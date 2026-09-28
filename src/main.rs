// diskmap — explorateur d'espace disque.
//
// Un petit serveur HTTP local (pas de dépendance web : on sert l'UI embarquée et
// quelques routes JSON) + un scan parallèle par volume, avec cache binaire sur disque
// pour que les lancements suivants soient quasi instantanés.

mod scan;
mod win32;

use scan::{trier_lignes, Progress, Row, Snapshot, Tri};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, IsTerminal, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime};

const UI: &str = include_str!("../ui/index.html");
const DEFAULT_PORT: u16 = 8756;

/// Taille maximale d'un corps de requête accepté.
///
/// Le plus gros corps légitime est une liste d'éléments à supprimer :
/// l'interface en envoie un par ligne sélectionnée, une trentaine d'octets
/// chacun. 4 Mio laissent donc passer plus de cent mille éléments — bien
/// au-delà de ce que la table sait afficher.
const CORPS_MAX: usize = 4 * 1024 * 1024;
/// Nombre maximal d'éléments qu'une seule simulation peut porter.
///
/// Ce n'est pas une limite de comfort mais une borne de sécurité : chaque
/// élément d'un `dry` devient un chemin figé que `execute` supprimera sans
/// nouvelle question. Une sélection manuelle qui dépasserait ce seuil ne
/// serait plus une sélection, et l'utilisateur ne peut pas la lire entièrement
/// dans l'aperçu sans perdre le fil. On refuse donc, en nommant le remède.
const ITEMS_MAX: usize = 5_000;
/// Une interface locale n'a aucune raison d'envoyer des en-têtes volumineux.
const ENTETE_LIGNE_MAX: usize = 8 * 1024;
const ENTETES_MAX: usize = 32 * 1024;
const CONNEXIONS_MAX: usize = 64;
const DELAI_CONNEXION: Duration = Duration::from_secs(10);
static CONNEXIONS_ACTIVES: AtomicUsize = AtomicUsize::new(0);

#[derive(Clone, Copy, PartialEq, serde::Serialize)]
enum Status {
    #[serde(rename = "empty")]
    Empty,
    #[serde(rename = "scanning")]
    Scanning,
    #[serde(rename = "ready")]
    Ready,
}

struct DriveState {
    info: win32::Drive,
    status: Status,
    snap: Option<Arc<Snapshot>>,
    prog: Arc<Progress>,
}

/// Ce que l'utilisateur a réellement vu lors de la simulation. Sans ce jeton,
/// rien ne peut être supprimé : on ne peut pas exécuter une suppression qui n'a
/// pas été chiffrée et listée au préalable.
#[derive(Clone)]
struct PendingDel {
    drive: char,
    items: Vec<Montre>,
    at_ms: i64,
    /// Génération de l'instantané contre lequel les sélecteurs ont été résolus.
    /// Elle est journalisée : un numéro d'identifiant ne veut rien dire sans
    /// l'instantané qui lui donnait ce sens.
    gen: u64,
    /// La corbeille pouvait-elle garder ce lot ? MESURÉ à l'aperçu, pas redemandé
    /// à l'exécution : c'est l'état de la corbeille AVANT qui décide, et le
    /// lire après n'aurait plus aucun sens.
    ///
    /// `Some(true)` : le lot déborde. `None` : indécidable, faute de plafond
    /// mesuré — et l'interface n'affirmera alors rien.
    corbeille_deborde: Option<bool>,
}

/// Un élément tel qu'il a été MONTRÉ, figé au moment de l'aperçu.
///
/// On mémorise le **chemin résolu**, jamais l'identifiant d'instantané.
/// `execute` résolvait l'identifiant contre l'instantané **courant** ; une
/// réanalyse intercalée entre l'aperçu et l'exécution décale ces identifiants,
/// et l'application supprime alors un fichier qui n'a jamais été montré.
///
/// Ce n'est pas un cas d'école : elle relance une analyse après chaque
/// suppression, et met en file celles des volumes sans cache au démarrage. Le
/// jeton d'aperçu vit dix minutes — la fenêtre est largement ouverte. Mesuré le
/// 26/09/2026 : l'aperçu annonçait `G:\_diskmap_coh\f06.txt`, et l'exécution a
/// supprimé `G:\.pnpm-store\v11\index.db` — un autre dossier, un autre fichier,
/// jamais sélectionné.
///
/// La taille et le compte sont figés avec le chemin : ils viennent du même
/// instantané que lui, et les recalculer après coup rouvrirait le même écart.
#[derive(Clone)]
struct Montre {
    path: PathBuf,
    /// Sélecteur demandé par le client, tel qu'il l'a envoyé. Conservé pour le
    /// journal uniquement : à l'exécution, c'est `path` qui fait foi, jamais lui.
    sel: u32,
    is_dir: bool,
    size: u64,
    count: u64,
}

struct App {
    drives: Mutex<HashMap<char, DriveState>>,
    pending: Mutex<HashMap<String, PendingDel>>,
    /// Volume en cours d'analyse (un seul à la fois : on évite de faire ramener
    /// plusieurs disques en concurrence sur le même contrôleur).
    scanning: Mutex<Option<char>>,
    queue: Mutex<Vec<char>>,
    cache_dir: PathBuf,
    /// Fixé au démarrage : le niveau de privilège d'un processus ne change pas
    /// en cours de route, et l'interface s'en sert à chaque rendu.
    eleve: bool,
    /// Un arrêt a été demandé. Sert de garde contre un second `/api/quit` pendant
    /// que le premier s'exécute, et empêche l'interface de relancer une analyse
    /// pendant l'arrêt.
    stopping: AtomicBool,
}

#[derive(serde::Serialize)]
struct DriveJson {
    letter: String,
    label: String,
    fs: String,
    total: u64,
    free: u64,
    status: Status,
    n_dirs: u64,
    n_files: u64,
    root_size: u64,
    elapsed_ms: u64,
    finished_ms: i64,
    /// Dossiers dont le contenu est inaccessible. Chacun fait manquer **tout un
    /// sous-arbre**, donc `root_size` est un plancher, pas une mesure.
    unreadable: u64,
    /// Sous-ensemble des précédents dû à un refus de droits (code 5) : le seul
    /// cas qu'une relance élevée réparerait.
    unreadable_droits: u64,
    /// Entrées sautées : coût d'une entrée chacune, jamais d'un sous-arbre.
    skipped: u64,
    dirs: u64,
    files: u64,
}

#[derive(serde::Serialize)]
struct StateJson {
    drives: Vec<DriveJson>,
    scanning: Option<String>,
    /// Vrai si l'instance tourne avec des droits d'administrateur. L'interface
    /// s'en sert pour ne pas conseiller une relance élevée à quelqu'un qui l'est
    /// déjà — le conseil serait faux, et enverrait chercher au mauvais endroit.
    eleve: bool,
}

/// Vrai si une instance diskmap répond déjà sur ce port. On interroge notre
/// propre route `/api/state` plutôt que de se contenter d'un test de connexion :
/// un autre programme occupant le port ne doit pas être pris pour nous.
fn already_running(port: u16) -> bool {
    let Ok(mut s) = TcpStream::connect(("127.0.0.1", port)) else {
        return false;
    };
    let req = b"GET /api/state HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n";
    if s.write_all(req).is_err() {
        return false;
    }
    let mut buf = [0u8; 15];
    match s.read(&mut buf) {
        Ok(n) if n >= 12 => buf.starts_with(b"HTTP/1.1 200"),
        _ => false,
    }
}

/// Le navigateur ne s'ouvre que pour un lancement INTERACTIF.
///
/// Mesuré le 28/09/2026 : un script qui lance le serveur — ici le harnais de
/// sondes, là un agent qui veut simplement interroger l'API — ouvrait une
/// fenêtre du navigateur PAR DÉFAUT à chaque démarrage. Le harnais passe
/// `--no-browser` et se tait donc depuis le début ; mais tout autre lancement
/// scripté n'avait aucun moyen de l'éviter, et `--no-browser` ne s'invente pas.
///
/// Ouvrir une fenêtre sur le bureau de quelqu'un est une intrusion, et la
/// règle du projet est simple : on ne touche que ce qu'on a fait naître, et on
/// ne devine pas l'intention. Ici, le signe est le même que partout ailleurs
/// dans ce binaire : y a-t-il une console ? Au double-clic, oui. Depuis un
/// script, non. La décision est donc lisible, et non une convention.
///
/// Les deux drapeaux restent, et ils priment tous les deux sur le signal :
/// `--browser` pour forcer, `--no-browser` pour interdire. Un Behavior qui ne
/// peut être ni forcé ni interdit n'est pas une règle, c'est une pente.
fn decider_le_navigateur(args: &[String], stdin_terminal: bool) -> bool {
    // L'interdit est lu AVEC l'autorise, et le test --no-browser vient en
    // PREMIER. Sans cela, `--browser --no-browser` ouvrait quand meme, et
    // l'ordre des deux `any` decidait seul de l'issue : une regle dont l'issue
    // tient a l'ordre de deux lignes n'est pas une regle, c'est un-au-hasard.
    if args.iter().any(|a| a == "--no-browser") {
        return false;
    }
    if args.iter().any(|a| a == "--browser") {
        return true;
    }
    stdin_terminal
}

fn open_in_browser(url: &str) {
    let _ = Command::new("cmd").args(["/c", "start", "", url]).spawn();
}

/// Bloque jusqu'à une pression sur Entrée. Sert uniquement à ce qu'une console
/// ouverte au double-clic ne se referme pas avant que le message soit lu.
fn wait_for_key() {
    eprintln!();
    eprint!("Appuie sur Entree pour fermer cette fenetre... ");
    let _ = std::io::stdout().flush();
    let mut s = String::new();
    let _ = std::io::stdin().read_line(&mut s);
}

fn bench(letter: Option<char>) {
    let letter = match letter {
        Some(c) => c.to_ascii_uppercase(),
        None => {
            eprintln!("usage: diskmap bench <LETTRE>");
            std::process::exit(2);
        }
    };
    let verbatim = format!(r"\\?\{letter}:\");
    let display = format!(r"{letter}:\");
    let threads = thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(8);
    println!("coeurs logiques : {threads}");

    let t0 = std::time::Instant::now();
    let snap = scan::scan(&verbatim, display, Arc::new(Progress::new()));
    let wall = t0.elapsed();

    println!("---");
    println!("dossiers       : {}", snap.n_dirs());
    println!("fichiers       : {}", snap.n_files());
    println!("inaccessibles  : {}", snap.unreadable_total);
    println!("refus de droits: {}", snap.unreadable_droits);
    println!("entrées sautées: {}", snap.skipped);
    // Un dossier inaccessible fait manquer tout son sous-arbre : on l'affiche,
    // parce que « 123 » sans chemin ne dit pas où regarder.
    if !snap.unreadable.is_empty() {
        let gardes = snap.unreadable.len() as u64;
        if gardes < snap.unreadable_total {
            println!(
                "  (liste plafonnée : {gardes} chemins sur {})",
                snap.unreadable_total
            );
        }
        for u in &snap.unreadable {
            println!(
                "  [{}] {}",
                if u.droits { "droits" } else { "autre " },
                u.path
            );
        }
    }
    println!("parcours seul  : {} ms", snap.elapsed_ms);
    println!("total agregé   : {:?}", wall);
    println!(
        "taille racine  : {:.1} Go",
        snap.size[0] as f64 / 1073741824.0
    );
    println!(
        "débit          : {:.0} entrées/s",
        (snap.n_dirs() + snap.n_files()) as f64 / wall.as_secs_f64()
    );
}

fn cache_dir() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    let d = base.join("diskmap");
    let _ = std::fs::create_dir_all(&d);
    d
}

fn main() {
    let args: Vec<String> = std::env::args().collect();

    // `diskmap bench <LETTRE>` : mesure le parcours seul, sans serveur ni UI.
    // Sert à vérifier les performances sur une vraie machine plutôt qu'à les supposer.
    // `diskmap --version` : la provenance seule, et on sort. Lisible sans
    // demarrer de serveur, donc sans declencher le moindre scan — ce qui est
    // le seul moyen de repondre a « de quel code vient ce binaire » sans
    // toucher au disque.
    if args.iter().any(|a| a == "--version" || a == "-V") {
        println!(
            "diskmap {} — {}",
            env!("CARGO_PKG_VERSION"),
            env!("DISKMAP_COMMIT")
        );
        println!("{}", env!("DISKMAP_PROVENANCE"));
        if env!("DISKMAP_ARBRE_SALLE") == "true" {
            println!(
                "ATTENTION : binaire compile avec des modifications NON COMMITÉES — \
                 il ne correspond a aucun commit."
            );
        }
        return;
    }

    if args.get(1).map(|s| s.as_str()) == Some("bench") {
        return bench(args.get(2).and_then(|s| s.chars().next()));
    }

    let port: u16 = args
        .iter()
        .position(|a| a == "--port")
        .and_then(|i| args.get(i + 1))
        .and_then(|v| v.parse().ok())
        .unwrap_or(DEFAULT_PORT);

    let open_browser = decider_le_navigateur(&args, std::io::stdin().is_terminal());
    if !open_browser {
        // On DIT pourquoi. Un serveur qui n'ouvre rien sans un mot laisse
        // croire a un defaut ; et celui qui n'explique pas sa decision ne la
        // meritait pas.
        println!("Navigateur  : non ouvert — lancement non interactif. `--browser` pour l’ouvrir.");
    }

    // Une instance tourne déjà ? On ouvre le navigateur dessus au lieu d'en
    // lancer une seconde : deux instances feraient deux scans concurrents des
    // mêmes disques. Et surtout, l'ancien comportement était un `exit(1)` dont
    // le message partait sur stderr — au double-clic, une fenêtre noire qui se
    // referme sans rien dire.
    if already_running(port) {
        let url = format!("http://127.0.0.1:{port}/");
        println!("Une instance tourne déjà : {url}");
        if open_browser {
            open_in_browser(&url);
        }
        return;
    }

    let mut drives = HashMap::new();
    for d in win32::drives() {
        let cache = cache_dir().join(format!("{}.bin", d.letter));
        let (snap, status) = match Snapshot::load(&cache, d.serial, &format!("{}:\\", d.letter)) {
            Ok(s) => (Some(Arc::new(s)), Status::Ready),
            Err(_) => (None, Status::Empty),
        };
        drives.insert(
            d.letter,
            DriveState {
                info: d,
                status,
                snap,
                prog: Arc::new(Progress::new()),
            },
        );
    }

    let app = Arc::new(App {
        drives: Mutex::new(drives),
        scanning: Mutex::new(None),
        queue: Mutex::new(Vec::new()),
        pending: Mutex::new(HashMap::new()),
        cache_dir: cache_dir(),
        eleve: win32::est_eleve(),
        stopping: AtomicBool::new(false),
    });

    // Les volumes sans cache sont mis en file : ils seront analysés les uns après
    // les autres au démarrage, sans bloquer l'interface.
    {
        let d = app.drives.lock().unwrap();
        let mut q: Vec<char> = d
            .iter()
            .filter(|(_, s)| s.status == Status::Empty)
            .map(|(k, _)| *k)
            .collect();
        q.sort_unstable();
        drop(d);
        *app.queue.lock().unwrap() = q;
    }
    pump(&app);

    // Le port demandé peut être pris par autre chose qu'une instance à nous :
    // on glisse sur les suivants plutôt que d'abandonner.
    let mut listener = None;
    for p in port..port + 10 {
        match TcpListener::bind(("127.0.0.1", p)) {
            Ok(l) => {
                listener = Some((l, p));
                break;
            }
            Err(_) => continue,
        }
    }
    let (listener, real_port) = match listener {
        Some(x) => x,
        None => {
            eprintln!("Aucun port libre entre {port} et {}.", port + 9);
            eprintln!("Ferme les autres instances, ou lance : diskmap --port 9000");
            // Sans cette pause, le message part sur stderr et la console se
            // referme avant d'avoir pu être lue.
            wait_for_key();
            std::process::exit(1);
        }
    };
    if real_port != port {
        println!("Le port {port} était pris, utilisation de {real_port} à la place.");
    }
    let url = format!("http://127.0.0.1:{real_port}/");
    println!("Espace disque : {url}");

    // La provenance est gravée à la compilation par `build.rs`. Elle est
    // affichée AVANT l'adresse, et non dans un fichier : un binaire dont on ne
    // peut pas dire d'où il sort se Contamine d'abord l'utilisateur.
    //
    // Le 26/09/2026, un binaire a effacé 168 fichiers réels et personne n'a pu
    // dire de quel commit il sortait. L'arbre « sale » est le cas exact de ce
    // jour-là : du bon code, jamais versionné. C'est le seul cas où cette
    // provenance doit crier plutôt qu'informer.
    println!(
        "Version      : {} ({})",
        env!("CARGO_PKG_VERSION"),
        env!("DISKMAP_COMMIT")
    );
    println!("Provenance   : {}", env!("DISKMAP_PROVENANCE"));
    if env!("DISKMAP_ARBRE_SALLE") == "true" {
        println!(
            "ATTENTION : ce binaire a été compilé avec des modifications NON \
             COMITÉES. Sa provenance est incertaine : il ne correspond à aucun \
             commit, et `git status` sur la machine qui l'a construit le dira."
        );
    }
    println!("Arrêt : le bouton dans l'interface, ou Ctrl+C ici.");
    if open_browser {
        open_in_browser(&url);
    }

    for s in listener.incoming().flatten() {
        if CONNEXIONS_ACTIVES
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                (n < CONNEXIONS_MAX).then_some(n + 1)
            })
            .is_err()
        {
            // Le client sera fermé par la fin de portée. Préserver les 64
            // connexions déjà admises vaut mieux que créer des threads sans fin.
            continue;
        }
        let app = app.clone();
        thread::spawn(move || {
            let _guard = ConnectionGuard;
            if let Err(e) = handle(&app, s) {
                eprintln!("connexion : {e}");
            }
        });
    }
}

