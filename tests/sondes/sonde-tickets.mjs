// La promesse d'une analyse est-elle tenue, et mesurée ?
//
// Le 28/09/2026, une demande d'analyse faite pendant une analyse en cours était
// acceptée (`{"ok":true}`) puis perdue : le serveur jettait la demande quand le
// volume était déjà en cours, sans un mot. R15 raconte le défaut ; le serveur
// répond désormais `{ok, ticket}` et publie `scan_requested` / `scan_completed`.
// Le 29/09/2026, ce contrat était écrit côté serveur — mais AUCUN client ne le
// consommait : l'interface et les sondes attendaient encore le drapeau global,
// dont la mesure a montré qu'il ment dans l'intervalle entre deux analyses.
//
// Cette sonde éprouve le contrat du point de vue du client, et ne conclut sur
// AUCUN drapeau :
//
//   1. la réponse du POST porte un ticket numérique ;
//   2. deux demandes rapprochées pendant un scan en cours donnent deux tickets
//      distincts et croissants — la coalescence mesurée, pas seulement testée
//      en Rust : deux demandes, UNE analyse de plus, et le second ticket désigne
//      la même analyse que le premier ;
//   3. quand `scan_completed >= ticket`, le fichier créé AVANT la demande est
//      dans l'instantané — la promesse couvre bien ce qui précède la demande,
//      pas seulement le disque au moment où le scan a démarré ;
//   4. `/api/state` publie bien `scan_requested >= scan_completed` en tout
//      instant — un achevé qui dépasserait le demandé serait une fenêtre de
//      publication déchirée.
//
// Elle n'attend jamais `!scanning` pour conclure : l'attente par ticket est le
// sujet ; l'attente par le fait (`attendreFichier`) reste la preuve
// d'existence, et les deux verdissent ensemble ici ou pas du tout.
//
// Elle ne supprime RIEN : elle crée un dossier et un fichier sous la racine de
// travail, puis les retire elle-même à la fin. Usage :
//   node sonde-tickets.mjs http://127.0.0.1:8990/ G
import fs from 'fs';

import { URL_DEFAUT, VOLUME_DEFAUT, attendreTicket, attendreFichier, dossier } from './config.mjs';

const BASE = (process.argv[2] || URL_DEFAUT).replace(/\/$/, '');
const VOL = (process.argv[3] || VOLUME_DEFAUT).toUpperCase();
const NOM = 'tickets';
const DOSSIER = dossier(VOL, NOM);
const FICHIER = 'cree-avant-la-demande.txt';
const H = { 'Content-Type': 'application/json', 'X-Diskmap': '1' };

const verifs = [], echecs = [];
function verifier(nom, cond, mesure) {
  const ok = !!cond; verifs.push(ok);
  if (!ok) echecs.push(`${nom} — mesuré : ${mesure}`);
  console.log(`${ok ? 'ok   ' : 'ROUGE'} ${nom}${ok ? '' : `\n      mesuré : ${mesure}`}`);
}

const post = (c, corps) => fetch(BASE + c, { method: 'POST', headers: H, body: JSON.stringify(corps) })
  .then(async r => ({ status: r.status, texte: await r.text() }));

async function etatVolume() {
  const s = await (await fetch(`${BASE}/api/state`)).json();
  return (s.drives || []).find(d => d.letter === VOL) || null;
}

// Demander une analyse et rendre le ticket promis. La réponse sans ticket est
// un échec de sonde, pas un verdict : le serveur qui ne répondrait plus
// `{ok, ticket}` casserait tout le harnais d'un coup, et il faut le voir.
async function demander() {
  const r = await post(`/api/scan/${VOL}`, {});
  const corps = (() => { try { return JSON.parse(r.texte); } catch { return null; } })();
  if (r.status !== 200 || !corps || typeof corps.ticket !== 'number') {
    throw new Error(`POST /api/scan a répondu ${r.status} sans ticket : ${r.texte.slice(0, 120)}`);
  }
  return corps.ticket;
}

// -------------------------------------------------------------- préparation
fs.mkdirSync(DOSSIER, { recursive: true });
fs.writeFileSync(`${DOSSIER}/${FICHIER}`, 'écrit avant la demande d’analyse\n');

// --- 1. le contrat de base : un ticket, puis la publication de CE ticket ----
console.log('--- 1. un ticket demandé est un ticket publié ---');
const t1 = await demander();
console.log(`      ticket rendu : ${t1}`);
verifier('la réponse /api/scan porte un ticket numérique', typeof t1 === 'number' && Number.isFinite(t1), `ticket=${JSON.stringify(t1)}`);

