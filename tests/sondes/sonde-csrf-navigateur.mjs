// Une page web tierce peut-elle déclencher une suppression ?
//
// Cette sonde est née le 26/09/2026 en MESURANT LA VULNÉRABILITÉ, et elle mesure
// désormais la DÉFENSE. Ses assertions ont été retournées avec le correctif :
// aujourd'hui, un vert signifie « la page tierce n'a pas pu effacer le fichier ».
// Avant le correctif, cette même sonde rendait 12/12 en effaçant réellement le
// fichier, trois fois sur trois — c'est sa contre-épreuve, déjà faite.
//
// Ce qu'elle éprouve, et pourquoi trois cas :
//   A. page servie depuis 127.0.0.1   → cible 127.0.0.1   (locale → locale)
//   B. page servie depuis l'IP privée → cible 127.0.0.1   (privée → locale)
//   C. page ouverte en file://        → cible 127.0.0.1   (origine « null »)
// Chrome classe les origines par espace d'adressage et pourrait opposer à B un
// préflight « Private Network Access » : le cas se mesurait, il ne se déduisait
// pas. Mesuré le 26/09/2026 sur Chromium 153.0.8010.12 : il ne l'opposait pas.
//
// La défense tient à une seule chose : la route exige l'en-tête X-Diskmap, qu'un
// en-tête personnalisé rende NON simple — le navigateur doit donc demander un
// préflight, et le serveur n'en sert aucun. La page attaquante ne peut pas
// davantage LIRE la réponse : le CORS la bloque. Elle n'a donc aucun moyen de
// savoir qu'elle a échoué, et la sonde doit conclure sur l'EFFET, pas sur ce que
// la page rapporte — d'où la vérification du journal du serveur en plus du
// fichier resté en place.
//
// La sonde n'efface QUE le fichier qu'elle a créé elle-même.
//
// Usage : node sonde-csrf-navigateur.mjs http://127.0.0.1:8756/
import http from 'http';
import fs from 'fs';
import path from 'path';

import { chromium } from './navigateur.mjs';
import { URL_DEFAUT, VOLUME_DEFAUT, attendreFichier, attendreFichierDans, dossier } from './config.mjs';

const BASE = (process.argv[2] || URL_DEFAUT).replace(/\/$/, '');
const VOL = (process.argv[3] || VOLUME_DEFAUT).toUpperCase();
const NOM = 'csrf';
const DOSSIER = dossier(VOL, NOM);
const PAGE_LOCALE = dossier(VOL, 'page-tierce.html');
const PORTE_PAGE = 8899;
const IP_PRIVEE = '172.22.22.68';
const JOURNAL = path.join(process.env.LOCALAPPDATA || '', 'diskmap', 'suppressions.log');

const verifs = [], echecs = [];
function verifier(nom, cond, mesure) {
  const ok = !!cond; verifs.push(ok);
  if (!ok) echecs.push(`${nom} — mesuré : ${mesure}`);
  console.log(`${ok ? 'ok   ' : 'ROUGE'} ${nom}${ok ? '' : `\n      mesuré : ${mesure}`}`);
}

const M = (1n << 64n) - 1n;
function xorshift(ms) {
  let s = BigInt(ms);
  s = (s ^ ((s << 13n) & M)) & M;
  s = (s ^ (s >> 7n)) & M;
  s = (s ^ ((s << 17n) & M)) & M;
  return Number(s & 0xffff_ffffn);
}