struct ConnectionGuard;

impl Drop for ConnectionGuard {
    fn drop(&mut self) {
        CONNEXIONS_ACTIVES.fetch_sub(1, Ordering::Release);
    }
}

/// Démarre le volume suivant de la file si aucun scan n'est en cours.
fn pump(app: &Arc<App>) {
    let mut busy = app.scanning.lock().unwrap();
    // Le contrôle est ICI, sous le verrou, et non chez l'appelant : `pump` dépile
    // un volume puis remplace sa progression par une neuve (`cancel: false`). Si un
    // arrêt s'intercalait entre les deux, il annulerait l'ancienne progression et
    // `pump` en installerait aussitôt une réactive — un parcours démarrerait
    // pendant l'arrêt, et la sortie du processus le couperait en pleine écriture.
    // Sous le verrou, aucun arrêt ne peut s'intercaler : il prend ce même verrou.
    if app.stopping.load(Ordering::Relaxed) {
        return;
    }
    if busy.is_some() {
        return;
    }
    let next = {
        let mut q = app.queue.lock().unwrap();
        if q.is_empty() {
            None
        } else {
            Some(q.remove(0))
        }
    };
    let Some(letter) = next else { return };
    *busy = Some(letter);
    {
        let mut d = app.drives.lock().unwrap();
        if let Some(ds) = d.get_mut(&letter) {
            ds.prog = Arc::new(Progress::new());
            ds.status = Status::Scanning;
        }
    }
    drop(busy);

    let app2 = app.clone();
    thread::spawn(move || {
        let verbatim = format!(r"\\?\{letter}:\");
        let display = format!(r"{letter}:\");
        let prog = {
            let d = app2.drives.lock().unwrap();
            d.get(&letter)
                .map(|s| s.prog.clone())
                .unwrap_or_else(|| Arc::new(Progress::new()))
        };
        let prog2 = prog.clone();
        let snap = scan::scan(&verbatim, display, prog);
        // Un parcours interrompu rend un instantané PARTIEL. Le sauver écraserait
        // un cache complet par une vue tronquée, que le prochain démarrage
        // prendrait pour argent comptant : un total faux présenté comme une
        // mesure, exactement ce que le compteur d'illisibles sert à éviter. On
        // ne garde donc rien — ni cache, ni état « analysé ».
        if prog2.cancel.load(Ordering::Relaxed) {
            eprintln!(
                "{letter}: parcours interrompu — cache inchangé, volume non marqué comme analysé"
            );
            {
                let mut d = app2.drives.lock().unwrap();
                if let Some(ds) = d.get_mut(&letter) {
                    ds.status = Status::Empty;
                }
            }
            *app2.scanning.lock().unwrap() = None;
            // On enchaîne sur le volume suivant, sauf si c'est un arrêt complet :
            // relancer un parcours pendant l'arrêt serait absurde.
            if !app2.stopping.load(Ordering::Relaxed) {
                pump(&app2);
            }
            return;
        }
        let cache = app2.cache_dir.join(format!("{letter}.bin"));
        let serial = {
            let d = app2.drives.lock().unwrap();
            d.get(&letter).map(|s| s.info.serial).unwrap_or(0)
        };
        if let Err(e) = snap.save(&cache, serial) {
            eprintln!("cache {letter}: {e}");
        }
        {
            let mut d = app2.drives.lock().unwrap();
            if let Some(ds) = d.get_mut(&letter) {
                ds.snap = Some(Arc::new(snap));
                ds.status = Status::Ready;
            }
        }
        *app2.scanning.lock().unwrap() = None;
        println!(
            "{letter}: terminé — {} dossiers, {} fichiers",
            count_dirs(&app2, letter),
            count_files(&app2, letter)
        );
        pump(&app2);
    });
}

fn count_dirs(app: &Arc<App>, l: char) -> usize {
    app.drives
        .lock()
        .unwrap()
        .get(&l)
        .and_then(|s| s.snap.as_ref())
        .map(|s| s.n_dirs())
        .unwrap_or(0)
}
fn count_files(app: &Arc<App>, l: char) -> usize {
    app.drives
        .lock()
        .unwrap()
        .get(&l)
        .and_then(|s| s.snap.as_ref())
        .map(|s| s.n_files())
        .unwrap_or(0)
}

// La demande est-elle DÉJÀ COUVERTE par une analyse qui vient après elle ?
//
// Pure, pour être testée. Elle ne prend que la file : ce n'est pas une copie
// de l'état, c'est la liste de ce qui s'exécutera. Une analyse EN COURS ne
// couvre rien -- elle a commencé avant que la demande existe, donc son
// instantané ne peut pas contenir ce que la demande voulait voir. C'est
// exactement le défaut du 28/09/2026, et c'est pour cela que la fonction ne
// prend pas `scanning` en paramètre : l'oublier est impossible.
fn demande_couverte(en_attente: &[char], letter: char) -> bool {
    en_attente.contains(&letter)
}

fn start_scan(app: &Arc<App>, letter: char) {
    // Ordre de verrouillage imposé partout : `scanning` puis `queue`.
    // L'inverse (queue -> scanning) risquerait l'interblocage avec `pump`. Le
    // verrou de `queue` est seul ici, et `pump` le prend apres `scanning` :
    // même ordre, donc pas d'interblocage possible.
    let mut q = app.queue.lock().unwrap();
    if demande_couverte(&q, letter) {
        return;
    }
    q.push(letter);
    drop(q);
    pump(app);
}

// ---------------------------- HTTP ----------------------------

fn handle(app: &Arc<App>, mut stream: TcpStream) -> std::io::Result<()> {
    stream.set_read_timeout(Some(DELAI_CONNEXION))?;
    stream.set_write_timeout(Some(DELAI_CONNEXION))?;
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut line = String::new();
    let mut head_size = 0;
    if !read_header_line(&mut reader, &mut line, &mut head_size)? {
        return Ok(());
    }
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let target = parts.next().unwrap_or("/").to_string();
    // En-têtes : on retient Content-Length, seul cas où un corps nous intéresse,
    // plus X-Diskmap, qui distingue notre page d'une page tierce, et Host, qui
    // nomme la machine visée (voir `hote_local` — c'est la défense contre un
    // rebinding DNS).
    let mut content_len: usize = 0;
    // Un corps annoncé plus gros que ce qu'on accepte est retenu comme tel,
    // sans jamais être alloué. `vec![0u8; content_len]` sur un en-tête venu du
    // réseau est une allocation arbitraire : mesuré le 26/09/2026, un seul
    // « Content-Length: 999999999999 » suffisait à faire tomber le processus
    // entier — aucune route n'était même atteinte.
    let mut trop_gros = false;
    let mut action = String::new();
    let mut host = String::new();
    loop {
        let mut h = String::new();
        if !read_header_line(&mut reader, &mut h, &mut head_size)? {
            break;
        }
        if h.trim().is_empty() {
            break;
        }
        let lower = h.to_ascii_lowercase();
        if let Some(v) = lower.strip_prefix("content-length:") {
            let n: usize = v.trim().parse().unwrap_or(0);
            if n > CORPS_MAX {
                trop_gros = true;
            } else {
                content_len = n;
            }
        } else if let Some(v) = lower.strip_prefix("x-diskmap:") {
            action = v.trim().to_string();
        } else if let Some(v) = lower.strip_prefix("host:") {
            host = v.trim().to_string();
        }
    }

    // On ne lit pas le corps : c'est justement lui qu'on refuse d'allouer.
    if trop_gros {
        let corps = format!("corps annoncé trop gros : {CORPS_MAX} octets au maximum");
        let entete = format!(
            "HTTP/1.1 413 Payload Too Large\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n",
            corps.len()
        );
        stream.write_all(entete.as_bytes())?;
        stream.write_all(corps.as_bytes())?;
        return stream.flush();
    }

    let mut body = vec![0u8; content_len];
    if content_len > 0 {
        reader.read_exact(&mut body)?;
    }

    let (path, query) = match target.split_once('?') {
        Some((p, q)) => (p.to_string(), parse_query(q)),
        None => (target, HashMap::new()),
    };

    let resp = route(app, &method, &path, &query, &body, &action, &host);
    let body: Vec<u8>;
    let (status, ctype) = match resp {
        Ok(Resp::Html(s)) => {
            body = s.into_bytes();
            ("200 OK", "text/html; charset=utf-8")
        }
        Ok(Resp::Json(s)) => {
            body = s.into_bytes();
            ("200 OK", "application/json; charset=utf-8")
        }
        Err((code, msg)) => {
            body = msg.into_bytes();
            (code, "text/plain; charset=utf-8")
        }
    };
    stream.write_all(
        format!(
            "HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n",
            body.len()
        )
        .as_bytes(),
    )?;
    stream.write_all(&body)?;
    stream.flush()
}

/// Lit une ligne HTTP sans accorder à un pair local une allocation sans borne.
///
/// `BufRead::read_line` agrandit sa chaîne jusqu'au prochain saut de ligne. Une
/// connexion lente pouvait donc retenir un thread et faire grossir sa mémoire
/// indéfiniment avant même que les routes ou l'en-tête Host ne soient vérifiés.
fn read_header_line(
    reader: &mut BufReader<TcpStream>,
    line: &mut String,
    head_size: &mut usize,
) -> std::io::Result<bool> {
    line.clear();
    loop {
        let (chunk, consumed, complete) = {
            let buf = reader.fill_buf()?;
            if buf.is_empty() {
                return Ok(!line.is_empty());
            }
            let newline = buf.iter().position(|b| *b == b'\n');
            let n = newline.map_or(buf.len(), |i| i + 1);
            (
                String::from_utf8_lossy(&buf[..n]).into_owned(),
                n,
                newline.is_some(),
            )
        };
        if line.len().saturating_add(chunk.len()) > ENTETE_LIGNE_MAX
            || head_size.saturating_add(consumed) > ENTETES_MAX
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "en-têtes HTTP trop volumineux",
            ));
        }
        reader.consume(consumed);
        line.push_str(&chunk);
        *head_size += consumed;
        if complete {
            return Ok(true);
        }
    }
}

enum Resp {
    Html(String),
    Json(String),
}

type Q = HashMap<String, String>;

fn parse_query(q: &str) -> Q {
    let mut m = Q::new();
    for kv in q.split('&') {
        if let Some((k, v)) = kv.split_once('=') {
            m.insert(pct_decode(k), pct_decode(v));
        }
    }
    m
}

fn pct_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'%' if i + 2 < b.len() => {
                if let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2])) {
                    out.push(h * 16 + l);
                    i += 3;
                    continue;
                }
                out.push(b[i]);
                i += 1;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

