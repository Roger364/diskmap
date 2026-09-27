// Que rend `/api/search`, et que pretend-il rendre ?
//
// Cette sonde ne corrige rien et ne tranche rien. Elle rend VISIBLE un contrat
// que personne n'a jamais lu : a quel moment la recherche s'arrete, et ce
// qu'elle dit de ce qu'elle a laisse.
//
// Elle existe parce que le 27/09/2026, trois lectures de code ont produit
// trois affirmations sur la recherche, et aucune n'etait mesuree :
//
//   1. `/api/search` accepte un `limit` — 500 par defaut, 800 depuis
//      l'interface. C'est un PARAMETRE. On peut donc exercer le plafond avec
//      six fichiers, au lieu d'en creer huit cents : c'est ce qui rend cette
//      sonde realiste en un run.
//   2. `snap.search()` (`src/scan.rs`) coupe le parcours a `limit` DANS
//      l'ordre de l'index, dossiers d'abord, puis `if out.len() < limit` les
//      fichiers. Donc des dossiers qui remplissent le plafond empechent les
//      fichiers d'etre cherches — pas « de sortir », pas d'etre tranches :
//      jamais regardes.
//   3. `let truncated = rows.len() >= limit` (`src/main.rs`) est une
//      SUPPOSITION. Avec exactement `limit` correspondances, rien n'est coupe,
//      et le serveur annonce pourtant `truncated` a l'interface, qui affiche
//      alors « tronque — affinez avec la recherche ».
//
// Aucune de ces trois lectures n'est une mesure. Cette sonde les mesure.
//
// ------------------------------------------------------------------
// CE QUI EST JUGE, ET CE QUI N'EST PAS
// ------------------------------------------------------------------
// Un verdict doit porter sur un invariant vraI quel que soit le contrat
// choisi. « La liste est triee par taille decroissante » n'en est pas un : on
// pourrait legitimement choisir l'ordre par date, ou par nom. Le dire en vert
// serait figer un choix qui n'a pas ete fait.
//
// Alors : les invariants sont des verdicts, le contrat est une note. Une note
// n'entre ni dans le compte des verts ni dans celui des rouges — elle sort, et
// elle est lue. C'est la meme discipline que le filet : un cas non mesure ne
// vaut ni succes ni echec.
//
// Usage : node sonde-recherche.mjs http://127.0.0.1:8990/ V
import fs from 'fs';

import { dossier, racine, URL_DEFAUT } from './config.mjs';

const BASE = (process.argv[2] || URL_DEFAUT).replace(/\/$/, '');
const VOL = (process.argv[3] || 'V').toUpperCase();
const DOSSIER = dossier(VOL, 'recherche');
const H = { 'Content-Type': 'application/json', 'X-Diskmap': '1' };

// Un jeton qu'aucune autre sonde n'utilise, pour que le compte des
// correspondances soit le nôtre et pas celui de l'execution precedente.
const JETON = 'w9k';
const DOSSIERS = ['a', 'b', 'c'];
const FICHIERS = ['a', 'b', 'c'];
// Des poids distincts et connus : sans eux, on ne pourrait distinguer « trie
// par taille » de « revient dans l'ordre de creation ».
const POIDS = { a: 150, b: 1500, c: 15000 };

const verifs = [], echecs = [], notes = [];
function verifier(nom, condition, mesure) {
  const ok = !!condition;
  verifs.push(ok);
  if (!ok) echecs.push(`${nom} — mesuré : ${mesure}`);
  console.log(`${ok ? 'ok   ' : 'ROUGE'} ${nom}${ok ? '' : `\n      mesuré : ${mesure}`}`);
}
/** Un fait releve, pas un jugement : il ne compte ni en vert ni en rouge. */
function noter(texte) {
  notes.push(texte);
  console.log(`      note : ${texte}`);
}
const post = (c, corps) => fetch(BASE + c, {
  method: 'POST', headers: H, body: JSON.stringify(corps || {}),
}).then(async (r) => ({ status: r.status, j: await r.json().catch(() => null) }));

