// Accès direct à une poignée d'appels Win32 : énumération des volumes, type, espace
// libre/occupé, système de fichiers. On évite une dépendance `windows-sys` pour trois
// fonctions — déclarées ici à la main, avec la convention `system` (stdcall sur x86).

use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::os::windows::fs::MetadataExt;

const REPARSE_POINT: u32 = 0x0000_0400;

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
    fn OpenProcessToken(
        process: *mut std::ffi::c_void,
        access: u32,
        token: *mut *mut std::ffi::c_void,
    ) -> i32;
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
        let mut info = Elevation {
            token_is_elevated: 0,
        };
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
pub const DRIVE_REMOVABLE: u32 = 2;
pub const DRIVE_FIXED: u32 = 3;
pub const DRIVE_REMOTE: u32 = 4;
pub const DRIVE_RAMDISK: u32 = 6;

fn to_wide(s: &str) -> Vec<u16> {
    use std::ffi::OsStr;
    OsStr::new(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
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
    /// Identité stable du volume. Une lettre peut changer de support entre deux
    /// lancements, elle ne doit donc jamais suffire à valider un cache.
    pub serial: u32,
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
        let (label, fs, serial) = volume_info(&w);
        out.push(Drive {
            letter,
            label,
            fs,
            serial,
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

/// Indique si l'entrée elle-même est une jonction, un lien symbolique ou un
/// autre point d'analyse. `symlink_metadata` est essentiel : `metadata` suit le
/// lien et inspecterait sa cible au lieu de l'entrée qui va être supprimée.
pub fn is_reparse_point(path: &std::path::Path) -> Result<bool, String> {
    std::fs::symlink_metadata(path)
        .map(|meta| meta.file_attributes() & REPARSE_POINT != 0)
        .map_err(|e| e.to_string())
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

// ---------------------------------------------------------------------------
// L'état RÉEL de la corbeille : ce qu'elle peut garder, et ce qu'elle garde déjà.
//
// Ce que l'application savait déjà, c'est si le fichier EST entré dans la
// corbeille — les fiches `$I` sont lues après la suppression et l'issue est
// journalisée comme ce qui a eu lieu. Ce qu'elle ne mesurait pas, et qu'elle
// affirmait quand même en afficheant « récupérables dans la corbeille », c'est
// que la corbeille le GARDERA.
//
// Elle ne le garde pas toujours. Windows plafonne la corbeille de chaque volume
// (`MaxCapacity`) et, passé le plafond, PURGE les entrées les plus anciennes
// SANS DEMANDER : supprimer un fichier peut en détruire un autre, sans que
// personne l'ait demandé et sans que le journal en parle. Le 27/09/2026, trois
// volumes de cette machine portaient `NeedToPurge` — le drapeau de Windows qui
// dit exactement cela. Aucune ligne de code ne le lisait.
//
// Le plafond se lit dans le registre de l'utilisateur ; l'occupation se mesure
// sur les fiches `$I`, dont l'en-tête version 2 porte la taille d'origine à
// l'octet 4 : 12 octets suffisent, sans parcourir l'arborescence d'une charge de
// 40 Go.
// ---------------------------------------------------------------------------

/// `HKEY_CURRENT_USER`, en tant que poignée.
const HKEY_CURRENT_USER: *mut std::ffi::c_void = 0x8000_0001usize as *mut std::ffi::c_void;
/// `RRF_RT_REG_DWORD` : la valeur est un DWORD, et le reste est une erreur.
const RRF_RT_REG_DWORD: u32 = 0x0000_0018;
/// `RRF_SUBKEY_WOW6464KEY` : lire la vue 32 bits si le processus l'est. Sans ce
/// drapeau, un binaire 32 bits lirait un emplacement que le 64 bits n'écrit pas.
const RRF_SUBKEY_WOW6464KEY: u32 = 0x0001_0000;
/// Nombre maximal de fiches ouvertes pour mesurer. Au-delà, la mesure est
/// INCOMPLÈTE et le dit : une sous-estimation qui se déguise en exactitude
/// produirait un avertissement faux, ce qui est pire que pas d'avertissement.
const CORBEILLE_FICHES_MAX: usize = 4_000;

#[link(name = "kernel32")]
extern "system" {
    fn GetVolumeNameForVolumeMountPointW(mount: *const u16, name: *mut u16, name_len: u32) -> i32;
}

#[link(name = "advapi32")]
extern "system" {
    fn RegGetValueW(
        hkey: *mut std::ffi::c_void,
        sub_key: *const u16,
        value: *const u16,
        flags: u32,
        out_type: *mut u32,
        out_data: *mut u8,
        out_size: *mut u32,
    ) -> i32;
}

/// Le GUID du volume, tel que le registre l'indexe.
///
/// `GetVolumeNameForVolumeMountPointW` est la fonction qui rend
/// `\\?\Volume{325a8542-…}\`, et c'est ce nom qui sert de sous-clé sous
/// `BitBucket\Volume`. `GetVolumeInformationW` aurait paru convenir — son nom
/// le promet — mais elle ne prend AUCUN paramètre de format : le drapeau
/// `VOLUME_NAME_GUID` n'existe que sur sa cousine `…ByHandleW`. On l'a essayée,
/// elle rend le LIBELLE du volume, et le plafond n'est jamais mesuré. C'est le
/// genre d'erreur qui ne se voit pas : la fonction ne rend pas `None`, elle
/// rend `None` pour une raison qu'on ne cherche pas.
fn guid_volume(lettre: char) -> Option<String> {
    let racine: Vec<u16> = format!("{lettre}:\\")
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let mut tampon = [0u16; 64];
    let ok = unsafe {
        GetVolumeNameForVolumeMountPointW(racine.as_ptr(), tampon.as_mut_ptr(), tampon.len() as u32)
    };
    if ok == 0 {
        return None;
    }
    let fin = tampon.iter().position(|&c| c == 0)?;
    let brut = String::from_utf16_lossy(&tampon[..fin]);
    // `\\?\Volume{325a8542-…}\` -> `{325a8542-…}` : la sous-clé ne garde que les
    // accolades. Une forme inattendue ne se devine pas — elle rend `None`.
    let debut = brut.find('{')?;
    let fin = brut.rfind('}')?;
    if debut >= fin {
        return None;
    }
    Some(brut[debut..=fin].to_string())
}

fn lire_dword(sous_cle: &str, valeur: &str) -> Option<u32> {
    let sk: Vec<u16> = sous_cle.encode_utf16().chain(Some(0)).collect();
    let v: Vec<u16> = valeur.encode_utf16().chain(Some(0)).collect();
    let mut out: u32 = 0;
    let mut taille: u32 = std::mem::size_of::<u32>() as u32;
    let code = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            sk.as_ptr(),
            v.as_ptr(),
            RRF_RT_REG_DWORD | RRF_SUBKEY_WOW6464KEY,
            std::ptr::null_mut(),
            (&mut out as *mut u32).cast::<u8>(),
            &mut taille,
        )
    };
    (code == 0).then_some(out)
}

/// Ce que la corbeille du volume peut garder, et ce qu'elle garde déjà.
pub struct EtatCorbeille {
    /// Plafond configuré, en octets. `None` = clé absente ou volume inconnu.
    /// On ne TOMBE PAS sur un plafond par défaut documenté mais non mesuré : un
    /// plafond inventé donnerait le verdict « ça tient », qui serait faux.
    pub plafond: Option<u64>,
    /// Octets déjà pris, mesurés sur les tailles déclarées par les fiches `$I`.
    pub occupe: u64,
    /// La mesure est-elle allée jusqu'au bout ? Faux ⇒ `occupe` est un MINIMUM,
    /// et l'interface doit le dire au lieu de le présenter comme exact.
    pub complet: bool,
}

impl EtatCorbeille {
    /// Le lot tient-il dans la corbeille ?
    ///
    /// `Some(true)` : il déborde. `Some(false)` : il tient. `None` : indécidable,
    /// faute de plafond mesuré — et l'interface n'affirmera alors rien.
    ///
    /// « Il déborde » décrit un ÉTAT qu'on va créer, pas un dommage qu'on
    /// provoque : mesuré le 27/09/2026 sur `V:`, 12 fichiers de 6 Mo pour un
    /// plafond de 51 Mo, la corbeille a fini à **1,66 fois** son plafond et
    /// les 12 fichiers y étaient. Windows n'a rien détruit à cet instant —
    /// le plafond n'est pas appliqué à la suppression. Ce qui suit, la purge,
    /// Windows la décide plus tard, à son rythme, sans prévenir.
    ///
    /// C'est pourquoi le calcul se contente de comparer : dire « Windows va
    /// détruire » au moment de la suppression aurait été faux, et l'a été
    /// pendant une heure. Ce que le calcul garantit, en revanche, c'est
    /// qu'aucune affirmation optimiste n'est faite sur un volume dont on
    /// ignore la contenance — c'est le sens du `None`.
    pub fn deborde(&self, lot: u64) -> Option<bool> {
        self.plafond.map(|p| self.occupe.saturating_add(lot) > p)
    }
}

/// Mesure l'état de la corbeille d'un volume.
///
/// Le coût est celui de l'OUVERTURE des fiches, pas de leur énumération (mesuré
/// le 26/09/2026 sur G: : 3 ms pour en énumérer 1500, 190 ms pour les ouvrir).
/// D'où le plafond d'ouvertures et le `complet` : au-delà de 4 000 fiches on
/// s'arrête et on déclare la mesure incomplète, plutôt que de faire attendre
/// l'interface en énumérant une corbeille de disque saturé.
pub fn etat_corbeille(lettre: char) -> EtatCorbeille {
    let plafond = guid_volume(lettre).and_then(|g| {
        lire_dword(
            &format!(
                "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\BitBucket\\Volume\\{g}"
            ),
            "MaxCapacity",
        )
        // La clé est en mégaoctets. Un zéro n'est pas un plafond de zéro octets,
        // c'est une valeur absente déguisée : on ne le confond pas.
        .filter(|mio| *mio > 0)
        .map(|mio| u64::from(mio) * 1_048_576)
    });

    let mut occupe = 0u64;
    let mut lus = 0usize;
    let mut complet = true;
    if let Ok(sids) = std::fs::read_dir(format!("{lettre}:\\$RECYCLE.BIN")) {
        for sid in sids.flatten() {
            // Un sous-dossier d'un autre compte renvoie EPERM : ce n'est pas une
            // corbeille vide, et son volume est déjà connu par ailleurs. On
            // l'écarte, et la mesure reste celle DU COMPTE COURANT — ce que
            // Windows purge, lui, l'est aussi.
            let Ok(entrees) = std::fs::read_dir(sid.path()) else {
                continue;
            };
            for f in entrees.flatten() {
                let nom = f.file_name().to_string_lossy().into_owned();
                if !nom.starts_with("$I") {
                    continue;
                }
                if lus >= CORBEILLE_FICHES_MAX {
                    complet = false;
                    break;
                }
                // Une `$I` sans sa charge `$R` est une fiche ORPHELINE : elle
                // décrit un fichier qui n'est plus dans la corbeille. La compter
                // ferait dire « la corbeille est pleine » d'un vide, et c'est le
                // chiffre qui décide du verdict. C'est aussi ce que laisse une
                // purge de Windows — d'où la vérification, et non une confiance.
                if !f
                    .path()
                    .with_file_name(nom.replacen("$I", "$R", 1))
                    .exists()
                {
                    continue;
                }
                if let Some(t) = taille_croyable(&f.path()) {
                    occupe = occupe.saturating_add(t);
                    lus += 1;
                }
            }
            if !complet {
                break;
            }
        }
    }
    EtatCorbeille {
        plafond,
        occupe,
        complet,
    }
}

/// Fenêtre dans laquelle une date de suppression est believable : de 1990 à 2100.
///
/// Une fiche `$I` illisible — écriture interrompue, format d'une autre
/// version — porte alors une date qui n'est pas une date. Mesuré le 27/09/2026 sur G: : une `$I` de 152 octets
/// dont l'octet 8 valait 4,4 Po, et dont la somme faisait basculer l'occupation
/// de la corbeille à `u64::MAX`. Une mesure de Charpie ne se laisse pas compter.
const FILETIME_MIN: u64 = 122_756_256_000_000_000; // 1990-01-01
const FILETIME_MAX: u64 = 157_469_184_000_000_000; // 2100-01-01

/// La taille qu'une fiche `$I` déclare pour sa charge — si elle est croyable.
///
/// L'en-tête de la version 2 a été MESURÉ, pas supposé : deux fichiers de
/// tailles connues ont été mis à la corbeille, puis leurs `$I` relues. Le
/// champ taille est à l'octet 8, et non à l'octet 4 comme le laissait croire la
/// disposition la plus citée. Un octet de décalage ne se voit pas — il ne
/// produit aucune erreur, seulement des tailles fausses.
///
/// ```
/// 0x00  4  version (2)      0x0C  4  (réservé)
/// 0x04  4  (réservé)        0x10  8  date de suppression (FILETIME)
/// 0x08  8  TAILLE           0x18  4  longueur du chemin
/// ```
///
/// Seuls les 24 premiers octets sont lus : une fiche est surtout un chemin, et
/// un chemin long se lirait pour rien. La date est exigée plausible, parce
/// qu'une `$I` mal écrite ferait passer un nombre aberrant pour une taille.
fn taille_croyable(fiche: &std::path::Path) -> Option<u64> {
    use std::io::Read;
    let mut f = std::fs::File::open(fiche).ok()?;
    let mut entete = [0u8; 24];
    f.read_exact(&mut entete).ok()?;
    if u32::from_le_bytes(entete[0..4].try_into().ok()?) != 2 {
        return None;
    }
    let quand = u64::from_le_bytes(entete[16..24].try_into().ok()?);
    if !(FILETIME_MIN..FILETIME_MAX).contains(&quand) {
        return None;
    }
    Some(u64::from_le_bytes(entete[8..16].try_into().ok()?))
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
            let Ok(entrees) = std::fs::read_dir(sid.path()) else {
                continue;
            };
            for f in entrees.flatten() {
                let nom = f.file_name().to_string_lossy().into_owned();
                if !nom.starts_with("$I") {
                    continue;
                }
                if !fiche_recente(&f, plancher_ms) {
                    continue;
                }
                let Ok(b) = std::fs::read(f.path()) else {
                    continue;
                };
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

fn volume_info(w: &[u16]) -> (String, String, u32) {
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
        return (String::new(), String::new(), 0);
    }
    (
        from_wide(name.as_ptr(), name.len()),
        from_wide(fs.as_ptr(), fs.len()),
        serial,
    )
}

#[cfg(test)]
mod tests {
    use super::EtatCorbeille;

    /// La taille d'une charge est à l'octet 8 de l'en-tête `$I` version 2 —
    /// et à l'octet 4 on lit n'importe quoi, sans le moindre symptôme.
    ///
    /// L'en-tête est reconstruit ici depuis ce que la corbeille de `V:` a
    /// réellement écrit : version, 4 octets nuls, taille, date, longueur du
    /// chemin. Un octet de bourrage en trop — la disposition la plus citée en
    /// compte un — et ce test échoue, ce qui est exactement son rôle.
    #[test]
    fn la_taille_declaree_est_a_son_place() {
        let mut entete = Vec::new();
        entete.extend_from_slice(&2u32.to_le_bytes());
        entete.extend_from_slice(&[0u8; 4]);
        entete.extend_from_slice(&4096u64.to_le_bytes());
        entete.extend_from_slice(&134_000_000_000_000_000u64.to_le_bytes());
        entete.extend_from_slice(&4u32.to_le_bytes());
        entete.extend_from_slice(&[0u8; 8]);
        // `taille_croyable` lit un FICHIER : on écrit, on relit.
        let p = std::env::temp_dir().join(format!("dm-fiche-{}.bin", std::process::id()));
        std::fs::write(&p, &entete).unwrap();
        let t = super::taille_croyable(&p);
        let _ = std::fs::remove_file(&p);
        assert_eq!(t, Some(4096));
    }

    /// Une date illisible ne se laisse pas compter comme une taille.
    ///
    /// C'est le défaut que la mesure a réellement rencontré : une `$I` de 152
    /// octets sur G: portait 4,4 Po à l'octet 8 et une date qui n'était pas une
    /// date. Sans ce refus, l'occupation de la corbeille vaut `u64::MAX` et le
    /// verdict « ça ne tient pas » serait vrai par accident, pour la mauvaise
    /// raison — sur n'importe quel volume, y compris une corbeille vide.
    #[test]
    fn une_fiche_illisible_ne_devient_pas_une_taille() {
        let mut entete = Vec::new();
        entete.extend_from_slice(&2u32.to_le_bytes());
        entete.extend_from_slice(&[0u8; 4]);
        entete.extend_from_slice(&0x3cd4_11c0_0000_0000u64.to_le_bytes());
        entete.extend_from_slice(&0x3e_01dd4d4bu64.to_le_bytes()); // pas une date
        let p = std::env::temp_dir().join(format!("dm-fiche-bad-{}.bin", std::process::id()));
        std::fs::write(&p, &entete).unwrap();
        let t = super::taille_croyable(&p);
        let _ = std::fs::remove_file(&p);
        assert_eq!(t, None);
    }

    /// Un plafond inconnu ne vaut pas « ça tient ».
    ///
    /// C'est tout l'intérêt du `Option` : sans plafond mesuré, aucune
    /// affirmation optimiste ne doit sortir. Un défaut de 5 % dokumenté mais
    /// non relevé produirait ici un `Some(false)` — c'est-à-dire exactement le
    /// mensonge qu'on a retiré de l'interface.
    #[test]
    fn sans_plafond_mesure_on_ne_prononce_nothing() {
        let e = EtatCorbeille {
            plafond: None,
            occupe: 0,
            complet: true,
        };
        assert_eq!(e.deborde(u64::MAX), None);
    }

    #[test]
    fn un_lot_qui_depasse_le_plafond_est_annonce() {
        let e = EtatCorbeille {
            plafond: Some(100),
            occupe: 90,
            complet: true,
        };
        assert_eq!(e.deborde(20), Some(true));
        assert_eq!(e.deborde(10), Some(false));
    }

    /// Une mesure INCOMPLÈTE reste un minimum, jamais un total : c'est ce que
    /// `complet` sert à dire à l'interface, et ce que l'occupation plus le lot
    /// ne doit pas faire oublier.
    #[test]
    fn une_mesure_incomplete_porte_encore_son_drapeau() {
        let e = EtatCorbeille {
            plafond: Some(100),
            occupe: 90,
            complet: false,
        };
        assert_eq!(e.deborde(5), Some(false));
        assert!(!e.complet, "l'interface doit pouvoir dire « au moins »");
    }

    /// Le débordement ne peut pas s'inverser par saturation : un lot absurdement
    /// grand plus une occupation au bord ne doit pas revenir « ça tient ».
    #[test]
    fn la_saturation_ne_retourne_pas_la_vraie() {
        let e = EtatCorbeille {
            plafond: Some(10),
            occupe: u64::MAX - 1,
            complet: true,
        };
        assert_eq!(e.deborde(100), Some(true));
    }
}
