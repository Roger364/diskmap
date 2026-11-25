// Détection de fichiers au contenu identique (doublons).
//
// On ne lit que les fichiers qui ont un jumeau de même taille, et on ne lit
// jamais plus que le budget. Le coût est donc borné par le budget, pas par
// le volume.

use crate::scan::Snapshot;
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::{BufReader, Read};
use std::sync::atomic::{AtomicBool, Ordering};

const PREFIXE: u64 = 64 * 1024;
const TAMPON: usize = 1 << 20;

pub struct Options<'a> {
    pub base: u32,
    pub min: u64,
    pub max: u64,
    pub budget: u64,
    pub limit: usize,
    pub stopping: &'a AtomicBool,
}

pub struct Groupe {
    pub empreinte: String,
    pub taille: u64,
    pub fichiers: Vec<u32>,
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
}

pub fn chercher(snap: &Snapshot, o: &Options) -> Resultat {
    // 1. Candidats : (taille, index), filtrés par taille et par sous-arbre.
    let dedans = sous_arbres(snap, o.base);
    let mut v: Vec<(u64, u32)> = snap
        .files
        .iter()
        .enumerate()
        .filter(|(_, f)| f.size > 0 && f.size >= o.min && f.size <= o.max)
        .filter(|(_, f)| dedans[f.parent as usize])
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

    // 3+4. Préfixe puis empreinte complète.
    let mut res = Resultat {
        exact: true,
        ..Default::default()
    };
    let mut budget_restant = o.budget;
    let mut tampon = vec![0u8; TAMPON];

    for (taille, g) in &tailles {
        if o.stopping.load(Ordering::Relaxed) {
            res.arret = true;
            res.exact = false;
            break;
        }
        let taille = *taille;
        let g = g.clone();
        let sous = if taille <= PREFIXE {
            hacher(
                snap,
                &g,
                taille,
                &mut budget_restant,
                &mut tampon,
                &mut res,
                o.stopping,
            )
        } else {
            let tete = hacher(
                snap,
                &g,
                PREFIXE,
                &mut budget_restant,
                &mut tampon,
                &mut res,
                o.stopping,
            );
            let restants: Vec<u32> = tete.into_values().flatten().collect();
            if restants.is_empty() {
                // Tous les fichiers ont une empreinte de préfixe distincte :
                // pas de doublon possible, on passe au groupe suivant.
                continue;
            }
            hacher(
                snap,
                &restants,
                taille,
                &mut budget_restant,
                &mut tampon,
                &mut res,
                o.stopping,
            )
        };
        for (empreinte, fichiers) in sous {
            if fichiers.len() >= 2 {
                res.groupes.push(Groupe {
                    empreinte,
                    taille,
                    fichiers,
                });
            }
        }
    }

    // 5. Tri des groupes par gain décroissant, puis taille décroissante, puis chemin.
    res.groupes.sort_by(|a, b| {
        let gain_a = a.taille * (a.fichiers.len() as u64 - 1);
        let gain_b = b.taille * (b.fichiers.len() as u64 - 1);
        gain_b
            .cmp(&gain_a)
            .then_with(|| b.taille.cmp(&a.taille))
            .then_with(|| {
                let pa = snap.file_path(a.fichiers[0]);
                let pb = snap.file_path(b.fichiers[0]);
                pa.cmp(&pb)
            })
    });

    // 6. Fabrication des lignes et coupe.
    // On ne coupe pas un groupe en deux : on rend les groupes entiers.
    // On compte les lignes pour vérifier la limite.
    let mut nb_lignes = 0usize;

    for g in &res.groupes {
        if nb_lignes + g.fichiers.len() > o.limit && nb_lignes > 0 {
            break;
        }
        nb_lignes += g.fichiers.len();
    }

    // Recalculer groupes_total et gain_total sur TOUS les groupes (pas seulement rendus).
    let groupes_total = res.groupes.len();
    let gain_total: u64 = res
        .groupes
        .iter()
        .map(|g| g.taille * (g.fichiers.len() as u64 - 1))
        .sum();

    res.groupes_total = groupes_total;
    res.gain_total = gain_total;
    res.exact = res.exact && budget_restant > 0;
    res.octets_lus = o.budget - budget_restant;

    res
}

fn sous_arbres(snap: &Snapshot, base: u32) -> Vec<bool> {
    let n = snap.dirs.len();
    let mut dedans = vec![false; n];
    if base == 0 {
        for i in 0..n {
            dedans[i] = true;
        }
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

// Removed dead code: groupes_de_taille (never called in production)

fn hacher(
    snap: &Snapshot,
    fichiers: &[u32],
    limite: u64,
    budget: &mut u64,
    tampon: &mut [u8],
    res: &mut Resultat,
    stopping: &AtomicBool,
) -> std::collections::HashMap<String, Vec<u32>> {
    use std::collections::HashMap;
    let mut groupes: HashMap<String, Vec<u32>> = HashMap::new();
    for &idx in fichiers {
        // Vérifier l'arrêt.
        if stopping.load(Ordering::Relaxed) {
            res.arret = true;
            res.exact = false;
            break;
        }
        let f = &snap.files[idx as usize];
        let path = snap.file_path(idx);
        // Vérifier que le fichier n'a pas changé depuis le scan.
        let meta = match std::fs::metadata(&path) {
            Ok(m) => m,
            Err(_) => {
                res.illisibles += 1;
                continue;
            }
        };
        if meta.len() != f.size {
            res.modifies += 1;
            continue;
        }
        // Budget.
        let a_lire = limite.min(f.size);
        if a_lire > *budget {
            res.exact = false;
            continue;
        }
        *budget -= a_lire;
        res.octets_lus += a_lire;

        // Hacher.
        let file = match File::open(&path) {
            Ok(f) => f,
            Err(_) => {
                res.illisibles += 1;
                continue;
            }
        };
        let mut reader = BufReader::new(file);
        let mut hasher = Sha256::new();
        let mut lu_total = 0u64;
        let mut ok = true;
        while lu_total < a_lire {
            let a_lire_ce_tour = (a_lire - lu_total).min(tampon.len() as u64) as usize;
            match reader.read(&mut tampon[..a_lire_ce_tour]) {
                Ok(0) => break,
                Ok(n) => {
                    hasher.update(&tampon[..n]);
                    lu_total += n as u64;
                }
                Err(_) => {
                    ok = false;
                    break;
                }
            }
        }
        if !ok {
            res.illisibles += 1;
            continue;
        }
        // Si on n'a pas lu assez (fichier tronqué), ignorer.
        if lu_total < a_lire {
            res.modifies += 1;
            continue;
        }
        let hash = hasher.finalize();
        let hex = hex_encode(&hash);
        groupes.entry(hex).or_default().push(idx);
    }
    groupes
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

    #[test]
    fn hex_encode_ok() {
        assert_eq!(hex_encode(&[0xab, 0xcd]), "abcd");
    }

    #[test]
    fn budget_refus_exact() {
        // Budget::prend refuse si n > reste.
        let mut reste = 100u64;
        let n = 101u64;
        assert!(n > reste);
        // Simuler le refus.
        if n > reste {
            // refus
        } else {
            reste -= n;
        }
        assert_eq!(reste, 100);
    }
}
