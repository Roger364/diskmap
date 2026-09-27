// Sonde de la route destructive : /api/delete.
//
// CE FICHIER NE SUPPRIME RIEN, et ne tente jamais de supprimer quelque chose de
// dangereux « pour voir si la garde tient ». Prouver une garde en tentant l'acte
// qu'elle doit empêcher, c'est prendre le risque qu'elle ne tienne pas.
//
// Deux moyens détournés, tous deux sûrs :
//
//  * les chemins protégés sont vérifiés en mode `dry` seulement. `dry` et
//    `execute` appellent le MÊME `blocked_reason` sur le MÊME chemin (le jeton
//    mémorise les items de la simulation) : le refus établi en simulation vaut
//    donc à l'exécution, sans jamais exécuter.
//  * l'exécution elle-même est éprouvée avec un JETON INERTE : un identifiant
//    hors bornes, que `resolve()` ne peut pas résoudre. La boucle d'exécution
//    tourne, le jeton est consommé, et rien n'est touché — par construction et
//    non par chance.
//
// Usage : node sonde-suppression.mjs http://127.0.0.1:8990/
//
// Depuis le 26/09/2026 le serveur exige l'en-tête X-Diskmap sur toute route POST.
// Cette sonde le porte (voir `post`) : elle joue le CLIENT. C'est
// `sonde-csrf-navigateur.mjs` qui joue l'attaquant, et qui ne le porte pas.

import { aCorbeille, estEleve, aTaper } from './config.mjs';

const URL = process.argv[2] || 'http://127.0.0.1:8990/';
const BASE = URL.replace(/\/$/, '');

// L'instance est-elle ÉLEVÉE ? Le runner de GitHub Actions l'est TOUJOURS, et
// une instance élevée exige `EFFACER` même en mode corbeille : sans cette
// lecture, les trois vérifications de cycle de vie du jeton ci-dessous sont
// fausses sur la CI et vraies chez le développeur, sans qu'aucune des deux
// exécutions ne donne à voir pourquoi. Le mot est donc déduit de l'état
// réel du serveur, jamais supposé.
const ELEVE = await estEleve(BASE);
// La corbeille de C: est MESUREE, pas supposee : cette sonde ne travaille que
// sur C:, et un volume qui n en a pas exigerait  en mode corbeille.
const MOT_RECYCLE = aTaper({ permanent: false, corbeille: aCorbeille('C'), eleve: ELEVE });
console.log(`instance ${ELEVE ? 'ÉLEVÉE' : 'normale'} — `
  + `mode corbeille : ${MOT_RECYCLE ? `« ${MOT_RECYCLE} »` : 'aucun mot exigé'}`);
// Sélecteur hors bornes pour tout volume : n_dirs de C: est ~271 000, et la
// position 1 852 516 352 n'appartient pas non plus à `files`. Le bit de type
// est mis pour que ce soit un sélecteur de FICHIER, le cas le plus strict.
const INERTE = 4000000000;

// La génération de l'instantané de C:, exigée par `dry` depuis le 26/09/2026.
//
// Les sélecteurs ci-dessous sont des POSITIONS dans cet instantané, et une
// position ne vaut que dans l'instantané qui l'a produite : re-résolue contre
// un index réanalysé, la position 16 de `p1.txt` désignait `p2.txt`. Le serveur
// refuse donc un aperçu qui ne dit pas de quel index il parle.
//
// Ce sont des sélecteurs de DOSSIERS : un sélecteur de dossier, c'est son
// numéro. Le type est dans le sélecteur (bit de type — voir
// `scan::BIT_FICHIER`), et non dans un champ séparé que le client pourrait
// rendre faux sans que l'aperçu le signale.
//
// Cette sonde ne supprime rien, donc ne déclenche aucune réanalyse : la
// génération reste stable d'un bout à l'autre.
const GEN_C = (await (await fetch(`${BASE}/api/tree?drive=C&id=0`)).json()).gen;
if (typeof GEN_C !== 'number') {
  console.log(`ROUGE /api/tree ne renvoie aucune génération — mesuré : ${GEN_C}`);
  process.exit(1);
}

