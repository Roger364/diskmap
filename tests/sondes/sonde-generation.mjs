// Un identifiant d'élément désigne-t-il encore le même fichier après une
// ré-analyse ?
//
// Un identifiant n'est PAS une identité : c'est une POSITION dans le vecteur de
// l'instantané (`snap.file_path(id)` renvoie `snap.files[id]`). Re-résoudre une
// position contre un instantané plus récent revient donc à viser un autre
// fichier.
//
// Défaut mesuré le 26/09/2026, avant correctif : `p1.txt` portait l'identifiant
// 16 ; après suppression de `p1.txt`, ajout d'un fichier et ré-analyse,
// l'identifiant 16 désignait `p2.txt` — et l'aperçu demandé avec l'ancien
// identifiant proposait `G:\_diskmap_perime\p2.txt`, `blocked=false`.
//
// Correctif : chaque instantané porte une génération ; `dry` exige celle du
// client et refuse si l'index a bougé.
//
// La sonde ne supprime RIEN par l'application : que des `dry`. Un défaut qui se
// démontre sans rien détruire se démontre plus souvent.
//
// Usage : node sonde-id-perime.mjs http://127.0.0.1:8806/ G
import fs from 'fs';

import { dossier, VOLUME_DEFAUT, URL_DEFAUT } from './config.mjs';

const BASE = (process.argv[2] || URL_DEFAUT).replace(/\/$/, '');
const VOL = (process.argv[3] || VOLUME_DEFAUT).toUpperCase();
const NOM = 'perime';
const DOSSIER = dossier(VOL, NOM);
const H = { 'Content-Type': 'application/json', 'X-Diskmap': '1' };
const rouges = [];

const post = (c, corps) => fetch(BASE + c, { method: 'POST', headers: H, body: JSON.stringify(corps) })
  .then(async r => ({ status: r.status, texte: await r.text() }));

async function repos() {
  for (let i = 0; i < 400; i++) {
    const s = await (await fetch(`${BASE}/api/state`)).json();
    if (!s.scanning) return;
    await new Promise(r => setTimeout(r, 300));
  }
}

// Le nom ET la génération : c'est l'ensemble que le client détient. On retient
// le `sel` et non le `id` brut : c'est lui que l'interface renvoie, et lui seul
// porte le type (voir `scan::BIT_FICHIER`).
async function listing() {
  const dir = (await (await fetch(`${BASE}/api/search?drive=${VOL}&q=${NOM}`)).json())
    .rows.find(r => r.name === NOM);
  const t = await (await fetch(`${BASE}/api/tree?drive=${VOL}&id=${dir.id}&limit=200`)).json();
  return { ids: new Map(t.rows.filter(r => r.name.endsWith('.txt')).map(r => [r.name, r.sel])), gen: t.gen };
}

fs.mkdirSync(DOSSIER, { recursive: true });
for (const n of ['p1.txt', 'p2.txt', 'p3.txt', 'p4.txt', 'p5.txt']) fs.writeFileSync(`${DOSSIER}/${n}`, `${n}\n`);

await post(`/api/scan/${VOL}`, {});
await repos();

// --- Instantané A : le client lit ici les identifiants ET la génération ------
const A = await listing();
const idP1 = A.ids.get('p1.txt');
console.log(`instantané A (génération ${A.gen}) : p1.txt porte le sélecteur ${idP1}`);
if (typeof A.gen !== 'number') { console.log('ROUGE la réponse /api/tree ne porte aucune génération'); rouges.push('génération absente'); }

// --- Le disque change, et une ré-analyse rebase les positions ---------------
fs.unlinkSync(`${DOSSIER}/p1.txt`);
fs.writeFileSync(`${DOSSIER}/zzz-neuf.txt`, 'arrivé après\n');
await post(`/api/scan/${VOL}`, {});
await repos();

const B = await listing();
const nomMaintenant = [...B.ids.entries()].find(([, id]) => id === idP1)?.[0];
console.log(`instantané B (génération ${B.gen}) : le sélecteur ${idP1} désigne maintenant ${nomMaintenant ?? '(rien)'}`);
console.log('');

