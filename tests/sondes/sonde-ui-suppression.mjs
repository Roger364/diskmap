// Le geste réel de l'utilisateur : choisir un volume, cocher une ligne, ouvrir la
// modale « Supprimer… », et LIRE ce que la modale promet.
//
// Deux raisons d'exister, et la seconde est la plus importante :
//
//  1. Le correctif CSRF exige un en-tête sur toute route POST, posé par le helper
//     `api()` de l'interface. Mes autres sondes exercent /api/delete depuis NODE :
//     elles ne disent donc rien du chemin de l'interface, et un correctif qui
//     aurait cassé le geste dans l'interface les aurait laissées toutes vertes.
//
//  2. La modale PROMETTAIT « tu peux les restaurer depuis l'explorateur ». Sur un
//     volume sans corbeille, cette phrase est fausse — mesuré sur E:, le mode
//     « corbeille » y détruit les fichiers. Une promesse écrite en dur dans
//     l'interface est exactement ce qu'aucune sonde serveur ne peut voir.
//
// Elle ne va PAS jusqu'à la suppression : elle s'arrête à l'aperçu, qui est déjà
// un appel POST à /api/delete, et c'est ce qu'il fallait éprouver.
//
// Usage : node sonde-ui-suppression.mjs http://127.0.0.1:9006/ G
//         node sonde-ui-suppression.mjs http://127.0.0.1:9006/ E
//         node sonde-ui-suppression.mjs http://127.0.0.1:9006/ G sans-en-tete
//           ↑ contre-épreuve : retire X-Diskmap au vol, et DOIT rougir.
import fs from 'fs';

import { chromium } from './navigateur.mjs';
import { dossier, aCorbeille, estEleve, aTaper, attendreFichier,
  VOLUME_DEFAUT, URL_DEFAUT } from './config.mjs';

const BASE = (process.argv[2] || URL_DEFAUT).replace(/\/$/, '');
const VOL = (process.argv[3] || VOLUME_DEFAUT).toUpperCase();
const CONTRE = process.argv[4] === 'sans-en-tete';
// Un dossier a nous, sous la racine de travail, retire apres coup.
// Le nom est préfixé par `sonde-`, et il doit l'être : le dossier s'appelait
// `ui`, ce qui est aussi le nom d'un dossier du DÉPÔT. Sur la machine de
// développement, `D:\ui` n'existait pas et la recherche ne trouvait qu'un
// candidat. Sur le runner, le dépôt est sur le volume analysé — donc sur
// `D:` — et la recherche remontait le `ui` du dépôt en premier : la sonde
// naviguait dans le code de l'interface au lieu du dossier d'essai, et
// concluait « le fichier n'apparaît pas ».
//
// Un nom de sonde doit être unique PARMI CE QUE LA SONDE ANALYSE. Le volume de
// travail n'est pas vierge, et il ne le sera jamais sur un runner.
const DOSSIER = dossier(VOL, 'sonde-ui');
const NOM = DOSSIER.split('/').pop();
const A_CORBEILLE = aCorbeille(VOL);
// L'instance peut etre ELEVEE : le mot `EFFACER` s'ajoute alors meme en mode
// corbeille, et la modale affiche un champ de plus. Le lire plutot que le
// supposer evite que cette sonde attribue au nom du dossier un refus qui
// porte en realite sur le mot — ce qu'elle faisait sur tout runner eleve.
const ELEVE = await estEleve(BASE);
// Le lot est celui de la sonde : quelques octets, donc aucun palier de taille.
const MOT = aTaper({ permanent: false, corbeille: A_CORBEILLE, eleve: ELEVE });

const verifs = [], echecs = [];
function verifier(nom, cond, mesure) {
  const ok = !!cond; verifs.push(ok);
  if (!ok) echecs.push(`${nom} — mesuré : ${mesure}`);
  console.log(`${ok ? 'ok   ' : 'ROUGE'} ${nom}${ok ? '' : `\n      mesuré : ${mesure}`}`);
}

const H = { 'X-Diskmap': '1' };   // la sonde joue le client légitime

console.log(`--- ${VOL}: — corbeille ${A_CORBEILLE ? 'présente' : 'ABSENTE'} ---`);

