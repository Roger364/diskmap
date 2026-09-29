// Les quatre gardes que PERSONNE ne regardait.
//
// Le 29/09/2026, `verifier-libelles.mjs` a extrait 37 gardes de `src/main.rs` et
// a affiché quatre libellés qu'aucune sonde ne cite : « lettre manquante »,
// « id invalide », « chemin invalide », « route inconnue ». Ce sont les quatre
// validations d'entrée du routeur, et aucune n'était éprouvée.
//
// LE TROU AVAIT UNE CAUSE, ET ELLE EST ICI
// ----------------------------------------
// `verifier-libelles` AFFICHAIT sa liste et sortait toujours en vert — décision
// volontaire, et la bonne : un contrôle rouge en permanence cesse d'être consulté.
// Mais une liste qu'on se contente de lire n'est pas une garde. Le contrôle a
// donc changé de rôle : il EXIGE maintenant (voir le plancher), et son propre
// pouvoir de morsure est éprouvé par une embuscade.
//
// CES QUATRE GARDES SONT LES PLUS ÉCONOMIQUES DU DÉPÔT
// ------------------------------------------------------
// Aucune ne coûte un fichier, un navigateur, ni une analyse. Ce sont quatre
// requêtes, et la sonde tourne en une seconde. C'est ce qui les rend introuvables
// quand on cherche « où tester encore » : elles ne font pas de bruit, ne
// laissent pas de trace, et sont donc les premières oubliées.
//
// LA RÈGLE QUI COMMANDE CE FICHIER
// ---------------------------------
// Un refus ne prouve que si un TÉMOIN, sur la MÊME route, reçoit une AUTRE
// réponse. Sinon une sonde qui vérifie « 400 » passe aussi bien sur un serveur
// qui refuse tout — le défaut exact qu'une preuve sans contre-exemple installe.
// Chaque cas ci-dessous a donc son jumeau : même route, garde voisine, message
// différent. Un témoin qui rendrait la MÊME réponse que le refus ne prouverait
// rien du tout ; c'est la raison d'être du message, et non du statut.
//
// AUCUN EFFET DE BORD
// --------------------
// Aucune de ces requêtes ne supprime, n'ouvre l'Explorateur, n'arrête le
// serveur, ni ne demande une analyse. Le témoin de « lettre manquante » vise un
// volume INEXISTANT (`Z:`) : il prouve que la route est atteinte sans lancer
// d'analyse. Le témoin de « chemin invalide » vise un dossier absent : la garde
// répond 404 avant tout `Command::new("explorer")`, et le statut mesuré le dit —
// un 404, pas un 200 suivi d'une fenêtre. Le témoin de « route inconnue » ne
// demande rien du tout.
//
// Usage : node sonde-entrees.mjs http://127.0.0.1:8990/ V

import { URL_DEFAUT, VOLUME_DEFAUT } from './config.mjs';

const BASE = (process.argv[2] || URL_DEFAUT).replace(/\/$/, '');
const VOL = (process.argv[3] || VOLUME_DEFAUT).toUpperCase();

const H = { 'Content-Type': 'application/json', 'X-Diskmap': '1' };

const verifs = [], echecs = [];
function verifier(nom, cond, mesure) {
  const ok = !!cond; verifs.push(ok);
  if (!ok) echecs.push(`${nom} — mesuré : ${mesure}`);
  console.log(`${ok ? 'ok   ' : 'ROUGE'} ${nom}${ok ? '' : `\n      mesuré : ${mesure}`}`);
}
const info = (m) => console.log(`      ${m}`);

/**
 * Une POST vers le serveur, corps `{}` et en-têtes de notre propre page.
 *
 * Le corps est `{}` et non absent : la lecture se fait par `Content-Length`, et
 * une requête sans corps n'en a pas. Le détail est sans effet ici — aucune de
 * ces routes ne lit le corps — mais il évite qu'une requête mal formée et un
 * refus de garde produisent le même 400, ce qui rendrait muet le témoin.
 */
async function poster(chemin) {
  const r = await fetch(BASE + chemin, { method: 'POST', headers: H, body: '{}' });
  return { status: r.status, texte: (await r.text()).replace(/\s+/g, ' ').trim() };
}

// Le support, mesuré et non supposé.
//
// « chemin invalide » est la SEULE des quatre gardes qui ne s'atteint pas sur un
// volume sans instantané : la route résout le volume AVANT de découper le
// chemin, et répond alors « volume pas encore analysé ». Sur un volume non
// analysé, ce cas mesurerait une AUTRE garde que celle qu'il prétend éprouver —
// un vert qui ne prouve rien. Le harnais analyse toujours son volume avant les
// sondes, mais une sonde qui s'appuie sur ce fait sans le mesurer se contente de
// y croire.
const etat = await (await fetch(`${BASE}/api/state`)).json();
const d = (etat.drives || []).find((x) => x.letter === VOL);
const support = !!(d && d.status === 'ready');
verifier(`${VOL}: le volume est analysé — support du cas « chemin invalide »`,
  support,
  d ? `${VOL}: status=${d.status}, ${d.n_files} fichier(s)` : `${VOL} absent de l'état`);

console.log(`--- ${VOL}: quatre gardes d'entrée, et un témoin pour chacune ---`);

