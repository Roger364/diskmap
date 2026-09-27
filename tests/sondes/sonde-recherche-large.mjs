// La garde de mémoire : quand la recherche ne peut pas tout matérialiser,
// dit-elle la vérité ?
//
// `/api/search` collecte au plus `garde` lignes — quatre fois la borne
// demandée, jamais moins de 4 000 — puis trie ce qu'elle a. Au-delà, elle
// continue de COMPTER (c'est gratuit : on visite les noms de toute façon) mais
// cesse de MATERIALISER, et la réponse porte alors `exact: false`.
//
// C'est le chemin que l'interface traduit par « au moins N ». Il a été écrit le
// 27/09/2026 et **aucune sonde ne l'exerçait**. C'est la seule branche du
// travail de ce jour-là dont je ne pouvais pas affirmer qu'elle marche — et
// une branche livrée sans preuve n'est pas une branche, c'est une
// hypothèse qui occupe de la place dans le binaire.
//
// Cette sonde ne crée RIEN et ne supprime RIEN. Elle cherche sur les volumes
// réels, comme `sonde-palier` évalue les paliers sur de vrais dossiers de
// 344 Go : le volume jetable fait 511 Mio et ne peut pas contenir 4 000
// correspondances sans les fabriquer, ce qui prendrait plus de temps que le
// test lui-même.
//
// Si aucun volume réel ne dépasse la garde, la sonde le DIT et sort en 2. Un
// vert obtenu sans avoir[jsais]()
//  rien est un vert qui ne prouve rien : la règle du projet est qu'un cas non
// mesuré ne vaut ni succès ni échec.
//
// Usage : node sonde-recherche-large.mjs http://127.0.0.1:8990/ V
import { URL_DEFAUT } from './config.mjs';

const BASE = (process.argv[2] || URL_DEFAUT).replace(/\/$/, '');

const verifs = [], echecs = [], notes = [];
function verifier(nom, condition, mesure) {
  const ok = !!condition;
  verifs.push(ok);
  if (!ok) echecs.push(`${nom} — mesuré : ${mesure}`);
  console.log(`${ok ? 'ok   ' : 'ROUGE'} ${nom}${ok ? '' : `\n      mesuré : ${mesure}`}`);
}
function noter(texte) {
  notes.push(texte);
  console.log(`      note : ${texte}`);
}

// Le serveur ne renvoie pas du JSON quand il refuse : il répond « volume pas
// encore analysé » en texte, avec un 409. Un `r.json()` transforme un refus
// ATTENDU en SyntaxError, et la sonde plante sans écrire une ligne.
const corps = async (r) => {
  const texte = await r.text();
  try { return JSON.parse(texte); } catch { return { error: texte.trim() || `HTTP ${r.status}`, rows: null }; }
};
const get = (c) => fetch(BASE + c).then(corps);

const chercher = (drive, q, limit) => {
  const qs = new URLSearchParams({ drive, q });
  if (limit !== undefined) qs.set('limit', String(limit));
  return fetch(`${BASE}/api/search?${qs}`).then(corps);
};

// --- 1. un volume reellement grand ----------------------------------------
const etat = await get('/api/state');
const volumes = (etat.drives || []).filter((d) => d.status === 'ready');
console.log('--- volumes prêts ---');
for (const d of volumes) {
  console.log(`    ${d.letter}: ${d.n_files} fichier(s), ${d.n_dirs} dossier(s)`);
}

if (!volumes.length) {
  console.log('PAS PU EPROUVER : aucun volume analysé.');
  process.exit(2);
}

// --- 2. un terme qui depasse la garde --------------------------------------
//
// On ne devine pas le terme : on les essaie, et on prend le premier
// qui depasse la garde. Sur un disque reel, une lettre suffit presque toujours.
const TERMES = ['e', 's', 'a', 'i', 'n', 'o', 'r', 't', 'package.json', 'node_modules', 'index', 'js'];
let trouve = null;
for (const v of volumes) {
  if ((v.n_files + v.n_dirs) < 5000) continue;
  for (const terme of TERMES) {
    const r = await chercher(v.letter, terme, 800);
    if (r.error || !r.rows) continue;
    if (r.exact === false) { trouve = { v, terme, r }; break; }
  }
  if (trouve) break;
}

