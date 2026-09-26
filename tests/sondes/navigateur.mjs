// Playwright, charge de facon portable.
//
// Les sondes l'empruntaient au projet `waifu` voisin, par
// `createRequire('G:/workspaces/workbuddy-ai/waifu/')`. C'est un chemin de ce
// poste, et il les rendait inutilisables ailleurs — d'abord en integration
// continue, ou le depot n'a que lui-meme.
//
// On resout desormais depuis `tests/sondes/`, ou `npm install` a pose
// `node_modules/`. `DISKMAP_PLAYWRIGHT` permet de designer un autre dossier si
// Playwright est deja installe quelque part.
//
// En cas d'echec on sort en 2, et non en 1 : « je n'ai pas pu eprouver » n'est
// pas « j'ai eprouve et c'est rouge ». Confondre les deux ferait passer une
// installation manquante pour une regression.

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

const ICI = path.dirname(fileURLToPath(import.meta.url));

function charger() {
  const pistes = [];
  if (process.env.DISKMAP_PLAYWRIGHT) {
    pistes.push([process.env.DISKMAP_PLAYWRIGHT, 'DISKMAP_PLAYWRIGHT']);
  }
  pistes.push([ICI, 'tests/sondes']);

  const manques = [];
  for (const [dossier, ou] of pistes) {
    try {
      return createRequire(path.join(dossier, 'sondes.mjs'))('playwright');
    } catch (e) {
      if (e.code !== 'MODULE_NOT_FOUND') throw e;
      manques.push(ou);
    }
  }
  console.error('Playwright est introuvable. Cherche dans : ' + manques.join(', '));
  console.error('Depuis tests/sondes/ :  npm install');
  process.exit(2);
}

const playwright = charger();

export const chromium = playwright.chromium;
