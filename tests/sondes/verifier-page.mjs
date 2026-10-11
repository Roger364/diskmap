// Le script de la page doit PARSER — sinon l'interface entière est morte.
//
// Le 11/10/2026, `b5111f7` a écrit un nom de clé entre deux backticks À
// L'INTÉRIEUR d'un littéral de gabarit de `ui/index.html`. Le premier backtick
// fermait la chaîne, la page levait `SyntaxError` à l'évaluation, et AUCUN script
// n'était exécuté : plus de liste, plus de bannières, plus de boîte de
// confirmation. L'application était morte, pas seulement le message ajouté.
//
// La CI l'a vu — mais elle l'a dit sous une forme qui n'aidait pas :
//
//   ROUGE  identifiant     SANS SYNTHESE
//          page.evaluate: ReferenceError: select is not defined
//
// Sept sondes rouges pour un seul backtick. Ce contrôle-ci nomme la ligne de
// `ui/index.html` et le token fautif, et il tourne en une seconde, sans
// navigateur ni serveur — là où les sondes ont besoin des deux.
//
// Il parse avec `vm.Script` : un script CLASSIQUE, comme le `<script>` de la
// page. Pas d'`import`, pas d'`await` de premier niveau — exactement ce que le
// navigateur accepte. Une analyse plus permissive passerait là où la page casse,
// et un contrôle qui accepte plus que le navigateur ne garde rien.

import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const ICI = path.dirname(fileURLToPath(import.meta.url));
const DEPOT = path.resolve(ICI, '..', '..');
const PAGE = 'ui/index.html';

const verifs = [];
const echecs = [];
function verifier(nom, cond, mesure) {
  const ok = !!cond;
  verifs.push(ok);
  if (!ok) echecs.push(`${nom} — mesuré : ${mesure}`);
  console.log(`${ok ? 'ok   ' : 'ROUGE'} ${nom}${ok ? '' : `\n      mesuré : ${mesure}`}`);
}

/**
 * Les blocs `<script>` d'une page, avec la ligne de la BALISE ouvrante.
 *
 * La balise, et non le premier caractère du code : c'est la ligne que lit une
 * personne qui ouvre le fichier. Le code, lui, commence par un saut de ligne —
 * le décalage du parseur en tient compte, pas le libellé.
 */
function blocs(html) {
  const out = [];
  const re = /<script>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) {
    const avant = html.slice(0, m.index + m[0].indexOf(m[1]));
    out.push({ code: m[1], ligneBalise: avant.split('\n').length });
  }
  return out;
}

/**
 * Le verdict pour un texte de page et le nom de fichier à citer.
 *
 * C'est une FONCTION parce que l'embuscade du bas doit juger une page qu'elle
 * IMAGINE — et appliquer exactement la même règle, sans la réécrire. Une règle
 * recopiée pour l'embuscade ne prouverait rien : c'est la copie qu'on testerait.
 */
function analyser(html, fichier) {
  const trouves = blocs(html);
  if (trouves.length === 0) {
    return [{ nom: `${fichier} a au moins un bloc <script>`, ok: false, mesure: 'aucun bloc extrait' }];
  }
  const nom = (i, ligneBalise) => `${fichier} bloc ${i + 1} (<script> ligne ${ligneBalise}) parse`;
  return trouves.map((b, i) => {
    // On parse le code précédé d'autant de lignes vides qu'il en existe au-dessus
    // de la balise dans le fichier : les numéros de ligne du parseur sont alors
    // ceux du fichier — sans conversion à écrire, donc sans conversion à se
    // tromper. Le code commence par un saut de ligne, ce qui place son premier
    // caractère une ligne plus bas, exactement là où il est dans le fichier.
    try {
      new vm.Script('\n'.repeat(b.ligneBalise - 1) + b.code, { filename: fichier });
      return { nom: nom(i, b.ligneBalise), ok: true, mesure: 'ok' };
    } catch (e) {
      const motif = new RegExp(`${fichier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(\\d+)`);
      const m = motif.exec(e.stack || '');
      const ou = m ? `ligne ${m[1]} de ${fichier}` : `quelque part après la ligne ${b.ligneBalise}`;
      return { nom: nom(i, b.ligneBalise), ok: false, mesure: `${ou} : ${e.message}` };
    }
  });
}

console.log('--- le script de la page parse-t-il ? ---');

const html = fs.readFileSync(path.join(DEPOT, PAGE), 'utf8');
for (const r of analyser(html, PAGE)) verifier(r.nom, r.ok, r.mesure);

// --- l'embuscade : le contrôle sait-il rougir ? ------------------------------
//
// Le cas exact du 11/10/2026, planté ici. La chaîne est écrite entre guillemets
// DOUBLES à dessein : entre backticks, ce fichier porterait lui-même le défaut
// qu'il dénonce, et le contrôle tomberait au lieu de le détecter.
console.log('');
console.log('--- le contrôle sait-il rougir ? ---');

const leurre = "<script>\nconst a = 1;\nconst t = `texte (`NukeOnDelete=1`) fin` + a;\n</script>\n";
const verdicts = analyser(leurre, 'page-imaginaire.html');
const rouges = verdicts.filter((v) => !v.ok);
verifier('le contrôle DÉTECTE un backtick ouvert dans un littéral de gabarit',
  rouges.length > 0,
  verdicts.map((v) => `${v.ok ? 'ok' : 'ROUGE'} ${v.nom} :: ${v.mesure}`).join(' · '));
verifier('et il l’accuse à la BONNE ligne, avec le bon token',
  rouges.some((v) => /ligne 3 de page-imaginaire\.html/.test(v.mesure) && /NukeOnDelete/.test(v.mesure)),
  rouges.map((v) => v.mesure).join(' · ') || 'aucun échec');

console.log(`      ${verifs.filter(Boolean).length}/${verifs.length} vérifications`);
if (echecs.length) {
  console.log('      ÉCHECS :');
  for (const e of echecs) console.log(`      - ${e}`);
}
process.exitCode = echecs.length ? 1 : 0;
