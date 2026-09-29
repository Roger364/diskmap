// Chaque `fichier:ligne` de la documentation doit designer le code qu'elle
// annonce.
//
// Le 27/09/2026, sur 21 références de SECURITY.md, quatre étaient fausses :
// trois pointaient vers la mauvaise fonction, et une décrivait un défaut déjà
// corrigé dans le code. Aucune n'avait été vérifiée depuis l'audit du 26/09,
// parce qu'une référence de ligne a l'air d'une chose stable : elle ne l'est
// pas, et elle devient de la fiction au premier commit qui ajoute cent lignes.
//
// Ce contrôle rend la vérification permanente. Il est volontairement STRICT :
//
//  1. la ligne existe, et elle n'est pas vide — c'est la dérive pure, celle que
//     un `grep` de la longueur du fichier suffit à manquer ;
//  2. la ligne CONTIENT le symbole que la documentation annonce — c'est le
//     défaut qu'un décalage de lignes ne révèle pas, et celui qui compte ;
//  3. toute référence NOUVELLE, sans symbole déclaré ici, est signalée. Une
//     référence non vérifiée ne passe pas en douce : elle se déclare, et le
//     contrôle échoue tant qu'elle n'a pas été lue.
//
// Le tableau ci-dessous est la trace de la vérification manuelle. Il est
// relisible, donc contestable : si une référence désigne bien autre chose que
// le symbole écrit, c'est le tableau qu'il faut corriger, et la correction
// se voit dans une revue.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ICI = path.dirname(fileURLToPath(import.meta.url));
const DEPOT = path.resolve(ICI, '..', '..');
const DOCS = ['SECURITY.md', 'README.md'];

