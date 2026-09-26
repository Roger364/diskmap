// La corbeille tient-elle sa promesse ? Et l'application dit-elle la vérité ?
//
// Le volume E: n'a AUCUNE `$RECYCLE.BIN`. `FOF_ALLOWUNDO` signifie « mets à la
// corbeille SI c'est possible » : sur un tel volume, Windows supprime
// définitivement, sans le dire.
//
// Avant le correctif du 26/09/2026, l'application annonçait `to_trash: true`,
// journalisait « corbeille », et le fichier était DÉTRUIT — introuvable dans
// toutes les corbeilles de la machine. L'annonce venait du mode DEMANDÉ, jamais
// constatée.
//
// Cette sonde éprouve désormais l'invariant qui compte, et lui seul :
//
//     l'annonce de l'application doit correspondre à l'état du disque.
//
// Elle établit l'état du disque indépendamment — en cherchant le fichier PAR SON
// CONTENU dans la corbeille du volume — puis compare. Elle ne présume pas ce que
// la réponse doit être : elle vérifie qu'elles concordent. Sur un volume avec
// corbeille comme sur un volume sans, le même invariant doit tenir.
//
// La sonde ne touche qu'à un fichier qu'elle crée elle-même, sur un volume de
// données.
//
// Usage : node sonde-reversibilite.mjs http://127.0.0.1:9004/ E
//         node sonde-reversibilite.mjs http://127.0.0.1:9004/ G   (doit tenir aussi)
import fs from 'fs';

import { dossier, corbeille, journal, VOLUME_SANS_CORBEILLE, URL_DEFAUT } from './config.mjs';

const BASE = (process.argv[2] || URL_DEFAUT).replace(/\/$/, '');
const VOL = (process.argv[3] || VOLUME_SANS_CORBEILLE).toUpperCase();
const NOM = 'reversibilite';
const DOSSIER = dossier(VOL, NOM);
const FICHIER = DOSSIER + '/cible.txt';
const CORBEILLE = corbeille(VOL);
const JOURNAL = journal();
const H = { 'Content-Type': 'application/json', 'X-Diskmap': '1' };

const verifs = [], echecs = [];
function verifier(nom, cond, mesure) {
  const ok = !!cond; verifs.push(ok);
  if (!ok) echecs.push(`${nom} — mesuré : ${mesure}`);
  console.log(`${ok ? 'ok   ' : 'ROUGE'} ${nom}${ok ? '' : `\n      mesuré : ${mesure}`}`);
}
function constater(t) { console.log(`      constat : ${t}`); }

