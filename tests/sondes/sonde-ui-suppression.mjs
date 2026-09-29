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

import { chromium, suivreRequetes } from './navigateur.mjs';
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
// Quatre fichiers de plus, DANS ce dossier, dont le nom et la taille ne se
// rangent pas dans le meme ordre. C est le support du verdict de tri, et il
// n existe que pour lui : sans plusieurs lignes dont l ordre peut changer, un
// verdict « la liste est dans l ordre demande » est une verification qui ne
// peut pas echouer. Elle passait au vert, serveur rendant l ordre inverse.
// Un test qui ne peut pas rougir n est pas un test, c est un decor.
for (const [nom, ko] of [['delta', 1], ['alpha', 2], ['charlie', 3], ['bravo', 4]]) {
  fs.writeFileSync(DOSSIER + '/Documents/' + nom + '.txt', 'x'.repeat(ko * 100));
}
// Le meme support, pour le TRI PENDANT UNE RECHERCHE. Un jeton que rien ne
// porte ailleurs, donc le resultat est le meme sur toutes les machines : c est
// la seule maniere d avoir plusieurs lignes a ordonner dans une vue recherche,
// ou les dependances de l environnement decident du nombre de resultats.
// ILS sont ranges par leur taille, donc l ordre par nom les change.
for (const [nom, ko] of [['zztri-3', 1], ['zztri-1', 2], ['zztri-2', 3]]) {
  fs.writeFileSync(DOSSIER + '/Documents/' + nom + '.txt', 'x'.repeat(ko * 100));
}
// Deux fichiers de MEME TAILLE, crees dans l ordre INVERSE de l ordre
// alphabetique. C est le support du verdict de departage, et il est construit
// pour que le serveur SANS departage se trahisse : il les rendrait dans l ordre
// du systeme de fichiers, donc `zztaille-z` avant `zztaille-a`, et le verdict
// rougirait. Avec le departage, ils sont ranges par nom croissant — meme en tri
// DECROISSANT, parce que le serveur garde le departage dans le sens demande
// (`.then_with(|| a.name.cmp(&b.name))`). C est un choix, et il tient pour les
// deux sens : un departage qui suivrait le sens rendrait l ordre illisible.
fs.writeFileSync(DOSSIER + '/Documents/zztaille-z.txt', 'x'.repeat(2000));
fs.writeFileSync(DOSSIER + '/Documents/zztaille-a.txt', 'x'.repeat(2000));
await fetch(`${BASE}/api/scan/${VOL}`, { method: 'POST', headers: H });
const indexe = await attendreFichier(BASE, VOL, DOSSIER, 'cible.txt');
verifier('le fichier d’essai est dans l’instantané', indexe,
  `« cible.txt » absent de « ${DOSSIER} » : rien n’a été indexé, donc rien n’a été éprouvé`);

const navig = await chromium.launch();
const page = await navig.newPage();
const erreurs = [];
page.on('console', m => { if (m.type() === 'error') erreurs.push(m.text()); });
page.on('pageerror', e => erreurs.push('pageerror: ' + e.message));
// Le reseau, comme le code et comme la console.
const suivi = suivreRequetes(page, navig);

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

