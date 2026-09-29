// Épreuves de morsure : une garde jamais neutralisée n'est pas une garde, c'est
// une intention.
//
// Ce que fait ce script, dans cet ordre, et jamais autrement :
//
//   1. REFUSE de partir sur un arbre sale. La restauration réécrit un fichier du
//      dépôt : sur un arbre sale, elle écraserait du travail qui n'est pas le
//      sien. Un outil qui abîme le dépôt pour produire une mesure n'est pas un
//      outil de mesure.
//   2. Neutralise UNE garde, compile, et lance la sonde qui doit la prouver.
//   3. EXIGE que la sonde passe au rouge. Une épreuve qui ne mord pas n'est pas
//      un résultat : c'est l'échec du script. Le 29/09, la vérification de
//      `arret-running` passait quelle que soit la garde — elle ne pouvait pas
//      rougir — et rien ne l'avait vu tant qu'on n'a pas neutralisé.
//   4. Restaure, recompile, exige de nouveau le vert.
//
// La restauration est dans un `finally` : un build cassé, une sonde qui plante,
// un Ctrl+C — rien ne doit laisser le dépôt sur une garde morte.
//
// Ce script ne committe rien et ne pousse rien. Il mesure une garde, il ne la
// change pas. En CI il n'a pas sa place : deux compilations par épreuve, et un
// code volontairement cassé au milieu du run.
//
// Usage :
//   node tests/sondes/epreuve.mjs              toutes les épreuves du catalogue
//   node tests/sondes/epreuve.mjs scan-running une seule