// --- 1. Aperçu demandé avec la génération PÉRIMÉE : doit être refusé ---------
const r1 = await post('/api/delete', { drive: VOL, items: [idP1], mode: 'dry', gen: A.gen });
console.log(`1. aperçu avec la génération ${A.gen} (périmée) : HTTP ${r1.status}`);
console.log(`   ${r1.texte.slice(0, 150)}`);
if (r1.status === 409) {
  console.log('ok    refusé, et le motif nomme la cause');
} else {
  console.log('ROUGE un aperçu a été produit sur des positions périmées');
  rouges.push('positions périmées acceptées');
}

// --- 2. Sans génération du tout : doit être refusé aussi --------------------
const r2 = await post('/api/delete', { drive: VOL, items: [idP1], mode: 'dry' });
console.log('');
console.log(`2. aperçu sans génération : HTTP ${r2.status}`);
console.log(`   ${r2.texte.slice(0, 120)}`);
if (r2.status === 400) {
  console.log('ok    refusé : on ne peut pas supprimer sans dire de quel index on parle');
} else {
  console.log('ROUGE un aperçu a été produit sans génération');
  rouges.push('génération facultative');
}

// --- 3. Génération CORRECTE : l'aperçu doit viser le bon fichier ------------
const idP2 = B.ids.get('p2.txt');
const r3 = await post('/api/delete', { drive: VOL, items: [idP2], mode: 'dry', gen: B.gen });
const a3 = JSON.parse(r3.texte);
const montre = (a3.items || []).map(i => i.path.replace(/\\/g, '/'));
console.log('');
console.log(`3. aperçu avec la génération ${B.gen} pour le sélecteur de p2.txt : HTTP ${r3.status}`);
for (const p of montre) console.log(`   ${p}`);
if (montre.some(p => p.endsWith('/p2.txt'))) {
  console.log('ok    l’aperçu vise bien le fichier dont le sélecteur a été lu');
} else {
  console.log('ROUGE l’aperçu ne vise pas p2.txt');
  rouges.push('aperçu hors cible');
}

// --- 4. Sélecteur hors bornes : doit être SIGNALÉ, pas oublié --------------
const nFiles = (await (await fetch(`${BASE}/api/state`)).json()).drives.find(d => d.letter === VOL)?.n_files ?? 0;
// Sélecteur de FICHIER hors bornes : le bit de type est mis, la position non.
//
// `>>> 0` est indispensable : le serveur attend un `u32`, et `(n + 0x80000000)`
// en JavaScript est un nombre NÉGatif (les entiers y sont sur 32 bits signés).
// Sans cette conversion, la sonde enverrait un entier négatif et le serveur
// répondrait « corps illisible » — un échec de sonde qui n'aurait rien à voir
// avec ce qu'elle mesure.
const trop = ((nFiles + 500_000) | 0x80000000) >>> 0;
const r4 = await post('/api/delete', { drive: VOL, items: [idP2, trop], mode: 'dry', gen: B.gen });
const a4 = JSON.parse(r4.texte);
console.log('');
console.log(`4. aperçu demandé pour 2 éléments dont un hors bornes (sel=${trop}) : ${(a4.items || []).length} élément(s)`);
for (const i of a4.items || []) console.log(`   ${i.path}   blocked=${i.blocked} raison="${i.reason}"`);
if ((a4.items || []).length === 2 && a4.blocked === 1) {
  console.log('ok    l’élément hors bornes est présent, marqué bloqué, et compté');
} else {
  console.log(`ROUGE l’élément hors bornes a disparu sans un mot (items=${(a4.items || []).length}, blocked=${a4.blocked})`);
  rouges.push('oubli silencieux');
}

console.log('');
console.log(rouges.length === 0 ? 'vert  aucun défaut' : `ROUGE ${rouges.length} défaut(s) : ${rouges.join(', ')}`);
process.exitCode = rouges.length === 0 ? 0 : 1;
