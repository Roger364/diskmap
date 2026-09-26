// Ce qui a été MONTRÉ est-il ce qui a été supprimé ? Et à quel prix ?
//
// Deux soupçons, nés en relisant `dry` / `execute` le 26/09/2026, et éprouvés
// ici plutôt que déduits. Tous deux se sont confirmés, et tous deux sont
// corrigés — cette sonde est désormais leur non-régression.
//
// 1. COHÉRENCE. `dry` mémorisait les identifiants d'instantané des éléments
//    montrés ; `execute` les résolvait contre l'instantané **courant**. Une
//    réanalyse qui s'intercale entre les deux — et l'application en lance une
//    après chaque suppression — décale ces identifiants. L'application
//    supprimait alors un fichier qui n'avait jamais été montré.
//
//    Corrigé en deux temps, parce que le premier correctif était incomplet :
//    `execute` ne résout plus rien (il ne supprime que les chemins figés par
//    l'aperçu), et `dry` REFUSE une liste dont la génération d'instantané n'est
//    plus la courante — sans quoi la re-résolution se contentait de se déplacer
//    d'un cran, de l'exécution vers l'aperçu.
//
//    Le protocole : on affiche l'aperçu d'un fichier précis, on retire un
//    fichier placé AVANT lui dans l'ordre de parcours (ce qui décale tous les
//    identifiants suivants d'un cran), on réanalyse, puis on exécute avec le
//    jeton d'avant. L'oracle est le seul qui vaille : **le fichier annoncé est
//    celui qui a disparu, et aucun autre**.
//
// 2. COÛT. Après une suppression réversible, l'application vérifiait la
//    corbeille en relisant les fiches `$I` du volume — pour CHAQUE élément. Le
//    coût était donc N × M (M = nombre de fiches du volume).
//
//    Corrigé par une lecture unique après la boucle. La section 2 ne mesure donc
//    plus « est-ce réparé » mais « le terme quadratique est-il revenu » : trois
//    tailles, un marginal comparé de 1→25 puis de 25→100, et un témoin en mode
//    définitif qui donne le plancher de l'API système.
//
// La sonde ne touche qu'à ses propres fichiers, et reprend dans la corbeille
// ce qu'elle y a laissé.
//
// Usage : node sonde-suppression-lot.mjs http://127.0.0.1:8806/ G
import fs from 'fs';
import path from 'path';

import { dossier, corbeille, aCorbeille, VOLUME_DEFAUT, URL_DEFAUT } from './config.mjs';

const BASE = (process.argv[2] || URL_DEFAUT).replace(/\/$/, '');
const VOL = (process.argv[3] || VOLUME_DEFAUT).toUpperCase();
const DOSSIER_A = dossier(VOL, 'lot-cout');
const DOSSIER_B = dossier(VOL, 'lot-coherence');
// La confirmation se calcule À CHAQUE APPEL, pas une fois pour toutes.
//
// Le définitif la demande toujours. Le « recycle » aussi, mais seulement sur
// un volume SANS corbeille — où FOF_ALLOWUNDO detruit sans prévenir. Or la
// corbeille apparaît en cours de route : `$RECYCLE.BIN` n'existe pas sur un
// volume neuf, et le premier lot la fait naître. Une constante figée au
// chargement serait fausse dès le lot suivant, et la sonde conclurait à un
// défaut de l'application là où il n'y en a pas.
const confirmation = (mode) => (mode === 'permanent' || !aCorbeille(VOL) ? 'EFFACER' : undefined);
const CORBEILLE = corbeille(VOL);
const H = { 'Content-Type': 'application/json', 'X-Diskmap': '1' };
const N_A = 240;   // fichiers du dossier de coût (227 consommés par la section 2)
const N_B = 60;    // fichiers du dossier de cohérence

const verifs = [], echecs = [];
function verifier(nom, cond, mesure) {
  const ok = !!cond; verifs.push(ok);
  if (!ok) echecs.push(`${nom} — mesuré : ${mesure}`);
  console.log(`${ok ? 'ok   ' : 'ROUGE'} ${nom}${ok ? '' : `\n      mesuré : ${mesure}`}`);
}
function constater(t) { console.log(`      constat : ${t}`); }