// Controle du collecteur, avant tout verdict reseau : un collecteur qui ne
// mord pas ne prouve rien, et il faut le savoir tot plutot que froid.
const ctl = await suivi.control();
verifier('le collecteur voit une requete morte (controle)', ctl.vu, ctl.mesure);

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
  // Le fil doit changer ET MENER AU DOSSIER DE LA SONDE. Les deux, pas l une ou
  // l autre. Le 27/09, sur le runner, le clic a porte sur un dossier du runner
  // lui-meme (`_runner_file_commands`) : le fil avait bien change, et toute la
  // suite a cherche `photo.jpg` parmi les fichiers internes de GitHub Actions,
  // puis a conclu que l interface ne listait rien. Un changement de fil prouve
  // qu il y a eu navigation, pas qu on est ARRIVE.
  let arrivee = false;
  try {
    await page.waitForFunction(
      ([avant, nom]) => {
        const c = document.querySelector('#crumbs')?.textContent ?? '';
        return c !== avant && c.includes(nom);
      },
      [avant, NOM], { timeout: 60000 });
    arrivee = true;
  } catch { /* rendu juste apres, avec le diagnostic */ }
  verifier('la recherche mene AU DOSSIER DE LA SONDE, et pas a un autre',
    arrivee, `${await contenuLignes()} · fil : ${await filAriane()}`);
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
const indexePerso = await attendreFichier(BASE, VOL, `${DOSSIER}/Documents`, 'photo.jpg');
verifier('le fichier sous « Documents » est dans l’instantané', indexePerso,
  `« photo.jpg » absent de « ${DOSSIER}/Documents » : rien n’a été indexé, donc rien n’a été éprouvé`);

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
    // Le clic doit etre MESURE a l instant ou il part.
    //
    // Le 27/09, cette sonde a attendu 60 s puis regarde l ecran. Ce qu elle a
    // mesure etait donc l etat d apres : le journal de la CI a rapp
    // le dossier temporaire du runner, hors de l arbre de la sonde, sans qu une
    // seule ligne dise ou l interface se trouvait au moment du clic. Trois
    // explications donnent ce journal la : le clic est parti sur un noeud
    // detache, l interface etait deja ailleurs, elle y est allee ensuite.
    // Aucune ne se deduit des deux autres.
    //
    // D ou les trois points de mesure : l etat AVANT (le fil, la ligne visee,
    // sa place dans la liste, et ce que l interface croit etre le dossier
    // courant), l etat juste APRES le clic, et l etat a la fin de l attente.
    const avant = await filAriane();
    const vise = await page.evaluate(() => {
      const trs = Array.from(document.querySelectorAll('#rows tr'));
      const i = trs.findIndex((tr) => {
        const nm = tr.querySelector('.nm');
        return !!nm && nm.textContent === 'Documents';
      });
      if (i < 0) return null;
      window.__vise = trs[i];
      return {
        place: `${i + 1}/${trs.length}`,
        texte: trs[i].textContent.replace(/\s+/g, ' ').trim().slice(0, 90),
        gestionnaire: !!trs[i].querySelector('.nm').onclick,
        interface: { volume: cur.drive, dossier: cur.id, vue: cur.view,
          generation: cur.gen, recherche: document.querySelector('#q').value },
      };
    });
    await ligneDocs.locator('.nm').click();
    // Le point le plus utile : le noeud vise est-il ENCORE celui de l ecran
    // quand le clic est parti. Sinon la mesure qui suit porte sur un ecran
    // que le clic n a jamais touche, et dire « le clic n a pas navigue »
    // serait faux.
    const auClic = await page.evaluate(() => ({
      memeNoeud: !!window.__vise && document.contains(window.__vise),
      interface: { volume: cur.drive, dossier: cur.id, vue: cur.view,
        generation: cur.gen },
    }));
    try {
      await page.waitForFunction(
        (avant) => {
          const c = document.querySelector('#crumbs')?.textContent ?? '';
          return c !== avant && c.includes('Documents');
        },
        avant, { timeout: 60000 });
      navigue = true;
    } catch { /* rendu plus bas */ }
    const aLaFin = await page.evaluate(() => ({
      interface: { volume: cur.drive, dossier: cur.id, vue: cur.view,
        generation: cur.gen },
    }));
    verifier('le clic sur « Documents » a bien navigué', navigue,
      `avant ${JSON.stringify(vise)} · au clic ${JSON.stringify(auClic)}`
      + ` · à la fin ${JSON.stringify(aLaFin)} · ${await etatEcran()}`);
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
    : `non mesurable : le clic n'a pas navigué — structurel : le clic n'a pas navigué, donc le geste a échoué et cette sonde est déjà rouge — ${await etatEcran()}`);

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

