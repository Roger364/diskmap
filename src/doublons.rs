// Détection de fichiers au contenu identique (doublons).
//
// On ne lit que les fichiers qui ont un jumeau de même taille, et on ne lit
// jamais plus que le budget. Le coût est donc borné par le budget, pas par
// le volume.
//
// Lot 1 « Doublons Smart » : avant de payer le SHA-256 complet d'un gros
// fichier, on calcule une pré-empreinte des 64 Kio de tête et des 64 Kio de
// queue. Deux vidéos, ISO ou archives qui partagent un en-tête identique mais
// diffèrent à la fin sont donc éliminées sans lire des gigaoctets. Le budget
// reste la seule borne : chaque lecture le décrémente atomiquement, et un
// fichier qui ne tient pas dans ce qui reste est écarté (`exact = false`).

use crate::scan::Snapshot;
use crate::win32;
use rayon::prelude::*;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;

/// Taille de la tête et de la queue lues avant l'empreinte complète.
pub const PREFIXE: u64 = 64 * 1024;
const TAMPON: usize = 1 << 20;
/// Plafond du cache d'empreintes : 200 000 entrées bornent la RAM.
pub const CACHE_MAX: usize = 200_000;

/// Catégories proposées par le filtre `category` de `/api/duplicates`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Categorie {
    Video,
    Image,
    Archive,
    Audio,
    Doc,
}

impl Categorie {
    /// `None` couvre `all` ET une valeur inconnue : un filtre qu'on ne comprend
    /// pas ne doit pas vider la liste, il la laisse entière.
    pub fn depuis(s: &str) -> Option<Categorie> {
        match s.to_lowercase().as_str() {
            "video" | "videos" | "vidéos" => Some(Categorie::Video),
            "image" | "images" => Some(Categorie::Image),
            "archive" | "archives" => Some(Categorie::Archive),
            "audio" => Some(Categorie::Audio),
            "doc" | "document" | "documents" => Some(Categorie::Doc),
            _ => None,
        }
    }

    pub fn accepte(self, nom: &str) -> bool {
        match self {
            Categorie::Video => categorie(nom) == "video",
            Categorie::Image => categorie(nom) == "image",
            Categorie::Archive => categorie(nom) == "archive",
            Categorie::Audio => categorie(nom) == "audio",
            Categorie::Doc => categorie(nom) == "doc",
        }
    }
}

/// Extension après le dernier point, en minuscules.
fn extension(nom: &str) -> Option<String> {
    let (_, ext) = nom.rsplit_once('.')?;
    if ext.is_empty() {
        None
    } else {
        Some(ext.to_ascii_lowercase())
    }
}

/// Catégorie d'affichage d'un fichier, d'après son extension.
pub fn categorie(nom: &str) -> &'static str {
    match extension(nom).as_deref() {
        Some(
            "mp4" | "mkv" | "avi" | "mov" | "wmv" | "webm" | "m4v" | "mpg" | "mpeg" | "ts" | "m2ts"
            | "mts" | "flv" | "3gp" | "ogv" | "vob" | "divx" | "rm" | "rmvb",
        ) => "video",
        Some(
            "jpg" | "jpeg" | "png" | "gif" | "webp" | "bmp" | "tif" | "tiff" | "heic" | "heif"
            | "raw" | "cr2" | "nef" | "arw" | "dng" | "svg" | "ico" | "psd" | "avif" | "jxl",
        ) => "image",
        Some(
            "zip" | "rar" | "7z" | "iso" | "tar" | "gz" | "bz2" | "xz" | "cab" | "tgz" | "zst"
            | "lz" | "lzma" | "lzh" | "arj" | "img" | "dmg" | "vhd" | "vhdx",
        ) => "archive",
        Some(
            "mp3" | "flac" | "wav" | "aac" | "ogg" | "opus" | "m4a" | "wma" | "aiff" | "alac"
            | "mid" | "midi" | "ape" | "wv" | "dsf" | "dff",
        ) => "audio",
        Some(
            "pdf" | "doc" | "docx" | "xls" | "xlsx" | "ppt" | "pptx" | "txt" | "md" | "rtf" | "odt"
            | "ods" | "odp" | "csv" | "json" | "xml" | "epub" | "mobi" | "html" | "htm" | "log"
            | "yaml" | "yml" | "toml" | "ini",
        ) => "doc",
        _ => "autre",
    }
}

/// Une empreinte déjà calculée pour un fichier.
#[derive(Clone, Copy, Debug, Default)]
pub struct EmpreinteCache {
    pub prehash: Option<[u8; 32]>,
    pub fullhash: Option<[u8; 32]>,
    /// Identité `(serial, index)` du fichier, quand le volume la fournit.
    /// Mise en cache avec la taille et la date : un fichier réécrit change
    /// d'identité, et l'ancienne ne doit pas resservir.
    pub file_id: Option<(u32, u64)>,
}

/// Cache d'empreintes en mémoire, indexé par `(drive, snap.gen)`.
///
/// La clé d'entrée porte aussi la taille et la date : un fichier réécrit entre
/// deux analyses ne peut pas réutiliser l'empreinte de son ancien contenu.
#[derive(Default)]
pub struct CacheEmpreintes {
    drive: Option<char>,
    gen: u64,
    entrees: HashMap<(u32, u64, i64), EmpreinteCache>,
}

impl CacheEmpreintes {
    pub fn new() -> CacheEmpreintes {
        CacheEmpreintes::default()
    }