import { spawn, execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import net from 'net';
import { fileURLToPath } from 'url';

// `fileURLToPath` et non `URL.pathname` : sur Windows, le second rend `/G:/…`,
// et un chemin contenant un espace arrive percent-encodé. Les deux se voient au
// moment où une sonde ne trouve plus son fichier — jamais avant.
const ICI = path.dirname(fileURLToPath(import.meta.url));
const DEPOT = path.resolve(ICI, '..', '..');

/**
 * Le catalogue. Chaque entrée dit QUOI neutraliser, QUELLE sonde doit le sentir,
 * et ce que la mesure doit montrer ensuite — parce que « rouge » ne suffit pas :
 * une sonde qui rougit pour une autre raison ne prouve pas cette garde.
 */
const EPREUVES = [
  {
    nom: 'scan-running',
    quoi: 'la publication du numéro d’analyse en vol',
    fichier: 'src/main.rs',
    avant: '    ds.scan_running = ticket;',
    apres: '    ds.scan_running = 0; // NEUTRALISE POUR L EPREUVE',
    sonde: 'sonde-arret.mjs',
    args: ['running'],
    // Le constat ou la cause racine que cette épreuve rattache. C'est ce qui
    // permet à `verifier-preuves.mjs` de compter ce qui est prouvé, sans
    // recompter les gardes ni croiser des codes HTTP.
    preuve: 'R15',
    // Neutralisée, l'écran affiche « analyse en cours… » sans numéro : c'est
    // le signe que le serveur analyse et ne dit pas laquelle.
    mesure: /analyse en cours…/,
    pourquoi:
      'Une application qui n annonce pas QUELLE analyse elle attend laisse '
      + "l'utilisateur devant un texte identique à celui de la précédente. "
      + 'Si `arret-running` passait malgré cette neutralisation, sa vérification '
      + 'serait décorative.',
  },
  {
    nom: 'generation',
    quoi: 'le refus 409 sur une génération d’instantané périmée',
    fichier: 'src/main.rs',
    avant: '            if gen_vue != snap.gen {',
    apres: '            if false && gen_vue != snap.gen { // NEUTRALISE POUR L EPREUVE',
    sonde: 'sonde-generation.mjs',
    args: ['V'],
    // La garde de génération EST la cause racine de l'incident du 26/09 : c'est
    // elle qui empêche qu'un sélecteur périmé désigne un autre fichier.
    preuve: '3.1',
    // La mesure exigée est le STATUT, pas le chemin visé. La première version
    // exigeait « RECYCLE.BIN » : le sélecteur périmé tombe bien sur un fichier
    // qui n'est pas p2.txt — mais LEQUEL dépend du contenu de la corbeille au
    // moment du run, et un passage est tombé sur « (rien) ». L'épreuve se
    // déclarait alors non mordante, à tort, et pour une raison étrangère à la
    // garde. Une mesure qui varie n'est pas une mesure.
    //
    // Le statut, lui, ne varie pas : 409 quand la garde tient, 200 quand elle a
    // cédé et que l'aperçu passe.
    mesure: /périmée\) : HTTP 200/,
    pourquoi:
      "C'est le garde-fou de l'incident du 26/09/2026 : un sélecteur périmé "
      + "désignait alors un autre fichier, jamais montré, et supprimable. "
      + "L'épreuve exige le STATUT — 409 quand la garde tient, 200 quand elle a "
      + 'cédé — et non le chemin visé : celui-ci dépend du contenu de la corbeille '
      + "et change d'un run à l'autre. Exiger une mesure instable ferait "
      + "échouer l'épreuve pour une raison étrangère à la garde.",
  },
  {
    nom: 'x-diskmap',
    quoi: "l'en-tête X-Diskmap exigé sur toute requête qui modifie",
    fichier: 'src/main.rs',
    avant: '    if method == "POST" && action != "1" {',
    apres: '    if false && method == "POST" && action != "1" { // NEUTRALISE POUR L EPREUVE',
    sonde: 'sonde-host.mjs',
    args: [],
    // La LIGNE ROUGE, pas son libellé seul : « → refusé » figure aussi dans les
    // lignes `ok` du run normal. La preuve, c'est ROUGE ET le libellé, même ligne.
    mesure: new RegExp('ROUGE[^' + String.fromCharCode(10) + ']*refusé'),
    preuve: '3.2',
    pourquoi:
      "Une page web tierce efface un fichier sans confirmation si cette garde "
      + 'tombe — mesuré dans un vrai navigateur le 26/09/2026, trois fois sur trois. '
      + "L'épreuve passe par `sonde-host` et NON par la sonde CSRF, et l'écart "
      + "vaut d'être noté : avec le navigateur, la garde neutralisée laissait 12/12 "
      + 'au vert. Le navigateur bloque déjà la requête de lui-même — un en-tête '
      + 'personnalisé déclenche un préflight, et le serveur n en sert aucun. Cette '
      + 'garde est donc une SECONDE défense, et une épreuve par navigateur ne peut '
      + 'pas la morser : elle mesure le navigateur. Une requête directe, elle, ne '
      + 'passe par aucun des deux.',
  },
];

// ------------------------------------------------------------------ outillage

const dire = (t) => console.log(t);
let echecs = 0;
const notes = [];

function refuser(t) {
  console.error(`\n  REFUS   ${t}\n`);
  process.exit(2);
}

function refuserSiSale() {
  let sortie = '';
  try {
    sortie = execFileSync('git', ['status', '--porcelain'], { cwd: DEPOT, encoding: 'utf8' });
  } catch (e) {
    refuser(`git n'a pas répondu : ${e.message}`);
  }
  const lignes = sortie.split('\n').filter(Boolean);
  if (lignes.length) {
    console.error('\n  REFUS   le dépôt n\'est pas propre, et cette épreuve réécrit des fichiers :\n');
    for (const l of lignes.slice(0, 12)) console.error(`    ${l}`);
    if (lignes.length > 12) console.error(`    … et ${lignes.length - 12} autre(s)`);
    console.error('\n  Committe, ou passe en lecture seule : une restauration écraserait ton travail.\n');
    process.exit(2);
  }
}

function portLibre() {
  return new Promise((resoudre) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resoudre(p));
    });
  });
}