// --- la liste se RE-REND quand elle doit, et SEULEMENT alors -------------------
// `renderRows` ne reconstruit plus que si ce qui est affiché change. C'est le
// correctif d'un clic perdu — la liste était vidée puis reconstruite toutes les
// 700 ms, et un clic tombant dans cette fenêtre partait sur un nœud détaché.
// Un correctif de ce genre a besoin de ses propres mesures, dans ce sens-là :
// non pas « la liste a-t-elle changé » — cela dépend des données du dossier, et
// deux entrées de même taille rendent le même ordre quel que soit le réglage —
// mais « la liste se re-rend-elle quand elle doit, et la sélection survit-elle ».
//
// La reconstruction se prouve par l'IDENTITÉ DU NŒUD : après un changement de
// réglage, `#rows tr` ne doit pas contenir les mêmes objets qu'avant. C'est
// indépendante du contenu, donc vraie pour n'importe quel dossier.
// L'ORDRE des lignes avec leur taille, et l'ordre demandé : sans ces trois
// choses, un échec ne dit pas si la liste est fausse, si le réglage n'a pas été
// appliqué, ou si l'ordre demandé rendait la même liste qu'avant.
// Les NOMS des lignes affichees, dans l ordre. Une liste, et non un nom : c est
// l ENSEMBLE qui doit survivre a un re-rendu, et c est lui qui doit obeir au
// tri demande.
const nomsLignes = () => page.$$eval('#rows tr .nm',
  (ns) => ns.map((n) => n.textContent));
// La collation du serveur : comparaison d octets. Voir pourquoi pas
// `localeCompare` au verdict du re-rendu.
const comparerNoms = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
// L ORDRE ATTENDU d une liste, pour un reglage donne. Meme collation que le
// serveur — comparaison d octets — et pour la meme raison qu aux autres
// verdicts : comparer avec une autre collation ne prouverait pas que le
// reglage demande est celui qui est applique.
const ordreAttenduPour = (noms, ordre) => {
  const s = [...noms].sort(comparerNoms);
  return ordre === 'desc' ? s.reverse() : s;
};
const etatTri = async () => page.evaluate(() => ({
  ordre: cur.order, tri: cur.sort, vue: cur.view, q: document.querySelector('#q').value,
  lignes: Array.from(document.querySelectorAll('#rows tr')).map((tr) => {
    const nm = tr.querySelector('.nm');
    const num = tr.querySelectorAll('td')[2];
    return `${nm ? nm.textContent : '?'}=${num ? num.textContent.trim() : '?'}`;
  }),
}));
// Ce qui a ete PEINT, et QUAND l ecran a cesse de bouger.
//
// Une liste peinte est un fait qui dure jusqu au rendu suivant : l ecran
// affiche un ordre, et il y reste. Or deux gestes de tri coup sur coup — le
// selecteur de tri, puis celui de sens — lancent DEUX requetes, et la plus
// ancienne peut se repondre APRES la plus recente. C est alors elle qui peint.
//
// Mesure le 28/09/2026, et reproduite en local avec 2 s de latence sur
// `/api/tree` : `tri=name` et `ordre=asc` dans l etat, une liste rangee par nom
// DECROISSANT a l ecran, deux secondes apres la bonne. Lire tot evite le
// defaut au lieu de le voir : la sonde lisait des la premiere peinture, donc son
// vert ne prouvait rien sur la derniere.
//
// D ou deux outils : le recorder, et l attente que l ecran se taise. Le
// raccord se voit en boucle : le rappel d un observateur de mutations s execute
// apres la tache ENTIERE, donc la liste qu il lit est celle du rendu fini, et
// jamais une ligne append par ligne.
const armerPeints = () => page.evaluate(() => {
  window.__peints = [];
  window.__bouge = Date.now();
  const lire = () => Array.from(document.querySelectorAll('#rows tr .nm'))
    .map((n) => n.textContent);
  const noter = () => {
    window.__bouge = Date.now();
    const noms = lire();
    const d = window.__peints[window.__peints.length - 1];
    if (d && d.tri === cur.sort && d.ordre === cur.order
      && d.noms.join('|') === noms.join('|')) return;
    window.__peints.push({ tri: cur.sort, ordre: cur.order, noms });
  };
  new MutationObserver(noter).observe(document.querySelector('#rows'),
    { childList: true, subtree: true });
  noter();
});
// L ecran se tait quand plus rien ne bouge depuis `ms`. La valeur est un
// CHOIX, et il merite de l etre dit : une reponse perimee peut arriver apres le
// dernier rendu utile, et une fenetre trop courte ne la verrait pas — son vert
// ne prouverait alors que la rapidite de la machine, pas la justesse du code.
// Deux secondes couvrent le service d un `/api/tree` sur un volume analyse, la
// ou la course a ete mesuree.
const attendreEcranStable = () => page.waitForFunction(
  (m) => Date.now() - (window.__bouge || 0) > m, 2000,
  { timeout: 60000, polling: 100 });