/// Le nom demandé est-il celui de la machine locale ?
///
/// C'est la défense contre le **rebinding DNS**, et elle est indispensable. Le
/// scénario : l'attaquant sert une page depuis son domaine, puis fait résoudre
/// ce domaine vers 127.0.0.1. Le navigateur envoie alors ses requêtes à notre
/// serveur **en les croyant de même origine**. Le contrôle d'`Origin` ne voit
/// rien — il n'y a pas de requête croisée. Le préflight non plus. Et l'en-tête
/// `X-Diskmap` est posable sans restriction, puisqu'une requête same-origin
/// n'est jamais préflightée : la garde qui protège des POST « simples » d'une
/// page tierce ne protège de rien ici.
///
/// Seul le nom porté par `Host` trahit l'attaque : le navigateur y met le nom
/// d'origine, jamais l'adresse à laquelle il a effectivement abouti.
///
/// D'où trois conséquences de conception :
/// - la vérification porte sur **toutes** les routes, lectures comprises. Les
///   lectures sont ici aussi sensibles que les écritures : `/api/tree` livre
///   l'inventaire complet du disque.
/// - on compare le **nom**, pas le port : le port n'apporte rien (l'attaquant
///   choisit son URL) et le figer casserait les sondes comme les scripts.
/// - `already_running` interroge notre propre `/api/state` avec
///   `Host: 127.0.0.1` **sans port** : le nom seul doit donc suffire.
fn hote_local(host: &str) -> bool {
    let h = host.trim();
    // On isole le nom en retirant un éventuel « :port ». Un littéral IPv6 est
    // entre crochets, donc ses deux-points internes ne se confondent pas avec
    // le séparateur de port.
    let nom = if let Some(reste) = h.strip_prefix('[') {
        let Some((n, apres)) = reste.split_once(']') else {
            return false;
        };
        if !apres.is_empty() {
            let Some(p) = apres.strip_prefix(':') else {
                return false;
            };
            if !port_ok(p) {
                return false;
            }
        }
        n
    } else if let Some((n, p)) = h.split_once(':') {
        if !port_ok(p) {
            return false;
        }
        n
    } else {
        h
    };
    // « localhost. » désigne le même nom que « localhost » : le point final est
    // la racine explicite, pas un nom différent.
    let nom = nom.trim_end_matches('.');
    nom.eq_ignore_ascii_case("127.0.0.1") || nom.eq_ignore_ascii_case("localhost") || nom == "::1"
}

/// Le port est-il bien un port ? Exiger des chiffres ferme la classe de leurres
/// du type `127.0.0.1:8800@evil.test`, où tout ce qui suit le premier
/// deux-points serait sinon pris pour un port — et le nom retenu, « 127.0.0.1 »,
/// se ferait accepter.
fn port_ok(p: &str) -> bool {
    p.is_empty() || p.bytes().all(|b| b.is_ascii_digit())
}

fn route(
    app: &Arc<App>,
    method: &str,
    path: &str,
    q: &Q,
    body: &[u8],
    action: &str,
    host: &str,
) -> Result<Resp, (&'static str, String)> {
    // Le nom demandé doit être celui de cette machine. Ce contrôle passe AVANT
    // tout le reste, et vaut pour les lectures autant que pour les écritures :
    // voir `hote_local` pour ce qu'il couvre et pourquoi il est le seul à le
    // pouvoir.
    if !hote_local(host) {
        return Err((
            "403 Forbidden",
            format!("en-tête Host refusé (« {host} ») : cette interface ne répond qu'à 127.0.0.1 ou localhost"),
        ));
    }

    // Toute route qui MODIFIE quelque chose exige un en-tête que seule notre
    // propre page sait poser. Ce n'est pas une formalité : un en-tête
    // personnalisé ne fait pas partie des en-têtes « simples », donc un
    // navigateur doit demander un préflight (OPTIONS) avant de l'envoyer — et
    // nous n'en servons aucun. Une page tierce ne peut donc pas atteindre ces
    // routes, alors qu'un simple POST « text/plain » lui suffisait.
    //
    // Mesuré le 26/09/2026 dans un vrai navigateur (Chromium 153), trois fois sur
    // trois : sans ce contrôle, une page d'une autre origine — servie depuis le
    // loopback, depuis l'IP privée, ou ouverte en file:// — supprimait un fichier
    // du disque sans que l'utilisateur voie rien, et sans pouvoir lire la moindre
    // réponse. Le jeton n'y changeait rien : il se recalcule à partir de
    // l'horodatage qu'il contient, et la simulation laisse l'entrée en attente
    // côté serveur. L'utilisateur n'a rien à confirmer pour qu'on lui efface un
    // fichier.
    if method == "POST" && action != "1" {
        return Err((
            "403 Forbidden",
            "en-tête X-Diskmap absent : requête refusée".into(),
        ));
    }
    match (method, path) {
        ("GET", "/") | ("GET", "/index.html") => Ok(Resp::Html(UI.to_string())),

        ("GET", "/api/state") => Ok(Resp::Json(serde_json::to_string(&state_json(app)).unwrap())),

        ("POST", p) if p.starts_with("/api/scan/") => {
            // Pendant l'arrêt, accepter une analyse n'aurait aucun sens : le
            // processus sort dans quelques centaines de millisecondes.
            if app.stopping.load(Ordering::Relaxed) {
                return Err(("409 Conflict", "arrêt en cours".into()));
            }
            let letter = p.rsplit('/').next().unwrap_or("").chars().next();
            let letter = letter
                .ok_or(("400 Bad Request", "lettre manquante".into()))?
                .to_ascii_uppercase();
            {
                let d = app.drives.lock().unwrap();
                if !d.contains_key(&letter) {
                    return Err(("404 Not Found", "volume inconnu".into()));
                }
            }
            start_scan(app, letter);
            Ok(Resp::Json("{\"ok\":true}".to_string()))
        }

        ("GET", "/api/tree") => tree(app, q),
        ("GET", "/api/search") => search(app, q),
        ("GET", "/api/unreadable") => unreadable(app, q),

        ("POST", "/api/reveal") => reveal(app, body),

        ("POST", "/api/quit") => quit(app, body),

        ("POST", "/api/delete") => delete(app, body),

        ("POST", "/api/open") => {
            let letter = q
                .get("drive")
                .and_then(|s| s.chars().next())
                .ok_or(("400 Bad Request", "drive manquant".into()))?
                .to_ascii_uppercase();
            let id: u32 = q
                .get("id")
                .and_then(|s| s.parse().ok())
                .ok_or(("400 Bad Request", "id invalide".into()))?;
            let kind = q.get("kind").cloned().unwrap_or_else(|| "dir".into());
            let snap = {
                let d = app.drives.lock().unwrap();
                d.get(&letter)
                    .and_then(|s| s.snap.clone())
                    .ok_or(("409 Conflict", "volume pas encore analysé".into()))?
            };
            // Un chemin venu du client n'est ouvert que s'il est dans l'index,
            // et c'est le chemin de l'INDEX qui part vers l'explorateur : la
            // garde répond à la même question que pour un identifiant — « ce
            // chemin fait-il partie de ce que j'ai analysé ? » — et le client
            // ne peut pas obtenir un chemin que le serveur n'a pas vu.
            //
            // Sans ce garde, un identifiant périmé ouvrait dans l'explorateur le
            // dossier qui portait son numéro après la ré-analyse : la même
            // dérive, dans une fenêtre que l'utilisateur voit.
            let p = if let Some(c) = q.get("chemin") {
                let (dossier, nom) = if kind == "file" {
                    let (d, n) = c
                        .rsplit_once('\\')
                        .ok_or(("400 Bad Request", "chemin invalide".into()))?;
                    (d.to_string(), n.to_string())
                } else {
                    (c.clone(), String::new())
                };
                let did = dossier_de(&snap, &dossier).ok_or((
                    "404 Not Found",
                    format!("ce dossier n'existe plus : {dossier}"),
                ))?;
                if kind == "file" {
                    let f = snap
                        .child_files(did)
                        .into_iter()
                        .find(|f| snap.files[*f as usize].name.eq_ignore_ascii_case(&nom))
                        .ok_or(("404 Not Found", format!("fichier absent de l'index : {c}")))?;
                    snap.file_path(f)
                } else {
                    snap.dir_path(did)
                }
            } else if kind == "file" {
                if (id as usize) >= snap.n_files() {
                    return Err(("400 Bad Request", "fichier hors bornes".into()));
                }
                snap.file_path(id)
            } else {
                if (id as usize) >= snap.n_dirs() {
                    return Err(("400 Bad Request", "dossier hors bornes".into()));
                }
                snap.dir_path(id)
            };
            let ps = p.to_string_lossy().into_owned();
            // /select, met en surbrillance le fichier dans l'explorateur.
            let arg = if kind == "file" {
                format!("/select,{ps}")
            } else {
                ps
            };
            let _ = Command::new("explorer").arg(arg).spawn();
            Ok(Resp::Json("{\"ok\":true}".to_string()))
        }

        _ => Err(("404 Not Found", "route inconnue".into())),
    }
}

fn state_json(app: &Arc<App>) -> StateJson {
    let d = app.drives.lock().unwrap();
    let mut out: Vec<DriveJson> = Vec::new();
    let mut letters: Vec<char> = d.keys().copied().collect();
    letters.sort_unstable();
    for l in letters {
        let s = &d[&l];
        let snap = s.snap.as_ref();
        out.push(DriveJson {
            letter: l.to_string(),
            label: s.info.label.clone(),
            fs: s.info.fs.clone(),
            total: s.info.total,
            free: s.info.free,
            status: s.status,
            n_dirs: snap.map(|x| x.n_dirs() as u64).unwrap_or(0),
            n_files: snap.map(|x| x.n_files() as u64).unwrap_or(0),
            root_size: snap.map(|x| x.size[0]).unwrap_or(0),
            elapsed_ms: snap.map(|x| x.elapsed_ms).unwrap_or(0),
            finished_ms: snap.map(|x| x.finished_ms).unwrap_or(0),
            unreadable: snap.map(|x| x.unreadable_total).unwrap_or(0),
            unreadable_droits: snap.map(|x| x.unreadable_droits).unwrap_or(0),
            skipped: snap.map(|x| x.skipped).unwrap_or(0),
            dirs: s.prog.dirs.load(Ordering::Relaxed),
            files: s.prog.files.load(Ordering::Relaxed),
        });
    }
    StateJson {
        drives: out,
        scanning: app.scanning.lock().unwrap().map(|c| c.to_string()),
        eleve: app.eleve,
    }
}

#[derive(serde::Serialize)]
struct Crumb {
    name: String,
    id: u32,
    /// Le chemin COMPLET qui mène à ce palier.
    ///
    /// C'est par lui que l'interface demande un dossier. Un identifiant ne le
    /// peut pas : c'est une position (voir `Snapshot::gen`), et une position ne
    /// survit pas à une ré-analyse.
    chemin: String,
}

/// Le chemin d'un enfant, à partir du chemin de son parent.
///
/// La racine se termine déjà par un antislash — `V:\` — et ajouter un second
/// produirait `V:\\dossier`, un chemin que Windows accepte mais que personne
/// n'écrit. Le test est donc nécessaire, et c'est pour cela qu'il est ici.
fn chemin_enfant(parent: &str, nom: &str) -> String {
    if parent.ends_with('\\') {
        format!("{parent}{nom}")
    } else {
        format!("{parent}\\{nom}")
    }
}

/// Le dossier de `chemin` dans l'instantané, ou `None` s'il n'y est plus.
///
/// Résolu palier par palier depuis la racine, en comparant les noms sans
/// tenir compte de la casse : Windows ignore la casse, et un chemin refusé pour
/// cette raison serait un refus que personne ne comprendrait.
///
/// LENT — O(profondeur x enfants) — et sans conséquence : un appel par
/// navigation, là où l'épinglage par identifiant serait rapide et faux.
fn dossier_de(snap: &scan::Snapshot, chemin: &str) -> Option<u32> {
    // Windows accepte les deux separateurs, et les deux se rencontrent : le
    // harnais construit ses chemins avec la barre oblique (voir racine() dans
    // tests/sondes/config.mjs, normalisee le 27/09 pour la meme raison), alors
    // que l index porte des antislashs. Comparer la racine sans normaliser
    // ferait echouer  sur un volume appele  — un refus qui
    // n aurait rien a voir avec le dossier demande.
    let normalise = chemin.replace('/', "\\");
    let chemin = normalise.as_str();
    let racine = snap.dirs[0].name.as_ref();
    if racine.eq_ignore_ascii_case(chemin) {
        return Some(0);
    }
    // `get` et non un découpage : un chemin dont les trois premiers octets ne
    // tombent pas sur une frontière de caractère rendrait `None` au lieu de
    // paniquer.
    if !chemin.get(..racine.len())?.eq_ignore_ascii_case(racine) {
        return None;
    }
    let mut cur = 0u32;
    for nom in chemin[racine.len()..]
        .split(['\\', '/'])
        .filter(|s| !s.is_empty())
    {
        cur = snap
            .child_dirs(cur)
            .into_iter()
            .find(|c| snap.dirs[*c as usize].name.eq_ignore_ascii_case(nom))?;
    }
    Some(cur)
}

#[derive(serde::Serialize)]
struct TreeJson {
    rows: Vec<Row>,
    path: Vec<Crumb>,
    total_size: u64,
    parent_size: u64,
    truncated: bool,
    /// Génération de l'instantané d'où viennent ces `id`. Le client doit la
    /// renvoyer pour supprimer : les identifiants sont des positions, et une
    /// position n'a de sens que dans l'instantané qui l'a produite.
    gen: u64,
}

