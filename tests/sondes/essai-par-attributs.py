"""Choisir une forme de tri qui soit JUSTE et COMPILABLE.

Premier essai, ECHEC, et c'est exactement a quoi il sert : on voulait
`Reverse((taille, nom))` pour l'ordre decroissant. Compile, ca donne
`["c", "b", "a"]` — la taille decroissante est correcte, mais `b` passe avant
`a` a taille egale, parce que `Reverse` retourne le TUPELE ENTIER. Le nom
s'inverse avec la taille.

Ce n'est ni deterministe ni lisible : deux lignes de meme taille sortiraient
dans un ordre qui depend du sens de tri, et l'utilisateur ne pourrait pas
prevoir lequel.

La forme correcte compare les DEUX composants separement : la cle dans le sens
demande, le nom toujours croissant. Un seul `then_with` suffit, et aucune copie
de nom n est necessaire.

Usage : python tests/sondes/essai-par-attributs.py
"""
import io
import os
import shutil
import subprocess
import sys

RUST = r'''
#[derive(Clone, Copy, PartialEq, Eq)]
enum Tri { Taille, Date }

#[derive(Clone)]
struct Row { sel: u32, name: String, size: u64, mtime: i64, is_dir: bool }

/// La forme qu on NE veut PAS : on retourne le tuple entier, donc le nom
/// part a l opposes de la taille. Consignee parce qu elle compile, qu elle a
/// l air correcte, et qu elle produit un ordre que personne ne peut prevoir.
fn trier_naif(rows: &mut [Row], decroissant: bool) {
    if decroissant {
        rows.sort_by_key(|r| (r.size, r.name.clone()));
        rows.reverse();
    } else {
        rows.sort_by_key(|r| (r.size, r.name.clone()));
    }
}

/// La forme qu on veut : la cle dans le sens demande, le nom toujours
/// croissant, sans copie.
fn trier(rows: &mut [Row], t: Tri, decroissant: bool) {
    rows.sort_by(|a, b| {
        let (ka, kb) = (a.cle(t), b.cle(t));
        if decroissant { kb.cmp(&ka) } else { ka.cmp(&kb) }
            .then_with(|| a.name.cmp(&b.name))
    });
}

impl Row {
    fn cle(&self, t: Tri) -> u64 {
        match t {
            Tri::Taille => self.size,
            Tri::Date => self.mtime.max(0) as u64,
        }
    }
}

fn noms(rows: &[Row]) -> Vec<&str> { rows.iter().map(|r| r.name.as_str()).collect() }

fn jeu() -> Vec<Row> {
    vec![
        Row { sel: 1, name: "b".into(), size: 10, mtime: 5, is_dir: false },
        Row { sel: 2, name: "a".into(), size: 10, mtime: 5, is_dir: true },
        Row { sel: 3, name: "c".into(), size: 30, mtime: 1, is_dir: false },
    ]
}

fn principal() {
    // --- la forme naive, pour consigner ce qu elle fait --------------------
    let mut v = jeu();
    trier_naif(&mut v, true);
    println!("naif  decroissant : {:?}", noms(&v));
    println!("  -> le nom part a l opposes de la taille : INDESIRABLE");

    // --- la forme choisie ---------------------------------------------------
    let mut v = jeu();
    trier(&mut v, Tri::Taille, true);
    println!("tri   decroissant : {:?}", noms(&v));
    assert_eq!(noms(&v), vec!["c", "a", "b"],
               "l egalite de taille doit se trancher par nom CROISSANT");

    trier(&mut v, Tri::Taille, false);
    println!("tri   croissant   : {:?}", noms(&v));
    assert_eq!(noms(&v), vec!["a", "b", "c"]);

    trier(&mut v, Tri::Date, true);
    println!("tri   date decr.  : {:?}", noms(&v));
    assert_eq!(noms(&v), vec!["a", "b", "c"]);

    // --- le nom reste croissant dans les DEUX sens -------------------------
    // C est la propriete qui rend la liste deterministe : a taille egale, la
    // position d une ligne ne depend pas du sens choisi.
    let mut grand = jeu();
    trier(&mut grand, Tri::Taille, true);
    let mut petit = jeu();
    trier(&mut petit, Tri::Taille, false);
    let egaux_grand: Vec<&Row> = grand.iter().filter(|r| r.size == 10).collect();
    let egaux_petit: Vec<&Row> = petit.iter().filter(|r| r.size == 10).collect();
    assert_eq!(noms_ordre(&egaux_grand), noms_ordre(&egaux_petit),
               "a taille egale, l ordre des noms ne doit pas dependre du sens");
    println!("egalite stable    : {:?} dans les deux sens", noms_ordre(&egaux_grand));

    // --- un dossier et un fichier de MEME nom ------------------------------
    let mut w = vec![
        Row { sel: 1, name: "x".into(), size: 5, mtime: 0, is_dir: true },
        Row { sel: 2, name: "x".into(), size: 5, mtime: 0, is_dir: false },
    ];
    trier(&mut w, Tri::Taille, true);
    println!("noms identiques   : {} ligne(s), aucune panique", w.len());

    // --- mtime negatif ou nul ----------------------------------------------
    let mut n = vec![
        Row { sel: 1, name: "recent".into(), size: 1, mtime: 100, is_dir: false },
        Row { sel: 2, name: "inconnu".into(), size: 1, mtime: -1, is_dir: false },
    ];
    trier(&mut n, Tri::Date, true);
    println!("date avec mtime=-1: {:?}", noms(&n));
    assert_eq!(noms(&n), vec!["recent", "inconnu"],
               "un mtime inconnu ne doit pas passer pour le plus recent");

    // --- 50 000 lignes : le tri ne doit pas etre un obstacle ---------------
    let mut gros: Vec<Row> = (0..50_000u32)
        .map(|i| Row {
            sel: i,
            name: format!("f{:05}", (i * 2_654_435_761) % 50_000),
            size: u64::from((i.wrapping_mul(2_654_435_761)) % 977),
            mtime: (i % 31) as i64 - 1,
            is_dir: i % 7 == 0,
        })
        .collect();
    let debut = std::time::Instant::now();
    trier(&mut gros, Tri::Taille, true);
    let ms = debut.elapsed().as_secs_f64() * 1000.0;
    let verifie = gros.windows(2).all(|p| p[0].size > p[1].size
        || (p[0].size == p[1].size && p[0].name <= p[1].name));
    println!("50 000 lignes     : {:.1} ms, ordre verifie : {}", ms, verifie);
    assert!(verifie, "l ordre produit ne respecte pas la cle puis le nom");
    assert!(ms < 500.0, "le tri de 50 000 lignes depasse 500 ms : trop lent");

    println!("OK : la forme (cle, puis nom croissant) est correcte et rapide");
}

fn noms_ordre<'a>(rows: &'a [&'a Row]) -> Vec<&'a str> { rows.iter().map(|r| r.name.as_str()).collect() }

fn main() { principal(); }
'''

RACINE = os.path.abspath('target')
CHEMIN = os.path.join(RACINE, 'essai-tri.rs')
BINAIR = os.path.join(RACINE, 'essai-tri.exe')
io.open(CHEMIN, 'w', encoding='utf-8', newline='\n').write(RUST)

print('=== compilation ===')
r = subprocess.run([shutil.which('rustc'), '-O', '-o', BINAIR, CHEMIN],
                   capture_output=True, text=True)
if r.returncode != 0:
    print('NE COMPILE PAS :')
    print(r.stderr[:3000])
    sys.exit(1)
print('compile')
if r.stderr.strip():
    # les champs jamais lus sont normaux dans un essai isole
    utile = [l for l in r.stderr.split('\n') if 'never read' not in l]
    if len(utile) > 2:
        print('avertissements :\n' + '\n'.join(utile[:12]))

print('')
print('=== execution ===')
r = subprocess.run([BINAIR], capture_output=True, text=True)
print(r.stdout.strip())
if r.stderr.strip():
    print('stderr :\n' + r.stderr[:900])
sys.exit(r.returncode)
