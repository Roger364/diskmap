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
  // UN SEPARATEUR, toujours. `DISKMAP_SONDE_RACINE` est posee avec des
  // antislashs par le workflow — `D:\_diskmap_sondes` — alors que le defaut
  // emploie la barre oblique. Un cheminmelange est un chemin dont on ne sait
  // pas couper : le 27/09, la sonde d elevation a coupe `D:\_diskmap_sondes` en
  // un seul segment, a cherche ce segment dans l instantane, et a conclu
  // « manque D:\_diskmap_sondes` » — l antislash compris — sur un dossier qui
  // existait bel et bien. Normaliser ici rend la forme du chemin independante
  // de celui qui l a ecrite, et supprime la classe entiere du defaut plutot
  // qu un cas.
  return r.replace(/(?:\\|\/)+/g, '/');
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

/**
 * Retrouver dans la corbeille les charges `$R` dont le CONTENU est exactement
 * celui qu'on cherche.
 *
 * Une sonde qui met un fichier a la corbeille doit le reprendrederniere, sinon
 * chaque execution laisse un residu de quelques octets dans le dossier du
 * developpeur -- et un test qu'on hesite a relancer est un test qu'on ne
 * relance pas. Or la corbeille renomme : le nom d'origine n'y est plus. On
 * retrouve donc par le contenu, pas par le nom.
 *
 * La fonction compare la TAILLE d'abord : sur une corbeille de plusieurs
 * milliers d'entrees, lire chaque fichier serait lent, et lire un repertoire
 * serait une faute de tres.
 */
/** Les SID de corbeille qu'on peut lire, et ceux qu'on ne peut pas. */
export function sidsDeCorbeille(corbeille) {
  const lisibles = [], illisibles = [];
  let entrees;
  try { entrees = fs.readdirSync(corbeille); } catch (e) {
    return { lisibles, illisibles, erreur: `${e.code} ${e.message}` };
  }
  for (const sid of entrees) {
    try {
      if (!fs.statSync(`${corbeille}/${sid}`).isDirectory()) continue;
      fs.readdirSync(`${corbeille}/${sid}`);
      lisibles.push(sid);
    } catch (e) { illisibles.push(`${sid} (${e.code})`); }
  }
  return { lisibles, illisibles, erreur: null };
}

export function fouillerCorbeille(corbeille, contenu) {
  const trouvees = [];
  const taille = Buffer.byteLength(contenu, 'utf8');
  let sids;
  try { sids = fs.readdirSync(corbeille); } catch { return trouvees; }
  for (const sid of sids) {
    const dossier = `${corbeille}/${sid}`;
    if (!fs.existsSync(dossier)) continue;
    let noms;
    try {
      if (!fs.statSync(dossier).isDirectory()) continue;
      noms = fs.readdirSync(dossier);
    } catch { continue; }
    for (const n of noms) {
      if (!n.startsWith('$R')) continue;
      const f = `${dossier}/${n}`;
      let st;
      try { st = fs.statSync(f); } catch { continue; }
      if (!st.isFile() || st.size !== taille) continue;
      try { if (fs.readFileSync(f, 'utf8') === contenu) trouvees.push(f); } catch { /* illisible */ }
    }
  }
  return trouvees;
}

/** Retirer de la corbeille les charges `$R` trouvées ET leur fiche `$I`. */
export function viderTrouves(corbeille, trouvees) {
  let rendus = 0;
  for (const f of trouvees) {
    const dossier = f.slice(0, f.lastIndexOf('/'));
    const nom = f.slice(f.lastIndexOf('/') + 1);
    const suffixe = nom.replace(/^\$R/, '').replace(/\.[^.]*$/, '');
    try { fs.unlinkSync(f); rendus++; } catch { /* deja parti */ }
    try {
      for (const n of fs.readdirSync(dossier)) {
        if (n.startsWith('$I') && n.includes(suffixe)) {
          try { fs.unlinkSync(`${dossier}/${n}`); } catch { /* fiche absente */ }
        }
      }
    } catch { /* dossier parti */ }
  }
  return rendus;
}

/** Ce volume a-t-il une corbeille ? La question se pose AVANT d'agir. */
export function aCorbeille(vol) {
  return fs.existsSync(corbeille(vol));
}

/**
 * Les paliers de taille, en octets. Mêmes valeurs que `PALIER_SUPPRIMER` et
 * `PALIER_SUPPRIMER_TOUT` dans `src/main.rs` — une constante dupliquée est une
 * constante qui finira par diverger en silence, et les deux sont fixées par le
 * rapport d'incident (74,2 Go).
 */
export const Go = 1e9;
export const PALIER_SUPPRIMER = 20 * Go;
export const PALIER_SUPPRIMER_TOUT = 500 * Go;