fn tree(app: &Arc<App>, q: &Q) -> Result<Resp, (&'static str, String)> {
    let letter = q
        .get("drive")
        .and_then(|s| s.chars().next())
        .ok_or(("400 Bad Request", "drive manquant".into()))?
        .to_ascii_uppercase();
    let id: u32 = q.get("id").and_then(|s| s.parse().ok()).unwrap_or(0);
    let sort = q.get("sort").cloned().unwrap_or_else(|| "size".into());
    let order = q.get("order").cloned().unwrap_or_else(|| "desc".into());
    let limit: usize = q
        .get("limit")
        .and_then(|s| s.parse().ok())
        .unwrap_or(3000)
        .min(50_000);
    let offset: usize = q.get("offset").and_then(|s| s.parse().ok()).unwrap_or(0);

    let snap = {
        let d = app.drives.lock().unwrap();
        d.get(&letter)
            .and_then(|s| s.snap.clone())
            .ok_or(("409 Conflict", "volume pas encore analysé".into()))?
    };
    // Le dossier demandé est désigné par son CHEMIN. Un identifiant est une
    // POSITION dans l'instantané, et une position ne survit pas à une
    // ré-analyse : mesuré le 27/09/2026, l'identifiant 8 est passé du dossier
    // de la sonde au dépôt entre deux analyses. L'interface épinglait donc le
    // dossier courant par un nombre, et ce nombre changeait de sens sous ses
    // pieds — sans un mot, dans un outil dont la raison d'être est de ne pas
    // viser la mauvaise cible.
    //
    // `id` reste accepté pour qui n'a que lui, mais l'interface n'envoie plus
    // que le chemin.
    let id: u32 = match q.get("chemin") {
        Some(c) => dossier_de(&snap, c)
            .ok_or(("404 Not Found", format!("ce dossier n'existe plus : {c}")))?,
        None => id,
    };

    // Le chemin du dossier affiché, reconstruit par l'index — jamais par ce que
    // le client a envoyé. Les lignes en hériteront, et l'interface pourra donc
    // les rappeler par leur chemin après une ré-analyse.
    let base = snap.dir_path(id).to_string_lossy().into_owned();
    let mut rows: Vec<Row> = Vec::new();
    for c in snap.child_dirs(id) {
        let nom = &snap.dirs[c as usize].name;
        rows.push(Row {
            id: c,
            sel: scan::sel(c, true),
            name: nom.to_string(),
            size: snap.size[c as usize],
            count: snap.count[c as usize],
            mtime: snap.mtime[c as usize],
            is_dir: true,
            path: chemin_enfant(&base, nom),
        });
    }
    for c in snap.child_files(id) {
        rows.push(Row {
            id: c,
            sel: scan::sel(c, false),
            name: snap.files[c as usize].name.to_string(),
            size: snap.files[c as usize].size,
            count: 1,
            mtime: snap.files[c as usize].mtime,
            is_dir: false,
            path: chemin_enfant(&base, &snap.files[c as usize].name),
        });
    }

    // Le tri passe par la fonction partagée : `/api/tree` et `/api/search`
    // doivent produire le MÊME ordre, sinon la même liste change de tête selon
    // la route qui l'a rendue.
    //
    // L'ancien code comparait quatre critères sans jamais trancher l'égalité :
    // deux entrées de même taille sortaient dans l'ordre de l'index, et
    // changeaient de place quand on inversait le sens du tri. L'utilisateur ne
    // pouvait pasKilculer l'ordre, et une sonde ne pouvait pas le mesurer —
    // elle aurait conclu « le tri n'a pas été appliqué » en voyant une liste
    // inchangée.
    let total = rows.len();
    trier_lignes(&mut rows, Tri::depuis(&sort), order != "asc");

    let parent_size = snap.size[id as usize];
    let mut path: Vec<Crumb> = Vec::new();
    let mut cur = id as usize;
    loop {
        path.push(Crumb {
            name: snap.dirs[cur].name.to_string(),
            id: cur as u32,
            chemin: String::new(),
        });
        if cur == 0 {
            break;
        }
        let p = snap.dirs[cur].parent as usize;
        if p >= cur {
            break;
        }
        cur = p;
    }
    path.reverse();
    // Chaque palier porte le chemin complet qui mène à lui : c'est par là que
    // l'interface remonte, et un identifiant ne le peut pas. Le premier palier
    // est la racine — `V:\` — dont le chemin est son propre nom.
    if let Some(racine) = path.first_mut() {
        racine.chemin = racine.name.clone();
    }
    for i in 1..path.len() {
        let parent = path[i - 1].chemin.clone();
        path[i].chemin = chemin_enfant(&parent, &path[i].name);
    }

    let truncated = total > offset + limit;
    let rows: Vec<Row> = rows.into_iter().skip(offset).take(limit).collect();

    Ok(Resp::Json(
        serde_json::to_string(&TreeJson {
            rows,
            path,
            total_size: total as u64,
            parent_size,
            truncated,
            gen: snap.gen,
        })
        .unwrap(),
    ))
}

// ---------------------------- effacement ----------------------------
//
// Principe : on ne peut supprimer que ce qui a été simulé. La simulation
// (`mode = "dry"`) renvoie un jeton à usage unique ; l'exécution doit le
// représenter, sinon elle est refusée. Le jeton expire au bout de dix minutes,
// ce qui interdit de supprimer sur la foi d'une liste périmée.
//
// Par défaut c'est la corbeille (`recycle`), donc réversible. Le définitif
// exige en plus le mot « EFFACER » tapé à la main.

/// Un élément demandé par le client.
///
/// Il ne porte QUE son sélecteur. Le champ `is_dir` a disparu : le type se
/// déduit du bit de `sel` (voir `scan::BIT_FICHIER`), donc le serveur n'a plus
/// de type déclaré auquel accorder foi. Un `sel` mal typé n'atteint pas un autre
/// chemin — il n'atteint rien, et l'aperçu le dit./// Un élément demandé par le client : un sélecteur, et rien d'autre.
///
/// Le champ `is_dir` a disparu du protocole. Le type se déduit du bit de type
/// porté par le sélecteur lui-même (voir `scan::BIT_FICHIER`), donc le serveur
/// n'a plus de type déclaré auquel accorder foi. Un sélecteur mal typé
/// n'atteint pas un autre chemin — il n'atteint rien, et l'aperçu le dit.
type DeleteItem = u32;

#[derive(serde::Deserialize)]
struct DeleteReq {
    drive: String,
    /// Utilisé uniquement par la simulation. À l'exécution, la liste vient du
    /// jeton et jamais de la requête : sinon un appelant pourrait présenter un
    /// jeton valide obtenu sur une liste, et supprimer autre chose que ce qui a
    /// été montré.
    ///
    /// Une liste de sélecteurs nus. L'ancienne forme `{id, is_dir}` est
    /// refusée : ce serveur n'a qu'un client — l'interface embarquée, mise à
    /// jour dans le même changement — et une forme héritée qui continue de
    /// fonctionner est une forme que l'on croit encore sûre.
    #[serde(default)]
    items: Vec<u32>,
    mode: String,
    token: Option<String>,
    confirm: Option<String>,
    /// Génération de l'instantané d'où viennent les `items`. Les identifiants
    /// sont des positions : re-résoudre une position contre un instantané plus
    /// récent revient à viser un autre fichier. Mesuré — voir `Snapshot::gen`.
    #[serde(default)]
    gen: Option<u64>,
    /// Les noms de dossiers personnels que la personne a saisis, un par champ.
    /// `#[serde(default)]` : un client plus ancien n'envoie rien, et il doit
    /// alors se faire refuser par le serveur — ce qui est le but — sans que le
    /// protocole devienne illisible.
    #[serde(default)]
    noms: Vec<String>,
}

#[derive(serde::Serialize)]
struct PreviewItem {
    path: String,
    size: u64,
    count: u64,
    is_dir: bool,
    exists: bool,
    blocked: bool,
    reason: String,
}

#[derive(serde::Serialize)]
struct DeletePreview {
    token: String,
    items: Vec<PreviewItem>,
    total_size: u64,
    deletable: usize,
    blocked: usize,
    /// Le volume a-t-il une corbeille ? Faux ⇒ une suppression « corbeille »
    /// détruirait les fichiers. On le dit AVANT, pas seulement après.
    corbeille: bool,
    /// Plafond de la corbeille du volume, en octets. `None` : non mesuré.
    corbeille_plafond: Option<u64>,
    /// Octets déjà occupés dans cette corbeille, mesurés sur les fiches `$I`.
    corbeille_occupe: u64,
    /// `corbeille_occupe` est-il exhaustif ? Faux ⇒ c'est un MINIMUM.
    corbeille_complet: bool,
    /// Ce lot déborde-t-il la corbeille ? `None` = indécidable.
    ///
    /// « Récupérable » n'est vrai qu'instantanément : Windows purge les entrées
    /// les plus anciennes pour tenir dans son plafond, sans demander. Le dire
    /// AVANT vaut mieux que le découvrir dans le journal après coup.
    corbeille_deborde: Option<bool>,
    /// Les dossiers que ce lot touche et qui doivent etre nommes : `["Images",
    /// ".git"]`. Le nom dit ce qu'il fait — ce ne sont pas seulement des
    /// dossiers « personnels » : `.git` et `.ssh` y sont aussi.
    /// L'interface doit faire nommer CHACUN d'eux avant d'activer son bouton —
    /// un champ par dossier, donc six champs quand on a tout sélectionné d'un
    /// profil. Voir `dossiers_a_nommer`.
    #[serde(rename = "aNommer")]
    a_nommer: Vec<String>,
    /// Les mots à taper pour confirmer ce lot, et pour quel mode.
    ///
    /// Le serveur ne demande JAMAIS un mot à la place de l'utilisateur : il
    /// exige ce qui MANQUE, et rien d'autre. Sans ce champ, l'interface ne peut
    /// que deviner — et deviner faux dans un sens dispense d'un garde-fou, dans
    /// l'autre en impose un que l'utilisateur n'a pas demandé.
    ///
    /// Les DEUX modes sont répondus parce que la simulation est toujours en mode
    /// `dry` : elle se fait avant que l'utilisateur choisisse « corbeille » ou
    /// « définitif », et ce choix peut changer après coup. Répondre pour un seul
    /// mode laisserait l'interface deviner l'autre — donc se tromper, en silence.
    ///
    /// Une LISTE, et non un mot : les règles s'additionnent (voir
    /// `mots_exiges`), et une liste s'affiche comme une liste. Un seul champ
    /// qui choisirait le « plus fort » des mots ferait perdre les autres, et
    /// l'utilisateur ne saurait plus lequel s'applique.
    mots_recycle: Vec<MotExige>,
    mots_permanent: Vec<MotExige>,
}

/// Un mot à taper, et la raison pour laquelle il est demandé.
///
/// La raison voyage avec le mot parce que l'utilisateur doit pouvoir savoir ce
/// qu'il est en train de confirmer. Un champ nu, sans motif, se tape par
/// réflexe — et un mot tapé par réflexe ne protège de rien.
#[derive(serde::Serialize)]
struct MotExige {
    mot: String,
    raison: String,
}

#[derive(serde::Serialize)]
struct DeleteOutcome {
    done: usize,
    failed: usize,
    freed: u64,
    /// L'opération ÉTAIT-elle réversible — et non : l'a-t-on demandée réversible.
    to_trash: bool,
    /// Demandés en corbeille, mais détruits faute d'avoir été pris par elle.
    irreversible: usize,
    /// Ce lot était trop gros pour la corbeille du volume. Repris de la
    /// PRÉVISION mesurée à l'aperçu : après coup, « trop gros » ne se constate
    /// plus — ce qui s'est perdu est déjà perdu, et rien dans le disque ne
    /// dira que le plafond existait.
    corbeille_deborde: Option<bool>,
    results: Vec<PreviewItem>,
    rescan: bool,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Comment un sélecteur illisible est-il nommé dans l'aperçu ?
///
/// On montre l'identifiant tel quel, en signalant qu'il n'a pas été résolu :
/// afficher une taille ou un type pour un élément qu'on n'a pas résolu serait
/// inventer une information, et c'est exactement le mensonge qui a fait passer
/// une suppression à côté pour une suppression de la cible.
fn irreductible(sel: u32) -> PreviewItem {
    PreviewItem {
        path: format!("(sélecteur {sel} absent de l’index actuel)"),
        size: 0,
        count: 0,
        is_dir: false,
        exists: false,
        blocked: true,
        reason: "identifiant irrésoluble : l’index ne le connaît plus".into(),
    }
}

/// Chemins qu'on refuse d'effacer quoi qu'il arrive. La racine d'un volume, les
/// répertoires système et les profils utilisateurs entiers : une erreur de
/// sélection là-dessus serait irrécupérable, même via la corbeille.
fn blocked_reason(path: &Path) -> Option<&'static str> {
    let up = path.to_string_lossy().to_uppercase();
    if up.len() < 3 {
        return Some("chemin trop court");
    }
    let rest = &up[3..];
    let parts: Vec<&str> = rest.split('\\').filter(|p| !p.is_empty()).collect();
    if parts.is_empty() {
        return Some("racine du volume");
    }
    const FORBIDDEN: &[&str] = &[
        "WINDOWS",
        "PROGRAM FILES",
        "PROGRAM FILES (X86)",
        "PROGRAMDATA",
        "SYSTEM VOLUME INFORMATION",
        "$RECYCLE.BIN",
        "RECOVERY",
    ];
    if FORBIDDEN.contains(&parts[0]) {
        return Some("répertoire système protégé");
    }
    if parts[0] == "USERS" && parts.len() <= 2 {
        return Some("profil utilisateur protégé");
    }
    None
}

/// Répertoires dont la perte n'est pas anodine : ce sont les seuls que
/// quelqu'un souvient d'avoir. Un disque se nettoie, un dossier de photos non.
///
/// La liste est bilingue, parce que Windows nomme ces répertoires dans la
/// langue de la machine et qu'une règle seulement française ne protège
/// personne sur une installation anglaise. Elle porte sur des NOMS, pas sur
/// des personnes : `C:\Users\<nom>` n'en fait volontairement pas partie — tout
/// y serait personnel, et la règle viderait l'outil de son usage.
const DOSSIERS_A_NOMMER: &[&str] = &[
    // Français
    "BUREAU",
    "DOCUMENTS",
    "IMAGES",
    "MUSIQUE",
    "VIDÉOS",
    "TÉLÉCHARGEMENTS",
    "FAVORIS",
    // Anglais
    "DESKTOP",
    "PICTURES",
    "MUSIC",
    "VIDEOS",
    "DOWNLOADS",
    "FAVOURITES",
    "SAVED GAMES",
    // Configuration et clés. Ces dossiers ne sont pas « personnels » au sens
    // Windows, mais leur perte est aussi sèche : pas de corbeille qui les
    // restaure correctement, pas de sauvegarde qui les rendrait, et la seule
    // façon de les retrouver est de les re-configurer à la main. Un dépôt dont
    // on supprime `.git` perd son historique — s'il n'est pas ailleurs.
    "APPDATA",
    ".GIT",
    ".SSH",
    ".GNUPG",
    ".AWS",
    ".KUBE",
];

/// Les dossiers personnels que ce chemin traverse, écrits comme ils le sont
/// sur le disque, sans doublon.
///
/// `C:\Users\lucas\Images\2024\a.jpg` rend `["Images"]` — un seul, même si le
/// chemin passe dix fois par le nom, parce que la question posée à la personne
/// est « quel dossier », pas « combien de fois ».
///
/// La comparaison passe par `to_uppercase()` des deux côtés, accents compris :
/// `Téléchargements` ne devient jamais `TELECHARGEMENTS`, et une constante
/// écrite sans accent ne détecterait rien. Une règle de sécurité qui ne
/// détecte pas est une règle morte — de la même nature que celle que
/// `tests/sondes/filet.mjs` portait avant d'être réparée.
fn dossiers_a_nommer(path: &Path) -> Vec<String> {
    let mut vus: Vec<String> = Vec::new();
    for seg in path.to_string_lossy().split(['\\', '/']) {
        let seg = seg.trim();
        if seg.is_empty() {
            continue;
        }
        let haut = seg.to_uppercase();
        if !DOSSIERS_A_NOMMER.contains(&haut.as_str()) {
            continue;
        }
        if !vus.iter().any(|v| v.eq_ignore_ascii_case(seg)) {
            vus.push(seg.to_string());
        }
    }
    vus
}

