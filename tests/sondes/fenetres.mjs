// Les fenetres que les sondes ouvrent, et qu'elles doivent rendre.
//
// Une sonde a le droit de faire travailler le serveur comme un vrai clic : c'est
// meme la seule facon de prouver certaines routes. `/api/reveal` en est l'exemple
// — elle ouvre l'Explorateur, pour de bon. Le 27/09/2026, cette preuve a laisse
// une fenetre « Bureau » a l'echran a chaque run, et 33 s'y sont accumulees sur la
// machine de l'auteur de ces lignes. Une sonde qui salit le bureau de celui qui la
// lance n'est plus une sonde.
//
// Ce module n'invente aucun remede cote serveur : `/api/reveal` doit continuer
// d'ouvrir une fenetre visible, parce que c'est ce que demande la personne qui
// clique sur « reveler ». Il n'intervient qu'autour de l'appel, et selon une seule
// regle : **fermer ce qu on a fait naitre, rien d'autre.** L'instantane des
// fenetres deja ouvertes est pris AVANT la route, et un descripteur qui y figure
// n'est jamais touche — une fenetre que l'utilisateur ouvre de son cote pendant
// la sonde lui reste.
//
// Le guetteur est lance AVANT l'appel, pas apres : c'est ce qui permet de
// minimiser la fenetre a sa naissance plutot que de la rattraper une seconde plus
// tard, quand elle a deja vole le focus.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ICI = path.dirname(fileURLToPath(import.meta.url));
const PS1 = path.join(ICI, 'fenetres.ps1');

/** Duree de bail par defaut. Assez large pour une ouverture d'Explorateur. */
const BAIL = 8000;

/**
 * Lance un guetteur de fenetres.
 *
 * @param {number} [duree] fenetre de surveillance, en millisecondes
 * @returns {{ arreter: () => Promise<{ neutre: boolean, raison: string,
 *            neutralisees: number, fermees: number, echecs: number,
 *            titres: string[] }> }}
 */
export function surveillerFenetres(duree = BAIL) {
  const enfant = spawn('powershell', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS1,
    '-DureeMs', String(duree),
  ], { windowsHide: true });

  let sortie = '';
  let termine = false;
  let sortieComplete = '';
  let code = null;

  enfant.stdout.on('data', (d) => { sortie += d.toString('utf8'); });
  enfant.stderr.on('data', (d) => { sortie += d.toString('utf8'); });
  enfant.on('close', (c) => { code = c; sortieComplete = sortie; termine = true; });

  return {
    async arreter() {
      if (!termine) {
        await new Promise((r) => {
          const fini = () => r();
          if (termine) return fini();
          enfant.once('close', fini);
          // Filet : un guetteur bloque ne doit pas bloquer la sonde. On le tue,
          // et on le DIT — un `neutre: true` sur un guetteur mort serait un
          // succes mesure par un capteur qui ne mesurait plus rien.
          setTimeout(() => { try { enfant.kill(); } catch { /* deja parti */ } }, duree + 20000);
        });
      }
      return lire(sortieComplete, code);
    },
  };
}

/**
 * Lit le compte rendu du guetteur.
 *
 * Une sortie illisible n'est pas un succes : c'est un cas NON MESURE, et la
 * discipline du harnais est qu'un cas non mesure ne vaut ni vert ni rouge.
 */
function lire(sortie, code) {
  const ligne = sortie.split(/\r?\n/).find((l) => l.startsWith('FENETRES '));
  if (!ligne) {
    return {
      neutre: false,
      raison: `le guetteur n'a rien dit (code ${code}) — ${sortie.trim().slice(0, 200) || 'sortie vide'}`,
      neutralisees: 0, fermees: 0, echecs: 0, titres: [],
    };
  }
  const nombre = (cle) => {
    const m = ligne.match(new RegExp(`${cle}=(\\d+)`));
    return m ? Number(m[1]) : 0;
  };
  const titres = (ligne.match(/titres=\[(.*)\]/) || [, ''])[1]
    .split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
  return {
    neutre: true,
    raison: '',
    neutralisees: nombre('neutralisees'),
    fermees: nombre('fermees'),
    echecs: nombre('echecs'),
    titres,
  };
}

/** Phrase de mesure, pour le message d'un echec. */
export function mesurer(r) {
  return r.neutre
    ? `${r.neutralisees} neutralisee(s), ${r.fermees} fermee(s), ${r.echecs} echec(s)`
      + (r.titres.length ? ` — « ${r.titres.join(' » | « ')} »` : '')
    : r.raison;
}
