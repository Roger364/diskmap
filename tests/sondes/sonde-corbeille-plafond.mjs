// La corbeille tient-elle sa promesse, une fois MESURÉE plutôt que supposée ?
//
// « Récupérable par défaut » était, jusqu'au 27/09/2026, la seule affirmation
// du projet qui ne reposait sur aucune mesure. Le serveur relève désormais le
// plafond du volume (registre, `MaxCapacity`) et son occupation (les tailles que
// déclarent les fiches `$I`), puis annonce si le lot tient.
//
// Cette sonde éprouve l'ANNONCE, pas la promesse : elle ne supprime rien. Elle
// vérifie que les trois nombres rendus par l'aperçu sont COHÉRENTS entre eux —
// que `corbeille_deborde` est exactement l'inégalité `occupe + lot > plafond`,
// et rien d'autre. Une annonce qui mentirait sur un seul de ces trois la ferait
// rougir ici.
//
// La branche de débordement exige un lot plus gros que le plafond, ce qui
// suppose d écrire sur le disque. C est borné : au-delà de 256 Mio — et c est le
// cas du volume jetable de la CI, dont la corbeille est plus large que cette
// borne — la sonde se contente de vérifier la cohérence et ÉCRIT SON AVEU dans le
// dialecte du registre : marque, justification, et le nombre de verdicts que le
// trou coûte, car c est ce nombre qui détend le plancher. Elle ne simule pas, ne
// prétend pas avoir éprouvé, et ne peut pas le faire dire à sa place.
//
// Usage : node sonde-corbeille-plafond.mjs http://127.0.0.1:8990/ V
import fs from 'fs';

import { dossier, racine, URL_DEFAUT } from './config.mjs';

const BASE = (process.argv[2] || URL_DEFAUT).replace(/\/$/, '');
const VOL = (process.argv[3] || 'V').toUpperCase();
const DOSSIER = dossier(VOL, 'plafond');
const H = { 'Content-Type': 'application/json', 'X-Diskmap': '1' };
const Mio = 1048576;

const verifs = [], echecs = [];
function verifier(nom, condition, mesure) {
  const ok = !!condition;
  verifs.push(ok);
  if (!ok) echecs.push(`${nom} — mesuré : ${mesure}`);
  console.log(`${ok ? 'ok   ' : 'ROUGE'} ${nom}${ok ? '' : `\n      mesuré : ${mesure}`}`);
}

// Une note est un AVEU : elle dit noir sur blanc que ce vert ne prouve pas ce
// qu il a l air de prouver. Deux conditions, et deux seulement, la rendent
// VISIBLE. Une marque que le collecteur reconnait : non exercee, ne prouve rien,
// non mesurable. Une justification : structurel : ... ou couvert par ... . Sans
// la marque, le harnais classe la ligne en « explication » et l avale ; sans la
// justification, il la classe « aveu nu » et rougit. Ni l un ni l autre ne se voit
// si la sonde elle-meme ne le dit pas, parce que sur un run vert sa sortie ne sort
// pas. D ou le controle ci-dessous : il compte dans le plancher de la sonde, et il
// rougit sur place, la ou aucune collecte a posteriori ne peut plus rien voir.
// C est la seule garde de ce fichier que personne ne regarde ailleurs.
const MOT_AVEU = /ne prouve rien|non exerc[ée]e?|ne pas mesurable|non mesurable/i;
const MARQUE_JUSTIF = /structurel\s*:\s*.{12,}|couvert par\s+\S+\.mjs\s*:/;
function noter(texte) {
  const plat = texte.replace(/\s+/g, ' ').trim();
  const marque = MOT_AVEU.test(plat);
  const justifie = MARQUE_JUSTIF.test(plat);
  verifier('l aveu est ecrit dans le dialecte que le harnais sait lire',
    marque && justifie,
    `marque=${marque} justification=${justifie} sur « ${plat.slice(0, 110)} »`);
  // UNE SEULE LIGNE dans la sortie, toujours : le collecteur lit ligne a ligne,
  // et une justification repoussee a la ligne suivante se retrouve seule sur
  // une ligne que personne ne recolle. D ou les tableaux ci-dessous, dont
  // noter() recolle les morceaux : l erreur y serait locale et nommee.
  console.log(`      note : ${plat}`);
}

const post = (c, corps) => fetch(BASE + c, {
  method: 'POST', headers: H, body: JSON.stringify(corps),
}).then(async r => ({ status: r.status, j: await r.json().catch(() => null) }));

async function attendre() {
  for (let i = 0; i < 300; i++) {
    const s = await (await fetch(`${BASE}/api/state`)).json();
    if (!s.scanning) return;
    await new Promise(r => setTimeout(r, 300));
  }
}

// Un `dry` sur un dossier de la sonde : rien n'est supprimé, un jeton est
// simplement rendu. Le dossier doit exister et être VIDE, sinon les sélecteurs
// viseraient autre chose.
async function apercuSur(nom) {
  const t = await (await fetch(`${BASE}/api/tree?drive=${VOL}&id=0&limit=200`)).json();
  const sonde = t.rows.find(r => r.name === racine(VOL).split('/').pop());
  if (!sonde) return { erreur: 'dossier de sondes absent' };
  const l2 = await (await fetch(`${BASE}/api/tree?drive=${VOL}&id=${sonde.id}&limit=200`)).json();
  const d = l2.rows.find(r => r.name === nom);
  if (!d) return { erreur: `dossier ${nom} absent de l'instantané` };
  const l3 = await (await fetch(`${BASE}/api/tree?drive=${VOL}&id=${d.id}&limit=200`)).json();
  const r = await post('/api/delete', {
    drive: VOL, items: l3.rows.map(x => x.sel), mode: 'dry', gen: l3.gen,
  });
  return { j: r.j, lignes: l3.rows };
}

