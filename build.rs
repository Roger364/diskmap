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
//
// Le 17/11/2026, la porte 2 du plan SignPath a posé une contrainte nouvelle :
// l'origine vérifiée exige que le binaire soit déterminé par le dépôt. Un
// horodatage pris à l'horloge murale faisait donc deux binaires différents
// pour un même commit. La date gravée est désormais CELLE DU COMMIT, lue dans
// git : elle varie d'un commit à l'autre, jamais d'une compilation à l'autre.

use std::process::Command;

fn main() {
    // Sans cela, cargo rebuild à chaque compilation : le dépôt est surveillé en
    // entier et la date de construction changerait le binaire pour rien.
    println!("cargo:rerun-if-changed=build.rs");
    // `.git/HEAD` ne bouge JAMAIS d'un commit à l'autre : il contient
    // « ref: refs/heads/master » et pointe sur la même ligne depuis le début du
    // dépôt. C'est le fichier de la REF qui est réécrit, à chaque commit comme
    // à chaque `amend` — et c'est donc lui qu'il faut surveiller, sous peine de
    // garder un binaire qui annonce un commit devenu introuvable.
    //
    // Réserve honnête : si les refs sont empaquetées (`git pack-refs`), ce
    // fichier n'existe plus et la reconstruction ne se déclenche plus
    // automatiquement. Le SHA affiché décrit alors la compilation précédente —
    // ce qui reste vrai de la compilation, et faux de l'instant présent.
    if std::path::Path::new(".git/refs/heads/master").exists() {
        println!("cargo:rerun-if-changed=.git/refs/heads/master");
    }
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

    // Date du COMMIT, pas date de compilation : c'est ce qui rend deux
    // compilations du même commit identiques, condition d'une origine
    // vérifiable par SignPath. Si git ne répond pas, on le dit — on ne
    // fabrique pas une date plausible à partir de l'horloge locale.
    let date = git(&["log", "-1", "--format=%ct"])
        .and_then(|s| s.trim().parse::<i64>().ok())
        .map(horodatage)
        .unwrap_or_else(|| "date du commit inconnue".into());

    let provenance = format!("{sha} · {arbre} · construit par {agent} le {date}");
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

/// Date UTC du COMMIT, `AAAA-MM-JJ HH:MM:SS UTC`.
///
/// Écrite à la main plutôt qu'importé : le projet n'a que trois dépendances et
/// celle-ci ne vaut pas une de plus. Algorithme de Howard Hinnant
/// (`civil_from_days`), exact pour les dates avant 1970 comme après.
///
/// L'entrée vient de `git log --format=%ct` : c'est un fait sur le dépôt, pas
/// une lecture de l'horloge de la machine qui compile. Deux builds du même
/// commit gravent donc la même provenance — mesuré le 17/11/2026 par comparaison
/// des SHA-256 de deux `cargo build --release` successifs.
fn horodatage(secs: i64) -> String {
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
