// Reposer les hooks git locaux, qui ne sont PAS versionnés.
//
// `.git/hooks/` vit hors du dépôt : un clone, une restauration depuis un bundle,
// ou un `.git` refait à neuf arrivent sans aucun hook, et rien ne le dit. Le
// contrôle du commit disparaît alors en silence — exactement le mode de
// défaillance que ce dépôt refuse partout ailleurs. Il n'y a pas de tâche
// planifiée pour le rattraper (décision du 21/09/2026) : ce qui se répète passe
// par un geste ou par un hook événementiel, et ceci est le geste.
//
// Ce qui est installé est un SHIM de trois lignes : la logique vit dans
// `tests/sondes/hooks/pre-commit`, qui est versionné, donc relisible, donc
// corrigeable en revue. Le shim ne fait que déléguer — sans lui, corriger le
// hook ne corrigerait rien sur les postes déjà installés.
//
// Il REFUSE d'écraser un hook qui n'est pas le sien. Un `pre-commit` local peut
// porter une intention qu'on ne connaît pas, et l'écraser serait une perte
// silencieuse ; c'est le même principe que partout ailleurs ici : ce qu'on ne
// comprend pas, on ne le remplace pas.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ICI = path.dirname(fileURLToPath(import.meta.url));
const DEPOT = path.resolve(ICI, '..', '..');

const SOURCE = 'tests/sondes/hooks/pre-commit';
const MARQUE = 'shim diskmap';

// Le shim `cd` d'abord, puis exécute par un chemin RELATIF. Passer un chemin
// absolu de la forme `G:/…` à `sh` marcherait peut-être — mais « marcherait
// peut-être » n'est pas une mesure, et ce dépôt a déjà payé une fois pour avoir
// supposé qu'un chemin se traduisait tout seul.
const SHIM = `#!/bin/sh
# ${MARQUE} — la logique vit dans ${SOURCE} (versionné).
racine=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
cd "$racine" 2>/dev/null || exit 0
exec sh ${SOURCE} "$@"
`;

// Trouver `.git` en REMONTANT, sans lancer git. Le lancer serait plus court,
// mais ce script doit pouvoir tourner partout — y compris là où `spawn` est
// refusé, ce qui est arrivé en écrivant ces lignes (`EBUSY`), et un installeur
// qui échoue pour une raison qui n'a rien à voir avec les hooks ne dit plus
// rien d'utile. `.git` peut être un DOSSIER, ou un FICHIER pour un worktree ou
// un sous-module ; les deux cas sont traités, parce que l'ignorer ferait
// écrire le hook dans le vide.
function trouverDossierGit(depart) {
  let d = depart;
  for (;;) {
    const g = path.join(d, '.git');
    if (fs.existsSync(g)) {
      if (fs.statSync(g).isDirectory()) return g;
      const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(g, 'utf8'));
      return m ? path.resolve(d, m[1].trim()) : null;
    }
    const parent = path.dirname(d);
    if (parent === d) return null;
    d = parent;
  }
}

const dossierGit = trouverDossierGit(DEPOT);
if (!dossierGit) {
  console.error('Aucun `.git` au-dessus de ce dossier : il n\'y a pas de dépôt à équiper.');
  process.exit(1);
}

const source = path.join(DEPOT, SOURCE);
if (!fs.existsSync(source)) {
  console.error(`${SOURCE} est absent : rien à installer.`);
  process.exit(1);
}

const hooks = path.join(dossierGit, 'hooks');
const cible = path.join(hooks, 'pre-commit');
fs.mkdirSync(hooks, { recursive: true });

if (fs.existsSync(cible)) {
  const actuel = fs.readFileSync(cible, 'utf8');
  if (!actuel.includes(MARQUE)) {
    console.error(`Refus d'écraser ${path.relative(DEPOT, cible)} : ce hook n'est pas celui de diskmap.`);
    console.error('Il a été écrit par autre chose. Le relire, puis le retirer à la main si c\'est voulu.');
    process.exit(1);
  }
}

fs.writeFileSync(cible, SHIM, 'utf8');
try {
  fs.chmodSync(cible, 0o755);
} catch {
  // Windows n'a pas de bit exécutable : git pour Windows lance le hook dès lors
  // qu'il porte un shebang. L'échec ici n'est pas un échec.
}

console.log(`Hook installé : ${path.relative(DEPOT, cible)}`);
console.log(`  -> ${SOURCE}`);
console.log('  Contrôle au commit : cargo fmt -- --check, puis les références de la doc.');
console.log('  Silencieux si tout passe. `clippy`, les tests et les sondes restent à la CI.');
