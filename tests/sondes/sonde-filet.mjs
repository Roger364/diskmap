// Le filet de sécurité tient-il, quand on joue le scénario de l'incident ?
//
// C'est la sonde la plus importante du dépôt, et la seule dont l'échec prouverait
// quelque chose sur les DONNÉES plutôt que sur le code.
//
// Le 26/09/2026, une sonde de coût a détruit 65 fichiers réels et en a envoyé
// 68 à la corbeille. Elle envoyait des identifiants, le serveur les a résolus
// contre un index réanalysé, et les chemins visés désignaient d'autres fichiers
// que les siens. Le harnais a partagé la faute : il ne filait qu'à l'échange.
//
// Cette sonde rejoue la MECHANIQUE, sur un fichier à elle : un `dry` qui
// annonce un chemin hors de la racine de travail, puis l'exécution de ce jeton.
// Le filet doit refuser, et le fichier doit être encore là.
//
// Elle commence par vérifier que le filet est bien interposé (`GET /filet`).
// Jouée contre un serveur nu, elle supprimerait pour de vrai le fichier de son
// scénario — un fichier qu'elle a créé, donc un dégât borné, mais un dégât
// quand même. Sans filet, elle s'abstient et sort en 2.
//
// Usage : node sonde-filet.mjs http://127.0.0.1:8990/ V

import fs from 'fs';
import path from 'path';

import { dossier, racine, VOLUME_DEFAUT, URL_DEFAUT } from './config.mjs';

const BASE = (process.argv[2] || URL_DEFAUT).replace(/\/$/, '');
const VOL = (process.argv[3] || VOLUME_DEFAUT).toUpperCase();
const H = { 'Content-Type': 'application/json', 'X-Diskmap': '1' };

// Hors de la racine, exprès. C'est le dossier que le filet doit surveiller de
// près parce qu'il n'y touche pas.
const HORS = path.join(path.dirname(racine(VOL)), `hors-filet-${process.pid}`);
const CIBLE = path.join(HORS, 'cible.txt');

const verifs = [], echecs = [];
function verifier(nom, cond, mesure) {
  const ok = !!cond;
  verifs.push(ok);
  if (!ok) echecs.push(`${nom} — mesuré : ${mesure}`);
  console.log(`${ok ? 'ok   ' : 'ROUGE'} ${nom}${ok ? '' : `\n      mesuré : ${mesure}`}`);
}
async function post(c, corps) {
  return fetch(BASE + c, { method: 'POST', headers: H, body: JSON.stringify(corps) })
    .then(async r => ({ status: r.status, texte: await r.text() }));
}
async function repos() {
  for (let i = 0; i < 400; i++) {
    const s = await (await fetch(`${BASE}/api/state`)).json();
    if (!s.scanning) return;
    await new Promise(r => setTimeout(r, 300));
  }
}

// --- 0. le filet est-il interposé ? ---------------------------------------
console.log('--- 0. le filet est-il là ? ---');
let marque = null;
try {
  marque = await (await fetch(`${BASE}/filet`)).json();
} catch { marque = null; }
if (!marque || !marque.filet) {
  console.log('PAS PU EPROUVER : aucun filet devant le serveur.');
  console.log('  Jouée telle quelle contre un serveur nu, cette sonde supprimerait');
  console.log('  le fichier de son scénario. Passez par lancer.mjs.');
  process.exit(2);
}
verifier('un proxy de garde répond avant le serveur', true, `${marque.racines} racine(s)`);

// --- 1. le fichier témoin, hors racine ------------------------------------
fs.mkdirSync(HORS, { recursive: true });
fs.writeFileSync(CIBLE, `temoin\n`);
verifier('le fichier témoin existe, hors de la racine',
  fs.existsSync(CIBLE) && !CIBLE.toUpperCase().startsWith(racine(VOL).toUpperCase()),
  `${CIBLE} vs racine ${racine(VOL)}`);

// On vient de créer le dossier : l'instantané ne le connaît pas encore. Sans
// cette réanalyse, la recherche ne le trouve pas et la sortie serait « pas pu
// éprouver » — un refus prudent, mais qui ne prouverait rien du filet.
await post(`/api/scan/${VOL}`, {});
await repos();

const s = await (await fetch(`${BASE}/api/search?drive=${VOL}&q=${path.basename(HORS)}`)).json();
const dir = s.rows.find(r => r.name === path.basename(HORS));
if (!dir) {
  console.log(`PAS PU EPROUVER : ${path.basename(HORS)} absent de l'instantané de ${VOL}:`);
  console.log('  Lancez une analyse du volume avant les sondes.');
  try { fs.rmSync(HORS, { recursive: true, force: true }); } catch { /* déjà parti */ }
  process.exit(2);
}
const t = await (await fetch(`${BASE}/api/tree?drive=${VOL}&id=${dir.id}&limit=50`)).json();
const ligne = t.rows.find(r => r.name === 'cible.txt');
if (!ligne) {
  console.log('PAS PU EPROUVER : le fichier témoin n’est pas dans l’instantané.');
  try { fs.rmSync(HORS, { recursive: true, force: true }); } catch { /* déjà parti */ }
  process.exit(2);
}

