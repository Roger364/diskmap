// Accès direct à une poignée d'appels Win32 : énumération des volumes, type, espace
// libre/occupé, système de fichiers. On évite une dépendance `windows-sys` pour trois
// fonctions — déclarées ici à la main, avec la convention `system` (stdcall sur x86).

use std::os::windows::ffi::{OsStrExt, OsStringExt};

#[link(name = "kernel32")]
extern "system" {
    fn GetLogicalDrives() -> u32;
    fn GetDriveTypeW(root: *const u16) -> u32;
    fn GetDiskFreeSpaceExW(
        dir: *const u16,
        avail_to_caller: *mut u64,
        total: *mut u64,
        total_free: *mut u64,
    ) -> i32;
    fn GetVolumeInformationW(
        root: *const u16,
        name: *mut u16,
        name_len: u32,
        serial: *mut u32,
        max_comp_len: *mut u32,
        flags: *mut u32,
        fs_name: *mut u16,
        fs_name_len: u32,
    ) -> i32;
}

#[link(name = "kernel32")]
extern "system" {
    fn GetCurrentProcess() -> *mut std::ffi::c_void;
    fn CloseHandle(h: *mut std::ffi::c_void) -> i32;
}

// Le jeton du processus vit dans advapi32, pas dans kernel32.
#[link(name = "advapi32")]
extern "system" {
    fn OpenProcessToken(process: *mut std::ffi::c_void, access: u32, token: *mut *mut std::ffi::c_void) -> i32;
    fn GetTokenInformation(
        token: *mut std::ffi::c_void,
        class: u32,
        info: *mut std::ffi::c_void,
        info_len: u32,
        ret_len: *mut u32,
    ) -> i32;
}

/// TOKEN_QUERY : seul droit nécessaire pour lire le jeton, jamais pour agir.
const TOKEN_QUERY: u32 = 0x0008;
/// TokenElevation (TOKEN_INFORMATION_CLASS).
const TOKEN_ELEVATION: u32 = 20;

#[repr(C)]
struct Elevation {
    token_is_elevated: u32,
}

/// Vrai si le processus tourne avec un jeton élevé (administrateur).
///
/// Sert à ne pas conseiller une relance en administrateur à quelqu'un qui y est
/// **déjà** : le conseil serait faux, et enverrait chercher au mauvais endroit.
/// Un refus de droits qui survit à l'élévation a une autre cause — une ACL qui
/// exclut aussi les administrateurs, ou un point d'analyse à ne pas suivre.
///
/// En cas d'échec on répond `false` : supposer qu'on n'est pas élevé conduit à
/// conseiller une relance inutile, alors que supposer l'inverse ferait taire un
/// conseil utile.
pub fn est_eleve() -> bool {
    unsafe {
        let mut token: *mut std::ffi::c_void = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return false;
        }
        let mut info = Elevation { token_is_elevated: 0 };
        let mut ret: u32 = 0;
        let ok = GetTokenInformation(
            token,
            TOKEN_ELEVATION,
            &mut info as *mut Elevation as *mut std::ffi::c_void,
            std::mem::size_of::<Elevation>() as u32,
            &mut ret,
        );
        CloseHandle(token);
        ok != 0 && info.token_is_elevated != 0
    }
}

// Types de lecteurs (WinBase.h)
pub const DRIVE_UNKNOWN: u32 = 0;
pub const DRIVE_NO_ROOT_DIR: u32 = 1;
pub const DRIVE_REMOVABLE: u32 = 2;
pub const DRIVE_FIXED: u32 = 3;
pub const DRIVE_REMOTE: u32 = 4;
pub const DRIVE_CDROM: u32 = 5;
pub const DRIVE_RAMDISK: u32 = 6;

fn to_wide(s: &str) -> Vec<u16> {
    use std::ffi::OsStr;
    OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
}