    /// Vide le cache dès que le volume ou la génération change.
    pub fn prepare(&mut self, drive: char, gen: u64) {
        if self.drive != Some(drive) || self.gen != gen {
            self.entrees.clear();
            self.drive = Some(drive);
            self.gen = gen;
        }
    }

    pub fn get(&self, idx: u32, taille: u64, mtime: i64) -> Option<EmpreinteCache> {
        self.entrees.get(&(idx, taille, mtime)).copied()
    }

    pub fn put_prehash(&mut self, idx: u32, taille: u64, mtime: i64, h: [u8; 32]) {
        if let Some(e) = self.entree(idx, taille, mtime) {
            e.prehash = Some(h);
        }
    }

    pub fn put_complet(&mut self, idx: u32, taille: u64, mtime: i64, h: [u8; 32]) {
        if let Some(e) = self.entree(idx, taille, mtime) {
            e.prehash = Some(h);
            e.fullhash = Some(h);
        }
    }

    pub fn put_fullhash(&mut self, idx: u32, taille: u64, mtime: i64, h: [u8; 32]) {
        if let Some(e) = self.entree(idx, taille, mtime) {
            e.fullhash = Some(h);
        }
    }

    pub fn put_file_id(&mut self, idx: u32, taille: u64, mtime: i64, id: (u32, u64)) {
        if let Some(e) = self.entree(idx, taille, mtime) {
            e.file_id = Some(id);
        }
    }

    fn entree(&mut self, idx: u32, taille: u64, mtime: i64) -> Option<&mut EmpreinteCache> {
        let cle = (idx, taille, mtime);
        if !self.entrees.contains_key(&cle) && self.entrees.len() >= CACHE_MAX {
            // Plafond atteint : on préfère ne rien mémoriser plutôt que de
            // faire grossir la RAM sans borne. Le disque sera relu, pas menti.
            return None;
        }
        Some(self.entrees.entry(cle).or_default())
    }
}

pub struct Options<'a> {
    pub base: u32,
    pub min: u64,
    pub max: u64,
    pub budget: u64,
    pub categorie: Option<Categorie>,
    pub stopping: &'a AtomicBool,
    pub drive: char,
    pub gen: u64,
    pub cache: &'a Mutex<CacheEmpreintes>,
}

pub struct Groupe {
    pub empreinte: String,
    pub taille: u64,
    pub fichiers: Vec<u32>,
    /// Copies qui partagent déjà l'inode d'une autre entrée du groupe :
    /// supprimer leur NOM ne libère rien. Triées, pour une recherche binaire.
    pub hardlinks: Vec<u32>,
    /// Copies PHYSIQUES distinctes (`fichiers.len() - hardlinks.len()`). C'est
    /// ce nombre, et non le nombre de chemins, qui décide du gain.
    pub physiques: usize,
}

/// Deux dossiers qui partagent des fichiers identiques.
///
/// `fichiers` compte les contenus partagés, pas les chemins : un lien dur dans
/// l'autre dossier ne libérerait rien et ne doit donc pas gonfler la paire.
pub struct PaireDossiers {
    pub dir_a: u32,
    pub dir_b: u32,
    pub fichiers: u64,
    pub octets: u64,
}

#[derive(Default)]
pub struct Resultat {
    pub groupes: Vec<Groupe>,
    pub groupes_total: usize,
    pub gain_total: u64,
    pub exact: bool,
    pub arret: bool,
    pub octets_lus: u64,
    pub modifies: u64,
    pub illisibles: u64,
    /// Top 100 des paires de dossiers, par octets partagés décroissants.
    pub paires: Vec<PaireDossiers>,
}

/// Critère de tri des GROUPES (jamais des lignes).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TriGroupe {
    Gain,
    Taille,
    Date,
    Nombre,
    Nom,
}

impl TriGroupe {
    pub fn depuis(s: &str) -> TriGroupe {
        match s {
            "size" => TriGroupe::Taille,
            "mtime" | "date" => TriGroupe::Date,
            "count" => TriGroupe::Nombre,
            "name" => TriGroupe::Nom,
            _ => TriGroupe::Gain,
        }
    }
}

/// Les grandeurs d'un groupe qui décident de sa place dans la liste.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CleGroupe {
    pub gain: u64,
    pub taille: u64,
    pub mtime: i64,
    pub count: usize,
    pub nom: String,
}

/// Compare deux groupes. Le nom tranche les égalités dans le sens croissant,
/// comme `trier_lignes` : deux groupes de même gain ne changent pas de place
/// quand on inverse le sens demandé.
pub fn comparer_cles(
    a: &CleGroupe,
    b: &CleGroupe,
    tri: TriGroupe,
    decroissant: bool,
) -> std::cmp::Ordering {
    let ordre = |x: u64, y: u64| {
        if decroissant {
            y.cmp(&x)
        } else {
            x.cmp(&y)
        }
    };
    let principal = match tri {
        TriGroupe::Gain => ordre(a.gain, b.gain),
        TriGroupe::Taille => ordre(a.taille, b.taille),
        TriGroupe::Date => ordre(a.mtime.max(0) as u64, b.mtime.max(0) as u64),
        TriGroupe::Nombre => ordre(a.count as u64, b.count as u64),
        TriGroupe::Nom => {
            if decroissant {
                b.nom.cmp(&a.nom)
            } else {
                a.nom.cmp(&b.nom)
            }
        }
    };
    principal
        .then_with(|| a.nom.cmp(&b.nom))
        .then_with(|| b.taille.cmp(&a.taille))
        .then_with(|| b.gain.cmp(&a.gain))
}

