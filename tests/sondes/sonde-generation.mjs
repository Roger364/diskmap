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
// Usage : node sonde-generation.mjs http://127.0.0.1:8990/ G
import fs from 'fs';

import { URL_DEFAUT, VOLUME_DEFAUT, attendreDossier, dossier } from './config.mjs';

const BASE = (process.argv[2] || URL_DEFAUT).replace(/\/$/, '');
const VOL = (process.argv[3] || VOLUME_DEFAUT).toUpperCase();
const NOM = 'perime';
const DOSSIER = dossier(VOL, NOM);
const H = { 'Content-Type': 'application/json', 'X-Diskmap': '1' };

// Chaque vérification passe par ICI. Pas seulement pour la mise en forme : une
// sonde qui ne tient pas son décompte sort en 0 avec un résumé illisible, et
// le harnais affiche « SANS SYNTHESE » — la même ligne qu'une sonde MORTE, pour
// vingt-sept vérifications faites. C'est ce qu'affichait celle-ci depuis son
// écriture : un vert muet, indiscernable d'un test qui ne tourne pas.
const verifs = [], echecs = [];
function verifier(nom, cond, mesure) {
  const ok = !!cond; verifs.push(ok);
  if (!ok) echecs.push(`${nom} — mesuré : ${mesure}`);
  console.log(`${ok ? 'ok   ' : 'ROUGE'} ${nom}${ok ? '' : `\n      mesuré : ${mesure}`}`);
}

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
//
// Attendre le DOSSIER, pas la fin d'une analyse.
//
// Le 28/09/2026, cette fonction lisait l'instantane des que `repos()` rendait
// la main, puis levait `TypeError: Cannot read properties of undefined` quand le
// dossier n'y etait pas. Deux defauts dans les six caracteres de `.id` : elle
// mesurait le mauvais instantane -- celui d'avant ses propres ecritures -- et
// elle CRASAIT au lieu de nommer ce qu'elle ne voyait pas. Un `TypeError` dans
// une sonde n'est pas un echec de produit : c'est `SANS SYNTHESE`, donc
// impossible a distinguer d'une sonde morte.
//
// L'attente se fait donc sur le fait, par `attendreDossier`, et l'absence est
// un resultat : elle revient `null` et la sonde la dit.
async function listing() {
  // Le dossier, adresse par son CHEMIN. Par son NOM il se perdait parmi 356
  // `experimental` : la recherche est plafonnee, et un nom courant sort de la
  // premiere page. Le 28/09/2026, `perime` a ainsi disparu d'un instantane ou
  // il existait bel et bien — et la sonde a conclu qu'il n'existait pas.
  //
  // On attend le DOSSIER, pas un de ses fichiers : la sonde en supprime un entre
  // les deux lectures, pour prouver qu'un identifiant designe une position.
  // Attendre `p1.txt` revenait a attendre un fait devenu faux, et le second
  // instantane n'arrivait jamais.
  const t = await attendreDossier(BASE, VOL, DOSSIER);
  if (!t) return { ids: new Map(), gen: null, absent: true };
  return {
    ids: new Map((t.rows || []).filter(x => x.name.endsWith('.txt')).map(x => [x.name, x.sel])),
    gen: t.gen,
    absent: false,
  };
}
fs.mkdirSync(DOSSIER, { recursive: true });
for (const n of ['p1.txt', 'p2.txt', 'p3.txt', 'p4.txt', 'p5.txt']) fs.writeFileSync(`${DOSSIER}/${n}`, `${n}\n`);

await post(`/api/scan/${VOL}`, {});
await repos();

// --- Instantané A : le client lit ici les identifiants ET la génération ------
const A = await listing();
const idP1 = A.ids.get('p1.txt');
console.log(`instantané A (génération ${A.gen}) : p1.txt porte le sélecteur ${idP1}`);
verifier('le dossier de la sonde est dans l’instantané', !A.absent,
  `« ${NOM} » absent après écriture et ré-analyse : l’instantané ne contient pas ce que la sonde vient d’écrire`);
verifier('la réponse /api/tree porte une génération', typeof A.gen === 'number', `gen=${JSON.stringify(A.gen)}`);

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
verifier('un aperçu sur des positions périmées est refusé, et le motif nomme la cause', r1.status === 409, `HTTP ${r1.status}`);

// --- 2. Sans génération du tout : doit être refusé aussi --------------------
const r2 = await post('/api/delete', { drive: VOL, items: [idP1], mode: 'dry' });
console.log('');
console.log(`2. aperçu sans génération : HTTP ${r2.status}`);
console.log(`   ${r2.texte.slice(0, 120)}`);
verifier('un aperçu sans génération est refusé : on ne peut pas supprimer sans dire de quel index on parle', r2.status === 400, `HTTP ${r2.status}`);

// --- 3. Génération CORRECTE : l'aperçu doit viser le bon fichier ------------
const idP2 = B.ids.get('p2.txt');
const r3 = await post('/api/delete', { drive: VOL, items: [idP2], mode: 'dry', gen: B.gen });
const a3 = JSON.parse(r3.texte);
const montre = (a3.items || []).map(i => i.path.replace(/\\/g, '/'));
console.log('');
console.log(`3. aperçu avec la génération ${B.gen} pour le sélecteur de p2.txt : HTTP ${r3.status}`);
for (const p of montre) console.log(`   ${p}`);
verifier('l’aperçu vise bien le fichier dont le sélecteur a été lu',
  montre.some(p => p.endsWith('/p2.txt')), montre.join(', ') || '(aucun élément)');

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
verifier('l’élément hors bornes est présent, marqué bloqué, et compté',
  (a4.items || []).length === 2 && a4.blocked === 1,
  `items=${(a4.items || []).length}, blocked=${a4.blocked}`);

console.log('');
console.log(`${verifs.filter(Boolean).length}/${verifs.length} vérifications vertes`);
if (echecs.length) {
  console.log(`${echecs.length} échec(s)`);
  for (const e of echecs) console.log(`   - ${e}`);
  process.exitCode = 1;
}
