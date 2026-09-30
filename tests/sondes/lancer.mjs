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
    // Les quatre validations d’entrée du routeur, et le premier jeu de sondes
    // dont le refus est exige AU MOINS aussi qu un témoin. Chacune des quatre
    // garde un message de refus different, et chacune a un jumeau qui prouve
    // qu elle a bien parle : un 400 lu seul ne distingue pas « id invalide » de
    // « dossier hors bornes », et une sonde qui ne verrait que le statut
    // passerait sur un serveur qui refuse tout.
    //
    // Le 29/09/2026, ces quatre etaient les seules gardes du depot que
    // `verifier-libelles.mjs` declarait « que personne ne regarde ». Elles ne
    // coutaient qu une seconde chacune, et ne se perdaient pas dans le bruit du
    // run : c est precisement ce qui les rendait invisibles. Un trou gratuit
    // n est pas un trou qu on laisse.
    nom: 'entrees', fichier: 'sonde-entrees.mjs', args: (c) => [c.url, c.volume], ci: true,
    detruit: 'rien',
    quoi: 'Les quatre gardes d’entree du routeur, chacune avec le temoin qui prouve qu elle a parle',
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
    // Sans cette sonde, le contrat `{ok, ticket}` de R15 n'était éprouvé nulle
    // part : écrit côté serveur, ignoré par chaque client. Elle ne conclut sur
    // aucun drapeau — l'attente par ticket est son sujet, et l'attente par le
    // fait verdit avec elle.
    nom: 'tickets', fichier: 'sonde-tickets.mjs', args: (c) => [c.url, c.volume], ci: true,
    detruit: 'les siennes',
    quoi: 'Un ticket demandé est publié, coalescé, et couvre ce qui précède la demande',
  },
  {
    nom: 'reelle', fichier: 'sonde-suppression-reelle.mjs', args: (c) => [c.url, c.volume], ci: true,
    detruit: 'les siennes',
    quoi: 'Le mode corbeille tient vraiment sa promesse de reversibilite',
  },
  {
    nom: 'plafond', fichier: 'sonde-corbeille-plafond.mjs', args: (c) => [c.url, c.volume], ci: true,
    detruit: 'les siennes',
    quoi: 'Le plafond de la corbeille est mesure, et son annonce se tient',
  },
  {
    nom: 'mot', fichier: 'sonde-mot-exige.mjs', args: (c) => [c.url, c.volume], ci: true,
    detruit: 'les siennes',
    quoi: 'Le mot exige est celui du contexte, mode par mode',
  },
  {
    // Ses lectures sont des `dry` sur des vrais dossiers deja presents : le volume
    // jetable fait 511 Mio et le premier palier est a 20 Go, donc sans cette sonde
    // la regle ne serait verifiee qu'a l'echelle d'un test unitaire, jamais sur un
    // vrai dossier de 344 Go.
    //
    // Elle ne supprime AUCUN fichier d autrui, mais elle ne touche pas non plus
    // un disque en lecture seule : elle cree `petit.txt` sous son dossier et le
    // retire. L ancienne note « elle ne supprime rien » etait vraie au sens
    // etroit et fausse au sens du harnais, ou une sonde qui ecrit sur un disque
    // de donnees doit le declarer.
    nom: 'palier', fichier: 'sonde-palier.mjs', args: (c) => [c.url, c.volume], ci: true,
    detruit: 'les siennes',
    quoi: 'Un lot de 344 Go exige un mot, un lot minuscule n en exige aucun',
  },
  {
    nom: 'lot', fichier: 'sonde-suppression-lot.mjs', args: (c) => [c.url, c.volume], ci: true,
    detruit: 'les siennes',
    quoi: 'Le cout d un lot, et un temoin en mode definitif',
  },
  {
    // Elle ne corrige rien et ne tranche rien : elle rend VISIBLE le contrat de
    // `/api/search` — ce qui est coupe, et ce que le serveur dit de ce qu il a
    // coupe. Ses verdicts portent sur des invariants vrais quel que soit le
    // contrat choisi ; le contrat lui-meme sort en NOTE, donc ni vert ni rouge.
    // C est ce qui permet de decider si `/api/search` doit devenir honnete ou
    // complet sans avoir encore tranche.
    //
    // Le plafond est un PARAMETRE (`limit`), donc six fichiers suffisent a
    // l exercer. Une sonde qui devait creer huit cents entrees pour prouver la
    // meme chose n aurait jamais ete ecrite.
    nom: 'recherche', fichier: 'sonde-recherche.mjs', args: (c) => [c.url, c.volume], ci: true,
    detruit: 'les siennes',
    quoi: 'Ce que rend la recherche, ce qu elle coupe, et ce qu elle pretend',
  },
  {
    // Lecture seule : elle cherche sur les volumes REELS, et ne prend pas le volume
    // de travail en argument. Elle eprouve le seul chemin que la precedente ne peut
    // pas atteindre — la garde de MEMoire, quand la recherche ne peut pas tout
    // materialiser et doit donc dire « au moins N ». Ce chemin a ete livre le
    // 27/09/2026 sans qu'aucune sonde ne l'exerce. Le volume jetable fait 511 Mio :
    // fabriquer 4 000 correspondances y prendrait plus de temps que le test.
    nom: 'rechercheGrande', fichier: 'sonde-recherche-large.mjs', args: (c) => [c.url], ci: true,
    detruit: 'rien',
    quoi: 'Quand la recherche ne peut pas tout montrer, elle dit « au moins N » au lieu de pretendre',
  },
  {
    // Un dossier affiche doit rester LE dossier choisi, et sa disparition doit etre
    // dite. Le 27/09, l interface epinglait le dossier courant par un NUMERO : apres
    // une reanalyse, ce numero designait un autre dossier — le depot GitHub sur le
    // runner — et l ecran suivait sans rien dire. Dans un outil qui supprime, un ecran
    // qui change de cible sans le dire est une suppression qui vise autre chose.
    // La sonde mesure aussi si les identifiants ont bouge sur CE volume : sans cela,
    // un vert ne prouverait que le cas tranquille.
    nom: 'identifiant', fichier: 'sonde-identifiant.mjs', args: (c) => [c.url, c.volume], ci: true,
    detruit: 'les siennes',
    quoi: 'Le dossier affiche survit a une reanalyse, et un dossier disparu est dit plutot que remplace',
  },
  {
    nom: 'ui', fichier: 'sonde-ui-suppression.mjs', args: (c) => [c.url, c.volume], ci: true,
    detruit: 'les siennes',
    quoi: 'Le geste reel dans l interface, jusqu a l apercu — ce qu aucune sonde serveur ne voit',
  },
  {
    // Elle ne supprime rien : elle ouvre la modale, mesure, et ne clique jamais
    // sur « Supprimer ». Elle a donc besoin d un volume analyse, pas jetable.
    nom: 'elevation', fichier: 'sonde-elevation.mjs', args: (c) => [c.url, c.volume], ci: true,
    detruit: 'les siennes',
    quoi: 'Une instance elevee annonce, et exige — la loi mesuree sur les deux moities',
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
    // Les deux modes qui ARRETENT le serveur, enfin exerces.
    //
    // Jusqu'au 29/09/2026, `lancer.mjs` n'invoquait `sonde-arret.mjs` qu'en mode
    // `styles` : les points 4, 5 et 6 du fichier, et le controle de `scan_running`
    // a l'arret, etaient du code ecrit et jamais execute. La raison etait
    // structurelle — `running` appelle `POST /api/quit`, qui aurait tue le serveur
    // unique du harnais — et elle etait invisible : rien ne la disait, et la sonde
    // annoncait 9/9 comme si elle avait tout mesure.
    //
    // `serveurDedie` leve la raison structurelle : ces deux sondes demarrent LEUR
    // serveur, sur un autre port, et l'arretent elles-memes. Le binaire ne
    // verrouille que par port — verifie, pas suppose.
    nom: 'arret-idle', fichier: 'sonde-arret.mjs', args: (c) => [c.url, 'idle'],
    ci: true, detruit: 'rien', serveurDedie: true,
    quoi: 'Sans analyse en cours, l arret aboutit et la veille s eteint',
  },
  {
    nom: 'arret-running', fichier: 'sonde-arret.mjs', args: (c) => [c.url, 'running'],
    ci: true, detruit: 'rien', serveurDedie: true,
    quoi: 'L arret pendant une analyse chiffre ce qui serait perdu, et ne laisse aucun scan_running colle',
  },
  {
    // LA MÊME sonde, sur le volume de travail. Son invariant — « ce que
    // l'application annonce doit correspondre à l'état du disque » — tient sur
    // un volume AVEC corbeille comme sur un volume sans : la seconde entrée ci
    //-dessous n'en est qu'un cas particulier. La laisser hors de la CI, parce
    // que son cas exFAT est difficile à monter, retirait l'invariant lui-même :
    // la CI prouvait que la corbeille prend les fichiers, jamais que
    // l'application dit VRAI ce qui s'est passé.
    //
    // Elle n'est donc decomposee en deux : l'invariant est en CI, la situation
    // exFAT reste locale. Un vert qui ne couvre pas ce pour quoi la sonde existe
    // est un test qui ne peut pas echouer.
    nom: 'reversibilite', fichier: 'sonde-reversibilite.mjs',
    args: (c) => [c.url, c.volume], ci: true, detruit: 'les siennes',
    quoi: 'Ce que l application annonce correspond a ce que le disque dit',
  },
  {
    nom: 'sans-corbeille', fichier: 'sonde-reversibilite.mjs',
    args: (c) => [c.url, c.volumeSansCorbeille], ci: false, detruit: 'les siennes',
    // Elle agit sur un AUTRE volume que le volume principal. C'est ce qui
    // impose a `racinesDuFilet` de verifier qu'une racine existe pour elle —
    // sans quoi le filet couvrirait un volume que personne n'a designe.
    volumeSecondaire: true,
    quoi: 'Sur un volume SANS corbeille, la promesse ne tient pas — et doit etre dite',
  },
];

// ------------------------------------------------------------------ arguments
/**
 * Le fichier de `cibles` le plus recent que `reference`, ou `null`.
 *
 * Sert au refus de demarrer sur un binaire perime. La comparaison se fait sur
 * la DATE, et non sur le contenu : ce qu on veut detecter, c est une source
 * modifiee apres la derniere compilation. Une source de date egale est acceptee
 * — `cargo build` ecrit le binaire apres avoir lu les sources, et une seconde
 * d ecart n a aucun sens.
 */
function plusRecentQue(reference, cibles) {
  const t = fs.statSync(reference).mtimeMs;
  let pire = null;
  for (const c of cibles) {
    if (!fs.existsSync(c)) continue;
    const m = fs.statSync(c).mtimeMs;
    if (m > t && (!pire || m > pire.mtimeMs)) {
      pire = { fichier: path.relative(DEPOT, c), mtimeMs: m };
    }
  }
  return pire;
}

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

