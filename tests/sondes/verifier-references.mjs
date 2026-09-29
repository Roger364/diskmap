// Chaque `fichier:ligne` de la documentation doit designer le code qu'elle
// annonce.
//
// Le 27/09/2026, sur 21 références de SECURITY.md, quatre étaient fausses :
// trois pointaient vers la mauvaise fonction, et une décrivait un défaut déjà
// corrigé dans le code. Aucune n'avait été vérifiée depuis l'audit du 26/09,
// parce qu'une référence de ligne a l'air d'une chose stable : elle ne l'est
// pas, et elle devient de la fiction au premier commit qui ajoute cent lignes.
//
// Ce contrôle rend la vérification permanente. Il est volontairement STRICT :
//
//  1. la ligne existe, et elle n'est pas vide — c'est la dérive pure, celle que
//     un `grep` de la longueur du fichier suffit à manquer ;
//  2. la ligne CONTIENT le symbole que la documentation annonce — c'est le
//     défaut qu'un décalage de lignes ne révèle pas, et celui qui compte ;
//  3. toute référence NOUVELLE, sans symbole déclaré ici, est signalée. Une
//     référence non vérifiée ne passe pas en douce : elle se déclare, et le
//     contrôle échoue tant qu'elle n'a pas été lue.
//
// Le tableau ci-dessous est la trace de la vérification manuelle. Il est
// relisible, donc contestable : si une référence désigne bien autre chose que
// le symbole écrit, c'est le tableau qu'il faut corriger, et la correction
// se voit dans une revue.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ICI = path.dirname(fileURLToPath(import.meta.url));
const DEPOT = path.resolve(ICI, '..', '..');
const DOCS = ['SECURITY.md', 'README.md'];

