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
// Il ne sort donc jamais en échec sur une couverture incomplète : un contrôle rouge
// en permanence cesse d'être consulté. Il n'échoue que si l'extraction ne trouve
// RIEN — ce qui signifie que le script est cassé, pas que le dépôt est sain.
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
for (const garde of g) {
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
  const strictes = corps.filter((s) => s.n.includes(cible)).map((s) => s.nom);
  const mots = [...new Set(cible.split(/[^a-z0-9à-ÿ']+/).filter((w) => w.length >= 4))];
  const trouvees = corps
    .filter((s) => mots.filter((w) => s.n.includes(w)).length >= 2)
    .map((s) => s.nom);
  if (strictes.length) cites.push({ ...garde, ou: strictes });
  else {
    muets.push(garde);
    if (trouvees.length) laxes.push({ ...garde, ou: trouvees });
  }
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
  console.log('');
  console.log('  Ce n est PAS une liste de failles. Une sonde peut vérifier le statut sans');
  console.log('  citer le texte — c est ce que fait le cas de X-Diskmap. C est une liste de');
  console.log('  ce dont le TEXTE n est nulle part, et le tri se fait à la lecture.');
}

console.log('');
console.log(`${verifs.filter(Boolean).length}/${verifs.length} verifications vertes`);
if (echecs.length) {
  console.log('ECHECS :');
  for (const e of echecs) console.log(`  - ${e}`);
}
process.exitCode = echecs.length ? 1 : 0;