// --- le tri agit-il PENDANT une recherche ? --------------------------------
//
// Le 27/09, le serveur IGNORAIT `sort` et `order` sur `/api/search`, et le
// client compensait par un garde : le selecteur etait inerte pendant une
// recherche. Le serveur honore les deux depuis, et le garde est parti. Un
// réglage redevenu actif sans mesure est un réglage dont on ne sait rien.
//
// Ce que la sonde exige, et qui ne depend d'aucun contenu : la MEME liste de
// resultats, dans l ORDRE DEMANDE. Le nombre de resultats n entre pas — il
// depend du volume — mais l ordre, si.
if (fichierTrouve) {
  await armerPeints();
  await page.fill('#q', 'zztri-');
  await page.press('#q', 'Enter');
  // On attend un fait LIE A LA RECHERCHE — des lignes qui portent le jeton de
  // la requete — et non un COMPTE de lignes. Le listing du dossier reste a
  // l ecran tant que le serveur n a pas repondu, et l interface ne rend les
  // resultats qu a l arrivee : « au moins trois lignes » y est donc deja vrai,
  // et l attente passait sur la liste d AVANT.
  //
  // C est ce que le runner a mesure le 27/09/2026, et sa mesure etait juste :
  // huit lignes de diverse natures a « avant », trois noms `zztri-` a « apres ».
  // Ce n etait pas un volume instable : c etait le dossier compare a sa propre
  // recherche. Rejoue en local avec 4 s de latence sur `/api/search`, le verdict
  // rougissait a l octet pres — et il avait raison de rougir.
  // Le bloc suivant porte la meme lecon, et attend le fil d Ariane.
  //
  // Le critere est celui du verdict, donc : des LIGNES DE RESULTAT. Le support
  // porte `zztri-` et rien d autre ne le porte sur la machine, donc aucune
  // ligne de dossier ne peut satisfaire ce critere, et l attente ne peut plus
  // passer trop tot.
  let trouve = true;
  try {
    await page.waitForFunction(
      (jeton) => {
        const ns = Array.from(document.querySelectorAll('#rows tr .nm'));
        return ns.length >= 3 && ns.every((n) => n.textContent.includes(jeton));
      },
      'zztri-', { timeout: 60000 });
  } catch { trouve = false; }
  const avantRecherche = await nomsLignes();
  verifier('la recherche de contrôle rend plusieurs lignes à ordonner',
    trouve && avantRecherche.length >= 3,
    `${avantRecherche.length} ligne(s) : ${JSON.stringify(avantRecherche)}`);

  // Le support doit avoir quelque chose a changer : avant le reglage, la liste
  // est par taille decroissante, donc elle n'est PAS dans l ordre par nom. Sans
  // ce verdict, « la liste est dans l ordre demande » pourrait passer sans que
  // le reglage ait fait quoi que ce soit.
  const ordreDemande = [...avantRecherche].sort(comparerNoms);
  const dejaDansLOrdre = JSON.stringify(avantRecherche) === JSON.stringify(ordreDemande);
  verifier('et la liste n’est pas DÉJÀ dans l’ordre demandé', !dejaDansLOrdre,
    `avant=${JSON.stringify(avantRecherche)} · `
    + `l ordre demandé serait ${JSON.stringify(ordreDemande)}`);

  // On attend un FAIT, pas une generation. `cur.gen` est la generation de
  // l instantane, et une nouvelle interrogation du meme instantane la laisse
  // inchangee : attendre `cur.gen` a suppose qu une relance le fait bouger, et
  // le verdict a rougi alors que le tri venait de fonctionner. Le fait, c est
  // l ordre affiche.
  await page.selectOption('#sort', 'name');
  await page.selectOption('#order', 'asc');
  let rechargée = false;
  try {
    await page.waitForFunction(
      () => {
        const premier = document.querySelector('#rows tr .nm');
        return !!premier && premier.textContent === 'zztri-1.txt';
      }, null, { timeout: 60000 });
    rechargée = true;
  } catch { /* rendu plus bas */ }

  await attendreEcranStable();
  const apresRecherche = await nomsLignes();
  const memes = avantRecherche.length === apresRecherche.length
    && avantRecherche.every((n) => apresRecherche.includes(n));
  verifier('changer le tri garde les mêmes résultats', memes,
    `avant=${JSON.stringify(avantRecherche)} · après=${JSON.stringify(apresRecherche)}`);
  const ordreApres = [...apresRecherche].sort(comparerNoms);
  verifier('et les range dans l’ordre demandé, et non dans celui des tailles',
    JSON.stringify(apresRecherche) === JSON.stringify(ordreApres),
    `demandé ${JSON.stringify(ordreApres)} · `
    + `affiché ${JSON.stringify(apresRecherche)} · `
    + `la liste a-t-elle bouge ? ${rechargée ? 'oui' : 'NON MESURABLE'}`);
}