const SCEAU = `${VOL}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const CONTENU = `${SCEAU}\n`;

const post = (chemin, corps) => fetch(BASE + chemin, {
  method: 'POST', headers: H, body: JSON.stringify(corps),
}).then(async r => ({ status: r.status, texte: await r.text() }));

async function attendreParcours() {
  for (let i = 0; i < 300; i++) {
    const s = await (await fetch(`${BASE}/api/state`)).json();
    if (!s.scanning) return;
    await new Promise(r => setTimeout(r, 300));
  }
}

// L'état du disque, établi SANS l'application : on cherche le sceau par son
// contenu. Un décompte ne dirait pas que c'est bien CE fichier.
function chercherSceau(racine, profondeur = 0) {
  if (profondeur > 8) return [];
  const trouves = [];
  let entrees;
  try { entrees = fs.readdirSync(racine, { withFileTypes: true }); } catch { return []; }
  for (const e of entrees) {
    const p = `${racine}/${e.name}`;
    if (e.isDirectory()) trouves.push(...chercherSceau(p, profondeur + 1));
    else {
      let st; try { st = fs.statSync(p); } catch { continue; }
      if (!st.isFile() || st.size > 64) continue;
      try { if (fs.readFileSync(p, 'utf8') === CONTENU) trouves.push(p); } catch { /* illisible */ }
    }
  }
  return trouves;
}

// ------------------------------------------------------------------ montage
console.log(`--- ${VOL}: — la corbeille ${fs.existsSync(CORBEILLE) ? 'existe' : 'N’EXISTE PAS'} ---`);
fs.mkdirSync(DOSSIER, { recursive: true });
fs.writeFileSync(FICHIER, CONTENU);
verifier('le fichier est créé', fs.existsSync(FICHIER), 'absent');

await post(`/api/scan/${VOL}`, {});
await attendreParcours();

const dir = (await (await fetch(`${BASE}/api/search?drive=${VOL}&q=${NOM}`)).json())
  .rows.find(r => r.name === NOM);
const t = await (await fetch(`${BASE}/api/tree?drive=${VOL}&id=${dir.id}&limit=100`)).json();
const id = t.rows.find(r => r.name === 'cible.txt')?.id ?? null;
// La génération accompagne toujours l'identifiant : un identifiant est une
// position, et `dry` refuse désormais une liste qui ne dit pas de quel
// instantané elle vient (mesuré le 26/09/2026 — voir `Snapshot::gen`).
const gen = t.gen;
verifier('la cible est dans l’instantané', id != null, `id=${id}`);
if (id == null) process.exit(1);

// -------------------------------------------------- l'aperçu, puis la corbeille
console.log('\n--- suppression demandée en mode « corbeille » ---');
const lignesAvant = fs.readFileSync(JOURNAL, 'utf8').split('\n').filter(Boolean).length;
const dry = JSON.parse((await post('/api/delete', {
  drive: VOL, items: [{ id, is_dir: false }], mode: 'dry', gen,
})).texte);
verifier('l’aperçu se propose de l’effacer', dry.deletable === 1, JSON.stringify(dry.items));
const r = await post('/api/delete', { drive: VOL, mode: 'recycle', token: dry.token });
const d = JSON.parse(r.texte);
console.log(`      réponse : HTTP ${r.status} · done=${d.done} · failed=${d.failed} ` +
  `· to_trash=${d.to_trash} · irreversible=${d.irreversible}`);

verifier('l’application annonce une réussite', d.done === 1, JSON.stringify(d.results));
verifier('le fichier a disparu du disque', !fs.existsSync(FICHIER), 'toujours présent');

// --------------------------------------------------- où est-il allé, en vrai ?
console.log('\n--- l’état du disque, établi sans l’application ---');
const dansCorbeille = chercherSceau(CORBEILLE);
// On ne parcourt PAS tout le volume : sur G: cela fait un million de fichiers,
// et la sonde s'est fait tuer avant de conclure. Le dossier d'origine et la
// corbeille sont les deux seuls endroits où le fichier peut être — s'il n'est ni
// dans l'un ni dans l'autre, il n'est nulle part.
const ailleurs = chercherSceau(DOSSIER).filter(p => !p.includes('RECYCLE'));
console.log(`      sceau dans la corbeille de ${VOL}: : ${dansCorbeille.length} ${JSON.stringify(dansCorbeille)}`);
console.log(`      sceau resté dans le dossier d’origine : ${ailleurs.length} ${JSON.stringify(ailleurs)}`);

const enCorbeille = dansCorbeille.length > 0 || ailleurs.length > 0;
const annonceReversible = d.to_trash === true;
if (enCorbeille) constater('le fichier est retrouvable : l’opération ÉTAIT réversible');
else constater('le fichier n’est NULLE PART : il a été DÉTRUIT');

// L'invariant. C'est lui qui compte, et il doit tenir sur les deux sortes de
// volume : ce que l'application annonce doit correspondre à ce qui a eu lieu.
verifier('l’annonce de l’application correspond à l’état du disque',
  annonceReversible === enCorbeille,
  `annonce réversible=${annonceReversible}, or le disque dit réversible=${enCorbeille}`);

if (!enCorbeille) {
  verifier('elle chiffre les éléments détruits au lieu de les taire',
    d.irreversible === 1, `irreversible=${d.irreversible}`);
  verifier('elle nomme la cause sur l’élément concerné',
    /DÉTRUIT/.test(JSON.stringify(d.results)), JSON.stringify(d.results));
}

// Le journal : il doit dire ce qui a EU LIEU, pas ce qui a été demandé.
const lignesApres = fs.readFileSync(JOURNAL, 'utf8').split('\n').filter(Boolean);
const nouvelles = lignesApres.slice(lignesAvant).filter(l => l.includes(NOM));
console.log(`      journal : ${JSON.stringify(nouvelles)}`);
const motAttendu = enCorbeille ? 'corbeille' : 'corbeille-refusee';
verifier('le journal enregistre l’issue réelle, pas le mode demandé',
  nouvelles.length === 1 && nouvelles[0].split('\t')[1] === motAttendu,
  `attendu « ${motAttendu} », lu ${JSON.stringify(nouvelles)}`);

// ------------------------------------------------------------- nettoyage
//
// Sur un volume qui a une corbeille, le test y a laissé son fichier : il le
// reprend. Sur un volume qui n'en a pas, il n'y a rien à reprendre — le fichier a
// été détruit, et c'est précisément ce que la sonde constate.
if (enCorbeille) {
  let rendus = 0;
  for (const f of dansCorbeille) {
    const dossier = f.slice(0, f.lastIndexOf('/'));
    const nom = f.slice(f.lastIndexOf('/') + 1);
    const suffixe = nom.replace(/^\$R/, '').replace(/\.[^.]*$/, '');
    try { fs.unlinkSync(f); rendus++; } catch { /* déjà parti */ }
    // La fiche $I partage le suffixe mais pas l'extension : on la cherche.
    for (const n of fs.readdirSync(dossier)) {
      if (n.startsWith('$I') && n.includes(suffixe)) {
        try { fs.unlinkSync(`${dossier}/${n}`); } catch { /* fiche absente */ }
      }
    }
  }
  console.log(`      nettoyage : ${rendus} fichier(s) d’essai repris dans la corbeille`);
}
try { fs.rmdirSync(DOSSIER); } catch { /* non vide, ou déjà parti */ }

console.log('');
console.log(`${verifs.filter(Boolean).length}/${verifs.length} vérifications`);
if (echecs.length) { console.log('ÉCHECS :'); for (const e of echecs) console.log(`  - ${e}`); }
process.exit(echecs.length ? 1 : 0);