const post = (chemin, corps) => fetch(BASE + chemin, {
  method: 'POST', headers: H, body: JSON.stringify(corps),
}).then(async r => ({ status: r.status, texte: await r.text() }));

async function repos() {
  for (let i = 0; i < 400; i++) {
    const s = await (await fetch(`${BASE}/api/state`)).json();
    if (!s.scanning) return;
    await new Promise(r => setTimeout(r, 300));
  }
}

const nom = i => `f${String(i).padStart(3, '0')}.txt`;
function monter(dossier, n) {
  fs.mkdirSync(dossier, { recursive: true });
  for (const e of fs.readdirSync(dossier)) fs.unlinkSync(`${dossier}/${e}`);
  for (let i = 1; i <= n; i++) fs.writeFileSync(`${dossier}/${nom(i)}`, `lot ${i}\n`);
}

// Renvoie les sélecteurs ET la génération de l'instantané qui les porte.
// Les séparer était le moyen le plus sûr de les désaccorder : un sélecteur est
// une position, et `dry` refuse désormais une liste qui ne dit pas de quel
// instantané elle vient (mesuré le 26/09/2026 — voir `Snapshot::gen`).
async function idsDuDossier(nomDossier) {
  const dir = (await (await fetch(`${BASE}/api/search?drive=${VOL}&q=${nomDossier}`)).json())
    .rows.find(r => r.name === nomDossier);
  if (!dir) return null;
  const t = await (await fetch(`${BASE}/api/tree?drive=${VOL}&id=${dir.id}&limit=1000`)).json();
  const m = new Map();
  for (const r of t.rows) if (/^f\d+\.txt$/.test(r.name)) m.set(r.name, r.sel);
  return { ids: m, gen: t.gen };
}

// ------------------------------------------------------------------- montage
monter(DOSSIER_A, N_A);
monter(DOSSIER_B, N_B);
await post(`/api/scan/${VOL}`, {});
await repos();
const vA = await idsDuDossier(path.basename(DOSSIER_A));
const vB = await idsDuDossier(path.basename(DOSSIER_B));
verifier('les deux dossiers d’essai sont dans l’instantané',
  vA && vA.ids.size === N_A && vB && vB.ids.size === N_B,
  `coût ${vA ? vA.ids.size : 'absent'}/${N_A}, cohérence ${vB ? vB.ids.size : 'absent'}/${N_B}`);
if (!vA || !vB) process.exit(1);

// ------------------------------------------------- 1. ce qui a été montré
console.log('\n--- 1. le fichier supprimé est-il celui qui a été annoncé ? ---');
const CIBLE = 'f030.txt';
const dryB = JSON.parse((await post('/api/delete', {
  drive: VOL, items: [vB.ids.get(CIBLE)], mode: 'dry', gen: vB.gen,
})).texte);
const annonce = dryB.items[0].path;
console.log(`      l’aperçu annonce : ${annonce}`);
verifier('l’aperçu annonce bien le fichier visé', annonce.endsWith(CIBLE), annonce);

// On retire un fichier placé AVANT dans l'ordre de parcours, puis on réanalyse :
// tous les identifiants suivants se décalent d'un cran.
fs.unlinkSync(`${DOSSIER_B}/${nom(1)}`);
await post(`/api/scan/${VOL}`, {});
await repos();

const exec = await post('/api/delete', { drive: VOL, mode: 'recycle', token: dryB.token, confirm: confirmation('recycle') });
const d = JSON.parse(exec.texte);
console.log(`      réponse : HTTP ${exec.status} · done=${d.done} · failed=${d.failed} · ` +
  `chemin rapporté : ${d.results && d.results[0] ? d.results[0].path : '(aucun)'}`);

const restants = new Set(fs.readdirSync(DOSSIER_B));
const disparus = [];
for (let i = 1; i <= N_B; i++) if (!restants.has(nom(i))) disparus.push(nom(i));
// f001 a été retiré par la sonde elle-même : c'est connu, et ce n'est pas le sujet.
const attendus = [nom(1), CIBLE].sort();
console.log(`      disparus : ${JSON.stringify(disparus.sort())}`);
verifier('c’est le fichier ANNONCÉ qui a disparu, et aucun autre',
  JSON.stringify(disparus.sort()) === JSON.stringify(attendus),
  `annoncé ${CIBLE} ; disparus ${JSON.stringify(disparus)}`);
