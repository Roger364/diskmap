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