/// Trie des groupes ENTIERS. Le type `T` (les lignes du groupe) n'est jamais
/// inspecté : deux fichiers de groupes différents ne peuvent donc pas se
/// mélanger, quel que soit le critère.
pub fn trier_par_cle<T>(groupes: &mut [(CleGroupe, T)], tri: TriGroupe, decroissant: bool) {
    groupes.sort_by(|a, b| comparer_cles(&a.0, &b.0, tri, decroissant));
}

/// Score « Smart » : plus il est haut, plus le fichier est un bon original.
///
/// Fonction pure et déterministe, pour être testable sans disque ni instantané.
pub fn score_smart(path: &str, mtime: i64, oldest_mtime: i64) -> i32 {
    let bas = path.replace('/', "\\").to_lowercase();
    let mut score = 0i32;

    // Dossiers « vrac / temporaire ».
    for motif in [
        "\\downloads\\",
        "\\téléchargements\\",
        "\\temp\\",
        "\\tmp\\",
        "\\$recycle.bin\\",
    ] {
        if bas.contains(motif) {
            score -= 40;
        }
    }
    for motif in [
        "\\desktop\\",
        "\\bureau\\",
        "\\whatsapp",
        "\\telegram",
        "\\cache\\",
    ] {
        if bas.contains(motif) {
            score -= 25;
        }
    }
    for motif in ["\\backup", "\\sauvegarde", "\\copie", "\\copy", "\\old"] {
        if bas.contains(motif) {
            score -= 15;
        }
    }

    // Nom dupliqué : « photo (1).jpg », « rapport - copie.docx »…
    let nom = bas.rsplit('\\').next().unwrap_or(&bas);
    let tige = match nom.rsplit_once('.') {
        Some((t, _)) if !t.is_empty() => t,
        _ => nom,
    };
    if suffixe_copie(tige) {
        score -= 30;
    }

    // Un niveau de profondeur en plus, un point en moins (racine = 0).
    let profondeur = bas.matches('\\').count().saturating_sub(1) as i32;
    score -= profondeur;

    // Le plus ancien du groupe est le meilleur candidat à la conservation.
    if mtime > 0 && mtime == oldest_mtime {
        score += 15;
    }

    score
}

fn suffixe_copie(tige: &str) -> bool {
    if let Some(pos) = tige.rfind(" (") {
        let fin = &tige[pos + 2..];
        if let Some(num) = fin.strip_suffix(')') {
            if !num.is_empty() && num.bytes().all(|b| b.is_ascii_digit()) {
                return true;
            }
        }
    }
    [" - copie", " - copy", "_copy", "_backup"]
        .iter()
        .any(|s| tige.ends_with(s))
}

/// Un fichier du groupe, tel que le score doit le voir.
#[derive(Clone, Debug)]
pub struct Candidat {
    pub idx: u32,
    pub path: String,
    pub mtime: i64,
}

/// Désigne UN original par groupe : meilleur score, puis date croissante, puis
/// chemin le plus court, puis ordre lexicographique.
pub fn choisir_original(candidats: &[Candidat]) -> Option<usize> {
    let premier = candidats.first()?;
    let oldest = candidats
        .iter()
        .filter(|c| c.mtime > 0)
        .map(|c| c.mtime)
        .min()
        .unwrap_or(0);
    let mut meilleur = 0usize;
    let mut meilleur_score = score_smart(&premier.path, premier.mtime, oldest);
    for (i, c) in candidats.iter().enumerate().skip(1) {
        let s = score_smart(&c.path, c.mtime, oldest);
        let reference = &candidats[meilleur];
        let gagne = s > meilleur_score
            || (s == meilleur_score
                && (c.mtime, c.path.len(), c.path.as_str())
                    < (
                        reference.mtime,
                        reference.path.len(),
                        reference.path.as_str(),
                    ));
        if gagne {
            meilleur = i;
            meilleur_score = s;
        }
    }
    Some(meilleur)
}

/// Gain récupérable d'un groupe : seules les copies PHYSIQUES au-delà de la
/// première libèrent de l'espace. Au Lot 1, toutes les copies sont distinctes.
pub fn gain_groupe(taille: u64, copies_physiques: usize) -> u64 {
    taille.saturating_mul(copies_physiques.saturating_sub(1) as u64)
}

/// Marque les entrées qui partagent l'inode d'une PRÉCÉDENTE du même groupe.
///
/// Le premier chemin portant une identité donnée est la copie physique ; les
/// suivants sont des liens durs, et leur suppression ne libère zéro octet de
/// moins : elle n'en libère aucun. `None` (volume non NTFS, refus) est traité
/// comme une identité DISTINCTE — on ne déduplique jamais sur une ignorance,
/// sinon deux vraies copies perdraient leur gain.
fn marquer_hardlinks(
    snap: &Snapshot,
    fichiers: &[u32],
    cache: &Mutex<CacheEmpreintes>,
) -> (Vec<u32>, usize) {
    let mut vus: HashMap<(u32, u64), u32> = HashMap::new();
    let mut liens: Vec<u32> = Vec::new();
    for &idx in fichiers {
        let f = &snap.files[idx as usize];
        let connu = cache
            .lock()
            .unwrap()
            .get(idx, f.size, f.mtime)
            .and_then(|e| e.file_id);
        let id = match connu {
            Some(id) => Some(id),
            None => {
                let id = win32::file_id(&snap.file_path(idx));
                if let Some(id) = id {
                    cache.lock().unwrap().put_file_id(idx, f.size, f.mtime, id);
                }
                id
            }
        };
        if let Some(id) = id {
            if vus.insert(id, idx).is_some() {
                liens.push(idx);
            }
        }
    }
    liens.sort_unstable();
    let physiques = fichiers.len().saturating_sub(liens.len());
    (liens, physiques)
}