// document -> reference -> fragment que la ligne vise doit contenir
const ATTENDU = {
  'SECURITY.md': {
    'src/main.rs:105': 'struct Montre',
    'src/main.rs:867': 'fn hote_local',
    'src/main.rs:945': 'X-Diskmap absent',
    'src/main.rs:1139': 'fn dossier_de',
    'src/main.rs:205': 'fn decider_le_navigateur',
    'src/scan.rs:977': 'let rd = match fs::read_dir(path)',
    'tests/sondes/sonde-ui-suppression.mjs:101': "zztaille-z.txt', 'x'.repeat(2000)",
    'tests/sondes/sonde-ui-suppression.mjs:711': 'taille égale, l’écran range',
    'src/main.rs:333': 'decider_le_navigateur(&args, std::io::stdin().is_terminal())',
    'src/main.rs:616': 'fn demande_couverte',
    'src/main.rs:627': 'en_attente.push(letter);',
    'src/main.rs:632': 'fn start_scan',
    'src/main.rs:338': 'Navigateur  : non ouvert',
    'tests/sondes/lancer.mjs:345': "'--port', String(port), '--no-browser'",
    'src/main.rs:1484': 'fn blocked_reason',
    'src/main.rs:1619': 'gen_vue != snap.gen',
    'src/main.rs:1755': 'app.pending.lock()',
    'src/main.rs:1756': 'retiré ICI aussi',
    'src/main.rs:1760': 'p.retain',
    'src/main.rs:1804': 'app.pending.lock()',
    'src/main.rs:2092': 'let rescan = scan_ticket.is_some()',
    'src/main.rs:2702': 'fn journal',
    'src/scan.rs:386': 'GENERATION',
    'src/scan.rs:455': 'gen: GENERATION',
    'src/scan.rs:503': 'pub fn dir_path',
    'src/scan.rs:526': 'pub fn file_path',
    'src/scan.rs:1004': 'REPARSE_POINT',
        'ui/index.html:524': 'le reste est',
    'ui/index.html:427': 'let peintMs = null;',
    'ui/index.html:1862': 'peintMs === null || (d.finished_ms || 0) === peintMs',
    'ui/index.html:1867': 'rechargerTri();',
    'ui/index.html:525': 'ne pouvait pas',
    'ui/index.html:727': 'let requete = 0',
    'ui/index.html:763': 'if (mien !== requete) return;',
    'ui/index.html:786': 'if (mien !== requete) return;',
    'ui/index.html:980': 'if (mien !== requete) return;',
    'ui/index.html:1099': 'relancer en administrateur',
    'ui/index.html:1110': 'const cause = dr ?',
    'tests/sondes/lancer.mjs:574': 'const connus',
    'tests/sondes/lancer.mjs:802': 'const muette = !compte',
    'tests/sondes/lancer.mjs:801': 'const vide = !!compte',
    'tests/sondes/lancer.mjs:902': 'resume vide : la sonde annonce',
    'tests/sondes/lancer.mjs:825': 'const descompteFaux = !!compte',
    'tests/sondes/lancer.mjs:906': 'aucun decompte ecrit',
    'tests/sondes/lancer.mjs:909': 'decompte incoherent : la sonde annonce',
    'tests/sondes/lancer.mjs:855': 'const mention = notes.length',
    'tests/sondes/lancer.mjs:951': 'note(s) de',
    'tests/sondes/sonde-generation.mjs:37': 'function verifier(nom, cond, mesure)',
    'tests/sondes/sonde-generation.mjs:167': 'verifs.filter(Boolean).length',
    'tests/sondes/config.mjs:452': 'export async function attendreTicket',
    'tests/sondes/sonde-generation.mjs:71': 'async function analyserEtAttendre',
    'tests/sondes/sonde-tickets.mjs:62': 'async function demander',
    'ui/index.html:675': 'cur.ticket = rep && typeof rep.ticket',
    'ui/index.html:693': 'd.scan_completed >= cur.ticket',
    'ui/index.html:1560': 'cur.ticket = typeof res.scan_ticket',
    'tests/sondes/config.mjs:413': 'export async function attendreAnalyse',
    'tests/sondes/sonde-ui-suppression.mjs:530': 'const armerPeints',
    'tests/sondes/sonde-ui-suppression.mjs:553': 'const attendreEcranStable',
    'tests/sondes/sonde-ui-suppression.mjs:773': 'jamais été contredit',
  },
  'README.md': {
    'src/scan.rs:977': 'let rd = match fs::read_dir(path)',
    'tests/sondes/sonde-ui-suppression.mjs:101': "zztaille-z.txt', 'x'.repeat(2000)",
    'tests/sondes/sonde-ui-suppression.mjs:711': 'taille égale, l’écran range',
    'tests/sondes/sonde-generation.mjs:37': 'function verifier(nom, cond, mesure)',
    'tests/sondes/sonde-generation.mjs:167': 'verifs.filter(Boolean).length',
    'tests/sondes/config.mjs:452': 'export async function attendreTicket',
    'tests/sondes/sonde-generation.mjs:71': 'async function analyserEtAttendre',
    'tests/sondes/sonde-tickets.mjs:62': 'async function demander',
    'ui/index.html:675': 'cur.ticket = rep && typeof rep.ticket',
    'ui/index.html:693': 'd.scan_completed >= cur.ticket',
    'ui/index.html:1560': 'cur.ticket = typeof res.scan_ticket',
    'tests/sondes/config.mjs:413': 'export async function attendreAnalyse',
    'tests/sondes/lancer.mjs:802': 'const muette = !compte',
    'tests/sondes/lancer.mjs:801': 'const vide = !!compte',
    'tests/sondes/lancer.mjs:902': 'resume vide : la sonde annonce',
    'tests/sondes/lancer.mjs:825': 'const descompteFaux = !!compte',
    'tests/sondes/lancer.mjs:906': 'aucun decompte ecrit',
    'tests/sondes/lancer.mjs:909': 'decompte incoherent : la sonde annonce',
    'tests/sondes/lancer.mjs:855': 'const mention = notes.length',
    'tests/sondes/lancer.mjs:951': 'note(s) de',
    'ui/index.html:427': 'let peintMs = null;',
    'ui/index.html:1862': 'peintMs === null || (d.finished_ms || 0) === peintMs',
    'ui/index.html:1867': 'rechargerTri();',
    'src/main.rs:616': 'fn demande_couverte',
    'src/main.rs:627': 'en_attente.push(letter);',
    'src/main.rs:632': 'fn start_scan',
  },
};