// L'attente ET la capture en vol, dans la MÊME boucle : une fois le ticket
// publié, l'analyse ne court plus, et une vérification lue après coup ne verrait
// jamais `scan_running` — mesuré : la première version de cette sonde appelait
// `attendreTicket` PUIS cherchait l'état en vol, et concluait « trop rapide »
// sur un G: de 13 s. L'état en vol se capture pendant qu'il y est.
let publie = null, vuEnVol = null;
for (let i = 0; i < 600 && !publie; i++) {
  const d = await etatVolume();
  if (d) {
    if (d.status === 'scanning') vuEnVol = d;
    if (d.scan_completed >= t1) publie = d;
  }
  await new Promise((r) => setTimeout(r, 300));
}
verifier('le ticket demandé est publié par /api/state', !!publie,
  publie ? `scan_completed=${publie.scan_completed} < ${t1}` : 'ticket jamais publié (délai ou arrêt)');
console.log(`      état publié : scan_completed=${publie ? publie.scan_completed : '(rien)'}`);
if (vuEnVol) {
  verifier('l’analyse en vol annonce son ticket (scan_running)',
    typeof vuEnVol.scan_running === 'number' && vuEnVol.scan_running >= 1,
    `scan_running=${JSON.stringify(vuEnVol.scan_running)} pendant le vol`);
} else {
  console.log('note : l’analyse n’a pas été vue en vol (volume trop rapide) — scan_running non exercé ici');
}
verifier('à la publication du ticket, l’analyse en vol n’est plus annoncée',
  !publie || publie.scan_running === 0,
  publie ? `scan_running=${publie.scan_running} alors que scan_completed=${publie.scan_completed}` : 'jamais publié');

// La preuve d'existence, à l'instant où le ticket est publié : le fichier créé
// AVANT la demande doit être dans l'instantané. C'est le cœur du contrat R15 —
// une analyse postérieure à la demande couvre ce qui existait avant elle.
const vu = publie
  ? await attendreFichier(BASE, VOL, DOSSIER, FICHIER, 10)
  : null;
verifier('l’instantané publié sous CE ticket contient le fichier créé avant la demande', !!vu,
  `« ${FICHIER} » absent de « ${DOSSIER} » alors que scan_completed >= ${t1}`);

// --- 2. la coalescence, mesurée --------------------------------------------
console.log('\n--- 2. deux demandes rapprochées ---');
// Deux POST l'un derrière l'autre, sans attendre entre eux : si l'analyse du
// premier court encore quand le second arrive, le serveur l'absorbe dans la
// même tâche (une seule analyse de plus pour deux demandes). Sur un volume
// rapide, le premier scan peut être fini avant le second POST : le cas n'est
// alors pas exercé — et la sonde le DIT, au lieu de prétendre.
const t3 = await demander();
const s3 = await (await fetch(`${BASE}/api/state`)).json();
const enVol = s3 && s3.scanning === VOL;
const t4 = await demander();
console.log(`      tickets rendus : ${t3}, puis ${t4}` +
  (enVol ? ' — le second est arrivé pendant l’analyse du premier' : ' (analyse du premier déjà finie : coalescence non exercée)'));
verifier('deux demandes rapprochées rendent des tickets distincts', t4 !== t3, `${t3} puis ${t4}`);
verifier('les tickets sont croissants', t4 > t3, `${t3} → ${t4}`);
// Invariant inconditionnel : le(s) scan(s) fini(s) honorent bien le DERNIER
// ticket demandé.
const apres = await attendreTicket(BASE, VOL, t4);
verifier('le dernier ticket demandé est publié', !!apres && apres.scan_completed >= t4,
  apres ? `scan_completed=${apres.scan_completed} < ${t4}` : 'jamais publié');
// Quand la coalescence a été exercée, la publication qui honore t3 porte
// AUSSI t4 (la tâche en file lit le dernier ticket au démarrage) : une seule
// analyse pour deux demandes — la borne qui interdit dix passages pour dix
// demandes. Ce verdict est CONDITIONNEL au fait observé ci-dessus, sinon il
// ne prouverait que la rapidité de la machine.
if (enVol) {
  const publie3 = await attendreTicket(BASE, VOL, t3);
  verifier('deux demandes coalescées sont honorées par la même publication',
    !!publie3 && publie3.scan_completed >= t4,
    publie3 ? `la publication de ${t3} porte scan_completed=${publie3.scan_completed} < ${t4}` : 'jamais publié');
} else {
  console.log('note : coalescence pendant un scan en vol non exercée sur ce volume (trop rapide) — elle reste prouvée côté Rust');
}

// --- 3. l'invariant de publication ------------------------------------------
console.log('\n--- 3. l’état publié reste cohérent ---');
const s = await etatVolume();
verifier('scan_completed ne dépasse jamais scan_requested',
  !s || s.scan_completed <= s.scan_requested,
  `completed=${s && s.scan_completed}, requested=${s && s.scan_requested}`);

// ------------------------------------------------------------------ ménage
try { fs.rmSync(DOSSIER, { recursive: true, force: true }); } catch { /* déjà parti */ }

console.log('');
console.log(`${verifs.filter(Boolean).length}/${verifs.length} vérifications vertes`);
if (echecs.length) {
  console.log(`${echecs.length} échec(s)`);
  for (const e of echecs) console.log(`   - ${e}`);
  process.exitCode = 1;
}