function cohérent(j) {
  // Le seul contrat : `deborde` est l'inégalité, ou `null` si le plafond n'a
  // pas pu être mesuré. Rien d'autre n'est admis.
  if (j.corbeille_plafond == null) return j.corbeille_deborde === null;
  return j.corbeille_deborde === (j.corbeille_occupe + j.total_size > j.corbeille_plafond);
}

fs.rmSync(DOSSIER, { recursive: true, force: true });
fs.mkdirSync(DOSSIER, { recursive: true });
await attendre();
await post(`/api/scan/${VOL}`, {});
await attendre();

// --- 1. un lot minuscule, sur une corbeille qu'on ne sait pas encore ---------
fs.writeFileSync(`${DOSSIER}/petit.txt`, 'x');
const petit = await apercuSur('plafond');
if (petit.erreur) {
  verifier('l’aperçu d’un lot minuscule répond', false, petit.erreur);
} else {
  const j = petit.j;
  verifier('l’aperçu publie les trois mesures',
    'corbeille_plafond' in j && 'corbeille_occupe' in j && 'corbeille_deborde' in j,
    Object.keys(j).filter(k => k.startsWith('corbeille')).join(', ') || 'aucune');
  verifier('les trois mesures se tiennent entre elles',
    cohérent(j),
    `plafond=${j.corbeille_plafond} occupe=${j.corbeille_occupe} lot=${j.total_size} `
    + `deborde=${j.corbeille_deborde}`);
  if (j.corbeille_plafond == null) {
    console.log(`      ${VOL} : plafond NON MESURÉ — la sonde ne peut rienjuger sur ce volume`);
  } else {
    console.log(`      ${VOL} : plafond ${(j.corbeille_plafond / Mio).toFixed(1)} Mio, `
      + `occupé ${(j.corbeille_occupe / Mio).toFixed(1)} Mio, complet=${j.corbeille_complet}`);
    const ecarte = (j.corbeille_occupe + j.total_size) > j.corbeille_plafond;
    verifier('un lot minuscule ne fait pas déborder une corbeille de 51 Mio',
      j.corbeille_deborde === ecarte, `déborde=${j.corbeille_deborde}, calcul=${ecarte}`);
  }
}

// --- 2. la branche du débordement, si elle est atteignable sans abusive ------
const plafond = petit.j && petit.j.corbeille_plafond;
if (plafond == null) {
  noter([
    'branches du débordement NON EXERCÉE — plafond non mesurable',
    '— structurel : le plafond de corbeille n est pas mesurable sur ce volume,',
    'donc la loi du débordement ne peut pas y etre éprouvée ; ce trou coûte',
    '4 verdicts à cette sonde, et le plancher les compte comme non écrits',
  ].join(' '));
} else if (plafond > 256 * Mio) {
  noter([
    'branches du débordement NON EXERCÉE — plafond au-delà de la borne',
    ` d écriture de 256 Mio (mesuré : ${(plafond / Mio).toFixed(0)} Mio sur ${VOL})`,
    '— structurel : les exercer exigerait d écrire plus que la borne',
    'd écriture de cette sonde ; ce trou coûte 3 verdicts à cette sonde,',
    'et le plancher les compte comme non écrits',
  ].join(' '));
} else {
  // On vise le plafond par un unique fichier, et on efface le petit lot : le
  // dossier doit contenir exactement ce qu'on veut mesurer.
  fs.rmSync(`${DOSSIER}/petit.txt`, { force: true });
  const cible = plafond + Mio;
  fs.writeFileSync(`${DOSSIER}/gros.bin`, Buffer.alloc(cible, 0x50));
  console.log(`      écrit ${(cible / Mio).toFixed(1)} Mio pour un plafond de `
    + `${(plafond / Mio).toFixed(1)} Mio`);
  await post(`/api/scan/${VOL}`, {});
  await attendre();
  const gros = await apercuSur('plafond');
  if (gros.erreur) {
    verifier('l’aperçu d’un lot débordant répond', false, gros.erreur);
  } else {
    const j = gros.j;
    verifier('un lot plus gros que le plafond est ANNONCÉ comme débordant',
      j.corbeille_deborde === true,
      `plafond=${j.corbeille_plafond} lot=${j.total_size} deborde=${j.corbeille_deborde}`);
    verifier('et l announcement reste cohérente',
      cohérent(j),
      `occupe=${j.corbeille_occupe} lot=${j.total_size} plafond=${j.corbeille_plafond}`);
    verifier('le lot annoncé correspond bien aux octets écrits',
      j.total_size === cible,
      `annoncé ${j.total_size}, écrit ${cible}`);
  }
  fs.rmSync(`${DOSSIER}/gros.bin`, { force: true });
  await post(`/api/scan/${VOL}`, {});
  await attendre();
}

// Le dossier est rendu vide : une sonde qui laisse des fichiers derrière elle
// fausse le diagnostic des suivantes — c'est exactement ce que le harnais
// signale au run suivant, et ce qu'il a signalé pour de bon aujourd'hui.
for (const f of fs.readdirSync(DOSSIER)) fs.rmSync(`${DOSSIER}/${f}`, { force: true });

console.log('');
console.log(`${verifs.filter(Boolean).length}/${verifs.length} vérifications vertes`);
if (echecs.length) {
  console.log('ÉCHECS :');
  for (const e of echecs) console.log(`  - ${e}`);
}
process.exitCode = echecs.length ? 1 : 0;
