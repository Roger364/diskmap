// Ce que les sondes doivent savoir de la machine — et rien de plus.
//
// Trois valeurs, lues dans l'environnement, avec des defauts qui fonctionnent
// aussi bien sur un poste de travail qu'en integration continue :
//
//   DISKMAP_SONDE_URL      adresse du serveur a eprouver
//   DISKMAP_SONDE_VOLUME   lettre du volume de travail, sans « : »
//   DISKMAP_SONDE_RACINE   dossier de travail, chemin absolu sur ce volume
//
// LA REGLE QUI COMMANDE CE FICHIER
// --------------------------------
// Une sonde ne cree et ne supprime QUE des fichiers sous `dossier(...)`. Elle le
// verifie avant d'agir, jamais apres.
//
// Cette regle n'est pas une precaution de principe : le 26/09/2026, une sonde de
// cout qui ne la suivait pas a detruit definitivement 65 fichiers reels et en a
// envoye 68 autres (74 Go) a la corbeille, disperses sur tout le volume. Les
// chemins qu'elle visait etaient resolus contre un index reanalyse : ils
// designaient d'autres fichiers que les siens.
//
// Corollaire pour la portabilite : la racine de travail est le SEUL chemin que
// les sondes connaissent, et il est configurable. Aucune sonde ne doit porter un
// chemin de ce poste en dur.

import fs from 'fs';
import path from 'path';

/** Adresse par defaut du serveur a eprouver. */
export const URL_DEFAUT = process.env.DISKMAP_SONDE_URL || 'http://127.0.0.1:8990/';

/** Volume de travail par defaut, sans « : ». */
export const VOLUME_DEFAUT = (process.env.DISKMAP_SONDE_VOLUME || 'G')
  .toUpperCase()
  .replace(/:$/, '');

/**
 * Volume SANS corbeille, pour la seule sonde qui doit eprouver ce cas.
 *
 * `FOF_ALLOWUNDO` ne veut dire que « vers la corbeille SI C'EST POSSIBLE » : sur
 * un volume qui n'en a pas, Windows detruit le fichier. Un volume exFAT n'a pas
 * de `$RECYCLE.BIN`. Ce volume n'existe pas partout — la sonde le dit et
 * s'abstient plutot que de conclure sur un cas qu'elle n'a pas su monter.
 */
export const VOLUME_SANS_CORBEILLE = (process.env.DISKMAP_SONDE_VOLUME_SANS_CORBEILLE || 'E')
  .toUpperCase()
  .replace(/:$/, '');

/**
 * Racine de travail sur un volume donne.
 *
 * `DISKMAP_SONDE_RACINE` l'emporte quand elle est posee — c'est ainsi que
 * l'integration continue designe un dossier temporaire sans toucher au code.
 *
 * Elle doit/designer le volume qu'on analyse. Le defaut, `C:\...` contre un
 * `V:` scans, ne coincidait avec rien : les sondes creaient leurs fichiers sur
 * un volume, interrogeaient l'instantane d'un autre, et concluaient « absent »
 * sans qu'aucune ligne ne dise pourquoi. Le genre de defaut qui fait perdre une
 * afternoon — et le genre qui, le jour ou la suppression suit, ne protege de
 * rien non plus.
 */
export function racine(vol) {
  const r = process.env.DISKMAP_SONDE_RACINE || `${vol}:/_diskmap_sondes`;
  const de = (r.match(/^([A-Za-z]):/) || [])[1];
  if (de && de.toUpperCase() !== String(vol).toUpperCase()) {
    throw new Error(
      `DISKMAP_SONDE_RACINE vaut « ${r} », qui est sur ${de.toUpperCase()}:, ` +
      `mais le volume analysé est ${String(vol).toUpperCase()}:. ` +
      `Les sondes créeraient leurs fichiers hors de l'instantane qu'elles interrogent.`
    );
  }
  return r;
}

