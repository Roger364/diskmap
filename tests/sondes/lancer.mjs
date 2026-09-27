// Chef d'orchestre des sondes.
//
// POURQUOI IL EXISTE
// ------------------
// Les sondes savaient deja eprouver l'application, mais rien ne les enchainait :
// il fallait lancer le serveur a la main, penser a analyser le bon volume, puis
// appeler onze scripts un par un en leur passant les bons arguments. Ce savoir
// vivait dans la memoire de qui l'avait fait, pas dans le depot.
//
// Consequence mesuree le 26/09/2026 : vingt-sept commits de corrections — six
// defauts trouves et reproduits — et aucun filet de securite qui voyage avec le
// code. Un clone du depot ne pouvait rien verifier.
//
// CE QU'IL FAIT
// -------------
//   1. demarre le binaire a eprouver sur un port libre, et lit l'adresse qu'il
//      annonce (il peut en choisir une autre si celle-ci est prise) ;
//   2. analyse le volume de travail et C:, et ATTEND que ce soit fini — une
//      sonde qui interroge un instantane absent conclut sur du vide ;
//   3. lance les sondes dans l'ordre, chacune avec ses arguments ;
//   4. rapporte, et sort en 1 si une seule est rouge.
//
// Chaque sonde sort deja en 1 quand elle echoue, et en 2 quand elle n'a pas pu
// eprouver. Ce chef d'orchestre distingue les deux : « pas pu eprouver » n'est
// pas « eprouve et rouge ».
//
// USAGE
// -----
//   node tests/sondes/lancer.mjs                      tout, sur le binaire de release
//   node tests/sondes/lancer.mjs --liste              la table des sondes, sans rien lancer
//   node tests/sondes/lancer.mjs --sans erreurs,arret sauter des sondes
//   node tests/sondes/lancer.mjs --tout               inclure les sondes locales
//   node tests/sondes/lancer.mjs --url http://127.0.0.1:8756/   eprouver un serveur deja lance
//
// Options : --volume L, --binaire chemin, --nettoyer, --attendre secondes
//
// LE FILET
// --------
// Les sondes ne parlent JAMAIS directement au serveur : elles passent par le
// proxy de `filet.mjs`, qui n transmet une suppression que si l'aperçu
// correspondant ne nommait que des chemins sous la racine de travail. C'est le
// filet qui a manqué le 26/09/2026 — il n'existait pas. Voir `filet.mjs` pour
// pourquoi c'est un proxy et non une vérification dans chaque sonde.

import { spawn } from 'child_process';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { fileURLToPath } from 'url';

import { creerFilet } from './filet.mjs';
import {
  URL_DEFAUT, VOLUME_DEFAUT, VOLUME_SANS_CORBEILLE, racine, MACHINE_EPHEMERE,
  interrogerVolumes, volumeJetable, decrireVolume,
} from './config.mjs';

const ICI = path.dirname(fileURLToPath(import.meta.url));
const DEPOT = path.resolve(ICI, '..', '..');

