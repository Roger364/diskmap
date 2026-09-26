// Filet de sécurité du harnais de sondes.
//
// POURQUOI IL EXISTE, ET POURQUOI C'EST UN PROXY
// -------------------------------------------------
// Le 26/09/2026, une sonde de coût a détruit 65 fichiers réels et en a envoyé
// 68 autres à la corbeille, dispersés sur tout le volume de travail. Elle ne
// s'était pas trompée de cible : elle avait envoyé des IDENTIFIANTS, et c'est
// le serveur qui les a résolus — contre un index réanalysé depuis, donc vers
// d'autres fichiers que les siens. La sonde faisait confiance à la
// composante même qu'elle était censée éprouver. C'est le sens de confiance
// qu'il faut inverser.
//
// Chaque sonde vérifiait ses propres chemins, au cas par cas. Une sonde qui
// oublie la vérification recommence l'incident : le filet doit être là où l'on
// n'oublie pas, donc dans le chef d'orchestre.
//
// Un proxy, et non un correctif de `fetch` : deux sondes (celle de CSRF et
// celle de l'interface) pilotent un vrai Chromium. Un patch de `fetch` ne les
// toucherait pas. Le proxy, lui, est sur le réseau, donc devant tout le monde.
//
// LA RÈGLE, ET CE QU'ELLE NE FAIT PAS
// ------------------------------------
// Une seule interception suffit : celle de l'EXÉCUTION. C'est là, et seulement
// là, qu'un fichier disparaît.
//
//   * un jeton dont l'aperçu contenait un chemin hors racine est REFUSÉ, et
//     jamais transmis. C'est l'incident, et c'est ce qui rend la run rouge ;
//   * un jeton inconnu est TRANSMIS. Le serveur le refusera de toute façon, et
//     les sondes ont le droit de vérifier qu'il le refuse : un filet qui
//     avalerait la réponse empêcherait d'éprouver la garde qu'il double.
//
// Un chemin que le serveur a lui-même marqué `blocked` ne compte pas comme un
// écart : il ne sera pas supprimé. Le filet ne s'arrête que sur ce qui
// disparaît vraiment — sinon il casserait les sondes qui vérifient que
// `C:\Windows` est refusé, et le doublon deviendrait une panne.
//
// Un `dry` n'est donc jamais refusé, même quand son aperçu sort de la racine :
// une sonde éprouve légitimement que `C:\Windows` est signalé bloqué, et
// n'exécute rien. Le filet consigne le jeton comme douteux, et attend.
//
// C'est aussi pourquoi le corps n'est lu que pour `/api/delete` : partout
// ailleurs la requête est RELAYÉE en flux. Bufferiser ici réintroduirait
// exactement le défaut que l'application vient de corriger — un
// `Content-Length: 999999999999` qui tue le processus avant toute route.
//
// Le filet est fermé par défaut : ce qu'il ne comprend pas, il le bloque.

import http from 'http';
import fs from 'fs';

/** Au-delà, on ne lit pas le corps : on refuse. Aligné sur `CORPS_MAX`. */
const CORPS_MAX = 4 * 1024 * 1024;

