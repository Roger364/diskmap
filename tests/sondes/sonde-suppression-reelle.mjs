// Chemin nominal de la suppression, sur des fichiers que NOUS avons créés.
// Le seul test qui efface vraiment, et il n'efface que ce qu'il a créé lui-même.
//
// Le test est AUTONOME : il crée son dossier et ses deux fichiers, puis déclenche
// lui-même la réanalyse du volume. La version précédente exigeait que les fichiers
// soient créés à la main avant le lancement — et c'est exactement ce qui a dérivé :
// un lancement s'est fait sur des fichiers absents de l'instantané, sans que rien
// ne le signale.
//
// Deux oracles, et l'ordre compte :
//   - PRINCIPAL — le fichier, retrouvé dans la corbeille PAR SON CONTENU. Il dit
//     « c'est bien CE fichier qui est là », ce qu'un décompte ne dit jamais.
//   - SECONDAIRE — le nombre de $R lisibles, qui a augmenté d'exactement 1.
//     Mesuré le 26/09/2026 : la corbeille de G: est passée de 1067 à 1126 entre
//     deux exécutions sans que ces essais l'expliquent — elle grossit par
//     activité extérieure. Ce décompte est donc sensible au moment où on le
//     prend ; il confirme, il ne prouve pas.
//
// Usage : node sonde-suppression-reelle.mjs http://127.0.0.1:8996/
//   (le serveur doit tourner sur le binaire à éprouver ; le test réanalyse G:)
import fs from 'fs';

import { dossier, corbeille, journal, VOLUME_DEFAUT, URL_DEFAUT } from './config.mjs';

const BASE = (process.argv[2] || URL_DEFAUT).replace(/\/$/, '');
const VOL = (process.argv[3] || VOLUME_DEFAUT).toUpperCase();
const NOM = 'suppression-reelle';
const DOSSIER = dossier(VOL, NOM);
const A = DOSSIER + '/a.txt';
const B = DOSSIER + '/b.txt';
const CORBEILLE = corbeille(VOL);
const JOURNAL = journal();

// Chaque exécution marque ses fichiers d'un sceau unique : c'est ce qui permet de
// les retrouver dans la corbeille par leur CONTENU, et non par un décompte.
const SCEAU = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const CONTENU_A = `A-${SCEAU}\n`;
const CONTENU_B = `B-${SCEAU}\n`;

const verifs = [];
const echecs = [];
const notes = [];
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

async function post(chemin, corps) {
  const r = await fetch(BASE + chemin, {
    method: 'POST',
    // En-tête exigé par le serveur sur toute route qui modifie quelque chose.
    // Sans lui, la sonde jouerait le rôle de l'attaquant et se ferait refuser.
    headers: { 'Content-Type': 'application/json', 'X-Diskmap': '1' },
    body: JSON.stringify(corps),
  });
  return { status: r.status, texte: await r.text() };
}

const effacer = (drive, items, mode, extra = {}) =>
  post('/api/delete', { drive, items, mode, ...extra });

// ---------------------------------------------------------------- la corbeille
//
// Les fichiers $R ne sont PAS à la racine de $RECYCLE.BIN mais dans un
// sous-dossier par SID — compter à la racine rendait toujours 0, et le test
// aurait conclu « rien n'a été recyclé » quoi qu'il arrive.
//
// Et sur ce volume, six sous-dossiers de SID coexistent, dont CINQ renvoient
// EPERM (ils appartiennent à d'autres comptes et à SYSTEM). La version
// précédente laissait cette EPERM remonter au catch global et renvoyait -1 pour
// l'ensemble : un dossier frère illisible empoisonnait le compte entier.
// On saute donc les illisibles, et on DIT combien on en a sauté — un compte qui
// tait ce qu'il n'a pas vu se présente comme une mesure alors qu'il n'est qu'un
// plancher.
function sidsDeCorbeille() {
  const lisibles = [], illisibles = [];
  let entrees;
  try {
    entrees = fs.readdirSync(CORBEILLE);
  } catch (e) {
    return { lisibles, illisibles, erreur: `${e.code} ${e.message}` };
  }
  for (const sid of entrees) {
    try {
      if (!fs.statSync(`${CORBEILLE}/${sid}`).isDirectory()) continue;
      fs.readdirSync(`${CORBEILLE}/${sid}`);
      lisibles.push(sid);
    } catch (e) {
      illisibles.push(`${sid} (${e.code})`);
    }
  }
  return { lisibles, illisibles, erreur: null };
}

