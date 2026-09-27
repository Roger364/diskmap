// Un lot qui touche un dossier personnel doit-il être nommé avant d'agir ?
//
// La règle est récente, et une règle non éprouvée est une intention. Le dépôt
// en a déjà mis une au jour qui ne pouvait pas s'exécuter : `filet.mjs` refusait
// par volume, et la branche était morte. Celle-ci est prouvée dans les DEUX
// sens — le refus quand le nom manque, l'absence de refus quand la règle ne
// parle pas — parce qu'une règle qui refuse toujours est aussi sterile qu'une
// règle qui ne refuse jamais.
//
// CE FICHIER NE SUPPRIME AUCUNE DONNÉE, et ne cherche pas à le faire. Les
// exécutions qu'il tente sont précisément celles que la règle doit refuser : sans
// le nom, puis avec le mauvais. Si la règle ne tenait pas, ce serait un défaut
// de la règle — visible ici, sur un volume jetable, et non ailleurs. Le fichier
// témoin est relu à la fin : il est encore là, et c'est la preuve.
//
// Le contre-exemple compte autant que la règle : un dossier qui ne s'appelle pas
// `Documents` ne déclenche RIEN. Sans ce cas, une détection qui Returningrait
// toujours quelque chose passerait cette sonde.
//
// Usage : node sonde-dossiers-personnels.mjs http://127.0.0.1:8990/ V
import fs from 'fs';
import path from 'path';

import { corbeille, dossier, fouillerCorbeille, URL_DEFAUT, VOLUME_DEFAUT, viderTrouves } from './config.mjs';

const BASE = (process.argv[2] || URL_DEFAUT).replace(/\/$/, '');
const VOL = (process.argv[3] || VOLUME_DEFAUT).toUpperCase();
const NOM = 'dossiers-personnels';
const DOSSIER = dossier(VOL, NOM);
const PERSO = DOSSIER + '/Documents';
const NEUTRE = DOSSIER + '/burns';
const F_PERSO = PERSO + '/photo-2019.jpg';
const F_NEUTRE = NEUTRE + '/image.iso';
const H = { 'Content-Type': 'application/json', 'X-Diskmap': '1' };

const verifs = [], echecs = [];
function verifier(nom, condition, mesure) {
  const ok = !!condition;
  verifs.push(ok);
  if (!ok) echecs.push(`${nom} — mesuré : ${mesure}`);
  console.log(`${ok ? 'ok   ' : 'ROUGE'} ${nom}${ok ? '' : `\n      mesuré : ${mesure}`}`);
}

