// L'aperçu est la première route qui rend les OCTETS d'un fichier choisi par
// l'index. Elle a donc trois façons de se tromper, et chacune a sa garde :
//
//   1. L'IDENTIFIANT est une position dans `snap.files`. Si la génération ne
//      correspond pas, il désigne un autre fichier — un contenu que personne
//      n'a demandé. D'où `gen invalide` (absente) puis `instantané périmé`.
//   2. L'INDEX peut être plus court que l'identifiant reçu : `fichier inconnu
//      de cet instantané`, et non une panique ni un 200 vide.
//   3. Le TYPE est décidé par l'EXTENSION, jamais par le client : une extension
//      hors liste est refusée, et l'en-tête `nosniff` empêche le navigateur de
//      décider à notre place.
//
// CE QUI N'EST PAS ÉPROUVÉ ICI, ET POURQUOI
// -----------------------------------------
// Le 403 « aperçu refusé : chemin protégé » demande un fichier sous C:\Windows
// (ou un dossier personnel, ou la racine) DANS l'instantané du volume de
// travail. Un volume jetable n'en contient pas, et en fabriquer un demanderait
// d'écrire hors de `dossier(...)` — interdit par la règle du harnais. La garde
// existe dans le code et `blocked_reason` est déjà éprouvée par la sonde de
// suppression ; on ne prétend pas l'avoir mesurée ici.
//
// Le 413 (image > 10 Mio) n'est pas monté non plus : créer une telle image
// coûte plus que la garde ne vaut, et la refuser ne doit jamais lire le fichier
// en entier — c'est justement ce que le code vérifie avant de lire.
//
// Usage : node sonde-preview.mjs http://127.0.0.1:8990/ V

import { URL_DEFAUT, VOLUME_DEFAUT } from './config.mjs';

const BASE = (process.argv[2] || URL_DEFAUT).replace(/\/$/, '');
const VOL = (process.argv[3] || VOLUME_DEFAUT).toUpperCase();

const verifs = [], echecs = [];
function verifier(nom, cond, mesure) {
  const ok = !!cond; verifs.push(ok);
  if (!ok) echecs.push(`${nom} — mesuré : ${mesure}`);
  console.log(`${ok ? 'ok   ' : 'ROUGE'} ${nom}${ok ? '' : `\n      mesuré : ${mesure}`}`);
}
const info = (m) => console.log(`      ${m}`);
const noter = (m) => console.log(`note : ${m}`);

async function reponse(chemin) {
  const r = await fetch(BASE + chemin);
  return { status: r.status, texte: (await r.text()).replace(/\s+/g, ' ').trim(), entetes: r.headers };
}

// Un instantané publié, sinon toutes les gardes en aval rendraient 409 pour la
// mauvaise raison et la sonde conclurait sur un volume vide.
const recherche = await reponse(`/api/search?drive=${VOL}&q=.txt&limit=200`);
if (recherche.status !== 200) {
  verifier('un instantané est publié pour ce volume', false,
    `GET /api/search → ${recherche.status} ${recherche.texte}`);
  console.log(`\n${verifs.filter(Boolean).length}/${verifs.length} vérifications passées`);
  process.exit(1);
}
const corpus = JSON.parse(recherche.texte);
const gen = corpus.gen;
verifier('la génération est un entier', Number.isFinite(gen), `gen = ${JSON.stringify(gen)}`);

// 1. Une requête sans identifiant, puis sans génération. Deux gardes voisines,
//    deux messages différents : le statut seul ne les distingue pas.
const sansId = await reponse(`/api/preview?drive=${VOL}&gen=${gen}`);
verifier('400 « id invalide » quand l’identifiant manque',
  sansId.status === 400 && sansId.texte.includes('id invalide'),
  `${sansId.status} ${sansId.texte}`);

const sansGen = await reponse(`/api/preview?drive=${VOL}&id=0`);
verifier('400 « gen invalide » quand la génération manque',
  sansGen.status === 400 && sansGen.texte.includes('gen invalide'),
  `${sansGen.status} ${sansGen.texte}`);