// --- montage : un fichier à nous, dans l'instantané --------------------------
// L'attente porte sur le FAIT : le fichier doit APPARAITRE dans l'instantane.
// `!scanning` peut revenir avant que le fichier soit indexe, et la suite
// irait alors chercher une ligne qui n'existe pas encore. Voir
// `attendreFichier` dans config.mjs.
fs.mkdirSync(DOSSIER, { recursive: true });
fs.writeFileSync(DOSSIER + '/cible.txt', `cible-${Date.now()}\n`);
// Un second fichier, dans un dossier que la regle des dossiers à nommer
// reconnait : c'est ce qui permet d'eprouver le champ dans un vrai navigateur.
fs.mkdirSync(DOSSIER + '/Documents', { recursive: true });
fs.writeFileSync(DOSSIER + '/Documents/photo.jpg', `photo-${Date.now()}\n`);
await fetch(`${BASE}/api/scan/${VOL}`, { method: 'POST', headers: H });
const indexe = await attendreFichier(BASE, VOL, 'cible.txt');
verifier('le fichier d’essai est dans l’instantané', indexe,
  `« cible.txt » n’apparaît pas dans l’index de ${VOL}`);

const navig = await chromium.launch();
const page = await navig.newPage();
const erreurs = [];
page.on('console', m => { if (m.type() === 'error') erreurs.push(m.text()); });
page.on('pageerror', e => erreurs.push('pageerror: ' + e.message));

if (CONTRE) {
  console.log('      contre-épreuve : X-Diskmap retiré au vol');
  await page.route('**/api/delete', route => {
    const h = { ...route.request().headers() };
    delete h['x-diskmap'];
    route.continue({ headers: h });
  });
}

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('#drives .drive', { timeout: 20000 });

// La recherche est refusée tant qu'aucun volume n'est choisi (`if (!cur.drive)
// return`) : sans ce clic, la fonction sort en silence et la liste reste vide —
// ce qui ressemblerait à une interface cassée.
await page.click(`#drives .drive[data-letter="${VOL}"]`);
await page.waitForTimeout(800);

// --- le geste : chercher, entrer, cocher, demander à supprimer ---------------
await page.fill('#q', NOM);
await page.press('#q', 'Enter');

// On attend L'ÉLÉMENT, jamais une durée. Un `waitForTimeout(1500)` suppose
// que la machine répond dans ce délai : sur le runner du premier run GitHub,
// la recherche n'était pas rendue à ce moment-là, la suite annonçait « aucune
// ligne trouvée », et le test concluait que l'interface ne listait rien. Un
// délai fixe transforme une machine lente en défaut de l'application — et il
// le fait SILENCIEUSEMENT, sans qu'aucune ligne dise qu'on a mal attendu.
const ligneDossier = page.locator('#rows tr')
  .filter({ has: page.getByText(NOM, { exact: true }) }).first();

// Diagnostics : « aucune ligne trouvée » ne dit pas CE QUI était à l'écran. Deux
// échecs très différents — une liste vide, ou une liste de dossiers seulement —
// donnaient le même message, et on ne pouvait pas les distinguer sans deviner.
const contenuLignes = async () => {
  const t = await page.locator('#rows tr').allTextContents().catch(() => []);
  return t.length ? `lignes affichées : ${JSON.stringify(t.slice(0, 5))}` : 'aucune ligne dans #rows';
};
const filAriane = () => page.textContent('#crumbs').catch(() => '');

let dossierTrouve = false;
try {
  await ligneDossier.locator('.nm').waitFor({ state: 'visible', timeout: 60000 });
  dossierTrouve = true;
} catch { /* laissé false : le verdict est rendu juste après */ }
// Texte EXACT, et non « contient » : la recherche remonte aussi tout fichier dont
// le nom contient le motif — et un `hasText` partiel a déjà cliqué sur un fichier,
// qui n'a pas de navigation, faisant conclure que l'interface ne listait rien.
verifier('le dossier d’essai apparaît dans la recherche', dossierTrouve,
  await contenuLignes());
if (dossierTrouve) {
  // Le clic déclenche une requête asynchrone : on attend que le MIEL change de
  // contenu, pas qu'un délai s'écoule. Un clic suivi d'un `waitForTimeout` ne
  // distingue pas « la navigation a eu lieu » de « le clic n'a rien fait ».
  const avant = await filAriane();
  await ligneDossier.locator('.nm').click();
  try {
    await page.waitForFunction(
      (avant) => document.querySelector('#crumbs')?.textContent !== avant,
      avant, { timeout: 60000 });
  } catch { /* rendu plus bas, avec le diagnostic */ }
}

const ligneFichier = page.locator('#rows tr')
  .filter({ has: page.getByText('cible.txt', { exact: true }) }).first();
