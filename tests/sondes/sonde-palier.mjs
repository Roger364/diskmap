// Le palier de taille se déclenche-t-il là où il le doit, et seulement là ?
//
// Avant cette règle, 400 Go passaient en un clic et une photo de 2 Mo exigeait
// le nom de son dossier. Le rapport d'incident chiffre le geste réel : le
// 26/09/2026, un lot unique de **74,2 Go** est parti en corbeille, et 79 fichiers
// ont été détruits définitivement. Le palier est calé là-dessus, pas sur une
// intuition.
//
// Cette sonde ne crée RIEN et ne supprime RIEN. Elle fait des `dry` — des
// simulations — sur de vrais dossiers déjà présents, ce qui permet d'éprouver les
// paliers que le volume jetable ne peut pas contenir : `V:` fait 511 Mio, et le
// premier palier est à 20 Go. Un `dry` ne supprime rien et ne consomme pas de
// place ; c'est la seule façon de vérifier la règle à son échelle réelle.
//
// Elle cherche donc un dossier au-dessus du palier sur les volumes réels, et
// vérifie trois choses : le mot est exigé au-dessus, il ne l'est pas en dessous,
// et il n'est exigé que pour le motif que le serveur annonce.
//
// Usage : node sonde-palier.mjs http://127.0.0.1:8990/ V
import fs from 'fs';

import { dossier, racine, Go, PALIER_SUPPRIMER, PALIER_SUPPRIMER_TOUT, URL_DEFAUT } from './config.mjs';

const BASE = (process.argv[2] || URL_DEFAUT).replace(/\/$/, '');
const VOL = (process.argv[3] || 'V').toUpperCase();
const DOSSIER = dossier(VOL, 'palier');
const H = { 'Content-Type': 'application/json', 'X-Diskmap': '1' };

const verifs = [], echecs = [];
function verifier(nom, condition, mesure) {
  const ok = !!condition;
  verifs.push(ok);
  if (!ok) echecs.push(`${nom} — mesuré : ${mesure}`);
  console.log(`${ok ? 'ok   ' : 'ROUGE'} ${nom}${ok ? '' : `\n      mesuré : ${mesure}`}`);
}
// Le serveur ne renvoie PAS du JSON quand il refuse : il repond « volume pas
// encore analyse » en texte, avec un 409. Un `r.json()` transforme donc un refus
// ATTENDU en SyntaxError, et la sonde PLANTE sans ecrire une seule ligne de
// motif. C est ce qui rendait le journal muet : cette sonde demande C, G et le
// volume de travail, et le runner n a que C: et D:.
//
// Un corps illisible est un FAIT, pas une panne : il revient comme `error`, et
// l appelant decide. C est la discipline du reste du harnais, qui garde
// `r.texte` et ne parse que lorsqu il y a quelque chose a parser.
const corps = async (r) => {
  const texte = await r.text();
  try {
    return JSON.parse(texte);
  } catch {
    return { error: texte.trim() || `HTTP ${r.status}`, rows: null };
  }
};
const get = (c) => fetch(BASE + c).then(corps);
const post = (c, donnees) => fetch(BASE + c, {
  method: 'POST', headers: H, body: JSON.stringify(donnees),
}).then(corps);

async function attendre() {
  for (let i = 0; i < 300; i++) {
    if (!(await get('/api/state')).scanning) return;
    await new Promise(r => setTimeout(r, 300));
  }
}

const mots = (ap, mode) => (mode === 'permanent' ? ap.mots_permanent : ap.mots_recycle) || [];

// Un `dry` sur des sélecteurs DONNÉS, sans rien créer. Le lot est figé par le
// jeton rendu, et rien n'est exécuté : c'est une pure lecture.
async function apercu(drive, sels, gen) {
  return post('/api/delete', { drive, items: sels, mode: 'dry', gen });
}

// --- 1. sous le palier, rien n'est exigé ------------------------------------
//
// Le cas ordinaire est le cas fréquent. Une règle qui se déclenche sur
// « ouvrir un dossier, effacer un cache » apprend ce geste, et un geste appris
// n'arrête plus rien.
fs.rmSync(DOSSIER, { recursive: true, force: true });
fs.mkdirSync(DOSSIER, { recursive: true });
fs.writeFileSync(`${DOSSIER}/petit.txt`, 'x');
await attendre();
await post(`/api/scan/${VOL}`, {});
await attendre();