/// Agrège les paires de dossiers qui partagent des contenus identiques.
///
/// Pour chaque groupe, on compte les copies par dossier parent, puis chaque
/// paire de dossiers reçoit `min(copies_a, copies_b)` fichiers partagés : c'est
/// le nombre de contenus qu'on peut supprimer d'un côté en gardant l'autre.
/// Le coût par groupe est O(d²) où `d` est le nombre de dossiers DISTINCTS —
/// presque toujours 2 ou 3. Au-delà de 512 dossiers, la paire n'est pas
/// calculée : mieux vaut une liste incomplète assumée qu'un calcul en O(n²)
/// sur un groupe pathologique.
fn paires_dossiers(snap: &Snapshot, groupes: &[Groupe]) -> Vec<PaireDossiers> {
    let mut agg: HashMap<(u32, u32), (u64, u64)> = HashMap::new();
    for g in groupes {
        let mut par_dir: HashMap<u32, u32> = HashMap::new();
        for &idx in &g.fichiers {
            if g.hardlinks.binary_search(&idx).is_ok() {
                continue;
            }
            *par_dir.entry(snap.files[idx as usize].parent).or_insert(0) += 1;
        }
        if par_dir.len() < 2 || par_dir.len() > 512 {
            continue;
        }
        let mut ds: Vec<(u32, u32)> = par_dir.into_iter().collect();
        ds.sort_unstable();
        for i in 0..ds.len() {
            for j in (i + 1)..ds.len() {
                let (a, ca) = ds[i];
                let (b, cb) = ds[j];
                let n = u64::from(ca.min(cb));
                let e = agg.entry((a, b)).or_insert((0, 0));
                e.0 += n;
                e.1 = e.1.saturating_add(g.taille.saturating_mul(n));
            }
        }
    }
    let mut out: Vec<PaireDossiers> = agg
        .into_iter()
        .map(|((dir_a, dir_b), (fichiers, octets))| PaireDossiers {
            dir_a,
            dir_b,
            fichiers,
            octets,
        })
        .collect();
    out.sort_by(|a, b| {
        b.octets
            .cmp(&a.octets)
            .then_with(|| b.fichiers.cmp(&a.fichiers))
            .then_with(|| a.dir_a.cmp(&b.dir_a))
            .then_with(|| a.dir_b.cmp(&b.dir_b))
    });
    out.truncate(100);
    out
}