fn delete(app: &Arc<App>, body: &[u8]) -> Result<Resp, (&'static str, String)> {
    let req: DeleteReq = match serde_json::from_slice(body) {
        Ok(r) => r,
        Err(e) => return Err(("400 Bad Request", format!("corps illisible : {e}"))),
    };
    let letter = req
        .drive
        .chars()
        .next()
        .ok_or(("400 Bad Request", "drive manquant".into()))?
        .to_ascii_uppercase();
    let snap = {
        let d = app.drives.lock().unwrap();
        d.get(&letter)
            .and_then(|s| s.snap.clone())
            .ok_or(("409 Conflict", "volume pas encore analysé".into()))?
    };
    // Les identifiants sont des POSITIONS dans l'instantané, et une position ne
    // vaut que dans l'instantané qui l'a produite : re-résoudre un identifiant
    // contre un instantané plus récent revient à viser un AUTRE fichier.
    //
    // Mesuré le 26/09/2026 : `p1.txt` portait l'identifiant 16. Après
    // suppression de `p1.txt`, ajout d'un fichier et ré-analyse, l'identifiant
    // 16 désignait `p2.txt` — et un aperçu demandé avec l'ancien identifiant
    // proposait `G:\_diskmap_perime\p2.txt`, `blocked=false`, `deletable=1`.
    // Le fichier montré n'était pas le fichier coché, et rien ne le disait.
    //
    // L'exécution, elle, n'a pas besoin de cette garde : elle ne résout plus
    // rien et ne supprime que les chemins figés par l'aperçu.
    let gen_vue = req.gen;
    match req.mode.as_str() {
        "dry" => {
            let Some(gen_vue) = gen_vue else {
                return Err((
                    "400 Bad Request",
                    "génération de l’instantané absente : recharge la liste avant de supprimer"
                        .into(),
                ));
            };
            if gen_vue != snap.gen {
                return Err((
                    "409 Conflict",
                    format!(
                        "la liste a été lue à la génération {gen_vue}, l’index est à la {0} : \
                         les positions ont pu changer. Recharge la liste avant de supprimer.",
                        snap.gen
                    ),
                ));
            }
            dry(app, letter, &snap, req.items)
        }
        // `req.items` est délibérément ignoré à l'exécution : on ne supprime que
        // ce que `dry` a résolu et montré.
        "recycle" => execute(app, letter, req, true),
        "permanent" => execute(app, letter, req, false),
        _ => Err(("400 Bad Request", "mode inconnu".into())),
    }
}

fn dry(
    app: &Arc<App>,
    letter: char,
    snap: &Snapshot,
    items: Vec<DeleteItem>,
) -> Result<Resp, (&'static str, String)> {
    let mut out: Vec<PreviewItem> = Vec::new();
    let mut total = 0u64;
    let mut deletable = 0usize;
    let mut blocked = 0usize;

    // On refuse AU PLUS TOT, et l'aperçu est alors complet ou absent : jamais
    // « les 25 premiers » d'une liste que l'exécution supprimera en entier.
    // Voir `ITEMS_MAX`.
    if items.len() > ITEMS_MAX {
        return Err((
            "400 Bad Request",
            format!(
                "{} éléments demandés, {} au maximum : affine la sélection, \
                 un lot plus large ne serait pas lisible à l'écran",
                items.len(),
                ITEMS_MAX
            ),
        ));
    }

    // Ce qu'on retient pour l'exécution : le chemin résolu, figé ici. C'est la
    // seule liste que `execute` consultera.
    let mut montres: Vec<Montre> = Vec::new();

    for it in &items {
        // Un identifiant irrésoluble ne doit pas DISPARAÎTRE. Le client en
        // demande N et n'en verrait revenir N-1, sans rien pour le lui dire :
        // c'était le cas, `continue` suffisait à effacer la trace. Mesuré le
        // 26/09/2026 — un aperçu demandé pour deux éléments dont un hors bornes
        // en renvoyait UN, et `deletable=1` n'en soufflait mot.
        let Some(e) = snap.entree(*it) else {
            blocked += 1;
            out.push(irreductible(*it));
            continue;
        };
        let path = e.path;
        let (size, count) = (e.size, e.count);
        let ps = path.to_string_lossy().into_owned();
        let reason = blocked_reason(&path);
        let exists = path.exists();
        let blocked_flag = reason.is_some() || !exists;
        if blocked_flag {
            blocked += 1;
        } else {
            deletable += 1;
            total += size;
            // Le sélecteur est figé avec le chemin : c'est lui qui permet au
            // journal de nommer ce que le client AVAIT demandé, à côté de ce
            // qui a été traité. Voir `LigneJournal`.
            montres.push(Montre {
                path,
                sel: *it,
                is_dir: e.is_dir,
                size,
                count,
            });
        }
        out.push(PreviewItem {
            path: ps,
            size,
            count,
            is_dir: e.is_dir,
            exists,
            blocked: blocked_flag,
            reason: reason
                .unwrap_or(if exists {
                    ""
                } else {
                    "introuvable sur le disque"
                })
                .to_string(),
        });
    }

    // Les dossiers personnels que ce lot touche, PARCOURUS SUR CE QUI SERA
    // RÉELLEMENT SUPPRIMÉ : un élément bloqué ne part pas, il ne doit donc pas
    // faire défaut de le confirmer. C'est la seule liste que l'interface verra, et elle
    // est calculée ici, pas chez le client — sinon un client qui n'en veut pas
    // n'enverrait aucun.
    let mut a_nommer: Vec<String> = Vec::new();
    for m in &montres {
        for d in dossiers_a_nommer(&m.path) {
            if !a_nommer.iter().any(|p| p.eq_ignore_ascii_case(&d)) {
                a_nommer.push(d);
            }
        }
    }
    a_nommer.sort_by_key(|d| d.to_uppercase());

    // L'état de la corbeille, mesuré UNE fois et figé avec l'aperçu : c'est
    // l'état AVANT qui décide, et le relever à l'exécution serait déjà faux.
    let etat = win32::etat_corbeille(letter);
    let deborde = etat.deborde(total);

    // Le mot exigé est décidé ICI, dans la simulation, et figé avec elle : à
    // l'exécution, la corbeille aura pu changer, et la décision serait déjà
    // fausse. Il est calculé du MODE DEMANDÉ, comme le fera l'exécution — la
    // corbeille réelle ne s'applique que si l'exécution a lieu, et là c'est trop
    // tard pour exiger un mot.
    let corbeille = win32::corbeille_disponible(letter);
    let (mots_recycle, mots_permanent) = (
        mots_avec_raison(total, true, corbeille, app.eleve),
        mots_avec_raison(total, false, corbeille, app.eleve),
    );

    // L'horodatage sert à dater et à distinguer deux jetons ; il n'a jamais eu à
    // cacher quoi que ce soit, puisqu'il est écrit en clair juste à côté. C'est
    // l'aléa qui doit être imprévisible — et lui seul.
    let token = format!("{}-{:016x}", now_ms(), win32::alea_u64());
    {
        let mut p = app.pending.lock().unwrap();
        // Un jeton périmé est retiré ICI aussi, pas seulement à l'exécution :
        // une série d'aperçus jamais confirmés ferait sinon croître cette map
        // sans borne, chacun retenant une liste entière de chemins.
        let now = now_ms();
        p.retain(|_, v| now - v.at_ms < 600_000);
        p.insert(
            token.clone(),
            PendingDel {
                drive: letter,
                items: montres,
                at_ms: now_ms(),
                gen: snap.gen,
                corbeille_deborde: deborde,
            },
        );
    }

    Ok(Resp::Json(
        serde_json::to_string(&DeletePreview {
            token,
            items: out,
            total_size: total,
            deletable,
            blocked,
            corbeille: win32::corbeille_disponible(letter),
            corbeille_plafond: etat.plafond,
            corbeille_occupe: etat.occupe,
            corbeille_complet: etat.complet,
            corbeille_deborde: deborde,
            a_nommer,
            mots_recycle,
            mots_permanent,
        })
        .unwrap(),
    ))
}

fn execute(
    app: &Arc<App>,
    letter: char,
    req: DeleteReq,
    to_trash: bool,
) -> Result<Resp, (&'static str, String)> {
    let token = req.token.clone().unwrap_or_default();

    // On valide tout avant de consommer le jeton : une demande refusée (mauvais
    // volume, confirmation absente) ne doit pas obliger à refaire une simulation.
    let peek = {
        let mut p = app.pending.lock().unwrap();
        let now = now_ms();
        p.retain(|_, v| now - v.at_ms < 600_000);
        p.get(&token).cloned()
    };
    let peek = peek.ok_or((
        "409 Conflict",
        "jeton absent ou expiré : relance une simulation avant de supprimer".into(),
    ))?;
    if peek.drive != letter {
        return Err(("400 Bad Request", "jeton d'un autre volume".into()));
    }
    // "recycle" n'est qu'une intention : sans corbeille, Windows détruit. La
    // confirmation dépend donc de l'effet prévisible, pas du libellé du bouton.
    // Une instance ÉLEVÉE s'y ajoute : les ACL ne s'appliquent plus, et le mot
    // demandé est alors celui de la suppression DÉFINITIVE — sans remplacer
    // les autres règles, qui s'ajoutent.
    let recycle_available = win32::corbeille_disponible(letter);
    let confirm = req.confirm.clone().unwrap_or_default();
    let attendus = mots_exiges(
        taille_du_lot(&peek.items),
        to_trash,
        recycle_available,
        app.eleve,
    );
    if !confirmation_suffit(&confirm, &attendus) {
        // Le motif nomme la saisie attendue, mot pour mot : un refus qui ne dit
        // pas quoi taper laisse l'utilisateur deviner, et il devine mal — ou il
        // tape n'importe quoi jusqu'à ce que ça passe.
        return Err((
            "400 Bad Request",
            format!("confirmation attendue : « {} »", attendus.join(" ")),
        ));
    }

    // Les dossiers personnels suivent la même règle que le mot « EFFACER » :
    // chacun doit être nommé. Les attendus sont RECALCULÉS ici, sur les chemins
    // figés de l'aperçu — le serveur ne fait jamais confiance à une liste
    // envoyée par le client, sans quoi il suffirait d'en envoyer une vide pour
    // que la règle ne s'applique jamais.
    let mut attendus: Vec<String> = Vec::new();
    for m in &peek.items {
        for d in dossiers_a_nommer(&m.path) {
            if !attendus.iter().any(|p| p.eq_ignore_ascii_case(&d)) {
                attendus.push(d);
            }
        }
    }
    for d in &attendus {
        if !req.noms.iter().any(|s| s.trim().eq_ignore_ascii_case(d)) {
            return Err((
                "400 Bad Request",
                format!("dossier personnel « {d} » non confirmé : nomme-le pour confirmer la suppression"),
            ));
        }
    }

    // Validé : le jeton est consommé, il ne servira qu'une fois.
    let pending = {
        let mut p = app.pending.lock().unwrap();
        p.remove(&token)
    };
    let pending = pending.ok_or((
        "409 Conflict",
        "jeton consommé entre-temps : relance une simulation".into(),
    ))?;

    let mut results: Vec<PreviewItem> = Vec::new();
    let mut done = 0usize;
    let mut failed = 0usize;
    let mut freed = 0u64;
    // TOUT ce que le lot a touché, y compris ce qu'il n'a pas supprimé. Un
    // journal qui n'écrit que les succès laisse le même vide que l'incident : on
    // y voit des suppressions, mais pas les cibles refusées entre les deux —
    // donc pas la preuve qu'un lot avait bien été artículos comme prévu.
    let mut journal_lignes: Vec<LigneJournal> = Vec::new();
    // Demandés en corbeille, mais la corbeille ne les a pas pris : détruits.
    let mut irreversible = 0usize;
    // Sert de plancher aux fiches `$I` : une fiche plus ancienne décrit une
    // suppression ANTÉRIEURE du même chemin, et ferait passer une destruction
    // pour un succès. `now_ms` est signé, les dates de fiches ne le sont pas.
    let debut_ms = now_ms().max(0) as u64;
    // Éléments supprimés dont la réversibilité reste à juger : (index dans
    // `results`, index dans `journal_lignes`). On les juge après la boucle, et
    // non dedans — voir plus bas.
    let mut a_juger: Vec<(usize, usize)> = Vec::new();

    // On ne résout PLUS les identifiants ici : `pending.items` porte les chemins
    // résolus au moment de l'aperçu, et c'est la seule chose qu'on s'autorise à
    // supprimer. Résoudre à nouveau contre l'instantané courant revenait à faire
    // confiance à un index qui a pu être remplacé depuis (voir `Montre`).
    for m in &pending.items {
        let ps = m.path.to_string_lossy().into_owned();
        let size = m.size;
        let count = m.count;
        // Ligne de journal d'un élément NON supprimé. `prevu` et `realise` sont
        // identiques — c'est le chemin figé, et rien d'autre n'a été tenté — et
        // le dire deux fois est le but : si un jour un chemin résolu à
        // l'exécution réapparaît, les deux colonnes divergent et l'écart se lit
        // sans avoir à comparer le journal au code.
        let refuse = |motif: &str, realise: String| LigneJournal {
            lot: token.clone(),
            gen: pending.gen,
            sel: m.sel,
            prevu: ps.clone(),
            realise,
            issue: "refuse".into(),
            taille: size,
            count,
            motif: motif.to_string(),
        };
        let reason = blocked_reason(&m.path);
        if let Some(r) = reason {
            failed += 1;
            journal_lignes.push(refuse(r, ps.clone()));
            results.push(PreviewItem {
                path: ps,
                size,
                count,
                is_dir: m.is_dir,
                exists: true,
                blocked: true,
                reason: r.to_string(),
            });
            continue;
        }
        if !m.path.exists() {
            failed += 1;
            journal_lignes.push(refuse("introuvable sur le disque", ps.clone()));
            results.push(PreviewItem {
                path: ps,
                size,
                count,
                is_dir: m.is_dir,
                exists: false,
                blocked: true,
                reason: "introuvable sur le disque".into(),
            });
            continue;
        }
        // Le scan ignore déjà les points d'analyse. On les refuse aussi juste
        // avant l'action : une cible normale peut avoir été remplacée depuis
        // l'aperçu par une jonction ou un lien symbolique.
        match win32::is_reparse_point(&m.path) {
            Ok(true) => {
                failed += 1;
                journal_lignes.push(refuse("point d’analyse apparu depuis l’aperçu", ps.clone()));
                results.push(PreviewItem {
                    path: ps,
                    size,
                    count,
                    is_dir: m.is_dir,
                    exists: true,
                    blocked: true,
                    reason: "point d’analyse apparu depuis l’aperçu : suppression refusée".into(),
                });
                continue;
            }
            Err(e) => {
                failed += 1;
                let motif = format!("impossible de vérifier la cible avant suppression : {e}");
                journal_lignes.push(refuse(&motif, ps.clone()));
                results.push(PreviewItem {
                    path: ps,
                    size,
                    count,
                    is_dir: m.is_dir,
                    exists: false,
                    blocked: true,
                    reason: motif,
                });
                continue;
            }
            Ok(false) => {}
        }
        match win32::delete_path(&ps, to_trash) {
            Ok(()) => {
                done += 1;
                freed += size;
                // La réversibilité se CONSTATE, et elle se lit dans la corbeille
                // — mais les fiches des fichiers qu'on vient de lui envoyer n'y
                // sont qu'APRÈS l'opération. On note donc l'élément tel quel, et
                // on jugera plus bas, en une seule lecture de la corbeille : la
                // relire ici, pour chaque élément, coûtait N × M (voir
                // `win32::Corbeille`).
                let idx = results.len();
                results.push(PreviewItem {
                    path: ps.clone(),
                    size,
                    count,
                    is_dir: m.is_dir,
                    // Après l'opération le chemin n'existe plus, et c'est vrai
                    // dans les deux cas. Le champ dit la même chose des deux
                    // côtés de la branche — il ne l'affirme plus.
                    exists: false,
                    blocked: false,
                    reason: String::new(),
                });
                let jdx = journal_lignes.len();
                journal_lignes.push(LigneJournal {
                    lot: token.clone(),
                    gen: pending.gen,
                    sel: m.sel,
                    prevu: ps.clone(),
                    realise: ps.clone(),
                    // Issue provisoire : la réversibilité n'est pas encore
                    // connue. Elle est écrite plus bas, au même emplacement.
                    issue: String::new(),
                    taille: size,
                    count,
                    motif: String::new(),
                });
                a_juger.push((idx, jdx));
            }
            Err(e) => {
                failed += 1;
                // `exists` doit dire la VÉRITÉ. Le figer à `true` faisait
                // affirmer que le fichier était toujours là alors qu'il avait
                // disparu — et c'est ainsi qu'une suppression réussie a pu
                // passer pour un échec sans que rien ne le contredise.
                let encore = m.path.exists();
                journal_lignes.push(refuse(&e, ps.clone()));
                results.push(PreviewItem {
                    path: ps,
                    size,
                    count,
                    is_dir: m.is_dir,
                    exists: encore,
                    blocked: true,
                    reason: e,
                });
            }
        }
    }

    // La réversibilité, jugée une fois pour toutes — après les suppressions,
    // parce que c'est seulement là que la corbeille porte les fiches des
    // fichiers qu'on vient de lui envoyer.
    //
    // `FOF_ALLOWUNDO` signifie « mets à la corbeille SI c'est possible » :
    // mesuré le 26/09/2026, sur E: — volume sans corbeille — l'opération
    // réussit, renvoie 0, et le fichier est DÉTRUIT. Journaliser « corbeille »
    // sur la foi de la demande enregistrait donc une destruction comme une
    // opération réversible, et l'utilisateur n'avait aucun moyen de le savoir.
    if !a_juger.is_empty() {
        let corbeille = if to_trash {
            Some(win32::Corbeille::lire(letter, debut_ms))
        } else {
            None
        };
        for (idx, jdx) in &a_juger {
            let ps = journal_lignes[*jdx].realise.clone();
            let reversible = corbeille
                .as_ref()
                .map(|c| c.contient(&ps, debut_ms))
                .unwrap_or(false);
            let l = &mut journal_lignes[*jdx];
            l.issue = match (to_trash, reversible) {
                (true, true) => "corbeille",
                (true, false) => "corbeille-refusee",
                _ => "definitif",
            }
            .into();
            if to_trash && !reversible {
                irreversible += 1;
                results[*idx].reason = "DÉTRUIT : la corbeille de ce volume ne l’a pas pris".into();
                l.motif = "la corbeille de ce volume ne l’a pas pris".into();
            }
        }
    }

    if !journal_lignes.is_empty() {
        journal(app, &journal_lignes);
    }

    // L'index ne reflète plus le disque : on relance une analyse pour que les
    // totaux redeviennent justes au lieu de garder des entrées fantômes.
    let rescan = done > 0;
    if rescan {
        start_scan(app, letter);
    }

    // `to_trash` répond à la question utile : « l'opération était-elle
    // réversible ? » — et non « l'a-t-on demandée réversible ? ». Les deux
    // différaient silencieusement tant qu'on ne vérifiait pas la corbeille.
    let reversible = to_trash && irreversible == 0;
    Ok(Resp::Json(
        serde_json::to_string(&DeleteOutcome {
            done,
            failed,
            freed,
            to_trash: reversible,
            irreversible,
            corbeille_deborde: peek.corbeille_deborde,
            results,
            rescan,
        })
        .unwrap(),
    ))
}