// ---- 1. lettre manquante ----------------------------------------------------
const sansLettre = await poster('/api/scan/');
verifier('un scan sans lettre est refusé, et nommé',
  sansLettre.status === 400 && /lettre manquante/.test(sansLettre.texte),
  `HTTP ${sansLettre.status} · ${sansLettre.texte.slice(0, 90)}`);

// Le témoin : MÊME route, un volume qui n'existe pas. La garde de la lettre a
// laissé passer — sinon on lirait « volume inconnu » — et c'est la garde
// suivante qui parle. Sans lui, « 400 » ne distinguerait pas une validation
// d'entrée d'un refus de tout.
const lettreAbsente = await poster('/api/scan/Z');
verifier('témoin : une lettre valide atteint la garde suivante, elle',
  lettreAbsente.status === 404 && /volume inconnu/.test(lettreAbsente.texte),
  `HTTP ${lettreAbsente.status} · ${lettreAbsente.texte.slice(0, 90)}`);

// ---- 2. id invalide ---------------------------------------------------------
const idAbime = await poster(`/api/open?drive=${VOL}&id=zzz`);
verifier('un identifiant illisible est refusé, et nommé',
  idAbime.status === 400 && /id invalide/.test(idAbime.texte),
  `HTTP ${idAbime.status} · ${idAbime.texte.slice(0, 90)}`);

// Le témoin : un identifiant numérique, mais HORS BORNES. Même 400 que le cas
// précédent — c'est ce qui rend ce témoin utile : seul le message distingue les
// deux gardes, et il se trouve que le statut ne le fait pas.
const idHorsBornes = await poster(`/api/open?drive=${VOL}&id=999999999&kind=dir`);
verifier('témoin : un identifiant hors bornes atteint la garde suivante, elle',
  idHorsBornes.status === 400 && /hors bornes/.test(idHorsBornes.texte),
  `HTTP ${idHorsBornes.status} · ${idHorsBornes.texte.slice(0, 90)}`);

// ---- 3. chemin invalide -----------------------------------------------------
if (support) {
  // `kind=file` déclenche le découpage ; sans séparateur, `rsplit_once` échoue.
  const sansSeparateur = await poster(`/api/open?drive=${VOL}&id=0&kind=file&chemin=zzz`);
  verifier('un chemin de fichier sans séparateur est refusé, et nommé',
    sansSeparateur.status === 400 && /chemin invalide/.test(sansSeparateur.texte),
    `HTTP ${sansSeparateur.status} · ${sansSeparateur.texte.slice(0, 90)}`);

  // Le témoin : MÊME route, MÊME paramètre, mais un chemin qui porte un
  // séparateur. La garde de découpage est alors passée, et c'est l'index qui
  // refuse — dossier absent du volume.
  const dossierAbsent = await poster(
    `/api/open?drive=${VOL}&id=0&kind=file&chemin=${encodeURIComponent(`${VOL}:\\absent\\zz.txt`)}`);
  verifier('témoin : un chemin bien formé atteint la garde suivante, elle',
    dossierAbsent.status === 404 && !/chemin invalide/.test(dossierAbsent.texte),
    `HTTP ${dossierAbsent.status} · ${dossierAbsent.texte.slice(0, 90)}`);
} else {
  info(`NE PAS MESURABLE — non mesurable : « chemin invalide » exige un instantané, et ${VOL} n'en a pas. structurel : la garde exige un instantané, et ce volume n'en a pas au moment de la requête.`);
  verifier('« chemin invalide » est éprouvé', false,
    `${VOL} sans instantané : le cas aurait mesuré la garde du volume, pas celle du chemin`);
}

// ---- 4. route inconnue ------------------------------------------------------
const routeInconnue = await poster('/api/une-route-qui-nexiste-pas');
verifier('une route inconnue est refusée, et nommée',
  routeInconnue.status === 404 && /route inconnue/.test(routeInconnue.texte),
  `HTTP ${routeInconnue.status} · ${routeInconnue.texte.slice(0, 90)}`);

// Le témoin, et il est le plus parlant des quatre : MÊME statut que le refus —
// 404 — mais un AUTRE message. Une sonde qui ne vérifierait que le statut
// compterait cette route comme correctement refusée, et la garde resterait
// invisible. C'est la démonstration en deux lignes de ce que R15 a appris à ses
// dépens : le statut est une information, le libellé en est une autre.
const routeVielle = await poster('/api/scan/Z');
verifier('témoin : un 404 de route réelle ne se confond pas avec celui d\'une route inconnue',
  routeVielle.status === 404 && !/route inconnue/.test(routeVielle.texte),
  `HTTP ${routeVielle.status} · ${routeVielle.texte.slice(0, 90)}`);

// Le serveur est-il toujours debout ? Les huit requêtes ci-dessus sont des POST :
// une faute de corps, une garde qui cède, et le processus peut tomber. Un refus
// mesuré sur un serveur mort est un refus qui ne prouve rien.
const vivant = await fetch(`${BASE}/api/state`).then((r) => r.ok).catch(() => false);
verifier('le serveur répond toujours après les huit requêtes', vivant,
  'le processus est mort — une requête suffit');

console.log('');
console.log(`${verifs.filter(Boolean).length}/${verifs.length} vérifications vertes`);
if (echecs.length) { console.log('ÉCHECS :'); for (const e of echecs) console.log(`  - ${e}`); }
process.exitCode = echecs.length ? 1 : 0;