function compiler() {
  try {
    execFileSync('cargo', ['build', '--release'], { cwd: DEPOT, stdio: 'pipe' });
  } catch (e) {
    // La sortie de cargo est ici décisive : une garde neutralisée peut ne plus
    // compiler, et ce n'est PAS la même chose qu'une sonde qui ne mord pas.
    const sortie = `${e.stdout || ''}${e.stderr || ''}`.split('\n').slice(-12).join('\n');
    // « Accès refusé » sur le binaire n'est pas une erreur de compilation : c'est
    // une instance qui le tient ouvert. Les deux finissent par un message de cargo
    // et une fin de course, et les confondre envoie chercher une panne dans le
    // code alors qu'il n'y en a pas. Le harnais sait déjà le dire ; cet outil
    // avait le même angle mort.
    if (/Acc[eè]s refus|os error 5|being used by another process/i.test(sortie)) {
      throw new Error('le binaire est ouvert par une instance de diskmap — ferme-la,'
        + ' puis relance. Ce n\'est pas une erreur de compilation.\n' + sortie);
    }
    throw new Error(`le binaire ne compile plus :\n${sortie}`);
  }
}

async function demarrer(binaire, port) {
  const p = spawn(binaire, ['--port', String(port), '--no-browser'], {
    cwd: DEPOT, windowsHide: true,
  });
  let sortie = '';
  p.stdout.on('data', (d) => { sortie += d.toString(); });
  p.stderr.on('data', (d) => { sortie += d.toString(); });

  const limite = Date.now() + 30_000;
  while (Date.now() < limite) {
    if (/Espace disque\s*:\s*(\S+)/.test(sortie)) {
      return { processus: p, adresse: sortie.match(/Espace disque\s*:\s*(\S+)/)[1] };
    }
    if (p.exitCode !== null) {
      throw new Error(`le binaire s'est arrêté (code ${p.exitCode}) :\n${sortie}`);
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  p.kill();
  throw new Error(`le binaire n'a pas annoncé d'adresse en 30 s :\n${sortie}`);
}

async function mesurer(ep, binaire) {
  const port = await portLibre();
  const { processus, adresse } = await demarrer(binaire, port);
  try {
    const sortie = await new Promise((resoudre) => {
      const p = spawn(process.execPath, [path.join(ICI, ep.sonde), adresse, ...ep.args],
        { cwd: ICI, windowsHide: true });
      let tout = '';
      p.stdout.on('data', (d) => { tout += d.toString(); });
      p.stderr.on('data', (d) => { tout += d.toString(); });
      p.on('close', (code) => resoudre({ code, tout }));
    });
    return sortie;
  } finally {
    try { processus.kill(); } catch { /* déjà mort : c'est même l'effet recherché */ }
    await new Promise((r) => setTimeout(r, 300));
  }
}

// -------------------------------------------------------------------- moteur

/**
 * Une épreuve = quatre mesures. Le ROUGE est exigé, le VERT aussi : une garde
 * qui rend l'application inutilisable ne protège personne.
 */
async function eprouver(ep, binaire) {
  dire(`\n--- ${ep.nom} : ${ep.quoi} ---`);
  dire(`  ${ep.pourquoi}\n`);

  const chemin = path.join(DEPOT, ep.fichier);
  const original = fs.readFileSync(chemin, 'utf8');
  const n = original.split(ep.avant).length - 1;
  if (n !== 1) {
    throw new Error(`${ep.fichier} : « ${ep.avant.trim()} » trouvé ${n} fois, attendu 1.`
      + ' Une garde qu on ne sait plus nommer n est pas une garde.');
  }

  let neutralisee;
  try {
    fs.writeFileSync(chemin, original.replace(ep.avant, ep.apres));
    // LA COMPILATION ICI, et pas plus tard. Sans elle, on mesure l'ancien
    // binaire et l épreuve « passe » : c'est ce que fait la première version de
    // ce fichier, et les deux gardes sont alors declarées non mordantes alors
    // qu elles mordent. Un test qui mesure l objet d avant la modification ne
    // mesure rien — il constate qu on n a rien fait.
    compiler();
    neutralisee = await mesurer(ep, binaire);
  } finally {
    // Toujours, même sur une exception : le dépôt ne doit jamais sortir d'ici
    // avec une garde morte.
    fs.writeFileSync(chemin, original);
    compiler();
  }

  const compte = neutralisee.tout.match(/(\d+)\/(\d+)\s+v[ée]rifications/);
  const rouge = /ROUGE/.test(neutralisee.tout);
  const mesureVoulue = ep.mesure.test(neutralisee.tout);

  dire(`  neutralisée : ${compte ? `${compte[1]}/${compte[2]}` : 'aucun décompte'}`
    + `, code ${neutralisee.code}, ${rouge ? 'ROUGE' : '… VERT'}`);
  if (rouge && !mesureVoulue) {
    dire('    ATTENTION : rouge, mais la mesure attendue est absente —'
      + ' la sonde a pu rougir pour une autre raison.');
  }

  const restauree = await mesurer(ep, binaire);
  const compte2 = restauree.tout.match(/(\d+)\/(\d+)\s+v[ée]rifications/);
  dire(`  restaurée  : ${compte2 ? `${compte2[1]}/${compte2[2]}` : 'aucun décompte'}`
    + `, code ${restauree.code}`);

  // Le ROUGE est exigé, la MESURE attendue est exigée, le VERT après
  // restauration est exigé. Trois exigences : c'est ce qui sépare une épreuve
  // d'une démonstration.
  const morsure = rouge && mesureVoulue && neutralisee.code !== 0;
  const revenu = restauree.code === 0;
  if (!morsure) echecs++;
  if (!revenu) echecs++;

  for (const l of neutralisee.tout.split(/\r?\n/).filter((x) => /ROUGE|mesuré/.test(x))) {
    dire(`    ${l.trim()}`);
  }
  if (rouge && !mesureVoulue) notes.push(`${ep.nom} : rouge sans la mesure attendue`);

  return { morsure, revenu };
}

// ------------------------------------------------------------------- marche

refuserSiSale();
const demandees = process.argv.slice(2);
const retenues = EPREUVES.filter((e) => !demandees.length || demandees.includes(e.nom));
if (!retenues.length) {
  refuser(`aucune épreuve ne porte ces noms : ${demandees.join(', ')}.\n`
    + `  disponibles : ${EPREUVES.map((e) => e.nom).join(', ')}`);
}

const binaire = path.join(DEPOT, 'target', 'release', 'diskmap.exe');
if (!fs.existsSync(binaire)) {
  refuser(`binaire introuvable : ${binaire}\n  Construis-le :  cargo build --release`);
}

console.log(`  ${retenues.length} épreuve(s) · binaire ${binaire}`);
compiler();

for (const ep of retenues) {
  try {
    await eprouver(ep, binaire);
  } catch (e) {
    echecs++;
    console.log(`\n  ÉCHEC    ${ep.nom} — ${e.message}`);
    // Le `finally` de `eprouver` a déjà restauré. On ne continue pas : les
    // épreuves suivantes partiraient d'un binaire qu'on ne sait plus situer.
    break;
  }
}

console.log('');
if (notes.length) {
  console.log(`  ${notes.length} réserve(s) :`);
  for (const n of notes) console.log(`    - ${n}`);
}
console.log(echecs
  ? `  ${echecs} point(s) en échec — une garde qui ne mord pas est aussi un échec`
  : `  ${retenues.length} épreuve(s) : la garde mord, et l'application revient`);

// Un dépôt propre après l'épreuve est une EXIGENCE, pas un bonus : on le vérifie.
let residuel = '';
try {
  residuel = execFileSync('git', ['status', '--porcelain'], { cwd: DEPOT, encoding: 'utf8' }).trim();
} catch { /* git a déjà parlé */ }
if (residuel) {
  console.error(`\n  RÉSIDU   le dépôt n'est pas revenu propre :\n${residuel}`);
  process.exitCode = 1;
}

process.exitCode = echecs ? 1 : 0;
