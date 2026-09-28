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
    'src/main.rs:101': 'struct Montre',
    'src/main.rs:783': 'fn hote_local',
    'src/main.rs:861': 'X-Diskmap absent',
    'src/main.rs:1041': 'fn dossier_de',
    'src/main.rs:1385': 'fn blocked_reason',
    'src/main.rs:1520': 'gen_vue != snap.gen',
    'src/main.rs:1656': 'app.pending.lock()',
    'src/main.rs:1657': 'retiré ICI aussi',
    'src/main.rs:1661': 'p.retain',
    'src/main.rs:1764': 'app.pending.lock()',
    'src/main.rs:1982': 'let rescan = done > 0',
    'src/main.rs:2592': 'fn reveal',
    'src/scan.rs:386': 'GENERATION',
    'src/scan.rs:455': 'gen: GENERATION',
    'src/scan.rs:503': 'pub fn dir_path',
    'src/scan.rs:526': 'pub fn file_path',
    'src/scan.rs:1004': 'REPARSE_POINT',
        'ui/index.html:513': 'le reste est',
    'ui/index.html:514': 'ne pouvait pas',
    'ui/index.html:694': 'let requete = 0',
    'ui/index.html:730': 'if (mien !== requete) return;',
    'ui/index.html:753': 'if (mien !== requete) return;',
    'ui/index.html:942': 'if (mien !== requete) return;',
    'ui/index.html:1056': 'relancer en administrateur',
    'ui/index.html:1067': 'const cause = dr ?',
    'tests/sondes/lancer.mjs:553': 'const connus',
    'tests/sondes/lancer.mjs:753': 'const muette = !compte',
    'tests/sondes/lancer.mjs:801': 'aucun decompte ecrit',
    'tests/sondes/sonde-generation.mjs:37': 'function verifier(nom, cond, mesure)',
    'tests/sondes/sonde-generation.mjs:131': 'verifs.filter(Boolean).length',
    'tests/sondes/sonde-ui-suppression.mjs:520': 'const armerPeints',
    'tests/sondes/sonde-ui-suppression.mjs:543': 'const attendreEcranStable',
    'tests/sondes/sonde-ui-suppression.mjs:725': 'jamais été contredit',
  },
  'README.md': {
    'tests/sondes/sonde-generation.mjs:37': 'function verifier(nom, cond, mesure)',
    'tests/sondes/sonde-generation.mjs:131': 'verifs.filter(Boolean).length',
    'tests/sondes/lancer.mjs:753': 'const muette = !compte',
    'tests/sondes/lancer.mjs:801': 'aucun decompte ecrit',
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