let fichierTrouve = false;
if (dossierTrouve) {
  try {
    await ligneFichier.waitFor({ state: 'visible', timeout: 60000 });
    fichierTrouve = true;
  } catch { /* idem */ }
}
verifier('le fichier apparaît après être entré dans le dossier',
  fichierTrouve, `${await contenuLignes()} · fil : ${await filAriane()}`);

let titre = null, corps = '';
if (fichierTrouve) {
  await ligneFichier.locator('.chk').check();
  const bouton = page.locator('#delbtn');
  let boutonVisible = false;
  try {
    await bouton.waitFor({ state: 'visible', timeout: 30000 });
    boutonVisible = true;
  } catch { /* rendu juste après */ }
  verifier('le bouton « Supprimer… » apparaît quand une ligne est cochée',
    boutonVisible, 'bouton invisible');
  if (boutonVisible) await bouton.click();
}

// C'est ici que tout se joue : la modale ne s'ouvre que si l'appel POST
// /api/delete en mode « dry » a été ACCEPTÉ. Un 403 la laisserait fermée.
//
// Le délai est large : c'est un POST qui resolve des chemins sur le disque, et
// sur un runner lent il dépasse largement les 10 s d'avant.
if (fichierTrouve) try {
  await page.waitForSelector('#modal:not(.hidden)', { timeout: 60000 });
  titre = (await page.textContent('#dtitle')).trim();
  corps = (await page.textContent('#dbody')).replace(/\s+/g, ' ');
} catch (e) {
  verifier('la modale s’ouvre — donc l’appel POST de l’interface est accepté',
    false, `elle ne s'est pas ouverte : ${erreurs.slice(0, 2).join(' | ') || 'sans message'}`);
}
if (titre !== null) {
  console.log(`      titre : « ${titre} »`);
  verifier('la modale s’ouvre — donc l’appel POST de l’interface est accepté', true, '');
  verifier('elle annonce le fichier à supprimer', /1 élément/.test(titre), `« ${titre} »`);

  // La promesse affichée doit correspondre à ce que le volume sait faire.
  console.log(`      promesse : « ${corps.slice(corps.indexOf('corbeille') > 0 ? corps.indexOf('corbeille') - 60 : 0, 240)}… »`);
  if (A_CORBEILLE) {
    // La promesse n'est plus une formule : elle est MESURÉE. Le serveur relève
    // le plafond du volume et son occupation, et l'interface doit dire si ce
    // lot tient — ou avouer qu'il déborde. Une formule (« tu peux les restaurer
    // » donnée à toutes les lettres près) ne prouverait plus rien du tout.
    // Cette phrase ne doit pas DISPARAITRE quand un mot est exige. Elle
    // disparaissait : l'interface faisait « si un mot est demande, tais-toi sur
    // la destination », et sur une instance elevee — donc chez tout
    // administrateur — l'utilisateur tapait EFFACER sans qu'on lui dise que les
    // fichiers partaient en corbeille. Destination et saisie sont deux faits
    // independants, et c'est ce que verifie cette ligne.
    const annonce = /Les éléments iront dans la corbeille/.test(corps);
    const mesure = /de plafond/.test(corps) && /y tient/.test(corps);
    const avertit = /Rien ne sera détruit tout de suite/.test(corps);
    verifier('elle annonce la corbeille, et le volume en a une',
      annonce && !/définitivement détruits/.test(corps),
      corps.slice(0, 240));
    // Sur un lot minuscule — le fichier de la sonde — ça tient toujours. La
    // branche du débordement est éprouvée ailleurs, sur un volume dont le
    // plafond est atteint ; ici on vérifie au moins qu'aucun avertissement ne
    // sort quand la mesure dit que ça tient.
    verifier('elle donne la mesure, pas une formule',
      mesure && !avertit, corps.slice(0, 240));
  } else {
    verifier('elle AVERTIT que le volume n’a pas de corbeille, au lieu de promettre la restauration',
      /pas de corbeille/.test(corps) && /définitivement détruits/.test(corps),
      corps.slice(0, 240));
    verifier('elle exige EFFACER avant une destruction inévitable',
      await page.locator('#dconfirm').count() === 1,
      'champ de confirmation absent');
    verifier('elle ne promet PAS une restauration impossible',
      !/tu peux les restaurer/.test(corps), corps.slice(0, 240));
  }

  // On annule : cette vérification ne supprime rien.
  await page.click('#dcancel');
  verifier('le fichier est toujours là — la vérification n’a rien effacé',
    fs.existsSync(DOSSIER + '/cible.txt'), 'le fichier a disparu');
}
// --- la regle des dossiers à nommer, dans un vrai navigateur -------------
//
// La sonde serveur (`sonde-dossiers-personnels.mjs`) prouve que le serveur
// refuse. Elle ne voit pas le BOUTON, qui est la moitie du geste : un
// `disabled` oublie dans l'interface laisserait tous les tests verts et
// l'utilisateur devant une modale qui ne finit pas.
//
// Elle s'arrete une fois le bouton allume. Elle ne clique pas dessus : la
// suppression reelle n'est pas l'objet de cette verification, et la sonde
// `reelle` s'en charge sur le meme volume.
console.log('--- la regle des dossiers à nommer, dans un vrai navigateur ---');
await fetch(`${BASE}/api/scan/${VOL}`, { method: 'POST', headers: H });
const indexePerso = await attendreFichier(BASE, VOL, 'photo.jpg');
verifier('le fichier sous « Documents » est dans l’instantané', indexePerso,
  '« photo.jpg » n’apparaît pas dans l’index de ' + VOL);

