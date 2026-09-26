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
import { dossier, aCorbeille, attendreFichier, VOLUME_DEFAUT, URL_DEFAUT } from './config.mjs';

const BASE = (process.argv[2] || URL_DEFAUT).replace(/\/$/, '');
const VOL = (process.argv[3] || VOLUME_DEFAUT).toUpperCase();
const CONTRE = process.argv[4] === 'sans-en-tete';
// Un dossier a nous, sous la racine de travail, retire apres coup.
const DOSSIER = dossier(VOL, 'ui');
const NOM = DOSSIER.split('/').pop();
const A_CORBEILLE = aCorbeille(VOL);

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
let dossierTrouve = false;
try {
  await ligneDossier.locator('.nm').waitFor({ state: 'visible', timeout: 60000 });
  dossierTrouve = true;
} catch { /* laissé false : le verdict est rendu juste après */ }
// Texte EXACT, et non « contient » : la recherche remonte aussi tout fichier dont
// le nom contient le motif — et un `hasText` partiel a déjà cliqué sur un fichier,
// qui n'a pas de navigation, faisant conclure que l'interface ne listait rien.
verifier('le dossier d’essai apparaît dans la recherche', dossierTrouve, 'aucune ligne trouvée');
if (dossierTrouve) await ligneDossier.locator('.nm').click();

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
  fichierTrouve, 'aucune ligne trouvée');

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
    verifier('elle promet la corbeille, et le volume en a une',
      /restaurer depuis l.?.?explorateur/.test(corps) && !/définitivement détruits/.test(corps),
      corps.slice(0, 240));
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
verifier('aucune erreur JavaScript dans l’interface', erreurs.length === 0,
  JSON.stringify(erreurs.slice(0, 3)));

await navig.close();
console.log('');
console.log(`${verifs.filter(Boolean).length}/${verifs.length} vérifications`);
if (echecs.length) { console.log('ÉCHECS :'); for (const e of echecs) console.log(`  - ${e}`); }
process.exit(echecs.length ? 1 : 0);
