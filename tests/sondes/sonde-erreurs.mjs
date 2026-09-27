// Sonde de bout en bout : honnêteté des chiffres de diskmap.
//
// Promet, et sort en 1 si l'une manque :
//  1. le bandeau « total incomplet » n'apparaît QUE sur les volumes qui ont des
//     dossiers illisibles, et il porte le nombre exact renvoyé par l'API ;
//  2. l'écart disque/analyse est affiché quand il dépasse le seuil, avec le bon
//     signe, et pas du tout quand il est négligeable ;
//  3. la liste est regroupée par emplacement, et les noms d'enfants couvrent
//     bien tous les chemins reçus ;
//  4. la route /api/reveal refuse un chemin qui ne vient pas de la liste — sans
//     ce contrôle, la page pourrait faire ouvrir n'importe quel chemin ;
//  5. le conseil sur l'élévation correspond à l'état RÉEL de l'instance.
//
// Le point 1 et le point 2 sont ceux qui peuvent échouer en silence : un bandeau
// rendu inconditionnellement, ou un écart affiché sans seuil, passeraient le
// reste sans qu'on le voie.
//
// Usage : node sonde-erreurs.mjs http://127.0.0.1:8800/
// Note : le point 4 ouvre pour de vrai une fenêtre de l'explorateur — c'est le
// seul moyen de prouver que la route ACCEPTE un chemin de la liste. Elle est
// neutralisée par un guetteur (`fenetres.mjs`) lancé AVANT l'appel : minimisée à
// sa naissance, referme aussitot, et jamais une fenêtre que l'utilisateur avait
// ouverte avant. Le 27/09/2026, sans ce guetteur, cette preuve a laissé 33
// fenêtres « Bureau » sur l'écran de l'auteur de ces lignes.

import { chromium } from './navigateur.mjs';
import { URL_DEFAUT } from './config.mjs';
import { surveillerFenetres, mesurer } from './fenetres.mjs';

const URL = process.argv[2] || URL_DEFAUT;

// Convertit un libellé de `hsize` en octets. L'application affiche des unités
// DÉCIMALES (1 Go = 1e9 o), pas des GiB — comparer l'affichage à `octets/2**30`
// fait apparaître un écart de 7,4 % qui n'existe pas. C'est une faute de sonde,
// pas d'application, et elle a coûté une passe le 26/09/2026.
function versOctets(txt) {
  const m = String(txt).match(/(\d+(?:,\d+)?)\s*(To|Go|Mo|Ko|o)\b/);
  if (!m) return NaN;
  return parseFloat(m[1].replace(',', '.')) * { To: 1e12, Go: 1e9, Mo: 1e6, Ko: 1e3, o: 1 }[m[2]];
}

const verifs = [];
const echecs = [];
function verifier(nom, condition, mesure) {
  const ok = !!condition;
  verifs.push(ok);
  if (!ok) echecs.push(`${nom}\n      mesuré : ${mesure}`);
  console.log(`${ok ? 'ok   ' : 'ROUGE'} ${nom}${ok ? '' : `\n      mesuré : ${mesure}`}`);
}