function compterR() {
  const { lisibles } = sidsDeCorbeille();
  let n = 0;
  for (const sid of lisibles) {
    try { n += fs.readdirSync(`${CORBEILLE}/${sid}`).filter(x => x.startsWith('$R')).length; }
    catch { /* illisible entre-temps : on ne le compte pas, il est signalé ailleurs */ }
  }
  return n;
}

// L'oracle qui compte vraiment : le fichier est-il dans la corbeille ?
// Un décompte qui bouge ne prouve pas que C'EST NOTRE fichier ; le retrouver par
// son contenu, si.
// Le filtre par taille d'abord : un fichier recyclé garde sa taille, donc seuls
// les $R de cette taille exacte sont candidats — on ne lit que ceux-là.
function fouillerCorbeille(contenu) {
  const taille = Buffer.byteLength(contenu, 'utf8');
  const { lisibles } = sidsDeCorbeille();
  const trouves = [];
  for (const sid of lisibles) {
    let noms;
    try { noms = fs.readdirSync(`${CORBEILLE}/${sid}`); } catch { continue; }
    for (const n of noms) {
      if (!n.startsWith('$R')) continue;
      const f = `${CORBEILLE}/${sid}/${n}`;
      let st;
      try { st = fs.statSync(f); } catch { continue; }
      if (!st.isFile() || st.size !== taille) continue;
      try { if (fs.readFileSync(f, 'utf8') === contenu) trouves.push(f); } catch { /* illisible */ }
    }
  }
  return trouves;
}

// Renvoie l'identifiant ET la génération de l'instantané qui le porte.
//
// Les appeler séparément était le moyen le plus sûr de les désaccorder : un
// identifiant est une POSITION, et une position ne vaut que dans l'instantané
// qui l'a produite. Depuis le 26/09/2026, `dry` refuse une liste qui ne dit pas
// de quel index elle vient.
function idDe(nom) {
  return fetch(`${BASE}/api/search?drive=${VOL}&q=${NOM}`)
    .then(r => r.json())
    .then(d => { const r = d.rows.find(x => x.name === NOM); if (!r) throw new Error(`dossier ${NOM} absent de l'instantane`); return r.id; })
    .then(dirId => fetch(`${BASE}/api/tree?drive=${VOL}&id=${dirId}&limit=100`))
    .then(r => r.json())
    .then(d => {
      const f = d.rows.find(r => r.name === nom);
      // `sel`, pas `id` : c'est le sélecteur que l'interface renvoie, et lui
      // seul porte le type (bit de type — voir `scan::BIT_FICHIER`).
      return { id: f ? f.sel : null, gen: d.gen };
    });
}

