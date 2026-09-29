// Combien de constats ont une preuve qu'ils peuvent MORDRE ?
//
// Une sonde verte dit « rien n'a régressé ». Elle ne dit pas « quelque chose serait
// rouge si ça régressait » : pour cela, il faut avoir neutralisé la garde une fois,
// et vu la sonde passer au rouge. Sur ce dépôt, l.inventory des gardes existe déjà
// — ce sont les constats R et les causes racines du §3 — et il a été validé. Ce que
// le dépôt ne savait pas, c'est COMBIEN de ces constats ont une preuve de morsure.
//
// On ne recompte donc pas les gardes : ce serait les compter deux fois, et par
// code HTTP — méthode essayée le 29/09 etimmediately rejetée, parce que chaque
// sonde cite « 400 » et que le chiffre obtenu ne distinguait rien. Ici le croisement
// se fait sur des NOMS déclarés : chaque preuve dit à quel constat elle se
// rattache, et le contrôle vérifie que ce constat existe.
//
// Ce contrôle n'exige PAS que tous les constats aient une preuve — il les
// COMPTE et les nomme. Exiger la couverture complète rendrait le contrôle rouge en
// permanence, et un contrôle rouge en permanence n'est plus un contrôle. Il sort en
// échec sur une seule chose : une preuve qui désigne un constat inexistant, parce
// que là, c'est le contrôle qui a tort, pas le dépôt.
//
// Usage : node tests/sondes/verifier-preuves.mjs

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ICI = path.dirname(fileURLToPath(import.meta.url));
const DEPOT = path.resolve(ICI, '..', '..');
const SECURITY = path.join(DEPOT, 'SECURITY.md');
const CATALOGUE = path.join(ICI, 'epreuve.mjs');

const verifs = [];
const echecs = [];

function verifier(nom, cond, mesure) {
  const ok = !!cond;
  verifs.push(ok);
  if (!ok) echecs.push(`${nom} — mesuré : ${mesure}`);
  console.log(`${ok ? 'ok   ' : 'ROUGE'} ${nom}${ok ? '' : `\n      mesuré : ${mesure}`}`);
}

function sujet(n) {
  return n.startsWith('R') ? n : n;
}


// --- le document : les constats et les causes racines qu'il déclare lui-même
const doc = fs.readFileSync(SECURITY, 'utf8');
const constats = new Set();
for (const m of doc.matchAll(/^### (R\d+)\s+—/gm)) constats.add(m[1]);
for (const m of doc.matchAll(/^### 3\.(\d+)\s+/gm)) constats.add(`3.${m[1]}`);

// --- le catalogue : les épreuves et le constat auquel chacune se rattache
const cat = fs.readFileSync(CATALOGUE, 'utf8');
const preuves = [];
for (const bloc of cat.split(/^  \{$/m).slice(1)) {
  const nom = (bloc.match(/^\s+nom: '([^']+)'/m) || [])[1];
  const rattache = (bloc.match(/^\s+preuve: '([^']+)'/m) || [])[1];
  if (nom) preuves.push({ nom, sujet: rattache });
}

console.log('--- les preuves de morsure désignent-elles un constat qui existe ? ---');

verifier('le catalogue déclare des épreuves', preuves.length > 0, `${preuves.length} épreuve(s)`);
verifier('le document déclare des constats', constats.size > 0, `${constats.size} constat(s) et cause(s) racine(s)`);

for (const p of preuves) {
  if (!p.sujet) continue;
  verifier(`l'épreuve « ${p.nom} » se rattache à un constat qui existe`,
    constats.has(sujet(p.sujet)), `${p.sujet} — absent de SECURITY.md`);
}

// --- l'écart, compté et nommé
const couverts = new Set(preuves.filter((p) => p.sujet).map((p) => sujet(p.sujet)));
const nus = [...constats].filter((c) => !couverts.has(c)).sort((a, b) => {
  const na = Number(String(a).replace(/\D/g, ''));
  const nb = Number(String(b).replace(/\D/g, ''));
  return String(a).startsWith('R') === String(b).startsWith('R') ? na - nb : (String(a).startsWith('R') ? -1 : 1);
});

console.log('');
console.log(`  ${couverts.size}/${constats.size} constats portent une preuve de morsure rejouable.`);
if (nus.length) {
  console.log(`  ${nus.length} sans preuve rejouable — ce n'est PAS un échec, c'est la limite :`);
  console.log(`  ${nus.join(', ')}`);
  console.log('  Ces constats sont corrigés et sondés. Ce qui n est pas établi, c est que');
  console.log('  leur sonde rouge si la garde cédait. `node tests/sondes/epreuve.mjs` est');
  console.log('  le moyen de le changer, une garde à la fois.');
}
if (!couverts.size && constats.size) {
  console.log('  Aucune preuve pour le moment : le contrôle le dit, il ne le pardonne pas.');
}

console.log('');
console.log(`${verifs.filter(Boolean).length}/${verifs.length} verifications vertes`);
if (echecs.length) {
  console.log('ECHECS :');
  for (const e of echecs) console.log(`  - ${e}`);
}
process.exitCode = echecs.length ? 1 : 0;
