// Un dossier affiché doit rester LE dossier qu'on a choisi, et sa disparition
// doit être dite.
//
// Ce que la sonde du 27/09 a etabli sans que rien ne le dise : l'interface
// épinglait le dossier courant par un NUMERO, et redemandait ce numéro après
// chaque analyse. Un numéro est une POSITION dans l'instantané, et la position
// bouge dès qu'un dossier apparaît ou disparaît ailleurs sur le volume. Mesuré
// sur le runner : l'identifiant 8 est passé du dossier de la sonde au dépôt
// GitHub entre deux analyses, et l'écran a suivi sans un mot.
//
// Deux propriétés, donc :
//
//  1. après une réanalyse, l'écran montre TOUJOURS le dossier choisi ;
//  2. si ce dossier a disparu, l'écran le DIT et remonte d'un cran — il ne
//     montre surtout pas un autre dossier à sa place.
//
// La deuxième est celle qui compte dans un outil qui supprime : un écran qui
// change de cible sans le dire, c'est une suppression qui vise autre chose.
//
// CE QUI LA REND NON VACANTE
// --------------------------
// Une sonde qui passe toujours ne prouve rien. Ici le support est mesuré :
// l'identifiant du dossier est relevé avant et après la réanalyse, et le verdict
// dit ce qu'il a vu. Le cas « les identifiants n'ont pas bougé » dépend du
// volume — un volume calme les garde — et le verdict le dit plutôt que de
// feindre une preuve. Le cas déterministe, lui, est écrit en Rust :
// `un_chemin_retrouve_le_dossier_apres_une_reanalyse` construit deux analyses
// dont les numéros sont redistribués et exige le même dossier pour le même
// chemin.
//
// Usage : node sonde-identifiant.mjs http://127.0.0.1:8990/ V
import fs from 'fs';

import { chromium, suivreRequetes } from './navigateur.mjs';
import { dossier, racine, URL_DEFAUT, VOLUME_DEFAUT } from './config.mjs';

const BASE = (process.argv[2] || URL_DEFAUT).replace(/\/$/, '');
const VOL = (process.argv[3] || VOLUME_DEFAUT).toUpperCase();
const H = { 'X-Diskmap': '1' };
const DOSSIER = dossier(VOL, 'sonde-identifiant');
const CIBLE = `${DOSSIER}/cible`;
// Le remplissage vit DANS la racine de travail, et non à la racine du volume.
//
// Mesuré le 28/09/2026, sur le runner : à la racine du volume, il n'a pas
// déplacé l'identifiant — `10 -> 10` — et la sonde a rougi. La raison est
// dans `src/scan.rs` : la lecture des entrées est un `read_dir` SANS tri
// (`fs::read_dir`, ligne 977). L'ordre est celui du système de fichiers, il
// n'est pas le nôtre, et un dossier racine créé après coup peut se retrouver
// après `_diskmap_sondes` comme avant, selon le volume.
//
// À l'intérieur de la racine de travail, le remplissage dispute la position au
// dossier de la sonde DANS LE MÊME parent : le décalage devient quasi certain
// au lieu d'être tiré à pile ou face. Et le ménage vient avec la racine, au
// lieu d'un dossier qu'il fallait se  nettoyer à la racine du volume.
const REMPLISSAGE = `${racine(VOL)}/remplissage-identifiant`;
const REMPLISSAGE_N = 300;

const verifs = [], echecs = [];
// Ce que la sonde n'a pas PU demontrer, et qui doit se voir au resume : une
// demonstration absente ne se declare pas verte en silence (meme reflexe que
// R12 pour une sonde muette).
const nonMesurables = [];
function verifier(nom, cond, mesure) {
  const ok = !!cond; verifs.push(ok);
  if (!ok) echecs.push(`${nom} — mesuré : ${mesure}`);
  console.log(`${ok ? 'ok   ' : 'ROUGE'} ${nom}${ok ? '' : `\n      mesuré : ${mesure}`}`);
}
const info = (m) => console.log(`      ${m}`);
// Ce que le navigateur ecrit pour une reponse 404, quel que soit le chemin.
// La forme vient de Chromium et peut donc changer : le filtre echoue BRUYAMMENT
// si le texte change plutot que de laisser passer une erreur par defaut.
const ATTENDU_404 = /status of 404/;

const etat = async () => (await fetch(`${BASE}/api/state`)).json();
// Le corps d une erreur est du TEXTE, pas du JSON : un 404 doit se lire comme
// un 404. Sans cela la sonde explose sur une `SyntaxError` de lecture, et le
// journal cesse de dire quoi que ce soit du dossier — la panne qui ne se montre
// qu au moment ou la sonde reussit enfin.
const arbre = async (chemin) => {
  const r = await fetch(
    `${BASE}/api/tree?drive=${VOL}&chemin=${encodeURIComponent(chemin)}`, { headers: H });
  if (!r.ok) return { erreur: r.status, texte: (await r.text()).trim() };
  return r.json();
};