fn from_wide(ptr: *const u16, len: usize) -> String {
    if ptr.is_null() {
        return String::new();
    }
    let slice = unsafe { std::slice::from_raw_parts(ptr, len) };
    let end = slice.iter().position(|&c| c == 0).unwrap_or(len);
    match std::ffi::OsString::from_wide(&slice[..end]).to_str() {
        Some(s) => s.to_string(),
        None => String::new(),
    }
}

#[derive(Clone, Debug)]
pub struct Drive {
    pub letter: char,
    pub label: String,
    pub fs: String,
    pub kind: u32,
    pub total: u64,
    pub free: u64,
}

/// Liste les lecteurs réellement utilisables (disques fixes, amovibles, réseau).
pub fn drives() -> Vec<Drive> {
    let mask = unsafe { GetLogicalDrives() };
    let mut out = Vec::new();
    for i in 0..26u32 {
        if mask & (1 << i) == 0 {
            continue;
        }
        let letter = (b'A' + i as u8) as char;
        let root = format!(r"{letter}:\");
        let w = to_wide(&root);
        let kind = unsafe { GetDriveTypeW(w.as_ptr()) };
        match kind {
            DRIVE_FIXED | DRIVE_REMOVABLE | DRIVE_REMOTE | DRIVE_RAMDISK => {}
            // Lecteur absent, CD/DVD vide, type inconnu : rien à analyser.
            _ => continue,
        }
        let (total, free) = space(&w).unwrap_or((0, 0));
        let (label, fs) = volume_info(&w);
        out.push(Drive {
            letter,
            label,
            fs,
            kind,
            total,
            free,
        });
    }
    out
}

// ---------------------------- effacement ----------------------------
//
// `SHFileOperationW` avec FOF_ALLOWUNDO envoie dans la corbeille : l'opération
// reste réversible, ce qui est la seule façon raisonnable d'implémenter une
// suppression dans un outil qui voit tous les disques.
//
// Attention : surtout pas de préfixe verbatim `\\?\` ici. Avec ce préfixe,
// SHFileOperation contourne la corbeille et supprime définitivement — exactement
// l'inverse de ce qu'on veut par défaut. Les chemins passés sont donc les
// chemins normaux (`C:\...`), pas ceux utilisés pour le scan.

const FO_DELETE: u32 = 3;
const FOF_SILENT: u16 = 0x0004;
const FOF_NOCONFIRMATION: u16 = 0x0010;
const FOF_ALLOWUNDO: u16 = 0x0040;
const FOF_NOERRORUI: u16 = 0x0400;

#[repr(C)]
struct ShFileOpStructW {
    hwnd: *mut std::ffi::c_void,
    w_func: u32,
    p_from: *const u16,
    p_to: *const u16,
    f_flags: u16,
    f_any_operations_aborted: i32,
    h_name_mappings: *mut std::ffi::c_void,
    lpsz_progress_title: *const u16,
}

#[link(name = "shell32")]
extern "system" {
    fn SHFileOperationW(op: *mut ShFileOpStructW) -> i32;
}

#[link(name = "bcrypt")]
extern "system" {
    fn BCryptGenRandom(alg: *mut std::ffi::c_void, buf: *mut u8, len: u32, flags: u32) -> i32;
}

/// Laisse Windows choisir son propre générateur.
const BCRYPT_USE_SYSTEM_PREFERRED_RNG: u32 = 0x0000_0002;

/// Octets imprévisibles fournis par le système.
///
/// Remplace un xorshift semé par l'horodatage, et c'était là le défaut : le jeton
/// de suppression s'écrivait `<ms>-<xorshift(ms)>`, donc l'horodatage était publié
/// en clair dans le jeton et le reste s'en déduisait entièrement. Mesuré le
/// 26/09/2026 : les deux horodatages étaient identiques, et explorer ±5 ms —
/// onze candidats au lieu de 2^32 — retrouvait le jeton. Un aléa qui ne dépend
/// pas de ce qu'on publie ne se déduit pas.
pub fn alea_u64() -> u64 {
    let mut b = [0u8; 8];
    let r = unsafe {
        BCryptGenRandom(
            std::ptr::null_mut(),
            b.as_mut_ptr(),
            b.len() as u32,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        )
    };
    if r == 0 {
        return u64::from_le_bytes(b);
    }
    // Repli : jamais une constante, qui serait le pire des cas — un jeton
    // prévisible pour tout le monde. On combine trois choses que l'appelant ne
    // voit pas : les nanosecondes, une adresse de pile (l'ASLR les rend
    // imprévisibles) et l'identifiant du processus.
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let adresse = &nanos as *const u64 as u64;
    nanos ^ adresse.rotate_left(17) ^ ((std::process::id() as u64) << 32)
}

/// `to_trash = true` : corbeille (réversible). `false` : suppression définitive.
pub fn delete_path(path: &str, to_trash: bool) -> Result<(), String> {
    if path.starts_with(r"\\?\") {
        return Err("chemin verbatim interdit pour une suppression".into());
    }
    // pFrom doit être une liste de chaînes terminée par un double zéro.
    let mut wide: Vec<u16> = to_wide(path);
    let len = wide.len();
    wide[len - 1] = 0;
    wide.push(0);

    let mut flags = FOF_SILENT | FOF_NOCONFIRMATION | FOF_NOERRORUI;
    if to_trash {
        flags |= FOF_ALLOWUNDO;
    }
    let mut op = ShFileOpStructW {
        hwnd: std::ptr::null_mut(),
        w_func: FO_DELETE,
        p_from: wide.as_ptr(),
        p_to: std::ptr::null(),
        f_flags: flags,
        f_any_operations_aborted: 0,
        h_name_mappings: std::ptr::null_mut(),
        lpsz_progress_title: std::ptr::null(),
    };
    let chemin = std::path::Path::new(path);
    let r = unsafe { SHFileOperationW(&mut op) };

    // Le code de retour n'est PAS un verdict, et s'y fier était le défaut.
    // Mesuré sur cette machine le 26/09/2026, quatre fois sur quatre : le
    // recyclage RÉUSSIT en renvoyant 2 (ERROR_FILE_NOT_FOUND), et le fichier
    // est bien dans la corbeille. Conclure « échec » sur un code non nul
    // rapportait donc chaque suppression réversible comme un échec — pendant
    // que le fichier, lui, avait bel et bien disparu.
    // Le seul juge est l'état du disque après coup ; le code ne sert plus qu'à
    // décrire un échec réel, quand le chemin est toujours là.
    if op.f_any_operations_aborted != 0 {
        return Err("opération abandonnée par le système".into());
    }
    if !chemin.exists() {
        return Ok(());
    }
    if r != 0 {
        return Err(format!("SHFileOperationW a renvoyé {r}"));
    }
    Err("le chemin existe toujours après l'opération".into())
}

/// Une fiche `$I` de la corbeille nomme le fichier qu'elle décrit. On la lit.
///
/// Format MESURÉ sur cette machine le 26/09/2026, sur les 1194 fiches de G: —
/// toutes en version 2, et toutes décodées en chemins bien formés (`X:\…`) :
///   0x00  u32  version (2)
///   0x08  u64  taille du fichier
///   0x10  u64  date de suppression (FILETIME)
///   0x18  u32  longueur du chemin, en caractères
///   0x1C  …    chemin d'origine, UTF-16LE, terminé par un zéro
///
/// La longueur n'est utilisée que comme borne : on s'arrête au premier zéro, ce
/// qui rend le décodage insensible à ce qu'elle compte exactement (caractères
/// utiles, ou zéro final compris).
fn fiche_i(b: &[u8]) -> Option<(String, u64)> {
    if b.len() < 0x20 {
        return None;
    }
    let version = u32::from_le_bytes(b[0..4].try_into().ok()?);
    if version != 2 {
        return None;
    }
    let quand = u64::from_le_bytes(b[0x10..0x18].try_into().ok()?);
    let n = u32::from_le_bytes(b[0x18..0x1C].try_into().ok()?) as usize;
    if n == 0 {
        return None;
    }
    let fin = (0x1C + n * 2).min(b.len());
    let mut u: Vec<u16> = Vec::with_capacity(n);
    let mut i = 0x1C;
    while i + 1 < fin {
        let c = u16::from_le_bytes([b[i], b[i + 1]]);
        if c == 0 {
            break;
        }
        u.push(c);
        i += 2;
    }
    Some((String::from_utf16_lossy(&u), quand))
}

/// Le volume a-t-il une corbeille où aller ? Sert à AVERTIR avant, et non
/// seulement à constater après.
///
/// Ce n'est qu'un indice, et il faut le présenter comme tel : un volume peut
/// avoir une corbeille et la refuser quand même — fichier plus gros que la taille
/// maximale allouée, par exemple. Son ABSENCE, en revanche, est un fait : c'est
/// le cas de `E:`, mesuré, où Windows supprime définitivement sans le dire.
pub fn corbeille_disponible(lettre: char) -> bool {
    std::path::Path::new(&format!("{lettre}:\\$RECYCLE.BIN")).is_dir()
}

/// Écart entre l'époque FILETIME (1601) et l'époque Unix, en unités de 100 ns.
const EPOQUE_FILETIME: u64 = 116_444_736_000_000_000;

/// La fiche a-t-elle été écrite depuis `plancher_ms` ?
///
/// En cas de doute — date illisible — on répond OUI. Un faux « non » écarterait
/// la fiche qu'on cherche, et ferait journaliser une destruction comme une
/// opération réversible : c'est le défaut qu'on cherche justement à ne plus
/// commettre. Un faux « oui » ne coûte qu'une lecture inutile.
fn fiche_recente(f: &std::fs::DirEntry, plancher_ms: u64) -> bool {
    let Ok(md) = f.metadata() else { return true };
    let Ok(m) = md.modified() else { return true };
    match m.duration_since(std::time::UNIX_EPOCH) {
        Ok(d) => d.as_millis() as u64 >= plancher_ms,
        Err(_) => true,
    }
}

/// Le fichier est-il RÉELLEMENT dans la corbeille du volume qui le portait ?
///
/// On ne peut pas se fier à `FOF_ALLOWUNDO` : il signifie « mets à la corbeille
/// **si c'est possible** ». Mesuré le 26/09/2026 : sur `E:`, volume sans
/// corbeille, l'opération réussit, renvoie 0, et le fichier est **DÉTRUIT** —
/// pendant que l'application annonçait une opération réversible et journalisait
/// « corbeille ». Un fichier introuvable dans toutes les corbeilles de la
/// machine.
///
/// Le seul juge est donc la corbeille elle-même : chaque fichier recyclé y
/// laisse une fiche `$I` portant son chemin d'origine. On exige en plus que la
/// date de la fiche soit postérieure au début de l'opération — sans quoi une
/// fiche laissée par une suppression ANTÉRIEURE du même chemin ferait passer
/// une destruction pour un succès.
/// Les fiches `$I` d'un volume, lues **une fois**.
///
/// `execute` appelait la vérification pour CHAQUE élément supprimé, et chaque
/// appel relisait toutes les fiches du volume : le coût était donc N × M, où M
/// est le nombre de fiches — et M croît avec l'usage du disque. Mesuré le
/// 26/09/2026 sur G: : **193 ms pour un seul balayage** de 1500 fiches, soit
/// 19 s pour 100 fichiers et 96 s pour 500. Une suppression de dossier y
/// devenait inutilisable, sans que rien ne le signale.
///
/// On lit donc l'index une fois, **après** les suppressions : c'est seulement
/// là que les fiches des fichiers qu'on vient d'envoyer existent.
pub struct Corbeille {
    /// (chemin d'origine, date de suppression en FILETIME)
    fiches: Vec<(String, u64)>,
}

impl Corbeille {
    /// Lit les fiches du volume, en **écartant par la date avant de les ouvrir**.
    ///
    /// Une fiche n'est utile que si elle décrit une suppression récente : c'est
    /// la seule question qu'on lui pose. Or sur cette machine, lire 1500 fiches
    /// coûte 190 ms tandis que les ÉNUMÉRER en coûte 3 — c'est l'ouverture du
    /// fichier qui porte tout le prix, pas le parcours du dossier. On compare
    /// donc la date d'écriture de la fiche, que l'énumération fournit déjà
    /// (`DirEntry::metadata` ne coûte aucun appel système supplémentaire sous
    /// Windows), avant de l'ouvrir.
    ///
    /// Mesuré le 26/09/2026, corbeille de G: à ~1500 fiches : le balayage
    /// complet coûtait 305 ms par requête, et c'est lui qui dominait le coût
    /// d'une suppression d'UN fichier (335 ms au total).
    pub fn lire(lettre: char, depuis_ms: u64) -> Corbeille {
        let mut fiches = Vec::new();
        let racine = format!("{lettre}:\\$RECYCLE.BIN");
        // Pas de corbeille du tout : c'est exactement le cas de E:.
        let Ok(sids) = std::fs::read_dir(&racine) else {
            return Corbeille { fiches };
        };
        // Même marge que `contient` : deux arrondis valent mieux qu'un.
        let plancher_ms = depuis_ms.saturating_sub(2_000);
        for sid in sids.flatten() {
            // Certains sous-dossiers appartiennent à d'autres comptes et
            // renvoient EPERM : notre fichier est dans le nôtre, on saute les
            // autres — et surtout on ne les confond pas avec « vide ».
            let Ok(entrees) = std::fs::read_dir(sid.path()) else { continue };
            for f in entrees.flatten() {
                let nom = f.file_name().to_string_lossy().into_owned();
                if !nom.starts_with("$I") {
                    continue;
                }
                if !fiche_recente(&f, plancher_ms) {
                    continue;
                }
                let Ok(b) = std::fs::read(f.path()) else { continue };
                if let Some((chemin, quand)) = fiche_i(&b) {
                    fiches.push((chemin, quand));
                }
            }
        }
        Corbeille { fiches }
    }

    /// Ce chemin a-t-il été pris par la corbeille **depuis** `depuis_ms` ?
    ///
    /// Le plancher de date n'est pas une coquetterie : une fiche plus ancienne
    /// décrit une suppression ANTÉRIEURE du même chemin, et ferait passer une
    /// destruction pour une opération réversible.
    pub fn contient(&self, path: &str, depuis_ms: u64) -> bool {
        let plancher = depuis_ms.saturating_sub(2_000) * 10_000 + EPOQUE_FILETIME;
        self.fiches
            .iter()
            .any(|(c, q)| *q >= plancher && c.eq_ignore_ascii_case(path))
    }
}

fn space(w: &[u16]) -> Option<(u64, u64)> {
    let mut avail: u64 = 0;
    let mut total: u64 = 0;
    let mut free: u64 = 0;
    let ok = unsafe { GetDiskFreeSpaceExW(w.as_ptr(), &mut avail, &mut total, &mut free) };
    if ok != 0 {
        Some((total, avail))
    } else {
        None
    }
}

fn volume_info(w: &[u16]) -> (String, String) {
    let mut name = [0u16; 64];
    let mut fs = [0u16; 32];
    let mut serial: u32 = 0;
    let mut maxc: u32 = 0;
    let mut flags: u32 = 0;
    let ok = unsafe {
        GetVolumeInformationW(
            w.as_ptr(),
            name.as_mut_ptr(),
            name.len() as u32,
            &mut serial,
            &mut maxc,
            &mut flags,
            fs.as_mut_ptr(),
            fs.len() as u32,
        )
    };
    if ok == 0 {
        return (String::new(), String::new());
    }
    (from_wide(name.as_ptr(), name.len()), from_wide(fs.as_ptr(), fs.len()))
}
