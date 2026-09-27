// Sonde de bout en bout : bouton d'arrêt et discrétion des boutons d'illisibles.
//
// Promet, et sort en 1 si l'une manque :
//  1. le bouton « Arrêter » est présent dans l'en-tête ;
//  2. la bannière des dossiers illisibles a une couleur NEUTRE — la teinte ambre
//     d'origine ne doit plus apparaître nulle part dans ses styles calculés — et
//     seul le nombre garde la teinte chaude ;
//  3. les boutons « Ouvrir » de la modale sont en fantôme : ni fond ni bordure
//     visibles, texte discret ;
//  4. « Arrêter » sans analyse en cours arrête directement, sans poser de question ;
//  5. « Arrêter » pendant une analyse demande confirmation en CHIFFRANT ce qui
//     serait perdu, et « Arrêter maintenant » arrête ;
//  6. après l'arrêt, plus aucune requête ne part — les minuteurs sont bien éteints.
//
// Le point 2 et le point 5 sont ceux qui peuvent échouer en silence : un retour
// à l'ambre passerait sans rien casser, et une boîte de confirmation vide
// (« vraiment ? ») aurait l'air correcte tout en n'apprenant rien.
//
// Usage : node sonde-arret.mjs <url> <styles|idle|running>

import { chromium } from './navigateur.mjs';
import { URL_DEFAUT } from './config.mjs';

const URL = process.argv[2] || URL_DEFAUT;
const MODE = process.argv[3] || 'styles';

const verifs = [];
const echecs = [];
function verifier(nom, condition, mesure) {
  const ok = !!condition;
  verifs.push(ok);
  if (!ok) echecs.push(`${nom} — mesuré : ${mesure}`);
  console.log(`${ok ? 'ok   ' : 'ROUGE'} ${nom}${ok ? '' : `\n      mesuré : ${mesure}`}`);
}

const navigateur = await chromium.launch();
const page = await navigateur.newPage();
await page.goto(URL, { waitUntil: 'networkidle' });

// ------------------------------------------------------------------ styles
if (MODE === 'styles') {
  verifier('le bouton « Arrêter » est dans l’en-tête',
    await page.locator('header #stop').isVisible(), 'absent ou caché');

  // La bannière doit exister pour qu'on la mesure : on prend un volume qui a des
  // illisibles. S'il n'y en a aucun, la sonde le dit au lieu de passer en vert.
  const bannieres = await page.locator('.drive .inc').count();
  if (bannieres === 0) {
    verifier('au moins une bannière d’illisibles à mesurer', false,
      'aucun volume avec des dossiers illisibles — le point 2 n’a pas pu être exercé');
  } else {
    const s = await page.locator('.drive .inc').first().evaluate(el => {
      const c = getComputedStyle(el);
      const b = getComputedStyle(el.querySelector('b'));
      return { fond: c.backgroundColor, texte: c.color, nombre: b.color, bord: c.borderColor };
    });
    // #3a2a18 était le fond ambre d'origine. On l'interdit explicitement.
    verifier('la bannière d’illisibles n’a plus le fond ambre',
      s.fond !== 'rgb(58, 42, 24)', `fond = ${s.fond}`);
    verifier('la bannière d’illisibles a un fond neutre (--panel2)',
      s.fond === 'rgb(33, 37, 45)', `fond = ${s.fond}`);
    verifier('le texte de la bannière est discret (--muted)',
      s.texte === 'rgb(141, 149, 163)', `texte = ${s.texte}`);
    verifier('seul le NOMBRE garde la teinte chaude',
      s.nombre === 'rgb(201, 138, 46)', `nombre = ${s.nombre}`);

    // Le libellé doit tenir sur UNE ligne. Il ne le faisait pas avant : « incomplet »
    // se retrouvait orphelin sous « voir », sur deux lignes.
    // On compte les `top` DISTINCTS, pas les rectangles : `getClientRects()` sur une
    // plage qui traverse plusieurs nœuds rend un rectangle par FRAGMENT (`! `, le
    // `<b>`, puis le texte), et un bandeau d'une seule ligne en donnait quatre. Le
    // premier essai de cette vérification a accusé l'application à tort.
    const lignes = await page.locator('.drive .inc').first().evaluate(el => {
      const r = document.createRange();
      r.selectNodeContents(el.querySelector('span'));
      return new Set([...r.getClientRects()].map(x => Math.round(x.top))).size;
    });
    verifier('le libellé du bandeau tient sur une ligne',
      lignes === 1, `${lignes} ligne(s) — le libellé se replie`);

    await page.locator('.drive .inc').first().click();
    await page.waitForSelector('#ubody .grp', { timeout: 5000 });
    const o = await page.locator('#ubody .grp .gh .btn').first().evaluate(el => {
      const c = getComputedStyle(el);
      return { fond: c.backgroundColor, bord: c.borderColor, texte: c.color };
    });
    verifier('les boutons « Ouvrir » sont en fantôme (aucun fond)',
      o.fond === 'rgba(0, 0, 0, 0)', `fond = ${o.fond}`);
    verifier('les boutons « Ouvrir » n’ont pas de bordure visible',
      o.bord === 'rgba(0, 0, 0, 0)', `bordure = ${o.bord}`);
    verifier('les boutons « Ouvrir » sont en texte discret',
      o.texte === 'rgb(141, 149, 163)', `texte = ${o.texte}`);
  }
}

