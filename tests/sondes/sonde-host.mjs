// Le nom qu'on nous demande est-il celui de cette machine ?
//
// Cette sonde éprouve la défense contre le REBINDING DNS.
//
// Le scénario, en trois temps : l'attaquant sert une page depuis son domaine
// (evil.test) ; pendant que la victime la regarde, il fait résoudre ce domaine
// vers 127.0.0.1 ; les requêtes que la page émet ensuite atteignent notre
// serveur, et le navigateur les croit DE MÊME ORIGINE.
//
// Pourquoi les défenses existantes n'y suffisent pas :
//   - le contrôle d'`Origin` ne voit rien : il n'y a pas de requête croisée ;
//   - le préflight non plus, pour la même raison ;
//   - l'en-tête `X-Diskmap`, qui protège des POST « simples » d'une page tierce,
//     est ici posable sans restriction — un en-tête personnalisé ne déclenche un
//     préflight que sur une requête CROISÉE.
//
// Seul le nom porté par `Host` trahit l'attaque : le navigateur y met le nom
// d'origine, jamais l'adresse à laquelle il a effectivement abouti.
//
// La sonde a deux moitiés, et il faut les deux :
//   1. le nom, éprouvé sur TOUTES les routes — lectures comprises, car
//      `/api/tree` livre l'inventaire complet du disque ;
//   2. le rebinding lui-même, joué dans un VRAI navigateur, grâce à
//      `--host-resolver-rules=MAP evil.test 127.0.0.1`. C'est ce qui distingue
//      « l'en-tête est bien analysé » de « l'attaque ne passe plus ».
//
// Aucune route n'est réellement déclenchée : les POST partent avec un corps
// illisible (400 attendu si la garde cédait) ou une cible inexistante. La
// contre-épreuve peut donc tourner sans rien détruire ni arrêter le serveur.
//
// Usage : node sonde-host.mjs http://127.0.0.1:8800/
import http from 'http';

import { chromium } from './navigateur.mjs';
import { URL_DEFAUT } from './config.mjs';

const BASE = (process.argv[2] || URL_DEFAUT).replace(/\/$/, '');
const U = new URL(BASE);
const PORT = U.port || '80';

const verifs = [], echecs = [];
function verifier(nom, cond, mesure) {
  const ok = !!cond; verifs.push(ok);
  if (!ok) echecs.push(`${nom} — mesuré : ${mesure}`);
  console.log(`${ok ? 'ok   ' : 'ROUGE'} ${nom}${ok ? '' : `\n      mesuré : ${mesure}`}`);
}
function constater(t) { console.log(`      constat : ${t}`); }

// Une requête brute, pour poser l'en-tête `Host` qu'on veut. `setHost: false`
// empêche Node de le réécrire d'après l'URL : c'est tout l'intérêt.
function requete(method, chemin, host, entetes = {}) {
  const h = { ...entetes };
  if (host !== null) h.Host = host;
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: U.hostname, port: PORT, method, path: chemin,
      headers: h, setHost: false,
    }, res => {
      let corps = '';
      res.on('data', d => { corps += d; });
      res.on('end', () => resolve({ status: res.statusCode, corps }));
    });
    req.on('error', reject);
    // Corps DÉLIBÉRÉMENT illisible. Sans cela, la contre-épreuve (garde
    // neutralisée) ferait atteindre les routes, et `/api/quit` avec un corps
    // vide arrêterait vraiment le serveur — la sonde conclurait alors sur un
    // serveur mort, pour une raison qui n'a rien à voir avec ce qu'elle mesure.
    // Avec « { », chaque route répond 400 sans rien faire.
    req.end(method === 'POST' ? '{' : undefined);
  });
}

const JSON_POST = { 'Content-Type': 'application/json', 'X-Diskmap': '1' };

// ------------------------------------------------------------------ 1. le nom
console.log('--- 1. le nom étranger est refusé, sur toutes les routes ---');