// --- 2. l'aperçu est honnête, et le filet voit le débordement --------------
console.log('\n--- 2. un aperçu hors racine est-il signalé, puis neutralisé ? ---');
const dry = JSON.parse((await post('/api/delete', {
  drive: VOL, items: [{ id: ligne.id, is_dir: false }], mode: 'dry', gen: t.gen,
})).texte);

verifier('l’aperçu annonce bien le fichier hors racine',
  dry.items[0].path.replace(/\//g, '\\').toUpperCase() === CIBLE.toUpperCase(),
  `« ${dry.items[0].path} »`);
verifier('le serveur ne le déclare PAS bloqué — sans quoi il n’y aurait rien à prouver',
  dry.items[0].blocked === false,
  `blocked=${dry.items[0].blocked}, raison « ${dry.items[0].reason} »`);

// --- 3. l'exécution de ce jeton doit être refusée --------------------------
console.log('\n--- 3. l’exécution de ce jeton est-elle refusée ? ---');
const exec = await post('/api/delete', { drive: VOL, mode: 'recycle', token: dry.token, confirm: 'EFFACER' });
verifier('le filet refuse (403)', exec.status === 403, `HTTP ${exec.status} — ${exec.texte.slice(0, 120)}`);
verifier('le refus nomme le filet', /filet/i.test(exec.texte), exec.texte.slice(0, 120));
verifier('le fichier témoin est TOUJOURS là', fs.existsSync(CIBLE),
  'le fichier a disparu : le filet n’a pas tenu');

// --- 4. et un volume non surveillé, pareil --------------------------------
console.log('\n--- 4. un volume que le filet ne surveille pas ---');
const jeton = dry.token;
const aut = await post('/api/delete', { drive: VOL, mode: 'recycle', token: jeton, confirm: 'EFFACER' });
verifier('le filet refuse (403)', aut.status === 403, `HTTP ${aut.status} — ${aut.texte.slice(0, 120)}`);
verifier('le fichier témoin est TOUJOURS là', fs.existsSync(CIBLE), 'le fichier a disparu');

// --- 5. le jeton est-il resté inutilisable ? -------------------------------
console.log('\n--- 5. le jeton reste-t-il inutilisable ? ---');
const rejoue = await post('/api/delete', { drive: VOL, mode: 'recycle', token: jeton, confirm: 'EFFACER' });
verifier('une seconde tentative est refusée elle aussi', rejoue.status === 403, `HTTP ${rejoue.status}`);
verifier('le fichier témoin est TOUJOURS là', fs.existsSync(CIBLE), 'le fichier a disparu');

// --- 6. dans la racine, en revanche, ça fonctionne ------------------------
console.log('\n--- 6. un fichier DANS la racine passe, lui ---');
const DEDANS = dossier(VOL, 'filet');
fs.mkdirSync(DEDANS, { recursive: true });
fs.writeFileSync(path.join(DEDANS, 'pave.txt'), 'dans la racine\n');
await post(`/api/scan/${VOL}`, {});
await repos();
const s2 = await (await fetch(`${BASE}/api/search?drive=${VOL}&q=${path.basename(DEDANS)}`)).json();
const d2 = s2.rows.find(r => r.name === path.basename(DEDANS));
const t2 = d2 ? await (await fetch(`${BASE}/api/tree?drive=${VOL}&id=${d2.id}&limit=50`)).json() : { rows: [], gen: 0 };
const pave = t2.rows.find(r => r.name === 'pave.txt');
if (!pave) {
  console.log('PAS PU EPROUVER : le pavé n’est pas dans l’instantané.');
} else {
  const d2r = JSON.parse((await post('/api/delete', {
    drive: VOL, items: [{ id: pave.id, is_dir: false }], mode: 'dry', gen: t2.gen,
  })).texte);
  const e2 = await post('/api/delete', { drive: VOL, mode: 'recycle', token: d2r.token, confirm: 'EFFACER' });
  verifier('le filet laisse passer ce qui est sous la racine', e2.status === 200, `HTTP ${e2.status} — ${e2.texte.slice(0, 120)}`);
  verifier('le pavé a bien disparu', !fs.existsSync(path.join(DEDANS, 'pave.txt')), 'il est encore là');
}

// --- 7. le silence --------------------------------------------------------
console.log('\n--- 7. le témoin disparaît avec la sonde ---');
try { fs.rmSync(HORS, { recursive: true, force: true }); } catch { /* déjà parti */ }
try { fs.rmSync(DEDANS, { recursive: true, force: true }); } catch { /* déjà parti */ }
verifier('rien n’est laissé du scénario', !fs.existsSync(CIBLE) && !fs.existsSync(DEDANS), 'il reste des fichiers');

console.log('');
console.log(`  ${verifs.filter(Boolean).length}/${verifs.length} vérifications`);
if (echecs.length) {
  console.log('ÉCHECS :');
  for (const e of echecs) console.log(`  - ${e}`);
  process.exit(1);
}
process.exit(0);