/** Un fait releve, pas une verification : il ne compte ni en vert ni en rouge. */
const notes = [];
function noter(texte) {
  notes.push(texte);
  console.log(`      note : ${texte}`);
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
const page = await ctx.newPage();
const erreursJs = [];
page.on('pageerror', e => erreursJs.push(String(e)));

await page.goto(URL, { waitUntil: 'domcontentloaded' });

// Attendre que C: ait FINI d'être analysé. « Il y a une carte » ne suffit pas :
// la carte existe dès le premier rendu, avec le statut « analyse en cours ».
// Un critère déjà vrai ne fait pas attendre, il fait conclure trop tôt.
await page.waitForFunction(() => {
  const el = document.querySelector('.drive[data-letter="C"]');
  return el && /fichiers/.test(el.textContent);
}, null, { timeout: 180000 });

// L'API est la référence : on compare l'affichage à elle, pas à une constante
// écrite dans la sonde, qui deviendrait fausse à la prochaine analyse.
const ref = await page.evaluate(async () => {
  const etat = await (await fetch('/api/state')).json();
  const unread = {};
  for (const d of etat.drives) {
    const r = await fetch(`/api/unreadable?drive=${d.letter}`);
    if (r.ok) unread[d.letter] = await r.json();
  }
  return { etat, unread };
});
const etat = ref.etat;
const api = ref.unread;
const parLettre = Object.fromEntries(etat.drives.map(d => [d.letter, d]));

console.log(`--- API (eleve=${etat.eleve}) ---`);
for (const l of Object.keys(api).sort()) {
  console.log(`  ${l}: total=${api[l].total} droits=${api[l].droits} sautees=${api[l].skipped} chemins=${api[l].items.length}`);
}

// ---------- 1. le bandeau, et seulement là où il faut ----------
console.log('--- 1. bandeau de total incomplet ---');
let avecIllisible = 0;
for (const l of Object.keys(api).sort()) {
  const total = api[l].total;
  const badge = page.locator(`.drive[data-letter="${l}"] .inc`);
  const n = await badge.count();
  if (total > 0) {
    avecIllisible++;
    verifier(`${l}: le bandeau est affiché (${total} illisibles)`, n === 1, `${n} bandeau(x)`);
    if (n === 1) {
      const txt = (await badge.innerText()).replace(/\s+/g, ' ').trim();
      const affiche = parseInt(txt.replace(/[^0-9]/g, ''), 10);
      verifier(`${l}: le nombre affiché est celui de l'API`, affiche === total,
        `affiché « ${txt} » → ${affiche}, API → ${total}`);
    }
  } else {
    verifier(`${l}: aucun bandeau (volume lu en entier)`, n === 0,
      `${n} bandeau(x) alors que l'API annonce 0 illisible`);
  }
}
verifier('au moins un volume a des illisibles — sinon la sonde ne teste rien',
  avecIllisible > 0, 'aucun volume avec total > 0');

// ---------- 2. l'écart disque / analyse ----------
console.log('--- 2. écart disque / analyse ---');
let avecEcart = 0;
let sansEcart = 0;
for (const l of Object.keys(parLettre).sort()) {
  const d = parLettre[l];
  if (d.status !== 'ready' || !d.total) continue;
  const used = d.total - d.free;
  const ecart = used - d.root_size;
  const seuil = Math.min(d.root_size * 0.005, 20 * 2 ** 20);
  const attendu = Math.abs(ecart) > seuil;
  const ligne = page.locator(`.drive[data-letter="${l}"] .gap`);
  const n = await ligne.count();
  if (attendu) {
    avecEcart++;
    verifier(`${l}: l'écart est affiché (${(ecart / 1e9).toFixed(2)} Go, seuil dépassé)`, n === 1,
      `${n} ligne(s) d'écart alors que |${ecart}| > seuil ${Math.round(seuil)}`);
    if (n === 1) {
      const cls = await ligne.getAttribute('class');
      const veutPos = ecart > 0;
      verifier(`${l}: le signe est ${veutPos ? 'positif (part invisible)' : 'négatif (on compte trop)'}`,
        cls.includes(veutPos ? 'pos' : 'neg'),
        `classes « ${cls} », écart ${ecart > 0 ? '+' : ''}${ecart}`);
      // On lit le montant dans la seule colonne des valeurs, puis on le ramène
      // en octets : comparer deux affichages entre eux ne prouverait rien sur le
      // chiffre réel.
      const txt = (await ligne.locator('.v').innerText()).trim();
      const affiche = versOctets(txt);
      const attenduOctets = Math.abs(ecart);
      verifier(`${l}: le montant affiché vaut l'écart réel en octets`,
        Math.abs(affiche - attenduOctets) <= Math.max(5e6, attenduOctets * 0.01),
        `affiché « ${txt} » = ${Math.round(affiche)} o, attendu ${attenduOctets} o`);
      const signeAffiche = txt.includes('\u2212') ? -1 : 1;
      verifier(`${l}: le signe affiché est celui de l'écart`, signeAffiche === Math.sign(ecart),
        `affiché « ${txt} », écart ${ecart}`);
    }
  } else {
    sansEcart++;
    verifier(`${l}: aucun écart affiché (négligeable)`, n === 0,
      `${n} ligne(s) d'écart alors que |${ecart}| ≤ seuil ${Math.round(seuil)}`);
  }
}
verifier('au moins un volume dépasse le seuil — sinon la sonde ne teste rien',
  avecEcart > 0, 'aucun volume avec un écart significatif');
// Le seuil n'est PAS exercé dans les deux sens sur toutes les machines. Le
// 26/09/2026, les quatre volumes de cette machine dépassaient le seuil : la
// branche « écart négligeable » n'a donc jamais tourné, et son vert ne prouvait
// rien. On le dit, plutôt que de compter une assertion vide comme une preuve.
if (sansEcart === 0) {
  console.log(`      note : branche « écart négligeable » NON exercée — ` +
    `${avecEcart} volume(s), tous au-dessus du seuil. Ce vert-là ne prouve rien.`);
}

// ---------- 3. regroupement et actions ----------
console.log('--- 3. liste regroupée ---');
const cible = Object.keys(api).sort((a, b) => api[b].total - api[a].total)[0];
if (api[cible].total > 0) {
  await page.locator(`.drive[data-letter="${cible}"] .inc`).click();
  await page.waitForSelector('#ubody .plist .grp', { timeout: 20000 });

  const attendu = new Set();
  for (const it of api[cible].items) {
    let p = it.path.replace(/\\[^\\]*$/, '') || it.path;
    if (/^[A-Za-z]:$/.test(p)) p += '\\';
    attendu.add(p);
  }
  const groupes = await page.locator('#ubody .plist .grp').count();
  verifier(`la liste est regroupée (${api[cible].items.length} chemins → ${attendu.size} emplacements)`,
    groupes === attendu.size, `${groupes} groupe(s) affiché(s), ${attendu.size} attendu(s)`);

  // Les noms d'enfants doivent couvrir tous les chemins : un regroupement qui
  // perd des entrées serait pire qu'une liste plate.
  const nomsAffiches = (await page.locator('#ubody .plist .gk').allInnerTexts()).join(', ');
  const manquants = api[cible].items
    .map(i => i.path.split('\\').pop())
    .filter(n => !nomsAffiches.includes(n));
  verifier('aucun chemin perdu par le regroupement', manquants.length === 0,
    `${manquants.length} nom(s) absent(s) de la liste, ex. « ${manquants[0] || ''} »`);

  const entete = (await page.locator('#ubody').innerText()).replace(/\s+/g, ' ');
  verifier('l\'en-tête annonce le nombre d\'emplacements',
    new RegExp(`${attendu.size} emplacement`).test(entete), entete.slice(0, 150));

  // ---------- 4. la route de révélation ----------
  const horsListe = 'C:\\chemin\\absent\\de\\la\\liste';
  const statutRefus = await page.evaluate(async p => {
    const r = await fetch('/api/reveal', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Diskmap': '1' },
      body: JSON.stringify({ drive: 'C', path: p }),
    });
    return r.status;
  }, horsListe);
  verifier('un chemin hors liste est refusé', statutRefus === 400,
    `statut ${statutRefus}, attendu 400 — la route ouvrirait n'importe quel chemin`);

  // Le chemin de la liste est ACCEPTÉ — donc l'Explorateur s'ouvre pour de bon,
  // comme pour un vrai clic. Le guetteur est lancé AVANT l'appel, jamais après :
  // après, la fenêtre aurait déjà volé le focus, et c'est exactement ce qu'on
  // veut éviter. Il ne ferme que les fenêtres nées sous ses yeux — celles de
  // l'utilisateur ne sont pas dans son instantané et ne sont jamais touchées.
  const guet = surveillerFenetres();
  const premier = api[cible].items[0].path;
  const statutOk = await page.evaluate(async p => {
    const r = await fetch('/api/reveal', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Diskmap': '1' },
      body: JSON.stringify({ drive: 'C', path: p }),
    });
    return r.status;
  }, premier);
  const rapport = await guet.arreter();
  verifier('un chemin de la liste est accepté (et l’Explorateur s’ouvre)', statutOk === 200,
    `statut ${statutOk} pour « ${premier} »`);
  // Le geste du serveur est correct même si le ramasse-miettes a échoué : les deux
  // faits sont distincts, et confondre les deux ferait rater un vrai défaut.
  if (!rapport.neutre) {
    noter('NE PAS MESURABLE — le guetteur de fenêtres n’a rien pu dire : '
      + rapport.raison);
  } else {
    verifier('la révélation ne laisse aucune fenêtre à l’écran', rapport.fermees === rapport.neutralisees,
      mesurer(rapport));
  }

  // ---------- 5. le conseil sur l'élévation ----------
  const corps = (await page.locator('#ubody').innerText()).replace(/\s+/g, ' ');
  if (api[cible].droits > 0) {
    if (etat.eleve) {
      verifier('élevé : la modale dit que relancer ne changerait rien',
        /déjà en administrateur/.test(corps), corps.slice(0, 200));
      verifier('élevé : la modale ne promet PAS que relancer aiderait',
        !/les rendrait lisibles/.test(corps), corps.slice(0, 200));
    } else {
      verifier('non élevé : la modale promet que relancer aiderait',
        /les rendrait lisibles/.test(corps), corps.slice(0, 200));
      verifier('non élevé : la modale ne prétend pas être déjà administrateur',
        !/déjà en administrateur/.test(corps), corps.slice(0, 200));
    }
  }

  // ---------- copie ----------
  await page.locator('#ucopy').click();
  await page.waitForTimeout(200);
  const libelle = await page.locator('#ucopy').innerText();
  verifier('le bouton confirme la copie', /copi/i.test(libelle), `libellé « ${libelle} »`);
  const presse = await page.evaluate(() => navigator.clipboard.readText());
  const lignes = presse.split('\r\n').filter(Boolean);
  verifier('le presse-papier contient tous les chemins', lignes.length === api[cible].items.length,
    `${lignes.length} ligne(s) copiée(s), ${api[cible].items.length} attendue(s)`);

  await page.locator('#uclose').click();
  verifier('la modale se ferme', await page.locator('#umodal.hidden').count() === 1,
    'toujours ouverte après « Fermer »');
}

// ---------- l'état d'élévation affiché ----------
const chip = (await page.locator('#eleve').innerText()).replace(/\s+/g, ' ').trim();
verifier('l\'état d\'élévation affiché correspond à l\'API',
  etat.eleve ? /administrateur/.test(chip) : /utilisateur/.test(chip),
  `affiché « ${chip} », API eleve=${etat.eleve}`);

verifier('aucune erreur JavaScript', erreursJs.length === 0, erreursJs.join(' | ') || 'aucune');

await browser.close();

const reussies = verifs.filter(Boolean).length;
console.log(`\n${reussies}/${verifs.length} vérifications passent`);
if (echecs.length) {
  console.log('\nÉchecs :');
  for (const e of echecs) console.log(`  - ${e}`);
}
if (notes.length) {
  console.log('\nNotes :');
  for (const n of notes) console.log(`  - ${n}`);
}
process.exitCode = echecs.length ? 1 : 0;
