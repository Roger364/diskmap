// Les gardes que PERSONNE ne regarde.
//
// Une garde peut être active, utilisée, et rester sans aucune vérification. Le 29/09,
// c'est arrivé pour `X-Diskmap` : elle bloque tout ce qui modifie — sans elle, une
// page web tierce efface un fichier sans confirmation — et aucune requête directe ne
// la posait. Le trou ne se voyait pas, parce que `csrf` passe par un navigateur, qui
// bloque la requête AVANT le serveur : la sonde était verte, et le vert ne prouvait
// rien.
//
// Chaque garde porte un LIBELLÉ dans sa réponse — « en-tête X-Diskmap absent »,
// « volume inconnu », « jeton consommé entre-temps ». Ce libellé est ce qu'une sonde
// peut citer. Ce contrôle les extrait et les cherche dans les sondes.
//
// Il ne conclut pas « cette garde n'est pas éprouvée » : une sonde peut vérifier le
// STATUT sans citer le libellé — c'est même le cas du cas ajouté pour `X-Diskmap`,
// qui vérifie le 403 sans lire la réponse. Il conclut « personne ne cite ce texte »,
// et laisse à l'œil le soin de dire si c'est un trou ou une couverture par le code.
//
//
// LE CONTRÔLE A CHANGÉ DE RÔLE LE 29/09/2026
// -------------------------------------------
// Ce fichier AFFICHAIT sa liste et sortait toujours en vert. La décision était
//-volontaire : un contrôle rouge en permanence cesse d'être consulté. Mais une
// liste que personne ne fait descendre n'est pas une garde, et les quatre
// libellés qu'il affichait sont restés nus. Un rapport qu'on ne fait pas
// descendre ne prouve rien — c'est R15 appliqué à l'outillage.
//
// Il exige donc maintenant, et son pouvoir de morsure est lui-même éprouvé :
//
//   1. un PLANCHER. Le nombre de gardes que PERSONNE ne regarde ne peut pas
//      dépasser une valeur écrite ici, et il vaut 0. Ajouter une garde sans la
//      tester fait donc rougir la chaîne, au lieu d'ajouter une ligne à un
//      rapport que personne ne lit. On ne peut pas non plus faire baisser le
//      plancher sans que ce soit visible : c'est une constante, donc une
//      révision.
//
//   2. une EMBUSCADE. Un contrôle qui n'a jamais rougi ne sait pas rougir. Avant
//      de croire « 0/0 muettes », le script vérifie qu'il SAIT détecter une
//      garde muette : il en fabrique une, et exige qu'elle soit vue. Le jour où
//      la règle de correspondance se cassera — et qu'elle rendra muette par
//      défaut — ce sera rouge, au lieu d'un faux « tout le monde regarde tout ».
//
// C'est la même leçon que le 29/09 sur `scan_running` et `csrf`, appliquée deux
// crans plus haut : ces deux-là mesuraient un état déjà_present. Ici, on
// vérifie qu'un CONTRÔLE sait détecter ce qu'il cherche à détecter.
//
// Usage : node tests/sondes/verifier-libelles.mjs

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ICI = path.dirname(fileURLToPath(import.meta.url));
const DEPOT = path.resolve(ICI, '..', '..');

// « 400 Bad Request », « 409 Conflict »… : le point d'entrée de chaque garde.
const CODE = /\b(400|403|404|409|503)\s+(Bad Request|Forbidden|Not Found|Conflict|Service Unavailable)/;
const LITERAL = /"([^"\\]{10,})"/g;

function gardes() {
  const fichier = path.join(DEPOT, 'src', 'main.rs');
  const lignes = fs.readFileSync(fichier, 'utf8').split('\n');
  const vues = [];

  for (let i = 0; i < lignes.length; i++) {
    const m = CODE.exec(lignes[i]);
    if (!m) continue;
    // Le motif est sur la ligne du code, ou dans le `format!` qui suit. On prend
    // une fenêtre de quatre lignes : au-delà, on attraperait le message d'une
    // garde voisine, ce qui serait pire que de ne rien voir.
    const fenetre = lignes.slice(i, i + 4).join('\n');
    const candidats = [];
    for (const lit of fenetre.matchAll(LITERAL)) {
      const s = lit[1];
      if (CODE.test(`"${s}"`)) continue;
      if (/^https?:/.test(s) || s.includes('X-Diskmap') === false && s.length < 10) continue;
      candidats.push(s);
    }
    if (!candidats.length) continue;
    // Un `format!` commence par un morceau fixe, souvent le seul lisible : on
    // garde le PREMIER segment avant la première accolade.
    const brut = candidats[0];
    const premier = brut.split('{')[0].trim().replace(/[ ,;:—–-]+$/, '');
    const motif = premier.length >= 10 ? premier : brut;
    vues.push({ ligne: i + 1, code: m[1], motif, complet: brut });
  }
  return vues;
}

