// Parcours NTFS parallèle (fork/join rayon) + agrégation en passes séparées.
//
// Choix de conception :
//  - on n'accumule PAS les tailles vers les parents pendant le parcours : ce serait un
//    verrou par fichier et par niveau de profondeur. On ne garde que (parent, taille, date),
//    puis on agrège en deux passes linéaires après coup (voir `Snapshot::new`).
//  - l'id d'un dossier est toujours attribué AVANT celui de ses enfants, donc
//    `parent < enfant` : la remontée se fait en une seule boucle descendante sur les index.
//  - chemins en forme verbatim `\\?\C:\...` : lève la limite MAX_PATH (260 caractères)
//    qui fait échouer les node_modules profonds, et évite une normalisation par appel.
//  - les erreurs de parcours sont réparties en DEUX natures, parce qu'elles n'ont pas
//    le même coût : un dossier illisible fait disparaître tout un sous-arbre du total,
//    une entrée sautée ne coûte qu'une entrée. Un compteur unique afficherait le même
//    chiffre pour « 12 Go manquants » et « 12 fichiers illisibles » (voir `Unreadable`).

use std::fs;
use std::os::windows::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Instant, SystemTime};

/// FILE_ATTRIBUTE_REPARSE_POINT : jonctions, liens symboliques, points de montage.
/// Ignorés : les suivre doublerait les compteurs (`C:\Documents and Settings` -> `C:\Users`)
/// et risquerait des cycles.
const REPARSE_POINT: u32 = 0x0000_0400;

/// Profondeur max de fork. Au-delà, on parcourt en série dans le même job rayon :
/// un job par dossier coûterait plus que ce que le parallélisme rapporte sur des feuilles.
const PAR_DEPTH: u32 = 16;

/// ERROR_ACCESS_DENIED. C'est le seul cas qui se règle en relançant élevé, donc
/// le seul qui mérite d'être distingué des autres échecs de lecture.
const ACCESS_DENIED: i32 = 5;

/// Plafond du nombre de chemins conservés. Un volume pathologique peut compter
/// des milliers de dossiers inaccessibles ; au-delà, on garde le compte exact
/// mais pas la liste, pour ne pas gonfler le cache (500 chemins ≈ 60 Ko au pire).
const MAX_UNREADABLE: usize = 500;

const NONE: u32 = u32::MAX;

/// Un dossier dont le contenu n'a pas pu être lu. **Son sous-arbre entier manque
/// au total**, donc la taille annoncée est un plancher, pas une mesure.
///
/// On garde le chemin, pas seulement le compte : « 123 dossiers illisibles »
/// laisse l'utilisateur sans piste, alors que la liste lui dit quoi regarder —
/// et, pour un refus de droits, ce qu'une relance élevée lui rendrait.
#[derive(Clone, Debug)]
pub struct Unreadable {
    pub path: Box<str>,
    /// Vrai si c'est un refus de droits (code 5). Faux : volume défaillant,
    /// périphérique débranché, dossier détruit en cours de parcours.
    pub droits: bool,
}

#[derive(Clone, Debug)]
pub struct DirRec {
    pub id: u32,
    pub parent: u32,
    pub name: Box<str>,
    /// Date de modification du dossier lui-même (pas de son contenu).
    pub own_mtime: i64,
}

#[derive(Clone, Debug)]
pub struct FileRec {
    pub parent: u32,
    pub name: Box<str>,
    pub size: u64,
    pub mtime: i64,
}

/// Compteurs de progression, partagés avec la couche HTTP pour le suivi temps réel.
///
/// Les erreurs sont réparties en DEUX compteurs, et ce n'est pas cosmétique :
/// un dossier illisible fait disparaître **tout un sous-arbre** du total, alors
/// qu'une entrée sautée ne coûte **qu'une entrée**. Les additionner rendrait le
/// nombre ininterprétable, et l'interface afficherait le même chiffre pour
/// « 12 Go manquants » et « 12 fichiers illisibles ».
pub struct Progress {
    pub dirs: AtomicU64,
    pub files: AtomicU64,
    /// Dossiers dont le contenu est inaccessible : un sous-arbre entier manque.
    pub unreadable: AtomicU64,
    /// Sous-ensemble des précédents dû à un refus de droits (code 5).
    pub unreadable_droits: AtomicU64,
    /// Entrées sautées (métadonnée indisponible, disparue en cours de route) :
    /// coût d'une entrée chacune, jamais d'un sous-arbre.
    pub skipped: AtomicU64,
    pub cancel: AtomicBool,
}