/// La taille d'un lot FIGÉ par l'aperçu, en octets.
///
/// L'exécution recalcule les mots exigés sur les chemins qu'elle va vraiment
/// toucher — pas sur ce que le client a annoncé, et pas sur ce que l'aperçu avait
/// calculé. Un client qui enverrait un lot énorme en espérant éviter le mot
/// n'y parviendrait pas : c'est la seule façon que la règle tienne.
fn taille_du_lot(items: &[Montre]) -> u64 {
    items.iter().map(|m| m.size).sum()
}

fn confirmation_required(to_trash: bool, recycle_available: bool) -> bool {
    !to_trash || !recycle_available
}

/// Une instance ÉLEVÉE change-t-elle ce que vaut une suppression ?
///
/// Windows ignore les ACL quand le jeton est élevé : les droits du compte
/// deviennent inopérants, et les fichiers que l'utilisateur ne pourrait pas
/// toucher le sont. L'interface le dit — un bandeau, en haut de page — mais un
/// bandeau n'est pas une règle : il se ferme avec l'onglet, et rien n'oblige à
/// l'avoir vu.
///
/// La règle retenue tient en une ligne, et elle cumule au lieu de remplacer :
/// une instance élevée exige le MÊME mot que la suppression définitive, en plus
/// de tout ce que le lot exige déjà. Rien n'est interdit — l'utilisateur peut
/// Legitiment vouloir nettoyer un volume entier en administrateur — mais le
/// geste devient un geste.
///
/// Le mot `EFFACER` est-il exigé, et pour quelle raison ?
///
/// Le serveur ne demande JAMAIS `EFFACER` à la place de l'utilisateur : il exige
/// ce qui manque. `Some("EFFACER")` signifie « tape EFFACER ». `None` signifie
/// « rien à taper de plus » — et c'est distinct de `Some("")`, qui est la
/// faute de l'interface : elle promettait une saisie qu'elle n'exigeait pas.
/// Les paliers de taille, du plus bas au plus haut.
///
/// Le premier n'est pas une intuition : c'est l'échelle de ce qui s'est réellement
/// passé. Le 26/09/2026, un geste unique a envoyé **74,2 Go** à la corbeille et
/// détruit 79 fichiers définitifs. Avant cette règle, ce geste-là ne demandait rien,
/// alors qu'une photo de 2 Mo demandait le nom de son dossier.
///
/// Le second palier n'est pas là pour « être plus strict » : 500 Go, c'est
/// l'ordre de grandeur d'un disque de données entier. Au-delà, exiger le même mot
/// qu'à 20 Go revient à ne plus rien exiger du tout — le mot est devenu une
/// habitude, et une habitude n'est pas une protection.
const PALIER_SUPPRIMER: u64 = 20 * 1_000_000_000;
const PALIER_SUPPRIMER_TOUT: u64 = 500 * 1_000_000_000;

/// Les mots que le serveur exige, pour un lot donné, dans l'ordre où il faut
/// les taper.
///
/// Ils ne se remplacent pas : ils s'additionnent. Un lot de 600 Go en instance
/// élevée et sans corbeille demande les trois, parce que chacune des trois
/// raisons est vraie indépendamment des deux autres. C'est le point : un mot
/// unique qui choisirait « le plus fort » ferait perdre les deux autres, et
/// l'utilisateur ne saurait jamais lequel s'applique.
fn mots_exiges(taille: u64, to_trash: bool, corbeille: bool, eleve: bool) -> Vec<&'static str> {
    let mut mots: Vec<&'static str> = Vec::new();
    if taille >= PALIER_SUPPRIMER_TOUT {
        mots.push("SUPPRIMER TOUT");
    } else if taille >= PALIER_SUPPRIMER {
        mots.push("SUPPRIMER");
    }
    if confirmation_required(to_trash, corbeille) || eleve_change_le_geste(eleve) {
        mots.push("EFFACER");
    }
    mots
}

/// La confirmation tapée satisfait-elle TOUS les mots exigés ?
///
/// **Égalité exacte, dans l'ordre.** C'est la règle qu'imposait déjà
/// `sonde-suppression.mjs` pour un mot seul — `effacer` en minuscules et
/// `EFFACER ` suivi d'une espace étaient l'un et l'autre refusés — et elle n'est
/// pas affaiblie ici pour hériter d'un mot de plus.
///
/// J'avais d'abord écrit cette comparaison en ignorant la casse et les espaces
/// superflus. C'était une faute : la règle existe parce que taper exactement ce
/// qui est écrit est un geste de plus, et c'est un geste qui compte. Un mot
/// recopié sans être lu est précisément le mot que ce garde-fou doit attraper.
/// Un mot à deux mots s'écrit `SUPPRIMER TOUT`, d'un seul tenant.
fn confirmation_suffit(conf: &str, mots: &[&str]) -> bool {
    // Aucun mot exigé : rien à vérifier. La comparaison ci-dessous dirait sinon
    // « non » à une confirmation parasite, et l'exécution serait refusée pour un
    // lot qui n'a rien demandé — un garde-fou qui bloque quand il n'a rien à
    // garder. Le champ est donc ignoré dès qu'il est vide.
    mots.is_empty() || conf == mots.join(" ")
}

/// Les mots exigés, chacun avec la raison pour laquelle il est demandé.
///
/// Le motif n'est pas décoratif : c'est lui qui distingue une règle qu'on
/// comprend d'une règle qu'on subit. « 74 Go partent » se lit ; « tapez un mot »
/// se contourne au bout de la deuxième fois.
fn mots_avec_raison(taille: u64, to_trash: bool, corbeille: bool, eleve: bool) -> Vec<MotExige> {
    let mut out = Vec::new();
    if taille >= PALIER_SUPPRIMER_TOUT {
        out.push(MotExige {
            mot: "SUPPRIMER TOUT".into(),
            raison: "ce lot dépasse un demi-teraoctet".into(),
        });
    } else if taille >= PALIER_SUPPRIMER {
        out.push(MotExige {
            mot: "SUPPRIMER".into(),
            raison: "ce lot dépasse vingt gigaoctets".into(),
        });
    }
    if confirmation_required(to_trash, corbeille) {
        out.push(MotExige {
            mot: "EFFACER".into(),
            raison: if to_trash {
                "ce volume n'a pas de corbeille".into()
            } else {
                "suppression définitive".into()
            },
        });
    } else if eleve_change_le_geste(eleve) {
        out.push(MotExige {
            mot: "EFFACER".into(),
            raison: "les droits du compte ne s'appliquent plus en instance élevée".into(),
        });
    }
    out
}

/// Une instance ÉLEVÉE change-t-elle ce que vaut une suppression ?
///
/// Windows ignore les ACL quand le jeton est élevé : les droits du compte
/// deviennent inopérants, et les fichiers que l'utilisateur ne pourrait pas
/// toucher le sont. L'interface le dit — un bandeau, en haut de page — mais un
/// bandeau n'est pas une règle : il se ferme avec l'onglet, et rien n'oblige à
/// l'avoir vu.
///
/// La règle retenue tient en une ligne, et elle cumule au lieu de remplacer :
/// une instance élevée exige le MÊME mot que la suppression définitive, en plus
/// de tout ce que le lot exige déjà. Rien n'est interdit — on peut
/// légitimement vouloir nettoyer un volume entier en administrateur — mais le
/// geste devient un geste.
///
/// L'avertissement ne DISPENSE pas : l'utilisateur qui a lu le bandeau et veut
/// passer outre tape le mot. C'est le but — pas un mur.
fn eleve_change_le_geste(eleve: bool) -> bool {
    eleve
}

#[cfg(test)]
mod tests_scan_redemande {
    use super::demande_couverte;

    #[test]
    fn une_file_vide_ne_couvre_rien() {
        assert!(!demande_couverte(&[], 'G'));
    }

    #[test]
    fn un_autre_volume_en_attente_ne_couvre_pas() {
        assert!(!demande_couverte(&['C'], 'G'));
    }

    #[test]
    fn un_volume_deja_en_attente_est_couvert() {
        // La borne : dix demandes pendant la même analyse ne doivent pas
        // devenir dix passages de plus sur le disque.
        assert!(demande_couverte(&['C', 'G'], 'G'));
    }

    #[test]
    fn deux_demandes_pendant_une_analyse_donnent_une_seule_Analyse() {
        // La séquence que l'ancien code exécutait, et le résultat qu'il
        // produisait : la demande absorbée, la file toujours vide, donc rien.
        // Mesuré le 28/09/2026 sur `generation` -- le dossier créé, la demande
        // répondue `ok`, et un instantané pris AVANT sa création.
        //
        // Un instantané antérieur à la création d'un dossier ne peut pas
        // contenir ce dossier : la seule chose qui couvre la demande, c'est une
        // analyse d'après elle. Deux demandes, une analyse de plus -- ni zéro,
        // ni deux.
        let mut file: Vec<char> = Vec::new();
        if !demande_couverte(&file, 'G') {
            file.push('G');
        }
        if !demande_couverte(&file, 'G') {
            file.push('G');
        }
        assert_eq!(file, vec!['G']);
    }
}

#[cfg(test)]
mod tests {
    use super::{
        confirmation_required, confirmation_suffit, decider_le_navigateur, dossiers_a_nommer,
        mots_exiges, LigneJournal, PALIER_SUPPRIMER, PALIER_SUPPRIMER_TOUT,
    };
    use std::path::Path;