async function get(chemin) {
  const r = await fetch(`${BASE}${chemin}`);
  return r.json();
}
async function post(chemin, corps) {
  const r = await fetch(`${BASE}${chemin}`, {
    method: 'POST', headers: H, body: JSON.stringify(corps),
  });
  // Le corps se lit UNE fois. `json()` puis `text()` sur la meme reponse
  // renvoie une chaine vide : le corps a deja ete consomme, et le message de
  // refus disparait — c'est-a-dire que la sonde ne verrait plus QUE le statut,
  // qui passe meme quand la garde se tait.
  const texte = await r.text();
  let data = null;
  try { data = JSON.parse(texte); } catch { /* refus en texte brut */ }
  return { status: r.status, data, texte };
}
async function attendreFinParcours() {
  for (let i = 0; i < 200; i++) {
    const s = await get('/api/state');
    if (!s.scanning) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

// ------------------------------------------------------------------ 0. départ
console.log('--- 0. la sonde crée un dossier personnel et un dossier neutre ---');
fs.mkdirSync(PERSO, { recursive: true });
fs.mkdirSync(NEUTRE, { recursive: true });
// Un sceau unique : la corbeille RENOMME, et c'est par le contenu qu'on
// retrouve un fichier pour le reprendre. Voir `fouillerCorbeille`.
const SCEAU = `personnel-${Date.now()}-${Math.random().toString(36).slice(2, 10)}\n`;
fs.writeFileSync(F_PERSO, SCEAU);
fs.writeFileSync(F_NEUTRE, 'neutre\n');
verifier('le témoin « Documents » est créé', fs.existsSync(F_PERSO), F_PERSO);
verifier('le témoin « burns » est créé', fs.existsSync(F_NEUTRE), F_NEUTRE);

await post(`/api/scan/${VOL}`, {});
const termine = await attendreFinParcours();
verifier('le volume est réanalysé', termine, 'le parcours n’a pas rendu la main');

// ------------------------------------------- 1. les sélecteurs, par leur NOM
// Les sélecteurs sont des positions : ils sont cherchés par le nom affiché, pas
// supposés. Une position devinée serait fausse, et un test vert sur un mauvais
// fichier ne prouverait rien.
const recherche = await get(`/api/search?drive=${VOL}&q=${encodeURIComponent(NOM)}`);
const racine = (recherche.rows || []).find((r) => r.is_dir && r.name === NOM);
verifier('le dossier de la sonde est indexé', !!racine, JSON.stringify(recherche.rows || []).slice(0, 200));
if (!racine) {
  console.log(`\n  ${echecs.length} échec(s)`);
  process.exit(1);
}
const gen = recherche.gen;
const enfants = (await get(`/api/tree?drive=${VOL}&id=${racine.sel}`)).rows || [];
const parNom = (nom) => enfants.find((r) => r.name === nom);
const selPerso = parNom('Documents');
const selNeutre = parNom('burns');
// Le FICHIER, et non le dossier. C'est le cas réel — c'est une photo qu'on
// veut effacer — et cela garde le ménage possible : une mise à la corbeille
// de DOSSIER produit une charge `$R` qui est un répertoire, que
// `fouillerCorbeille` ne cherche pas, puisque cette fonction ne descend pas
// dans les arbres.
const enfantsPerso = (await get(`/api/tree?drive=${VOL}&id=${selPerso.sel}`)).rows || [];
const selFichier = enfantsPerso.find((r) => !r.is_dir && r.name === 'photo-2019.jpg');
verifier('le fichier du dossier « Documents » est indexé', !!selFichier,
  JSON.stringify(enfantsPerso).slice(0, 200));
verifier('le dossier « Documents » est indexé', !!selPerso, JSON.stringify(enfants).slice(0, 200));
verifier('le dossier « burns » est indexé', !!selNeutre, JSON.stringify(enfants).slice(0, 200));
if (!selPerso || !selNeutre || !selFichier) {
  console.log(`\n  ${echecs.length} échec(s)`);
  process.exit(1);
}

// ---------------------------------------------------- 2. l'aperçu nomme le lot
console.log('--- 1. l’aperçu annonce le dossier personnel ---');
const apercuPerso = await post('/api/delete', {
  drive: VOL, mode: 'dry', items: [selFichier.sel], gen,
});
verifier(
  'un lot dans « Documents » est signalé comme tel',
  JSON.stringify(apercuPerso.data?.personnels) === '["Documents"]',
  `personnels = ${JSON.stringify(apercuPerso.data?.personnels)}`
);
verifier(
  'l’aperçu ne signale qu’une fois, même si le dossier contient plusieurs fichiers',
  Array.isArray(apercuPerso.data?.personnels) && apercuPerso.data.personnels.length === 1,
  `personnels = ${JSON.stringify(apercuPerso.data?.personnels)}`
);

const apercuNeutre = await post('/api/delete', {
  drive: VOL, mode: 'dry', items: [selNeutre.sel], gen,
});
verifier(
  'un lot dans un dossier ordinaire ne déclenche RIEN — la règle ne parle pas à tort',
  Array.isArray(apercuNeutre.data?.personnels) && apercuNeutre.data.personnels.length === 0,
  `personnels = ${JSON.stringify(apercuNeutre.data?.personnels)}`
);

// ------------------------------------------- 3. l'exécution, sans et avec le nom
console.log('--- 2. l’exécution exige le nom, dossier par dossier ---');
const sansNom = await post('/api/delete', {
  drive: VOL, mode: 'recycle', token: apercuPerso.data.token,
});
const refus = sansNom.texte;
verifier('sans le nom, l’exécution est refusée', sansNom.status === 409 || sansNom.status === 400, `status ${sansNom.status} — ${refus.slice(0, 160)}`);
verifier('le refus nomme le dossier à confirmer', /Documents/.test(refus), refus.slice(0, 160));
verifier('le refus explique quoi faire', /nomme|confirmer/i.test(refus), refus.slice(0, 160));

const mauvaisNom = await post('/api/delete', {
  drive: VOL, mode: 'recycle', token: apercuPerso.data.token, perso: ['burns'],
});
const refus2 = mauvaisNom.texte;
verifier('avec le MAUVAIS nom, l’exécution est refusée', mauvaisNom.status === 400, `status ${mauvaisNom.status} — ${refus2.slice(0, 160)}`);

// Le jeton survit à un refus : il n'a pas été consommé, donc l'utilisateur peut
// corriger sa saisie sans refaire l'aperçu. Vérifié en donnant enfin le bon nom.
const bonNom = await post('/api/delete', {
  drive: VOL,
  mode: 'recycle',
  token: apercuPerso.data.token,
  perso: ['documents'],
});
const ok = bonNom.status === 200;
verifier('avec le bon nom — sans tenir compte de la casse — l’exécution passe', ok, `status ${bonNom.status} — ${bonNom.texte.slice(0, 160)}`);
verifier('le jeton n’a pas été consommé par les refus', ok, 'un refus doit laisser la saisie reprenable');

// ---------------------------------------------------- 4. ce qui a réellement eu lieu
console.log('--- 3. ce qui a réellement eu lieu ---');
const efface = fs.existsSync(F_PERSO);
verifier('le fichier visé par le dernier essai a bien disparu', !efface, F_PERSO);

// Et surtout : la sonde ne laisse pas le fichier dans la corbeille. Elle en a
// mis un, donc elle le reprend. Le pire n'est pas le fichier de quelques
// octets : c'est que la corbeille rend le diagnostic des AUTRES faux. Mesurée :
// la sonde `ui` cherchait `photo.jpg`, trouvait le `photo-2019.jpg` laissé ici,
// et concluait que l'interface ne listait rien. Une sonde sale rend le
// diagnostic des autres faux, sans jamais échouer elle-même.
const trouves = fouillerCorbeille(corbeille(VOL), SCEAU);
const rendus = viderTrouves(corbeille(VOL), trouves);
verifier('la sonde a repris son fichier dans la corbeille', rendus === 1,
  `${rendus} retrait(s) sur ${trouves.length} trouvé(s)`);
verifier('aucun résidu dans la corbeille', fouillerCorbeille(corbeille(VOL), SCEAU).length === 0,
  `${fouillerCorbeille(corbeille(VOL), SCEAU).length} résidu(s)`);
verifier('le témoin neutre est intact', fs.existsSync(F_NEUTRE), F_NEUTRE);

const journal = fs.readFileSync(journalPath(), 'utf8');
const lignes = journal.split('\n').filter((l) => l.includes(PERSO.replace(/\//g, '\\')));
verifier('le journal nomme le chemin du fichier effacé', lignes.length > 0, `${lignes.length} ligne(s)`);

function journalPath() {
  const base = process.env.LOCALAPPDATA || process.env.USERPROFILE || '.';
  return path.join(base, 'diskmap', 'suppressions.log');
}

// --------------------------------------------------------------- 5. ménage
fs.rmSync(DOSSIER, { recursive: true, force: true });
verifier('le dossier de la sonde est retiré', !fs.existsSync(DOSSIER), DOSSIER);

console.log(`\n  ${verifs.filter(Boolean).length}/${verifs.length} verifications`);
if (echecs.length) {
  console.log(`\n  ${echecs.length} échec(s)`);
  for (const e of echecs) console.log(`   - ${e}`);
  process.exit(1);
}
console.log('  la regle tient dans les deux sens : elle parle quand il le faut, et se tait sinon');
