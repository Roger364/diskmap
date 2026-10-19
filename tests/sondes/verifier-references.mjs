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
//     contrôle échoue tant qu'elle n'a pas été lue ;
//  4. la référence porte son DOSSIER. Un nom nu — `main.rs:977`, sans `src/` —
//     ne dit pas de quel fichier il parle, et le résoudre demanderait une table
//     de devinettes. Il est refusé. Mesuré le 11/10/2026 : huit références
//     écrites en nom nu échappaient au contrôle, cinq étaient fausses, et deux
//     ne désignaient rien du tout.
//
// RECALER, quand un deplacement de lignes a broke des references :
//   python tests/sondes/recalage-references.py
// Jamais a la main, et jamais par decalage d un offset : le script cherche le
// SYMBOLE annonce dans le fichier vise, renumerote la documentation ET ce
// tableau, et repete jusqu a stabilite — parce qu une reference corrigee peut en
// decaler une autre. Il a ete ecrit le 30/09 apres un recalage manuel qui avait
// laisse 11 references fausses sur les 20 deplacees : la main voit ce qu elle a
// sous les yeux, et le reste est hors champ.
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
    'src/main.rs:1165': 'fn dossier_de',
    'src/main.rs:212': 'fn decider_le_navigateur',
    'src/scan.rs:977': 'let rd = match fs::read_dir(path)',
    'tests/sondes/sonde-ui-suppression.mjs:101': "zztaille-z.txt', 'x'.repeat(2000)",
    'tests/sondes/sonde-ui-suppression.mjs:757': 'taille égale, l’écran range',
    'src/main.rs:340': 'decider_le_navigateur(&args, std::io::stdin().is_terminal())',
    'src/main.rs:643': 'fn demande_couverte',
    'src/main.rs:643': 'en_attente.push(letter);',
    'src/main.rs:643': 'fn start_scan',
    'src/main.rs:345': 'Navigateur  : non ouvert',
    'tests/sondes/lancer.mjs:1174': "'--port', String(port), '--no-browser'",
    'src/main.rs:1511': 'fn blocked_reason',
    'src/main.rs:1641': 'gen_vue != snap.gen',
    'src/main.rs:1782': 'app.pending.lock()',
    'src/main.rs:1787': 'retiré ICI aussi',
    'src/main.rs:1787': 'p.retain',
    'src/main.rs:1832': 'app.pending.lock()',
    'src/main.rs:2118': 'let rescan = scan_ticket.is_some()',
    'src/main.rs:125': 'scanning: Mutex<Option<char>>',
    'src/main.rs:2736': 'fn journal',
    'src/scan.rs:386': 'GENERATION',
    'src/scan.rs:455': 'gen: GENERATION',
    'src/scan.rs:503': 'pub fn dir_path',
    'src/scan.rs:526': 'pub fn file_path',
    'src/scan.rs:1004': 'REPARSE_POINT',
        'ui/index.html:524': 'le reste est',
    'ui/index.html:427': 'let peintMs = null;',
    'ui/index.html:1889': 'peintMs === null || (d.finished_ms || 0) === peintMs',
    'ui/index.html:1894': 'rechargerTri();',
    'ui/index.html:525': 'ne pouvait pas',
    'ui/index.html:733': 'let requete = 0',
    'ui/index.html:769': 'if (mien !== requete) return;',
    'ui/index.html:792': 'if (mien !== requete) return;',
    'ui/index.html:986': 'if (mien !== requete) return;',
    'ui/index.html:1105': 'relancer en administrateur',
    'ui/index.html:1116': 'const cause = dr ?',
    'tests/sondes/lancer.mjs:1406': 'const connus',
    'tests/sondes/lancer.mjs:787': 'const muette = !compte',
    'tests/sondes/lancer.mjs:780': 'const vide = !!compte',
    'tests/sondes/lancer.mjs:1802': 'resume vide : la sonde annonce',
    'tests/sondes/lancer.mjs:787': 'const descompteFaux = !!compte',
    'tests/sondes/lancer.mjs:1861': 'aucun decompte ecrit',
    'tests/sondes/lancer.mjs:1813': 'decompte incoherent : la sonde annonce',
    'tests/sondes/lancer.mjs:1734': 'const mention = notes.length',
    'tests/sondes/lancer.mjs:1861': 'note(s) de',
    'tests/sondes/sonde-generation.mjs:37': 'function verifier(nom, cond, mesure)',
    'tests/sondes/sonde-generation.mjs:167': 'verifs.filter(Boolean).length',
    'tests/sondes/config.mjs:431': 'export async function attendreTicket',
    'tests/sondes/sonde-generation.mjs:71': 'async function analyserEtAttendre',
    'tests/sondes/sonde-tickets.mjs:62': 'async function demander',
    'ui/index.html:681': 'cur.ticket = rep && typeof rep.ticket',
    'ui/index.html:699': 'd.scan_completed >= cur.ticket',
    'ui/index.html:1575': 'cur.ticket = typeof res.scan_ticket',
    'tests/sondes/sonde-ui-suppression.mjs:537': 'const armerPeints',
    'tests/sondes/sonde-ui-suppression.mjs:560': 'const attendreEcranStable',
    'tests/sondes/sonde-ui-suppression.mjs:819': 'jamais été contredit',
    // Section 7/28 : les quatre gardes d entrée que personne ne regardait, et
    // l embuscade du controle qui les cherche. Les quatre lignes de `src/main.rs`
    // sont les GARDES elles-memes — le libelle doit s y trouver, pas un
    // commentaire voisin : c est ce que la reference doit designer.
    'src/main.rs:972': 'lettre manquante',
    'src/main.rs:1012': 'id invalide',
    'src/main.rs:1028': 'chemin invalide',
    'src/main.rs:1069': 'route inconnue',
    'tests/sondes/verifier-libelles.mjs:217': "const leurre = 'zzcontrolejamaisvu'",
    // Section 7/29 : l ecoute du reseau que les quatre sondes a navigateur
    // n avaient pas. Le symbole designe l export qu elles importent — sans
    // lui, la reference pointerait sur un commentaire et ne garderait rien.
    'tests/sondes/navigateur.mjs:66': 'export function suivreRequetes',
    // Section 7/30 : les deux instruments du harnais sur son propre travail.
    // Le plancher des comptes, et le registre des aveux. Les symboles pointent
    // sur les DECLARATIONS : une reference qui designerait un commentaire
    // garderait un texte, pas une regle.
    'tests/sondes/lancer.mjs:384': 'const COMPTES_PLANCHER = {',
    'tests/sondes/lancer.mjs:464': 'const AVEURS_STRUCTURELS = [',
    // Section 7/31 : le mode decouverte de l outil d epreuves. Le symbole est
    // la fonction qui porte la discipline de restauration — ecrite une fois,
    // donc impossible a ecrire deux fois differemment.
    'tests/sondes/epreuve.mjs:344': 'async function sousGardeNeutralisee',
    'tests/sondes/lancer.mjs:501': 'corbeille_plafond` vaut null',
    'tests/sondes/sonde-corbeille-plafond.mjs:53': 'function noter(texte)',
    'tests/sondes/lancer.mjs:501': 'corbeille_plafond` vaut null',
    'tests/sondes/sonde-corbeille-plafond.mjs:53': 'function noter(texte)',
    // Les references vers `src/win32.rs`, longtemps INVISIBLES au controle : le
    // nom de fichier portait un chiffre et la classe de caracteres ne les
    // admettait pas. Elles sont declarees ici apres relecture une a une. Les
    // trois premieres sont les DECLARATIONS des fonctions citees — une
    // reference qui designerait un commentaire voisin garderait un texte, pas
    // une regle.
    'src/win32.rs:216': 'pub fn alea_u64',
    'src/win32.rs:242': 'pub fn delete_path',
    'src/win32.rs:292': 'pub fn is_reparse_point',
    // `:471` designait encore `GetVolumeInformationW` dans la prose, et depuis
    // longtemps plus rien de tel dans le fichier. Recalee sur la FONCTION qui
    // rend `label` et `fs` : c est elle que la phrase annonce.
    'src/win32.rs:769': 'fn volume_info',
    // Section 3.8 : le contrat `corbeille_inerte` expose par l apercu, et la
    // fonction qui recoit la reversibilite MESUREE — c est elle qui fait exiger
    // le mot de la suppression definitive malgre le mode « corbeille ».
    'src/win32.rs:470': 'pub fn corbeille_nuke',
    'src/win32.rs:495': 'pub fn corbeille_reversible',
    'src/main.rs:1412': 'corbeille_inerte: Option<bool>,',
    'src/main.rs:2196': 'fn mots_exiges',
    // Ajoutees avec la preuve de morsure de 3.8 (11/10/2026). La premiere est le
    // motif de refus que la sonde lisait mal : elle designe le `format!` qui
    // PRODUIT le texte brut, pas le `return Err` qui le porte — c est le message
    // qui compte, et une reference qui designerait la ligne voisine garderait un
    // texte, pas la cause.
    'src/main.rs:1861': 'format!("confirmation attendue : « {} »", attendus.join(" "))',
    // La regle qui rend la morsure impossible sur une instance ELEVEE : c est
    // elle qui ajoute « EFFACER » sans que la reversibilite y soit pour rien.
    'tests/sondes/config.mjs:352': "if (permanent || !corbeille || eleve) mots.push('EFFACER');",
    // Le filet ajoute a la sonde : sans lui, un refus en texte brut la tuait par
    // `SyntaxError`, et la mesure de 3.8 n existait pas.
    'tests/sondes/sonde-reversibilite.mjs:83': 'function lireCorps(r)',
    // Les deux references qui etaient ecrites en NOM NU, donc invisibles depuis
    // toujours. `:1017` pointait un COMMENTAIRE : la garde qui produit ce 409 est
    // en 1088 — c'est la ligne que la phrase annonce, et le controle des
    // references existe precisement pour refuser un commentaire voisin.
    'src/main.rs:977': 'return Err(("404 Not Found", "volume inconnu"',
    'src/main.rs:1088': '("409 Conflict", "volume pas encore analysé"',
    'ui/index.html:1189': 'if (!force && e.status === 409) {',
    'ui/index.html:775': 'if (e.status === 404) {',
  },
  'README.md': {
    'src/scan.rs:977': 'let rd = match fs::read_dir(path)',
    'tests/sondes/sonde-ui-suppression.mjs:101': "zztaille-z.txt', 'x'.repeat(2000)",
    'tests/sondes/sonde-ui-suppression.mjs:757': 'taille égale, l’écran range',
    'tests/sondes/sonde-generation.mjs:37': 'function verifier(nom, cond, mesure)',
    'tests/sondes/sonde-generation.mjs:167': 'verifs.filter(Boolean).length',
    'tests/sondes/config.mjs:431': 'export async function attendreTicket',
    'tests/sondes/sonde-generation.mjs:71': 'async function analyserEtAttendre',
    'tests/sondes/sonde-tickets.mjs:62': 'async function demander',
    'ui/index.html:681': 'cur.ticket = rep && typeof rep.ticket',
    'ui/index.html:699': 'd.scan_completed >= cur.ticket',
    'ui/index.html:1575': 'cur.ticket = typeof res.scan_ticket',
    'tests/sondes/lancer.mjs:787': 'const muette = !compte',
    'tests/sondes/lancer.mjs:780': 'const vide = !!compte',
    'tests/sondes/lancer.mjs:1802': 'resume vide : la sonde annonce',
    'tests/sondes/lancer.mjs:787': 'const descompteFaux = !!compte',
    'tests/sondes/lancer.mjs:1861': 'aucun decompte ecrit',
    'tests/sondes/lancer.mjs:1813': 'decompte incoherent : la sonde annonce',
    'tests/sondes/lancer.mjs:1734': 'const mention = notes.length',
    'tests/sondes/lancer.mjs:1861': 'note(s) de',
    'ui/index.html:427': 'let peintMs = null;',
    'ui/index.html:1889': 'peintMs === null || (d.finished_ms || 0) === peintMs',
    'ui/index.html:1894': 'rechargerTri();',
    'src/main.rs:643': 'fn demande_couverte',
    'src/main.rs:643': 'en_attente.push(letter);',
    'src/main.rs:643': 'fn start_scan',
    // Les quatre references du README qui etaient ecrites en NOM NU. Deux
    // pointaient un commentaire : le plancher se declare en 384, le registre des
    // aveux en 451 — pas en 381 et 432, ou il n'y a que la prose qui les
    // annonce. Une troisieme ne designait RIEN (`:9999`), et la quatrieme non
    // plus : `noter()` est en 53.
    'tests/sondes/lancer.mjs:384': 'const COMPTES_PLANCHER = {',
    'tests/sondes/lancer.mjs:464': 'const AVEURS_STRUCTURELS = [',
    'tests/sondes/lancer.mjs:743': 'const dispense = trous.reduce',
    'tests/sondes/sonde-corbeille-plafond.mjs:53': 'function noter(texte)',
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
  // Le nom de fichier accepte les CHIFFRES, et le chemin n'est plus impose.
  //
  // Deux trous, tous les deux mesures le 11/10/2026, de la meme famille : le
  // controle ne voyait que les references ecrites `src/…`, `ui/…` ou
  // `tests/sondes/…`, et seulement pour trois extensions.
  //
  //   - la classe etait `[A-Za-z_.-]+`, ou les CHIFFRES n'entrent pas :
  //     `src/win32.rs` — le fichier qui porte tout le registre Windows — etait
  //     invisible, et l'une de ses references (`:471`) ne designait plus
  //     `GetVolumeInformationW` depuis longtemps ;
  //   - le prefixe de dossier etait EXIGE : huit references ecrites en nom nu
  //     echappaient au controle, et cinq d'entre elles etaient fausses. Deux
  //     designaient un commentaire voisin au lieu de la declaration
  //     (`lancer.mjs:381` pour un plancher declare en 384, `:432` pour un
  //     registre declare en 451) ; deux ne designaient RIEN — `lancer.mjs:9999`
  //     dans un fichier de 1929 lignes, `sonde-corbeille-plafond.mjs:9999` dans
  //     un fichier de 192.
  //
  // La liste des extensions couvre tout ce qui porte du code ou de la
  // configuration dans ce depot. `.md` en est exclu : une reference d'un
  // document a un autre n'est pas une reference au code, et elle demanderait sa
  // propre regle plutot que d'etre glissee dans celle-ci.
  const refs = [...new Set(
    [...texte.matchAll(/([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.(?:rs|mjs|html|py|ps1|bat|toml|json|yml)):((?:\d+)(?:[,-]\d+)*)/g)]
      .flatMap((m) => m[2].split(/[,-]/).map((n) => ({ fichier: m[1], ligne: Number(n) })))
      .filter((r) => Number.isFinite(r.ligne))
  )];
  const declarees = new Set(Object.keys(ATTENDU[doc] || {}));
  const vues = new Set();

  for (const r of refs) {
    const ref = `${r.fichier}:${r.ligne}`;
    vues.add(ref);
    // Un nom nu est refuse AVANT toute autre chose, et sans essayer de le
    // resoudre : rien dans la phrase ne dit si `main.rs` est `src/main.rs` ou un
    // homonyme ailleurs. Une table de correspondance aurait repare ces huit-la en
    // en laissant passer la neuvieme — c'est la regle qui doit etre sure, pas la
    // liste.
    if (!r.fichier.includes('/')) {
      verifier(`${doc} ${ref} s'écrit avec son dossier`, false,
        `nom nu : rien ne dit de quel fichier il parle — écrire le chemin complet`);
      continue;
    }
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