if (fichierTrouve) {
  // Le tri n'agit que hors recherche : le handler teste
  // `if (!$('#q').value.trim())` avant de recharger. On revient donc à la vue
  // dossier, et on le fait ICI, à la fin, pour ne pas déranger les sections
  // qui précèdent et qui naviguent.
  await page.selectOption('#sort', 'size');
  await page.selectOption('#order', 'desc');
  await page.fill('#q', '');
  await page.press('#q', 'Enter');
  // On attend le FIL D ARIANE du dossier, et non « des lignes » : quitter une
  // recherche laisse les lignes de la recherche a l ecran pendant la reponse du
  // serveur, donc « au moins une ligne » est vrai trop tot. Le bloc capturait
  // alors les resultats de la recherche au lieu du dossier, et l attente
  // passait quand meme. C est l epreuve de rupture qui l a montre : avec le tri
  // rompu, trois verdicts rougissaient au lieu d un, et les deux autres etaient
  // des consequences de cette course-la.
  // `« ` est le marqueur du pseudo-dossier de recherche : aucun vrai dossier ne
  // porte de chevron gauche d ouverture dans son fil.
  try {
    await page.waitForFunction(
      () => {
        const c = document.querySelector('#crumbs')?.textContent ?? '';
        return !c.includes('« ') && document.querySelectorAll('#rows tr .nm').length > 0;
      },
      null, { timeout: 30000 });
  } catch { /* rendu plus bas, avec la mesure */ }

  const avantNoeud = await page.evaluate(() => {
    const tr = document.querySelector('#rows tr');
    window.__avant = tr;
    return tr ? tr.querySelector('.nm').textContent : null;
  });
  const avantCochees = await page.$$eval('#rows tr .chk',
    (c) => c.filter((x) => x.checked).length);

  // Le support doit etre la, sinon le verdict qui suit ne mesure rien. Le dire
  // est mieux que le decouvrir en rouge : une verification sans support est un
  // succes qui ne prouve rien.
  // LE DÉPARTAGE DES TAILLES ÉGALES, MESURÉ À L'ÉCRAN.
  //
  // Ce que la sonde disait d elle-meme, et qu elle ne mesurait pas : « comparer
  // un ordre par taille demanderait de relire les tailles, et un support qui ne
  // prouve rien est pire que pas de support ». Le support existe desormais, donc
  // l excuse non plus.
  //
  // L invariant est volontairement INDEPENDANT du serveur : on ne demande pas
  // « l ecran montre-t-il ce que le serveur a dit », mais « a taille egale, les
  // noms sont-ils croissants ». Comparer l ecran au serveur ne prouverait que
  // qu ils sont d accord, y compris s ils ont tort ensemble ; l invariant, lui,
  // tient sans reference et ne peut etre vrai que si le serveur departage.
  //
  // Aucune conversion d unite : on regroupe par TEXTE de taille affiche, ce
  // qui suffit — deux lignes sont a egale taille si l interface ecrit la meme
  // chose pour les deux. Une conversion ici serait une source de faux rouges
  // pour rien : la question n est pas « combien d octets », c est « quelles
  // lignes sont egales ».
  const etatTaille = await etatTri();
  const groupes = new Map();
  for (const l of etatTaille.lignes) {
    const i = l.lastIndexOf('=');
    if (i < 0) continue;
    const taille = l.slice(i + 1);
    if (!groupes.has(taille)) groupes.set(taille, []);
    groupes.get(taille).push(l.slice(0, i));
  }
  const exaequos = [...groupes.entries()].filter(([, noms]) => noms.length >= 2);
  const desordre = exaequos.filter(([, noms]) =>
    noms.some((n, k) => k > 0 && comparerNoms(noms[k - 1], n) > 0));
  verifier('à taille égale, l’écran range par nom croissant — même en tri décroissant',
    etatTaille.tri === 'size' && exaequos.length > 0 && desordre.length === 0,
    `tri=${etatTaille.tri}/${etatTaille.ordre} · `
    + `${exaequos.length} groupe(s) de taille egale : `
    + `${JSON.stringify(exaequos.slice(0, 3))}`
    + (desordre.length ? ` · EN DESORDRE : ${JSON.stringify(desordre[0][1])}` : ''));

  const supportLignes = await nomsLignes();
  verifier('le dossier affiché a plusieurs lignes à ordonner', supportLignes.length >= 5,
    `${supportLignes.length} ligne(s) : ${JSON.stringify(supportLignes)}`);
  const avantNoms = await nomsLignes();
  await page.selectOption('#sort', 'name');
  await page.selectOption('#order', 'asc');
  let reRendu = false;
  try {
    await page.waitForFunction(
      () => {
        const tr = document.querySelector('#rows tr');
        return !!tr && tr !== window.__avant;
      }, null, { timeout: 30000 });
    reRendu = true;
  } catch { /* rendu plus bas */ }
  verifier('changer de réglage REDESSINE la liste — un réglage n’est pas un décor',
    reRendu, `avant=${JSON.stringify(avantNoeud)} · `
    + `${JSON.stringify(await etatTri())}`);

  // Ce que le re-rendu doit garantir n est PAS que la premiere ligne garde son
  // nom. Un tri par nom place forcement une autre entree en tete : c est le
  // BUT du tri, et exiger l inverse, c est ecrire un test qui ne peut que
  // rougir quand la fonction fait correctement son travail. Le 27/09, ce
  // verdict a rouge sur le runner, et il avait raison de rouge : il exigeait
  // l impossible.
  //
  // Les deux proprietes qui, elles, doivent tenir — et qui ne dependent d aucun
  // contenu particulier, donc vraies sur n importe quel dossier :
  //
  //  1. la liste CONTIENT les memes lignes : le re-rendu n en perd aucune ;
  //  2. la liste est dans l ordre DEMANDE : un reglage n est pas un decor.
  //
  // L ordre se compare avec la collation du serveur — comparaison d octets,
  // celle qui departage aussi les tailles egales — et non avec
  // `localeCompare`. Sous une locale, `Documents` se range APRES `cible.txt`,
  // alors que le serveur les range dans l autre sens. Comparer avec une autre
  // collation ne prouverait pas que le reglage demande est celui qui est
  // applique : elle prouverait qu on ne compare pas la meme chose.
  await attendreEcranStable();
  // L ORDRE DEMANDE N A JAMAIS ETE CONTRADIT. C est le seul verdict qui voie
  // les peintures INTERMEDIAIRES : tous les autres lisent l ecran a un instant,
  // et cet instant peut precedre la derniere reponse — c est exactement ce qui
  // a laisse passer le defaut du 28/09/2026.
  //
  // Seules les peintures `par nom` sont verifiables ICI : comparer un ordre par
  // taille a cet endroit demanderait de relire les tailles sur chaque peinture
  // intermediaire, et le departage se mesure plus bas, sur un support fait pour.
  // Le nombre de peintures verifiables est lu et exige : sans lui, ce verdict
  // pourrait passer sans avoir rien regarde.
  const peints = await page.evaluate(() => window.__peints);
  const verifiables = peints.filter((p) => p.tri === 'name');
  const contradites = verifiables.filter((p) => p.noms.join('|')
    !== ordreAttenduPour(p.noms, p.ordre).join('|'));
  const conformes = verifiables
    .map((p) => `${p.tri}/${p.ordre} ${JSON.stringify(p.noms.slice(0, 3))}`);
  verifier('l’ordre demandé n’a jamais été contredit à l’écran',
    verifiables.length > 0 && contradites.length === 0,
    contradites.length
      ? `CONTREDIT : l’écran a peint ${contradites[0].tri}/${contradites[0].ordre} `
        + `en ${JSON.stringify(contradites[0].noms.slice(0, 6))} au lieu de `
        + `${JSON.stringify(ordreAttenduPour(contradites[0].noms, contradites[0].ordre).slice(0, 6))} `
        + `· ${peints.length} peinture(s) en tout`
      : `${verifiables.length} peinture(s) par nom sur ${peints.length} en tout — `
        + `toutes conformes : ${JSON.stringify(conformes)}`);

  const nomsApres = await nomsLignes();
  const memesLignes = avantNoms.length === nomsApres.length
    && avantNoms.every((n) => nomsApres.includes(n));
  verifier('le re-rendu ne perd aucune ligne', memesLignes,
    `avant=${JSON.stringify(avantNoms.slice(0, 6))} · `
    + `après=${JSON.stringify(nomsApres.slice(0, 6))}`);
  const ordreAttendu = [...nomsApres].sort(comparerNoms);
  verifier('et la liste est dans l’ordre demandé',
    JSON.stringify(nomsApres) === JSON.stringify(ordreAttendu),
    `demandé ${JSON.stringify(ordreAttendu.slice(0, 6))} · `
    + `affiché ${JSON.stringify(nomsApres.slice(0, 6))} · `
    + `${JSON.stringify(await etatTri())}`);
  const apresCochees = await page.$$eval('#rows tr .chk',
    (c) => c.filter((x) => x.checked).length);
  // La sélection doit survivre : une signature calculée sans elle afficherait une
  // liste toute décochée, et l'utilisateur verrait sa sélection disparaître.
  verifier('le re-rendu ne perd pas la sélection',
    avantCochees === apresCochees,
    `${avantCochees} case(s) avant, ${apresCochees} après`);
  verifier('et la liste garde le même nombre de lignes',
    (await etatTri()).lignes.length > 0,
    JSON.stringify((await etatTri()).lignes.slice(0, 4)));
}

verifier('aucune erreur JavaScript dans l’interface', erreurs.length === 0,
  JSON.stringify(erreurs.slice(0, 3)));
// Une page dont la requete est tombee affiche une liste vide ou figee, et ne
// leve AUCUNE erreur JavaScript : les deux verdicts du dessus la declarent
// saine. Celui-ci est le seul qui la puisse voir.
verifier('aucune requete de l’interface n a echoue', suivi.echecs.length === 0,
  suivi.echecs.slice(0, 3).join(' | ') || 'aucune');

await navig.close();
console.log('');
console.log(`${verifs.filter(Boolean).length}/${verifs.length} vérifications`);
if (echecs.length) { console.log('ÉCHECS :'); for (const e of echecs) console.log(`  - ${e}`); }
process.exitCode = echecs.length ? 1 : 0;
