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
import { spawnSync } from 'child_process';

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
 * Ce que l operateur AFFIRME, quand aucun fait ne peut le prouver.
 *
 * Un runner GitHub est jetable parce que le RUNNER est ephemere, pas parce que
 * son `D:` ressemble a un disque virtuel. Aucun releve ne peut etablir cela :
 * `D:` la, c est un disque physique comme un autre. Il faut donc le dire, et le
 * dire chaque fois.
 *
 * C est une VALEUR, pas un booleen, volontairement. Un `=1` passe inaperçu et
 * devient un rituel : pose une fois dans un workflow, pose dans tous les
 * suivants, pose dans un poste de travail par copier-coller — et la regle
 * n interroge plus rien. En exigeant un MOT, le log affiche ce quelqu un a
 * reellement cru, et la mention reste assez visible pour etre remarkee.
 * Elle est donc reprise telle quelle a l ecran, a chaque run.
 */
export const MACHINE_EPHEMERE = (process.env.DISKMAP_SONDE_MACHINE_EPHEMERE || '').trim();

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

// ------------------------------------------------------- volume jetable
//
// Une sonde qui detruit ne doit tourner que sur un volume jetable. Le 26/09/2026,
// elle en a tourne une sur `G:`, le volume de travail par defaut d'une machine
// qui contenait des donnees.
//
// OU EST LA REGLE, ET POURQUOI
// ----------------------------
// Elle vit dans le HARNais, jamais dans l'application. `diskmap` doit pouvoir
// supprimer sur n'importe quel volume : c'est son metier. Ce qui doit etre
// refuse, c'est de faire courir des tests automatiques qui SUPPRIMENT ailleurs
// que sur unSupport jetable. Un humain qui clique dans l'interface ne passe
// jamais par ici.
//
// LA QUESTION UTILE
// -----------------
// Pas « ce volume a-t-il l'air jetable ? » — cette question a un contre-exemple
// sur cette machine meme. `D:` fait 50 Mo, n'est ni boot ni systeme : tous les
// indices lui vont. Il est pourtant une partition du disque 0, celui qui porte
// les 476 Go de `G:`. Taille, `IsBoot` et `IsSystem` sont ANTI-CORRELES avec la
// securite : `G:` est lui aussi « ni boot ni systeme », et il porte tout.
//
// La bonne question est « qu'est-ce qui meurt si je detruis tout ce volume ? ».
// Un seul fait y repond, et il est structurel : un disque virtuel. Un VHD est
// un FICHIER pose sur un autre disque ; le detruire detruit un fichier, et ce
// fichier n'a ete cree que pour ca. Aucun disque physique, lui, ne peut etre
// declare jetable par une propriete : un disque de 4 To en une seule partition
// peut contenir les seules sauvegardes de quelqu'un, et « il n'y a rien a cote »
// n'y change rien.

/**
 * Regle pure : ce volume est-il jetable ?
 *
 * Volontairement sans effet de bord et sans lecture du disque, pour que le test
 * mecanique puisse l'eprouver sur des faits releves, sans jamais approcher un
 * fichier. Une regle qui ne peut pas etre testee sans risque n'est pas une
 * regle, c'est une intention.
 *
 * @param {object|null} f  faits releves par `interrogerVolumes`
 * @returns {{jetable: boolean, motif: string}}
 */
export function volumeJetable(f) {
  if (!f) return { jetable: false, motif: "ce volume n'est pas monte sur cette machine" };
  if (f.bus === 'File Backed Virtual') {
    return {
      jetable: true,
      motif: `disque virtuel « ${f.nomDisque} » : ce volume est un fichier, rien d'autre ne l'habite`,
    };
  }
  const autres = Math.max(0, (f.partitions || 0) - 1);
  const cause = autres > 0
    ? `${f.partitions} volumes partagent ce disque`
    : 'un disque physique ne se declare pas jetable';
  return {
    jetable: false,
    motif: `${f.lettre}: est sur « ${f.nomDisque} » (${f.bus || 'bus inconnu'}) — ${cause}. `
      + 'Detruire ce volume detruirait autre chose que lui.',
  };
}

/**
 * Relit les volumes montes et ce que Windows sait d'eux.
 *
 * Un seul processus PowerShell pour toutes les lettres : demarre une fois, il
 * coute ~1,6 s (mesure), et le harnais analyse de toute facon 2,1 millions de
 * fichiers. Le script est passe par `-EncodedCommand` (base64 UTF-16LE) plutot
 * que par la ligne de commande ou l'entree standard : sur cette machine
 * `powershell -Command -` n'emet rien du tout, et un script a ecrire dans un
 * fichier temporaire impose de l'encoder. `-EncodedCommand` n'a besoin d'aucun
 * des deux.
 *
 * @returns {Array<object>} faits par lettre de volume, `[]` si PowerShell echoue
 */
export function interrogerVolumes() {
  const script = [
    // Sans cela, PowerShell ecrit dans la page de code de la console et
    // l'etiquette « Reserve au systeme » arrive en caractere de remplacement.
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '$r = @()',
    'Get-Volume | Where-Object { $_.DriveLetter } | ForEach-Object {',
    '  $p = Get-Partition -DriveLetter $_.DriveLetter -ErrorAction SilentlyContinue',
    '  $d = $null',
    '  if ($p) { $d = Get-Disk -Number $p.DiskNumber -ErrorAction SilentlyContinue }',
    '  $r += [pscustomobject]@{',
    '    lettre = $_.DriveLetter;',
    '    etiquette = $_.FileSystemLabel;',
    '    format = $_.FileSystemType;',
    '    mo = [math]::Round($_.Size / 1MB, 1);',
    '    bus = $(if ($d) { [string]$d.BusType } else { "" });',
    '    nomDisque = $(if ($d) { $d.FriendlyName } else { "" });',
    '    boot = $(if ($d) { [bool]$d.IsBoot } else { $false });',
    '    systeme = $(if ($d) { [bool]$d.IsSystem } else { $false });',
    '    partitions = $(if ($d) { @(Get-Partition -DiskNumber $d.Number).Count } else { 0 })',
    '  }',
    '}',
    '$r | ConvertTo-Json -Compress',
  ].join('\n');

  const encode = Buffer.from(script, 'utf16le').toString('base64');
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encode], {
    encoding: 'buffer',
    timeout: 60_000,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (r.status !== 0 || !r.stdout) return [];
  try {
    const v = JSON.parse(r.stdout.toString('utf8').trim());
    return Array.isArray(v) ? v : [v];
  } catch {
    return [];
  }
}

/** Une ligne lisible sur un volume, pour l'afficher avant d'agir. */
export function decrireVolume(f) {
  if (!f) return 'volume absent';
  const tag = f.etiquette ? ` « ${f.etiquette} »` : '';
  return `${f.lettre}:${tag} ${f.format} ${f.mo} Mo — « ${f.nomDisque} » (${f.bus || 'bus inconnu'})`
    + `${f.boot ? ', boot' : ''}${f.systeme ? ', systeme' : ''}, ${f.partitions} volume(s) sur le disque`;
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