const verifs = [];
const echecs = [];
function verifier(nom, cond, mesure) {
  const ok = !!cond;
  verifs.push(ok);
  if (!ok) echecs.push(`${nom} — mesuré : ${mesure}`);
  console.log(`${ok ? 'ok   ' : 'ROUGE'} ${nom}${ok ? '' : `\n      mesuré : ${mesure}`}`);
}

console.log('--- une garde que personne ne cite, se voit-elle au moins ? ---');

const g = gardes();
verifier('le script sait extraire les gardes du code', g.length > 0, `${g.length} garde(s)`);

const sondes = [];
for (const f of fs.readdirSync(ICI)) {
  if (f.startsWith('sonde-') && f.endsWith('.mjs')) {
    sondes.push({ nom: f, texte: fs.readFileSync(path.join(ICI, f), 'utf8') });
  }
}
verifier('des sondes existent', sondes.length > 0, `${sondes.length} fichier(s) de sonde`);

const normaliser = (s) => s.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ').trim();
const corps = sondes.map((s) => ({ nom: s.nom, n: normaliser(s.texte) }));

const cites = [];
const muets = [];
const laxes = [];

/**
 * Classe une liste de gardes face à un ensemble de sondes.
 *
 * C'est une FONCTION, et non une boucle dans le corps du script, parce que
 * l'embuscade du bas doit pouvoir classifier une garde qu elle IMAGINE — donc
 * appliquer exactement la même règle, sans la réécrire. Une règle dupliquée pour
 * l'embuscade ne prouverait rien : c'est la règle dupliquée qu on testerait.
 */