pub fn chercher(snap: &Snapshot, o: &Options) -> Resultat {
    o.cache.lock().unwrap().prepare(o.drive, o.gen);

    // 1. Candidats : (taille, index), filtrés par taille, par sous-arbre et
    //    par catégorie AVANT toute lecture.
    let dedans = sous_arbres(snap, o.base);
    let mut v: Vec<(u64, u32)> = snap
        .files
        .iter()
        .enumerate()
        .filter(|(_, f)| f.size > 0 && f.size >= o.min && f.size <= o.max)
        .filter(|(_, f)| dedans[f.parent as usize])
        .filter(|(_, f)| o.categorie.is_none_or(|c| c.accepte(&f.name)))
        .map(|(i, f)| (f.size, i as u32))
        .collect();
    v.sort_unstable();

    // 2. Groupes de même taille ≥ 2.
    let mut tailles: Vec<(u64, Vec<u32>)> = Vec::new();
    let mut i = 0;
    while i < v.len() {
        let mut j = i + 1;
        while j < v.len() && v[j].0 == v[i].0 {
            j += 1;
        }
        if j - i >= 2 {
            tailles.push((v[i].0, v[i..j].iter().map(|&(_, k)| k).collect()));
        }
        i = j;
    }

    let mut candidats: Vec<u32> = tailles
        .iter()
        .flat_map(|(_, g)| g.iter().copied())
        .collect();
    candidats.sort_unstable();

    if o.stopping.load(Ordering::Relaxed) {
        return Resultat {
            exact: false,
            arret: true,
            ..Default::default()
        };
    }

    // Compteurs partagés par les lectures parallèles.
    let reste = AtomicU64::new(o.budget);
    let modifies = AtomicU64::new(0);
    let illisibles = AtomicU64::new(0);
    let epuise = AtomicBool::new(false);
    let arret = AtomicBool::new(false);

    // 3. Pré-empreinte (tête+queue, ou fichier entier s'il est petit), en
    //    parallèle borné : quatre lecteurs au plus, pour ne pas saturer un
    //    disque mécanique.
    let pool = rayon::ThreadPoolBuilder::new().num_threads(4).build().ok();

    let traiter_pre = |&idx: &u32| -> Option<(u32, [u8; 32], bool)> {
        if o.stopping.load(Ordering::Relaxed) {
            arret.store(true, Ordering::Relaxed);
            return None;
        }
        let f = &snap.files[idx as usize];
        let complet = f.size <= 2 * PREFIXE;

        if let Some(e) = o.cache.lock().unwrap().get(idx, f.size, f.mtime) {
            if complet {
                if let Some(h) = e.fullhash {
                    return Some((idx, h, true));
                }
            } else if let Some(h) = e.prehash {
                return Some((idx, h, false));
            }
        }

        let path = snap.file_path(idx);
        let meta = match std::fs::metadata(&path) {
            Ok(m) => m,
            Err(_) => {
                illisibles.fetch_add(1, Ordering::Relaxed);
                return None;
            }
        };
        if meta.len() != f.size {
            modifies.fetch_add(1, Ordering::Relaxed);
            return None;
        }

        let lu = if complet {
            hacher_complet(&path, f.size, &reste, o.stopping)
        } else {
            hacher_prealable(&path, f.size, &reste, o.stopping)
        };
        match lu {
            Ok(h) => {
                let mut cache = o.cache.lock().unwrap();
                if complet {
                    cache.put_complet(idx, f.size, f.mtime, h);
                } else {
                    cache.put_prehash(idx, f.size, f.mtime, h);
                }
                Some((idx, h, complet))
            }
            Err(Lecture::Budget) => {
                epuise.store(true, Ordering::Relaxed);
                None
            }
            Err(Lecture::Modifie) => {
                modifies.fetch_add(1, Ordering::Relaxed);
                None
            }
            Err(Lecture::Illisible) => {
                illisibles.fetch_add(1, Ordering::Relaxed);
                None
            }
            Err(Lecture::Arret) => {
                arret.store(true, Ordering::Relaxed);
                None
            }
        }
    };

    let pre: Vec<(u32, [u8; 32], bool)> = match &pool {
        Some(p) => p.install(|| candidats.par_iter().filter_map(traiter_pre).collect()),
        None => candidats.iter().filter_map(traiter_pre).collect(),
    };

    // 4. Seuls les fichiers dont la pré-empreinte a un jumeau méritent le
    //    SHA-256 complet. Les petits fichiers sont déjà complets.
    let mut par_pre: HashMap<[u8; 32], Vec<(u32, bool)>> = HashMap::new();
    for (idx, h, complet) in pre {
        par_pre.entry(h).or_default().push((idx, complet));
    }

    let mut a_completer: Vec<u32> = Vec::new();
    for v in par_pre.values() {
        if v.len() >= 2 {
            a_completer.extend(v.iter().filter(|(_, c)| !*c).map(|(i, _)| *i));
        }
    }
    a_completer.sort_unstable();

    let traiter_complet = |&idx: &u32| -> Option<(u32, [u8; 32])> {
        if o.stopping.load(Ordering::Relaxed) {
            arret.store(true, Ordering::Relaxed);
            return None;
        }
        let f = &snap.files[idx as usize];
        if let Some(e) = o.cache.lock().unwrap().get(idx, f.size, f.mtime) {
            if let Some(h) = e.fullhash {
                return Some((idx, h));
            }
        }
        let path = snap.file_path(idx);
        match hacher_complet(&path, f.size, &reste, o.stopping) {
            Ok(h) => {
                o.cache
                    .lock()
                    .unwrap()
                    .put_fullhash(idx, f.size, f.mtime, h);
                Some((idx, h))
            }
            Err(Lecture::Budget) => {
                epuise.store(true, Ordering::Relaxed);
                None
            }
            Err(Lecture::Modifie) => {
                modifies.fetch_add(1, Ordering::Relaxed);
                None
            }
            Err(Lecture::Illisible) => {
                illisibles.fetch_add(1, Ordering::Relaxed);
                None
            }
            Err(Lecture::Arret) => {
                arret.store(true, Ordering::Relaxed);
                None
            }
        }
    };

    let pleines: Vec<(u32, [u8; 32])> = match &pool {
        Some(p) => p.install(|| a_completer.par_iter().filter_map(traiter_complet).collect()),
        None => a_completer.iter().filter_map(traiter_complet).collect(),
    };

    let mut completes: HashMap<[u8; 32], Vec<u32>> = HashMap::new();
    for (h, v) in par_pre {
        if v.len() >= 2 && v.iter().all(|(_, c)| *c) {
            completes.insert(h, v.into_iter().map(|(idx, _)| idx).collect());
        }
    }
    for (idx, h) in pleines {
        completes.entry(h).or_default().push(idx);
    }

    let mut groupes: Vec<Groupe> = Vec::new();
    for (h, mut fichiers) in completes {
        if fichiers.len() < 2 {
            continue;
        }
        fichiers.sort_unstable();
        let (hardlinks, physiques) = marquer_hardlinks(snap, &fichiers, o.cache);
        groupes.push(Groupe {
            empreinte: hex_encode(&h),
            taille: snap.files[fichiers[0] as usize].size,
            fichiers,
            hardlinks,
            physiques,
        });
    }
    groupes.sort_by(|a, b| a.empreinte.cmp(&b.empreinte));

    let gain_total: u64 = groupes
        .iter()
        .map(|g| gain_groupe(g.taille, g.physiques))
        .sum();
    let paires = paires_dossiers(snap, &groupes);
    let arret_final = arret.load(Ordering::Relaxed);
    let exact = exact_apres(arret_final, epuise.load(Ordering::Relaxed));

    Resultat {
        groupes_total: groupes.len(),
        groupes,
        gain_total,
        exact,
        arret: arret_final,
        octets_lus: o.budget.saturating_sub(reste.load(Ordering::Relaxed)),
        modifies: modifies.load(Ordering::Relaxed),
        illisibles: illisibles.load(Ordering::Relaxed),
        paires,
    }
}