const verifs = [];
const echecs = [];
function verifier(nom, condition, mesure) {
  const ok = !!condition;
  verifs.push(ok);
  if (!ok) echecs.push(`${nom} — mesuré : ${mesure}`);
  console.log(`${ok ? 'ok   ' : 'ROUGE'} ${nom}${ok ? '' : `\n      mesuré : ${mesure}`}`);
}

async function post(chemin, corps, entetes = {}) {
  const r = await fetch(BASE + chemin, {
    method: 'POST',
    // En-tête exigé par le serveur sur toute route qui modifie quelque chose.
    // Une sonde qui l'omettrait ne jouerait plus le rôle du client mais celui de
    // l'attaquant — elle se ferait refuser, et croirait la route cassée.
    headers: { 'Content-Type': 'application/json', 'X-Diskmap': '1', ...entetes },
    body: JSON.stringify(corps),
  });
  const texte = await r.text();
  return { status: r.status, texte };
}

const effacer = (drive, items, mode, extra = {}) =>
  post('/api/delete', { drive, items, mode, gen: GEN_C, ...extra });

// Jeton dont la liste ne résout rien : l'exécution ne peut rien toucher.
async function jetonInerte() {
  const r = await effacer('C', [INERTE], 'dry');
  return JSON.parse(r.texte).token;
}

// ---------------------------------------------------------------- 1. refus
console.log('--- 1. chemins que l’effacement doit refuser (vérifiés en simulation) ---');

// Les sélecteurs sont RÉSOLUS par leur NOM, jamais écrits en dur.
//
// Ils l'étaient : 34 pour `Windows`, 32 pour `Users`, relevés sur la machine de
// développement. Ces numéros sont des POSITIONS dans un instantané de CETTE
// machine — sur un runner GitHub, le dossier 34 est un autre, et la sonde
// concluait « l'effacement ne protège pas `C:\Windows` » alors qu'elle venait
// simplement de viser un dossier sans rapport. Un test qui ne marche que chez
// celui qui l'a écrit n'est pas un test, c'est un souvenir.
//
// On demande donc la racine de C: et on retrouve chaque dossier par son nom.
const racineC = await (await fetch(`${BASE}/api/tree?drive=C&id=0&limit=200`)).json();
const parNom = new Map(racineC.rows.map(r => [r.name, r.sel]));
const selWindows = parNom.get('Windows');
const SYSTEMES = [
  ['racine du volume C:', 'racine du volume'],
  ['Windows', 'répertoire système protégé'],
  ['Program Files', 'répertoire système protégé'],
  ['ProgramData', 'répertoire système protégé'],
  ['Users', 'profil utilisateur protégé'],
];

// Un dossier protégé qu'une machine n'a pas (`Program Files` sur une
// installation minimale) ne peut pas être éprouvé. La sonde le DIT et
// s'en abstient — elle ne le compte ni pour un succès ni pour un échec.
const absents = [];
for (const [nom, attendu] of SYSTEMES) {
  const sel = nom.includes(':') ? 0 : parNom.get(nom);
  if (sel === undefined) { absents.push(`C:\\${nom}`); continue; }
  const r = await effacer('C', [sel], 'dry');
  let d = null;
  try { d = JSON.parse(r.texte); } catch { /* laissé null */ }
  const it = d && d.items && d.items[0];
  const affiche = nom.includes(':') ? nom : `C:\\${nom}`;
  verifier(`${affiche} est signalé bloqué`, r.status === 200 && it && it.blocked === true,
    `sel=${sel} — HTTP ${r.status} — ${r.texte.slice(0, 120)}`);
  if (it) {
    verifier(`${affiche} : la raison est « ${attendu} »`, it.reason === attendu, `« ${it.reason} »`);
    verifier(`${affiche} n’est pas compté comme effaçable`, d.deletable === 0, `deletable = ${d.deletable}`);
  }
}
if (absents.length) {
  console.log(`      (absents de cette machine, non éprouvés : ${absents.join(', ')})`);
}

// ------------------------------------------------------- 2. le jeton exigé
console.log('\n--- 2. on ne supprime que ce qui a été simulé ---');

