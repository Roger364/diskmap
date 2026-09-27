// Gravage de la provenance dans le binaire.
//
// Le 26/09/2026, un binaire a supprimé 168 fichiers réels. Personne n'a pu
// dire de quel commit il sortait : c'était une copie, compilée dans un état
// qu'aucun journal ne décrivait. Le binaire lui-même ne disait rien non plus.
// Une provenance absente ne se rattrape pas après coup — elle se grave.
//
// Ce que le binaire emporte désormais :
//   - le commit, tel que `git` le nomme, 12 caractères ;
//   - si l'arbre était PROPRE ou SALLE au moment de la compilation. Un arbre
//     sale, c'est exactement le cas du 26/09 : du bon code, non versionné,
//     d'où personne ne peut dire « de quel commit » ;
//   - l'agent qui compile, via `DISKMAP_AGENT`. Non déclaré, c'est dit ;
//
// Le tout affiché au démarrage, sur la console, à la place d'un simple
// « Espace disque : http://… ».

use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

fn main() {
    // Sans cela, cargo rebuild à chaque compilation : le dépôt est surveillé en
    // entier et la date de construction changerait le binaire pour rien.
    println!("cargo:rerun-if-changed=build.rs");
    // Le commit change quand HEAD bouge : c'est ce qui fait que « commit x »
    // reste vrai après un `git commit`.
    println!("cargo:rerun-if-changed=.git/HEAD");
    println!("cargo:rerun-if-env-changed=DISKMAP_AGENT");

    // `git` peut être absent (une archive de crates.io n'a pas de `.git`) :
    // l'incertitude se dit, elle ne se comble pas par une valeur plausible.
    let sha = git(&["rev-parse", "--short=12", "HEAD"]).unwrap_or_else(|| "commit-inconnu".into());

    let sale = match git(&["status", "--porcelain"]) {
        None => true, // on n'a pas su le dire : on le traite comme sale
        Some(s) => !s.trim().is_empty(),
    };
    let arbre = if sale { "arbre SALLE" } else { "arbre propre" };

    let agent = std::env::var("DISKMAP_AGENT")
        .ok()
        .map(|a| a.trim().to_string())
        .filter(|a| !a.is_empty())
        .unwrap_or_else(|| "agent NON DECLARE".to_string());

    let provenance = format!(
        "{sha} · {arbre} · construit par {agent} le {}",
        horodatage()
    );
    println!("cargo:rustc-env=DISKMAP_PROVENANCE={provenance}");
    println!("cargo:rustc-env=DISKMAP_ARBRE_SALLE={sale}");
    println!("cargo:rustc-env=DISKMAP_COMMIT={sha}");

    // Le README doit pouvoir citer l'identifiant d'une version publiée.
    println!(
        "cargo:rustc-env=DISKMAP_VERSION={}",
        env!("CARGO_PKG_VERSION")
    );
}

fn git(args: &[&str]) -> Option<String> {
    let out = Command::new("git").args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Date UTC de la compilation, `AAAA-MM-JJ HH:MM:SS`.
///
/// Écrit à la main plutôt qu'importé : le projet n'a que trois dépendances et
/// celle-ci ne vaut pas une de plus. Algorithme de Howard Hinnant
/// (`civil_from_days`), exact pour les dates avant 1970 comme après.
fn horodatage() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let jours = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let z = jours + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let j = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let a = if m <= 2 { y + 1 } else { y };
    format!(
        "{a:04}-{m:02}-{j:02} {:02}:{:02}:{:02} UTC",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}