// ---------------------------------------------------- arrêt sans analyse
if (MODE === 'idle') {
  const requetes = [];
  page.on('request', r => requetes.push(r.url()));
  await page.locator('#stop').click();
  await page.waitForSelector('#stopped:not(.hidden)', { timeout: 5000 });
  verifier('sans analyse, l’arrêt aboutit directement', true, '');
  verifier('aucune boîte de confirmation n’a été posée',
    await page.locator('#smodal.hidden').count() === 1,
    'la modale de confirmation s’est affichée alors qu’aucune analyse ne tournait');

  const avant = requetes.filter(u => u.includes('/api/state')).length;
  // On attend PLUS que la période de veille (4 s). Attendre moins rendrait la
  // vérification décorative : une veille qui continue de battre toutes les 4 s
  // passerait inaperçue dans une fenêtre de 1,6 s.
  await page.waitForTimeout(4600);
  const apres = requetes.filter(u => u.includes('/api/state')).length;
  verifier('après l’arrêt, la veille ne demande plus rien',
    apres === avant, `${apres - avant} requête(s) /api/state partie(s) après l’arrêt`);
}

// ---------------------------------------------------- arrêt pendant une analyse
if (MODE === 'running') {
  // On lance un parcours et on attend l'accusé de réception : à cet instant le
  // serveur a déjà marqué le volume « en cours », donc le refus 409 est certain.
  const attente = page.waitForResponse(r => r.url().includes('/api/scan/'));
  await page.locator('.drive').first().locator('button').click();
  await attente;

  await page.locator('#stop').click();
  await page.waitForSelector('#smodal:not(.hidden)', { timeout: 5000 });
  const texte = await page.locator('#sbody').innerText();
  // « Nomme » doit vouloir dire : dit DE QUEL volume il s'agit. Une phrase
  // générique du type « une analyse est en cours » passerait un test qui se
  // contenterait de chercher les mots « analyse en cours ».
  verifier('la confirmation nomme le volume analysé',
    /[A-Z]: analyse en cours/.test(texte), `texte = ${JSON.stringify(texte.slice(0, 90))}`);
  // Une boîte qui dit « vraiment ? » sans chiffre serait une question vide.
  verifier('la confirmation CHIFFRE ce qui serait perdu',
    /dossiers/.test(texte) && /\d/.test(texte),
    `texte = ${JSON.stringify(texte.slice(0, 90))}`);

  await page.locator('#sdo').click();
  await page.waitForSelector('#stopped:not(.hidden)', { timeout: 5000 });
  verifier('« Arrêter maintenant » arrête bien', true, '');
}

console.log('');
console.log(`${verifs.filter(Boolean).length}/${verifs.length} vérifications vertes`);
if (echecs.length) {
  console.log('ÉCHECS :');
  for (const e of echecs) console.log(`  - ${e}`);
}
await navigateur.close();
process.exitCode = echecs.length ? 1 : 0;
