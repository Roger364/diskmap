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
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::thread;

const UI: &str = include_str!("../ui/index.html");
const DEFAULT_PORT: u16 = 8756;

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

struct App {
    drives: Mutex<HashMap<char, DriveState>>,
    /// Volume en cours d'analyse (un seul à la fois : on évite de faire ramener
    /// plusieurs disques en concurrence sur le même contrôleur).
    scanning: Mutex<Option<char>>,
    queue: Mutex<Vec<char>>,
    cache_dir: PathBuf,
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
    errors: u64,
    dirs: u64,
    files: u64,
}

#[derive(serde::Serialize)]
struct StateJson {
    drives: Vec<DriveJson>,
    scanning: Option<String>,
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
    println!("erreurs        : {}", snap.errors);
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
        cache_dir: cache_dir(),
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
    println!("Ctrl+C pour arrêter.");
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
        let snap = scan::scan(&verbatim, display, prog);
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
    // En-têtes : on les consomme (Content-Length nous suffirait, on n'en a pas besoin).
    loop {
        let mut h = String::new();
        if reader.read_line(&mut h)? == 0 {
            break;
        }
        if h.trim().is_empty() {
            break;
        }
    }

    let (path, query) = match target.split_once('?') {
        Some((p, q)) => (p.to_string(), parse_query(q)),
        None => (target, HashMap::new()),
    };

    let resp = route(app, &method, &path, &query);
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

fn route(app: &Arc<App>, method: &str, path: &str, q: &Q) -> Result<Resp, (&'static str, String)> {
    match (method, path) {
        ("GET", "/") | ("GET", "/index.html") => Ok(Resp::Html(UI.to_string())),

        ("GET", "/api/state") => Ok(Resp::Json(serde_json::to_string(&state_json(app)).unwrap())),

        ("POST", p) if p.starts_with("/api/scan/") => {
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
            errors: snap.map(|x| x.errors).unwrap_or(0),
            dirs: s.prog.dirs.load(Ordering::Relaxed),
            files: s.prog.files.load(Ordering::Relaxed),
        });
    }
    StateJson {
        drives: out,
        scanning: app.scanning.lock().unwrap().map(|c| c.to_string()),
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
        })
        .unwrap(),
    ))
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
        serde_json::to_string(&serde_json::json!({ "rows": rows, "truncated": truncated })).unwrap(),
    ))
}