fn sous_arbres(snap: &Snapshot, base: u32) -> Vec<bool> {
    let n = snap.dirs.len();
    let mut dedans = vec![false; n];
    if base == 0 {
        dedans.fill(true);
        return dedans;
    }
    // Construire l'index parent -> enfants pour éviter O(n²).
    let mut enfants: Vec<Vec<u32>> = vec![Vec::new(); n];
    for dir in &snap.dirs {
        let p = dir.parent as usize;
        if p < n {
            enfants[p].push(dir.id);
        }
    }
    // Marquer le sous-arbre de base par DFS.
    let mut stack = vec![base];
    while let Some(d) = stack.pop() {
        let di = d as usize;
        if di >= n || dedans[di] {
            continue;
        }
        dedans[di] = true;
        for &child in &enfants[di] {
            if !dedans[child as usize] {
                stack.push(child);
            }
        }
    }
    dedans
}

/// `exact` reste vrai tant qu'aucune lecture n'a été refusée faute de budget
/// et que l'utilisateur n'a pas demandé l'arrêt.
fn exact_apres(arret: bool, epuise: bool) -> bool {
    !arret && !epuise
}

/// Pourquoi une lecture n'a pas rendu d'empreinte.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Lecture {
    /// Le budget ne couvre pas cette lecture : on n'a rien lu.
    Budget,
    /// Le fichier a changé depuis l'analyse (taille ou lecture courte).
    Modifie,
    /// Ouverture ou lecture impossible.
    Illisible,
    /// L'utilisateur a demandé l'arrêt.
    Arret,
}

/// Réserve `n` octets du budget, sans jamais le dépasser.
///
/// Le `compare_exchange` est la garde : deux threads qui lisent en parallèle ne
/// peuvent pas chacun voir « il reste assez » et dépasser ensemble.
fn reserver(reste: &AtomicU64, n: u64) -> bool {
    let mut courant = reste.load(Ordering::Relaxed);
    loop {
        if courant < n {
            return false;
        }
        match reste.compare_exchange_weak(courant, courant - n, Ordering::AcqRel, Ordering::Relaxed)
        {
            Ok(_) => return true,
            Err(vu) => courant = vu,
        }
    }
}

/// Crédite `n` octets réservés mais finalement non lus.
///
/// Sans ce remboursement, un fichier disparu ou tronqué consommerait quand
/// même son budget : `octets_lus` mentirait et une détection pourrait
/// s'arrêter « budget épuisé » sans avoir lu ces octets.
fn rembourser(reste: &AtomicU64, n: u64) {
    if n > 0 {
        reste.fetch_add(n, Ordering::AcqRel);
    }
}

fn finaliser(h: Sha256) -> [u8; 32] {
    let out = h.finalize();
    let mut a = [0u8; 32];
    a.copy_from_slice(&out);
    a
}

/// Lit exactement `a_lire` octets et les ajoute au hasher.
///
/// Renvoie le nombre d'octets effectivement lus, y compris en cas d'échec :
/// l'appelant rembourse la différence au budget. Un `Ok` vaut toujours
/// `a_lire`.
fn lire_et_hacher(
    file: &mut File,
    a_lire: u64,
    hasher: &mut Sha256,
    tampon: &mut [u8],
    stopping: &AtomicBool,
) -> Result<u64, (Lecture, u64)> {
    let mut reste = a_lire;
    while reste > 0 {
        if stopping.load(Ordering::Relaxed) {
            return Err((Lecture::Arret, a_lire - reste));
        }
        let n = reste.min(tampon.len() as u64) as usize;
        match file.read(&mut tampon[..n]) {
            Ok(0) => return Err((Lecture::Modifie, a_lire - reste)),
            Ok(l) => {
                hasher.update(&tampon[..l]);
                reste -= l as u64;
            }
            Err(_) => return Err((Lecture::Illisible, a_lire - reste)),
        }
    }
    Ok(a_lire)
}

fn hacher_complet(
    path: &Path,
    taille: u64,
    reste: &AtomicU64,
    stopping: &AtomicBool,
) -> Result<[u8; 32], Lecture> {
    // Ouvrir AVANT de réserver : un fichier absent ne doit rien consommer.
    let mut file = File::open(path).map_err(|_| Lecture::Illisible)?;
    if !reserver(reste, taille) {
        return Err(Lecture::Budget);
    }
    let mut hasher = Sha256::new();
    let mut tampon = vec![0u8; TAMPON.min(taille.max(1) as usize)];
    match lire_et_hacher(&mut file, taille, &mut hasher, &mut tampon, stopping) {
        Ok(_) => Ok(finaliser(hasher)),
        Err((raison, lus)) => {
            rembourser(reste, taille - lus);
            Err(raison)
        }
    }
}