let r = await effacer('C', [], 'recycle');
verifier('sans jeton, l’exécution est refusée', r.status === 409, `HTTP ${r.status} — ${r.texte.slice(0, 90)}`);

r = await effacer('C', [], 'recycle', { token: 'nimportequoi-123' });
verifier('avec un jeton inventé, l’exécution est refusée', r.status === 409, `HTTP ${r.status} — ${r.texte.slice(0, 90)}`);

r = await effacer('C', [], 'inconnu');
verifier('un mode inconnu est refusé', r.status === 400, `HTTP ${r.status} — ${r.texte.slice(0, 90)}`);

const j1 = await jetonInerte();
r = await effacer('D', [], 'recycle', { token: j1 });
verifier('un jeton de C: ne sert pas sur D:', r.status === 400 && /autre volume/.test(r.texte),
  `HTTP ${r.status} — ${r.texte.slice(0, 90)}`);

// Le définitif exige le mot exact.
r = await effacer('C', [], 'permanent', { token: j1 });
verifier('le définitif sans « EFFACER » est refusé', r.status === 400 && /EFFACER/.test(r.texte),
  `HTTP ${r.status} — ${r.texte.slice(0, 90)}`);
r = await effacer('C', [], 'permanent', { token: j1, confirm: 'effacer' });
verifier('« effacer » en minuscules ne suffit pas', r.status === 400, `HTTP ${r.status} — ${r.texte.slice(0, 90)}`);
r = await effacer('C', [], 'permanent', { token: j1, confirm: 'EFFACER ' });
verifier('« EFFACER » suivi d’une espace ne suffit pas', r.status === 400, `HTTP ${r.status} — ${r.texte.slice(0, 90)}`);

// Une demande mal formée ne doit pas obliger à refaire la simulation : le refus
// doit rendre 400 (jeton présent, confirmation absente) et non 409 (jeton absent).
r = await effacer('C', [], 'recycle', { token: j1, confirm: MOT_RECYCLE });
verifier('un refus ne consomme pas le jeton', r.status === 200, `HTTP ${r.status} — ${r.texte.slice(0, 90)}`);
if (r.status === 200) {
  const d = JSON.parse(r.texte);
  verifier('le jeton inerte n’a rien supprimé', d.done === 0, `done = ${d.done}`);
  verifier('le jeton inerte n’a rien marqué en échec', d.failed === 0, `failed = ${d.failed}`);
  verifier('aucune réanalyse déclenchée sans suppression', d.rescan === false, `rescan = ${d.rescan}`);
}

r = await effacer('C', [], 'recycle', { token: j1, confirm: MOT_RECYCLE });
verifier('le jeton ne sert qu’une fois', r.status === 409, `HTTP ${r.status} — ${r.texte.slice(0, 90)}`);

// --------------------------------------------- 3. les items de la requête
console.log('\n--- 3. la liste vient du jeton, jamais de la requête ---');

// Le jeton porte une liste inerte ; la requête réclame C:\Windows. Si la requête
// faisait foi, c'est Windows qui serait visé — et ce test le dirait sans jamais
// l'avoir tenté.
const j2 = await jetonInerte();
r = await effacer('C', [selWindows ?? INERTE], 'recycle', { token: j2, confirm: MOT_RECYCLE });
if (r.status === 200) {
  const d = JSON.parse(r.texte);
  verifier('les items de la requête sont ignorés',
    d.results.length === 0,
    `chemins traités : ${JSON.stringify(d.results.map(x => x.path))} — la requête a été suivie`);
} else {
  verifier('les items de la requête sont ignorés', false, `HTTP ${r.status} — ${r.texte.slice(0, 90)}`);
}

// ------------------------------------------------ 4. force du jeton
//
// Ce que cette section vérifie s'est INVERSÉ le 26/09/2026. Le jeton s'écrivait
// « <ms>-xorshift(<ms>) » : l'horodatage était publié EN CLAIR dedans, et le
// reste s'en déduisait entièrement — mesuré, onze candidats (±5 ms) suffisaient
// à le retrouver, au lieu de 2^32. L'aléa vient maintenant du générateur du
// système, et ne dépend plus de ce qui est publié.
console.log('\n--- 4. le jeton est-il devinable ? ---');