const verifs = [], echecs = [];
function verifier(nom, cond, mesure) {
  const ok = !!cond; verifs.push(ok);
  if (!ok) echecs.push(`${nom} — mesuré : ${mesure}`);
  console.log(`${ok ? 'ok   ' : 'ROUGE'} ${nom}${ok ? '' : `\n      mesuré : ${mesure}`}`);
}

console.log('--- les références de la documentation désignent-elles leur code ? ---');

for (const doc of DOCS) {
  const texte = fs.readFileSync(path.join(DEPOT, doc), 'utf8');
  // `src/scan.rs:386,455` cite DEUX references : chaque nombre compte. En
  // n en retenant qu un, la seconde entree du tableau paraissait orpheline, et
  // le controle signalait un document qui ne cite plus rien.
  const refs = [...new Set(
    [...texte.matchAll(/((?:src|tests\/sondes|ui)\/[A-Za-z_.-]+\.(?:rs|mjs|html)):((?:\d+)(?:[,-]\d+)*)/g)]
      .flatMap((m) => m[2].split(/[,-]/).map((n) => ({ fichier: m[1], ligne: Number(n) })))
      .filter((r) => Number.isFinite(r.ligne))
  )];
  const declarees = new Set(Object.keys(ATTENDU[doc] || {}));
  const vues = new Set();

  for (const r of refs) {
    const ref = `${r.fichier}:${r.ligne}`;
    vues.add(ref);
    const chemin = path.join(DEPOT, r.fichier);
    if (!fs.existsSync(chemin)) {
      verifier(`${doc} ${ref} désigne un fichier présent`, false, `${r.fichier} n'existe pas`);
      continue;
    }
    const lignes = fs.readFileSync(chemin, 'utf8').split(/\r?\n/);
    if (r.ligne < 1 || r.ligne > lignes.length) {
      verifier(`${doc} ${ref} désigne une ligne existante`, false,
        `${r.fichier} n'a que ${lignes.length} ligne(s)`);
      continue;
    }
    verifier(`${doc} ${ref} désigne une ligne existante et non vide`,
      lignes[r.ligne - 1].trim().length > 0,
      JSON.stringify(lignes[r.ligne - 1].slice(0, 60)));
    const attendu = (ATTENDU[doc] || {})[ref];
    if (attendu === undefined) {
      // Une référence écrite aujourd'hui, jamais relue : elle se déclare ici.
      verifier(`${doc} ${ref} a un symbole vérifié`, false,
        `aucune entrée dans le tableau de ${path.relative(DEPOT, path.join(ICI, 'verifier-references.mjs'))}`
        + ` — relire la ligne, puis l'ajouter`);
      continue;
    }
    verifier(`${doc} ${ref} désigne bien « ${attendu} »`,
      lignes[r.ligne - 1].includes(attendu),
      JSON.stringify(lignes[r.ligne - 1].trim().slice(0, 80)));
  }

  // L'inverse : un symbole vérifié qui n'est plus cité est un tableau périmé.
  for (const ref of declarees) {
    if (!vues.has(ref)) {
      verifier(`${doc} ${ref} est encore cité`, false,
        'le tableau le vérifie mais le document ne le cite plus');
    }
  }
}

console.log(`      ${verifs.filter(Boolean).length}/${verifs.length} vérifications`);
if (echecs.length) {
  console.log('      ÉCHECS :');
  for (const e of echecs) console.log(`      - ${e}`);
}
process.exitCode = echecs.length ? 1 : 0;