/// Pré-empreinte d'un fichier.
///
/// - `taille <= 2 * PREFIXE` : le fichier entier, en une passe (c'est aussi
///   l'empreinte complète).
/// - au-delà : SHA-256 de la taille, des 64 Kio de tête puis des 64 Kio de
///   queue. Deux fichiers de même taille et de même en-tête mais de queue
///   différente sont donc séparés sans lire le milieu.
fn hacher_prealable(
    path: &Path,
    taille: u64,
    reste: &AtomicU64,
    stopping: &AtomicBool,
) -> Result<[u8; 32], Lecture> {
    if taille <= 2 * PREFIXE {
        return hacher_complet(path, taille, reste, stopping);
    }
    let mut file = File::open(path).map_err(|_| Lecture::Illisible)?;
    let mut hasher = Sha256::new();
    hasher.update(taille.to_le_bytes());
    let mut tampon = vec![0u8; PREFIXE as usize];

    if !reserver(reste, PREFIXE) {
        return Err(Lecture::Budget);
    }
    if let Err((raison, lus)) =
        lire_et_hacher(&mut file, PREFIXE, &mut hasher, &mut tampon, stopping)
    {
        rembourser(reste, PREFIXE - lus);
        return Err(raison);
    }

    file.seek(SeekFrom::End(-(PREFIXE as i64)))
        .map_err(|_| Lecture::Illisible)?;
    if !reserver(reste, PREFIXE) {
        return Err(Lecture::Budget);
    }
    if let Err((raison, lus)) =
        lire_et_hacher(&mut file, PREFIXE, &mut hasher, &mut tampon, stopping)
    {
        rembourser(reste, PREFIXE - lus);
        return Err(raison);
    }

    Ok(finaliser(hasher))
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 0x0f) as usize] as char);
    }
    s
}