impl Progress {
    pub fn new() -> Self {
        Progress {
            dirs: AtomicU64::new(0),
            files: AtomicU64::new(0),
            unreadable: AtomicU64::new(0),
            unreadable_droits: AtomicU64::new(0),
            skipped: AtomicU64::new(0),
            cancel: AtomicBool::new(false),
        }
    }
}

struct ScanState {
    dirs: Mutex<Vec<DirRec>>,
    files: Mutex<Vec<FileRec>>,
    unreadable: Mutex<Vec<Unreadable>>,
    next_id: AtomicU64,
    prog: Arc<Progress>,
}

impl ScanState {
    /// Enregistre un `read_dir` impossible : le sous-arbre de ce dossier est
    /// perdu pour le total. Le verrou n'est pris que sur le chemin d'erreur, qui
    /// reste rare (123 fois sur 271 747 dossiers sur la machine de référence).
    fn note_unreadable(&self, e: &std::io::Error, path: &Path) {
        let droits = e.raw_os_error() == Some(ACCESS_DENIED);
        self.prog.unreadable.fetch_add(1, Ordering::Relaxed);
        if droits {
            self.prog.unreadable_droits.fetch_add(1, Ordering::Relaxed);
        }
        let mut v = self.unreadable.lock().unwrap();
        if v.len() < MAX_UNREADABLE {
            v.push(Unreadable {
                path: affichable(path).into_boxed_str(),
                droits,
            });
        }
    }

    /// Une entrée sautée. On ne garde pas le chemin : ce sont des cas isolés
    /// (fichier verrouillé, disparu entre l'énumération et la lecture), et il y
    /// en a trop peu pour qu'une liste soit utile.
    fn note_skipped(&self) {
        self.prog.skipped.fetch_add(1, Ordering::Relaxed);
    }
}

/// Chemin affichable : on retire le préfixe verbatim `\\?\` qui sert seulement à
/// lever la limite de 260 caractères. Le laisser dans l'interface donnerait
/// `\\?\C:\Windows` au lieu de `C:\Windows`.
fn affichable(p: &Path) -> String {
    let s = p.to_string_lossy();
    if let Some(r) = s.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{r}")
    } else if let Some(r) = s.strip_prefix(r"\\?\") {
        r.to_string()
    } else {
        s.into_owned()
    }
}

pub struct Snapshot {
    pub root: String,      // "C:\"
    pub dirs: Vec<DirRec>, // trié par id : dirs[i].id == i
    pub files: Vec<FileRec>,
    /// Taille totale du sous-arbre, par id de dossier.
    pub size: Vec<u64>,
    /// Nombre de fichiers du sous-arbre, par id de dossier.
    pub count: Vec<u64>,
    /// Dernière écriture dans le sous-arbre (max des mtime), par id.
    pub mtime: Vec<i64>,
    // Listes d'adjacence en CSR (chaînage) : aucun Vec par dossier à allouer.
    head_dir: Vec<u32>,
    next_dir: Vec<u32>,
    head_file: Vec<u32>,
    next_file: Vec<u32>,
    pub elapsed_ms: u64,
    pub finished_ms: i64,
    /// Dossiers dont le contenu est inaccessible, plafonné à `MAX_UNREADABLE`.
    pub unreadable: Vec<Unreadable>,
    /// Nombre réel de dossiers inaccessibles, même au-delà du plafond.
    pub unreadable_total: u64,
    /// Sous-ensemble des précédents dû à un refus de droits (code 5).
    pub unreadable_droits: u64,
    /// Entrées sautées : coût d'une entrée chacune.
    pub skipped: u64,
}