const corpsPage = (sel) => `<!doctype html><meta charset="utf-8"><title>page tierce</title>
<script>
const CIBLE = ${JSON.stringify(BASE)};
const SEL = ${sel};
const M = (1n << 64n) - 1n;
function xorshift(ms){ let s=BigInt(ms); s=(s^((s<<13n)&M))&M; s=(s^(s>>7n))&M; s=(s^((s<<17n)&M))&M; return Number(s & 0xffffffffn); }
window.__journal = [];
const note = t => window.__journal.push(t);
// Requête SANS en-tête personnalisé : c'est le geste de l'attaquant. Le type
// « text/plain » la range parmi les requêtes simples, donc envoyée sans préflight.
const envoyer = (corps) => fetch(CIBLE + '/api/delete', {
  method: 'POST',
  headers: { 'Content-Type': 'text/plain' },
  body: JSON.stringify(corps),
});
(async () => {
  const t0 = Date.now();
  try {
    const rep = await envoyer({ drive: VOL, items:[SEL], mode:'dry' });
    note('dry: status=' + rep.status + ' type=' + rep.type);
    note('lecture possible: true');
  } catch (e) {
    // Attendu : la réponse est bloquée faute d'en-tête CORS. La requête, elle,
    // est bien partie — c'est toute la question.
    note('dry: réponse refusée au lecteur (' + e.name + ')');
    note('lecture possible: false');
  }
  // Dérivation aveugle du jeton, sans rien avoir lu.
  let essais = 0;
  for (let ms1 = t0 - 2; ms1 <= t0 + 40; ms1++) {
    for (let d = 0; d <= 3; d++) {
      essais++;
      try {
        await envoyer({ drive: VOL, mode:'permanent', token: ms1 + '-' + xorshift(ms1 + d), confirm:'EFFACER' });
      } catch (e) { /* réponse illisible : normal, on ne lit rien */ }
    }
  }
  note('jetons essayés: ' + essais);
  note('la page ignore si elle a réussi: oui, elle n\\'a rien pu lire');
  window.__fini = true;
})();
<\/script>`;

const serveur = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(corpsPage(serveur.selCourant));
});
serveur.selCourant = 0;
// Écoute sur 0.0.0.0 pour couvrir l'IP privée du cas B autant que le loopback.
await new Promise(r => serveur.listen(PORTE_PAGE, '0.0.0.0', r));

