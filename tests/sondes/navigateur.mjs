// Playwright, charge de facon portable.
//
// Les sondes l'empruntaient au projet voisin, par
// `createRequire('G:/workspaces/<projet voisin>/')`. C'est un chemin de la
// machine de développement, et il les rendait inutilisables ailleurs — d'abord en integration
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

// ---------- la page, écoutée AUSSI par le réseau ----------
//
// Les quatre sondes qui pilotent un navigateur n'écoutaient que `pageerror`,
// c'est-à-dire le CODE de la page. Or une requête qui n'aboutit pas ne lève
// aucune exception de ce côté : elle finit en `TypeError: Failed to fetch`,
// attrapé quelque part, puis en silence.
//
// Le fait est mesuré. Le 29/09/2026, la sonde `elevation` a rendu ROUGE en
// n'affichant que ces deux mots — impossible de dire si le serveur avait
// refusé la connexion, coupé la réponse au milieu, ou si la page avait été
// déchargée sous ses pieds. Ces trois causes n'appellent pas le même remède,
// et un rouge qui ne dit pas la sienne ne se laisse pas corriger.
//
// `requestfailed` est l'événement qui, lui, nomme la requête ET la raison. Il
// est écouté ici une fois, pour les quatre sondes : c'est le seul endroit où
// le filtrage commun peut vivre, et le faire quatre fois serait quatre
// endroits où l'oubli est possible.
const MARQUE_EMBUSCADE = 'zz-embuscareseau-diskmap.json';

export function suivreRequetes(page, navigateur) {
  const echecs = [];

  page.on('requestfailed', (r) => {
    const echec = r.failure();
    echecs.push(`${r.method()} ${r.url()} — ${(echec && echec.errorText)
      || 'raison inconnue'}`);
  });

  // Le contrôle de MÊME LIGNE. On provoque un échec de réseau qu'on connaît,
  // et on vérifie que le collecteur le voit : sans lui, « aucune requête n'a
  // échoué » est un rapport de trous — vrai par défaut, incapable de rougir.
  // C'est exactement la faute que §7/28 de SECURITY.md raconte, et elle se
  // commettrait ici tout aussi tranquillement.
  //
  // Il a lieu sur une page JETABLE, avec son PROPRE contexte, et non sur la page
  // mesurée. La raison est mesurée aussi : un échec de ressource fait aussi une
  // ligne de CONSOLE (« Failed to load resource: net::ERR_UNSAFE_PORT »), et
  // deux des quatre sondes lisent cette console. Le premier essai, ce soir, a
  // fait rougir `identifiant` et `ui` sur le seul témoin : un témoin qui salit
  // la mesure n'est pas un témoin, c'est une source de faux positifs.
  //
  // Le contexte est créé explicitement pour cette raison : sur une page née de
  // `browser.newPage()`, Playwright refuse d'en ouvrir une autre
  // (« Please use browser.newContext() »), et le navigateur est donc demandé
  // en second argument plutôt que déduit de la page.
  const control = async () => {
    let ctx = null;
    const temoin = await navigateur.newContext()
      .then((c) => { ctx = c; return c.newPage(); });
    const vu = [];
    temoin.on('requestfailed', (r) => vu.push(`${r.method()} ${r.url()}`
      + ` — ${(r.failure() && r.failure().errorText) || 'raison inconnue'}`));
    try {
      // 127.0.0.1:1 est un port que Chromium refuse LUI-MÊME avant toute
      // connexion (net::ERR_UNSAFE_PORT, mesuré) : pas de DNS, pas de serveur à
      // invoquer, pas de sortie réseau. Le même verdict sur la machine de
      // développement et sur le runner, hors ligne compris.
      await temoin.evaluate(async (marque) => {
        try { await fetch(`http://127.0.0.1:1/${marque}`); } catch { /* voulu */ }
      }, MARQUE_EMBUSCADE);
    } catch (e) {
      await ctx.close().catch(() => {});
      return { vu: false, mesure: `la page temoin n’a pas pu tenter la requete : ${e.message}` };
    }
    // L'événement est asynchrone : il peut arriver après le retour de
    // `evaluate`. L'attendre, sinon le contrôle se declare rouge pour rien.
    for (let i = 0; i < 40 && vu.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    await ctx.close().catch(() => {});
    if (vu.length === 0) {
      return {
        vu: false,
        mesure: 'l’échec voulu sur 127.0.0.1:1 n’a pas été vu : le collecteur ne mord pas',
      };
    }
    return { vu: true, mesure: `l’échec voulu a été vu : ${vu[0]}` };
  };

  return { echecs, control };
}