// ------------------------------------------------------- la table se verifie
//
// `detruit` n est pas cosmetique : c est ce qui autorise une sonde a tourner
// sur un volume jetable, et la regle du filet tient sur elle. Une entree qui
// oublie de le dire ne doit pas passer inapercue jusqu au premier `padEnd` sur
// un `undefined` — c est ce qui est arrive, et `--liste` plantait au lieu de
// dire quoi manquer.
//
// La faute est donc nommee ici, au chargement, et elle arrete le harnais.
// C'est le meme parti pris que partout ailleurs : mieux vaut un arret net qu un
// `undefined` qui attend qu on le decouvre.
for (const s of SONDES) {
  const manquant = ['nom', 'fichier', 'args', 'ci', 'detruit', 'quoi']
    .filter((cle) => s[cle] === undefined);
  if (manquant.length) {
    throw new Error(
      `La sonde « ${s.nom || '(sans nom)'} » ne declare pas : ${manquant.join(', ')}. `
      + 'Une sonde qui ne dit pas ce qu elle detruit ne peut pas etre executee '
      + 'en confiance — c est la regle entiere du filet.'
    );
  }
}

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

// ---------- plancher de verifications, par sonde ----------
//
// Ce que la regle interdit : une sonde VERTE qui a ecrit moins de
// verifications qu elle n en ecrivait. Rien d autre ne le voit. Supprimer
// trois assertions d une sonde ne fait rougir aucun controle du depot : le
// run affiche « 24/24 sondes vertes », `npm test` passe, et la suite encaisse
// une degradation comme une amelioration. C est R12 vu par l autre bout —
// un angle mort sur le harnais lui-meme, et le plus facile a refermer de tout
// le projet : le compte etait deja ecrit, il manquait seulement quelqu un
// pour le lire.
//
// Les valeurs sont MESUREES, pas choisies : le plus petit compte observe sur
// les logs du 29 et du 30/09/2026 (`/tmp/run-v5.log`, `/tmp/run.log`,
// `/tmp/quad2.log`, `/tmp/run-final.log`). On garde le PLUS PETIT, jamais le
// plus grand : un plancher quiivalence legerement plus bas reste vrai, alors
// qu un plancher pris sur un run chanceux devient rouge le jour ou la machine
// change. Deux sondes varient d un run a l autre et le tableau le dit :
// `tickets` vaut 9 ou 10 selon qu un scan a ete surpris en vol, `elevation`
// vaut 18 sur une instance normale et 21 sur le runner, qui est TOUJOURS eleve
// et ajoute donc son verdict de bandeau ET les trois verdicts du bouton sous
// saisie. Le plancher est pose sur le chemin LE PLUS LONG (22 verdicts
// possibles) : la moitie non jouee se declare par note, et la detente se fait
// d un cout de 4 (normale) ou 1 (elevee). Le plancher ne parle que des VERTES : une sonde
// rouge ecrit moins de verifications — elle saute un bloc entier quand un
// geste echoue — et son rouge suffit.
const COMPTES_PLANCHER = {
  aNommer: 27, arret: 9, 'arret-idle': 3, 'arret-running': 4, corps: 4,
  csrf: 12, elevation: 22, entrees: 12, filet: 16,
  generation: 6, host: 33, identifiant: 15, lot: 9, mot: 6, palier: 5,
  plafond: 6, recherche: 25, rechercheGrande: 7, reelle: 38,
  reversibilite: 8, suppression: 34, tickets: 9, ui: 39,
};
// Un plancher sans sonde est une garde qui ne garde rien : renommer une sonde
// laisse son plancher derriere, il ne rend plus jamais, et personne ne le
// remarque. C est le controle gratuit le plus utile du lot.
// Ce que le harnais sait DEJA de la machine, sans demander quoi que ce soit.
// Un plancher qui en depend doit dependre de ca, et non d un nombre recopie
// depuis un run fait ailleurs.
// PROVISIONNEL a 1 : la vraie valeur est etablie par `exigerVolumeJetable`, qui
// est la seule a savoir combien de volumes la machine a reellement. Le plancher
// n est compare qu apres, donc la valeur provisoire ne sert jamais — mais elle
// doit exister, sinon une comparaison anterieurroe au releve leverait.
const ENV = { volumes: 1 };
// `erreurs` ecrit 1 a 4 verdicts par volume pret : 26 hors boucle (mesure le
// 30/09 : 46 - 5 volumes x 4), et au moins 1 par volume. Un plancher fixe de
// 46 serait FAUX sur le runner, qui a moins de volumes. Cout par volume pris
// au MINIMUM (1) : une machine dont un volume passe sous le seuil ecrira moins
// de 4 verdicts pour ce volume, et un plancher plus serre la ferait rougir a
// tort. Limite nommee : cette sonde peut perdre ses trois verdicts de signe,
// de montant et de signe affiche sans que son plancher le voie.
COMPTES_PLANCHER.erreurs = (env) => 25 + env.volumes;
const nomsConnus = new Set(SONDES.map((x) => x.nom));
const sansSonde = Object.keys(COMPTES_PLANCHER).filter((n) => !nomsConnus.has(n));

// ---------- les notes d aveu, et leur justification ----------
//
// Une note est une excuse. certaines sont justes — « c est normal : un disque a
// des centaines de dossiers du meme nom » n accuse personne. D autres sont des
// AVEUX : la sonde dit noir sur blanc que son vert ne prouve rien. Le 30/09,
// le run en portait une : « branche « ecart negligeable » NON exercee — 5
// volume(s), tous au-dessus du seuil. Ce vert-la ne prouve rien. »
//
// Le defaut n est pas le trou : c est que l aveu ne restraints a rien. Il est
// ecrit dans un coin, le run affiche « 24/24 sondes vertes », et au run suivant
// il disparait — les 29 et 30/09, `tickets` portait un aveu que le 30 ne portait
// plus. Un trou qui s efface sur un run chanceux est plus Dangereux qu un trou
// permanent : le run vert le nie.
//
// La regle, donc, n est pas « zero aveu » — elle serait rouge en permanence, et
// un controle rouge en permanence n est plus consulte. La regle est : un aveu
// doit se JUSTIFIER, et la justification se verifie.
//
//   couvert par <fichier> : <nom de verification>
//       une autre sonde AFFIRME la meme chose. Verifie : le fichier existe au
//       catalogue, et il contient un `verifier(` dont le nom contient le nom
//       donne. C est la reponse a « citer n est pas eprouver » : une citation ne
//       compte que si elle devient une assertion quelque part.
//
//   structurel : <raison>
//       personne ne couvre ce trou, et voici pourquoi. Verifie : la raison est
//       declaree dans `AVEURS_STRUCTURELS` ci-dessous. Un trou structurel
//       nouveau ne passe donc pas : il faut l ecrire, ici, une fois.
//
// Le plancher est « zero aveu non justifie », pas « zero aveu ». Il mord, et il ne
// ment pas sur le nombre de trous : le registre est affiche a chaque run.

// Les trous structurels, avec la MESURE qui les etablit. Chaque ligne est une
// dette ecrite, donc une dette qu on peut discuter — et non une excuse
// forgotten dans la sortie d une sonde. La mesure de la premiere ligne est
// dans SECURITY.md §7/30 : sur le volume jetable, le seuil vaut 38 octets et
// l ecart vaut 15 Mo ; la branche « ecart negligeable » n est donc pas
// inexercitee par megarde, elle est inatteignable sur cette machine.
const AVEURS_STRUCTURELS = [
  { motif: 'branche « écart négligeable » non exercée', couts: 1, pourquoi: 'mesuré le 30/09 : la branche porte un verdict par volume concerné (écart affiché, signe, montant, signe affiché), et le registre prend le MINIMUM — un volume dont l écart passe sous le seuil perd un verdict, pas quatre ; sur V: le seuil vaut 38 octets pour 15 Mo d’écart, sur C: l’écart vaut 33,8 Go' },
  { motif: 'le guetteur de fenêtres n', couts: 0, pourquoi: 'l ouverture de l Explorateur est neutralisée par le guetteur, pas sautée : la sonde tourne et écrit ses verdicts, rien n est perdu — le motif existe pour documenter la preuve, pas pour détendre un plancher' },
  { motif: 'le support du volume n', couts: 1, pourquoi: 'mesuré : la démonstration porte un verdict unique (« le support est réel ») ; un volume calme le perd, et le runner l a montré le 28/09 — les identifiants ne bougent pas quand la surface d un volume ne change pas' },
  { motif: 'le volume est trop rapide', couts: 1, pourquoi: 'mesuré : la publication du numéro en vol porte un verdict unique ; sur un volume où l analyse finit avant l observation, il ne s écrit pas — un scan dure moins d une seconde sur le volume jetable' },
  // Le motif suit les MOTS DE LA SONDE, et rien d'autre. Celui d ici decrivait
  // « la coalescence reste prouvée cote Rust » ; la sonde ecrit « ELLE reste
  // prouvee cote Rust ». Le registre ne trouvait donc jamais son propre motif, et
  // le 30/09 l aveu passait en « sans justification » sur une machine rapide. Une
  // entree qui ne correspond a rien est une entree morte, et une entree morte ne
  // declare rien.
  { motif: 'coalescence pendant un scan en vol non exercée', couts: 1, pourquoi: 'mesuré le 30/09 : sur un volume rapide le premier scan est fini avant le second POST, donc la branche conditionnelle — un seul verdict — ne s ecrit pas ; la coalescence reste couverte par son test Rust, qu un navigateur ne peut pas voir' },
  { motif: 'exige un instantané', couts: 1, pourquoi: 'mesuré : le cas « chemin invalide » et son témoin portent deux verdicts, mais le témoin (le volume est analysé) est vérifié dans les deux branches — la perte est d un verdict, pas deux ; la garde a besoin d un instantané, et le volume n en a pas au moment de la requête' },
  { motif: 'le clic n', couts: 0, pourquoi: 'le clic qui échoue rend la sonde déjà ROUGE par ailleurs : aucun verdict supplémentaire n est perdu, le motif documente la cause et ne détend rien' },

// Le COUT d un trou, en verdicts. Un aveu structurel ne se contente pas de nommer
// ce qui n a pas ete eprouve : il DECLARE combien de verifications la sonde n ecrira
// pas a cause de ca, et c est ce nombre qui detend son plancher. Mesure le 30/09 :
// `plafond` ecrivait 6 verdicts ici et 4 sur le runner, et son plancher fixe de 6
// le faisait rougir a tort — un controle qui ment sur ce qu il mesure. Le nombre
// de verdicts perdus ne se devine donc pas : il se LIT dans le registre, la ou le
// trou se declare. Une sonde ne peut pas acheter son plancher : elle peut
// seulement declarer le trou qu elle a nomme, une fois, ici.

// Un second trou de la meme espece, revele le 30/09 par la reparation du premier :
// corriger le crash rendait au harnais le droit de parler, et il a immediatement
// trouve autre chose a dire. La sonde le disait depuis toujours — en deux lignes
// que le collecteur ne comptait pas, dans un dialecte (« non éprouvé ») qui ne
// correspond a aucune des marques reconnues.

// Un quatrieme trou de la meme famille, et le seul ou le cout s additionne :
// `csrf` fait trois cas, et le cas muet est un cas qui n a pas repondu. Un seul
// motif, donc un `couts` de 3 — et le harnais SOMME une entree par cas muet,
// donc le plancher baisse de 3 par cas et non une fois pour toutes.
  { motif: 'cas de csrf inaccessible non exercé', couts: 3, pourquoi: 'mesuré le 30/09 sur le runner : la page d un des trois cas n a pas repondu ; ce cas ne peut rien prouver, ni le CSRF ni son absence — la sonde ecrit alors 1 verdict au lieu de 4, et la distinction entre inaccessible et echec reste dans un commentaire' },
  { motif: 'le palier de vingt gigaoctets non exercée', couts: 4, pourquoi: 'mesuré le 30/09 sur le runner : aucun dossier de plus de 20 Go n existe, la sonde n écrit donc que son unique verdict de coherence ; la branche à cinq verdicts reste couverte par les tests unitaires, qui la vérifient à 74,2 Go' },

  { motif: 'branches du débordement non exercée — plafond non mesurable', couts: 4, pourquoi: 'mesuré : `corbeille_plafond` vaut null, et la section 1 saute alors son troisieme verdict ; les trois verdicts de la branche de débordement sont donc hors d atteinte' },
 { motif: 'branches du débordement non exercée — plafond au-delà de la borne d écriture de 256 mio', couts: 2, pourquoi: 'mesuré le 30/09, run 36606537220 : le plafond du volume jetable de la CI dépasse 256 Mio, alors qu il vaut 51 Mio sur les volumes locaux ; la sonde y écrit 4 verdicts sur 6, donc la perte est de 2, pas de 3 — un cout plus haut pardonnerait un verdict perdu sans aveu' },
  { motif: 'garde de l’application « Host absent → 403 » non exercée', couts: 0, pourquoi: 'dans un run du harnais, les sondes ne reçoivent que l URL du filet, donc la garde 403 de l application est morte par construction : le parseur HTTP de Node répond 400 avant elle. Aucun verdict n est perdu — ce que la note déclare est une ATTRIBUTION (ce vert prouve le filet, pas l application), et son coût est zéro écrit, pas tu' },
  { motif: 'moitié « instance élevée » NON exercée', couts: 4, pourquoi: 'la sonde elevation a deux chemins exclusifs : 17 verdicts communs + 1 sur instance normale, 17 + 4 sur élevée. Le plancher est posé sur le chemin le plus long (22) ; la moitié non jouée se déclare et détend de son coût — 4 sur une instance normale, 1 sur une élevée' },
  { motif: 'moitié « instance normale » NON exercée', couts: 1, pourquoi: 'l autre moitié du même mécanisme : sur une instance élevée, le bouton « actif sans rien taper » n existe pas, puisque le serveur exige EFFACER' },
  { motif: 'branche « corbeille présente » NON exercée', couts: 3, pourquoi: 'mesuré : elevation lit aCorbeille(VOL) et l imprime en tête, mais trois verdicts de destination et de loi n avaient jamais été conditionnés au fait ; sans corbeille ils assertent sur un état qui ne tient pas — un volume sans corbeille est un état légitime de la machine, pas une attaque : la sonde saute et déclare, l application n a rien à refuser' },
];