async function attendreFinParcours() {
  for (let i = 0; i < 200; i++) {
    const s = await (await fetch(`${BASE}/api/state`)).json();
    if (!s.scanning) return true;
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}

// ------------------------------------------------------------------ 0. départ
console.log('--- 0. le test crée ses propres fichiers ---');
fs.mkdirSync(DOSSIER, { recursive: true });
fs.writeFileSync(A, CONTENU_A);
fs.writeFileSync(B, CONTENU_B);
console.log(`      sceau de cette exécution : ${SCEAU}`);
verifier('a.txt créé', fs.readFileSync(A, 'utf8') === CONTENU_A, 'contenu inattendu');
verifier('b.txt créé', fs.readFileSync(B, 'utf8') === CONTENU_B, 'contenu inattendu');

const sids = sidsDeCorbeille();
if (sids.erreur) {
  noter(`corbeille de G: inaccessible (${sids.erreur}) — l'oracle de la corbeille ne vaut rien`);
} else {
  noter(`corbeille de G: : ${sids.lisibles.length} sous-dossier(s) de SID lisible(s), ` +
    `${sids.illisibles.length} illisible(s)`);
  if (sids.illisibles.length) {
    // Ce n'est pas une faille du test : nos fichiers sont créés par l'utilisateur
    // courant, donc recyclés dans SON dossier, qui est lisible. Les illisibles
    // appartiennent à d'autres comptes et ne peuvent pas les recevoir. On le
    // vérifie plus bas en montrant que c'est bien un dossier lisible qui bouge.
    noter(`  ignorés : ${sids.illisibles.join(', ')}`);
  }
}

const lignesAvant = fs.readFileSync(JOURNAL, 'utf8').split('\n').filter(Boolean).length;
const rAvant = compterR();
console.log(`      journal : ${lignesAvant} ligne(s) · $R lisibles : ${rAvant}`);

// Les fichiers viennent d'être créés : il faut les faire entrer dans l'instantané.
const scan = await post(`/api/scan/${VOL}`, {});
verifier(`la réanalyse de ${VOL}: est acceptée`, scan.status === 200, `HTTP ${scan.status}`);
verifier('le parcours se termine', await attendreFinParcours(), 'toujours en cours après 60 s');

const vuA = await idDe('a.txt');
const vuB = await idDe('b.txt');
const idA = vuA.id;
verifier('les deux fichiers sont dans l’instantané', idA !== null && vuB.id !== null,
  `selA=${idA}, selB=${vuB.id}`);

// ------------------------------------------------- 1. l'aperçu dit la vérité
console.log('\n--- 1. l’aperçu montre ce qui sera supprimé ---');
let r = await effacer(VOL, [idA], 'dry', { gen: vuA.gen });
let d = JSON.parse(r.texte);
verifier('l’aperçu annonce un seul élément', d.items.length === 1, `${d.items.length} élément(s)`);
verifier('l’aperçu donne le chemin réel du fichier',
  // `'\\\\'` dans un littéral JS vaut DEUX antislashs : la comparaison ne pouvait
  // jamais être vraie, et l'échec se lisait « l'aperçu est faux » alors que
  // l'aperçu était juste. On normalise par une expression régulière, pas par
  // une chaîne : un antislash y est un antislash.
  d.items[0].path === A.replace(/\//g, '\\'),
  `« ${d.items[0].path} »`);
verifier('le fichier est compté comme effaçable', d.deletable === 1 && d.items[0].blocked === false,
  `deletable=${d.deletable}, blocked=${d.items[0].blocked}`);
const jetonA = d.token;

// ------------------------------- 2. le définitif exige le mot, et n'efface pas
console.log('\n--- 2. le définitif sans « EFFACER » ne touche à rien ---');
r = await effacer(VOL, [], 'permanent', { token: jetonA });
verifier('refusé sans le mot', r.status === 400, `HTTP ${r.status}`);
verifier('a.txt est toujours là après le refus', fs.existsSync(A), 'le fichier a disparu !');

// ------------------------------------------ 3. la corbeille, réversible
console.log('\n--- 3. suppression vers la corbeille ---');
r = await effacer(VOL, [], 'recycle', { token: jetonA });
d = JSON.parse(r.texte);
verifier('la suppression réussit', r.status === 200 && d.done === 1,
  `HTTP ${r.status}, done=${d.done}, ${JSON.stringify(d.results)}`);
verifier('elle est annoncée comme réversible', d.to_trash === true, `to_trash=${d.to_trash}`);
verifier('aucun échec rapporté', d.failed === 0, `failed=${d.failed}`);
verifier('a.txt a disparu du disque', !fs.existsSync(A), 'toujours présent');
verifier('b.txt n’a pas été touché', fs.existsSync(B), 'b.txt a disparu');

// L'oracle principal : le fichier, retrouvé dans la corbeille par son contenu.
const dansCorbeille = fouillerCorbeille(CONTENU_A);
verifier('a.txt est dans la corbeille du volume, retrouvé par son contenu',
  dansCorbeille.length === 1,
  `${dansCorbeille.length} fichier(s) au contenu attendu — ${JSON.stringify(dansCorbeille)}`);
if (dansCorbeille.length === 1) noter(`recyclé sous : ${dansCorbeille[0]}`);

const rApres = compterR();
verifier('le compte de $R lisibles a augmenté d’exactement 1',
  rApres === rAvant + 1, `${rAvant} → ${rApres}`);

// Le marqueur de b.txt ne doit PAS être dans la corbeille : rien n'a été recyclé
// par erreur au passage.
verifier('b.txt n’a pas été recyclé au passage',
  fouillerCorbeille(CONTENU_B).length === 0, 'le marqueur de b.txt est dans la corbeille');

// Le volume est réanalysé : les identifiants changent, il faut les reprendre.
console.log('\n--- 4. le volume est réanalysé après une suppression ---');
verifier('une réanalyse est déclenchée', d.rescan === true, `rescan=${d.rescan}`);
await attendreFinParcours();
const vuB2 = await idDe('b.txt');
const idB2 = vuB2.id;
verifier('b.txt est toujours indexé après la réanalyse', idB2 !== null, `sel=${idB2}`);

// ------------------------------- 4 bis. une liste périmée est REFUSÉE
//
// C'est le défaut mesuré le 26/09/2026 : après la réanalyse ci-dessus, les
// positions ont bougé, et un aperçu demandé avec l'ANCIENNE génération
// désignait un autre fichier — l'identifiant de `p1.txt` en venait à désigner
// `p2.txt`, `blocked=false`, et l'aperçu proposait de supprimer ce que personne
// n'avait coché. Le serveur doit refuser, pas viser à côté.
console.log('\n--- 4 bis. une liste lue avant la réanalyse est refusée ---');
r = await effacer(VOL, [idB2], 'dry', { gen: vuA.gen });
verifier('un aperçu sur une génération périmée est REFUSÉ',
  r.status === 409,
  `HTTP ${r.status} — un 200 signifierait qu'une position périmée est re-résolue`);
verifier('le refus nomme la cause', /génération/.test(r.texte), `« ${r.texte.slice(0, 120)} »`);
verifier('b.txt est intact après le refus', fs.existsSync(B), 'le fichier a disparu !');

// --------------------------------------- 5. le définitif, avec le mot
console.log('\n--- 5. suppression définitive ---');
r = await effacer(VOL, [idB2], 'dry', { gen: vuB2.gen });
const jetonB = JSON.parse(r.texte).token;
r = await effacer(VOL, [], 'permanent', { token: jetonB, confirm: 'EFFACER' });
d = JSON.parse(r.texte);
verifier('la suppression définitive réussit', r.status === 200 && d.done === 1,
  `HTTP ${r.status}, done=${d.done}, ${JSON.stringify(d.results)}`);
verifier('elle n’est pas annoncée comme réversible', d.to_trash === false, `to_trash=${d.to_trash}`);
verifier('b.txt a disparu du disque', !fs.existsSync(B), 'toujours présent');
verifier('le dossier d’essai est vide',
  fs.readdirSync(DOSSIER).length === 0,
  `reste : ${JSON.stringify(fs.readdirSync(DOSSIER))}`);

// « définitif » veut dire : nulle part dans la corbeille. C'est ça qu'on vérifie —
// pas seulement que le compte n'a pas bougé.
verifier('le marqueur de b.txt n’est nulle part dans la corbeille',
  fouillerCorbeille(CONTENU_B).length === 0, 'retrouvé dans la corbeille !');
verifier('le compte de $R lisibles n’a pas bougé pour le définitif',
  compterR() === rApres, `${rApres} → ${compterR()}`);

// ------------------------------------------------------- 6. la journalisation
console.log('\n--- 6. le journal des suppressions ---');
const lignesApres = fs.readFileSync(JOURNAL, 'utf8').split('\n').filter(Boolean);
verifier('le journal a gagné deux lignes', lignesApres.length === lignesAvant + 2,
  `${lignesAvant} → ${lignesApres.length}`);
const nouvelles = lignesApres.slice(lignesAvant);
const tA = Buffer.byteLength(CONTENU_A), tB = Buffer.byteLength(CONTENU_B);
verifier('la ligne de corbeille est datée, nommée et mesurée',
  nouvelles.some(l => new RegExp(`^\\d{13}\\tcorbeille\\t${tA}\\t1\\t.*a\\.txt\t`).test(l)),
  JSON.stringify(nouvelles));
verifier('la ligne définitive est datée, nommée et mesurée',
  nouvelles.some(l => new RegExp(`^\\d{13}\\tdefinitif\\t${tB}\\t1\\t.*b\\.txt\t`).test(l)),
  JSON.stringify(nouvelles));

// Ce que R6 corrige : le journal disait l'issue et le chemin traité, rien qui
// rattache cette suppression à une demande. Le 26/09/2026, on a lu 168 lignes
// de ce fichier sans pouvoir dire, pour aucune d'elles, ce que l'utilisateur
// avait sélectionné.
//
// Chaque ligne nomme donc le lot, la génération, le sélecteur reçu, et le chemin
// PRÉVU à l'aperçu. Le prévu et le réalisé sont égaux par construction ; ils
// sont deux colonnes pour que cette égalité se VÉRIFIE à la lecture, et qu'un
// jour où un chemin résolu à l'exécution réapparaîtrait, l'écart soit lisible
// sans avoir à relire le code.
//
// Ici les deux suppressions sont deux EXÉCUTIONS distinctes — a.txt recyclée à
// l'étape 3, b.txt en définitif à l'étape 5 — donc deux lots distincts, et c'est
// attendu. Le regroupement des éléments d'un même lot se vérifie dans
// `sonde-suppression-lot.mjs`, qui supprime vraiment par lots.
const lots = nouvelles.map(l => (l.split('\t').find(c => c.startsWith('lot=')) || ''));
verifier('chaque ligne nomme un lot', lots.length === 2 && lots.every(l => l.length > 'lot='.length),
  JSON.stringify(lots));
verifier('deux exécutions distinctes ont deux lots distincts',
  lots[0] !== lots[1],
  JSON.stringify(lots));
verifier('chaque ligne nomme le sélecteur reçu et la génération',
  nouvelles.every(l => /sel=\d+/.test(l) && /gen=\d+/.test(l)),
  JSON.stringify(nouvelles));
verifier('le prévu et le réalisé coïncident, chemin par chemin',
  nouvelles.every(l => {
    const champs = l.split('\t');
    const prevu = (champs.find(c => c.startsWith('prevu=')) || '').slice('prevu='.length);
    return prevu !== '' && prevu === champs[4];
  }),
  JSON.stringify(nouvelles));
verifier('le chemin prévu est bien celui que l’aperçu avait montré',
  nouvelles.some(l => l.includes(`prevu=${A.replace(/\//g, '\\')}`)) &&
  nouvelles.some(l => l.includes(`prevu=${B.replace(/\//g, '\\')}`)),
  `A=${A}, B=${B} — ${JSON.stringify(nouvelles)}`);

// ------------------------------------------------------- 7. nettoyage
//
// Le test a lui-même mis un fichier à la corbeille : il le reprend. Sans ça,
// chaque exécution laisserait un résidu de 25 octets dans le dossier du
// developpeur — un test qu'on hesite a relancer est un test qu'on ne relance pas.
// On retire la paire $R (le contenu) et $I (la fiche), qui partagent leur suffixe.
console.log('\n--- 7. le test reprend ce qu’il a mis à la corbeille ---');
let rendus = 0;
for (const r of fouillerCorbeille(CONTENU_A)) {
  const dossier = r.slice(0, r.lastIndexOf('/'));
  const nom = r.slice(r.lastIndexOf('/') + 1);          // $RND7AN9.txt
  const suffixe = nom.replace(/^\$R/, '').replace(/\.[^.]*$/, ''); // ND7AN9
  try {
    fs.unlinkSync(r);
    rendus++;
  } catch (e) { noter(`retrait de ${r} impossible : ${e.code}`); }
  // La fiche $I partage le suffixe mais pas l'extension : on la cherche, on ne la
  // devine pas. Son absence n'est pas un échec.
  for (const n of fs.readdirSync(dossier)) {
    if (n.startsWith('$I') && n.includes(suffixe)) {
      try { fs.unlinkSync(`${dossier}/${n}`); } catch { /* fiche absente : sans effet */ }
    }
  }
}
verifier('le test n’a rien laissé dans la corbeille', fouillerCorbeille(CONTENU_A).length === 0,
  'résidu présent');
noter(`${rendus} fichier(s) d’essai retiré(s) de la corbeille`);

console.log('');
console.log(`${verifs.filter(Boolean).length}/${verifs.length} vérifications vertes`);
if (echecs.length) {
  console.log('ÉCHECS :');
  for (const e of echecs) console.log(`  - ${e}`);
}
process.exit(echecs.length ? 1 : 0);