/** Normalise une comparaison de chemin Windows : pas de barre oblique finale. */
function normaliser(p) {
  return String(p).replace(/\//g, '\\').replace(/\\+$/, '');
}

/** La lettre de volume d'un chemin `X:\...`, en majuscules, ou ''. */
function lettre(p) {
  const m = normaliser(p).match(/^([A-Z]):\\/i);
  return m ? m[1].toUpperCase() : '';
}

/**
 * Le chemin est-il sous l'une des racines autorisées ?
 * Renvoie la racine qui l'a accepté, ou null.
 */
function sousRacine(cible, racines) {
  const c = normaliser(cible).toUpperCase();
  for (const r of racines) {
    const rn = normaliser(r).toUpperCase();
    // On exige le séparateur après la racine : `G:\_sondesX` ne passe pas
    // pour un enfant de `G:\_sondes`.
    if (c === rn || c.startsWith(rn + '\\')) return r;
  }
  return null;
}

/**
 * Démarre le proxy de garde.
 *
 * @param {object} opts
 * @param {string} opts.cible        adresse du vrai serveur, ex. `http://127.0.0.1:8801/`
 * @param {string[]} opts.racines    racines autorisées, chemins absolus
 * @param {string} [opts.journal]    fichier où consigner les suppressions autorisées
 * @returns {Promise<{url: string, port: number, incidents: Array, refus: number, arreter: Function}>}
 */
export function creerFilet({ cible, racines, journal }) {
  const cibleUrl = new URL(cible);
  const nomsRacines = racines.map((r) => normaliser(r).toUpperCase());
  // jeton -> { douteux: bool, chemins: string[] }
  const emis = new Map();
  const incidents = [];
  let refus = 0;
  let douteux = 0;

  function noter(message) {
    incidents.push(message);
    console.error(`  FILET  ${message}`);
  }

  function journaliser(mode, chemin) {
    if (!journal) return;
    try {
      fs.appendFileSync(journal, `${Date.now()}\tfilet\t${mode}\t${chemin}\n`);
    } catch { /* le journal est un bonus, jamais une condition */ }
  }

  /** Réponse locale du filet : rien n'est transmis au serveur. */
  function refuser(res, code, message) {
    refus += 1;
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(message),
      Connection: 'close',
    });
    res.end(message);
  }

  /**
   * Relie une requête en flux. Le corps n'est pas lu ici : c'est la seule
   * façon de ne pas réintroduire l'allocation non bornée.
   */
  function relierFlux(req, res, url, entetes) {
    const opts = {
      hostname: cibleUrl.hostname,
      port: cibleUrl.port,
      method: req.method,
      path: url.pathname + url.search,
      headers: entetes,
    };
    if (req.headers['content-length']) opts.headers['Content-Length'] = req.headers['content-length'];
    const vers = http.request(opts, (amont) => {
      res.writeHead(amont.statusCode, amont.headers);
      amont.pipe(res);
    });
    vers.on('error', (e) => {
      if (!res.headersSent) {
        const m = JSON.stringify({ erreur: `filet : serveur injoignable (${e.message})` });
        res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(m) });
        res.end(m);
      } else res.end();
    });
    req.pipe(vers);
  }

  /**
   * Relie une requête DONT LE CORPS A DÉJÀ ÉTÉ LU. `req` est consommé : le
   * repiper ne renverrait rien, d'où le « socket hang up » qu'on obtenait
   * simplement en réutilisant `relierFlux` ici.
   */
  function relierCorps(res, url, entetes, corps) {
    const opts = {
      hostname: cibleUrl.hostname,
      port: cibleUrl.port,
      method: 'POST',
      path: url.pathname + url.search,
      headers: { ...entetes, 'Content-Length': corps.length },
    };
    const vers = http.request(opts, (amont) => {
      res.writeHead(amont.statusCode, amont.headers);
      amont.pipe(res);
    });
    vers.on('error', (e) => {
      if (!res.headersSent) {
        const m = JSON.stringify({ erreur: `filet : serveur injoignable (${e.message})` });
        res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(m) });
        res.end(m);
      } else res.end();
    });
    if (corps.length) vers.write(corps);
    vers.end();
  }

  /** Exécute un `dry` en mémoire pour n'inspecter que sa réponse. */
  function interroger(corps, url, entetes) {
    return new Promise((resolve) => {
      const vers = http.request({
        hostname: cibleUrl.hostname,
        port: cibleUrl.port,
        method: 'POST',
        path: url.pathname + url.search,
        headers: { ...entetes, 'Content-Length': corps.length },
      }, (r) => {
        let t = '';
        r.setEncoding('utf8');
        r.on('data', (m) => { t += m; });
        r.on('end', () => resolve({
          statut: r.statusCode,
          texte: t,
          typeur: r.headers['content-type'] || 'application/json; charset=utf-8',
        }));
      });
      vers.on('error', (e) => resolve({
        statut: 502,
        texte: JSON.stringify({ erreur: e.message }),
        typeur: 'application/json; charset=utf-8',
      }));
      vers.write(corps);
      vers.end();
    });
  }

  function repondre(res, statut, texte, typeur) {
    res.writeHead(statut, {
      'Content-Type': typeur,
      'Content-Length': Buffer.byteLength(texte),
      Connection: 'close',
    });
    res.end(texte);
  }

  const serveur = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    // `Host` se RELAIE tel quel. Le retirer ferait que node le remplacerait par
    // celui de la cible, et la sonde qui éprouve la garde du nom n'enverrait
    // plus jamais de nom étranger au serveur : elle testerait le filet, pas la
    // garde. C'est exactement le défaut qu'un doublon ne doit pas introduire.
    const entetes = { ...req.headers };

    // Marque de présence. Une sonde qui éprouve le filet DOIT le voir avant
    // d'agir : jouée contre le serveur nu, elle supprimerait pour de vrai le
    // fichier de son scénario. Sans cette réponse, elle s'abstient.
    if (req.method === 'GET' && url.pathname === '/filet') {
      const m = JSON.stringify({ filet: true, racines: racines.length, incidents: incidents.length });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(m) });
      return res.end(m);
    }

    const estDelete = req.method === 'POST' && url.pathname === '/api/delete';
    if (!estDelete) return relierFlux(req, res, url, entetes);

    const annonce = Number(req.headers['content-length'] || 0);
    if (annonce > CORPS_MAX) {
      return refuser(res, 413, JSON.stringify({ erreur: 'filet : corps trop gros' }));
    }

    const morceaux = [];
    req.on('data', (m) => morceaux.push(m));
    req.on('end', async () => {
      const corps = Buffer.concat(morceaux);
      let demande = null;
      try {
        demande = JSON.parse(corps.toString('utf8') || '{}');
      } catch {
        // Corps illisible : on TRANSMET. Le serveur le refusera, et c'est
        // lui qu'une sonde vient interroger — refuses « filet : corps
        // illisible » a sa place, on ne prouve plus rien. Un corps illisible ne
        // peut pas porter de jeton, donc aucune suppression n'est possible.
        demande = null;
      }
      if (!demande || typeof demande !== 'object') {
        return relierCorps(res, url, entetes, corps);
      }
      const mode = String(demande.mode || '');

      // --- la simulation : transmise, mais SES resultats sont memorises ------
      if (mode === 'dry') {
        const brut = await interroger(corps, url, entetes);
        if (brut.statut === 200) {
          let apercu = null;
          try { apercu = JSON.parse(brut.texte); } catch { apercu = null; }
          const items = (apercu && apercu.items) || [];
          // Hors racine ET effaçable. Un chemin que le serveur a lui-meme
          // marque `blocked` — racine de volume, `C:\Windows`, profil — ne
          // sera PAS supprimé : l'intercepter ici ne protegerait rien et
          // empecherait les sondes de vérifier la garde du serveur, qu'on est
          // précisément en train de doublonner. Le filet ne s'arrete que sur ce
          // qui disparaitrait vraiment.
          const hors = items.filter((it) => !it.blocked && !sousRacine(it.path, racines));
          const jeton = apercu && apercu.token;
          emis.set(jeton, { douteux: hors.length > 0, chemins: items.map((i) => i.path) });
          if (hors.length) {
            // Consigné, pas bloqué : une sonde a le droit de regarder un
            // aperçu hors racine pour vérifier qu'il EST refusé. Ce qui compte,
            // c'est qu'elle ne puisse plus l'exécuter.
            douteux += 1;
            console.log(`  filet   : apercu douteux (${hors.length}/${items.length}), jeton neutralise`);
          }
        }
        return repondre(res, brut.statut, brut.texte, brut.typeur);
      }

      if (mode !== 'recycle' && mode !== 'permanent') {
        return relierCorps(res, url, entetes, corps);
      }

      // --- l'execution : le seul point ou un fichier peut disparaitre -------
      const verdict = emis.get(demande.token);

      // Un jeton INCONNU est transmis. Le serveur le refusera — c'est lui qui
      // sait, et une sonde a le droit de vérifier qu'il le fait. Le filet ne
      // se substitue pas à la garde qu'il doublle : il ne s'en substitue que
      // là où la transmission serait destructive.
      if (!verdict) return relierCorps(res, url, entetes, corps);

      if (verdict.douteux) {
        noter(`execution d un jeton dont l'apercu sortait de la racine (${verdict.chemins.length} element(s))`);
        return refuser(res, 403, JSON.stringify({
          erreur: "filet : l'apercu de ce jeton annoncait des chemins hors de la racine de travail. Execution refusee.",
        }));
      }
      // Le volume demandé doit être l'un de ceux qu'on surveille. Ici seulement,
      // car c'est ici seulement qu'une suppression va réellement avoir lieu.
      const l = lettre(`${demande.drive || ''}:\\`);
      if (l && !racines.some((r) => lettre(r) === l)) {
        noter(`execution sur un volume non surveille (${demande.drive}:)`);
        return refuser(res, 403, JSON.stringify({
          erreur: `filet : le volume ${demande.drive}: n'est pas surveille. Execution refusee.`,
        }));
      }
      journaliser(mode, `${verdict.chemins.length} element(s) sous ${racines[0]}`);
      return relierCorps(res, url, entetes, corps);
    });
  });

  return new Promise((resolve) => {
    serveur.listen(0, '127.0.0.1', () => {
      resolve({
        port: serveur.address().port,
        url: `http://127.0.0.1:${serveur.address().port}/`,
        get incidents() { return incidents; },
        // Incidents survenus pendant une sonde qui N'EST PAS la sonde d'épreuve
        // du filet. Ceux-là n'ont aucune explication benign : une sonde a visé
        // hors de sa racine, et c'est l'incident du 26/09/2026. Le chef
        // d'orchestre y range ceux-ci ; ceux qu'il a sur un tableau à part, lui,
        // vident la liste à chaque sonde pour ne garder que les nouveaux.
        tiers: [],
        get refus() { return refus; },
        get douteux() { return douteux; },
        get racines() { return nomsRacines; },
        arreter: () => new Promise((r) => serveur.close(() => r())),
      });
    });
  });
}