verifier('le chemin rapporté est celui qui a été montré',
  (d.results || []).every(r => r.path.endsWith(CIBLE)),
  JSON.stringify((d.results || []).map(r => r.path)));

// ------------------------------------------------------------ 2. le coût
console.log('\n--- 2. le coût d’une suppression en lot ---');

// Ce qu'on cherche : un TERME QUADRATIQUE. Le défaut corrigé était N × M —
// relire toutes les fiches de la corbeille pour chaque élément. Un coût
// « fixe + N × constante » est linéaire et acceptable ; une pente qui s'aggrave
// avec N signale que le défaut est revenu.
//
// D'où trois tailles, et non deux : avec deux points, n'importe quelle courbe
// passe par une droite. On mesure donc le marginal 1->25 et le marginal
// 25->100, et on les compare.
//
// Le mode « permanent » sert de TÉMOIN : il ne touche pas à la corbeille et
// n'exécute aucun de nos traitements de réversibilité. Le coût par fichier qu'il
// affiche est donc celui de l'API système, et il donne le plancher incompressible.
async function supprimer(noms, mode) {
  // Relire la liste AVANT chaque lot : le lot précédent a déclenché une
  // réanalyse, donc la génération a changé et les positions ont pu bouger. Un
  // lot mesuré avec les identifiants du lot précédent viserait autre chose —
  // c'est exactement le défaut corrigé le 26/09/2026.
  //
  // Et le relire ne suffit pas toujours : la réanalyse déclenchée par le lot
  // précédent peut se terminer ENTRE la lecture et la simulation, auquel cas le
  // serveur refuse — à raison. Un 409 ici n'est pas un défaut à contourner, c'est
  // la garde qui fait son travail ; on recharge et on réessaie, comme le fait
  // l'interface quand elle affiche « Recharge la liste ».
  let dry = null;
  let dryRep = null;
  for (let essai = 0; essai < 8; essai++) {
    const v = await idsDuDossier(path.basename(DOSSIER_A));
    if (!v) {
      await repos();
      continue;
    }
    // Un nom absent de la liste signifie que l'instantané lu est partiel : la
    // réanalyse Suit encore. Envoyer `sel: undefined` ne donnerait qu'un « corps
    // illisible » — un échec de la sonde qui n'aurait rien à voir avec ce qu'elle
    // mesure. On attend, comme on attend après un 409.
    if (noms.some(n => v.ids.get(n) === undefined)) {
      await repos();
      continue;
    }
    const items = noms.map(n => v.ids.get(n));
    dryRep = await post('/api/delete', { drive: VOL, items, mode: 'dry', gen: v.gen });
    if (dryRep.status === 200) {
      try { dry = JSON.parse(dryRep.texte); } catch { dry = null; }
      if (dry && dry.token) break;
    }
    if (dryRep.status !== 409) {
      return { ms: 0, r: dryRep, n: noms.length, refuse: `HTTP ${dryRep.status} : ${dryRep.texte.slice(0, 120)}` };
    }
    await repos();
  }
  if (!dry || !dry.token) {
    return {
      ms: 0,
      r: dryRep,
      n: noms.length,
      refuse: dryRep
        ? `HTTP ${dryRep.status} : ${String(dryRep.texte).slice(0, 120)}`
        : 'l instantane ne contient pas les fichiers du lot apres 8 tentatives',
    };
  }
  const corps = { drive: VOL, mode, token: dry.token, confirm: confirmation(mode) };
  const t0 = Date.now();
  const r = await post('/api/delete', corps);
  const ms = Date.now() - t0;
  return { ms, r, n: noms.length };
}