// Tests unitaires.
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    static COMPTEUR: AtomicUsize = AtomicUsize::new(0);

    fn fichier_temporaire(nom: &str, octets: &[u8]) -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!(
            "diskmap-doublons-{}-{}-{}",
            std::process::id(),
            COMPTEUR.fetch_add(1, Ordering::Relaxed),
            nom
        ));
        std::fs::write(&p, octets).unwrap();
        p
    }

    #[test]
    fn hex_encode_ok() {
        assert_eq!(hex_encode(&[0xab, 0xcd]), "abcd");
    }

    #[test]
    fn score_smart_prefere_propre_et_ancien() {
        // Profondeur 3 -> -2, plus ancien -> +15.
        let propre = score_smart(r"C:\Photos\vacances\img.jpg", 1000, 1000);
        assert_eq!(propre, 13);
        // Downloads (-40), « (1) » (-30), profondeur 4 -> -3.
        let sale = score_smart(r"C:\Users\bob\Downloads\img (1).jpg", 2000, 1000);
        assert_eq!(sale, -73);
        assert!(propre > sale);
    }

    #[test]
    fn score_smart_penalise_les_suffixes_de_copie() {
        let base = score_smart(r"C:\Photos\a.jpg", 1000, 0);
        for nom in [
            r"C:\Photos\a (2).jpg",
            r"C:\Photos\a - copie.jpg",
            r"C:\Photos\a - copy.jpg",
            r"C:\Photos\a_copy.jpg",
            r"C:\Photos\a_backup.jpg",
        ] {
            assert_eq!(score_smart(nom, 1000, 0), base - 30, "{nom}");
        }
    }

    #[test]
    fn election_designe_un_seul_original() {
        let candidats = vec![
            Candidat {
                idx: 1,
                path: r"C:\Users\bob\Downloads\a (1).jpg".into(),
                mtime: 500,
            },
            Candidat {
                idx: 2,
                path: r"C:\Photos\a.jpg".into(),
                mtime: 900,
            },
            Candidat {
                idx: 3,
                path: r"C:\Photos\b.jpg".into(),
                mtime: 1000,
            },
        ];
        let pos = choisir_original(&candidats).unwrap();
        assert_eq!(candidats[pos].idx, 2);
        // Une égalité parfaite de score se tranche par la date la plus ancienne.
        let jumeaux = vec![
            Candidat {
                idx: 10,
                path: r"C:\Photos\a.jpg".into(),
                mtime: 2000,
            },
            Candidat {
                idx: 11,
                path: r"C:\Photos\b.jpg".into(),
                mtime: 1000,
            },
        ];
        let pos = choisir_original(&jumeaux).unwrap();
        assert_eq!(jumeaux[pos].idx, 11);
    }

    #[test]
    fn prealable_distingue_meme_tete_queue_differente() {
        let taille = 200 * 1024usize;
        let a = vec![7u8; taille];
        let mut b = a.clone();
        b[taille - 1] = 9;
        let c = a.clone();

        let pa = fichier_temporaire("a.bin", &a);
        let pb = fichier_temporaire("b.bin", &b);
        let pc = fichier_temporaire("c.bin", &c);
        let reste = AtomicU64::new(u64::MAX);
        let stop = AtomicBool::new(false);

        let ha = hacher_prealable(&pa, taille as u64, &reste, &stop).unwrap();
        let hb = hacher_prealable(&pb, taille as u64, &reste, &stop).unwrap();
        let hc = hacher_prealable(&pc, taille as u64, &reste, &stop).unwrap();

        assert_ne!(ha, hb, "la queue doit distinguer deux fichiers");
        assert_eq!(ha, hc, "deux fichiers identiques ont la même pré-empreinte");

        for p in [pa, pb, pc] {
            let _ = std::fs::remove_file(p);
        }
    }

    #[test]
    fn budget_strict_ne_depasse_jamais() {
        let reste = AtomicU64::new(10);
        assert!(reserver(&reste, 6));
        assert!(!reserver(&reste, 5));
        assert_eq!(reste.load(Ordering::Relaxed), 4);
        assert!(reserver(&reste, 4));
        assert_eq!(reste.load(Ordering::Relaxed), 0);
        assert!(!reserver(&reste, 1));
    }

    #[test]
    fn budget_atteint_rend_exact_faux() {
        assert!(exact_apres(false, false));
        assert!(!exact_apres(false, true));
        assert!(!exact_apres(true, false));
        assert!(!exact_apres(true, true));
    }

    #[test]
    fn budget_insuffisant_refuse_la_lecture() {
        let p = fichier_temporaire("budget.bin", &[3u8; 100]);
        let reste = AtomicU64::new(99);
        let stop = AtomicBool::new(false);
        assert_eq!(hacher_complet(&p, 100, &reste, &stop), Err(Lecture::Budget));
        // Le refus n'a rien consommé : on ne lit pas « presque tout ».
        assert_eq!(reste.load(Ordering::Relaxed), 99);
        let _ = std::fs::remove_file(p);
    }

    #[test]
    fn fichier_absent_ne_consomme_pas_le_budget() {
        let manquant = std::env::temp_dir().join("diskmap-absent-budget.bin");
        let _ = std::fs::remove_file(&manquant);
        let reste = AtomicU64::new(1000);
        let stop = AtomicBool::new(false);
        assert_eq!(
            hacher_complet(&manquant, 500, &reste, &stop),
            Err(Lecture::Illisible)
        );
        assert_eq!(
            reste.load(Ordering::Relaxed),
            1000,
            "un fichier qu'on n'a pas pu ouvrir ne débite rien"
        );
    }

    #[test]
    fn lecture_courte_ne_debite_que_les_octets_lus() {
        let p = fichier_temporaire("court.bin", &[5u8; 10]);
        let reste = AtomicU64::new(100);
        let stop = AtomicBool::new(false);
        assert_eq!(
            hacher_complet(&p, 100, &reste, &stop),
            Err(Lecture::Modifie)
        );
        // 10 octets réellement lus, 90 remboursés : octets_lus ne surestime pas.
        assert_eq!(reste.load(Ordering::Relaxed), 90);
        let _ = std::fs::remove_file(p);
    }

    #[test]
    fn tri_par_groupe_ne_melange_pas_les_groupes() {
        let mut groupes = vec![
            (
                CleGroupe {
                    gain: 10,
                    taille: 5,
                    mtime: 1,
                    count: 3,
                    nom: "b".into(),
                },
                vec![1u32, 2],
            ),
            (
                CleGroupe {
                    gain: 50,
                    taille: 5,
                    mtime: 2,
                    count: 2,
                    nom: "a".into(),
                },
                vec![3u32],
            ),
            (
                CleGroupe {
                    gain: 10,
                    taille: 5,
                    mtime: 3,
                    count: 4,
                    nom: "a".into(),
                },
                vec![4u32, 5, 6, 7],
            ),
        ];
        trier_par_cle(&mut groupes, TriGroupe::Gain, true);
        assert_eq!(groupes[0].1, vec![3]);
        assert_eq!(groupes[1].1, vec![4, 5, 6, 7]);
        assert_eq!(groupes[2].1, vec![1, 2]);
        // Les groupes restent des unités : aucune ligne ne change de vecteur.
        assert_eq!(groupes.len(), 3);
        assert_eq!(groupes.iter().map(|g| g.1.len()).sum::<usize>(), 7);
    }

    #[test]
    fn gain_ne_compte_pas_deux_fois_un_hardlink() {
        assert_eq!(gain_groupe(100, 0), 0);
        assert_eq!(gain_groupe(100, 1), 0);
        assert_eq!(gain_groupe(100, 2), 100);
        assert_eq!(gain_groupe(100, 3), 200);
    }

    #[test]
    fn categories_par_extension() {
        assert_eq!(categorie("film.MKV"), "video");
        assert_eq!(categorie("photo.JPG"), "image");
        assert_eq!(categorie("archive.zip"), "archive");
        assert_eq!(categorie("son.flac"), "audio");
        assert_eq!(categorie("note.txt"), "doc");
        assert_eq!(categorie("inconnu.xyz"), "autre");
        assert_eq!(categorie("sans-extension"), "autre");
        assert!(Categorie::Video.accepte("film.mkv"));
        assert!(!Categorie::Image.accepte("film.mkv"));
        assert_eq!(Categorie::depuis("all"), None);
        assert_eq!(Categorie::depuis("vidéos"), Some(Categorie::Video));
        assert_eq!(Categorie::depuis("n-importe-quoi"), None);
    }

    #[test]
    fn cache_vide_au_changement_de_generation() {
        let mut c = CacheEmpreintes::new();
        c.prepare('C', 1);
        c.put_complet(3, 10, 100, [1u8; 32]);
        assert!(c.get(3, 10, 100).unwrap().fullhash.is_some());
        // Même volume, nouvelle génération : les positions ont changé de sens.
        c.prepare('C', 2);
        assert!(c.get(3, 10, 100).is_none());
        // Autre volume : même conclusion.
        c.prepare('D', 2);
        c.put_prehash(1, 2, 3, [4u8; 32]);
        assert!(c.get(1, 2, 3).is_some());
        c.prepare('C', 2);
        assert!(c.get(1, 2, 3).is_none());
    }
}