// ---------- le registre se verifie LUI-MEME, avant les tables ----------
//
// Un motif sans `couts` est le pire des deux mondes : la note qu il recoit est
// classee « aveu structurel » (donc jamais rouge), mais `plancherEffectif`
// filtre sur `&& n.couts` et ne detend RIEN. Une sonde saine qui declare un
// trou reconnu rougit donc a tort — le faux rouge le plus durable de ce depot,
// resté ouvert pendant deux campagnes parce que rien ne l eprouvait.
//
// La regle n est pas « ajoute un cout » : c est « dis ce que vaut le trou ».
// Zéro est une reponse legitime — `le clic n` ne coute rien, la sonde est déjà
// rouge par ailleurs — mais il faut l ECRIRE, parce qu un cout omis et un cout
// zero se lisent pareil et ne se comportent pas pareil.
// La VALIDITE, pas la presence. Le 30/09, un modele adverse (niveau extra) a
// trouve la faille en une reponse : ce filtre ne regardait que `=== undefined`,
// donc null, NaN, '' ou '1' (chaine) passaient le controle — et chacun
// continuait sa vie plus bas : `|| 0` transformait un cout inutilisable en
// zero silencieux (le faux rouge que le controle promettait d'empecher), et
// `a + n.couts` CONCATENAIT deux chaines en '011' (plancher ecrase a zero,
// faux vert). Un cout omis et un cout zero se lisent pareil et ne se
// comportent pas pareil ; un cout NON NOMBRE se comporte comme le hasard
// decide. La validite se verifie a la declaration, et la meme garde re-mord
// au point d'usage — dans plancherEffectif, plus bas.
const MOTIF_SANS_COUTS = AVEURS_STRUCTURELS.filter((a) =>
  a.couts === undefined || typeof a.couts !== 'number' || !Number.isFinite(a.couts) || a.couts < 0);
if (MOTIF_SANS_COUTS.length) {
  console.error(`  REGISTRE DES AVEUX : ${MOTIF_SANS_COUTS.length} motif(s) a couts absent ou non nombre :`);
  for (const a of MOTIF_SANS_COUTS) console.error(`    - ${a.motif} : ${JSON.stringify(a.couts)}`);
  console.error('    Un cout non nombre passe le controle de presence puis se comporte' +
    ' au hasard plus bas : null ou chaine devient zero par ||, deux chaines se' +
    ' CONCATENENT dans la somme. Ecris un nombre fini positif ou nul, meme zero.');
  process.exit(1);
}