// Chaque lot a ses propres fichiers : un lot ne doit pas mesurer le coût d'un
// autre. Découpage dans `nom(1..N_A)`.
const T = {};
let curseur = 1;
for (const [mode, taille] of [['recycle', 1], ['recycle', 25], ['recycle', 100], ['permanent', 1], ['permanent', 100]]) {
  const noms = Array.from({ length: taille }, () => nom(curseur++));
  const m = await supprimer(noms, mode);
  if (m.refuse) { console.log(`ROUGE le lot ${mode}/${taille} a été refusé : ${m.refuse}`); process.exit(1); }
  T[`${mode}/${taille}`] = m.ms;
  let fait = '?';
  if (m.r) {
    // Un refus est un resultat, pas une exception : le parse doit survivre a
    // un corps en clair, sinon la sonde meurt sur le detail au lieu de dire ce
    // que le serveur a repondu.
    try { fait = JSON.parse(m.r.texte).done; } catch { fait = `refus ${m.r.status}`; }
  }
  console.log(`      ${mode.padEnd(9)} ${String(taille).padStart(3)} fichiers : ${String(m.ms).padStart(6)} ms  ${(m.ms / taille).toFixed(1).padStart(6)} ms/fichier  done=${fait}`);
}

const pente1 = (T['recycle/25'] - T['recycle/1']) / 24;
const pente2 = (T['recycle/100'] - T['recycle/25']) / 75;
const pentePerm = (T['permanent/100'] - T['permanent/1']) / 99;
constater(`marginal corbeille : ${pente1.toFixed(1)} ms/fichier de 1 à 25, ${pente2.toFixed(1)} ms/fichier de 25 à 100`);
constater(`marginal définitif (témoin, sans corbeille) : ${pentePerm.toFixed(1)} ms/fichier`);
constater(`coût fixe par requête (un balayage des fiches) : ${T['recycle/1'] - T['permanent/1']} ms`);

verifier('le coût par fichier ne s’aggrave pas avec N — pas de terme quadratique',
  pente2 <= pente1 * 1.5,
  `marginal 1->25 : ${pente1.toFixed(1)} ms/fichier · 25->100 : ${pente2.toFixed(1)} ms/fichier`);

// Si le mode témoin coûte déjà plusieurs dizaines de ms par fichier, alors le
// coût par fichier n'est pas le nôtre : c'est celui de `SHFileOperationW`.
verifier('le coût par fichier est celui de l’API système, et non le nôtre',
  pentePerm > 10,
  `en mode définitif, sans corbeille ni réversibilité : ${pentePerm.toFixed(1)} ms/fichier`);

// --------------------------------------------------------------- nettoyage
//
// Les fichiers supprimés sont dans la corbeille du volume. On les reprend en
// lisant les fiches `$I` — c'est le format que l'application lit elle-même.
function reprendre(marque) {
  let repris = 0;
  let sids = [];
  try { sids = fs.readdirSync(CORBEILLE); } catch { return 0; }
  for (const sid of sids) {
    const dossier = `${CORBEILLE}/${sid}`;
    let fiches = [];
    try { fiches = fs.readdirSync(dossier).filter(n => n.startsWith('$I')); } catch { continue; }
    for (const f of fiches) {
      let b; try { b = fs.readFileSync(`${dossier}/${f}`); } catch { continue; }
      if (b.length < 0x20) continue;
      const n = b.readUInt32LE(0x18);
      if (!n) continue;
      const chemin = b.toString('utf16le', 0x1C, 0x1C + n * 2).replace(/\0.*$/, '');
      if (!chemin.includes(marque)) continue;
      const suffixe = f.slice(2);
      try { fs.unlinkSync(`${dossier}/$R${suffixe}`); } catch { /* déjà parti */ }
      try { fs.unlinkSync(`${dossier}/$I${suffixe}`); repris++; } catch { /* fiche seule */ }
    }
  }
  return repris;
}
const n1 = reprendre(path.basename(DOSSIER_A));
const n2 = reprendre(path.basename(DOSSIER_B));
console.log(`      corbeille : ${n1 + n2} élément(s) d’essai repris (${n1} coût, ${n2} cohérence)`);
for (const d of [DOSSIER_A, DOSSIER_B]) {
  try { for (const e of fs.readdirSync(d)) fs.unlinkSync(`${d}/${e}`); } catch { /* absent */ }
  try { fs.rmdirSync(d); } catch { /* non vide ou absent */ }
}

console.log('');
console.log(`${verifs.filter(Boolean).length}/${verifs.length} vérifications`);
if (echecs.length) { console.log('ÉCHECS :'); for (const e of echecs) console.log(`  - ${e}`); }
process.exit(echecs.length ? 1 : 0);