// L'instantané ne porte pas de numéro de génération : il porte `finished_ms`,
// qui change à chaque analyse terminée. Attendre « !scanning » ne suffirait pas
// — c'est satisfait AVANT que l'analyse démarre, et la mesure porterait alors sur
// l'instantané d'avant. C'est l'erreur que la sonde `recherche` faisait le
// 27/09 ; elle se voyait parce qu'elle passait seule et tombait au harnais.
async function attendreReanalyse(avant) {
  for (let i = 0; i < 800; i++) {
    const s = await etat();
    const d = (s.drives || []).find((x) => x.letter === VOL);
    if (d && d.status === 'ready' && !s.scanning && (d.finished_ms || 0) !== avant) return d;
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}
const scanner = async () => {
  const s = await etat();
  const d = (s.drives || []).find((x) => x.letter === VOL);
  return (d && d.finished_ms) || 0;
};

// Le premier palier a cliquer depuis la racine du volume : le dossier de travail
// des sondes. Il se deduit de DOSSIER plutot que d etre ecrit en dur, comme le
// fait racine() dans config.mjs depuis le 27/09.
const racineDuVolume = () => DOSSIER.split('/').slice(0, 2).pop();

console.log(`--- ${VOL}: — un dossier affiché doit survivre à la réanalyse ---`);

fs.mkdirSync(`${CIBLE}`, { recursive: true });
fs.writeFileSync(`${CIBLE}/un.txt`, 'un');
fs.writeFileSync(`${CIBLE}/deux.txt`, 'de');
const fini0 = await scanner();
await fetch(`${BASE}/api/scan/${VOL}`, { method: 'POST', headers: H });
verifier('l’analyse de départ a bien eu lieu', !!(await attendreReanalyse(fini0)),
  `finished_ms toujours ${fini0}`);

const nav = await chromium.launch();
const page = await nav.newPage();
const erreurs = [];
page.on('pageerror', (e) => erreurs.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') erreurs.push(m.text()); });
// Le reseau aussi : c'est par la que « Failed to fetch » entrait sans que rien
// ne dise quelle requete avait disparu.
const suivi = suivreRequetes(page, nav);

try {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  // Controle du collecteur : sans lui, le verdict reseau du dessous serait un
  // rapport de trous — vrai par defaut, incapable de rougir.
  const ctl = await suivi.control();
  verifier('le collecteur voit une requete morte (controle)', ctl.vu, ctl.mesure);
  await page.evaluate((l) => select(l), VOL);
  await page.waitForFunction(() => document.querySelectorAll('#rows tr .nm').length > 0,
    null, { timeout: 60000 });

  // La navigation se fait en CLIQUANT, comme une personne : c'est le geste qu'on
  // éprouve, pas un appel interne.
  //
  // Et un échec de navigation RAPPORTÉ, pas une exception : une sonde qui plante
  // sur un délai d'attente dit « Timeout » au journal, et rien du dossier affiché.
  // Le 27/09, deux sondes ont Peri exactement ainsi, et le diagnostic de l'une
  // decrivait un ecran qu elle ne regardait pas. Une navigation qui n aboutit pas
  // EST la mesure : elle se dit.
  const cliquer = async (nom) => {
    const ligne = page.locator('#rows tr')
      .filter({ has: page.getByText(nom, { exact: true }) }).first();
    try {
      await ligne.locator('.nm').waitFor({ state: 'visible', timeout: 60000 });
      await ligne.locator('.nm').click();
      await page.waitForFunction(
        (n) => (document.querySelector('#crumbs')?.textContent ?? '').includes(n),
        nom, { timeout: 60000 });
      return true;
    } catch {
      return false;
    }
  };
  // Trois paliers, pas deux : le dossier de la sonde vit sous la RACINE de
  // travail, et la racine du VOLUME ne contient que celle-ci. Cliquer le nom du
  // dossier de la sonde depuis la racine du volume n aurait rien trouve — et
  // l attente aurait expire sur un detail de l arbre, ce qui se lit comme un
  // defaut de produit alors que c en est un de sonde.
  let atteint = true;
  for (const nom of [racineDuVolume(), 'sonde-identifiant', 'cible']) {
    if (!(await cliquer(nom))) {
      atteint = false;
      info(`palier non atteint : ${nom}`);
      break;
    }
  }
  verifier('la navigation entre dans le dossier de la sonde', atteint,
    `fil = ${JSON.stringify(await page.textContent('#crumbs').catch(() => ''))} · `
    + `lignes = ${JSON.stringify(await page.$$eval('#rows tr .nm',
      (ns) => ns.map((n) => n.textContent)).catch(() => []))}`);

  const filAriane = () => page.textContent('#crumbs').catch(() => '');
  const nomLignes = () => page.$$eval('#rows tr .nm', (ns) => ns.map((n) => n.textContent));
  const attendu = await filAriane();
  const lignesAvant = await nomLignes();
  const a1 = await arbre(CIBLE);
verifier("le dossier de la sonde est dans l'instantané", !a1.erreur,
  a1.erreur ? `${a1.erreur} ${a1.texte}` : '');
const idAvant = a1.path.at(-1).id;
  info(`dossier choisi : ${JSON.stringify(attendu)} · lignes ${JSON.stringify(lignesAvant)}`);
  info(`identifiant du dossier : ${idAvant}`);

  if (atteint) {

  // On déplace les identifiants : 300 dossiers à la RACINE du volume de travail,
  // donc en amont de tout le reste dans le numérotage. Puis on relance une
  // analyse — comme le fait l'application après une suppression.
  for (let i = 0; i < REMPLISSAGE_N; i++) fs.mkdirSync(`${REMPLISSAGE}/r${i}`, { recursive: true });
  const finiAvant = await scanner();
  await fetch(`${BASE}/api/scan/${VOL}`, { method: 'POST', headers: H });
  const d = await attendreReanalyse(finiAvant);
  verifier('la réanalyse a bien eu lieu', !!d,
    d ? `${finiAvant} -> ${d.finished_ms}` : `finished_ms toujours ${finiAvant}`);

  // PROVOQUER le rechargement, et le mesurer.
  //
  // L'interface ne recharge l'arbre que si elle voit une analyse en cours — sa
  // veille regarde toutes les 4 s — ou si l'utilisateur AGIT. Sur le runner, une
  // analyse de D: dure plusieurs minutes : la veille la voit, toujours. Sur le
  // volume jetable de 511 Mio, elle dure moins d'une seconde et passe entre deux
  // sveils : l'interface ne recharge rien, et le verdict « meme dossier » passe
  // a vide. Une preuve qui ne se prouve pas n est pas une preuve.
  //
  // Changer le tri est un geste d'utilisateur qui recharge le dossier courant.
  // On l'utilise donc, et on exige la preuve que le rechargement a eu lieu.
  const genAvant = await page.evaluate(() => cur.gen);
  await page.selectOption('#order', 'asc');
  let recharge = false;
  try {
    await page.waitForFunction(
      (g) => cur.gen !== g, genAvant, { timeout: 60000 });
    recharge = true;
  } catch { /* rendu plus bas */ }
  verifier('l\'interface recharge bien l\'arbre apres une reanalyse', recharge,
    `generation ${genAvant} -> ${await page.evaluate(() => cur.gen)}`);
  // Le remplissage a-t-il VRAIMENT ete analyse ? Sans cela, un identifiant qui
  // ne bouge pas ne prouve rien du tout : il peut signifier que le support n'a
  // jamais ete monte. Cette verification, elle, est deterministe — un dossier
  // absent de l'instantane est un echec, pas une demonstration indisponible.
  const aRemp = await arbre(REMPLISSAGE);
  const vusRemp = aRemp.erreur ? 0 : (aRemp.rows || []).length;
  verifier('le remplissage a bien été vu par l’analyse', vusRemp >= REMPLISSAGE_N,
    `${vusRemp}/${REMPLISSAGE_N} dossier(s) vus sous « remplissage-identifiant »`);

  const a2 = await arbre(CIBLE);
const idApres = a2.path ? a2.path.at(-1).id : null;
  // Le cas que l'en-tete de ce fichier annonce depuis le debut : un volume calme
  // garde les identifiants en place. Ce n'est PAS un defaut de produit — le
  // contrat ci-dessous tient, lui, inchange — mais c'est une DEMONSTRATION
  // absente. Elle se dit, elle ne se declare pas verte, et elle ne fait pas
  // echouer non plus : la faire echouer revenait a punir la sonde d'un volume
  // calme, et le runner l'a montre le 28/09/2026.
  if (idApres === idAvant) {
    nonMesurables.push(1);
    info(`NE PAS MESURABLE — identifiant ${idAvant} inchange apres reanalyse : `
      + 'la demonstration est indisponible sur ce volume, le contrat ci-dessous reste etabli');
  } else {
    verifier('le support est réel — les identifiants ont changé de sens', true,
      `identifiant ${idAvant} -> ${idApres}`);
  }
  // Le tri est replacé : les deux verdicts qui suivent portent sur l'ordre par
  // taille, comme au depart, pour que la comparaison porte sur le CONTENU.
  await page.selectOption('#order', 'desc');
  await page.waitForFunction(
    () => (document.querySelector('#crumbs')?.textContent ?? '').length > 0,
    null, { timeout: 60000 });

  const filApres = await filAriane();
  const lignesApres = await nomLignes();
  verifier('après la réanalyse, l’écran montre TOUJOURS le dossier choisi',
    filApres === attendu,
    `avant ${JSON.stringify(attendu)} · après ${JSON.stringify(filApres)}`);
  verifier('et ses lignes sont les mêmes', JSON.stringify(lignesApres) === JSON.stringify(lignesAvant),
    `avant ${JSON.stringify(lignesAvant)} · après ${JSON.stringify(lignesApres)}`);

  // Maintenant le dossier DISPARAÎT. Sous l'ancien code, l'identifiant
  // aurait désigné le dossier suivant ; l'écran aurait changé de cible, sans
  // rien dire, et la ligne cochée aurait été celle d'un autre dossier.
  fs.rmSync(CIBLE, { recursive: true, force: true });
  const fini2 = await scanner();
  await fetch(`${BASE}/api/scan/${VOL}`, { method: 'POST', headers: H });
  const d2 = await attendreReanalyse(fini2);
  verifier('la réanalyse après suppression a bien eu lieu', !!d2,
    d2 ? `${fini2} -> ${d2.finished_ms}` : `finished_ms toujours ${fini2}`);

  // Meme gesto, meme raison : sans rechargement, un dossier disparu ne peut pas
  // etre vu, et le verdict passerait sans rien prouver.
  const gen3 = await page.evaluate(() => cur.gen);
  await page.selectOption('#order', 'asc');
  let dit = false;
  try {
    await page.waitForFunction(
      (g) => cur.gen !== g && dossierDisparu !== '', gen3, { timeout: 60000 });
    dit = true;
  } catch { /* rendu plus bas */ }
  const etatApres = await page.evaluate(() => ({
    disparu: dossierDisparu,
    compte: (document.querySelector('#count')?.textContent ?? '').trim(),
    fil: (document.querySelector('#crumbs')?.textContent ?? '').trim(),
  }));
  verifier('un dossier disparu est DIT, pas remplacé', dit,
    `dossierDisparu=${JSON.stringify(etatApres.disparu)} · `
    + `compte=${JSON.stringify(etatApres.compte)} · fil=${JSON.stringify(etatApres.fil)}`);
  verifier('et l’écran remonte d’un cran au lieu de viser ailleurs',
    /n'existe plus/.test(etatApres.compte)
    && etatApres.fil.includes('sonde-identifiant')
    && !etatApres.fil.includes('cible'),
    `fil=${JSON.stringify(etatApres.fil)} · compte=${JSON.stringify(etatApres.compte)}`);

  // Le 404 ATTENDU. L'interface demande deliberately un dossier qui n'existe
  // plus, et le navigateur consigne toute reponse non 2xx comme une erreur
  // console. La separer est legitime — c est la preuve que la demande a ete
  // faite — mais son NOMBRE est affiche : un 404 de trop se voit, et l affichage
  // reste la seule mesure qui ne peut pas passer pour un succes.
  const benignes = erreurs.filter((e) => ATTENDU_404.test(e));
  const autres = erreurs.filter((e) => !ATTENDU_404.test(e));
  info(`erreurs console : ${autres.length} inattendue(s), ${benignes.length} 404 attendu(s)`);
  verifier('aucune erreur JavaScript inattendue dans l’interface', autres.length === 0,
    autres.slice(0, 2).join(' | ') || 'aucune');
  // Les 404 ATTENDUS ci-dessus sont des REPONSES : le serveur a repondu. Une
  // requete tombee n'a pas de statut, et le navigateur n'en leve pas d'erreur
  // de page : sans cet ecoute, elle ne se voyait nulle part.
  verifier('aucune requete de l’interface n a echoue', suivi.echecs.length === 0,
    suivi.echecs.slice(0, 3).join(' | ') || 'aucune');
  } else {
    info('phases non mesurees : le dossier de la sonde n a pas ete atteint');
  }
} finally {
  await nav.close();
  fs.rmSync(REMPLISSAGE, { recursive: true, force: true });
  fs.rmSync(DOSSIER, { recursive: true, force: true });
}

const resume = `${verifs.filter(Boolean).length}/${verifs.length} vérifications`
  + (nonMesurables.length ? ` (+${nonMesurables.length} non mesurable(s))` : '');
console.log(`      ${resume}`);
if (echecs.length) {
  console.log('      ÉCHECS :');
  for (const e of echecs) console.log(`      - ${e}`);
}
process.exitCode = echecs.length ? 1 : 0;