/**
 * Les mots que le serveur va exiger — DÉDUITS DES FAITS, jamais recopiés de sa
 * réponse.
 *
 * La règle du serveur a trois entrées : le mode (corbeille ou définitif), la
 * présence d'une corbeille sur le volume, et le fait que le processus soit
 * ÉLEVÉ. Les sondes n'en connaissaient que les deux premières jusqu'au
 * 27/09/2026, et le runner de GitHub Actions est toujours élevé : sept sondes
 * qui affirmaient « aucun mot n'est exigé » sont donc devenues fausses d'un
 * coup, sans qu'une seule ligne de l'application ait changé de comportement.
 * C'est le test qui était faux, pas le produit — mais un test faux qui ne dit
 * pas pourquoi est un test qu'on ne peut pas/debuguer.
 *
 * Cette fonction est l'affirmation INDEPENDANTE des sondes. Si elle recopiait
 * `mots_recycle` / `mots_permanent`, elle ne vérifierait plus rien : elle
 * dirait au serveur « est-ce ce que tu as dit ? ».
 *
 * Elle est donc à lire comme une seconde implémentation de `mots_exiges`, et
 * toute divergence entre les deux est un défaut de l'une des deux.
 */
export function motsExiges({ permanent = false, corbeille = true, eleve = false, taille = 0 } = {}) {
  const mots = [];
  // L'ordre est celui du serveur : le palier le plus élevé l'emporte, et les
  // règles s'additionnent au lieu de se remplacer.
  if (taille >= PALIER_SUPPRIMER_TOUT) mots.push('SUPPRIMER TOUT');
  else if (taille >= PALIER_SUPPRIMER) mots.push('SUPPRIMER');
  if (permanent || !corbeille || eleve) mots.push('EFFACER');
  return mots;
}

/**
 * Le mot à envoyer, ou `undefined` quand il n'y en a pas.
 *
 * `undefined` et non `''` : le champ est alors absent de la requête, ce qui est
 * la situation normale d'un lot qui n'exige rien.
 */
export function aTaper(opts) {
  const mots = motsExiges(opts);
  return mots.length ? mots.join(' ') : undefined;
}

/**
 * Le serveur tourne-t-il dans une instance ÉLEVÉE ?
 *
 * Lu sur `/api/state` — le même endroit que la bannière, donc la même vérité.
 * On ne le devine pas : une instance élevée n'est pas une propriété de la
 * machine mais du jeton du processus, et un test qui la présumerait serait
 * faux chez l'un des deux côtés.
 */
