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
    let r = unsafe { SHFileOperationW(&mut op) };
    if r != 0 {
        return Err(format!("SHFileOperationW a renvoyé {r}"));
    }
    if op.f_any_operations_aborted != 0 {
        return Err("opération abandonnée par le système".into());
    }
    Ok(())
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