// ---------- le controle META des gardes, apres les tables ----------
//
// Trois tables mordent sur trois fonctions. Mais une fonction n est pas une
// garde : c est le CHEMIN de decision qu elle prend, et un chemin qu aucune
// table ne traverse est une garde que PERSONNE ne regarde. C est la cause racine
// nommee trois fois cette semaine (§7/35, §7/38, le bilan des muettes) : les
// cinq instances de la famille « sonde dit vrai, controle ne sait pas lire »
// vivaient toutes dans un chemin jamais eprouve.
//
// Le controle n est pas une liste tenue a cote du code — le registre `couts`
// a deja paye pour ce defaut la (six entrees mortes). Chaque chemin se DECLARE
// dans le code de la fonction elle-meme, au moment ou il rend : une garde non
// declaree est invisible au controle, une declaree sans table est une orpheline
// nommee. La dette n est pas supprimee, elle est rendue visible au moment de la
// naissance.
const GARDES = [];
// Une entree PAR CLE (pas par appel) : sinon chaque invocation laisse une
// declaration orpheline que rien ne marquera jamais, et le controle s accuse
// lui-meme. La cle voyage avec l objet rendu (`__garde`) : la boucle qui recoit
// une sortie sait AUSSITOT quel chemin l a produite, sans aucune recherche.
const garde = (cle, chemin) => {
  if (!GARDES.some((g) => g.cle === cle)) GARDES.push({ cle, mordue: false });
  return { ...chemin, __garde: cle };
};
// Marquer un chemin qui ne rend pas d objet : les formes de ramassage du
// collecteur et les états de lecture d une sortie sont des DECISIONS sans
// valeur de retour — elles se déclarent par leur seule traversée.
const toucher = (cle) => {
  let g = GARDES.find((x) => x.cle === cle);
  if (!g) { g = { cle, mordue: false }; GARDES.push(g); }
  g.mordue = true;
};
let GARDE_FAIL = '';
// Les noms de verification d une sonde, lus dans son SOURCE et non dans sa
// sortie : c est le code qui affirme, et un rapport peut mentir. Deplace ici
// au moment du controle meta : les declarations vivent avec lui, sinon la
// portée utilise ce qu elle n a pas encore declare.
const cacheNoms = new Map();
function nomsDuCatalogue(fichier) {
  if (cacheNoms.has(fichier)) return cacheNoms.get(fichier);
  let noms = [];
  try {
    const src = fs.readFileSync(path.join(ICI, fichier), 'utf8');
    noms = [...src.matchAll(/verifier\(\s*(['`])(.+?)\1/g)].map((m) => norm(m[2]));
  } catch { /* un fichier absent ne couvre rien : c est traite plus bas */ }
  cacheNoms.set(fichier, noms);
  return noms;
}

// Un aveu est reconnu par sa MARQUE, explicite de preference. Les formes
// historiques restent reconnues, sinon un simple `NE PAS MESURABLE` passerait
// sous le controle en changant trois lettres — un controle qu on contourne en
// ecrivant autrement n est pas un controle.
const MOT_AVEU = /ne prouve rien|non exerc[ée]e?|ne pas mesurable|non mesurable/i;
const FORME_COUVERT = /couvert par\s+([\w.-]+\.mjs)\s*:\s*(.+)$/;
const FORME_STRUCTUREL = /structurel\s*:\s*(.+)$/;

// Les apostrophes typographiques ne sont pas une raison de manquer une
// verification : `l'Analyse` et `l’Analyse` doivent etre le meme nom. Les
// accents non plus : `numero` et `numéro` sont le meme mot.
const norm = (t) => String(t).toLowerCase().replace(/[’‘`]/g, "'")
  .replace(/[\u00e0\u00e2\u00e4]/g, 'a').replace(/[\u00e9\u00e8\u00ea\u00eb]/g, 'e')
  .replace(/[\u00ee\u00ef]/g, 'i').replace(/[\u00f4\u00f6]/g, 'o')
  .replace(/[\u00f9\u00fb\u00fc]/g, 'u').replace(/\u00e7/g, 'c')
  .replace(/\s+/g, ' ').trim();

/**
 * Classe une note : explication, aveu justifie, ou aveu SANS JUSTIFICATION.
 * La mesure est toujours le texte, parce qu un controle qui dit « non » sans
 * dire pourquoi oblige a relire la sortie entiere.
 */
function classerNote(texte) {
  if (!MOT_AVEU.test(texte)) return garde('explication', { sorte: 'explication' });
  const couverte = texte.match(FORME_COUVERT);
  if (couverte) {
    const [, fichier, nom] = couverte;
    const connu = SONDES.some((s) => s.fichier === fichier);
    if (!connu) {
      return garde('couvert hors catalogue', { sorte: 'aveu nu', mesure: `${fichier} n’est pas une sonde du catalogue : elle ne peut rien couvrir` });
    }
    // La citation est lue dans le SOURCE de la sonde citee — les noms y sont
    // declares par `nomsDuCatalogue`, plus haut — et comparee par MOTS ENTIERS,
    // en sequence : `includes` faisait passer `couvert par <une sonde>.mjs : e`
    // dès qu'un nom de verification contenait la lettre `e`. Une citation
    // tronquee au debut reste recevable, une citation en sous-mots (« e ») ne
    // l est plus. Les accents sont retires des deux cotes : `numero` et
    // `numéro` sont le meme mot.
    const noms = nomsDuCatalogue(fichier);
    const motsCites = norm(nom).split(/\s+/).filter(Boolean);
    const citeQuelqueChose = motsCites.length > 0 &&
      noms.some((n) => {
        const mots = n.split(/\s+/);
        if (motsCites.length > mots.length) return false;
        let i = 0;
        for (const m of mots) {
          if (m === motsCites[i]) i++;
        }
        return i === motsCites.length;
      });
    if (!citeQuelqueChose) {
      return garde('couvert sans nom', {
        sorte: 'aveu nu',
        mesure: `${fichier} ne vérifie rien qui s’appelle « ${nom.trim()} » : la citation ne `
          + 'devient une assertion nulle part',
      });
    }
    return garde('couvert reconnu', { sorte: 'aveu couvert', mesure: `couvert par ${fichier} : ${norm(nom)}` });
  }
  const structurel = texte.match(FORME_STRUCTUREL);
  if (structurel) {
    // Une justification qui tient sur la LIGNE. Le collecteur lit ligne a ligne,
    // donc un `structurel :` suivi d un retour a la ligne laisse la raison vide :
    // l aveu devient « nu », donc rouge — mais pour une faute de FORME, accusée à tort
    // d un trou qui, lui, est bel et bien déclaré. Le 30/09, un brouillon de
    // `sonde-corbeille-plafond` écrivait exactement cela, et c est ce contrôle-là
    // qui a produit le faux rouge de la première contre-épreuve.
    if (structurel[1].trim().length < 12) {
      return garde('structurel trop court', {
        sorte: 'aveu nu',
        mesure: 'la justification est vide ou trop courte : « structurel : » suivi d un'
          + 'retour a la ligne perd sa raison, et l aveu est lu nu. Une note tient sur'
          + 'UNE seule ligne.',
      });
    }
    // Le motif du registre se cherche dans la NOTE ENTIERE, pas dans la seule
    // raison. Premier essai, il ne cherchait que la raison — et comme l auteur
    // ecrit l identifiant du trou AVANT (`branche « ecart negligeable »`) et la
    // raison apres (`structurel : …`), le registre ne trouvait jamais son propre
    // motif et déclarait huit aveux sur neuf injustifies. Le controle etait
    // exact, la convention etait absurde : c est elle qu on a changee.
    const declare = AVEURS_STRUCTURELS.find((a) => norm(texte).includes(norm(a.motif)));
    if (!declare) {
      return garde('structurel hors registre', {
        sorte: 'aveu nu',
        mesure: `« ${structurel[1].trim()} » n’est pas dans le registre AVEURS_STRUCTURELS : `
          + 'un trou structurel nouveau doit être écrit une fois, ici',
      });
    }
    return garde('aveu structurel', {
      sorte: 'aveu structurel',
      mesure: declare.pourquoi,
      motif: declare.motif,
      couts: declare.couts || 0,
    });
  }
  return garde('aveu sans forme', { sorte: 'aveu nu', mesure: 'ni « couvert par », ni « structurel » : un aveu sans justification' });
}

/**
 * Le plancher effectif, en une fonction PURE.
 *
 * Elle ne fait qu arithmetique — et c est precisement pour cela qu elle est
 * eprouvee plus bas. Ecrits dans le corps du run, le calcul etait faux deux fois
 * sur trois Machine : ici `plafond` ecrivait 3 verdicts sur le runner, et son
 * plancher de 6 le faisait rougir a tort — un controle qui ment sur ce qu il
 * mesure. Le pire n est pas le faux rouge : c est que rien dans le depot ne
 * pouvait etre vrai et faux dans la meme seconde, selon la machine.
 *
 * Le defaut du calcul est nomme dans la fonction ; il est verifie par la table
 * qui suit, sur des entrees connues, avant que la moindre sonde ne tourne. Ses
 * trois chemins de sortie sont declares au controle meta : sans garde, intact,
 * relache — un chemin rendu sans etre nommé serait un chemin que personne ne
 * regarde.
 */
function plancherEffectif(brut, notes) {
  // Le cout se verifie AU POINT D'USAGE, pas seulement a la declaration : la
  // table ci-dessous re-verifie le controle lui-meme, donc un controle affine
  // en amont ne suffit pas si la fonction aval accepte n'importe quoi. Une
  // valeur non nombre est une PANNE, pas une absence : elle force le chemin
  // « plancher intact » a echouer vers le rouge (plancher -1), jamais vers le
  // vert — un plancher a zero serait precisement le faux vert que la
  // concatenation de chaines produisait.
  const coutsFous = (notes || []).filter((n) => n.sorte === 'aveu structurel'
    && n.couts !== undefined && (typeof n.couts !== 'number' || !Number.isFinite(n.couts)));
  if (coutsFous.length) return garde('couts non nombre', {
    plancher: -1, trous: coutsFous, dispense: NaN,
  });
  const trous = (notes || []).filter((n) => n.sorte === 'aveu structurel' && n.couts);
  const dispense = trous.reduce((a, n) => a + n.couts, 0);
  if (brut === undefined) return garde('plancher sans garde', { plancher: undefined, trous, dispense });
  // Une note reconnue DONC non detendue est le faux vert le plus silencieux
  // d ici : le chemin « intact » doit etre un chemin declare, pas un cas
  // glissant de la branche de dispense.
  if (dispense === 0) return garde('plancher intact', { plancher: Math.max(0, brut), trous, dispense });
  return garde('plancher relâché', { plancher: Math.max(0, brut - dispense), trous, dispense });
}

// ---------- le compte d une sortie de sonde, en pur ----------
//
// Une sonde ecrit ses verdicts ligne a ligne, et son resume, qu elle ecrit
// ELLE-MEME : le harnais ne peut pas l ecrire a sa place. Il le recompte donc,
// et il recompte les lignes aussi. Deux controles qui se recoupent ne valent que
// s ils sont INDEPENDANTS — or les deux lisaient le meme tampon, et une seule
// ligne pouvait donc les satisfaire tous les deux.
//
// C etait vrai, et c etait une laisse. Une entree construite le 30/09 par un
// modele adverse : « ok    5/5 verifications », ecrit APRES le vrai resume.
// Elle comptait comme verdict, comme numerateur et comme denominateur, et le
// harnais declarait verte une sonde qui avait perdu un verdict. Le resume
// commence maintenant une LIGNE : aucune ligne de verdict ne peut en etre un.
//
// La seconde laisse : rien ne verifiait qu un verdict n avait pas ROUGE. Un
// ROUGE ecrit, puis une sortie en 0 : le recoupement passe — un resume honnete
// « 4/5 » s accorde parfaitement avec quatre ok et un ROUGE — et le ROUGE
// comble le plancher a la place d un ok manquant. Les vingt-cinq sondes
// sortent toutes en 1 des qu un echec est enregistre, donc rien ne s ouvre
// aujourd hui. La porte, elle, etait ouverte pour demain, et rien ne l aurait
// signale : c est elle qu un harnais doit fermer, pas un code de sortie.
const FORME_RESUME = /^[ \t]*(\d+)\/(\d+)[ \t]+v[ée]rifications/m;
const TOUS_RESUMES = new RegExp(FORME_RESUME.source, 'gm');
const FORME_VERDICT = /^(ok|ROUGE)\b\s/;

/** Compte une sortie de sonde. Ne leve jamais : c est une fonction, pas un test. */
function compterSortie(tout) {
  const compte = [...tout.matchAll(TOUS_RESUMES)].pop();
  const vide = !!compte && Number(compte[2]) === 0;
  const muette = !compte || vide;
  const lignesVerdict = tout.split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => FORME_VERDICT.test(l) && !FORME_RESUME.test(l));
  const nOk = lignesVerdict.filter((l) => l.startsWith('ok')).length;
  const verdictsEcrits = lignesVerdict.length;
  const descompteFaux = !!compte
    && (Number(compte[1]) !== nOk || Number(compte[2]) !== verdictsEcrits);
  const rougeEcrit = verdictsEcrits !== nOk;
  // Les quatre chemins de lecture se déclarent : muette, décompte incohérent,
  // rouge écrit — et le chemin SILENCIEUX, celui d une sortie honnête, qui
  // n est pas une absence de décision mais la conjonction des trois négations.
  // Sans sa déclaration, une fusion des trois branches en une seule ne se
  // verrait nulle part.
  if (muette) toucher('sortie muette');
  if (descompteFaux) toucher('decompte incoherent');
  if (rougeEcrit) toucher('rouge ecrit');
  if (!muette && !descompteFaux && !rougeEcrit) toucher('sortie saine');
  return { compte, vide, muette, nOk, verdictsEcrits, descompteFaux, rougeEcrit };
}

// ---------- le ramassage des notes, en pur ----------
//
// Le collecteur vit ICI, hors de la boucle des sondes : c est lui qui ramassait
// le prefixe `NE PAS MESURABLE` en emportant la marque avec lui (§7/36), et
// `entrees` ecrivait ses notes par `info()`, sans prefixe ni fonction — deux
// defauts vecus, dans le code que personne ne regardait parce qu il tournait
// PENDANT les sondes. Ses trois formes de ramassage sont des gardes : une
// forme retiree du filtre n est plus jamais marquee et le verdict du controle
// meta le nomme ; une forme elargie ramasse trop, et la table de collecte voit
// le texte exact deraper. Deux formes historiques : la ligne `note :` et le
// marqueur du resume (`(+N non mesurable(s))`) — le TEXTE est retenu, pas
// seulement un nombre, et la marque de l aveu doit SURVIVRE au retrait du
// prefixe, dans le corps du texte.
function collecterNotes(tout) {
  return tout.split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => {
      if (/^note\s*:/i.test(l)) { toucher('forme note :'); return true; }
      if (/^NE PAS MESURABLE/.test(l)) { toucher('forme NE PAS MESURABLE'); return true; }
      if (/\+\d+ non mesurable/.test(l)) { toucher('forme resume non mesurable'); return true; }
      return false;
    })
    .map((l) => l.replace(/^note\s*:\s*/i, '')
      .replace(/^NE PAS MESURABLE\s*[—-]\s*/i, '')
      .replace(/\(\+\d+ non mesurable\(s\)\)\s*$/i, '')
      .trim()
      .slice(0, 300))
    .map((texte) => ({ texte, ...classerNote(texte) }));
}

// ---------- la table de reconnaissance, eprouvee a chaque run ----------
//
// `classerNote` est une garde que PERSONNE ne regarde : elle ne rend un code de
// sortie a personne, elle classe des phrases. Une retouche de `MOT_AVEU` — deux
// lettres — et tous les aveux structurels du depot repassent « explication » :
// plus de rouge, plus de registre, plus rien. Le trou redevient ce qu il etait
// avant tout ca, et le run affiche « 24/24 sondes vertes ».
//
// Alors cette table est le contre-epreuve : elle passe dans le classifieur
// REEL, avec des phrases reelles, et le run s arrete ICI, avant la moindre sonde,
// si une seule ne tombe pas dans la categorie qu elle annonce. Le controle se
// controle, et il se controle avant de rendre la main.
//
// Chaque ligne est un cas deja observe, ou un cas qu il faut pouvoir nommer.
const TABLE_RECONNAISSANCE = [
  [
    'branches du débordement NON EXERCÉE — plafond non mesurable — structurel : le plafond de corbeille n est pas mesurable',
    'aveu structurel',
    'un aveu structurel declare, sa raison tenant sur la meme ligne',
    { garde: 'aveu structurel' },
  ],
  [
    'branches du débordement NON ÉPROUVÉE — structurel : une raison parfaitement suffisante',
    'explication',
    '« éprouvé » n est pas dans MOT_AVEU : la sonde aurait avoué sans etre comptee',
  ],
  [
    'branches du débordement NON EXERCÉE — structurel :',
    'aveu nu',
    'une justification repoussee a la ligne suivante perd sa raison',
    { garde: 'aveu sans forme' },
  ],
  [
    'branches du débordement NON EXERCÉE — un trou que personne n a declare — structurel : une raison suffisamment longue',
    'aveu nu',
    'un trou structurel absent du registre ne passe pas',
    { garde: 'structurel hors registre' },
  ],
  [
    'rien à signaler sur ce volume',
    'explication',
    'une note qui n avoue rien est une explication, pas un aveu',
  ],
  [
    'branches du débordement NON EXERCÉE — plafond non mesurable — structurel : trop court',
    'aveu nu',
    'une justification de moins de douze caracteres garde sa ligne mais perd sa raison : la garde de longueur a besoin de sa propre ligne, sinon la retirer ne casse rien',
    { garde: 'structurel trop court' },
  ],
  [
    'branches du débordement NON EXERCÉE — non mesurable — couvert par sonde-inconnue.mjs : un nom de verification',
    'aveu nu',
    'une justification qui cite un fichier hors catalogue ne couvre rien : la branche « couvert par » a besoin de sa propre ligne, sinon on ne sait pas qu elle rend avant le registre',
    { garde: 'couvert hors catalogue' },
  ],
  [
    'branches du débordement NON EXERCÉE — non mesurable — couvert par sonde-erreurs.mjs : au moins un volume a des illisibles',
    'aveu couvert',
    'la meme branche, avec une citation REELLE cette fois : fichier du catalogue, mots entiers d un verifier existant — un chemin qui mord doit aussi avoir son cas vert, sinon on ne distingue pas sa morsure d une panne generale',
    { garde: 'couvert reconnu' },
  ],
  [
    'branches du débordement NON EXERCÉE — non mesurable — couvert par sonde-erreurs.mjs : e',
    'aveu nu',
    'une citation d une seule lettre ne nomme aucune verification : c est le faux « couvert » historique, celui qu includes laissait passer — sa garde n avait jamais eu sa ligne de table',
    { garde: 'couvert sans nom' },
  ],
];
// Le passage des tables EST l enregistrement des morsures : chaque ligne
// traverse le chemin qui produit ce qu elle attend, et ce chemin se declare en
// meme temps qu il est eprouve. Le dernier element d une ligne nomme la garde
// qu elle pretend mordre ({ garde: « cle » }) : si la sortie vient d un autre
// chemin, la table et la declaration se contredisent, et le controle refuse de
// trancher a leur place. Une sortie rendue SANS garde jumelle est un chemin
// que le controle meta ne peut pas voir — et ce silence-la est precisement le
// trou qu on cherche. Inversement, une declaration jamais traversee se verra
// au verdict final : fusionner deux chemins, c est en laisser un orphelin,
// et l orphelin a un nom.
const tableFaux = [];
for (const [texte, attendu, , role] of TABLE_RECONNAISSANCE) {
  const obtenu = classerNote(texte);
  if (obtenu.sorte !== attendu) {
    tableFaux.push(`${attendu} — mesuré : ${obtenu.sorte} sur « ${texte.slice(0, 70)} »`);
  }
  const g = GARDES.find((x) => x.cle === obtenu.__garde);
  if (!g) {
    GARDE_FAIL += `    - TABLE_RECONNAISSANCE produit une sortie ${JSON.stringify(obtenu)} que la fonction ne declare pas : un chemin rendu sans etre nommé est un chemin que le controle meta ne peut pas voir\n`;
  } else {
    g.mordue = true;
    if (role && role.garde && role.garde !== g.cle) {
      GARDE_FAIL += `    - la ligne annonce mordre sur « ${role.garde} » mais la sortie vient de « ${g.cle} » : la table et la declaration ne disent pas la meme chose\n`;
    }
  }
}
if (tableFaux.length) {
  console.error(`  LA TABLE DE RECONNAISSANCE DES AVEUX EST FAUSSE : ${tableFaux.length}`);
  for (const m of tableFaux) console.error(`    - ${m}`);
  // Une expression a virgules : elle evaluait les deux chaines sans jamais les
  // afficher, et le run sortait en 1 en gardant le silence. Un controle qui refuse
  // de dire pourquoi il vient de mourir est un controle que personne ne peut
  // reparer. Le 30/09, un modele adverse l a trouve en lisant ces lignes.
  console.error('    Le classifieur ne tient plus sa promesse, donc plus aucun aveu' +
    ' du depot n est comptable. Corriger avant de lire un run vert.');
  process.exit(1);
}
if (GARDE_FAIL) {
  console.error('  GARDES NON DECLAREES OU NON EPROUVEES :');
  console.error(GARDE_FAIL);
  console.error('    Toute garde doit avoir sa ligne de table — son cas qui fait mordre, et' +
    ' son cas qui laisse passer. Une garde sans epreuve est celle que PERSONNE ne regarde.');
  process.exit(1);
}

// La MEME demarche, sur l arithmetique du plancher. Une sonde qui perd des
// verdicts ne doit pas etre rougee — mais une sonde qui en perd plus qu elle
// ne dit pas, si. Ces entrees sont les MESURES du 30/09, pas des intentions :
// `plafond` ecrivait 6 verdicts sur un volume dont la corbeille tient sous
// 256 Mio, et 4 sur celui de la CI, dont la corbeille est plus large. Le meme
// plancher ne peut pas etre vrai sur les deux — donc il se relache, et il se
// relache du nombre que le registre DECLARE.
const NON_EXERCEE = 'branches du débordement NON EXERCÉE — plafond non mesurable — structurel : le plafond de corbeille n est pas mesurable';
const TROP_LARGE = 'branches du débordement NON EXERCÉE — plafond au-delà de la borne d écriture de 256 Mio — structurel : la borne est dépassée';
const LE_PALIER = 'le palier de vingt gigaoctets NON EXERCÉE — structurel : aucun dossier de plus de 20 Go n existe sur cette machine';
const LE_CSRF = 'cas de csrf inaccessible NON EXERCÉ — structurel : la page n a pas pu etre atteinte, donc rien n a ete mesuré pour ce cas';
const LE_TICKETS = 'coalescence pendant un scan en vol non exercée sur ce volume (trop rapide) — elle reste prouvée côté Rust — structurel : la coalescence a son test Rust, qu un navigateur ne peut pas voir';
const SANS_MARQUE = 'branches du débordement NON ÉPROUVÉE — structurel : une raison parfaitement suffisante';
const TRONQUEE = 'branches du débordement NON EXERCÉE — structurel :';
const NON_DECLARE = 'branches du débordement NON EXERCÉE — un trou neuf — structurel : une raison parfaitement suffisante';
const MOITIE_ELEVEE = 'moitié « instance normale » NON exercée — 1 vérification sautée (bouton actif sans rien taper). structurel : l instance est élevée, le serveur exige alors EFFACER et un bouton actif sans saisie ne peut pas être observé';
const MOITIE_NORMALE = 'moitié « instance élevée » NON exercée — 4 vérifications sautées (conséquence du bandeau, bouton inactif tant que vide, mot suivi d une espace, mot exact), le champ de saisie n a pas été éprouvé. structurel : l instance est normale, la loi n exige alors aucun mot et le champ de confirmation n existe pas dans la modale';
const CORBEILLE_ABSENTE = 'branche « corbeille présente » NON exercée — 3 vérifications sautées (destination annoncée, destination sous mot exigé, LA LOI), la corbeille de V est absente. structurel : sans corbeille, le serveur ne peut pas annoncer la destination corbeille, et la loi ne tient sur aucun de ses deux côtés — cet état dépend du volume, pas du code';
const notes = (...textes) => textes.map((t) => ({ texte: t, ...classerNote(t) }));
const TABLE_PLANCHER = [
  [6, notes(), 6, 'sans note, le plancher ne bouge pas', { garde: 'plancher intact' }],
  [6, notes(TROP_LARGE), 4, 'un trou declare de 2 verdicts relache de 2 (mesure : la sonde ecrit 4 verdicts sur le runner, donc la perte est de 2)', { garde: 'plancher relâché' }],
  [6, notes(NON_EXERCEE), 2, 'un trou declare de 4 verdicts relache de 4', { garde: 'plancher relâché' }],
  [6, notes(SANS_MARQUE), 6, '« éprouvé » n est pas une marque d aveu : rien ne se relache'],
  [6, notes(TRONQUEE), 6, 'une justification tronquee ne relache rien'],
  [6, notes(NON_DECLARE), 6, 'un trou absent du registre ne relache rien'],
  [12, notes(LE_CSRF), 9, 'un cas muet sur trois detache 3 verdicts : 12 - 3 = 9, ce qu ecrit reellement la sonde sur le runner', { garde: 'plancher relâché' }],
  [12, notes(LE_CSRF, LE_CSRF), 6, 'deux cas muets detachent 6 : le cout s cumule, il ne s ecrit qu une fois', { garde: 'plancher relâché' }],
  [9, notes(LE_TICKETS), 8, 'un scan en vol non observe detache le seul verdict conditionnel : 9 - 1 = 8, ce qu ecrit la sonde sur un volume rapide', { garde: 'plancher relâché' }],
  [5, notes(LE_PALIER), 1, 'un trou declare de 4 verdicts ramene le plancher de 5 a 1, ce qu ecrit reellement une sonde sans dossier de 20 Go', { garde: 'plancher relâché' }],
  [6, [{ texte: 'cout chaine', sorte: 'aveu structurel', couts: '1' }], -1,
    'un cout non nombre est une PANNE : le verrou echoue vers -1, jamais vers zero — deux chaines se concatenaient en 011 et ecrasaient le plancher',
    { garde: 'couts non nombre' }],
  [6, [{ texte: 'cout null', sorte: 'aveu structurel', couts: null }], -1,
    'null passe la garde && puis vaut zero par || : le faux rouge que le controle de declaration devait empecher, ici rendu impossible',
    { garde: 'couts non nombre' }],
  [6, notes(TROP_LARGE, NON_EXERCEE), 0, 'deux trous cumulent leurs couts, et le plancher est borne a zero'],
  [22, notes(MOITIE_ELEVEE), 21, 'instance élevée : 17 communs + 1 bandeau + 3 bouton = 21 écrits, la moitié non jouée détend de 1 — le compte du runner du 30/09'],
  [22, notes(MOITIE_NORMALE), 18, 'instance normale : 18 écrits, la moitié élevée détend de 4 — le compte de la machine locale'],
  [22, notes(MOITIE_NORMALE, CORBEILLE_ABSENTE), 15, 'instance normale ET corbeille absente : les dettes se cumulent, 22 - 4 - 3 = 15 — le cas que la mutation de preuve a joué'],
  [undefined, notes(TROP_LARGE), undefined, 'une sonde sans plancher en garde reste sans plancher : une relaxation n en cree pas un', { garde: 'plancher sans garde' }],
];
// MEME enregistrement pour l arithmetique. Le danger propre d ici n est pas la
// panne — elle rend une valeur fausse, et la table la voit — mais la FUSION : un
// chemin « intact » avale par « relâché » produit les MEMES valeurs sur ces
// lignes, et l orphelin ne se verrait qu au verdict final, par son absence de
// morsure.
const plancherFaux = [];
for (const [brut, ns, attendu, , role] of TABLE_PLANCHER) {
  const obtenu = plancherEffectif(brut, ns);
  if (obtenu.plancher !== attendu) {
    plancherFaux.push(`attendu ${attendu}, mesuré ${obtenu.plancher} sur un plancher de ${brut} et ${ns.length} note(s)`);
  }
  const g = GARDES.find((x) => x.cle === obtenu.__garde);
  if (!g) {
    GARDE_FAIL += `    - TABLE_PLANCHER produit une sortie ${JSON.stringify(obtenu)} que la fonction ne declare pas\n`;
  } else if (obtenu.plancher < 0 && obtenu.plancher !== -1) {
    GARDE_FAIL += `    - TABLE_PLANCHER produit un plancher ${obtenu.plancher} : la panne echoue vers -1 exactement, pas vers une autre valeur negative\n`;
  } else {
    g.mordue = true;
    if (role && role.garde && role.garde !== g.cle) {
      GARDE_FAIL += `    - la ligne du plancher annonce « ${role.garde} » mais la sortie vient de « ${g.cle} »\n`;
    }
  }
}
if (plancherFaux.length) {
  console.error(`  LA TABLE DES PLANCHERS EST FAUSSE : ${plancherFaux.length}`);
  for (const m of plancherFaux) console.error(`    - ${m}`);
  console.error('    Un plancher faux fait rougir a tort une sonde saine, ou laisse' +
    'passer une sonde qui a perdu des assertions. Corriger avant de lire un vert.');
  process.exit(1);
}
if (GARDE_FAIL) {
  console.error('  GARDES NON DECLAREES OU NON EPROUVEES (plancher) :');
  console.error(GARDE_FAIL);
  console.error('    Toute garde doit avoir sa ligne de table — son cas qui fait mordre, et' +
    ' son cas qui laisse passer. Une garde sans epreuve est celle que PERSONNE ne regarde.');
  process.exit(1);
}

// ---------- la table de collecte, eprouvee a chaque run ----------
//
// Les formes de ramassage sont des gardes, donc elles ont leur table. L oracle
// est LITERAL : le texte exact attendu apres retrait du prefixe — un .replace
// elargi drape ici, sur la chaine qu il modifie, pas sur un classement aval.
// La ligne 2 porte le piege du §7/36 : la marque de l aveu doit SURVIVRE au
// retrait du prefixe, donc vivre dans le corps du texte. La ligne 4 est la
// negative : une phrase qui ressemble a une note n en est pas une.
const TABLE_COLLECTE = [
  [
    'note : branche « x » NON exercée — 2 vérifications sautées. structurel : la raison tient sur la ligne',
    ['branche « x » NON exercée — 2 vérifications sautées. structurel : la raison tient sur la ligne'],
    { garde: 'forme note :' },
  ],
  [
    'NE PAS MESURABLE — non mesurable : le guetteur de fenêtres n’a rien pu dire. structurel : l’ouverture de l’Explorateur ne se mesure pas en service continu',
    ['non mesurable : le guetteur de fenêtres n’a rien pu dire. structurel : l’ouverture de l’Explorateur ne se mesure pas en service continu'],
    { garde: 'forme NE PAS MESURABLE' },
  ],
  [
    'ok   a\n14/14 vérifications (+1 non mesurable(s))',
    ['14/14 vérifications'],
    { garde: 'forme resume non mesurable' },
  ],
  [
    'aucune note ici : la sonde dit tout à voix haute',
    [],
    { garde: 'forme note :' },
  ],
];
const collecteFausse = [];
for (const [entree, attendu, role] of TABLE_COLLECTE) {
  const obtenu = collecterNotes(entree).map((n) => n.texte);
  if (JSON.stringify(obtenu) !== JSON.stringify(attendu)) {
    collecteFausse.push(`attendu ${JSON.stringify(attendu)}, mesuré ${JSON.stringify(obtenu)} sur « ${entree.slice(0, 60)} »`);
  }
  const g = GARDES.find((x) => x.cle === role.garde);
  if (!g) {
    GARDE_FAIL += `    - TABLE_COLLECTE annonce « ${role.garde} », qui n est pas déclarée\n`;
  } else {
    g.mordue = true;
  }
}
if (collecteFausse.length) {
  console.error(`  LA TABLE DE COLLECTE EST FAUSSE : ${collecteFausse.length}`);
  for (const m of collecteFausse) console.error(`    - ${m}`);
  console.error('    Le collecteur décide de ce que le harnais voit des notes d une sonde :' +
    ' un ramassage faux, c est un aveu qui disparaît — ou une phrase qui devient un aveu.');
  process.exit(1);
}
if (GARDE_FAIL) {
  console.error('  GARDES NON DECLAREES OU NON EPROUVEES (collecte) :');
  console.error(GARDE_FAIL);
  console.error('    Toute garde doit avoir sa ligne de table. Une garde sans epreuve est' +
    ' celle que PERSONNE ne regarde.');
  process.exit(1);
}

// La MEME demarche, sur ce que le harnais LIT dans la sortie d une sonde. Ces
// quatre entrees sont des sorties REELLES en forme : trois d entre elles sont
// des formes qu aucune sonde n ecrit aujourd hui, et c est precisement le
// sujet — une porte que rien n exerce est une porte qu on croit fermee.
const SORTIE_PLAINE = 'ok   a\nok   b\n2/2 vérifications vertes';
const SORTIE_AVEC_ROUGE = 'ok   a\nok   b\nok   c\nok   d\nROUGE somme des tailles\n'
  + '      mesuré : 4096 au lieu de 4100\n4/5 vérifications vertes';
const SORTIE_PARASITE = 'ok   a\nok   b\nok   c\nok   d\n4/4 vérifications vertes\nok    5/5 vérifications';
const SORTIE_MUETTE = 'aucun cas a tester sur ce volume\n0/0 vérifications vertes';
const TABLE_SORTIE = [
  [SORTIE_PLAINE, { muette: false, descompteFaux: false, rougeEcrit: false, verdictsEcrits: 2 },
    'une sortie honnete ne declenche rien'],
  [SORTIE_AVEC_ROUGE, { muette: false, descompteFaux: false, rougeEcrit: true, verdictsEcrits: 5 },
    'un resume HONNETE ne fait pas disparaitre un ROUGE : le recoupement passe, et c est la ligne rouge que le harnais doit voir'],
  [SORTIE_PARASITE, { muette: false, descompteFaux: true, rougeEcrit: false, verdictsEcrits: 5 },
    'une ligne « ok 5/5 verifications » n est plus un resume : elle devient un verdict, et le recoupement la voit'],
  [SORTIE_MUETTE, { muette: true, descompteFaux: false, rougeEcrit: false, verdictsEcrits: 0 },
    'une sonde qui annonce 0/0 est muette, quoi qu elle ecrit autour'],
];
const sortieFaux = TABLE_SORTIE
  .filter(([texte, attendu]) => Object.entries(attendu)
    .some(([cle, valeur]) => compterSortie(texte)[cle] !== valeur))
  .map(([texte, attendu]) => Object.entries(attendu)
    .filter(([cle, valeur]) => compterSortie(texte)[cle] !== valeur)
    .map(([cle, valeur]) => `${cle} : attendu ${valeur}, mesuré ${compterSortie(texte)[cle]}`)
    .join(', ') + ` sur « ${texte.split('\n').at(-1)} »`);
if (sortieFaux.length) {
  console.error(`  LA TABLE DES SORTIES EST FAUSSE : ${sortieFaux.length}`);
  for (const m of sortieFaux) console.error(`    - ${m}`);
  console.error('    Le harnais ne sait plus lire ce que les sondes ecrivent. Corriger avant' +
    ' de lire un vert : un resume qu il ne voit pas est un plancher qu il ne garde pas.');
  process.exit(1);
}

// ---------- le verdict du controle meta des gardes ----------
//
// Ici, tout chemin declare a ete traverse : les tables ont tourne, et leurs
// attentes ont nomme ce qu elles produisaient. Reste l inverse — un chemin
// declare que RIEN n a traverse. Et le pire des deux mondes : plus aucune
// declaration du tout, qui ferait taire le controle entier. Les deux se
// verifient tout seuls :
const GARDES_MINIMALES = 19;
if (GARDES.length < GARDES_MINIMALES) {
  console.error(`  CONTROLE META DES GARDES : ${GARDES.length} chemin(s) declares, il en faut au moins ${GARDES_MINIMALES} — les declarations ont-elles ete retirees ?`);
  process.exit(1);
}
const jamaisMordues = GARDES.filter((g) => !g.mordue);
if (jamaisMordues.length) {
  console.error(`  ${jamaisMordues.length} GARDE(S) DECLAREE(S) MAIS JAMAIS TRAVERSEE(S) :`);
  for (const g of jamaisMordues) console.error(`    - ${g.cle}`);
  console.error('    Un chemin declare sans table est une garde que personne ne regarde —' +
    ' ou une fusion : deux chemins qui n en font plus qu un laissent l un des deux' +
    ' orphelin. La cinquieme instance de cette famille (tickets) a vecu exactement la.');
  process.exit(1);
}
console.log(`  gardes du harnais : ${GARDES.length} chemins declares, tous traverses par les tables avant les sondes`);


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
  // Le POST rend le ticket de CETTE demande ; l'attente porte sur sa
  // publication (`scan_completed >= ticket`), pas sur le statut seul : un
  // `ready` peut être publié par une analyse en file qui a démarré AVANT la
  // demande — le même défaut que R15, côté harnais. Sans ticket dans la
  // réponse (serveur ancien), le repli reste le statut, faute de mieux.
  let ticket = null;
  try {
    const rep = await fetch(`${base}/api/scan/${lettre}`, { method: 'POST', headers: { 'X-Diskmap': '1' } });
    const corps = await rep.json().catch(() => null);
    if (rep.ok && corps && typeof corps.ticket === 'number') ticket = corps.ticket;
  } catch { /* le repli statut ci-dessous dira ce qu'il aura vu */ }
  const limite = Date.now() + limiteSecondes * 1000;
  let vu = null;
  while (Date.now() < limite) {
    const e = await etat(url);
    const d = e && (e.drives || []).find((x) => x.letter === lettre);
    if (d) vu = d;
    if (d && d.status === 'ready' && (ticket === null || d.scan_completed >= ticket)) {
      return { ...d, delai: false };
    }
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

  // Le releve des volumes alimente les planchers structurels. C est la seule
  // mesure de la machine dont le harnais dispose, et elle est juste ici.
  ENV.volumes = Math.max(1, faits.length);
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
  const sansRacine = retenues.filter((s) => s.volumeSecondaire);
  // La racine du volume secondaire n est demandee que par une sonde qui en a
  // besoin. La poser quand meme affichait, sur le runner, « le volume analyse
  // est E: » — E: n existe pas sur cette machine et aucune sonde n y
  // travaille. Le lecteur devait savoir que E: etait une valeur par defaut et
  // non un volume monte, pour dissipuer une note qui ne signalait rien. Une note
  // qu il faut decrypter avant de la lire est du bruit qui cache un vrai
  // defaut dans le meme paragraphe.
  const secondaire = sansRacine.length
    ? racinePour(opt.volumeSansCorbeille, false)
    : null;
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
  const connus = ['csrf', 'ui', 'perime', 'reversibilite', 'sans-corbeille', 'plafond',
    'mot-exige', 'palier', 'lot-cout', 'lot-coherence', 'suppression-reelle', 'tickets'];
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
  // HORS du `if (!url)` : une sonde a serveur dedie doit savoir ou trouver le
  // binaire meme quand l appelant fournit deja une URL. Un calcul de chemin, rien
  // de plus — le refus sur un binaire absent ou perime reste la ou il est.
  const binaire = opt.binaire || path.join(DEPOT, 'target', 'release', 'diskmap.exe');


  if (!url) {
    if (!fs.existsSync(binaire)) {
      console.error(`Binaire introuvable : ${binaire}`);
      // `--offline` compile depuis un cache chaud, et échoue sur une machine
      // qui n'a jamais construit le projet (`no matching package named
      // rayon`). Il ne doit pas être conseillé ici : le lecteur peut très bien
      // partir d'une copie fraîche du dépôt.
      console.error('Construis-le :  cargo build --release');
      process.exit(2);
    }
    // Un binaire plus ancien qu une source ne prouve RIEN. Le 27/09, cinq
    // sondes ont rouge sur une `SyntaxError` alors que le code etait correct :
    // l interface servie vient du binaire, qui embarque `ui/index.html` a la
    // compilation, et la derniere modification de l interface n avait pas ete
    // recompilee. Le symptome designait entierement le produit, et il n etait
    // pas dedans. Pire : un controle de syntaxe passe sur le fichier extrait du
    // depot, lui, alors que le navigateur lisait l ancien — deux fichiers de
    // meme nom et de contenu different, et rien ne le disait.
    //
    // En CI le risque n existe pas : `cargo build` y precede toujours les
    // sondes. En local, ou l application se teste a la main, si. Le harnais
    // refuse donc de partir, et nomme le fichier en cause — un refus qui ne dit
    // pas quoi corriger est un refus qu on contourne.
    const perime = plusRecentQue(binaire, [
      path.join(DEPOT, 'Cargo.toml'),
      path.join(DEPOT, 'Cargo.lock'),
      path.join(DEPOT, 'ui', 'index.html'),
      ...fs.readdirSync(path.join(DEPOT, 'src')).map((f) => path.join(DEPOT, 'src', f)),
    ]);
    if (perime) {
      console.error(`Le binaire eprouve est plus ancien que ${perime.fichier}.`);
      console.error('  Les sondes y mesureraient l interface d AVANT votre');
      console.error('  modification. Ce n est pas un echec de produit, et le');
      console.error('  laisser tourner reviendrait a mesurer la mauvaise version.');
      console.error('  Construis-le :  cargo build --release');
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
    // Une sonde qui ARRETE le serveur ne peut pas passer par le filet : le filet
    // relaierait `/api/quit` et tuerait le serveur des vingt sondes suivantes.
    // Ces sondes ont donc leur PROPRE serveur, sur un autre port, et ne sont pas
    // relayees.
    //
    // C'est la seule entree du filet, et elle est volontaire. Le filet existe pour
    // voir passer une suppression ; ces sondes n'en envoient aucune, et surtout
    // leur but EST d'arreter un serveur — le relayer tuerait l'instrument. Un
    // contournement declare vaut mieux qu'un contournement muet.
    let dedie = null;
    let urlDedi = urlProbes;
    if (s.serveurDedie) {
      const portDedi = (await portLibre(8811)) || 8811;
      const d = await demarrer(binaire, portDedi);
      dedie = d.processus;
      urlDedi = d.adresse.replace(/\/$/, '') + '/';
      console.log(`  serveur dedie pour « ${s.nom} » : ${urlDedi}`);
    }
    const args = s.args({ url: urlDedi, volume, volumeSansCorbeille: opt.volumeSansCorbeille });
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
    // La derniere ligne qui compte : « 8/8 verifications ». L'accent est
    // ACCEPTÉ dans les deux écritures : la regex ne portait que `verifications`,
    // et quatorze sondes sur seize écrivent `vérifications`. Elles affichaient
    // donc toutes « — » — le même tiret qu'une sonde morte avant la fin, alors
    // qu'elles venaient de faire vingt-sept vérifications. Un résumé qu'on ne
    // sait pas lire ne dit pas ce qu'il a couvert.
    const { compte, vide, muette, nOk, verdictsEcrits, descompteFaux, rougeEcrit } = compterSortie(sortie.tout);
    // Une sonde qui sort en 0 SANS avoir écrit son décompte n'a rien mesuré —
    // et la laisser verte est le pire des verdicts, parce qu'elle ne se
    // distingue d'une sonde MORTE que par un mot dans la colonne de droite.
    // `generation` est restée ainsi depuis son écriture : cinq vérifications,
    // toutes faites, toutes justes, jamais comptées, jamais lues. Le mot
    // signalait le symptôme depuis des mois, sans rien faire échouer : rien ne
    // pouvait donc le corriger. Une sonde muette est un échec, pas une note.
    //
    // Un resume « 0/0 » n est pas un resume : c'est le meme silence, dans
    // la seule ecriture que la garde ci-dessus laisse passer. La sonde a
    // annonce un compte — elle n a donc pas ete muette au sens de `SANS
    // SYNTHESE` — et ce compte vaut zero.
    //
    // Mesure avant d ecrire la regle, sur les vingt sondes d un run complet du
    // runner et les vingt-et-une du run local `--tout` (le 28/09/2026) : la
    // plus petite annonce 1/1 — `palier` — et les autres entre 3/3 et 38/38.
    // Aucune n annonce 0. La regle ne separe rien aujourd'hui — elle interdit
    // seulement ce qui passerait desormais.
    //
    // Et elle mord. Son epreuve : `generation` sort avant son premier
    // `verifier()`, en ecrivant « aucun cas a tester sur ce volume », puis
    // « 0/0 verifications vertes », puis sort en 0. Le harnais affichait
    // « vert generation 0/0 », « 1/1 sondes vertes », « aucune note » :
    // exactement la meme ligne qu une sonde de trente-huit verifications,
    // et son propre bilan certifiait le silence.
    //
    // Pourquoi rouge et non note. Une note, c est « ce volume ne peut pas me
    // montrer cela » — et c est legitime, c est meme ce que la sonde
    // `identifiant` fait depuis le 28/09. Ici ce n est pas le volume qui
    // decide : une sonde n a pas de jeu de cas, ou son jeu de cas est vide.
    // Cela se verifie, et cela se corrige. Si une sonde n a reellement rien a
    // tester sur un volume donne, elle doit VERIFIER qu elle n a rien a
    // tester — l absence est une mesure, comme le dit deja R10 pour le
    // support d une demonstration.
    // (ci-dessus, `compterSortie` a deja tranche : muette, vide, et le
    //  recoupement. Ce qui suit est le raisonnement qui a produit ces règles.)
    // Le resume doit etre un COMPTE FIDE des verdicts ecrits — les DEUX termes.
    // Sans cette arithmetique, la garde ci-dessus se laisse passer le cas qu elle
    // ne visait pas : une sonde qui ecrit son resume AVANT ses verifications
    // affiche un compte juste sur le papier et faux sur l ecran.
    //
    // Les deux termes, parce qu un seul ne suffit pas. Un resume ecrit d avance
    // et jamais repris donnerait « 5/5 » juste, tant que tout passe : le seul
    // denominateur ne voit rien. C est le numerateur qui revele qu on a retire
    // un ok, et c est le denominateur qui revele qu on a ajoute une
    // verification sans la compter.
    //
    // Le numerateur NE revele plus qu un verdict a rouge apres coup. Il le
    // pouvait, tant qu il coincidait avec le compte des lignes : un resume
    // « 4/5 » s accorde avec quatre ok et un ROUGE, et le recoupement passait.
    // C etait vrai le 30/09, et c etait faux des qu on l ecrit — le harnais
    // regarde maintenant les lignes ROUGE directement, dans `compterSortie`.
    //
    // Mesure avant d ecrire la regle, sur les vingt sondes d un run complet :
    // les vingt numerateurs egalaient le nombre de lignes `ok`, et les vingt
    // denominateurs le nombre de lignes `ok` + `ROUGE`. Aucun `vert` en tete
    // de ligne, donc ni l un ni l autre n entre dans le compte. La regle ne
    // separe rien aujourd hui — elle interdit seulement ce qui passerait
    // desormais.
    const descompte = muette || descompteFaux;
    // Un ROUGE ecrit, et une sortie en 0. Le resume est honnete, donc le
    // recoupement passe, et le ROUGE comble le plancher a la place d un ok
    // manquant : le controle des trois portes passe au complet.
    const mensonge = rougeEcrit && sortie.code === 0;
    let code = (descompte || mensonge) && sortie.code === 0 ? 1 : sortie.code;
    // `let`, et non `const` : deux verifiers ont le droit de rendre cette
    // sonde rouge apres coup — le decompte incoherent, et le plancher. Avec un
    // `const`, le second levait une TypeError et tuait le run au moment precis
    // ou il avait a parler. Mesure le 30/09 sur la CI : le message du plancher
    // s affichait, puis `TypeError: Assignment to constant variable`, et sept
    // sondes derriere n ont jamais tourne.
    const resume = compte ? `${compte[1]}/${compte[2]}` : 'SANS SYNTHESE';
    // (le plancher, lui, est calcule plus bas : apres les notes, parce que
    //  c est la qu on sait ce que la sonde dit ne pas avoir ecrit)
    // (le plancher est calcule plus bas, apres les notes : voir pourquoi)
    // Ce que les sondes NOTENT, et qui n'apparait sur aucun run vert.
    //
    // Le 28/09/2026, une sonde a porte « (+1 non mesurable) » a son resume, et
    // personne ne l'a su : le harnais n'affiche la sortie d une sonde qu en cas
    // d echec. Sur un run VERT, une note est donc invisible — ce qui rend le
    // « vert » indecent, et pire : on ne peut meme pas mesurer combien il y en
    // a. C est le meme angle mort que R12, vu par l autre bout. Mesure a la
    // premiere ligne qui compte : HUIT notes par run, reparties sur quatre
    // sondes, invisibles depuis toujours.
    //
    // Deux formes, parce que deux sondes ecrivent deja ainsi : le marqueur du
    // resume (`(+N non mesurable(s))`) et la ligne `note :` — une convention
    // etablie dans quatre sondes, qui dit parfois « rien a mesurer ici » et
    // parfois « le contrat lui-meme est une note ». D'ou le mot `note` plutot
    // que « non mesurable » : on ne.resize pas ce que la sonde a dit.
    //
    // Le TEXTE est retenu, pas seulement le nombre : un compteur seul dit
    // qu il y a un probleme sans dire lequel, et un diagnostic jete par l outil
    // cense l afficher est un diagnostic absent.
    const notes = collecterNotes(sortie.tout);
    // Le plancher, calcule ICI et pas plus tot : c est le seul endroit ou l on sait
    // a la fois ce que la sonde a reellement ecrit, verdict par verdict, ET ce
    // qu elle a dit n avoir pas ecrit.
    // Un plancher est un nombre, ou une fonction de l environnement. Dans les deux
    // cas il faut un NOMBRE a comparer — et il faut savoir lequel, sinon un
    // plancher fonctionnel rouge avec « undefined » dans le message.
    const brut = COMPTES_PLANCHER[s.nom];
    const plancherBrut = typeof brut === 'function' ? brut(ENV) : brut;
    // Le plancher se RELACHE d autant de verdicts que les trous structurels en
    // DECLARENT. Mesure le 30/09 : `plafond` ecrivait 6 verdicts ici et 3 sur le
    // runner, et son plancher fixe de 6 le faisait rougir a tort — un controle qui
    // ment sur ce qu il mesure. Le nombre de verdicts perdus ne se devine donc pas :
    // il se LIT dans le registre, la ou le trou se declare.
    // Un aveu nu ne detend RIEN, et un `structurel :` sans registre non plus : la
    // porte est etroite par construction, et une sonde ne peut pas acheter son
    // plancher — seulement declarer le trou qu elle a nomme.
    const { plancher, trous, dispense } = plancherEffectif(plancherBrut, notes);
    const perte = code === 0 && plancher !== undefined && verdictsEcrits < plancher;
    const mention = notes.length ? `  [!] ${notes.length} note(s)` : '';
    // Le compte des AVEUX, des la ligne de resume : une note d aveu non justifiee
    // doit se voir sur la ligne de la sonde, pas six pages plus loin.
    const aveux = notes.filter((n) => n.sorte !== 'explication');
    const aveuxNus = aveux.filter((n) => n.sorte === 'aveu nu');
    if (aveux.length) {
      const detail = aveux.length === 1 ? 'aveu' : 'aveux';
      const marques = aveuxNus.length ? ` dont ${aveuxNus.length} SANS JUSTIFICATION` : '';
      console.log(`           [${detail}] ${aveux.length} ${detail}${marques}`);
    }
    // Le code forcé NE REMPLACE PAS les deux autres verdicts. Une sonde qui n a
    // pas pu tourner — volume absent, prérequis manquant — sort en 2 sans
    // écrire de résumé, et doit rester « PAS PU » : la confondre avec un produit
    // en défaut enverrait chercher le défaut du mauvais côté.
    const etatMot = code === 0 ? 'vert ' : code === 2 ? 'PAS PU' : 'ROUGE';
    console.log(`  ${etatMot}  ${s.nom.padEnd(15)} ${resume}${mention}`);
    if (perte) {
      // Le message nomme le NOMBRE, pas seulement la faute : « des assertions ont
      // disparu » ne dit pas combien, et un plancher qu on ne peut pas chiffrer
      // ne se corrige pas.
      console.log(`           PLANCHER : ${s.nom} a ecrit ${verdictsEcrits} verification(s), son`);
      console.log(`           plancher est ${plancher}. Une sonde verte qui en ecrit moins a`);
      console.log('           perdu des assertions — et rien d autre dans ce depot ne le voit.');
      if (dispense) {
        console.log(`           RELÂCHE de ${dispense} : ${plancherBrut} moins ${trous.map((n) => n.couts).join(' plus ')} = ${plancher}`);
      }
      code = 1;
    }
    if (code !== 0 || aveuxNus.length) {
      // Ce que la sonde a DIT, pas seulement les lignes qui ressemblent a un
      // motif. Le filtre d’avant guts le cas le plus difficile : une sonde qui
      // PLANTE n’ecrit aucun motif, elle sort en 1 — et le journal de la CI disait
      // alors « ROUGE palier » sans une seule ligne de raison. C’est ce qui
      // s’est passé le 27/09/2026 : `sonde-palier.mjs` lisait `t.rows` d’un volume non
      // monté, et rien ne le disait. La FIN de la sortie est ce qu’il faut voir :
      // c’est là que se trouve la pile d’appel.
      const lignes = sortie.tout.split(/\r?\n/).map((l) => l.trim())
        .filter((l) => l);
      // Les VERDICTS ROUGES, ou qu ils soient dans la sortie. La fin de la
      // sortie est ce qu il faut voir quand une sonde PLANTE — la pile d
      // appel est en dernier — mais une sonde qui verifie quarante choses et
      // rouge a la troisieme n a plus rien a dire en vingt-quatre lignes.
      // Le 27/09, la sonde d interface a rouge sur un clic qui n avait pas
      // navigue, et le journal n en montrait que l ETAT SOIXANTE SECONDES
      // PLUS TARD : un dossier qui n a rien a voir avec la sonde. Un diagnostic
      // jete par l outil censé l afficher est un diagnostic absent — c est la
      // troisieme fois de la journee, apres la fenetre de 400 resultats et le
      // `node --check` porte sur un fichier perime.
      const rouges = [];
      for (let i = 0; i < lignes.length; i++) {
        if (!/^ROUGE\b/.test(lignes[i])) continue;
        rouges.push(lignes[i]);
        // La mesure est la ligne suivante, quand elle existe : sans elle, un
        // echec ne dit pas ce qui a ete mesure.
        if (lignes[i + 1] && /^mesur/.test(lignes[i + 1])) rouges.push(lignes[i + 1]);
      }
      const uniques = [...new Set(rouges)].slice(0, 14);
      if (uniques.length) {
        console.log(`           verdicts rouges (${uniques.length > 14 ? '14 premiers' : 'tous'}) :`);
        for (const l of uniques) console.log(`           ${l}`);
      }
      // Une sonde muette n aura aucun « ROUGE » à montrer : ce qu elle a fait
      // est justement invisible. Sans ce mot, le journal afficherait un rouge
      // muet, et le même défaut qu elle est censée signaler. Réservé au cas
      // forcé : une sonde « PAS PU » n a pas de synthèse parce qu elle n a rien
      // fait, et son raison est déjà plus haut.
      if ((descompte || mensonge) && code === 1) {
        if (vide) {
          console.log('           resume vide : la sonde annonce 0/0 verification, donc elle n en a');
          console.log('           fait aucune. « Je n avais rien a tester » n est pas une mesure :');
          console.log('           sur un volume qui ne donne rien, c est cela qu il faut verifier.');
        } else if (muette) {
          console.log('           aucun decompte ecrit : la sonde n a rien rapporte, donc rien ne prouve');
          console.log('           qu elle a verifie quoi que ce soit.');
        } else if (mensonge) {
          console.log(`           la sonde a ecrit un ROUGE et est sortie en 0 : elle annonce`);
          console.log(`           ${compte[1]}/${compte[2]}, et c est coherent. C est son code de`);
          console.log('           sortie qui aurait du la rougir, et rien d autre ne le voit.');
        } else {
          console.log(`           decompte incoherent : la sonde annonce ${compte[1]}/${compte[2]},`);
          console.log(`           et a ecrit ${nOk} ok et ${verdictsEcrits - nOk} ROUGE. Un resume`);
          console.log('           ecrit avant les verifications, ou jamais repris apres un echec, se lit ici.');
        }
      }
      for (const l of lignes.slice(-24)) console.log(`           ${l}`);
    }
    // Le serveur dedi est rendu meme si la sonde a echoue : un run interrompu
    // laisserait un processus qui scanne, et le harnais ne verrait plus pourquoi.
    if (dedie) {
      try { dedie.kill(); } catch { /* deja mort : c'est meme ce qu on attendait */ }
      dedie = null;
    }
    resultats.push({ nom: s.nom, code, resume, notes, plancher, plancherBrut, trous, ecrit: verdictsEcrits });
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
// Les notes, meme vertes. Une ligne de plus, qui ne disparait jamais : tant
// qu elle n existe pas, on ne sait pas si le probleme existe. Et le texte
// suit, parce qu'un compte sans dire de quoi n'apprend rien.
const notees = resultats.filter((r) => r.notes && r.notes.length);
if (notees.length) {
  const total = notees.reduce((n, r) => n + r.notes.length, 0);
  console.log(`  ${total} note(s) de ${notees.length} sonde(s) — rien n'est masque derriere un vert :`);
  for (const r of notees) {
    for (const n of r.notes) {
      const tag = n.sorte === 'explication' ? 'note' : `AVEU ${n.sorte.replace('aveu ', '')}`;
      console.log(`           ${r.nom} [${tag}] ${n.texte}`);
      if (n.sorte !== 'explication') console.log(`                    -> ${n.mesure}`);
    }
  }
} else {
  console.log('  aucune note');
}

// Le registre des AVEUX, et le plancher. Le compte est affiche meme quand il
// n est pas nul : un trou structurel declare est une dette, et une dette
// qu on ne recompte pas est une dette qu on oublie.
const tousAveux = resultats.flatMap((r) => (r.notes || [])
  .filter((n) => n.sorte !== 'explication').map((n) => ({ ...n, sonde: r.nom })));
const aveuxNus = tousAveux.filter((n) => n.sorte === 'aveu nu');
const structurels = tousAveux.filter((n) => n.sorte === 'aveu structurel');
const couverts = tousAveux.filter((n) => n.sorte === 'aveu couvert');
console.log(`  aveux : ${tousAveux.length} — ${couverts.length} couvert(s) par une assertion, `
  + `${structurels.length} structurel(s) declare(s), ${aveuxNus.length} SANS JUSTIFICATION`);
if (structurels.length) {
  console.log('           registre : un trou structurel n est pas une excuse, c est une dette ecrit');
  for (const n of structurels) console.log(`           - ${n.sonde} : ${n.mesure}`);
}
if (aveuxNus.length) {
  console.log(`  AVEUX SANS JUSTIFICATION : ${aveuxNus.length} — le run est ROUGE`);
  console.log('    Un aveu qui ne dit ni qui le couvre, ni pourquoi il est structurel, n est');
  console.log('    qu une excuse : il disparait au run suivant et le vert ne dit plus rien.');
  console.log('    Deux formes acceptees : « couvert par <fichier> : <nom de verification> »');
  console.log('    ou « structurel : <raison> », cette derniere devant figurer au registre.');
  for (const n of aveuxNus) console.log(`    - ${n.sonde} : ${n.texte}\n      -> ${n.mesure}`);
}
if (pasPu.length) console.log(`  PAS PU EPROUVER : ${pasPu.map((r) => r.nom).join(', ')}`);

// Le plancher, une derniere fois. Trois faits, dans l ordre de ce qu ils
// interdent : un plancher qui ne nomme plus de sonde (renommage, donc garde
// morte), une sonde VERTE sans plancher (donc sans rien dire quand elle perd une
// assertion), et la couverture — combien de sondes en ont un. Les trois sont
// des mesures, pas des intentions : le troisieme est ce qui permet de voir la
// suite plutot que de la supposer couverte.
if (sansSonde.length) {
  console.log(`  PLANCHER ROUGE : ${sansSonde.length} plancher(s) sans sonde — ${sansSonde.join(', ')}`);
  console.log('    Une sonde renommee laisse son plancher derriere : il ne rend plus');
  console.log('    jamais, et rien ne le signale. Corriger le nom, ou retirer le plancher.');
}
const vertes = resultats.filter((r) => r.code === 0);
const sansPlancher = vertes.filter((r) => r.plancher === undefined).map((r) => r.nom);
const avecPlancher = vertes.filter((r) => r.plancher !== undefined).length;
if (sansPlancher.length) {
  console.log(`  ${avecPlancher}/${vertes.length} sondes vertes ont un plancher ; sans plancher :`);
  console.log(`           ${sansPlancher.join(', ')} — une assertion perdue dans ces sondes ne`);
  console.log('           rougirait rien. C est un choix, il doit etre visible.');
} else {
  console.log(`  plancher : ${avecPlancher}/${vertes.length} sondes vertes gardees, aucune sans`);
}

// Les planchers RELACHES, eux, sont une dette comme les autres : ils se
// recomptent a chaque run, avec le trou qui les a detendus et le nombre de
// verdicts qu il a coute. Un plancher elargi en silence redeviendrait un
// plancher que personne ne surveille.
const relaches = resultats.filter((r) => r.trous && r.trous.length);
if (relaches.length) {
  console.log(`  PLANCHERS RELACHES : ${relaches.length} — chaque ligne est un trou structurel declare, donc ecrit, donc discutable`);
  for (const r of relaches) {
    for (const t of r.trous) {
      console.log(`    - ${r.nom} : ${r.plancherBrut} - ${t.couts} = ${r.plancher} (${t.motif})`);
    }
  }
}

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

// Trois sorties dures devenaient un seul code : rouge 1, « pas pu
// eprouver » 2, sinon 0. Le harnais n a plus de coupure au milieu de sa
// propre sortie -- c est lui aussi un processus qui a des sockets.
process.exitCode = rouges.length ? 1 : (pasPu.length ? 2 : 0);
if (sansSonde.length) process.exitCode = 1;
if (aveuxNus.length) process.exitCode = 1;