// `docsTrouve` est déclaré ICI et pas dans le `if` : une `let` déclarée dans
// un bloc n'existe que dans ce bloc, et la vérification suivante — celle qui
// dépend du clic — planterait sur une variable invisible. Le parcours entier
// du fichier a été sorti de l'échec en cascades pour cette seule ligne.
// `ligneDocs` reste dans le `if` : c’est un `const`, donc le clic et sa
// vérification aussi — les monter plus haut donnerait un
// `ReferenceError`, le genre de panne qui ne se montre qu’au moment précis
// où la sonde réussit enfin ce qu’elle cherche.
// Ce que l ECRAN montre, et non ce que la sonde suppose qu il montre.
//
// Un echec qui dit seulement « le clic n a pas navigue » laisse choisir entre
// trois causes tres differentes : le dossier affiche n est pas celui de la
// sonde, la ligne visee n a aucun gestionnaire de clic, ou le clic est parti
// ailleurs. Elles ne se distinguent pas a la lecture du journal, et les
// deduire serait exactement l affirmation sans mesure que ce projet refuse.
//
// Le marqueur est decideur : `.onclick` est une PROPRIETE DOM, presente quand
// le gestionnaire est pose et `null` sinon. `[MORT]` ne dit pas « le clic a
// echoue », il dit « il n y avait rien a appeler ».
const etatEcran = async () => {
  const noms = await page.$$eval('#rows tr', (trs) => trs.slice(0, 8).map((tr) => {
    const nm = tr.querySelector('.nm');
    return (nm ? nm.textContent : '?') + (nm && nm.onclick ? ' [clic]' : ' [MORT]');
  }));
  return `fil : ${await filAriane()} · ${noms.length} ligne(s) : ${noms.join(' | ')}`;
};

let docsTrouve = false;
let navigue = false;
if (fichierTrouve) {
  const ligneDocs = page.locator('#rows tr')
    .filter({ has: page.getByText('Documents', { exact: true }) }).first();
  try {
    await ligneDocs.locator('.nm').waitFor({ state: 'visible', timeout: 30000 });
    docsTrouve = true;
  } catch { /* rendu plus bas */ }
  verifier('le dossier « Documents » est listé à côté du fichier d’essai',
    docsTrouve, await contenuLignes());

  // Le clic doit être SUIVI, pas supposé. `docsTrouve` ne dit que la visibilité
  // d'une ligne : rien ne garantit que le clic ait navigué. S'il n'a pas
  // navigué, la recherche de `photo.jpg` porte sur l'écran d'avant, et son
  // échec conclut alors que l'interface ne liste pas le fichier alors qu'elle
  // n'a jamais été dans le dossier.
  //
  // C'est exactement ce qui est arrivé sur le runner du 27/09/2026 : le fil
  // d'Ariane disait `…_diskmap_sondes › suppression-reelle` — le dossier de la
  // SONDE PRÉCÉDENTE — et la ligne annonçait « aucune ligne dans #rows ». Le
  // message ne disait donc rien du défaut : il décrivait un écran que la sonde
  // n'était pas censée regarder.
  if (docsTrouve) {
    // Même idiomat que plus haut dans ce fichier : on attend que le FIL
    // change, pas qu’une durée s’écoule. `#crumbs` est DÉJÀ visible avant
    // le clic — l’attendre serait satisfait dès le départ.
    const avant = await filAriane();
    await ligneDocs.locator('.nm').click();
    try {
      await page.waitForFunction(
        (avant) => {
          const c = document.querySelector('#crumbs')?.textContent ?? '';
          return c !== avant && c.includes('Documents');
        },
        avant, { timeout: 60000 });
      navigue = true;
    } catch { /* rendu plus bas */ }
    verifier('le clic sur « Documents » a bien navigué', navigue,
      await etatEcran());
  }
}

