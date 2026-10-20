// Sonde F-DEL-1 : la protection de racine est-elle GLOBALE ?
//
// La garde de `/api/delete` refuse un lot dont un ÉLÉMENT est une racine
// protégée. Elle ne dit rien de ce qu'un élément CONTIENT. Un dossier supprimé
// qui porte, en profondeur, une jonction vers un dossier HORS du lot : la
// suppression doit effacer la jonction comme un lien, et laisser la cible
// intacte. Si elle suit la jonction, tout ce que la cible contient part avec le
// lot, hors de l'instantané et hors de toute garde.
//
// CETTE SONDE SUPPRIME, sous `racine(VOL)/jonction-imbriquee-<mode>/` et sur
// un volume jetable seulement. Sans volume jetable (ni déclaration
// DISKMAP_SONDE_MACHINE_EPHEMERE), elle s'abstient : elle ne crée rien.
//
// La cible hors lot porte une SENTINELLE. Le lot effacé est vérifié absent :
// sans cette vérification, une sentinelle intacte ne prouverait rien (un lot
// qui n'aurait pas été effacé laisserait la sentinelle en place).
//
// Usage : node sonde-jonction-imbriquee.mjs http://127.0.0.1:8990/ [VOLUME]

import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  racine, dossier, volumeJetable, interrogerVolumes, aCorbeille, estEleve, aTaper,
  attendreTicket, attendreDossier, MACHINE_EPHEMERE,
} from './config.mjs';

const run = promisify(execFile);
const URL = process.argv[2] || 'http://127.0.0.1:8990/';
const BASE = URL.replace(/\/$/, '');
const VOL = (process.argv[3] || 'V').toUpperCase().replace(/:$/, '');

const verifs = [];
const echecs = [];
function verifier(nom, condition, mesure) {
  const ok = !!condition;
  verifs.push(ok);
  if (!ok) echecs.push(`${nom} — mesuré : ${mesure}`);
  console.log(`${ok ? 'ok   ' : 'ROUGE'} ${nom}${ok ? '' : `\n      mesuré : ${mesure}`}`);
}

async function post(chemin, corps) {
  const r = await fetch(BASE + chemin, {
    method: 'POST',
    // Le serveur exige cet en-tête sur toute route qui modifie quelque chose.
    headers: { 'Content-Type': 'application/json', 'X-Diskmap': '1' },
    body: JSON.stringify(corps),
  });
  return { status: r.status, texte: await r.text() };
}

// ------------------------------------------------------------- garde de volume
// Même règle que `lancer.mjs` : un volume qui n'est pas jetable n'est touché
// que sur déclaration explicite. Cette sonde est refaite seule, donc elle ne
// compte pas sur le lanceur pour cette règle.
const faits = await interrogerVolumes();
const cible = faits.find((f) => String(f.lettre).toUpperCase() === VOL);
const jetable = cible ? volumeJetable(cible) : { jetable: false, motif: `${VOL}: absent` };
if (!jetable.jetable && !MACHINE_EPHEMERE) {
  console.log(`ABSTENTION — ${VOL}: non jetable (${jetable.motif}). Rien créé, rien supprimé.`);
  process.exit(0);
}

const ELEVE = await estEleve(BASE);
const MOTS = {
  recycle: aTaper({ permanent: false, corbeille: aCorbeille(VOL), eleve: ELEVE }),
  permanent: aTaper({ permanent: true, corbeille: aCorbeille(VOL), eleve: ELEVE }),
};