#[derive(serde::Serialize, Clone)]
pub struct Row {
    pub id: u32,
    pub name: String,
    pub size: u64,
    pub count: u64,
    pub mtime: i64,
    pub is_dir: bool,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub path: String,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn ts(t: std::io::Result<SystemTime>) -> i64 {
    t.ok()
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

impl Snapshot {
    fn new(
        root: String,
        mut dirs: Vec<DirRec>,
        files: Vec<FileRec>,
        elapsed_ms: u64,
        unreadable: Vec<Unreadable>,
        unreadable_total: u64,
        unreadable_droits: u64,
        skipped: u64,
    ) -> Snapshot {
        // Les ids sont attribués atomiquement mais poussés depuis plusieurs threads :
        // l'ordre d'arrivée n'est pas l'ordre des ids. On re-trie pour garantir index == id.
        dirs.sort_unstable_by_key(|d| d.id);

        let n = dirs.len();
        let mut size = vec![0u64; n];
        let mut count = vec![0u64; n];
        let mut mtime = vec![0i64; n];
        for (i, d) in dirs.iter().enumerate() {
            mtime[i] = d.own_mtime;
        }

        // Passe 1 : chaque fichier alimente son dossier porteur.
        for f in &files {
            let p = f.parent as usize;
            if p < n {
                size[p] += f.size;
                count[p] += 1;
                if f.mtime > mtime[p] {
                    mtime[p] = f.mtime;
                }
            }
        }

        // Passe 2 : remontée des sous-arbres. `parent < enfant` garantit qu'un seul
        // passage descendant suffit.
        for i in (1..n).rev() {
            let p = dirs[i].parent as usize;
            if p < i {
                size[p] += size[i];
                count[p] += count[i];
                if mtime[i] > mtime[p] {
                    mtime[p] = mtime[i];
                }
            }
        }

        // Listes d'adjacence : chaînage par tête de liste, O(n) sans tri global.
        let mut head_dir = vec![NONE; n];
        let mut next_dir = Vec::with_capacity(n);
        for (idx, d) in dirs.iter().enumerate() {
            let p = d.parent as usize;
            // La racine porte `parent == id` : sans ce test elle figurerait
            // dans sa propre liste d'enfants.
            if p < n && d.parent != d.id {
                next_dir.push(head_dir[p]);
                head_dir[p] = idx as u32;
            } else {
                next_dir.push(NONE);
            }
        }

        let mut head_file = vec![NONE; n];
        let mut next_file = Vec::with_capacity(files.len());
        for (idx, f) in files.iter().enumerate() {
            let p = f.parent as usize;
            if p < n {
                next_file.push(head_file[p]);
                head_file[p] = idx as u32;
            } else {
                next_file.push(NONE);
            }
        }

        Snapshot {
            root,
            dirs,
            files,
            size,
            count,
            mtime,
            head_dir,
            next_dir,
            head_file,
            next_file,
            elapsed_ms,
            finished_ms: now_ms(),
            unreadable,
            unreadable_total,
            unreadable_droits,
            skipped,
        }
    }

    /// Total des anomalies de parcours. Sert au diagnostic en ligne de commande.
    ///
    /// L'interface ne doit PAS s'en servir seule : additionner un sous-arbre
    /// perdu et une entrée sautée n'a pas de sens, et c'est précisément la
    /// confusion que la séparation des compteurs sert à éviter.
    pub fn errors(&self) -> u64 {
        self.unreadable_total + self.skipped
    }

    /// Vrai si la taille annoncée est un plancher plutôt qu'une mesure : au
    /// moins un sous-arbre n'a pas été lu.
    pub fn incomplet(&self) -> bool {
        self.unreadable_total > 0
    }

    pub fn n_dirs(&self) -> usize {
        self.dirs.len()
    }
    pub fn n_files(&self) -> usize {
        self.files.len()
    }

    pub fn child_dirs(&self, id: u32) -> Vec<u32> {
        let mut out = Vec::new();
        let mut c = self.head_dir.get(id as usize).copied().unwrap_or(NONE);
        while c != NONE {
            out.push(c);
            c = self.next_dir[c as usize];
        }
        out
    }

    pub fn child_files(&self, id: u32) -> Vec<u32> {
        let mut out = Vec::new();
        let mut c = self.head_file.get(id as usize).copied().unwrap_or(NONE);
        while c != NONE {
            out.push(c);
            c = self.next_file[c as usize];
        }
        out
    }

    /// Chemin affichable d'un dossier (préfixe verbatim retiré).
    pub fn dir_path(&self, id: u32) -> PathBuf {
        let mut parts: Vec<&str> = Vec::new();
        let mut cur = id as usize;
        loop {
            parts.push(&self.dirs[cur].name);
            if cur == 0 {
                break;
            }
            let p = self.dirs[cur].parent as usize;
            if p >= cur {
                break;
            }
            cur = p;
        }
        parts.reverse();
        let mut p = PathBuf::from(parts[0]);
        for part in &parts[1..] {
            p.push(part);
        }
        p
    }

    /// Chemin complet d'un fichier.
    pub fn file_path(&self, idx: u32) -> PathBuf {
        let f = &self.files[idx as usize];
        let mut p = self.dir_path(f.parent);
        p.push(&*f.name);
        p
    }

    /// Recherche insensible à la casse sur les noms (dossiers puis fichiers).
    pub fn search(&self, needle_lower: &str, limit: usize) -> Vec<Row> {
        let needle = needle_lower.as_bytes();
        let mut out: Vec<Row> = Vec::new();
        if needle.is_empty() {
            return out;
        }
        for d in &self.dirs {
            if contains_ci(&d.name, needle) {
                let i = d.id as usize;
                out.push(Row {
                    id: d.id,
                    name: d.name.to_string(),
                    size: self.size[i],
                    count: self.count[i],
                    mtime: self.mtime[i],
                    is_dir: true,
                    path: self.dir_path(d.id).to_string_lossy().into_owned(),
                });
                if out.len() >= limit {
                    break;
                }
            }
        }
        if out.len() < limit {
            for (idx, f) in self.files.iter().enumerate() {
                if contains_ci(&f.name, needle) {
                    out.push(Row {
                        id: idx as u32,
                        name: f.name.to_string(),
                        size: f.size,
                        count: 1,
                        mtime: f.mtime,
                        is_dir: false,
                        path: self.file_path(idx as u32).to_string_lossy().into_owned(),
                    });
                    if out.len() >= limit {
                        break;
                    }
                }
            }
        }
        out
    }

    // ---------- persistance binaire (cache disque) ----------
    //
    // Version 2 : les erreurs de parcours ne sont plus un compteur unique mais
    // trois compteurs plus la liste des chemins inaccessibles. Un cache de
    // version 1 est refusé (`load` compare la version) : il ne porte pas
    // l'information, et la reconstituer à partir du seul total obligerait à
    // inventer une répartition. Le volume est donc réanalysé — 11,8 s sur C:
    // sur la machine de référence — ce qui est le prix d'un chiffre honnête.

    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        use std::io::Write;
        let mut buf: Vec<u8> = Vec::with_capacity(64 + self.dirs.len() * 16 + self.files.len() * 24);
        buf.extend_from_slice(b"DSKM");
        buf.extend_from_slice(&2u32.to_le_bytes());
        let root = self.root.as_bytes();
        buf.extend_from_slice(&(root.len() as u32).to_le_bytes());
        buf.extend_from_slice(root);
        buf.extend_from_slice(&self.finished_ms.to_le_bytes());
        buf.extend_from_slice(&self.elapsed_ms.to_le_bytes());
        buf.extend_from_slice(&self.unreadable_total.to_le_bytes());
        buf.extend_from_slice(&self.unreadable_droits.to_le_bytes());
        buf.extend_from_slice(&self.skipped.to_le_bytes());
        buf.extend_from_slice(&(self.dirs.len() as u32).to_le_bytes());
        buf.extend_from_slice(&(self.files.len() as u32).to_le_bytes());
        buf.extend_from_slice(&(self.unreadable.len() as u32).to_le_bytes());
        for d in &self.dirs {
            buf.extend_from_slice(&d.parent.to_le_bytes());
            buf.extend_from_slice(&d.own_mtime.to_le_bytes());
            buf.extend_from_slice(&(d.name.len() as u32).to_le_bytes());
        }
        for f in &self.files {
            buf.extend_from_slice(&f.parent.to_le_bytes());
            buf.extend_from_slice(&f.size.to_le_bytes());
            buf.extend_from_slice(&f.mtime.to_le_bytes());
            buf.extend_from_slice(&(f.name.len() as u32).to_le_bytes());
        }
        for u in &self.unreadable {
            buf.push(u.droits as u8);
            buf.extend_from_slice(&(u.path.len() as u32).to_le_bytes());
        }
        for d in &self.dirs {
            buf.extend_from_slice(d.name.as_bytes());
        }
        for f in &self.files {
            buf.extend_from_slice(f.name.as_bytes());
        }
        for u in &self.unreadable {
            buf.extend_from_slice(u.path.as_bytes());
        }
        let mut f = fs::File::create(path)?;
        f.write_all(&buf)?;
        Ok(())
    }

    pub fn load(path: &Path) -> std::io::Result<Snapshot> {
        let bytes = fs::read(path)?;
        let mut r = Reader { b: &bytes, p: 0 };
        if r.take(4)? != b"DSKM" {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "magic"));
        }
        let ver = r.u32()?;
        if ver != 2 {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "version"));
        }
        let root_len = r.u32()? as usize;
        let root = String::from_utf8_lossy(r.take(root_len)?).into_owned();
        let finished_ms = r.i64()?;
        let elapsed_ms = r.u64()?;
        let unreadable_total = r.u64()?;
        let unreadable_droits = r.u64()?;
        let skipped = r.u64()?;
        let n_dirs = r.u32()? as usize;
        let n_files = r.u32()? as usize;
        let n_unread = r.u32()? as usize;

        let mut parents = Vec::with_capacity(n_dirs);
        let mut own = Vec::with_capacity(n_dirs);
        let mut dlen = Vec::with_capacity(n_dirs);
        for _ in 0..n_dirs {
            parents.push(r.u32()?);
            own.push(r.i64()?);
            dlen.push(r.u32()? as usize);
        }
        let mut fparent = Vec::with_capacity(n_files);
        let mut fsize = Vec::with_capacity(n_files);
        let mut fmtime = Vec::with_capacity(n_files);
        let mut flen = Vec::with_capacity(n_files);
        for _ in 0..n_files {
            fparent.push(r.u32()?);
            fsize.push(r.u64()?);
            fmtime.push(r.i64()?);
            flen.push(r.u32()? as usize);
        }
        let mut udroits = Vec::with_capacity(n_unread);
        let mut ulen = Vec::with_capacity(n_unread);
        for _ in 0..n_unread {
            udroits.push(r.byte()? != 0);
            ulen.push(r.u32()? as usize);
        }
        let mut dirs = Vec::with_capacity(n_dirs);
        for i in 0..n_dirs {
            let name = String::from_utf8_lossy(r.take(dlen[i])?).into_owned().into_boxed_str();
            dirs.push(DirRec {
                id: i as u32,
                parent: parents[i],
                name,
                own_mtime: own[i],
            });
        }
        let mut files = Vec::with_capacity(n_files);
        for i in 0..n_files {
            let name = String::from_utf8_lossy(r.take(flen[i])?).into_owned().into_boxed_str();
            files.push(FileRec {
                parent: fparent[i],
                name,
                size: fsize[i],
                mtime: fmtime[i],
            });
        }
        let mut unreadable = Vec::with_capacity(n_unread);
        for i in 0..n_unread {
            let path = String::from_utf8_lossy(r.take(ulen[i])?).into_owned().into_boxed_str();
            unreadable.push(Unreadable { path, droits: udroits[i] });
        }

        let mut s = Snapshot::new(
            root,
            dirs,
            files,
            elapsed_ms,
            unreadable,
            unreadable_total,
            unreadable_droits,
            skipped,
        );
        s.finished_ms = finished_ms;
        Ok(s)
    }
}