// ---------------------------------------------------------------- les sondes
//
// `ci` dit si la sonde a sa place dans une integration continue. Une sonde
// locale n'est pas moins bonne : elle demande une situation que la CI ne peut
// pas monter. `reversibilite` a besoin d'un volume SANS corbeille — un exFAT.
// L'inclure quand meme donnerait un vert qui ne couvre pas ce pour quoi elle
// existe, c'est-a-dire un test qui ne peut pas echouer.
//
// `detruit` dit ce qu'elle touche. « les siennes » veut dire : uniquement des
// fichiers qu'elle a crees sous la racine de travail, et elle le verifie avant
// d'agir.
const SONDES = [
  {
    // EN PREMIER, et c'est important. C'est la seule sonde qui prouve que le
    // filet est interposé, donc que les suivantes sont réellement encadrées. Après
    // une sonde destructive, un filet défaillant aurait déjà fait son oeuvre.
    nom: 'filet', fichier: 'sonde-filet.mjs', args: (c) => [c.url, c.volume], ci: true,
    detruit: 'les siennes',
    quoi: 'Le filet refuse une suppression hors racine — le scenario de l incident',
  },
  {
    nom: 'host', fichier: 'sonde-host.mjs', args: (c) => [c.url], ci: true, detruit: 'rien',
    quoi: 'Le nom porte par Host est celui de la machine, sur toutes les routes ; rebinding joue dans un vrai navigateur',
  },
  {
    nom: 'corps', fichier: 'sonde-corps.mjs', args: (c) => [c.url], ci: true, detruit: 'rien',
    quoi: 'Une taille de corps annoncee par le client ne tue plus le serveur',
  },
  {
    nom: 'suppression', fichier: 'sonde-suppression.mjs', args: (c) => [c.url], ci: true, detruit: 'rien',
    quoi: 'En-tete exige, chemins proteges refuses, jeton — le tout en simulation',
  },
  {
    nom: 'aNommer', fichier: 'sonde-dossiers-a-nommer.mjs', args: (c) => [c.url, c.volume], ci: true,
    detruit: 'les siennes',
    quoi: 'Un lot qui touche .git, .ssh ou un dossier personnel doit le nommer ; un .gitignore ne declenche rien',
  },
  {
    nom: 'generation', fichier: 'sonde-generation.mjs', args: (c) => [c.url, c.volume], ci: true,
    detruit: 'les siennes',
    quoi: 'Un identifiant est une position : la generation le rend verifiable',
  },
  {
    nom: 'reelle', fichier: 'sonde-suppression-reelle.mjs', args: (c) => [c.url, c.volume], ci: true,
    detruit: 'les siennes',
    quoi: 'Le mode corbeille tient vraiment sa promesse de reversibilite',
  },
  {
    nom: 'plafond', fichier: 'sonde-corbeille-plafond.mjs', args: (c) => [c.url, c.volume], ci: true,
    quoi: 'Le plafond de la corbeille est mesure, et son annonce se tient',
  },
  {
    nom: 'lot', fichier: 'sonde-suppression-lot.mjs', args: (c) => [c.url, c.volume], ci: true,
    detruit: 'les siennes',
    quoi: 'Le cout d un lot, et un temoin en mode definitif',
  },
  {
    nom: 'ui', fichier: 'sonde-ui-suppression.mjs', args: (c) => [c.url, c.volume], ci: true,
    detruit: 'les siennes',
    quoi: 'Le geste reel dans l interface, jusqu a l apercu — ce qu aucune sonde serveur ne voit',
  },
  {
    nom: 'csrf', fichier: 'sonde-csrf-navigateur.mjs', args: (c) => [c.url, c.volume], ci: true,
    detruit: 'les siennes',
    quoi: 'Une page tierce servie en local n efface pas un fichier',
  },
  {
    nom: 'erreurs', fichier: 'sonde-erreurs.mjs', args: (c) => [c.url], ci: true, detruit: 'rien',
    quoi: 'Messages d erreur, modale, etat d elevation. Ouvre une fenetre Explorateur : la plus sensible a l environnement',
  },
  {
    nom: 'arret', fichier: 'sonde-arret.mjs', args: (c) => [c.url, 'styles'], ci: true, detruit: 'rien',
    quoi: 'Le bouton Arreter est present, et les boutons d illisibles sont discrets',
  },
  {
    nom: 'reversibilite', fichier: 'sonde-reversibilite.mjs',
    args: (c) => [c.url, c.volumeSansCorbeille], ci: false, detruit: 'les siennes',
    // Elle agit sur un AUTRE volume que le volume principal. C'est ce qui
    // impose a `racinesDuFilet` de verifier qu'une racine existe pour elle —
    // sans quoi le filet couvrirait un volume que personne n'a designe.
    volumeSecondaire: true,
    quoi: 'Sur un volume SANS corbeille, la promesse de reversibilite ne tient pas — et doit etre dite',
  },
];