// `sort` et `order` sont des PARAMETRES, pas du texte de recherche. Les avoir
// concatenes dans `q` etait le premier defaut de cette sonde : `chercher()`
// encode ce qu il recoit, donc « w9k&sort=name » partait en un seul terme,
// la recherche ne trouvait rien, et la lecture de `rows[0]` plantait sur un
// `undefined`. Une URL ne se construit pas en collant des morceaux dans un
// parametre deja encode.
const chercher = (q, limit, extra = {}) => {
  const qs = new URLSearchParams({ drive: VOL, q });
  if (limit !== undefined) qs.set('limit', String(limit));
  for (const [cle, valeur] of Object.entries(extra)) qs.set(cle, String(valeur));
  return fetch(`${BASE}/api/search?${qs}`).then(async (r) => ({
    status: r.status, j: await r.json().catch(() => null),
  }));
};

const nomDe = (r) => String(r.name || '').split('\\').pop().toLowerCase();
const nomDuRepertoire = (p) => String(p || '').replace(/\//g, '\\').split('\\').pop().toLowerCase();

// ------------------------------------------------------------------ l'arbre
//
// Trois dossiers et trois fichiers, tous nommes apres le jeton, de poids
// differents. Les dossiers contiennent un fichier qui ne porte PAS le jeton :
// sinon il compterait comme correspondance, et le compte ne serait plus le
// notre.
fs.rmSync(DOSSIER, { recursive: true, force: true });
fs.mkdirSync(DOSSIER, { recursive: true });
for (const suffixe of DOSSIERS) {
  fs.mkdirSync(`${DOSSIER}/${JETON}_${suffixe}`, { recursive: true });
  fs.writeFileSync(`${DOSSIER}/${JETON}_${suffixe}/poids_${suffixe}`, 'x'.repeat(POIDS[suffixe]));
}
for (const suffixe of FICHIERS) {
  fs.writeFileSync(`${DOSSIER}/${JETON}_${suffixe}.txt`, 'x'.repeat(POIDS[suffixe]));
}

const CHEMINS = fs.readdirSync(DOSSIER).sort();
console.log(`--- ${VOL} : ${CHEMINS.length} entree(s) sous ${racine(VOL)}/recherche ---`);
console.log(`    3 dossiers + 3 fichiers, tous nommes « ${JETON} », poids ${FICHIERS.map((s) => `${s}=${POIDS[s]}`).join(' ')}`);
console.log('');

// Elles n'entrent dans l'instantane qu'apres une analyse. On attend le
// CHANGEMENT DE GENERATION, pas la fin d'une analyse : juste apres
// `POST /api/scan`, l'analyse n'est pas encore lancee, donc `scanning` est
// encore faux, donc une attente sur `scanning` passe aussitot et l'on mesure
// l'instantane du run precedent. Mesure : l'ancienne version passait 24/24
// seule et tombait a 18/24 par le harnais, sur l'ecart
// [w9k_c, w9k_b, w9k_b.txt, ...] contre [w9k_c, w9k_c.txt, w9k_b, ...] — un
// ordre par nom, parce que les dossiers de l'ancien arbre etaient vides et
// donc tous a zero. Le produit triait juste ; la sonde mesurait le volume
// d'avant.
const generationAvant = (await chercher(JETON, 1)).j && (await chercher(JETON, 1)).j.gen;
await post(`/api/scan/${VOL}`);
let generationApres = generationAvant;
for (let i = 0; i < 200 && generationApres === generationAvant; i++) {
  await new Promise((r) => setTimeout(r, 200));
  const r = await chercher(JETON, 1);
  generationApres = r.j ? r.j.gen : generationAvant;
}
verifier('l instantane observe est celui qui contient les fichiers de la sonde',
  generationApres !== generationAvant,
  `generation ${generationAvant} -> ${generationApres} : l analyse n a pas change `
  + 'd instantane, et la sonde mesurerait le volume du run precedent');
noter(`generation : ${generationAvant} -> ${generationApres}`);

// ------------------------------------------------------------------ le contrat
const ATTENDU = DOSSIERS.length + FICHIERS.length;
console.log(`--- 1. la borne haute ne coupe rien quand elle ne peut rien couper ---`);

const large = await chercher(JETON, 50);
const rangees = large.j && Array.isArray(large.j.rows) ? large.j.rows : [];
const trouvees = new Set(rangees.map(nomDe));

verifier('la reponse est un JSON de resultats', large.status === 200 && rangees.length > 0,
  `statut ${large.status}, ${rangees.length} ligne(s)`);
verifier('toutes les correspondances sont rendues quand la borne est large',
  rangees.length === ATTENDU,
  `${rangees.length} rendue(s), ${ATTENDU} attendue(s) — manquantes : ${[...DOSSIERS, ...FICHIERS.map((s) => `${JETON}_${s}.txt`)].filter((n) => !trouvees.has(n)).join(', ') || 'aucune'}`);
verifier('aucune ligne ne sort de la racine de travail',
  rangees.every((r) => String(r.path || '').replace(/\\/g, '/').startsWith(`${racine(VOL)}/`)),
  rangees.filter((r) => !String(r.path || '').replace(/\\/g, '/').startsWith(`${racine(VOL)}/`)).map((r) => r.path).join(', ') || 'toutes dedans');
verifier('la reponse ne rend jamais plus que la borne demandee',
  rangees.length <= 50, `${rangees.length} ligne(s) pour une borne de 50`);

// La casse ne devrait rien changer : `contains_ci` est le seul filtre du nom.
const majuscule = await chercher(JETON.toUpperCase(), 50);
const rangeesMaj = majuscule.j && Array.isArray(majuscule.j.rows) ? majuscule.j.rows : [];
verifier('la recherche ignore la casse', rangeesMaj.length === rangees.length,
  `${rangeesMaj.length} ligne(s) en majuscules, ${rangees.length} en minuscules`);

const vide = await chercher('zz9k_aucun_resultat_volontaire');
const rangeesVides = vide.j && Array.isArray(vide.j.rows) ? vide.j.rows : [];
verifier('une recherche sans resultat ne renvoie rien et ne se trompe pas',
  vide.status === 200 && rangeesVides.length === 0,
  `statut ${vide.status}, ${rangeesVides.length} ligne(s)`);

// ------------------------------------------------------------------ ce qui est coupe
console.log('');
console.log('--- 2. la borne, et ce que le serveur en dit ---');

// Le drapeau doit etre un FAIT, jamais une supposition. On le met face a des
// bornes de part et d'autre du total : juste egale (rien n'est coupe), juste
// inferieure (coupe), juste superieure (rien n'est coupe).
for (const borne of [ATTENDU, ATTENDU + 4, ATTENDU - 1, 1]) {
  const r = await chercher(JETON, borne);
  const n = (r.j && r.j.rows ? r.j.rows.length : 0);
  const total = r.j ? r.j.total : null;
  const attendu = total !== null && borne < total;
  verifier(`a la borne ${borne}, « truncated » dit vrai (total ${total}, rendu ${n})`,
    r.j && r.j.truncated === attendu && n === Math.min(borne, total),
    `truncated=${r.j && r.j.truncated}, attendu ${attendu}, rendu ${n}`);
}

const large2 = await chercher(JETON, 50);
verifier('« total » est le compte reel, pas le compte rendu',
  large2.j && large2.j.total === ATTENDU,
  `total=${large2.j && large2.j.total}, attendu ${ATTENDU}`);
verifier('une borne au-dessus du total ne dit pas « tronqué »',
  large2.j && large2.j.truncated === false,
  `truncated=${large2.j && large2.j.truncated}`);

// Le cas de 2026 : des dossiers qui remplissent la borne ne doivent pas
// interdire aux fichiers d'etre vus. On le mesure par le CONTENU rendu, pas
// en comptant des dossiers.
const tousDossiers = await chercher(JETON, DOSSIERS.length);
const lignesDd = tousDossiers.j && tousDossiers.j.rows ? tousDossiers.j.rows : [];
const nbDossiers = lignesDd.filter((r) => r.is_dir).length;
const nbFichiers = lignesDd.filter((r) => !r.is_dir).length;
verifier(`des dossiers qui remplissent la borne n empechent pas les fichiers d etre vus`,
  nbFichiers > 0,
  `${nbDossiers} dossier(s) et ${nbFichiers} fichier(s) rendus a la borne `
  + `${DOSSIERS.length}, alors que ${FICHIERS.length} fichiers portent le jeton`);

// ------------------------------------------------------------------ l'egalite
console.log('');
console.log('--- 3. ce qui est rendu est ce qui a ete choisi ---');

// LE verdict. On demande une borne large — la liste complete, deja triee par
// le serveur — puis on rejoue le meme tri en local. Ce que le serveur rend
// pour une borne N doit etre le prefixe de cette liste.
//
// C'est ce qui manquait, et ce que l'interface laisse croire : avant,
// `Reverse(size)` portait sur le jeu deja coupe dans l'ordre de l'index, donc
// les 800 premieres vues etaient presentees comme les 800 plus grosses.
const triLocal = (r) => (a, b) => (b.size - a.size) || a.name.localeCompare(b.name);
for (const borne of [1, 2, 3, 4, 5, 6]) {
  const r = await chercher(JETON, borne);
  const rendu = r.j && r.j.rows ? r.j.rows.map(nomDe) : [];
  const attendu = rangees.slice().sort(triLocal()).slice(0, borne).map(nomDe);
  verifier(`borne ${borne} : le rendu est le debut de la liste entiere triee`,
    rendu.join('|') === attendu.join('|'),
    `rendu [${rendu.join(', ')}], attendu [${attendu.join(', ')}]`);
}

// L'egalite se tranche par nom, dans les deux sens. C'est ce qui rend la liste
// reproductible, et ce qui permet a une sonde de mesurer un changement de tri
// sans dependre du contenu du dossier.
// L'egalite se tranche par nom CROISSANT, dans les deux sens.
//
// Les deux listes entieres ne sont PAS l'une l'inverse de l'autre, et ne
// doivent pas l'etre : c'est exactement le defaut corrige. Ce qu on exige est
// plus precis et plus utile — dans chaque groupe de taille egale, les noms
// apparaissent dans le meme ordre, croissant, quel que soit le sens demande.
// Une position donnee ne depend donc que de la DONNEE, pas du geste de
// l'utilisateur, et c'est ce qui rend une liste reproductible.
const egauxDecr = await chercher(JETON, 50, { sort: 'size', order: 'desc' });
const egauxAsc = await chercher(JETON, 50, { sort: 'size', order: 'asc' });
const parTaille = (rows) => {
  const groupes = new Map();
  for (const r of rows || []) {
    if (!groupes.has(r.size)) groupes.set(r.size, []);
    groupes.get(r.size).push(r.name);
  }
  return groupes;
};
const decr = parTaille(egauxDecr.j && egauxDecr.j.rows);
const asc = parTaille(egauxAsc.j && egauxAsc.j.rows);
const tailles = [...decr.keys()].sort((a, b) => b - a);
const groupesEgaux = tailles.length > 0 && tailles.every((t) => {
  const d = decr.get(t) || [];
  const a = asc.get(t) || [];
  return d.length === a.length && d.length > 0
    && d.join('|') === a.join('|')
    && d.every((n, i) => i === 0 || d[i - 1] <= n);
});
verifier('a taille egale, les noms restent croissants quel que soit le sens',
  groupesEgaux,
  tailles.map((t) => `taille ${t} : desc [${(decr.get(t) || []).join(', ')}] / `
    + `asc [${(asc.get(t) || []).join(', ')}]`).join(' ; '));

// Et le corollaire : le serveur rend bien la MEME liste, pas une liste
// recomposee a chaque requete. Deux appels identiques donnent le meme ordre.
const repete1 = await chercher(JETON, 50, { sort: 'size', order: 'desc' });
const repete2 = await chercher(JETON, 50, { sort: 'size', order: 'desc' });
verifier('deux requetes identiques rendent le meme ordre, dans le meme sens',
  (repete1.j.rows || []).map(nomDe).join('|') === (repete2.j.rows || []).map(nomDe).join('|'),
  `${(repete1.j.rows || []).map(nomDe).join(', ')} / `
  + `${(repete2.j.rows || []).map(nomDe).join(', ')}`);

const parNom = await chercher(JETON, 50, { sort: 'name', order: 'desc' });
verifier('le tri par nom respecte le sens demande',
  parNom.j && parNom.j.rows && parNom.j.rows[0].name > parNom.j.rows[parNom.j.rows.length - 1].name,
  `premiere « ${parNom.j && parNom.j.rows && parNom.j.rows[0].name} », `
  + `derniere « ${parNom.j && parNom.j.rows && parNom.j.rows[parNom.j.rows.length - 1].name} »`);

// ------------------------------------------------------------------ la sonde
// Elle a cree des fichiers ; elle ne doit en avoir detruit aucun. Une sonde
// destructive qui nie l'etre est une sonde dont on ne peut plus rien attendre.
const restant = fs.readdirSync(DOSSIER).sort();
verifier('la sonde n a detruit aucun fichier qu elle a crees',
  restant.length === CHEMINS.length,
  `${restant.length} entree(s) sur ${CHEMINS.length} : ${restant.join(', ')}`);
const contenuIntact = FICHIERS.every((s) => {
  try { return fs.statSync(`${DOSSIER}/${JETON}_${s}.txt`).size === POIDS[s]; }
  catch { return false; }
});
verifier('les poids ecrits sont ceux annonces', contenuIntact,
  FICHIERS.map((s) => `${s}: ${fs.existsSync(`${DOSSIER}/${JETON}_${s}.txt`) ? fs.statSync(`${DOSSIER}/${JETON}_${s}.txt`).size : 'absent'}/${POIDS[s]}`).join(', '));

// ------------------------------------------------------------------ verdict
const reussies = verifs.filter(Boolean).length;
console.log('');
console.log(`${reussies}/${verifs.length} vérifications passent`);
if (notes.length) {
  console.log('\nContrat de la recherche — MESURÉ, non jugé :');
  for (const n of notes) console.log(`  - ${n}`);
}
// On rend le volume. C'est la DERNIERE chose, et c'est deliberé : les
// verdicts ci-dessus prouvent que la sonde n'a detruit aucun fichier qu'elle a
// crees, et celle-ci retire les siens.
//
// Sans ce nettoyage, la sonde suivante trouve `w9k_a` en tete de liste au lieu
// du dossier attendu, et echoue sur une salete qu'elle n'a pas produite.
// Mesure le 27/09/2026 : la sonde `ui` est devenue rouge 17/19 en suivant la
// `recherche`, parce que l'interface trie par taille et que cette sonde avait
// pose des poids arbitraires.
try {
  fs.rmSync(DOSSIER, { recursive: true, force: true });
  noter(`dossier de travail retire : ${DOSSIER}`);
} catch (e) {
  noter(`PAS PU NETTOYER ${DOSSIER} : ${e.code || e.message} — `
    + 'les residus peuvent faire echouer une sonde qui passe apres');
}

if (echecs.length) {
  console.log('\nÉchecs :');
  for (const e of echecs) console.log(`  - ${e}`);
  process.exitCode = 1;
}
// On ne force PAS la sortie. Un `process.exit(0)` ici coupe le processus
// pendant que des sockets d'`undici` sont encore vivantes, et Node le paie sur
// Windows par :
//   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c:76
// Le verdict etait imprime AVANT le plantage — la sonde sortait donc en « pas
// pu eprouver » alors qu elle avait reussi ses 8 verifications. Laisser Node
// sortir de lui-meme laisse les handles se fermer proprement ; le code de sortie
// reste 0, et 1 seulement en cas d'echec reel.