    #[test]
    fn requires_confirmation_when_recycling_would_destroy() {
        assert!(confirmation_required(true, false));
        assert!(confirmation_required(false, true));
        assert!(!confirmation_required(true, true));
    }

    /// Le cas FR, y compris l'accent : `Téléchargements` ne devient pas
    /// `TELECHARGEMENTS` à la majuscule, et une constante écrite sans accent ne
    /// détecterait rien. Une règle qui ne détecte pas est une règle morte —
    /// même nature que celle que `tests/sondes/filet.mjs` portait avant d'être
    /// réparée.
    #[test]
    fn trouves_les_dossiers_a_nommer_en_francais() {
        assert_eq!(
            dossiers_a_nommer(Path::new(r"C:\Users\lucas\Images\a.jpg")),
            ["Images"]
        );
        assert_eq!(
            dossiers_a_nommer(Path::new(r"C:\Users\lucas\Téléchargements\setup.exe")),
            ["Téléchargements"]
        );
        assert_eq!(
            dossiers_a_nommer(Path::new(r"C:\Users\lucas\Bureau\notes")),
            ["Bureau"]
        );
    }

    #[test]
    fn trouves_les_dossiers_a_nommer_en_anglais() {
        assert_eq!(
            dossiers_a_nommer(Path::new(r"C:\Users\sam\Pictures\x.png")),
            ["Pictures"]
        );
        assert_eq!(
            dossiers_a_nommer(Path::new(r"C:\Users\sam\Desktop\y.txt")),
            ["Desktop"]
        );
    }

    /// La seconde famille : clés et historiques. Un dépôt dont on supprime `.git`
    /// perd son histoire, une clé qu'on supprime se ré-édite. La corbeille ne
    /// rend ni l'un ni l'autre.
    #[test]
    fn trouves_les_dossiers_de_configuration() {
        assert_eq!(
            dossiers_a_nommer(Path::new(r"G:\workspaces\projet\.git\config")),
            [".git"]
        );
        assert_eq!(
            dossiers_a_nommer(Path::new(r"C:\Users\lucas\.ssh\id_rsa")),
            [".ssh"]
        );
        assert_eq!(
            dossiers_a_nommer(Path::new(r"C:\Users\lucas\AppData\Roaming\x")),
            ["AppData"]
        );
    }

    /// Le faux positif le plus probable de cette famille : `.gitignore`, qui
    /// commence comme `.git` et n'a rien à voir avec un dépôt. Sans ce test, une
    /// comparaison par préfixe ferait apparaître un champ à remplir sur chaque
    /// projet du disque.
    #[test]
    fn un_nom_qui_commence_par_un_nom_de_dossier_ne_compte_pas() {
        assert!(dossiers_a_nommer(Path::new(r"G:\workspaces\projet\.gitignore")).is_empty());
        assert!(dossiers_a_nommer(Path::new(r"C:\x\images-rendus\a.png")).is_empty());
        assert!(dossiers_a_nommer(Path::new(r"C:\x\AppDatas\b.txt")).is_empty());
    }

    /// Un dossier de travail nommé `Documents` sur un disque de données serait    /// Un dossier de travail nommé `Documents` sur un disque de données serait
    /// un faux positif... et on ne devine pas les intentions : la règle porte
    /// sur des noms, elle ne peut pas savoir. Ce test dit au moins que le cas
    /// est connu, et qu'un simple préfixe ne suffit pas à la déclencher.
    #[test]
    fn un_prefixe_ne_compte_pas() {
        assert!(dossiers_a_nommer(Path::new(r"D:\projets\images-utils\x.rs")).is_empty());
        assert!(dossiers_a_nommer(Path::new(r"D:\burns\a.iso")).is_empty());
    }

    /// Le dossier personnel est nommé UNE fois, même quand dix fichiers y
    /// sont : la question posée à la personne est « quel dossier », pas « combien
    /// de fois ». Ni la casse ni les variantes de chemin ne doivent créer un
    /// second champ à remplir.
    #[test]
    fn chaque_dossier_a_nommer_n_est_nomme_qu_une_fois() {
        let mut v: Vec<String> = Vec::new();
        for p in [
            r"C:\Users\lucas\Images\a.jpg",
            r"C:\Users\lucas\Images\2024\b.jpg",
            r"C:\Users\lucas\Documents\c.pdf",
            r"c:\users\LUCAS\images\d.jpg",
        ] {
            for d in dossiers_a_nommer(Path::new(p)) {
                if !v.iter().any(|x: &String| x.eq_ignore_ascii_case(&d)) {
                    v.push(d);
                }
            }
        }
        assert_eq!(
            v.len(),
            2,
            "attendu Images et Documents : pas de doublon, pas de variante de casse"
        );
    }

    fn ligne(corbeille: &str, prevu: &str, realise: &str) -> String {
        LigneJournal {
            lot: "1700000000000-0123456789abcdef".into(),
            gen: 7,
            sel: 12,
            prevu: prevu.into(),
            realise: realise.into(),
            issue: corbeille.into(),
            taille: 25,
            count: 1,
            motif: String::new(),
        }
        .ligne(1700000000000)
    }

    /// Sous le palier, rien n'est demandé — et c'est ce qui compte.
    ///
    /// Le cas ordinaire est le cas fréquent : ouvrir un dossier, effacer un
    /// cache, valider. Une règle qui se déclenche sur ce geste apprend le geste, et un
    /// geste appris n'arrête plus rien. La règle ne sert qu'à
    /// l'exception, donc elle ne doit pasdhaîner sur l'exception.
    #[test]
    fn sous_le_palier_rien_nest_exige() {
        let petit = PALIER_SUPPRIMER - 1;
        assert!(mots_exiges(petit, true, true, false).is_empty());
        assert!(mots_exiges(0, true, true, false).is_empty());
    }

    /// Le palier est une MESURE, pas une intuition.
    ///
    /// Le 26/09/2026, un geste unique a envoyé 74,2 Go à la corbeille et détruit
    /// 79 fichiers définitifs. Avant cette règle, ce lot ne demandait rien, alors
    /// qu'une photo de 2 Mo demandait le nom de son dossier. Le test fixe cette
    /// bascule : si quelqu'un relève le palier, ce test échoue, et la raison est
    /// visible.
    #[test]
    fn le_palier_tient_la_vraie_echelle_de_lincident() {
        let go = 1_000_000_000u64;
        assert!(mots_exiges(74 * go + 200_000_000, true, true, false).contains(&"SUPPRIMER"));
        assert!(mots_exiges(19 * go + 999_999_999, true, true, false).is_empty());
    }

    /// Au-delà du demi-teraoctet, exiger le même mot qu'à 20 Go ne protège plus
    /// de rien : le mot serait devenu une habitude.
    #[test]
    fn le_second_palier_demande_plus_que_le_premier() {
        assert_eq!(
            mots_exiges(PALIER_SUPPRIMER, true, true, false),
            vec!["SUPPRIMER"]
        );
        assert_eq!(
            mots_exiges(PALIER_SUPPRIMER_TOUT, true, true, false),
            vec!["SUPPRIMER TOUT"]
        );
    }

    /// Les règles s'additionnent : un lot énorme ET définitif demande les DEUX
    /// mots, pas le plus fort des deux.
    ///
    /// C'est le cœur de la règle. Un mot unique qui choisirait « le plus fort »
    /// ferait perdre l'autre, et l'utilisateur ne saurait jamais lequel
    /// s'applique — donc il taperait le mauvais, et le serveur refuserait, et il
    /// finirait par taper les deux sans comprendre.
    #[test]
    fn les_mots_s_additionnent_ils_ne_se_remplacent_pas() {
        let go = 1_000_000_000u64;
        assert_eq!(
            mots_exiges(600 * go, false, true, false),
            vec!["SUPPRIMER TOUT", "EFFACER"]
        );
        // sans corbeille, le mot de corbeille devient lui-même définitif.
        assert_eq!(
            mots_exiges(30 * go, true, false, false),
            vec!["SUPPRIMER", "EFFACER"]
        );
        // instance élevée : le mot s'ajoute sans rien retirer.
        assert_eq!(
            mots_exiges(30 * go, true, true, true),
            vec!["SUPPRIMER", "EFFACER"]
        );
        // rien de tout ça : pas de corbeille, instance normale, petit lot.
        assert_eq!(mots_exiges(30 * go, true, true, false), vec!["SUPPRIMER"]);
        // instance élevée, SOUS le palier, corbeille disponible : le mot seul,
        // sans le palier. Cest le cas de tous les jours sur le runner de la CI :
        // V: fait 511 Mio, donc aucun palier, et le jeton est élevé.
        // Cest exactement ce que sept sondes affirmaient contraire le 27/09/2026.
        assert_eq!(mots_exiges(0, true, true, true), vec!["EFFACER"]);
    }

    /// La confirmation doit contenir TOUS les mots, dans l'ordre, EXACTEMENT.
    ///
    /// Le test le plus important est le dernier : `EFFACER ` avec une espace
    /// final doit être refusé. C'est la règle que `sonde-suppression.mjs`
    /// imposait déjà pour un mot seul, et elle tient pour une liste comme pour
    /// un mot. Une confirmation acceptée « à peu près » n'est plus une
    /// confirmation : c'est une lecture d'intention, et l'intention se devine.
    #[test]
    fn la_confirmation_exige_tous_les_mots_exactement() {
        let mots = ["SUPPRIMER", "EFFACER"];
        assert!(confirmation_suffit("SUPPRIMER EFFACER", &mots));
        // dans le désordre : refusé, l'ordre des motifs est l'ordre des mots.
        assert!(!confirmation_suffit("EFFACER SUPPRIMER", &mots));
        // casse et espaces : ce que la sonde imposait déjà, et qui tient.
        assert!(!confirmation_suffit("supprimer effacer", &mots));
        assert!(!confirmation_suffit("SUPPRIMER EFFACER ", &mots));
        assert!(!confirmation_suffit(" SUPPRIMER EFFACER", &mots));
        // un seul des deux ne suffit pas — c'est tout l'intérêt de cumuler.
        assert!(!confirmation_suffit("SUPPRIMER", &mots));
        assert!(!confirmation_suffit("EFFACER", &mots));
        assert!(!confirmation_suffit("", &mots));
    }

    /// Un mot à deux mots ne se valide pas par un seul de ses morceaux.
    ///
    /// `SUPPRIMER TOUT` ne doit pas être satisfait par `SUPPRIMER` : sinon le
    /// palier le plus élevé se contenterait du mot du palier inférieur, et
    /// l'escalade n'escaladerait rien.
    #[test]
    fn un_mot_a_deux_mots_ne_se_valide_pas_avec_un_seul() {
        assert!(confirmation_suffit("SUPPRIMER TOUT", &["SUPPRIMER TOUT"]));
        assert!(!confirmation_suffit("SUPPRIMER", &["SUPPRIMER TOUT"]));
        assert!(!confirmation_suffit("TOUT", &["SUPPRIMER TOUT"]));
    }

    /// Aucun mot exigé, aucune saisie : la règle du dessous est aussi
    /// importante que celle du dessus.
    #[test]
    fn sans_mot_exige_la_saisie_est_indifférente() {
        assert!(confirmation_suffit("", &[]));
        assert!(confirmation_suffit("n'importe quoi", &[]));
    }

    #[test]
    fn le_journal_conserve_les_champs_de_2026() {
        // Les ~2 500 lignes déjà écrites doivent rester lisibles : les cinq
        // premiers champs ne changent pas de place ni de sens. C'est ce qui
        // permet de relire l'incident avec le même parseur que le journal d'aujourd'hui.
        let l = ligne("corbeille", "V:\\x\\a.txt", "V:\\x\\a.txt");
        let champs: Vec<&str> = l.split('\t').collect();
        assert_eq!(champs[0], "1700000000000");
        assert_eq!(champs[1], "corbeille");
        assert_eq!(champs[2], "25");
        assert_eq!(champs[3], "1");
        assert_eq!(champs[4], "V:\\x\\a.txt");
    }

    #[test]
    fn le_journal_nomme_le_lot_le_prevu_et_le_realise() {
        // C'est l'objet de R6 : un écart entre le chemin prévu et le chemin
        // réalisé doit être lisible dans le journal, sans le code.
        let l = ligne("definitif", "V:\\x\\prevu.txt", "V:\\autre\\realise.txt");
        assert!(l.contains("lot=1700000000000-0123456789abcdef"), "{l}");
        assert!(l.contains("gen=7"), "{l}");
        assert!(l.contains("sel=12"), "{l}");
        assert!(l.contains("prevu=V:\\x\\prevu.txt"), "{l}");
        assert!(l.contains("V:\\autre\\realise.txt"), "{l}");
        // Et l'écart est bien visible : deux chemins distincts, deux colonnes.
        assert!(l.contains("\tprevu=V:\\x\\prevu.txt\t"), "{l}");
    }

    #[test]
    fn le_journal_donne_a_savoir_quelle_issue_a_eu_lieu() {
        // Les trois issues d'avant, plus le refus — qui n'était jamais écrit,
        // et laissait le même vide que l'incident.
        for issue in ["corbeille", "corbeille-refusee", "definitif", "refuse"] {
            let l = ligne(issue, "V:\\x\\a.txt", "V:\\x\\a.txt");
            assert_eq!(l.split('\t').nth(1), Some(issue));
        }
    }

    /// Un lancement sans console n'ouvre PAS de navigateur. C'est le défaut
    /// mesuré le 28/09/2026 : tout lancement scripté — un agent, une sonde, un
    /// script — ouvrait une fenêtre sur le bureau de celui qui l'avait lancé, et
    /// `--no-browser` ne s'invente pas. Ouvrir une fenêtre qu'on n'a pas
    /// demandé est une intrusion, quelle que soit l'innocence du code.
    #[test]
    fn un_lancement_sans_console_n_ouvre_pas_de_navigateur() {
        let vide: Vec<String> = Vec::new();
        assert!(!decider_le_navigateur(&vide, false));
        assert!(decider_le_navigateur(&vide, true));
    }

    /// Les deux drapeaux PRIMENT sur le signal, et dans les deux sens. Un
    /// comportement qu'on ne peut ni forcer ni interdire n'est pas une règle.
    #[test]
    fn les_draceaux_priment_sur_le_signal() {
        for terminal in [true, false] {
            assert!(decider_le_navigateur(&["--browser".into()], terminal));
            assert!(!decider_le_navigateur(&["--no-browser".into()], terminal));
        }
    }