if (!trouve) {
  console.log('');
  console.log('PAS PU EPROUVER : aucun terme ne dépasse la garde de mémoire sur les '
    + 'volumes réellement montés. Le chemin « au moins N » reste donc non '
    + 'exercé — et il ne faut pas le declarer bon pour autant.');
  for (const n of notes) console.log(`  - ${n}`);
  process.exit(2);
}

const { v, terme, r } = trouve;
const garde = r.garde;
console.log('');
console.log(`--- ${v.letter} : « ${terme} » dépasse la garde ---`);
console.log(`    garde=${garde}  total=${r.total}  rendu=${r.rows.length}  exact=${r.exact}`);

// --- 3. ce que la reponse doit dire -----------------------------------------
verifier('la reponse signale qu elle ne montre pas tout',
  r.exact === false, `exact=${r.exact}, alors que le total dépasse la garde`);
verifier('« total » est un PLANCHER, pas un compte pretendu exact',
  r.total >= garde,
  `total=${r.total}, garde=${garde} : un total sous la garde serait un compte, `
  + 'et cette branche existe justement parce qu il n y a pas de compte');
verifier('« total » n est pas le nombre rendu',
  r.total !== r.rows.length,
  `total=${r.total}, rendu=${r.rows.length} : ils ne peuvent pas etre egaux ici`);
verifier('la borne d affichage est toujours respectee',
  r.rows.length <= 800, `${r.rows.length} ligne(s) pour une borne de 800`);

// --- 4. l echantillon reste trie -------------------------------------------
// Un echantillon non trie serait le pire des deux mondes : on ne peut ni dire
// que la liste est complete, ni la lire par taille.
const tailles = r.rows.map((x) => x.size);
const decroissant = tailles.every((t, i) => i === 0 || tailles[i - 1] >= t);
verifier('l echantillon rendu reste trie par taille decroissante', decroissant,
  `tailles [${tailles.slice(0, 6).join(', ')}${tailles.length > 6 ? ', …' : ''}]`);

// L unicite se porte sur le SELECTEUR, pas sur le nom.
//
// Un volume contient des centaines de dossiers `node_modules`, tous nommes
// pareil. Compter les noms distincts ne prouve donc rien : mesuré ici, 800
// lignes pour 696 noms distincts, ce qui est NORMAL et pas un doublon.
// Deux lignes ne sont la meme ligne que si elles designent le meme chemin.
const selecteurs = r.rows.map((x) => String(x.sel));
const chemins = r.rows.map((x) => String(x.path));
const doublonSel = selecteurs.length - new Set(selecteurs).size;
const doublonChemin = chemins.length - new Set(chemins).size;
verifier('aucune ligne n est rendue deux fois', doublonSel === 0 && doublonChemin === 0,
  `${doublonSel} doublon(s) de selecteur, ${doublonChemin} de chemin sur `
  + `${chemins.length} ligne(s) — ${new Set(chemins).size} chemin(s) distinct(s)`);
noter(`noms distincts : ${new Set(r.rows.map((x) => x.name)).size} sur ${r.rows.length} `
  + `— c'est normal : un disque a des centaines de dossiers du meme nom.`);

// --- 5. le meme volume, un terme etroit : le plancher n est pas permanent --
const etroit = await chercher(v.letter, 'zz9k_aucun_resultat', 800);
verifier('un terme rare donne un compte complet, pas un plancher',
  !etroit.error && etroit.exact === true && etroit.total === 0,
  `exact=${etroit.exact}, total=${etroit.total} — « au moins » doit disparaitre `
  + 'quand il n a plus rien a dire');

const moyen = await chercher(v.letter, 'package.json', 800);
if (!moyen.error) {
  noter(`« package.json » sur ${v.letter} : total=${moyen.total}, rendu=${moyen.rows.length}, `
    + `exact=${moyen.exact}, tronque=${moyen.truncated}`);
}

const reussies = verifs.filter(Boolean).length;
console.log('');
console.log(`${reussies}/${verifs.length} vérifications passent`);
if (notes.length) {
  console.log('\nMesuré :');
  for (const n of notes) console.log(`  - ${n}`);
}
if (echecs.length) {
  console.log('\nÉchecs :');
  for (const e of echecs) console.log(`  - ${e}`);
  process.exitCode = 1;
}