// Une jonction se crée avec `mklink /J`, qui n'accepte que des barres obliques
// inverses. Les chemins de la sonde sont en barres obliques.
const versWindows = (p) => p.replace(/\//g, '\\');

// Relève la sélection (`sel`) et la génération de l'instantané d'un dossier.
async function sel(chemin, nom) {
  const t = await attendreDossier(BASE, VOL, chemin);
  if (!t) return null;
  const ligne = t.rows.find((r) => r.name === nom);
  return ligne ? { sel: ligne.sel, gen: t.gen } : null;
}

async function unLot(mode) {
  const R = dossier(VOL, `jonction-imbriquee-${mode}`);
  const LOT = `${R}/lot`;
  const PROFOND = `${LOT}/a/b`;
  const EXTERNE = `${R}/hors-lot`;
  const SENTINELLE = `${EXTERNE}/sentinelle.txt`;
  const LIEN = `${PROFOND}/vers-externe`;

  console.log(`\n--- ${mode} : lot « ${LOT} » avec jonction vers « ${EXTERNE} » ---`);

  // Un dossier de travail déjà présent n'est jamais réutilisé ni nettoyé à
  // l'aveugle : une jonction survivante ferait suivre un `rm -r` récursif.
  if (fs.existsSync(R)) {
    throw new Error(`dossier de travail déjà présent : « ${R} ». Nettoyage manuel requis, sans suivre les jonctions.`);
  }
  fs.mkdirSync(EXTERNE, { recursive: true });
  fs.writeFileSync(SENTINELLE, 'sentinelle\n');
  fs.mkdirSync(PROFOND, { recursive: true });
  await run('cmd', ['/c', 'mklink', '/J', versWindows(LIEN), versWindows(EXTERNE)]);

  verifier('la jonction pointe bien vers la sentinelle',
    fs.existsSync(`${LIEN}/sentinelle.txt`), `${LIEN}/sentinelle.txt absent`);

  // Analyse, puis lecture de la sélection du lot dans son dossier parent.
  const scan = await post(`/api/scan/${VOL}`, {});
  const corps = JSON.parse(scan.texte);
  if (scan.status !== 200 || typeof corps.ticket !== 'number') {
    throw new Error(`POST /api/scan a répondu ${scan.status} sans ticket`);
  }
  await attendreTicket(BASE, VOL, corps.ticket);
  const s = await sel(R, 'lot');
  if (!s) throw new Error(`« lot » absent de l'instantané sous « ${R} »`);

  // Simulation : la garde voit le lot, sans toucher à rien.
  const dry = await post('/api/delete', { drive: VOL, items: [s.sel], mode: 'dry', gen: s.gen });
  if (dry.status !== 200) throw new Error(`dry a répondu ${dry.status} : ${dry.texte.slice(0, 160)}`);
  const d = JSON.parse(dry.texte);
  verifier(`[${mode}] la simulation accepte le lot (racine non protégée)`,
    d.token && d.items && d.items[0] && d.items[0].blocked === false,
    dry.texte.slice(0, 200));

  // Exécution. Le mot est celui du contexte (aTaper), pas une valeur écrite
  // en dur : un mode qui en exige un doit le recevoir.
  const exec = await post('/api/delete', {
    drive: VOL, items: [], mode, token: d.token, confirm: MOTS[mode] || undefined,
  });
  verifier(`[${mode}] l'exécution est acceptée`, exec.status === 200,
    `${exec.status} ${exec.texte.slice(0, 160)}`);

  // Attente bornée sur le FAIT : le lot a disparu de l'arborescence réelle.
  for (let i = 0; i < 120 && fs.existsSync(LOT); i++) {
    await new Promise((r) => setTimeout(r, 1000));
  }

  // Vérifications. La première n'est pas une formalité : sans elle, la
  // sentinelle intacte ne prouverait rien.
  verifier(`[${mode}] le lot est effacé`, !fs.existsSync(LOT), `« ${LOT} » existe encore`);
  verifier(`[${mode}] la cible hors lot est intacte (sentinelle présente)`,
    fs.existsSync(SENTINELLE) && fs.readFileSync(SENTINELLE, 'utf8') === 'sentinelle\n',
    fs.existsSync(SENTINELLE) ? 'contenu modifié' : 'SENTINELLE EFFACÉE : la jonction a été suivie');

  // Nettoyage : on ne retire que ce que cette sonde a créé, fichier par fichier.
  // Si la sentinelle manque, on ne touche à rien d'autre.
  if (fs.existsSync(SENTINELLE)) fs.unlinkSync(SENTINELLE);
  if (fs.existsSync(EXTERNE)) fs.rmdirSync(EXTERNE);
  if (fs.existsSync(R) && fs.readdirSync(R).length === 0) fs.rmdirSync(R);
}

for (const mode of ['recycle', 'permanent']) {
  try {
    await unLot(mode);
  } catch (e) {
    verifier(`[${mode}] la sonde s'est déroulée`, false, e.message);
  }
}

// LE DÉCOMPTE QUE LE HARNAIS LIT. `compterSortie` (lancer.mjs) compte les
// lignes `ok`/`ROUGE` ET relit une ligne `N/N vérifications` : les deux termes
// doivent valoir le compte réel des lignes écrites. Sans cette ligne, la sortie
// est « muette » et le harnais force la sonde au ROUGE même à code de sortie 0
// — « aucun décompte écrit : la sonde n'a rien rapporté ». C'est ce qui
// arrivait le 20/10/2026 aux cas [recycle] et [permanent] : dix vérifications
// écrites, toutes justes, toutes perdues — le vert de la sonde ne prouvait
// rien, puisque le harnais ne voyait rien.
const reussies = verifs.filter(Boolean).length;
console.log('');
console.log(`${reussies}/${verifs.length} vérifications sur ${VOL}:`);
if (echecs.length) {
  console.log('Échecs :');
  for (const e of echecs) console.log(`  - ${e}`);
  process.exit(1);
}
console.log('VERT — un lot contenant une jonction imbriquée efface la jonction, pas la cible');