    /// Quand les deux drapeaux sont présents, c'est `--no-browser` qui gagne.
    /// C'est l'interdit qui l'emporte sur l'autorisé : une double intention doit
    /// se résoudre vers la retenue, jamais vers l'intrusion.
    #[test]
    fn l_interdit_lemporte_sur_l_autorise() {
        assert!(!decider_le_navigateur(
            &["--browser".into(), "--no-browser".into()],
            true
        ));
    }

    /// Un drapeau QUI RESSEMBLE n'est pas un drapeau. `--no-browser=1` ou
    /// `--browser-launch` ne doivent pas être lus comme `--no-browser` : sinon
    /// une faute de frappe ouvre quand même une fenêtre.
    #[test]
    fn seul_le_drapeau_exact_compte() {
        // Avec une console, un "--no-browser=1" n'interdit rien : sinon une
        // faute de frappe se lirait comme une interdiction.
        assert!(decider_le_navigateur(&["--no-browser=1".into()], true));
        assert!(decider_le_navigateur(&["--no-browser ".into()], true));
        // Et sans console, un "--browser-launch" n'autorise rien.
        assert!(!decider_le_navigateur(&["--browser-launch".into()], false));
        assert!(!decider_le_navigateur(&["browser".into()], false));
    }
}

/// Une ligne du journal : ce qui a été demandé, et ce qui a été fait.
///
/// Le journal du 26/09/2026 disait l'issue, la taille et le chemin traité —
/// rien d'autre. C'est ce qui a rendu l'incident impossible à qualifier : rien ne
/// reliait une suppression à une demande, donc rien ne permettait de dire si le
/// chemin effacé était celui qu'on avait coché. 168 chemins ont été lus dans ce
/// fichier, et aucun ne portait de quoi le rattacher à une sélection.
///
/// Une ligne porte donc les DEUX chemins — celui **prévu** à l'aperçu et celui
/// **réalisé** — plus le lot et le sélecteur d'origine. Ils sont égaux par
/// construction aujourd'hui : `execute` ne résout plus rien, il ne supprime que
/// les chemins figés par l'aperçu. C'est PRÉCISÉMENT pour que cette égalité se
/// vérifie à la lecture, et non par relecture du code, que les deux colonnes
/// existent. Une ligne où ils diffèrent serait la preuve directe d'un écart.
///
/// Les cinq premiers champs sont ceux d'avant, à l'identique : les ~2 500 lignes
/// déjà écrites restent lisibles, et une ligne de 2026 se reconnaît au premier
/// coup d'œil dans une ligne de 2027. La suite est étiquetée (`lot=`, `gen=`,
/// `sel=`, `prevu=`, `motif=`) pour que la ligne se lise sans le format.
struct LigneJournal {
    lot: String,
    gen: u64,
    sel: u32,
    prevu: String,
    realise: String,
    issue: String,
    taille: u64,
    count: u64,
    motif: String,
}

impl LigneJournal {
    fn ligne(&self, ms: i64) -> String {
        format!(
            "{ms}\t{}\t{}\t{}\t{}\tlot={}\tgen={}\tsel={}\tprevu={}\tmotif={}",
            self.issue,
            self.taille,
            self.count,
            self.realise,
            self.lot,
            self.gen,
            self.sel,
            self.prevu,
            self.motif,
        )
    }
}

fn journal(app: &Arc<App>, lignes: &[LigneJournal]) {
    use std::io::Write;
    let p = app.cache_dir.join("suppressions.log");
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(p)
    {
        // Un seul `now_ms` par lot : plusieurs lignes portant la même
        // milliseconde se regroupent déjà par `lot=`, et un horodatage par ligne
        // donnerait l'illusion d'une chronologie à l'intérieur du lot alors
        // qu'elle est celle de l'écriture.
        let ms = now_ms();
        for l in lignes {
            let _ = writeln!(f, "{}", l.ligne(ms));
        }
    }
}

fn search(app: &Arc<App>, q: &Q) -> Result<Resp, (&'static str, String)> {
    let letter = q
        .get("drive")
        .and_then(|s| s.chars().next())
        .ok_or(("400 Bad Request", "drive manquant".into()))?
        .to_ascii_uppercase();
    let term = q.get("q").cloned().unwrap_or_default();
    let limit: usize = q
        .get("limit")
        .and_then(|s| s.parse().ok())
        .unwrap_or(500)
        .min(20_000);
    let snap = {
        let d = app.drives.lock().unwrap();
        d.get(&letter)
            .and_then(|s| s.snap.clone())
            .ok_or(("409 Conflict", "volume pas encore analysé".into()))?
    };

    // La garde de MEMoire, distincte de la borne d'AFFICHAGE.
    //
    // Elle vaut quatre fois la borne demandée, et jamais moins de 4 000 : une
    // borne de 1 ne doit pas faire remonter 4 000 lignes dans le tri, mais une
    // borne de 20 000 doit pouvoir juger sur 20 000. C'est le compromis entre
    // deux coûts qui ne s'ajoutent pas — le balayage est déjà fait pour
    // compter, seules les allocations en plus sont évitées.
    let garde = limit.saturating_mul(4).max(4_000);

    let needle = term.to_lowercase();
    let r = snap.search(&needle, garde);

    // On trie AVANT de plafonner, et sur l'union déjà rendue.
    //
    // L'ordre du parcours ne vaut rien comme critère : il suit l'index, et
    // l'index ne connaît ni la taille ni le nom. Plafonner d'abord revenait à
    // dire « les 800 premiers encountered », puis à les présenter par taille
    // décroissante — l'utilisateur lisait une sélection par taille, et ce
    // n'en était pas une.
    let mut lignes = r.lignes;
    let tri = Tri::depuis(q.get("sort").map(|s| s.as_str()).unwrap_or("size"));
    let decroissant = q.get("order").map(|s| s != "asc").unwrap_or(true);
    trier_lignes(&mut lignes, tri, decroissant);

    // Le plafond s'applique ICI, après le tri. `truncated` devient un fait :
    // on a rendu moins qu'on n'en a trouvé, ou on a tout rendu.
    // Le drapeau se calcule APRES la coupe. Avant, `lignes` portait encore
    // le jeu entier : `total > lignes.len()` donnait `6 > 6`, et le serveur
    // annonait « rien n a ete coupe » en en coupant cinq. Mesure par la
    // sonde `recherche` a la borne 5 sur un total de 6.
    lignes.truncate(limit);
    let tronque = r.total > lignes.len();

    Ok(Resp::Json(
        serde_json::to_string(&serde_json::json!({
            "rows": lignes,
            // `total` est le compte REEL. L'ancien `rows.len() >= limit`
            // était une supposition, fausse dans les deux sens : il
            // annonçait « tronqué » quand la page était complète, et
            // ne pouvait rien dire quand le parcours s'était arrêté avant.
            "total": r.total,
            "truncated": tronque,
            // `exact: false` signifie « au moins total » : la garde de
            // mémoire a été atteinte, la liste est un échantillon trié.
            // Un plancher honnête, jamais un silence.
            "exact": r.exact,
            "garde": garde,
            "tri": q.get("sort").cloned().unwrap_or_else(|| "size".into()),
            "order": if decroissant { "desc" } else { "asc" },
            "gen": snap.gen,
        }))
        .unwrap(),
    ))
}

#[derive(serde::Deserialize)]
struct RevealReq {
    drive: String,
    path: String,
}

/// Montre où se trouve un dossier illisible, sans essayer de l'ouvrir.
///
/// `/select,` ouvre le dossier **parent** et y surligne l'élément : c'est le
/// seul comportement possible, puisque le dossier visé n'est pas lisible — c'est
/// précisément pourquoi il figure dans cette liste.
///
/// Le chemin doit venir de NOTRE liste. Sans ce contrôle, la route ouvrirait
/// n'importe quel chemin de la machine sur demande d'une page, et le navigateur
/// est accessible à tout ce qui sait parler HTTP sur cette machine.
fn reveal(app: &Arc<App>, body: &[u8]) -> Result<Resp, (&'static str, String)> {
    let req: RevealReq = serde_json::from_slice(body)
        .map_err(|e| ("400 Bad Request", format!("corps illisible : {e}")))?;
    let letter = req
        .drive
        .chars()
        .next()
        .ok_or(("400 Bad Request", "drive manquant".into()))?
        .to_ascii_uppercase();
    let snap = {
        let d = app.drives.lock().unwrap();
        d.get(&letter)
            .and_then(|s| s.snap.clone())
            .ok_or(("409 Conflict", "volume pas encore analysé".into()))?
    };
    if !snap.unreadable.iter().any(|u| *u.path == req.path) {
        return Err((
            "400 Bad Request",
            "chemin hors de la liste des illisibles".into(),
        ));
    }
    // Guillemets : sans eux, une virgule dans le chemin couperait l'argument.
    let _ = Command::new("explorer")
        .arg(format!("/select,\"{}\"", req.path))
        .spawn();
    Ok(Resp::Json("{\"ok\":true}".to_string()))
}

#[derive(serde::Deserialize)]
struct QuitReq {
    #[serde(default)]
    force: bool,
}

/// Arrête le serveur proprement.
///
/// « Proprement » veut dire ici : on ne coupe pas un parcours en plein milieu de
/// l'écriture de son cache. Un `exit()` sur un thread qui écrit un instantané
/// laisserait un fichier tronqué, que le prochain démarrage tenterait de lire.
/// On demande donc l'annulation, puis on attend que le parcours ait rendu la main.
///
/// La sortie du processus est différée dans un thread : `handle` écrit la réponse
/// HTTP *après* le retour de cette fonction. Sortir ici couperait la connexion, et
/// le navigateur afficherait une erreur réseau là où il n'y a qu'un arrêt normal.
fn quit(app: &Arc<App>, body: &[u8]) -> Result<Resp, (&'static str, String)> {
    let req: QuitReq = if body.is_empty() {
        QuitReq { force: false }
    } else {
        serde_json::from_slice(body)
            .map_err(|e| ("400 Bad Request", format!("corps illisible : {e}")))?
    };

    // Premier appel sans `force` alors qu'une analyse tourne : on ne refuse pas
    // sèchement, on rend de quoi demander confirmation — ce qui serait perdu,
    // chiffré, plutôt qu'un « vraiment ? » qui ne dit rien.
    if let Some(letter) = *app.scanning.lock().unwrap() {
        if !req.force {
            let (dirs, files) = {
                let d = app.drives.lock().unwrap();
                d.get(&letter)
                    .map(|s| {
                        (
                            s.prog.dirs.load(Ordering::Relaxed),
                            s.prog.files.load(Ordering::Relaxed),
                        )
                    })
                    .unwrap_or((0, 0))
            };
            return Err((
                "409 Conflict",
                format!("{letter}: analyse en cours ({dirs} dossiers, {files} fichiers parcourus)"),
            ));
        }
    }

    // À partir d'ici l'arrêt est acquis. Le drapeau sert deux fois : il empêche
    // un second `/api/quit` de refaire le travail, et `pump` s'en sert pour ne pas
    // enchaîner sur le volume suivant.
    app.stopping.store(true, Ordering::Relaxed);

    // Barrière : on prend le verrou que `pump` tient pendant qu'il choisit un
    // volume ET remplace sa progression. Sans elle, un `pump` déjà engagé
    // installerait une progression neuve APRÈS la passe d'annulation ci-dessous,
    // et le parcours ainsi lancé ne serait jamais annulé. Ordre de verrouillage
    // respecté partout : `scanning` puis `queue` puis `drives`.
    let busy = app.scanning.lock().unwrap();
    // La file n'a rien à préserver : ces volumes n'ont pas commencé, il n'y a ni
    // cache à écrire ni progression à perdre.
    app.queue.lock().unwrap().clear();
    // On demande l'annulation à TOUS les volumes, file comprise.
    {
        let d = app.drives.lock().unwrap();
        for s in d.values() {
            s.prog.cancel.store(true, Ordering::Relaxed);
        }
    }
    drop(busy);

    // On attend que le parcours rende la main. Le contrôle d'annulation est en
    // tête de chaque dossier, donc l'attente se compte en millisecondes ; la borne
    // est là pour un disque qui ne répond plus, qui ne doit pas rendre
    // l'application impossible à fermer.
    let limite = std::time::Instant::now() + Duration::from_secs(3);
    while app.scanning.lock().unwrap().is_some() {
        if std::time::Instant::now() > limite {
            eprintln!("arrêt : le parcours n'a pas rendu la main en 3 s — on ferme quand même");
            break;
        }
        thread::sleep(Duration::from_millis(20));
    }
    // Un parcours interrompu purge lui-même ce drapeau ; on le fait aussi au cas
    // où la boucle ci-dessus a expiré, pour ne rien laisser marqué « en cours ».
    *app.scanning.lock().unwrap() = None;

    println!("Arrêt demandé depuis l'interface.");
    thread::spawn(|| {
        thread::sleep(Duration::from_millis(250));
        std::process::exit(0);
    });
    Ok(Resp::Json("{\"ok\":true}".to_string()))
}

#[derive(serde::Serialize)]
struct UnreadableJson {
    path: String,
    droits: bool,
}

/// Dossiers dont le contenu n'a pas pu être lu, donc dont le sous-arbre entier
/// manque au total affiché.
///
/// Route séparée plutôt qu'un champ de `/api/state` : l'état est interrogé en
/// boucle pendant une analyse, et y charrier jusqu'à 500 chemins à chaque tour
/// serait du gaspillage pour une information qu'on ne consulte qu'à la demande.
fn unreadable(app: &Arc<App>, q: &Q) -> Result<Resp, (&'static str, String)> {
    let letter = q
        .get("drive")
        .and_then(|s| s.chars().next())
        .ok_or(("400 Bad Request", "drive manquant".into()))?
        .to_ascii_uppercase();
    let snap = {
        let d = app.drives.lock().unwrap();
        d.get(&letter)
            .and_then(|s| s.snap.clone())
            .ok_or(("409 Conflict", "volume pas encore analysé".into()))?
    };
    let items: Vec<UnreadableJson> = snap
        .unreadable
        .iter()
        .map(|u| UnreadableJson {
            path: u.path.to_string(),
            droits: u.droits,
        })
        .collect();
    let tronque = (items.len() as u64) < snap.unreadable_total;
    Ok(Resp::Json(
        serde_json::to_string(&serde_json::json!({
            "items": items,
            "total": snap.unreadable_total,
            "droits": snap.unreadable_droits,
            "skipped": snap.skipped,
            "tronque": tronque,
        }))
        .unwrap(),
    ))
}
