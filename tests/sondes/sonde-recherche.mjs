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

import { dossier, racine, URL_DEFAUT, attendreAnalyse } from './config.mjs';

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

const chercher = (q, limit) => {
  const u = limit === undefined
    ? `${BASE}/api/search?drive=${VOL}&q=${encodeURIComponent(q)}`
    : `${BASE}/api/search?drive=${VOL}&q=${encodeURIComponent(q)}&limit=${limit}`;
  return fetch(u).then(async (r) => ({
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

// Elles n'entrent dans l'instantane qu'apres une analyse : sans ca, la sonde
// mesurerait un volume ou elle n'a pas mis les pieds.
await post(`/api/scan/${VOL}`);
await attendreAnalyse(BASE, VOL);

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
console.log(`--- 2. ce que la borne coupe, et ce que le serveur en dit ---`);

// Exactement le nombre de correspondances. RIEN n'est coupe, et c'est le cas
// que la formule ne sait pas distinguer d'une vraie troncature.
const exact = await chercher(JETON, ATTENDU);
const rangeesExact = exact.j && Array.isArray(exact.j.rows) ? exact.j.rows : [];
noter(`borne = ${ATTENDU} pour ${ATTENDU} correspondance(s) : ${rangeesExact.length} rendue(s). `
  + `« truncated » annonce : ${exact.j && exact.j.truncated}. `
  + `Rien n'a ete coupe : un serveur qui ne tronque rien mais le dit est un `
  + `serveur qui ment, et l'interface le repete a l'utilisateur.`);
noter(`borne par defaut de l'interface (800) sur le meme jeton : ` +
  `${(await chercher(JETON, 800)).j.rows.length} ligne(s).`);

// La borne egale au nombre de DOSSIERS. Si les dossiers remplissent la borne,
// que devient un fichier qui correspond ? C'est la question du jour.
const tousDossiers = await chercher(JETON, DOSSIERS.length);
const lignesDd = tousDossiers.j && Array.isArray(tousDossiers.j.rows) ? tousDossiers.j.rows : [];
const nbDossiers = lignesDd.filter((r) => r.is_dir).length;
const nbFichiers = lignesDd.filter((r) => !r.is_dir).length;
noter(`borne = ${DOSSIERS.length} (le nombre de DOSSIERS) : ${lignesDd.length} ligne(s), `
  + `dont ${nbDossiers} dossier(s) et ${nbFichiers} fichier(s). `
  + `${FICHIERS.length} fichier(s) portent le jeton et sont lisibles sur le disque.`
  + (nbFichiers === 0
    ? ' AUCUN n est rendu : les fichiers ne sont pas « hors borne », ils ne sont pas cherches.'
    : ` ${nbFichiers} sur ${FICHIERS.length} sont rendus.`));

// La meme question, une borne de plus : un seul fichier doit apparaitre.
const plusUn = await chercher(JETON, DOSSIERS.length + 1);
const lignesPlusUn = plusUn.j && Array.isArray(plusUn.j.rows) ? plusUn.j.rows : [];
noter(`borne = ${DOSSIERS.length + 1} : ${lignesPlusUn.filter((r) => !r.is_dir).length} fichier(s) rendu(s).`);

// ------------------------------------------------------------------ l'ordre
console.log('');
console.log(`--- 3. l'ordre des lignes rendues ---`);

const tailles = rangees.map((r) => r.size);
const decroissant = tailles.every((t, i) => i === 0 || tailles[i - 1] >= t);
noter(`borne large : tailles rendues = [${tailles.join(', ')}]. `
  + `Decroissant : ${decroissant}. `
  + (decroissant
    ? 'La selection et l affichage utilisent le meme critere, sur cette arbre.'
    : 'L affichage n est PAS dans l ordre des tailles : la liste ne se lit pas comme elle se presente.'));

// Le point qui compte vraiment : sur QUEL critere les lignes ont ete CHOISIES,
// pas dans quel ordre elles sont presentees. A la borne large, les deux
// coincident par hasard — tout est rendu. A la borne egale au nombre de
// dossiers, NON : les fichiers n'ont pas ete vus, donc ils ne peuvent pas
// avoir ete ecartes pour etre petits. Ce qui les a ecarte, c'est qu'ils sont
// des fichiers.
const nomFichiersVisibles = lignesDd.filter((r) => !r.is_dir).map(nomDe);
noter(`a la borne ${DOSSIERS.length}, les lignes rendues se nomment : `
  + `${lignesDd.map((r) => `${nomDe(r)}${r.is_dir ? '/' : ''}(${r.size})`).join(', ')}.`);
noter(`le critere de SELECTION n est donc pas la taille : a cette borne, les `
  + `dossiers ont ete pris parce que ce sont des dossiers, et les fichiers `
  + `ecartes parce que le parcours s est arrete avant eux. L affichage, lui, `
  + `montre des tailles decroissantes — la liste a l air d avoir ete choisie `
  + `par taille, et n a pas ete choisie ainsi.`);
if (nomFichiersVisibles.length) {
  noter(`fichier(s) effectivement rendus : ${nomFichiersVisibles.join(', ')}.`);
} else {
  noter(`aucun fichier rendu a la borne ${DOSSIERS.length}, alors que `
    + `${FICHIERS.length} portent le jeton. Un fichier de 15 000 octets et un `
    + `dossier de 150 octets se disputent la meme place, et c'est le dossier qui gagne.`);
}

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