/** Dossier de travail d'une sonde, sous la racine. */
export function dossier(vol, nom) {
  return `${racine(vol)}/${nom}`;
}

/** Corbeille d'un volume. Sa presence n'est pas garantie (exFAT n'en a pas). */
export function corbeille(vol) {
  return `${vol}:/$RECYCLE.BIN`;
}

/** Ce volume a-t-il une corbeille ? La question se pose AVANT d'agir. */
export function aCorbeille(vol) {
  return fs.existsSync(corbeille(vol));
}

/**
 * Journal de l'application.
 *
 * C'est la trace que les sondes relisent pour distinguer ce qui a ete DECLARE de
 * ce qui a eu lieu. Le 26/09/2026, il a ete la seule source exploitable apres un
 * incident : sans lui, on aurait su que des fichiers avaient disparu, sans
 * savoir lesquels, ni quand, ni par quel appel.
 */
export function journal() {
  return path.join(process.env.LOCALAPPDATA || '', 'diskmap', 'suppressions.log');
}

/**
 * Attend qu'un volume soit analyse ET que l'instantaner voie ce qu'on vient de
 * creer.
 *
 * Attendre seulement `!scanning` est une course, et elle est SILENCIEUSE :
 * l'analyse peut s'achever avant que les fichiers soient ecrits — ou le runner
 * peut servir un instantane en cache, plus vieux que la creation. Dans les deux
 * cas la boucle sort au premier tour, la sonde interroge un index qui ne
 * connait pas ses fichiers, et elle conclut « absent » ou « dossier hors de
 * l'instantane » : un verdict FAUX, sur un defaut qui n'existe pas. C'est ce
 * que le premier run sur GitHub a produit, et le diagnostic indiquait « les
 * protections ne fonctionnent plus » — alors que rien de tout cela n'etait vrai.
 *
 * `attendus` est le nombre de fichiers que le volume doit porter au minimum.
 * On le releve AVANT la creation et on y ajoute le nombre cree : la comparaison
 * porte alors sur le volume entier, donc elle marche aussi sur un runner deja
 * rempli, sans rien savoir du nom du dossier de travail.
 *
 * `attendreFichier` est préférable dans la plupart des cas — voir plus bas.
 *
 * Renvoie `true` si le volume porte bien le nombre attendu, `false` sinon. Un
 * `false` n'est pas une panne : la sonde appelante decide ce qu'il vaut, parce
 * que la consequence n'est pas la meme partout.
 */
export async function attendreAnalyse(base, vol, attendus = 0, tours = 600) {
  for (let i = 0; i < tours; i++) {
    const s = await (await fetch(`${base}/api/state`)).json();
    const d = (s.drives || []).find((x) => x.letter === String(vol).toUpperCase());
    if (s && !s.scanning) {
      if (!attendus) return true;
      if (d && d.n_files >= attendus) return true;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

/**
 * Attend qu'un fichier APPARAISSE dans l'instantane d'un volume.
 *
 * C'est le critere de FAIT, et il est meilleur qu'un compte de fichiers : le
 * volume perd des fichiers en cours de run — les sondes en suppriment, c'est
 * leur raison d'être — donc un plancher sur `n_files` peut être franchi même
 * quand l'instantané n'a pas encore le fichier qu'on cherche. Compter, c'est
 * constater une conséquence ; chercher le nom, c'est constater le fait.
 *
 * La recherche passe par `/api/search`, qui cherche dans le nom, et l'attente
 * est bornee : au pire, la sonde appelante constate l'absence et le dit.
 */
export async function attendreFichier(base, vol, nom, tours = 600) {
  const cible = encodeURIComponent(nom);
  for (let i = 0; i < tours; i++) {
    const s = await (await fetch(`${base}/api/state`)).json();
    if (s && !s.scanning) {
      const r = await (await fetch(`${base}/api/search?drive=${vol}&q=${cible}`)).json();
      if ((r.rows || []).some((x) => x.name === nom)) return true;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}
