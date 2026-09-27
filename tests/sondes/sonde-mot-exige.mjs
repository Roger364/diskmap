// Le mot exigé est-il celui que le serveur va EXIGER, et pas un autre ?
//
// Une instance élevée rend tout effaçable : les ACL ne s'appliquent plus, et
// les fichiers que les droits du compte interdisaient passent. L'interface le
// disait dans un bandeau — un bandeau n'est pas une règle, il se ferme avec
// l'onglet. Le serveur exige désormais le mot `EFFACER` dans ce contexte, comme
// pour une suppression définitive.
//
// Cette sonde ne peut pas exécuter une suppression élevée : elle n'a pas les
// droits, et il ne s'agit pas d'en obtenir. Elle vérifie donc ce qui est
// VÉRIFIABLE SANS SUPPRIMER : que l'aperçu annonce le mot du bon mode, et que
// le serveur refuse l'exécution qui ne le fournit pas.
//
// Le refus est éprouvé avec un jeton INERTE — un sélecteur hors bornes, que la
// résolution ne peut pas résoudre. La boucle d'exécution tourne, le contrôle
// d'accès est passé, et rien n'est touché : par construction, pas par chance.
//
// Usage : node sonde-mot-exige.mjs http://127.0.0.1:8990/ V
import fs from 'fs';

import { dossier, aCorbeille, URL_DEFAUT } from './config.mjs';

const BASE = (process.argv[2] || URL_DEFAUT).replace(/\/$/, '');
const VOL = (process.argv[3] || 'V').toUpperCase();
const DOSSIER = dossier(VOL, 'mot-exige');
const H = { 'Content-Type': 'application/json', 'X-Diskmap': '1' };
// Hors bornes pour tout volume : cf. sonde-suppression.mjs.
const INERTE = 4000000000;

const verifs = [], echecs = [];
function verifier(nom, condition, mesure) {
  const ok = !!condition;
  verifs.push(ok);
  if (!ok) echecs.push(`${nom} — mesuré : ${mesure}`);
  console.log(`${ok ? 'ok   ' : 'ROUGE'} ${nom}${ok ? '' : `\n      mesuré : ${mesure}`}`);
}
const post = (c, corps) => fetch(BASE + c, {
  method: 'POST', headers: H, body: JSON.stringify(corps),
}).then(async r => ({ status: r.status, j: await r.json().catch(() => null) }));

// Les mots annonces pour un mode donne. La liste remplace le mot unique depuis
// que les regles s'additionnent : un lot enorme ET definitif en annonce deux.
const mots = (ap, mode) => (mode === 'permanent' ? ap.mots_permanent : ap.mots_recycle) || [];

const etat = await (await fetch(`${BASE}/api/state`)).json();
const ELEVE = etat.eleve === true;
const CORBEILLE = aCorbeille(VOL);
console.log(`--- ${VOL} : instance ${ELEVE ? 'ÉLEVÉE' : 'normale'}, corbeille `
  + `${CORBEILLE ? 'présente' : 'ABSENTE'} ---`);

async function attendre() {
  for (let i = 0; i < 300; i++) {
    const s = await (await fetch(`${BASE}/api/state`)).json();
    if (!s.scanning) return;
    await new Promise(r => setTimeout(r, 300));
  }
}

// Ce que le serveur annonce pour ce lot, mode par mode. On ne devine rien : on
// lit les deux champs, et la règle du projet est confrontée à ce qu'il a dit.
async function annonce() {
  fs.rmSync(DOSSIER, { recursive: true, force: true });
  fs.mkdirSync(DOSSIER, { recursive: true });
  fs.writeFileSync(`${DOSSIER}/cible.txt`, 'contenu de la sonde');
  await attendre();
  await post(`/api/scan/${VOL}`, {});
  await attendre();
  const t = await (await fetch(`${BASE}/api/tree?drive=${VOL}&id=0&limit=200`)).json();
  const racine = t.rows.find(r => r.name === '_diskmap_sondes');
  const l2 = await (await fetch(`${BASE}/api/tree?drive=${VOL}&id=${racine.id}&limit=200`)).json();
  const d = l2.rows.find(r => r.name === 'mot-exige');
  const l3 = await (await fetch(`${BASE}/api/tree?drive=${VOL}&id=${d.id}&limit=200`)).json();
  const r = await post('/api/delete', {
    drive: VOL, items: l3.rows.map(x => x.sel), mode: 'dry', gen: l3.gen,
  });
  return r.j;
}