struct Reader<'a> {
    b: &'a [u8],
    p: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> std::io::Result<&'a [u8]> {
        if self.p + n > self.b.len() {
            return Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "fin de fichier"));
        }
        let s = &self.b[self.p..self.p + n];
        self.p += n;
        Ok(s)
    }
    fn u32(&mut self) -> std::io::Result<u32> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn byte(&mut self) -> std::io::Result<u8> {
        Ok(self.take(1)?[0])
    }
    fn u64(&mut self) -> std::io::Result<u64> {
        Ok(u64::from_le_bytes(self.take(8)?.try_into().unwrap()))
    }
    fn i64(&mut self) -> std::io::Result<i64> {
        Ok(i64::from_le_bytes(self.take(8)?.try_into().unwrap()))
    }
}

/// Parcourt `root_verbatim` et renvoie l'index agrégé.
pub fn scan(root_verbatim: &str, display_root: String, prog: Arc<Progress>) -> Snapshot {
    let t0 = Instant::now();

    let st = Arc::new(ScanState {
        dirs: Mutex::new(Vec::new()),
        files: Mutex::new(Vec::new()),
        unreadable: Mutex::new(Vec::new()),
        next_id: AtomicU64::new(1),
        prog,
    });

    st.dirs.lock().unwrap().push(DirRec {
        id: 0,
        parent: 0,
        name: display_root.clone().into_boxed_str(),
        own_mtime: ts(fs::metadata(root_verbatim).and_then(|m| m.modified())),
    });

    let root_path = PathBuf::from(root_verbatim);
    rayon::scope(|s| walk(&st, s, 0, &root_path, 0));

    let dirs = std::mem::take(&mut *st.dirs.lock().unwrap());
    let files = std::mem::take(&mut *st.files.lock().unwrap());
    let unreadable = std::mem::take(&mut *st.unreadable.lock().unwrap());
    let unreadable_total = st.prog.unreadable.load(Ordering::Relaxed);
    let unreadable_droits = st.prog.unreadable_droits.load(Ordering::Relaxed);
    let skipped = st.prog.skipped.load(Ordering::Relaxed);

    Snapshot::new(
        display_root,
        dirs,
        files,
        t0.elapsed().as_millis() as u64,
        unreadable,
        unreadable_total,
        unreadable_droits,
        skipped,
    )
}