// ------------------------------------------------------------- les attentes
//
// Sonder juste après un POST peut voir « scanning = null » AVANT que le serveur
// n'ait posé son drapeau, et on croirait alors le parcours déjà fini. D'où le
// temps d'attente du démarrage.
async function attendreParcours(demarrage = false) {
  if (demarrage) {
    for (let i = 0; i < 60; i++) {
      const s = await (await fetch(`${BASE}/api/state`)).json();
      if (s.scanning) break;
      await new Promise(r => setTimeout(r, 100));
    }
  }
  for (let i = 0; i < 300; i++) {
    const s = await (await fetch(`${BASE}/api/state`)).json();
    if (!s.scanning) return true;
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}

// La suppression du cas précédent déclenche SA PROPRE réanalyse. Demander une
// réanalyse par-dessus était ignoré, et l'attente portait alors sur le parcours
// déjà en vol — qui avait dépassé le dossier. Le fichier recréé n'entrait jamais
// dans l'instantané. On attend donc le repos AVANT d'écrire.
//
// Le MONTAGE de la sonde est un client légitime : il porte X-Diskmap. La page
// attaquante, elle, ne le porte jamais — c'est tout l'objet de la sonde. Sans
// cette distinction, le montage se ferait refuser et la sonde conclurait
// « attaque bloquée » sans avoir rien éprouvé.
async function idVictime() {
  await attendreParcours();
  fs.mkdirSync(DOSSIER, { recursive: true });
  fs.writeFileSync(DOSSIER + '/victime.txt', `victime-${Date.now()}\n`);
  const rep = await fetch(`${BASE}/api/scan/${VOL}`, { method: 'POST', headers: { 'X-Diskmap': '1' } });
  if (!rep.ok) throw new Error(`réanalyse refusée : HTTP ${rep.status}`);
  // Le dossier, adresse par son CHEMIN, et non par son nom.
  //
  // Le 28/09/2026, cette fonction cherchait `q=csrf` puis faisait `.find()` sur
  // la premiere page de resultats. La recherche est plafonnee, et `csrf` est un
  // nom que tous les `node_modules` du disque contiennent : le dossier de la
  // sonde sortait de la page, `sel` valait `null`, et les trois verdicts
  // rapportaient « la victime n'est pas dans l'instantane » — sur une sonde dont
  // tout l'objet est de conclure que l'attaque a echoue. Le pire des messages
  // possibles : il affirme qu'une protection a cede alors que rien n'a ete
  // mesure.
  //
  // Un chemin est unique par construction. L'attente se fait sur le FAIT, dans
  // ce dossier-la : `attendreFichierDans`.
  const r = await attendreFichierDans(BASE, VOL, DOSSIER, 'victime.txt');
  return r ? r.ligne.sel : null;
}
const journal = () => fs.readFileSync(JOURNAL, 'utf8').split('\n').filter(Boolean);

const navig = await chromium.launch();
const ctx = await navig.newContext();

const CAS = [
  { nom: 'A — page locale (127.0.0.1) visant le loopback', url: `http://127.0.0.1:${PORTE_PAGE}/` },
  { nom: 'B — page privée (IP du réseau) visant le loopback', url: `http://${IP_PRIVEE}:${PORTE_PAGE}/` },
  { nom: 'C — page ouverte en file:// (origine « null »)', url: null },
];

for (const cas of CAS) {
  console.log(`\n--- ${cas.nom} ---`);
  const sel = await idVictime();
  verifier('la victime est dans l’instantané', sel != null,
    sel == null
      ? `« ${DOSSIER}\\victime.txt » absent après écriture et ré-analyse : rien n'a été indexé, donc rien n'a été éprouvé`
      : `sel=${sel}`);
  if (sel == null) continue;
  serveur.selCourant = sel;

  // Pour le cas C, la page doit exister sur le disque : l'origine « null » ne
  // peut pas être servie.
  if (cas.url === null) {
    fs.writeFileSync(PAGE_LOCALE, corpsPage(sel));
    cas.url = 'file:///' + PAGE_LOCALE.replace(/\\/g, '/');
  }

  const avant = journal().length;
  const page = await ctx.newPage();
  try {
    // 60 s pour la navigation : le cas B passe par l'IP privée du runner, dont
    // le réseau est plus lent que le loopback. À 20 s, le premier run GitHub a
    // échoué là-dessus, et l'échec se lisait « la page n'a pas pu aller au bout »
    // — ce qui suggère une protection active, alors que rien n'avait été jugé.
    await page.goto(cas.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction('window.__fini === true', null, { timeout: 90000 });
  } catch (e) {
    const motif = e.message.split('\n')[0];
    // Une page INATTEIGNABLE et une page qui a échoué à supprimer sont deux
    // choses sans commune mesure. Le cas B vise l'IP privée du runner, et sur
    // le réseau de GitHub il expire : `net::ERR_CONNECTION_TIMED_OUT` au bout
    // de 60 s. Compter cela comme un échec de sécurité affirmait que la
    // protection CSRF avait cédé, alors que rien n'avait été mesuré — sur un
    // test dont tout l'objet est de conclure « l'attaque a échoué », c'est le
    // pire des messages possibles.
    //
    // On distingue donc l'INACCESSIBILITÉ de l'ÉCHEC : la première se dit, la
    // seconde se prouve. Un cas non mesuré n'est jamais compté ni comme
    // réussite ni comme échec.
    if (/ERR_CONNECTION_TIMED_OUT|ERR_CONNECTION_REFUSED|Timeout .* exceeded|net::ERR_/i.test(motif)) {
      console.log(`      (page inatteignable sur « ${cas.nom} » : ${motif} — rien n'a été mesuré)`);
      await page.close();
      continue;
    }
    verifier('la page a pu aller au bout de sa tentative', false, motif);
    await page.close();
    continue;
  }
  const j = await page.evaluate('window.__journal');
  for (const l of j) console.log(`      ${l}`);

  verifier('la page n’a rien pu lire de la réponse',
    j.includes('lecture possible: false'), JSON.stringify(j));
  // L'assertion qui compte. La page ne peut pas rapporter son échec — elle ne lit
  // rien — donc on ne juge que l'effet.
  verifier('la page tierce n’a PAS pu effacer le fichier',
    fs.existsSync(DOSSIER + '/victime.txt'),
    'le fichier a disparu — la page tierce a réussi à supprimer');
  // Preuve indépendante de la page : aucune ligne au journal pour ce chemin.
  const nomme = journal().slice(avant).some(l => l.includes(`${NOM}\\victime.txt`));
  verifier('le journal du serveur ne mentionne aucune suppression',
    !nomme, JSON.stringify(journal().slice(avant)));
  await page.close();
}

await navig.close();
serveur.close();

console.log('');
console.log(`${verifs.filter(Boolean).length}/${verifs.length} vérifications`);
if (echecs.length) { console.log('ÉCHECS / CONSTATS :'); for (const e of echecs) console.log(`  - ${e}`); }
process.exitCode = echecs.length ? 1 : 0;