// ------------------------------------------------------------------ arguments
function lireArguments(argv) {
  const o = {
    url: null, volume: VOLUME_DEFAUT, volumeSansCorbeille: VOLUME_SANS_CORBEILLE,
    binaire: null, sans: [], tout: false, liste: false, nettoyer: false, attendre: 180,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') o.url = argv[++i];
    else if (a === '--volume') o.volume = argv[++i].toUpperCase().replace(/:$/, '');
    else if (a === '--binaire') o.binaire = argv[++i];
    else if (a === '--sans') o.sans.push(...argv[++i].split(',').map((s) => s.trim()).filter(Boolean));
    else if (a === '--attendre') o.attendre = Number(argv[++i]);
    else if (a === '--tout') o.tout = true;
    else if (a === '--liste') o.liste = true;
    else if (a === '--nettoyer') o.nettoyer = true;
    else { console.error(`option inconnue : ${a}`); process.exit(2); }
  }
  return o;
}

const opt = lireArguments(process.argv.slice(2));

if (opt.liste) {
  console.log('  sonde           ci   detruit          ce qu elle eprouve');
  console.log('  ' + '-'.repeat(100));
  for (const s of SONDES) {
    console.log(`  ${s.nom.padEnd(15)} ${(s.ci ? 'oui' : 'local').padEnd(4)} ${s.detruit.padEnd(16)} ${s.quoi}`);
  }
  process.exit(0);
}

const retenues = SONDES.filter((s) => (s.ci || opt.tout) && !opt.sans.includes(s.nom));
if (!retenues.length) {
  console.error('Aucune sonde retenue. Voir --liste et --sans.');
  process.exit(2);
}

// ------------------------------------------------------------------- reseau
const attendre = (ms) => new Promise((r) => setTimeout(r, ms));

function portLibre(debut) {
  return new Promise((resoudre) => {
    const s = net.createServer();
    s.once('error', () => resoudre(null));
    s.listen(debut, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resoudre(p));
    });
  });
}