const lignePerso = page.locator('#rows tr')
  .filter({ has: page.getByText('photo.jpg', { exact: true }) }).first();
let persoTrouve = false;
if (navigue) {
  try {
    await lignePerso.waitFor({ state: 'visible', timeout: 60000 });
    persoTrouve = true;
  } catch { /* idem */ }
}
verifier('le fichier du dossier personnel est listé', persoTrouve,
  navigue
    ? `${await contenuLignes()} · fil : ${await filAriane()}`
    // Sans navigation, la mesure serait celle d'un autre écran. Le dire vaut
    // mieux que rapporter un vide qui n'est pas là où on le cherche.
    : `non mesurable : le clic n'a pas navigué — ${await etatEcran()}`);

if (persoTrouve) {
  await lignePerso.locator('.chk').check();
  await page.locator('#delbtn').click();
  let modale = false;
  try {
    await page.waitForSelector('#modal:not(.hidden)', { timeout: 60000 });
    modale = true;
  } catch { /* rendu plus bas */ }
  verifier('la modale s’ouvre sur un lot de dossier personnel', modale,
    'elle ne s’est pas ouverte');

  if (modale) {
    const champ = page.locator('#dbody .nom-in').first();
    const nb = await page.locator('#dbody .nom-in').count();
    verifier('elle affiche un champ par dossier à nommer', nb === 1, `${nb} champ(s)`);
    const attendu = await champ.getAttribute('data-dossier').catch(() => null);
    verifier('le champ porte le nom du dossier à saisir', attendu === 'Documents',
      `data-dossier = ${JSON.stringify(attendu)}`);

    const corps = (await page.textContent('#dbody')).replace(/\s+/g, ' ');
    verifier('le bandeau annonce le dossier à nommer', /Dossier à nommer/i.test(corps),
      corps.slice(0, 200));

    const desactive = () => page.locator('#ddo').isDisabled();
    verifier('le bouton est inactif tant que rien n’est saisi', await desactive(),
      'le bouton est actif sur une modale non confirmee');
    await champ.fill('burns');
    await page.waitForTimeout(150);
    verifier('le bouton reste inactif sur le MAUVAIS nom', await desactive(),
      'le bouton s’est active sur « burns » pour un dossier « Documents »');
    const aide = (await page.locator('#dbody .p-aide').first().textContent().catch(() => '')) || '';
    verifier('l’interface dit pourquoi le nom ne convient pas', aide.length > 0, 'aide vide');
    // Les mots se remplissent AVANT le nom, et l'ordre est verifiable : un
    // bouton qui s'allume sur le bon nom TOUT SEUL prouverait que le mot ne
    // protege de rien.
    const champsMot = page.locator('#dbody .dconfirm');
    const nbMots = await champsMot.count();
    verifier('elle affiche un champ par mot exige', nbMots === (MOT ? 1 : 0),
      `${nbMots} champ(s) pour le mot ${JSON.stringify(MOT)}`);
    if (MOT) {
      await champsMot.first().fill(MOT);
      await page.waitForTimeout(150);
      verifier('le bon mot, sans le nom du dossier, ne suffit pas', await desactive(),
        'le bouton s’est activé sur le seul mot');
    }
    await champ.fill('documents');
    await page.waitForTimeout(150);
    verifier('le bouton s’active quand le nom ET le mot sont bons',
      !(await desactive()), 'le bouton reste inactif sur « documents »');

    await page.click('#dcancel');
    verifier('rien n’a été effacé : la vérification s’est arrêtée à l’allumage',
      fs.existsSync(DOSSIER + '/Documents/photo.jpg'),
      'le fichier a disparu sans que la sonde ait clique');
  }
}

verifier('aucune erreur JavaScript dans l’interface', erreurs.length === 0,
  JSON.stringify(erreurs.slice(0, 3)));

await navig.close();
console.log('');
console.log(`${verifs.filter(Boolean).length}/${verifs.length} vérifications`);
if (echecs.length) { console.log('ÉCHECS :'); for (const e of echecs) console.log(`  - ${e}`); }
process.exit(echecs.length ? 1 : 0);