// document -> reference -> fragment que la ligne vise doit contenir
const ATTENDU = {
  'SECURITY.md': {
    'src/main.rs:110': 'struct Montre',
    'src/main.rs:878': 'fn hote_local',
    'src/main.rs:956': 'X-Diskmap absent',
    'src/main.rs:1151': 'fn dossier_de',
    'src/main.rs:212': 'fn decider_le_navigateur',
    'src/scan.rs:977': 'let rd = match fs::read_dir(path)',
    'tests/sondes/sonde-ui-suppression.mjs:101': "zztaille-z.txt', 'x'.repeat(2000)",
    'tests/sondes/sonde-ui-suppression.mjs:718': 'taille égale, l’écran range',
    'src/main.rs:340': 'decider_le_navigateur(&args, std::io::stdin().is_terminal())',
    'src/main.rs:643': 'fn demande_couverte',
    'src/main.rs:643': 'en_attente.push(letter);',
    'src/main.rs:643': 'fn start_scan',
    'src/main.rs:345': 'Navigateur  : non ouvert',
    'tests/sondes/lancer.mjs:540': "'--port', String(port), '--no-browser'",
    'src/main.rs:1496': 'fn blocked_reason',
    'src/main.rs:1631': 'gen_vue != snap.gen',
    'src/main.rs:1767': 'app.pending.lock()',
    'src/main.rs:1768': 'retiré ICI aussi',
    'src/main.rs:1772': 'p.retain',
    'src/main.rs:1816': 'app.pending.lock()',
    'src/main.rs:2104': 'let rescan = scan_ticket.is_some()',
    'src/main.rs:125': 'scanning: Mutex<Option<char>>',
    'src/main.rs:2714': 'fn journal',
    'src/scan.rs:386': 'GENERATION',
    'src/scan.rs:455': 'gen: GENERATION',
    'src/scan.rs:503': 'pub fn dir_path',
    'src/scan.rs:526': 'pub fn file_path',
    'src/scan.rs:1004': 'REPARSE_POINT',
        'ui/index.html:524': 'le reste est',
    'ui/index.html:427': 'let peintMs = null;',
    'ui/index.html:1868': 'peintMs === null || (d.finished_ms || 0) === peintMs',
    'ui/index.html:1873': 'rechargerTri();',
    'ui/index.html:525': 'ne pouvait pas',
    'ui/index.html:733': 'let requete = 0',
    'ui/index.html:769': 'if (mien !== requete) return;',
    'ui/index.html:792': 'if (mien !== requete) return;',
    'ui/index.html:986': 'if (mien !== requete) return;',
    'ui/index.html:1105': 'relancer en administrateur',
    'ui/index.html:1116': 'const cause = dr ?',
    'tests/sondes/lancer.mjs:769': 'const connus',
    'tests/sondes/lancer.mjs:1019': 'const muette = !compte',
    'tests/sondes/lancer.mjs:1018': 'const vide = !!compte',
    'tests/sondes/lancer.mjs:1145': 'resume vide : la sonde annonce',
    'tests/sondes/lancer.mjs:1042': 'const descompteFaux = !!compte',
    'tests/sondes/lancer.mjs:1149': 'aucun decompte ecrit',
    'tests/sondes/lancer.mjs:1152': 'decompte incoherent : la sonde annonce',
    'tests/sondes/lancer.mjs:1080': 'const mention = notes.length',
    'tests/sondes/lancer.mjs:1200': 'note(s) de',
    'tests/sondes/sonde-generation.mjs:37': 'function verifier(nom, cond, mesure)',
    'tests/sondes/sonde-generation.mjs:167': 'verifs.filter(Boolean).length',
    'tests/sondes/config.mjs:428': 'export async function attendreTicket',
    'tests/sondes/sonde-generation.mjs:71': 'async function analyserEtAttendre',
    'tests/sondes/sonde-tickets.mjs:62': 'async function demander',
    'ui/index.html:681': 'cur.ticket = rep && typeof rep.ticket',
    'ui/index.html:699': 'd.scan_completed >= cur.ticket',
    'ui/index.html:1566': 'cur.ticket = typeof res.scan_ticket',
    'tests/sondes/sonde-ui-suppression.mjs:537': 'const armerPeints',
    'tests/sondes/sonde-ui-suppression.mjs:560': 'const attendreEcranStable',
    'tests/sondes/sonde-ui-suppression.mjs:780': 'jamais été contredit',
    // Section 7/28 : les quatre gardes d entrée que personne ne regardait, et
    // l embuscade du controle qui les cherche. Les quatre lignes de `src/main.rs`
    // sont les GARDES elles-memes — le libelle doit s y trouver, pas un
    // commentaire voisin : c est ce que la reference doit designer.
    'src/main.rs:972': 'lettre manquante',
    'src/main.rs:1012': 'id invalide',
    'src/main.rs:1033': 'chemin invalide',
    'src/main.rs:1074': 'route inconnue',
    'tests/sondes/verifier-libelles.mjs:217': "const leurre = 'zzcontrolejamaisvu'",
    // Section 7/29 : l ecoute du reseau que les quatre sondes a navigateur
    // n avaient pas. Le symbole designe l export qu elles importent — sans
    // lui, la reference pointerait sur un commentaire et ne garderait rien.
    'tests/sondes/navigateur.mjs:66': 'export function suivreRequetes',
    // Section 7/30 : les deux instruments du harnais sur son propre travail.
    // Le plancher des comptes, et le registre des aveux. Les symboles pointent
    // sur les DECLARATIONS : une reference qui designerait un commentaire
    // garderait un texte, pas une regle.
    'tests/sondes/lancer.mjs:381': 'const COMPTES_PLANCHER = {',
    'tests/sondes/lancer.mjs:432': 'const AVEURS_STRUCTURELS = [',
    // Section 7/31 : le mode decouverte de l outil d epreuves. Le symbole est
    // la fonction qui porte la discipline de restauration — ecrite une fois,
    // donc impossible a ecrire deux fois differemment.
    'tests/sondes/epreuve.mjs:272': 'async function sousGardeNeutralisee',
  },
  'README.md': {
    'src/scan.rs:977': 'let rd = match fs::read_dir(path)',
    'tests/sondes/sonde-ui-suppression.mjs:101': "zztaille-z.txt', 'x'.repeat(2000)",
    'tests/sondes/sonde-ui-suppression.mjs:718': 'taille égale, l’écran range',
    'tests/sondes/sonde-generation.mjs:37': 'function verifier(nom, cond, mesure)',
    'tests/sondes/sonde-generation.mjs:167': 'verifs.filter(Boolean).length',
    'tests/sondes/config.mjs:428': 'export async function attendreTicket',
    'tests/sondes/sonde-generation.mjs:71': 'async function analyserEtAttendre',
    'tests/sondes/sonde-tickets.mjs:62': 'async function demander',
    'ui/index.html:681': 'cur.ticket = rep && typeof rep.ticket',
    'ui/index.html:699': 'd.scan_completed >= cur.ticket',
    'ui/index.html:1566': 'cur.ticket = typeof res.scan_ticket',
    'tests/sondes/lancer.mjs:1019': 'const muette = !compte',
    'tests/sondes/lancer.mjs:1018': 'const vide = !!compte',
    'tests/sondes/lancer.mjs:1145': 'resume vide : la sonde annonce',
    'tests/sondes/lancer.mjs:1042': 'const descompteFaux = !!compte',
    'tests/sondes/lancer.mjs:1149': 'aucun decompte ecrit',
    'tests/sondes/lancer.mjs:1152': 'decompte incoherent : la sonde annonce',
    'tests/sondes/lancer.mjs:1080': 'const mention = notes.length',
    'tests/sondes/lancer.mjs:1200': 'note(s) de',
    'ui/index.html:427': 'let peintMs = null;',
    'ui/index.html:1868': 'peintMs === null || (d.finished_ms || 0) === peintMs',
    'ui/index.html:1873': 'rechargerTri();',
    'src/main.rs:643': 'fn demande_couverte',
    'src/main.rs:643': 'en_attente.push(letter);',
    'src/main.rs:643': 'fn start_scan',
  },
};