async function etat(url) {
  try {
    const r = await fetch(`${url.replace(/\/$/, '')}/api/state`);
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

/** Attend que le serveur reponde, et renvoie l'adresse qu'il annonce. */
async function demarrer(binaire, port) {
  const p = spawn(binaire, ['--port', String(port), '--no-browser'], {
    cwd: DEPOT, windowsHide: true,
  });
  let sortie = '';
  let adresse = null;

  p.stdout.on('data', (d) => {
    sortie += d.toString();
    const m = sortie.match(/Espace disque\s*:\s*(\S+)/);
    if (m) adresse = m[1];
  });
  p.stderr.on('data', (d) => { sortie += d.toString(); });

  const limite = Date.now() + 30_000;
  while (!adresse && Date.now() < limite) {
    if (/Une instance tourne deja/.test(sortie)) {
      console.error('Une instance de diskmap tourne deja sur ce poste.');
      console.error('Ferme-la : ses caches et son journal fausseraient la mesure.');
      p.kill();
      process.exit(2);
    }
    if (p.exitCode !== null) {
      console.error(`Le binaire s est arrete (code ${p.exitCode}). Sortie :\n${sortie}`);
      process.exit(2);
    }
    await attendre(120);
  }
  if (!adresse) {
    p.kill();
    console.error(`Le binaire n a pas annonce d adresse en 30 s. Sortie :\n${sortie}`);
    process.exit(2);
  }
  // Le serveur peut mettre un instant a ecouter apres avoir annonce l'adresse.
  for (let i = 0; i < 100 && !(await etat(adresse)); i++) await attendre(100);
  return { processus: p, adresse };
}

/**
 * Analyse un volume et attend la fin. Un instantane absent ferait conclure sur du vide.
 *
 * Deux SORTIES, parce qu'un dépassement de délai n'a pas la même cause qu'un refus
 * du disque, et que les confondre rend le diagnostic faux : sur l'intégration
 * continue du 26/09, un délai dépassé était rapporté « ECHEC », ce qui faisait
 * croire à un défaut de l'application alors que C: simplement prenait plus de
 * trois minutes à être analysé sur le runner.
 *
 * `delai` distingue donc les deux, et le message dit lequel des deux s'est produit.
 */
async function analyser(url, lettre, limiteSecondes) {
  const base = url.replace(/\/$/, '');
  await fetch(`${base}/api/scan/${lettre}`, { method: 'POST', headers: { 'X-Diskmap': '1' } });
  const limite = Date.now() + limiteSecondes * 1000;
  let vu = null;
  while (Date.now() < limite) {
    const e = await etat(url);
    const d = e && (e.drives || []).find((x) => x.letter === lettre);
    if (d) vu = d;
    if (d && d.status === 'ready') return { ...d, delai: false };
    if (d && d.status === 'error') return { ...d, delai: false };
    await attendre(400);
  }
  return { ...(vu || { letter: lettre }), delai: true };
}

// ------------------------------------------------------------ volume jetable
/**
 * Refuse de lancer des sondes qui DETRUIENT sur un volume qui n'est pas jetable.
 *
 * Ce controle porte sur le HARNAIS, jamais sur l'application : `diskmap` doit
 * pouvoir supprimer sur n'importe quel volume, c'est son metier. Ce qui est
 * refuse ici, c'est de faire tourner des tests automatiques destructifs hors
 * d'un support jetable. Un humain qui utilise l'interface ne passe jamais par
 * ce chemin, et la regle ne peut donc pas lui retirer la moindre capacite.
 *
 * Elle refuse aussi — et c'est volontaire — quand le releve est IMPOSSIBLE. Un
 * volume dont on n'a pas su dire s'il est jetable n'est pas un volume jetable
 * presume : « un cas non mesure ne vaut ni succes ni echec », et ici les deux
 * consequences sont destructrices. Un PowerShell qui echoue doit donc arranger
 * le run, jamais le laisser passer.
 */
function exigerVolumeJetable(vol) {
  const faits = interrogerVolumes();
  const cible = (faits || []).find((f) => String(f.lettre).toUpperCase() === String(vol).toUpperCase());

  console.log(`  volumes : ${faits.length} monte(s), releves par PowerShell`);
  for (const f of [...faits].sort((a, b) => a.lettre.localeCompare(b.lettre))) {
    const j = volumeJetable(f);
    console.log(`    ${(j.jetable ? 'jetable ' : 'refuse  ')} ${decrireVolume(f)}`);
  }
  console.log('');

  if (!faits.length) {
    throw new Error(
      'Aucun volume n a pu etre releve (PowerShell a echoue ou n est pas disponible). '
      + 'Or un volume dont on ignore s il est jetable ne peut pas etre presume jetable. '
      + 'Le run est refuse plutot que lance sur une mesure absente.'
    );
  }
  if (!cible) {
    throw new Error(`Le volume ${vol}: n est pas monte sur cette machine. Rien a eprouver dessus.`);
  }

  const v = volumeJetable(cible);
  if (!v.jetable) {
    if (MACHINE_EPHEMERE) {
      // La seule voie qui passe, et elle est bruyante. Elle dit ce qu elle
      // repose : rien. Ni un fait, ni un releve — une affirmation de
      // l operateur, dont le MOT est affiche pour qu on puisse le discuter.
      // Si cette ligne te surprend dans un log, c est que quelqu un l a posee
      // sans y penser, et c est exactement le moment de le voir.
      console.log('  ============================================================');
      console.log(`  DECLARATION  « ${MACHINE_EPHEMERE} »`);
      console.log(`  ${vol}: n est PAS un disque virtuel. Il est accepte sur`);
      console.log('  DECLARATION, pas sur mesure. Si cette machine contient');
      console.log('  des donnees, cette declaration est fausse.');
      console.log('  ============================================================');
      console.log('');
      return;
    }
    throw new Error(
      `${v.motif} `
      + `Les sondes de ce run detruisent : filet, generation, reelle, lot, ui, csrf. `
      + `Monte un volume jetable (tests\\sondes\\creer-volume-test.ps1) et pointe le run dessus, `
      + `ou passe --liste pour consulter la table sans rien lancer. `
      + `Sur une machine ephemere dont aucun volume n est virtuel, declaree : `
      + `DISKMAP_SONDE_MACHINE_EPHEMERE=<pourquoi>.`
    );
  }
  console.log(`  volume de travail ${vol}: — ${v.motif}`);
  console.log('');
}

// ------------------------------------------------------------------ racines
/**
 * La racine de travail d'un volume.
 *
 * `racine()` refuse une racine posee sur un AUTRE volume que celui qu'on
 * analyse — c'est la seule Facon de ne pas finir avec des fichiers crees sur
 * C: et un instantane interroge sur V:, ce qui fait conclure « absent » sans
 * explication. Le volume principal, lui, doit respecter la configuration : une
 * racine posee et ignoree serait pire qu'une racine absente.
 *
 * Le volume secondaire ne se rabat PLUS sur un dossier invente, et c'est la
 * partie qui compte. Le filet transforme chaque racine en AUTORISATION de
 * supprimer : une racine qu'on n'a pas demandee est une autorisation qu'on n'a
 * pas demandee non plus. Sur cette machine, poser `DISKMAP_SONDE_RACINE` sur
 * `V:` suffisait a faire apparaitre `E:/_diskmap_sondes` dans les racines du
 * filet — un exFAT de 55 Go de donnees reelles, couvert par la garde, que
 * personne n'avait configure. Un `--tout` suffisait ensuite a y faire agir une
 * sonde. Le filet n'est pas transparent : c'est le prix d'un point unique, et
 * un point unique ne doit pas couvrir plus large que ce qu'on lui a demande.
 *
 * Aucune racine inventee, donc : `null`. Le filet ne couvre alors que la racine
 * verifiee, et `filet.mjs` refuse alors par volume comme par chemin. Une sonde
 * qui aurait besoin de ce volume la REFUSE (voir `racinesDuFilet`) : c'est un
 * cas non mesure, et un cas non mesure ne vaut ni succes ni echec.
 */
function racinePour(vol, principal) {
  try {
    return racine(vol);
  } catch (e) {
    if (principal) throw e;
    console.log(`  note   : ${e.message.split('.')[0]}. Aucune racine inventee pour ${vol}:.`);
    return null;
  }
}

/**
 * Les racines que le filet couvre — et le refus, s'il en manque une.
 *
 * Le filet est demande AVANT toute sonde, donc ses racines ne peuvent pas
 *dependre d'un run qu'il supervise deja. D'ou l'ordre inverse : on regarde
 * d'abord quelles sondes sont retenues, et on exige la racine dont elles ont
 * besoin. Retenir `reversibilite` alors que `DISKMAP_SONDE_RACINE` pointe
 * ailleurs n'est pas un detail de configuration, c'est une sonde destructive
 * sans racine : elle creerait ses fichiers là où le filet ne couvre rien, sur
 * un volume que personne n'a designe. Le run s'arrete ici, avant le moindre
 * octet ecrit.
 */
function racinesDuFilet(volume, retenues) {
  const principal = racinePour(volume, true);
  const secondaire = racinePour(opt.volumeSansCorbeille, false);
  const sansRacine = retenues.filter((s) => s.volumeSecondaire);
  if (sansRacine.length && !secondaire) {
    const noms = sansRacine.map((s) => s.nom).join(', ');
    throw new Error(
      `Les sondes « ${noms} » travaillent sur ${opt.volumeSansCorbeille}:, mais ` +
      `DISKMAP_SONDE_RACINE (${process.env.DISKMAP_SONDE_RACINE}) est sur un autre ` +
      `volume. Elles n'auraient aucune racine de travail, et le filet ne couvrirait ` +
      `rien là où elles ecriraient. Pose ` +
      `DISKMAP_SONDE_VOLUME_SANS_CORBEILLE sur un volume jetable sans corbeille, ` +
      `ou retire ces sondes du run.`
    );
  }
  return [...new Set([principal, secondaire].filter(Boolean))];
}

// ------------------------------------------------------------------ nettoyage
/**
 * Retire les dossiers de travail des sondes.
 *
 * On ne parcourt rien : on retire exactement `<racine>/<nom de sonde>`, pour les
 * noms connus. La lecon du 26/09/2026 tient en une phrase : une suppression qui
 * ne verifie pas sa cible detruit autre chose. Un `rm -rf <racine>` serait plus
 * court et moins sur.
 */
function nettoyer() {
  const base = racine(opt.volume);
  const connus = ['csrf', 'ui', 'perime', 'reversibilite', 'lot-cout', 'lot-coherence', 'suppression-reelle'];
  let n = 0;
  for (const nom of connus) {
    const cible = `${base}/${nom}`;
    if (fs.existsSync(cible)) { fs.rmSync(cible, { recursive: true, force: true }); n++; }
  }
  console.log(`  nettoyage : ${n} dossier(s) de travail retire(s) sous ${base}`);
}

// -------------------------------------------------------------------- marche
const resultats = [];
let serveur = null;
let url = opt.url;
// Déclaré ici, et non dans le `try` : le `finally` doit pouvoir arrêter le
// filet, et le verdict doit pouvoir le consulter.
let filet = null;

// Les racines sont resolues AVANT toute chose demarree : rien n'ecoute, rien
// n'est analyse, donc un refus ici ne coute qu'un message. Le meme refus apres
// `demarrer` aurait laisse un serveur en ecoute et fait perdre une analyse de
// C: pour rien — et il n'y a ici aucun `finally` qui rattrape quoi que ce soit.
let racines = null;
try {
  exigerVolumeJetable(opt.volume);
  racines = racinesDuFilet(opt.volume, retenues);
} catch (e) {
  console.error(`\n  REFUS   ${e.message}\n`);
  process.exit(2);
}

try {
  const volume = opt.volume;

  if (!url) {
    const binaire = opt.binaire || path.join(DEPOT, 'target', 'release', 'diskmap.exe');
    if (!fs.existsSync(binaire)) {
      console.error(`Binaire introuvable : ${binaire}`);
      // `--offline` compile depuis un cache chaud, et échoue sur une machine
      // qui n'a jamais construit le projet (`no matching package named
      // rayon`). Il ne doit pas être conseillé ici : le lecteur peut très bien
      // partir d'une copie fraîche du dépôt.
      console.error('Construis-le :  cargo build --release');
      process.exit(2);
    }
    const port = (await portLibre(8801)) || 8801;
    const demarre = await demarrer(binaire, port);
    serveur = demarre.processus;
    url = demarre.adresse;
  }
  url = url.replace(/\/$/, '') + '/';
  console.log(`  serveur : ${url}`);

  process.stdout.write(`  analyse de ${volume}: et de C: ...`);
  const dv = await analyser(url, volume, opt.attendre);
  const dc = await analyser(url, 'C', opt.attendre);
  // Le volume de travail est INDISPENSABLE : sans son instantané, les sondes
  // interrogent un index vide et concluent « absent » sans explication. C: ne
  // l'est pas — seule la sonde `suppression` le consulte, et elle s'abstient si
  // le volume n'a pas été analysé. Un délai dépassé se dit « délai », jamais
  // « ECHEC » : les deux n'ont rien à voir, et le confondre envoie chercher un
  // défaut là où il n'y en a pas.
  const etat = (d) => d.delai
    ? `delai de ${opt.attendre}s dépassé`
    : d.status === 'ready' ? `${d.n_dirs} dossiers, ${d.n_files} fichiers`
    : d.status === 'error' ? 'refusee par le disque' : 'inconnue';
  console.log(` ${etat(dv)} / C: ${etat(dc)}`);
  if (dv.delai || dv.status !== 'ready') {
    console.error(`Le volume ${volume} n'a pas produit d'instantané exploitable (${etat(dv)}).`);
    console.error("Augmente le delai avec --attendre, ou verifie que le volume existe.");
    process.exit(2);
  }

/**
 * Ce qui traîne sur les racines du filet : charges `$R` de la corbeille du
 * volume de travail, et dossiers laissés sous la racine des sondes.
 *
 * `racines` contient la racine du volume secondaire : on ne compte que celle du
 * volume ANALYSE, sinon un résidu de l'autre ferait crier un run parfaitement
 * propre. Et on ne compte que ce qui est visible — un `$I` seul, sans sa charge
 * `$R`, est une fiche orpheline, pas un risque de confusion de diagnostic.
 */
function lireResidus(racines, volume) {
  const trouve = [];
  const racine = racines.find((r) => new RegExp(`^${volume}:`, 'i').test(r));
  if (!racine) return trouve;
  // Un volume PROPRE n'a pas encore de dossier de sondes : son absence est la
  // normale, pas une erreur. Sans ce try/catch, le harnais echouait sur le
  // premier volume neuf — c'est-a-dire en CI, sur un runner qui n'a jamais
  // eu de sondes (run du 27/09/2026, #31).
  try {
    for (const d of fs.readdirSync(racine, { withFileTypes: true })) {
      if (d.isDirectory()) trouve.push(`${d.name}/ (sous ${racine})`);
    }
  } catch { /* racine absente : volume propre */ }
  const corbeille = `${volume}:/$RECYCLE.BIN`;
  let charges = 0;
  let sids = [];
  try { sids = fs.readdirSync(corbeille); } catch { sids = []; }
  for (const sid of sids) {
    const d = `${corbeille}/${sid}`;
    try {
      if (!fs.statSync(d).isDirectory()) continue;
      charges += fs.readdirSync(d).filter((f) => f.startsWith('$R')).length;
    } catch { /* illisible : on ne compte pas, on ne le pretend pas */ }
  }
  if (charges) trouve.push(`${charges} charge(s) $R dans ${corbeille}`);
  return trouve;
}

  console.log('');
  // Le filet est DEMANDÉ avant toute sonde, et son URL est celle que les sondes
  // reçoivent. Le chef d'orchestre, lui, garde la vraie adresse : c'est lui qui
  // analyse, et il n'a pas à se faire filtrer.
  const journalFilet = path.join(ICI, 'filet-suppressions.log');
  filet = await creerFilet({ cible: url, racines, journal: journalFilet });
  const urlProbes = filet.url;
  console.log(`  filet   : ${racines.join(' | ')} — les sondes passent par ${urlProbes}`);

  // Le volume de travail est-il SALE ? Un résidu ne fait échouer aucune sonde,
  // et c'est bien le problème : il rend le DIAGNOSTIC des autres faux. Mesuré le
  // 27/09/2026 — la sonde `ui` cherchait `photo.jpg`, cliquait sur un
  // `photo-2019.jpg` laissé dans la corbeille par une sonde précédente, entrait
  // dans `$RECYCLE.BIN`, et concluait que l'interface ne listait rien. La sonde
  // qui produisait le mensonge est, elle, restée verte.
  //
  // Un avertissement, jamais un refus : des résidus peuvent être légitimes, et
  // un harnais qui refuse de tourner n'apprend rien. Il dit ce qu'il a vu et
  // ce que ça peut fausser, et laisse décider.
  const residus = lireResidus(racines, volume);
  if (residus.length) {
    console.log('');
    console.log(`  ⚠ volume de travail sale : ${residus.join(', ')}`);
    console.log('    Ces residus peuvent rendre le diagnostic FAUX d’une sonde, sans la');
    console.log('    faire rougir : une ligne trouvee dans la corbeille ressemble a une');
    console.log('    ligne du dossier recherche. Supprime-les avant de croire un resultat,');
    console.log('    ou vide a la main la corbeille et le dossier de sondes de ce volume.');
  }

  for (const s of retenues) {
    const fichier = path.join(ICI, s.fichier);
    if (!fs.existsSync(fichier)) {
      console.log(`  ABSENT  ${s.nom} — ${s.fichier} n existe pas`);
      resultats.push({ nom: s.nom, code: 2 });
      continue;
    }
    const args = s.args({ url: urlProbes, volume, volumeSansCorbeille: opt.volumeSansCorbeille });
    // Le filet compte ses incidents. Ceux qu'une sonde PROVOQUE pour éprouver le
    // filet ne sont pas des échecs — la sonde `filet` ne peut faire autrement,
    // et ses propres vérifications la jugent. Ceux qu'une autre sonde provoque
    // n'ont aucune explication : une sonde a alors visé hors de sa racine, et
    // c'est exactement l'incident du 26/09/2026.
    const incidentsAvant = filet.incidents.length;    const sortie = await new Promise((resoudre) => {
      const p = spawn(process.execPath, [fichier, ...args], { cwd: ICI, windowsHide: true });
      let tout = '';
      p.stdout.on('data', (d) => { tout += d.toString(); });
      p.stderr.on('data', (d) => { tout += d.toString(); });
      p.on('close', (code) => resoudre({ code, tout }));
    });
    // La derniere ligne qui compte : « 8/8 verifications ».
    const compte = [...sortie.tout.matchAll(/(\d+)\/(\d+)\s+verifications/g)].pop();
    const resume = compte ? `${compte[1]}/${compte[2]}` : '—';
    const etatMot = sortie.code === 0 ? 'vert ' : sortie.code === 2 ? 'PAS PU' : 'ROUGE';
    console.log(`  ${etatMot}  ${s.nom.padEnd(15)} ${resume}`);
    if (sortie.code !== 0) {
      const lignes = sortie.tout.split('\n').filter((l) => /ROUGE|ECHEC|Echecs|Échecs|^  - /.test(l));
      for (const l of lignes.slice(0, 12)) console.log(`           ${l.trim()}`);
    }
    resultats.push({ nom: s.nom, code: sortie.code, resume });
    if (s.nom !== 'filet' && filet.incidents.length > incidentsAvant) {
      const nouveaux = filet.incidents.slice(incidentsAvant);
      console.log(`           FILET  ${nouveaux.length} incident(s) pendant « ${s.nom} »`);
      filet.tiers.push(...nouveaux);
    }
  }
} finally {
  if (filet) {
    await filet.arreter();
  }
  if (serveur) {
    try {
      await fetch(`${url}api/quit`, { method: 'POST', headers: { 'X-Diskmap': '1', 'Content-Type': 'application/json' }, body: '{}' });
    } catch { /* il est peut-etre deja arrete */ }
    await attendre(400);
    try { serveur.kill(); } catch { /* deja mort */ }
  }
  if (opt.nettoyer) nettoyer();
}

// -------------------------------------------------------------------- verdict
const verts = resultats.filter((r) => r.code === 0).length;
const rouges = resultats.filter((r) => r.code === 1);
const pasPu = resultats.filter((r) => r.code !== 0 && r.code !== 1);

console.log('');
console.log(`  ${verts}/${resultats.length} sondes vertes`);
if (rouges.length) console.log(`  ROUGES : ${rouges.map((r) => r.nom).join(', ')}`);
if (pasPu.length) console.log(`  PAS PU EPROUVER : ${pasPu.map((r) => r.nom).join(', ')}`);

// Le filet a la parole. Un incident rend la run ROUGE même si toutes les sondes
// sont vertes : une sonde a vu passer une suppression qu'elle n'aurait jamais
// dû déclencher, et son « vert » ne veut alors plus rien dire. C'est le principe
// « fermé par défaut » : on ne peut pas contourner le filet en sobrescrivant.
// Le filet a la parole. Un incident survenu durant une sonde QUI N'EST PAS
// `filet` rend la run ROUGE même si toutes les sondes sont vertes : une sonde a
// vu passer une suppression qu'elle n'aurait jamais dû déclencher, et son
// « vert » ne veut alors plus rien dire. C'est le principe « fermé par défaut » :
// on ne peut pas contourner le filet en sobercrivant.
if (filet && filet.tiers.length) {
  console.log(`  FILET ROUGE : ${filet.tiers.length} incident(s) hors sonde d'epreuve`);
  for (const t of filet.tiers.slice(0, 6)) console.log(`    - ${t}`);
  process.exit(1);
}
if (filet) {
  console.log(`  filet   : ${filet.refus} execution(s) refusee(s), ${filet.incidents.length} incident(s) — tous produits par la sonde d'epreuve du filet`);
}

if (rouges.length) process.exit(1);
if (pasPu.length) process.exit(2);
process.exit(0);