const GETS = [
  ['/', 'la page'],
  ['/api/state', 'l’état'],
  ['/api/tree?drive=C&id=0', 'l’arbre'],
  ['/api/search?drive=C&q=windows', 'la recherche'],
  ['/api/unreadable?drive=C', 'la liste des illisibles'],
];
// Corps illisible ou cible hors bornes : si la garde cédait, la route répondrait
// 400 ou 404 — jamais elle n'agirait. La contre-épreuve est donc sans danger.
const POSTS = [
  ['/api/scan/Z', {}, 'demander une analyse'],
  ['/api/reveal', JSON_POST, 'ouvrir dans l’explorateur'],
  ['/api/open?drive=C&id=999999999', {}, 'ouvrir une entrée'],
  ['/api/quit', JSON_POST, 'arrêter le serveur'],
  ['/api/delete', JSON_POST, 'supprimer'],
];

for (const [chemin, nom] of GETS) {
  const r = await requete('GET', chemin, `evil.test:${PORT}`);
  verifier(`GET ${chemin} (${nom}) → refusé`, r.status === 403, `HTTP ${r.status} · ${r.corps.slice(0, 90)}`);
}
for (const [chemin, entetes, nom] of POSTS) {
  const r = await requete('POST', chemin, `evil.test:${PORT}`, entetes);
  verifier(`POST ${chemin} (${nom}) → refusé`, r.status === 403, `HTTP ${r.status} · ${r.corps.slice(0, 90)}`);
}

const refus = await requete('GET', '/api/state', `evil.test:${PORT}`);
verifier('le refus nomme la cause', /Host refus/i.test(refus.corps), JSON.stringify(refus.corps.slice(0, 120)));

// L'en-tête X-Diskmap est posé sur les POST ci-dessus : la garde du nom doit
// agir AVANT lui, sinon un POST bien muni passerait.
const post = await requete('POST', '/api/quit', `evil.test:${PORT}`, JSON_POST);
verifier('la garde du nom passe avant celle de l’en-tête X-Diskmap',
  post.status === 403 && /Host refus/i.test(post.corps),
  `HTTP ${post.status} · ${post.corps.slice(0, 90)}`);

// ------------------------------------------------------- 2. le nom légitime
console.log('\n--- 2. le nom de la machine reste accepté ---');

const BONS = [
  [`127.0.0.1:${PORT}`, 'l’adresse et son port'],
  ['127.0.0.1', 'l’adresse seule — c’est ce qu’envoie `already_running`'],
  [`localhost:${PORT}`, 'le nom local'],
  [`LOCALHOST:${PORT}`, 'la casse ne compte pas'],
  ['localhost.', 'le point final est la racine, pas un autre nom'],
  [`[::1]:${PORT}`, 'le littéral IPv6 entre crochets'],
];
for (const [host, nom] of BONS) {
  const r = await requete('GET', '/api/state', host);
  verifier(`Host « ${host} » accepté (${nom})`, r.status === 200, `HTTP ${r.status} · ${r.corps.slice(0, 90)}`);
}

// -------------------------------------------------------------- 3. les leurres
console.log('\n--- 3. les leurres qui commencent par la bonne adresse ---');

const LEURRES = [
  [`127.0.0.1.evil.test:${PORT}`, 'l’adresse en préfixe d’un autre nom'],
  [`127.0.0.1:${PORT}@evil.test`, 'un port suivi d’une arobase'],
  ['127.0.0.1evil.test', 'l’adresse collée à un autre nom'],
  [`x127.0.0.1:${PORT}`, 'l’adresse en suffixe'],
  [`localhost.evil.test:${PORT}`, 'le nom local en préfixe'],
  ['evil.test', 'un nom quelconque'],
];
for (const [host, nom] of LEURRES) {
  const r = await requete('GET', '/api/state', host);
  verifier(`Host « ${host} » refusé (${nom})`, r.status === 403, `HTTP ${r.status} · ${r.corps.slice(0, 90)}`);
}

// Sans en-tête Host du tout — un client HTTP/1.0, par exemple.
//
// Derrière le filet, cette requête ne peut pas l'atteindre : Node refuse
// lui-même, au parseur, une requête HTTP/1.1 sans Host, et le filet est un
// serveur Node. Le point de la vérification — « ça ne passe pas » — tient
// toujours ; seule la main qui refuse change. Le filet n'est donc PAS
// transparent, et on ne le prétend pas : le croire transparent ferait passer
// une preuve pour une autre.
const derriereFilet = await fetch(`${BASE}/filet`).then(r => r.json()).catch(() => null);
const viaFilet = !!(derriereFilet && derriereFilet.filet);
const sans = await requete('GET', '/api/state', null);
verifier(
  viaFilet
    ? 'l’absence d’en-tête Host est refusée — par le parseur du filet'
    : 'l’absence d’en-tête Host est refusée — par l’application',
  viaFilet ? sans.status === 400 : sans.status === 403,
  `HTTP ${sans.status} · ${sans.corps.slice(0, 90)}`);