export async function estEleve(base) {
  const s = await (await fetch(`${base.replace(/\/$/, '')}/api/state`)).json();
  return s.eleve === true;
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

// Il n'y a plus d'attente « le volume se repose », et c'est une suppression, pas
// une note de limite. Elle vivait ici : `attendreAnalyse(BASE, VOL, 0)` rendait
// la main des le premier tour ou `scanning` etait faux, donc sur l'instantane du
// run PRECEDENT ; sa seule protection, `n_files >= attendus`, comptait les
// fichiers du VOLUME — donc l'activite des AUTRES sondes, pas la sienne — et son
// dernier appelant l'utilisait ainsi, dans la sonde qui rejoue l'incident du
// 26/09/2026. Elle attend desormais le ticket qu'elle a demande
// (`attendreTicket`) ou le fichier qu'elle a ecrit (`attendreFichier`), et ces
// deux-la constatent un fait au lieu de deviner une fin. Un depot ne garde pas
// une attente dont la seule garantie est qu'elle n'expire pas.


/**
 * Attend que l'analyse promise à UN ticket soit publiée.
 *
 * L'inverse du problème historique : l'attente par drapeau — celle qui
 * concluait sur `!scanning` — concluait sur `!scanning`,
 * qui est vrai dans l'intervalle entre la fin du scan en vol et le début de
 * celui qu'on vient de demander — le harnais mesurait alors l'instantané du
 * run précédent. Ici, l'attente porte sur la promesse EXPLICITE que le serveur
 * rend à la demande : `POST /api/scan` renvoie `{ok, ticket}`, et `/api/state`
 * publie `scan_completed` avec l'instantané qu'il achève, sous les mêmes
 * verrous. `scan_completed >= ticket` signifie donc : l'analyse qui couvre
 * cette demande a été publiée, avec son instantané.
 *
 * `ticket` n'est PAS optionnel : une attente sans ticket serait retombée sur
 * le drapeau, c'est-à-dire sur l'attente fausse que cette fonction existe pour
 * remplacer. L'appelant qui n'a pas de ticket doit le dire, et chercher le fait
 * (`attendreFichier`, `attendreDossier`) — la preuve d'existence n'a jamais
 * résidé dans un drapeau.
 *
 * `>=` et non `==` : une analyse coalescée porte le DERNIER ticket demandé au
 * moment où elle démarre ; si une autre demande est arrivée entre-temps, elle
 * franchit aussi la borne. `==` attendrait un scan qui n'arrivera jamais.
 *
 * Un `!s.scanning` est lu comme garde-fou de SERVICE, jamais comme preuve :
 * le serveur a pu être arrêté pendant l'attente — sans lui, la boucle tournerait
 * six cents fois pour rien. Le verdict reste la borne sur `scan_completed`.
 */
export async function attendreTicket(base, vol, ticket, tours = 600) {
  if (!Number.isFinite(ticket)) throw new Error(`attendreTicket : ticket invalide (${ticket})`);
  const lettre = String(vol).toUpperCase();
  for (let i = 0; i < tours; i++) {
    const s = await (await fetch(`${base}/api/state`)).json();
    const d = (s.drives || []).find((x) => x.letter === lettre);
    if (d && d.scan_completed >= ticket) return d;
    if (s && s.scanning === null && !d) return null;
    if (s && !s.scanning && d && d.status === 'empty' && d.scan_completed < ticket) {
      // Le volume a été annulé (arrêt, purge de la file) : sa demande ne sera
      // jamais honorée. `attendreTicket` le dit plutôt que d'expirer en silence.
      return null;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}

/**
 * Attend qu'un DOSSIER soit PUBLIE, adresse par son CHEMIN.
 *
 * C'est le fait minimal : `/api/tree` le rend, donc il fait partie de
 * l'instantane. Le CONTENU du dossier, lui, change -- une sonde qui supprime un
 * de ses fichiers pour prouver qu'un identifiant designe une position
 * s'attacherait sinon a attendre un fait devenu faux.
 */
export async function attendreDossier(base, vol, chemin, tours = 600) {
  const c = encodeURIComponent(chemin);
  for (let i = 0; i < tours; i++) {
    const s = await (await fetch(`${base}/api/state`)).json();
    if (s && !s.scanning) {
      const r = await fetch(`${base}/api/tree?drive=${vol}&chemin=${c}&limit=200`);
      if (r.ok) return await r.json();
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}

/**
 * Attend qu'un NOM apparaisse dans un DOSSIER, adresse par son CHEMIN.
 *
 * C'est le critere de FAIT, et il est meilleur qu'un compte de fichiers : le
 * volume perd des fichiers en cours de run -- les sondes en suppriment, c'est
 * leur raison d'etre -- donc un plancher sur `n_files` peut etre franchi meme
 * quand l'instantane n'a pas encore le fichier qu'on cherche. Compter, c'est
 * constater une consequence ; chercher le nom, c'est constater le fait.
 *
 * L'attente porte sur le CONTENU DU DOSSIER, jamais sur la fin d'une analyse.
 * Les deux sont des faits INDIRECTS, et la mesure a montre qu'ils mentent tous
 * les deux. Juste apres `POST /api/scan`, l'analyse n'est pas encore lancee,
 * donc `scanning` est encore faux : une attente sur le drapeau passe aussitot
 * et l'on mesure l'instantane du run precedent. Puis, depuis que le serveur
 * accepte une demande d'analyse pendant une analyse (28/09/2026), attendre un
 * changement de `finished_ms` n'ameliore rien : le changement peut etre celui de
 * l'analyse deja en cours au moment ou la sonde a ecrit. L'attente par le fait
 * est plus lente, et c'est la seule exacte.
 *
 * Le chemin, et non le nom du dossier, parce qu'un nom n'est une adresse que
 * tant qu'il est rare. `perime` se perdait parmi 356 `experimental`, et `csrf`
 * parmi tous les `node_modules` du disque : la recherche est plafonnee, et le
 * dossier sortait de la premiere page. Un chemin est unique par construction.
 *
 * L'attente est bornee : au pire, la sonde appelante constate l'absence et le
 * dit. C'est un RESULTAT, jamais une ligne de trop.
 */
export async function attendreFichier(base, vol, chemin, nom, tours = 600) {
  const c = encodeURIComponent(chemin);
  for (let i = 0; i < tours; i++) {
    const s = await (await fetch(`${base}/api/state`)).json();
    if (s && !s.scanning) {
      const r = await fetch(`${base}/api/tree?drive=${vol}&chemin=${c}&limit=200`);
      if (r.ok) {
        const t = await r.json();
        const ligne = (t.rows || []).find((x) => x.name === nom);
        // L'arbre entier, pas seulement la ligne : `id` d'une LIGNE identifie
        // l'element, pas le dossier qu'on vient de lire, et s'en servir pour
        // lister ce dossier rend une liste vide. Aucune conversion a deviner.
        if (ligne) return { ligne, arbre: t };
      }
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}