// 2. La génération périmée. La borne est la seule qui protège contre un index
//    décalé : sans elle, `id` désignerait un autre fichier.
const perime = await reponse(`/api/preview?drive=${VOL}&id=0&gen=${gen + 1}`);
verifier('409 « instantané périmé » quand la génération diffère',
  perime.status === 409 && perime.texte.includes('instantané périmé'),
  `${perime.status} ${perime.texte}`);

// 3. Un identifiant au-delà de l'index. `snap.files.get` doit répondre, pas
//    paniquer : 4000000000 est hors de toute machine réelle.
const inconnu = await reponse(`/api/preview?drive=${VOL}&id=4000000000&gen=${gen}`);
verifier('404 « fichier inconnu de cet instantané » hors index',
  inconnu.status === 404 && inconnu.texte.includes('fichier inconnu de cet instantané'),
  `${inconnu.status} ${inconnu.texte}`);

// 3 bis. Une garde VOISINE, sur la route des doublons : elle refuse des bornes
// inversées AVANT de lancer la moindre détection (le refus est donc gratuit).
// Elle appartient au même lot, et sans cette ligne son libellé n'était cité par
// aucune sonde.
const bornes = await reponse(`/api/duplicates?drive=${VOL}&min=2&max=1`);
verifier('400 « max plus petit que min » quand les bornes s’inversent',
  bornes.status === 400 && bornes.texte.includes('max plus petit que min'),
  `${bornes.status} ${bornes.texte}`);

// 4. Le témoin positif : un fichier texte de l'index s'ouvre vraiment. Sans
//    lui, toutes les gardes ci-dessus passeraient sur un serveur qui refuse
//    /api/preview en bloc.
const texte = (corpus.rows || []).find((r) =>
  !r.is_dir && /\.(txt|md|log|json|csv)$/i.test(r.name) && !/\\Windows\\/i.test(r.path));
if (texte) {
  const r = await fetch(`${BASE}/api/preview?drive=${VOL}&id=${texte.id}&gen=${gen}`);
  const corps = await r.arrayBuffer();
  verifier('un texte de l’index s’ouvre en 200', r.status === 200,
    `GET /api/preview id=${texte.id} → ${r.status}`);
  verifier('l’aperçu interdit la devinette de type',
    r.headers.get('x-content-type-options') === 'nosniff',
    `X-Content-Type-Options = ${JSON.stringify(r.headers.get('x-content-type-options'))}`);
  verifier('le texte est servi en text/plain',
    (r.headers.get('content-type') || '').startsWith('text/plain'),
    `Content-Type = ${JSON.stringify(r.headers.get('content-type'))}`);
  verifier('le corps rendu n’est pas vide', corps.byteLength > 0,
    `${corps.byteLength} octet(s) pour ${texte.name}`);
} else {
  noter('aucun fichier texte dans l’index : le 200, nosniff et le type ne sont pas éprouvés sur ce volume');
}

// 5. Une extension hors liste. On cherche un exécutable : s'il n'y en a pas,
//    la garde n'est pas mesurée et on le dit — plutôt que d'inventer un id.
const reExe = await reponse(`/api/search?drive=${VOL}&q=.exe&limit=50`);
const exe = reExe.status === 200
  ? (JSON.parse(reExe.texte).rows || []).find((r) => !r.is_dir && /\.exe$/i.test(r.name))
  : null;
if (exe) {
  const r = await reponse(`/api/preview?drive=${VOL}&id=${exe.id}&gen=${gen}`);
  verifier('415 « extension non prévisualisable » pour un .exe',
    r.status === 415 && r.texte.includes('extension non prévisualisable'),
    `${r.status} ${r.texte}`);
} else {
  noter('aucun .exe dans l’index : la garde 415 (extension non prévisualisable) n’est pas éprouvée');
}

const ok = verifs.filter(Boolean).length;
console.log(`\n${ok}/${verifs.length} vérifications passées`);
if (echecs.length) {
  console.log('\nÉchecs :');
  for (const e of echecs) console.log(`  - ${e}`);
  process.exit(1);
}
