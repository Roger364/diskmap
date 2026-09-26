// diskmap — explorateur d'espace disque.
//
// Un petit serveur HTTP local (pas de dépendance web : on sert l'UI embarquée et
// quelques routes JSON) + un scan parallèle par volume, avec cache binaire sur disque
// pour que les lancements suivants soient quasi instantanés.

mod scan;
mod win32;

use scan::{Progress, Row, Snapshot};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, SystemTime};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

const UI: &str = include_str!("../ui/index.html");
const DEFAULT_PORT: u16 = 8756;

/// Taille maximale d'un corps de requête accepté.
///
/// Le plus gros corps légitime est une liste d'éléments à supprimer :
/// l'interface en envoie un par ligne sélectionnée, une trentaine d'octets
/// chacun. 4 Mio laissent donc passer plus de cent mille éléments — bien
/// au-delà de ce que la table sait afficher.
const CORPS_MAX: usize = 4 * 1024 * 1024;

#[derive(Clone, Copy, PartialEq, serde::Serialize)]
enum Status {
    #[serde(rename = "empty")]
    Empty,
    #[serde(rename = "scanning")]
    Scanning,
    #[serde(rename = "ready")]
    Ready,
    #[serde(rename = "error")]
    Error,
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
    let threads = thread::available_parallelism().map(|n| n.get()).unwrap_or(8);
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
            println!("  (liste plafonnée : {gardes} chemins sur {})", snap.unreadable_total);
        }
        for u in &snap.unreadable {
            println!("  [{}] {}", if u.droits { "droits" } else { "autre " }, u.path);
        }
    }
    println!("parcours seul  : {} ms", snap.elapsed_ms);
    println!("total agregé   : {:?}", wall);
    println!("taille racine  : {:.1} Go", snap.size[0] as f64 / 1073741824.0);
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
    if args.get(1).map(|s| s.as_str()) == Some("bench") {
        return bench(args.get(2).and_then(|s| s.chars().next()));
    }

    let port: u16 = args
        .iter()
        .position(|a| a == "--port")
        .and_then(|i| args.get(i + 1))
        .and_then(|v| v.parse().ok())
        .unwrap_or(DEFAULT_PORT);

    let open_browser = !args.iter().any(|a| a == "--no-browser");

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
        let (snap, status) = match Snapshot::load(&cache) {
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
    println!("Arrêt : le bouton dans l'interface, ou Ctrl+C ici.");
    if open_browser {
        open_in_browser(&url);
    }

    for stream in listener.incoming() {
        match stream {
            Ok(s) => {
                let app = app.clone();
                thread::spawn(move || {
                    if let Err(e) = handle(&app, s) {
                        eprintln!("connexion : {e}");
                    }
                });
            }
            Err(_) => {}
        }
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
            eprintln!("{letter}: parcours interrompu — cache inchangé, volume non marqué comme analysé");
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
        if let Err(e) = snap.save(&cache) {
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

fn start_scan(app: &Arc<App>, letter: char) {
    // Ordre de verrouillage imposé partout : `scanning` puis `queue`.
    // L'inverse (queue -> scanning) risquerait l'interblocage avec `pump`.
    if *app.scanning.lock().unwrap() == Some(letter) {
        return;
    }
    {
        let mut q = app.queue.lock().unwrap();
        if !q.contains(&letter) {
            q.push(letter);
        }
    }
    pump(app);
}

// ---------------------------- HTTP ----------------------------

fn handle(app: &Arc<App>, mut stream: TcpStream) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut line = String::new();
    if reader.read_line(&mut line)? == 0 {
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
        if reader.read_line(&mut h)? == 0 {
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
    nom.eq_ignore_ascii_case("127.0.0.1")
        || nom.eq_ignore_ascii_case("localhost")
        || nom == "::1"
}

/// Le port est-il bien un port ? Exiger des chiffres ferme la classe de leurres
/// du type `127.0.0.1:8800@evil.test`, où tout ce qui suit le premier
/// deux-points serait sinon pris pour un port — et le nom retenu, « 127.0.0.1 »,
/// se ferait accepter.
fn port_ok(p: &str) -> bool {
    p.is_empty() || p.bytes().all(|b| b.is_ascii_digit())
}

fn route(app: &Arc<App>, method: &str, path: &str, q: &Q, body: &[u8], action: &str, host: &str) -> Result<Resp, (&'static str, String)> {
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
            let letter = letter.ok_or(("400 Bad Request", "lettre manquante".into()))?
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
            let letter = q.get("drive").and_then(|s| s.chars().next())
                .ok_or(("400 Bad Request", "drive manquant".into()))?
                .to_ascii_uppercase();
            let id: u32 = q.get("id").and_then(|s| s.parse().ok())
                .ok_or(("400 Bad Request", "id invalide".into()))?;
            let kind = q.get("kind").cloned().unwrap_or_else(|| "dir".into());
            let snap = {
                let d = app.drives.lock().unwrap();
                d.get(&letter).and_then(|s| s.snap.clone())
                    .ok_or(("409 Conflict", "volume pas encore analysé".into()))?
            };
            let p = if kind == "file" {
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
            let arg = if kind == "file" { format!("/select,{ps}") } else { ps };
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
    let letter = q.get("drive").and_then(|s| s.chars().next())
        .ok_or(("400 Bad Request", "drive manquant".into()))?
        .to_ascii_uppercase();
    let id: u32 = q.get("id").and_then(|s| s.parse().ok()).unwrap_or(0);
    let sort = q.get("sort").cloned().unwrap_or_else(|| "size".into());
    let order = q.get("order").cloned().unwrap_or_else(|| "desc".into());
    let limit: usize = q.get("limit").and_then(|s| s.parse().ok()).unwrap_or(3000).min(50_000);
    let offset: usize = q.get("offset").and_then(|s| s.parse().ok()).unwrap_or(0);

    let snap = {
        let d = app.drives.lock().unwrap();
        d.get(&letter).and_then(|s| s.snap.clone())
            .ok_or(("409 Conflict", "volume pas encore analysé".into()))?
    };
    if (id as usize) >= snap.n_dirs() {
        return Err(("400 Bad Request", "dossier hors bornes".into()));
    }

    let mut rows: Vec<Row> = Vec::new();
    for c in snap.child_dirs(id) {
        rows.push(Row {
            id: c,
            name: snap.dirs[c as usize].name.to_string(),
            size: snap.size[c as usize],
            count: snap.count[c as usize],
            mtime: snap.mtime[c as usize],
            is_dir: true,
            path: String::new(),
        });
    }
    for c in snap.child_files(id) {
        rows.push(Row {
            id: c,
            name: snap.files[c as usize].name.to_string(),
            size: snap.files[c as usize].size,
            count: 1,
            mtime: snap.files[c as usize].mtime,
            is_dir: false,
            path: String::new(),
        });
    }

    let total = rows.len();
    let asc = order == "asc";
    match sort.as_str() {
        "name" => rows.sort_by(|a, b| {
            let k = a.name.to_lowercase().cmp(&b.name.to_lowercase());
            if asc { k } else { k.reverse() }
        }),
        "mtime" => rows.sort_by(|a, b| if asc { a.mtime.cmp(&b.mtime) } else { b.mtime.cmp(&a.mtime) }),
        "count" => rows.sort_by(|a, b| if asc { a.count.cmp(&b.count) } else { b.count.cmp(&a.count) }),
        _ => rows.sort_by(|a, b| if asc { a.size.cmp(&b.size) } else { b.size.cmp(&a.size) }),
    }

    let parent_size = snap.size[id as usize];
    let mut path: Vec<Crumb> = Vec::new();
    let mut cur = id as usize;
    loop {
        path.push(Crumb { name: snap.dirs[cur].name.to_string(), id: cur as u32 });
        if cur == 0 { break; }
        let p = snap.dirs[cur].parent as usize;
        if p >= cur { break; }
        cur = p;
    }
    path.reverse();

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

#[derive(serde::Deserialize, Clone)]
struct DeleteItem {
    id: u32,
    is_dir: bool,
}

#[derive(serde::Deserialize)]
struct DeleteReq {
    drive: String,
    /// Utilisé uniquement par la simulation. À l'exécution, la liste vient du
    /// jeton et jamais de la requête : sinon un appelant pourrait présenter un
    /// jeton valide obtenu sur une liste, et supprimer autre chose que ce qui a
    /// été montré.
    #[serde(default)]
    items: Vec<DeleteItem>,
    mode: String,
    token: Option<String>,
    confirm: Option<String>,
    /// Génération de l'instantané d'où viennent les `items`. Les identifiants
    /// sont des positions : re-résoudre une position contre un instantané plus
    /// récent revient à viser un autre fichier. Mesuré — voir `Snapshot::gen`.
    #[serde(default)]
    gen: Option<u64>,
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
    results: Vec<PreviewItem>,
    rescan: bool,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn resolve(snap: &Snapshot, it: &DeleteItem) -> Option<PathBuf> {
    if it.is_dir {
        if (it.id as usize) < snap.n_dirs() {
            Some(snap.dir_path(it.id))
        } else {
            None
        }
    } else if (it.id as usize) < snap.n_files() {
        Some(snap.file_path(it.id))
    } else {
        None
    }
}

fn index_size(snap: &Snapshot, it: &DeleteItem) -> (u64, u64) {
    if it.is_dir {
        let i = it.id as usize;
        if i < snap.n_dirs() {
            (snap.size[i], snap.count[i])
        } else {
            (0, 0)
        }
    } else {
        snap.files
            .get(it.id as usize)
            .map(|f| (f.size, 1))
            .unwrap_or((0, 0))
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
                    "génération de l’instantané absente : recharge la liste avant de supprimer".into(),
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

fn dry(app: &Arc<App>, letter: char, snap: &Snapshot, items: Vec<DeleteItem>) -> Result<Resp, (&'static str, String)> {
    let mut out: Vec<PreviewItem> = Vec::new();
    let mut total = 0u64;
    let mut deletable = 0usize;
    let mut blocked = 0usize;

    // Ce qu'on retient pour l'exécution : le chemin résolu, figé ici. C'est la
    // seule liste que `execute` consultera.
    let mut montres: Vec<Montre> = Vec::new();

    for it in &items {
        // Un identifiant irrésoluble ne doit pas DISPARAÎTRE. Le client en
        // demande N et n'en verrait revenir N-1, sans rien pour le lui dire :
        // c'était le cas, `continue` suffisait à effacer la trace. Mesuré le
        // 26/09/2026 — un aperçu demandé pour deux éléments dont un hors bornes
        // en renvoyait UN, et `deletable=1` n'en soufflait mot.
        let Some(path) = resolve(snap, it) else {
            blocked += 1;
            out.push(PreviewItem {
                path: format!("(élément {} absent de l’index actuel)", it.id),
                size: 0,
                count: 0,
                is_dir: it.is_dir,
                exists: false,
                blocked: true,
                reason: "identifiant irrésoluble : l’index ne le connaît plus".into(),
            });
            continue;
        };
        let ps = path.to_string_lossy().into_owned();
        let (size, count) = index_size(snap, it);
        let reason = blocked_reason(&path);
        let exists = path.exists();
        let blocked_flag = reason.is_some() || !exists;
        if blocked_flag {
            blocked += 1;
        } else {
            deletable += 1;
            total += size;
            montres.push(Montre { path, is_dir: it.is_dir, size, count });
        }
        out.push(PreviewItem {
            path: ps,
            size,
            count,
            is_dir: it.is_dir,
            exists,
            blocked: blocked_flag,
            reason: reason.unwrap_or(if exists { "" } else { "introuvable sur le disque" }).to_string(),
        });
    }

    // L'horodatage sert à dater et à distinguer deux jetons ; il n'a jamais eu à
    // cacher quoi que ce soit, puisqu'il est écrit en clair juste à côté. C'est
    // l'aléa qui doit être imprévisible — et lui seul.
    let token = format!("{}-{:016x}", now_ms(), win32::alea_u64());
    {
        let mut p = app.pending.lock().unwrap();
        p.insert(token.clone(), PendingDel { drive: letter, items: montres, at_ms: now_ms() });
    }

    Ok(Resp::Json(
        serde_json::to_string(&DeletePreview {
            token,
            items: out,
            total_size: total,
            deletable,
            blocked,
            corbeille: win32::corbeille_disponible(letter),
        })
        .unwrap(),
    ))
}

fn execute(app: &Arc<App>, letter: char, req: DeleteReq, to_trash: bool) -> Result<Resp, (&'static str, String)> {
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
    if !to_trash && req.confirm.clone().unwrap_or_default() != "EFFACER" {
        return Err(("400 Bad Request", "confirmation « EFFACER » absente".into()));
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
    let mut journal_lines: Vec<String> = Vec::new();
    // Demandés en corbeille, mais la corbeille ne les a pas pris : détruits.
    let mut irreversible = 0usize;
    // Sert de plancher aux fiches `$I` : une fiche plus ancienne décrit une
    // suppression ANTÉRIEURE du même chemin, et ferait passer une destruction
    // pour un succès. `now_ms` est signé, les dates de fiches ne le sont pas.
    let debut_ms = now_ms().max(0) as u64;
    // Éléments supprimés dont la réversibilité reste à juger : (index dans
    // `results`, chemin, taille, compte). On les juge après la boucle, et non
    // dedans — voir plus bas.
    let mut a_juger: Vec<(usize, String, u64, u64)> = Vec::new();

    // On ne résout PLUS les identifiants ici : `pending.items` porte les chemins
    // résolus au moment de l'aperçu, et c'est la seule chose qu'on s'autorise à
    // supprimer. Résoudre à nouveau contre l'instantané courant revenait à faire
    // confiance à un index qui a pu être remplacé depuis (voir `Montre`).
    for m in &pending.items {
        let ps = m.path.to_string_lossy().into_owned();
        let size = m.size;
        let count = m.count;
        let reason = blocked_reason(&m.path);
        if let Some(r) = reason {
            failed += 1;
            results.push(PreviewItem { path: ps, size, count, is_dir: m.is_dir, exists: true, blocked: true, reason: r.to_string() });
            continue;
        }
        if !m.path.exists() {
            failed += 1;
            results.push(PreviewItem { path: ps, size, count, is_dir: m.is_dir, exists: false, blocked: true, reason: "introuvable sur le disque".into() });
            continue;
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
                a_juger.push((idx, ps, size, count));
            }
            Err(e) => {
                failed += 1;
                // `exists` doit dire la VÉRITÉ. Le figer à `true` faisait
                // affirmer que le fichier était toujours là alors qu'il avait
                // disparu — et c'est ainsi qu'une suppression réussie a pu
                // passer pour un échec sans que rien ne le contredise.
                let encore = m.path.exists();
                results.push(PreviewItem { path: ps, size, count, is_dir: m.is_dir, exists: encore, blocked: true, reason: e });
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
        let corbeille = if to_trash { Some(win32::Corbeille::lire(letter, debut_ms)) } else { None };
        for (idx, ps, size, count) in &a_juger {
            let reversible = corbeille
                .as_ref()
                .map(|c| c.contient(ps, debut_ms))
                .unwrap_or(false);
            if to_trash && !reversible {
                irreversible += 1;
                results[*idx].reason =
                    "DÉTRUIT : la corbeille de ce volume ne l’a pas pris".into();
            }
            journal_lines.push(format!(
                "{}\t{}\t{}\t{}\t{}",
                now_ms(),
                match (to_trash, reversible) {
                    (true, true) => "corbeille",
                    (true, false) => "corbeille-refusee",
                    _ => "definitif",
                },
                size,
                count,
                ps
            ));
        }
    }

    if !journal_lines.is_empty() {
        journal(app, &journal_lines);
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
        serde_json::to_string(&DeleteOutcome { done, failed, freed, to_trash: reversible, irreversible, results, rescan }).unwrap(),
    ))
}

fn journal(app: &Arc<App>, lines: &[String]) {
    use std::io::Write;
    let p = app.cache_dir.join("suppressions.log");
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(p) {
        for l in lines {
            let _ = writeln!(f, "{l}");
        }
    }
}

fn search(app: &Arc<App>, q: &Q) -> Result<Resp, (&'static str, String)> {
    let letter = q.get("drive").and_then(|s| s.chars().next())
        .ok_or(("400 Bad Request", "drive manquant".into()))?
        .to_ascii_uppercase();
    let term = q.get("q").cloned().unwrap_or_default();
    let limit: usize = q.get("limit").and_then(|s| s.parse().ok()).unwrap_or(500).min(20_000);
    let snap = {
        let d = app.drives.lock().unwrap();
        d.get(&letter).and_then(|s| s.snap.clone())
            .ok_or(("409 Conflict", "volume pas encore analysé".into()))?
    };
    let needle = term.to_lowercase();
    let mut rows = snap.search(&needle, limit);
    rows.sort_by(|a, b| b.size.cmp(&a.size));
    let truncated = rows.len() >= limit;
    Ok(Resp::Json(
        serde_json::to_string(&serde_json::json!({ "rows": rows, "truncated": truncated, "gen": snap.gen })).unwrap(),
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
    if !snap.unreadable.iter().any(|u| &*u.path == req.path) {
        return Err(("400 Bad Request", "chemin hors de la liste des illisibles".into()));
    }
    // Guillemets : sans eux, une virgule dans le chemin couperait l'argument.
    let _ = Command::new("explorer").arg(format!("/select,\"{}\"", req.path)).spawn();
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
    let letter = q.get("drive").and_then(|s| s.chars().next())
        .ok_or(("400 Bad Request", "drive manquant".into()))?
        .to_ascii_uppercase();
    let snap = {
        let d = app.drives.lock().unwrap();
        d.get(&letter).and_then(|s| s.snap.clone())
            .ok_or(("409 Conflict", "volume pas encore analysé".into()))?
    };
    let items: Vec<UnreadableJson> = snap
        .unreadable
        .iter()
        .map(|u| UnreadableJson { path: u.path.to_string(), droits: u.droits })
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