const j = await annonce();
if (!j) {
  verifier('l’aperçu répond', false, 'aucun JSON');
} else {
  verifier('l’aperçu répond pour les DEUX modes, par LISTE',
    Array.isArray(j.mots_recycle) && Array.isArray(j.mots_permanent),
    JSON.stringify(Object.keys(j).filter(k => k.startsWith('mots_'))));

  // Le mode définitif détruit : le mot y est toujours exigé, quelle que soit
  // l'instance. C'est le fondement, pas une option.
  const perm = mots(j, 'permanent').map(m => m.mot);
  verifier('le mode définitif exige toujours le mot',
    perm.join(' ') === 'EFFACER', `mots_permanent=${JSON.stringify(perm)}`);

  // Le mode corbeille : le mot dépend du contexte, et de rien d'autre.
  const attendu = (!CORBEILLE || ELEVE) ? ['EFFACER'] : [];
  const rec = mots(j, 'recycle').map(m => m.mot);
  verifier('le mode corbeille exige le mot selon le contexte, et lui seul',
    JSON.stringify(rec) === JSON.stringify(attendu),
    `mots_recycle=${JSON.stringify(rec)}, attendu ${JSON.stringify(attendu)} `
    + `(corbeille=${CORBEILLE}, élevée=${ELEVE})`);

  // Un mot exigé porte toujours son motif : un champ nu se tape par réflexe.
  verifier('chaque mot exigé porte le motif qui le justifie',
    mots(j, 'permanent').concat(mots(j, 'recycle'))
      .every(m => typeof m.raison === 'string' && m.raison.length > 0),
    JSON.stringify(mots(j, 'permanent')));

  // Le mot ne doit jamais être exigé là où il ne l'est pas : une règle qui
  // s'applique trop devient une règle qu'on contourne.
  if (CORBEILLE && !ELEVE) {
    verifier('et il n’est PAS exigé quand tout va bien — sinon on s’y habitue',
      rec.length === 0 && perm.join(' ') === 'EFFACER',
      `recycle=${JSON.stringify(rec)} permanent=${JSON.stringify(perm)}`);
  }
}

// --- le refus, éprouvé sans rien supprimer ---------------------------------
// Un jeton INERTE : l'exécution va passer le contrôle du mot, tourner, et ne
// rien résoudre. C'est le seul moyen de éprouver un refus sans supprimer.
const gen = (await (await fetch(`${BASE}/api/tree?drive=${VOL}&id=0`)).json()).gen;
const inertie = await post('/api/delete', { drive: VOL, items: [INERTE], mode: 'dry', gen });
if (inertie.j && inertie.j.token) {
  // Deux exécutions, DEUX JETONS : le premier est consommé même quand il est
  // refusé, et c'est un détail du jeton unique qu'il ne faut pas oublier.
  const sansMot = await post('/api/delete', {
    drive: VOL, mode: 'recycle', token: inertie.j.token,
  });
  const rejet = await post('/api/delete', {
    drive: VOL, items: [INERTE], mode: 'dry', gen,
  });
  const avecMot = await post('/api/delete', {
    drive: VOL, mode: 'recycle', token: rejet.j.token, confirm: 'EFFACER',
  });
  if (j && mots(j, 'recycle').length) {
    verifier('sans le mot, l’exécution est refusée',
      sansMot.status === 400, `HTTP ${sansMot.status}`);
    verifier('avec le mot, l’exécution passe le contrôle du mot',
      avecMot.status !== 400,
      `HTTP ${avecMot.status}`);
  } else {
    verifier('sans mot exigé, l’exécution passe — le contexte ne demande rien',
      sansMot.status !== 400, `HTTP ${sansMot.status}`);
  }
  // Le mot exigé ne doit JAMAIS être accepted quand le serveur n'en attendait
  // pas : un client qui en envoie un par habitude ne doit pas obtenir de
  // pouvoir supplémentaire — mais surtout, il ne doit pas obtenir la preuve
  // que le contrôle est désactivé.
  console.log(`      (jeton inerte consommé : ${inertie.j.token.slice(0, 18)}…)`);
} else {
  console.log('      refus non éprouvé : jeton inerte indisponible');
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
process.exit(echecs.length ? 1 : 0);