// ------------------------------------------------ 4. le rebinding, pour de vrai
console.log('\n--- 4. le rebinding DNS, joué dans un vrai navigateur ---');
console.log(`      evil.test est résolu vers 127.0.0.1 par le navigateur lui-même`);

const nav = await chromium.launch({ args: ['--host-resolver-rules=MAP evil.test 127.0.0.1'] });
try {
  const ctx = await nav.newContext();

  // 4a. La page de l'attaquant est servie PAR notre serveur, sous un nom
  //     étranger. C'est l'état exact après un rebinding.
  const page = await ctx.newPage();
  const rep = await page.goto(`http://evil.test:${PORT}/`, { waitUntil: 'domcontentloaded' });
  verifier('la page ne se sert pas sous un nom étranger', rep.status() === 403, `HTTP ${rep.status()}`);
  const texte = await page.content();
  verifier('c’est bien notre refus qui est servi', /Host refus/i.test(texte),
    JSON.stringify(texte.replace(/\s+/g, ' ').slice(0, 140)));

  // 4b. Depuis cette origine, le navigateur la croit locale : aucune requête
  //     n'est croisée, donc ni CORS ni préflight ne s'appliquent. C'est
  //     exactement le point où le rebinding gagne, s'il gagne.
  const fuite = await page.evaluate(async () => {
    try {
      const r = await fetch('/api/state', { headers: { 'X-Diskmap': '1' } });
      return { status: r.status, corps: (await r.text()).slice(0, 120) };
    } catch (e) { return { status: 0, corps: String(e).slice(0, 120) }; }
  });
  console.log(`      lecture tentée depuis evil.test : HTTP ${fuite.status} · ${JSON.stringify(fuite.corps)}`);
  verifier('l’inventaire du disque n’est pas lisible sous un nom étranger',
    fuite.status === 403, `HTTP ${fuite.status} · ${JSON.stringify(fuite.corps)}`);

  // 4c. Et la même lecture, sous le bon nom, doit évidemment fonctionner : sans
  //     ce contrôle, une garde qui refuse TOUT passerait pour un succès.
  const page2 = await ctx.newPage();
  const rep2 = await page2.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  verifier('la page légitime se charge toujours', rep2.status() === 200, `HTTP ${rep2.status()}`);
  const ui = await page2.locator('#drives').count();
  verifier('l’interface légitime est bien rendue', ui > 0, `#drives trouvé ${ui} fois`);
  const bon = await page2.evaluate(async () => {
    const r = await fetch('/api/state');
    return { status: r.status, n: (await r.json()).drives.length };
  });
  verifier('l’API répond au nom légitime', bon.status === 200 && bon.n > 0,
    `HTTP ${bon.status}, ${bon.n} volume(s)`);

  // Le même genre de POST, sous le bon nom et avec le bon en-tête, doit ATTEINDRE
  // la route : la garde du nom ne doit pas fermer les POST au passage.
  //
  // On vise une lettre de volume inexistante, donc un 404 : la requête a franchi
  // les deux gardes et c'est la route qui a répondu. Surtout PAS `/api/quit` —
  // avec un Host valide, il arrêterait réellement le serveur, et la sonde
  // conclurait sur un serveur mort.
  const atteint = await requete('POST', '/api/scan/Z', `127.0.0.1:${PORT}`, JSON_POST);
  verifier('un POST légitime atteint bien la route',
    atteint.status === 404, `HTTP ${atteint.status} · ${atteint.corps.slice(0, 90)}`);
} finally {
  await nav.close();
}

console.log('');
console.log(`${verifs.filter(Boolean).length}/${verifs.length} vérifications`);
if (echecs.length) { console.log('ÉCHECS :'); for (const e of echecs) console.log(`  - ${e}`); }
process.exitCode = echecs.length ? 1 : 0;