const verifs = [], echecs = [];
function verifier(nom, cond, mesure) {
  const ok = !!cond; verifs.push(ok);
  if (!ok) echecs.push(`${nom} — mesuré : ${mesure}`);
  console.log(`${ok ? 'ok   ' : 'ROUGE'} ${nom}${ok ? '' : `\n      mesuré : ${mesure}`}`);
}

console.log('--- les références de la documentation désignent-elles leur code ? ---');

for (const doc of DOCS) {
  const texte = fs.readFileSync(path.join(DEPOT, doc), 'utf8');
  // `src/scan.rs:386,455` cite DEUX references : chaque nombre compte. En
  // n en retenant qu un, la seconde entree du tableau paraissait orpheline, et
  // le controle signalait un document qui ne cite plus rien.
  const refs = [...new Set(
    [...texte.matchAll(/((?:src|tests\/sondes|ui)\/[A-Za-z_.-]+\.(?:rs|mjs|html)):((?:\d+)(?:[,-]\d+)*)/g)]
      .flatMap((m) => m[2].split(/[,-]/).map((n) => ({ fichier: m[1], ligne: Number(n) })))
      .filter((r) => Number.isFinite(r.ligne))
  )];
  const declarees = new Set(Object.keys(ATTENDU[doc] || {}));
  const vues = new Set();

  for (const r of refs) {
    const ref = `${r.fichier}:${r.ligne}`;
    vues.add(ref);
    const chemin = path.join(DEPOT, r.fichier);
    if (!fs.existsSync(chemin)) {
      verifier(`${doc} ${ref} désigne un fichier présent`, false, `${r.fichier} n'existe pas`);
      continue;
    }
    const lignes = fs.readFileSync(chemin, 'utf8').split(/\r?\n/);
    if (r.ligne < 1 || r.ligne > lignes.length) {
      verifier(`${doc} ${ref} désigne une ligne existante`, false,
        `${r.fichier} n'a que ${lignes.length} ligne(s)`);
      continue;
    }
    verifier(`${doc} ${ref} désigne une ligne existante et non vide`,
      lignes[r.ligne - 1].trim().length > 0,
      JSON.stringify(lignes[r.ligne - 1].slice(0, 60)));
    const attendu = (ATTENDU[doc] || {})[ref];
    if (attendu === undefined) {
      // Une référence écrite aujourd'hui, jamais relue : elle se déclare ici.
      verifier(`${doc} ${ref} a un symbole vérifié`, false,
        `aucune entrée dans le tableau de ${path.relative(DEPOT, path.join(ICI, 'verifier-references.mjs'))}`
        + ` — relire la ligne, puis l'ajouter`);
      continue;
    }
    verifier(`${doc} ${ref} désigne bien « ${attendu} »`,
      lignes[r.ligne - 1].includes(attendu),
      JSON.stringify(lignes[r.ligne - 1].trim().slice(0, 80)));
  }

  // L'inverse : un symbole vérifié qui n'est plus cité est un tableau périmé.
  for (const ref of declarees) {
    if (!vues.has(ref)) {
      verifier(`${doc} ${ref} est encore cité`, false,
        'le tableau le vérifie mais le document ne le cite plus');
    }
  }
}

console.log(`      ${verifs.filter(Boolean).length}/${verifs.length} vérifications`);
if (echecs.length) {
  console.log('      ÉCHECS :');
  for (const e of echecs) console.log(`      - ${e}`);
}
process.exitCode = echecs.length ? 1 : 0;