// Ce à quoi ressemblerait le jeton si l'ancienne formule revenait. C'est
// l'hypothèse à réfuter, pas une prédiction.
function ancienAlea(ts) {
  const M = (1n << 64n) - 1n;
  let s = BigInt(ts) & M;
  s = (s ^ (s << 13n)) & M;
  s = (s ^ (s >> 7n)) & M;
  s = (s ^ (s << 17n)) & M;
  return Number(s & 0xffffffffn);
}

const jeton = await jetonInerte();
const [ts, valeur] = jeton.split('-');
console.log(`      jeton réel : ${jeton}`);
verifier('l’horodatage du jeton est l’heure courante',
  Math.abs(Date.now() - Number(ts)) < 5000, `écart = ${Date.now() - Number(ts)} ms`);

// Le test qui compte. Si un décalage raisonnable autour de l'horodatage publié
// reproduit la partie aléatoire, l'ancien défaut est revenu et le jeton se forge
// sans rien savoir de plus que l'heure.
let forgeable = null;
for (let k = -5; k <= 5; k++) {
  if (String(ancienAlea(Number(ts) + k)) === valeur) forgeable = k;
}
verifier('la partie aléatoire ne se déduit PAS de l’horodatage publié',
  forgeable === null,
  `le décalage ${forgeable} ms reproduit le jeton — il est forgeable`);

// L'ancienne formule tenait sur au plus 10 chiffres décimaux ; celle-ci en écrit
// 16 en hexadécimal, soit les 64 bits du générateur. Le format distingue donc
// franchement les deux, ce qui rend la vérification précédente lisible.
verifier('la partie aléatoire couvre 64 bits, et non un xorshift tronqué à 32',
  /^[0-9a-f]{16}$/.test(valeur), `valeur = « ${valeur} »`);

// ------------------------------------------------ 5. surface CSRF
//
// Ce que cette section vérifie s'est INVERSÉ le 26/09/2026. La route ne se
// contentait pas d'ignorer Origin : elle était réellement atteignable depuis une
// page tierce — mesuré dans un vrai navigateur, trois origines sur trois, avec
// suppression effective du fichier. Elle exige désormais un en-tête que seule
// notre page sait poser.
console.log('\n--- 5. une page web tierce peut-elle appeler la route ? ---');

const r1 = await fetch(BASE + '/api/delete', {
  method: 'POST',
  headers: { 'Content-Type': 'text/plain', Origin: 'https://exemple.test' },
  body: JSON.stringify({ drive: 'C', items: [INERTE], mode: 'dry' }),
});
verifier('un POST « text/plain » d’une autre origine est REFUSÉ',
  r1.status === 403,
  `HTTP ${r1.status} — un 200 signifierait qu'une page tierce peut appeler la route`);

const r2 = await fetch(BASE + '/api/delete', {
  method: 'OPTIONS',
  headers: { Origin: 'https://exemple.test', 'Access-Control-Request-Method': 'POST' },
});
verifier('aucun préflight n’est servi (OPTIONS non routé)', r2.status === 404,
  `HTTP ${r2.status}`);

// Le refus doit venir de l'EN-TÊTE, et non d'un contrôle d'Origin. C'est ce qui
// distingue une défense qui tient — l'en-tête force un préflight, que le
// navigateur ne peut pas escamoter — d'une défense cosmétique, qu'on contourne
// en omettant ou en falsifiant Origin hors navigateur.
const r3 = await fetch(BASE + '/api/delete', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: 'https://exemple.test', 'X-Diskmap': '1' },
  body: JSON.stringify({ drive: 'C', items: [INERTE], mode: 'dry', gen: GEN_C }),
});
verifier('avec l’en-tête, la même origine étrangère passe — le juge est bien l’en-tête',
  r3.status === 200,
  `HTTP ${r3.status}`);

console.log('');
console.log(`${verifs.filter(Boolean).length}/${verifs.length} vérifications vertes`);
if (echecs.length) {
  console.log('ÉCHECS / CONSTATS :');
  for (const e of echecs) console.log(`  - ${e}`);
}
process.exit(echecs.length ? 1 : 0);