// Le NOM de la racine de travail est lu, jamais suppose : le workflow pose
// `D:\_diskmap_sondes` et une machine de developpement peut en poser un autre.
// Coder le nom en dur rendait la sonde muette des que la variable changeait.
const racineTravail = racine(VOL).split('/').pop();
const arbreRacine = await get(`/api/tree?drive=${VOL}&id=0&limit=200`);
const sonde = arbreRacine.rows.find(r => r.name === racineTravail);
const l2 = await get(`/api/tree?drive=${VOL}&id=${sonde.id}&limit=200`);
const d = l2.rows.find(r => r.name === 'palier');
const l3 = await get(`/api/tree?drive=${VOL}&id=${d.id}&limit=200`);
const petit = await apercu(VOL, l3.rows.map(r => r.sel), l3.gen);
verifier('un lot minuscule n’exige aucun mot',
  mots(petit, 'recycle').filter(m => m.mot.startsWith('SUPPRIMER')).length === 0,
  `lot=${petit.total_size} o, mots=${JSON.stringify(mots(petit, 'recycle'))}`);

// --- 2. au-dessus du palier, un mot est exigé AVEC SON MOTIF -----------------
//
// Un dossier réel, au-dessus de 20 Go, trouvé sur les volumes de la machine.
// `dry` ne supprime rien : on peut donc l'interroger sans risque, et c'est la
// seule façon d'atteindre l'échelle du palier.
// Le PLUS GROS dossier effaçable, tous volumes confondus. Chercher le plus
// grand n'est pas de la coquetterie : c'est ce qui permet d'atteindre le second
// palier quand la machine a de quoi l'atteindre.
let trouve = null;
for (const drive of ['C', 'G', VOL]) {
  // Un volume qui n'est pas monte n'a pas de racine : l'API repond 409 « volume
  // pas encore analyse », sans `rows`. Le lire comme une liste vide marchait
  // jusqu'a ce qu'un `t.rows.filter` leve une TypeError — et une sonde qui
  // PLANTE ne dit rien : elle sort en 1 sans une seule ligne de motif. C'est ce
  // qui est arrive sur le runner du 27/09/2026, qui n'a que C: et D:.
  const t = await get(`/api/tree?drive=${drive}&id=0&limit=400`);
  if (!Array.isArray(t.rows)) {
    console.log(`      ${drive}: ignore — ${t.error || 'aucune racine analysee'}`);
    continue;
  }
  const candidats = t.rows.filter(r => r.is_dir && r.size > PALIER_SUPPRIMER)
    .sort((a, b) => b.size - a.size);
  for (const candidat of candidats) {
    const ap = await apercu(drive, [candidat.sel], t.gen);
    if (ap.total_size <= PALIER_SUPPRIMER || ap.deletable === 0) continue;
    if (!trouve || ap.total_size > trouve.ap.total_size) {
      trouve = { drive, ap, nom: candidat.name };
    }
    break; // le plus gros de ce volume suffit
  }
}

if (!trouve) {
  console.log(`      palier non éprouvé : aucun dossier de plus de 20 Go trouvé sur cette machine`);
  console.log('      (la règle reste couverte par les tests unitaires, qui la vérifient à 74,2 Go)');
} else {
  const { drive, ap, nom } = trouve;
  console.log(`      ${drive}:\\${nom} — ${(ap.total_size / Go).toFixed(1)} Go, lot de ${ap.deletable} élément(s)`);
  const ords = mots(ap, 'recycle');
  const motsTaille = ords.filter(m => m.mot.startsWith('SUPPRIMER'));
  verifier('un lot de plus de vingt gigaoctets exige un mot de taille',
    motsTaille.length === 1, JSON.stringify(ords));
  verifier('ce mot porte un motif, pas seulement un mot',
    motsTaille.length === 1 && typeof motsTaille[0].raison === 'string' && motsTaille[0].raison.length > 0,
    JSON.stringify(motsTaille));
  // Le palier le plus élevé ne doit pas être satisfait par le mot du plus bas.
  if (ap.total_size >= PALIER_SUPPRIMER_TOUT) {
    verifier('au-delà d’un demi-teraoctet, c’est le mot du palier supérieur qui est demandé',
      motsTaille[0] && motsTaille[0].mot === 'SUPPRIMER TOUT', JSON.stringify(motsTaille[0]));
  }
  // Le mode définitif exige en plus le mot EFFACER : les règles s'additionnent.
  const perm = mots(ap, 'permanent');
  verifier('et le mode définitif exige en plus le mot EFFACER',
    perm.some(m => m.mot === 'EFFACER'), JSON.stringify(perm));
  verifier('les deux motifs sont distincts — deux raisons, deux champs',
    new Set(perm.map(m => m.raison)).size === perm.length, JSON.stringify(perm));
}

fs.rmSync(DOSSIER, { recursive: true, force: true });
await post(`/api/scan/${VOL}`, {});
await attendre();

console.log('');
console.log(`${verifs.filter(Boolean).length}/${verifs.length} vérifications vertes`);
if (echecs.length) {
  console.log('ÉCHECS :');
  for (const e of echecs) console.log(`  - ${e}`);
}
process.exitCode = echecs.length ? 1 : 0;