fn walk(st: &Arc<ScanState>, scope: &rayon::Scope, id: u32, path: &Path, depth: u32) {
    if st.prog.cancel.load(Ordering::Relaxed) {
        return;
    }

    let rd = match fs::read_dir(path) {
        Ok(r) => r,
        Err(e) => {
            st.note_unreadable(&e, path);
            return;
        }
    };

    let mut subdirs: Vec<(u32, PathBuf)> = Vec::new();
    let mut local_files: Vec<FileRec> = Vec::new();

    for entry in rd {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => {
                st.note_skipped();
                continue;
            }
        };
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => {
                st.note_skipped();
                continue;
            }
        };
        // Jonctions / liens symboliques : ni comptés ni suivis.
        if meta.file_attributes() & REPARSE_POINT != 0 {
            continue;
        }
        let name: Box<str> = entry.file_name().to_string_lossy().into_owned().into_boxed_str();

        if meta.is_dir() {
            let nid = st.next_id.fetch_add(1, Ordering::Relaxed) as u32;
            st.dirs.lock().unwrap().push(DirRec {
                id: nid,
                parent: id,
                name,
                own_mtime: ts(meta.modified()),
            });
            subdirs.push((nid, entry.path()));
        } else {
            local_files.push(FileRec {
                parent: id,
                name,
                size: meta.len(),
                mtime: ts(meta.modified()),
            });
        }
    }

    if !local_files.is_empty() {
        st.prog.files.fetch_add(local_files.len() as u64, Ordering::Relaxed);
        st.files.lock().unwrap().extend(local_files);
    }
    st.prog.dirs.fetch_add(1, Ordering::Relaxed);

    if depth < PAR_DEPTH && subdirs.len() >= 2 {
        // Un job par sous-dossier : rayon équilibre par vol de travail.
        for (nid, p) in subdirs {
            let st = st.clone();
            scope.spawn(move |s| walk(&st, s, nid, &p, depth + 1));
        }
    } else {
        for (nid, p) in subdirs {
            walk(st, scope, nid, &p, depth + 1);
        }
    }
}

/// Sous-chaîne insensible à la casse (ASCII), sans allocation.
fn contains_ci(hay: &str, needle: &[u8]) -> bool {
    let h = hay.as_bytes();
    if needle.is_empty() || h.len() < needle.len() {
        return false;
    }
    'outer: for i in 0..=(h.len() - needle.len()) {
        for j in 0..needle.len() {
            if h[i + j].to_ascii_lowercase() != needle[j] {
                continue 'outer;
            }
        }
        return true;
    }
    false
}