function classer(lesGardes, lesSondes) {
  const cites = [], muets = [], laxes = [];
  for (const garde of lesGardes) {
    const cible = normaliser(garde.motif);
    // Règle STRICTE : le libellé entier est cité. Rare — une sonde écrit souvent
    // une regex courte (`/Host refus/i`) plutôt que la phrase.
    // Règle LAXE : au moins DEUX mots de plus de quatre caractères du libellé
    // apparaissent dans une même sonde. Elle évite de déclarer muette une garde que
    // la sonde regarde par un extrait.
    //
    // Les deux chiffres sont affichés, et la liste de « muettes » est celle de la
    // règle stricte : c'est la seule qui ne risque pas de cacher un trou. Le chiffre
    // lax sert à distinguer « personne n en parle » de « personne n en a le texte ».
    const strictes = lesSondes.filter((s) => s.n.includes(cible)).map((s) => s.nom);
    const mots = [...new Set(cible.split(/[^a-z0-9à-ÿ']+/).filter((w) => w.length >= 4))];
    const trouvees = lesSondes
      .filter((s) => mots.filter((w) => s.n.includes(w)).length >= 2)
      .map((s) => s.nom);
    if (strictes.length) cites.push({ ...garde, ou: strictes });
    else {
      muets.push(garde);
      if (trouvees.length) laxes.push({ ...garde, ou: trouvees });
    }
  }
  // « Réellement muet » = muet selon la règle stricte ET absent aussi de la
  // règle laxe. C'est le seul chiffre qui compte pour le plancher : une garde
  // regardée par un extrait de deux mots est regardée, même si son libellé
  // entier n'apparaît nulle part.
  return {
    cites,
    muets,
    laxes,
    reellementMuets: muets.filter((x) => !laxes.some((l) => l.motif === x.motif)),
  };
}

{
  const r = classer(g, corps);
  cites.push(...r.cites);
  muets.push(...r.muets);
  laxes.push(...r.laxes);
}

console.log('');
console.log(`  ${g.length} gardes dans src/main.rs ; ${cites.length} dont le libellé entier est cité par une sonde.`);
console.log(`  ${muets.length} ne le sont pas : ${laxes.length} d'entre elles sont pourtant regardées`);
console.log(`  par un extrait (regex courte), ${muets.length - laxes.length} ne le sont vraiment par personne.`);
if (muets.length) {
  console.log('');
  console.log('  Ces libellés ne sont cités en entier par AUCUNE sonde :');
  for (const x of muets) {
    const lache = laxes.find((l) => l.ligne === x.ligne);
    console.log(`    ${x.code}  src/main.rs:${x.ligne}  « ${x.motif} »`
      + (lache ? `   — regardé par ${lache.ou.join(', ')}` : '   — personne ne le regarde'));
  }
}

// ------------------------------------------------- le plancher, et son embuscade
console.log('');
console.log('--- le contrôle sait-il rougir ? ---');

// Le PLANCHER. Il vaut 0 : aucune garde ne doit être laissée sans regard. Une
// garde neuve, non testée, fait donc rouge — ce qui est le but. Le mettre à 1
// « le temps de voir » est exactement l'erreur que ce contrôle commettait
// avant : un rapport qu'on lit une fois et qu'on ne descend plus.
//
// MESURÉ, LE 29/09/2026 : une garde renommée en un libellé que personne ne cite
// fait passer ce contrôle de 6/6 à 5/6, et nomme la ligne. Le plancher n'est donc
// pas une déclaration, c'est une arme.
const PLANCHER_SANS_REGARD = 0;

// L'EMBUSCADE, avant de croire le chiffre.
//
// On fabrique une garde que PERSONNE ne cite, et on exige que la règle la
// déclare muette. Sans cela, « 0/0 muettes » est indiscernable d'une règle
// cassée qui n'en verrait aucune : les deux affichent la même chose, et la
// deuxième est un mensonge.
//
// ELLE A DÉJÀ ROUGI, ET C'EST CE QU'ELLE EST FAITE POUR
// --------------------------------------------------------
// Écrit naïvement — « embuscade jamais citée par aucune sonde » — ce leurre
// Passait pour LAXE : la règle lax compte DEUX mots de plus de quatre
// caractères, et « jamais » et « sonde » sont dans toutes les sondes. Le
// contrôle a donc rouge le 29/09 sur son propre leurre, et ce n'était pas un
// défaut de la règle : c'était un leurre mal écrit, qui ne prouvait rien.
//
// Un test de contrôle ne mesure que s'il est lui-même exact. D'où la forme
// ci-dessous : un mot unique, absent de tout le dépôt, et une garde d'un seul
// segment. Le mot est vérifié ABSENT avant d'être utilisé — sans cela, un
// embuscade qui « passe » pourrait n'avoir jamais été regardée.
const leurre = 'zzcontrolejamaisvu';
verifier('le leurre d\'embuscade n\'existe nulle part dans le dépôt',
  !corps.some((s) => s.n.includes(leurre)),
  `« ${leurre} » figure déjà dans une sonde : l'embuscade ne prouverait rien`);
const fauxMuet = classer([{ ligne: 0, code: '400', motif: leurre, complet: leurre }], corps);
verifier('le contrôle DÉTECTE une garde que personne ne cite',
  fauxMuet.muets.length === 1 && fauxMuet.reellementMuets.length === 1,
  `classée « citée » alors qu'aucune sonde ne la cite — la règle ne détecte plus rien`);

// L'autre moitié, et elle est aussi nécessaire que la première. Une règle qui
// déclarerait TOUT muet ne prouverait rien non plus : le plancher deviendrait un
// piège à lignes rouges, volontairement fausse. Un contrôle qui ne sait dire ni
// « vu » ni « pas vu » ne sait rien — et le test le dit plutôt que de le
// supposer.
//
// Le témoin est tiré des sondes RÉELLES, jamais d'un libellé du code : les
// libellés de `src/main.rs` sont des extraits de `format!`, souvent tronqués
// (« en-tête Host refusé (« » »), et une sonde peut fort bien regarder la garde
// sans citer cette coupe-là. Prendre un vrai libellé comme témoin produirait
// alors un rouge de SONDE — le défaut qu'un test de contrôle ne doit pas avoir.
const phraseCitee = corps
  .map((s) => s.n)
  .join(' ')
  .match(/[a-zà-ÿ]{12,}/)
  ? corps.flatMap((s) => s.n.match(/[a-zà-ÿ]{12,}/) || [])[0]
  : null;
if (phraseCitee === null) {
  verifier('le contrôle RECONNAIT une garde que le code cite', false,
    'aucune phrase de plus de douze lettres dans les sondes : témoin indisponible');
} else {
  const fauxCite = classer([{ ligne: 0, code: '400', motif: phraseCitee, complet: phraseCitee }], corps);
  verifier('le contrôle RECONNAIT une garde que le code cite',
    fauxCite.muets.length === 0,
    `« ${phraseCitee} » a été déclarée muette alors qu'une sonde la cite`);
}

const reels = muets.length - laxes.length;
verifier(
  `aucune garde sans regard (plancher ${PLANCHER_SANS_REGARD}, mesuré ${reels})`,
  reels <= PLANCHER_SANS_REGARD,
  reels === 0
    ? 'aucune'
    : `${reels} garde(s) que PERSONNE ne regarde — ajoute une sonde qui cite le libellé, `
      + 'ou relève le plancher en écrivant pourquoi dans PLANCHER_SANS_REGARD');
if (reels > PLANCHER_SANS_REGARD) {
  console.log('');
  console.log('  Ces gardes n ont AUCUNE vérification, et le plancher est 0 :');
  for (const x of muets) {
    if (laxes.find((l) => l.ligne === x.ligne)) continue;
    console.log(`    ${x.code}  src/main.rs:${x.ligne}  « ${x.motif} »`);
  }
}

console.log('');
console.log(`${verifs.filter(Boolean).length}/${verifs.length} verifications vertes`);
if (echecs.length) {
  console.log('ECHECS :');
  for (const e of echecs) console.log(`  - ${e}`);
}
process.exitCode = echecs.length ? 1 : 0;
