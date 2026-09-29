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
// ---------------------------------------------------------------------------
// LES TROIS MODES SONT EXERCES — 29/09/2026
//
// Jusqu'à ce jour, `lancer.mjs` n'invoquait ce fichier qu'en mode `styles` : les
// points 4, 5 et 6 ci-dessus, et le contrôle de `scan_running` à l'arrêt, étaient
// du code écrit et jamais exécuté. La raison était structurelle — le mode
// `running` appelle `POST /api/quit`, qui aurait tué le serveur unique du
// harnais — et elle n'était dite nulle part. La sonde annonçait 9/9 comme si elle
// avait tout mesuré.
//
// `lancer.mjs` donne désormais son propre serveur à ces deux modes
// (`serveurDedie`). Le binaire ne verrouille que par port, vérifié et non
// supposé : deux instances peuvent coexister, et c'est ce qui rend la mesure
// possible sans tuer l'instrument.
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
  const lire = () => page.evaluate(async () => {
    try {
      const r = await fetch('/api/state', { headers: { 'X-Diskmap': '1' } });
      return r.ok ? await r.json() : null;
    } catch { return null; }
  });

  // On lance un parcours et on attend l'accusé de réception : à cet instant le
  // serveur a déjà marqué le volume « en cours », donc le refus 409 est certain.
  const attente = page.waitForResponse((r) => r.url().includes('/api/scan/'));
  await page.locator('.drive').first().locator('button').click();
  await attente;

  // --- ce que le serveur publie PENDANT l'analyse ----------------------------
  //
  // La capture se fait ICI, dans la boucle qui suit la demande, et jamais apres.
  // Deux raisons, et la seconde vient de ce fichier :
  //
  // 1. Lue apres coup, une analyse deja terminee ne laisse que son instantane ;
  //    l'absence se lirait « l'analyse en vol n'existe pas » — un verdict faux
  //    sur un defaut qui n'y est pas. Le 28/09, `sonde-tickets` a commis
  //    exactement cette erreur.
  //
  // 2. Interroger l'etat APRES `/api/quit` ne prouve rien : le serveur est mort,
  //    la requete echoue, et la verification passait quoi qu'il arrive. Elle ne
  //    pouvait pas rougir. Une verification qui ne peut pas echouer n'en est pas
  //    une — et celle que ce fichier portait le 29/09 en etait une. Elle
  //    affirmait un invariant qu'aucune panne du serveur n'aurait pu contredire.
  //
  // Le tri n'est pas « vu / pas vu » : c'est « vu / le serveur analyse sans
  // publier / l'analyse a fini ». `scanning` est le fait indépendant : il dit
  // qu'une analyse court, sans dépendre du numéro. Sans lui, neutraliser la
  // publication ne faisait pas ROUGE — la sonde croyait à un volume trop rapide
  // et passait en 3/3. C'est mesuré : garde neutralisée, sortie 0. Une
  // vérification qui se dégonfle en note quand on lui retire ce qu'elle prouve
  // n'est pas une vérification.
  let annonce = 0;
  let enCours = false;
  let lettre = null;
  let affiche = '';
  for (let i = 0; i < 40; i++) {
    const etat = await lire();
    // `scanning` n'est pas un booleen : c'est la LETTRE du volume en cours, et
    // `null` quand rien ne tourne. Mesure : `scanning = 'C'` pendant l'analyse de
    // C:. Comparer a `true` ne pouvait donc jamais etre vrai — et `d.scanning`, par
    // volume, vaut toujours `null` : les deux sont des predicats impossibles, et
    // le second fait croire a un fait disponible.
    lettre = typeof etat?.scanning === 'string' ? etat.scanning : null;
    enCours = lettre !== null;
    annonce = Math.max(0, ...(etat?.drives || []).map((d) => d.scan_running || 0));
    if (enCours || annonce > 0) {
      affiche = await page.locator('.drive').first().innerText();
      break;
    }
    await page.waitForTimeout(50);
  }

  // « analyse en cours… » passerait aussi, et ne prouverait rien : c'est le
  // libelle du cas ou le serveur ne publie AUCUNE analyse. Le NUMERO est ce qui
  // distingue une analyse en vol d'un texte d'interface. Neutraliser la
  // publication du ticket fait donc passer cette verification au rouge — ce que
  // la version precedente ne pouvait pas faire.
  const prefixe = 'analyse n°';
  const i = affiche.indexOf(prefixe);
  const nombre = i < 0 ? NaN : Number(affiche.slice(i + prefixe.length).split(' ')[0]);
  const mesure = `scanning = ${lettre === null ? 'aucun' : lettre}`
    + `, scan_running = ${annonce},`
    + ` écran = ${JSON.stringify(affiche.slice(0, 110))}`;

  if (annonce > 0) {
    verifier('le serveur publie le numéro de l’analyse en vol',
      Number.isFinite(nombre) && nombre > 0, mesure);
  } else if (enCours) {
    // Le fait est établi — une analyse court — et le numéro manque. C'est un
    // défaut de l'application, pas une limite de la mesure : l'écran ne peut
    // alors distinguer une analyse de la précédente, et rien ne dit à l'utilisateur
    // laquelle il attend.
    verifier('le serveur publie le numéro de l’analyse en vol', false, mesure);
  } else {
    console.log('note : l’analyse s’est terminée avant d’être observée sur ce volume — structurel : le volume est trop rapide pour qu’un scan en vol soit observable'
      + ' (trop rapide) — la publication du numéro en vol non exercée ici');
  }

  await page.locator('#stop').click();
  await page.waitForSelector('#smodal:not(.hidden)', { timeout: 5000 });
  const texte = await page.locator('#sbody').innerText();
  // « Nomme » doit vouloir dire : dit DE QUEL volume il s'agit. Une phrase
  // generique du type « une analyse est en cours » passerait un test qui se
  // contenterait de chercher les mots « analyse en cours ».
  verifier('la confirmation nomme le volume analysé',
    /[A-Z]: analyse en cours/.test(texte), `texte = ${JSON.stringify(texte.slice(0, 90))}`);
  // Une boite qui dit « vraiment ? » sans chiffre serait une question vide.
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
