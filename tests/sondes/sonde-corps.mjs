// Une taille de corps annoncée par le client peut-elle tuer le serveur ?
//
// Le corps est lu dans un `vec![0u8; content_len]`, alloué sur la valeur d'un
// en-tête venu du réseau. Mesuré le 26/09/2026 : un seul
// « Content-Length: 999999999999 » suffisait à faire tomber le processus
// entier — connexion réinitialisée, puis plus aucune réponse, et AUCUNE route
// n'était même atteinte. Un simple GET suffisait donc à éteindre l'application
// depuis n'importe quelle page web.
//
// On parle ici en TCP brut, et non avec `fetch` : `fetch` refuse d'envoyer un
// Content-Length incohérent avec le corps, et ne permet donc pas de poser la
// question. C'est justement parce que le client poli ne peut pas le faire qu'un
// client impoli le fera.
//
// Usage : node sonde-corps.mjs http://127.0.0.1:8808/
import net from 'net';

const CIBLE = process.argv[2] || 'http://127.0.0.1:8808/';
const u = new URL(CIBLE);
const PORT = Number(u.port || 80);
const HOTE = u.hostname;

const verifs = [], echecs = [];
function verifier(nom, cond, mesure) {
  const ok = !!cond; verifs.push(ok);
  if (!ok) echecs.push(`${nom} — mesuré : ${mesure}`);
  console.log(`${ok ? 'ok   ' : 'ROUGE'} ${nom}${ok ? '' : `\n      mesuré : ${mesure}`}`);
}

/// Envoie une requête brute et rend la première ligne de réponse, ou null si
/// rien n'arrive avant `delai` (ce qui est en soi une réponse : le serveur
/// attend le corps annoncé).
function brut(lignes, delai = 1500) {
  return new Promise(resoudre => {
    const s = net.connect(PORT, HOTE);
    let recu = '';
    let fini = false;
    const conclure = v => { if (!fini) { fini = true; try { s.destroy(); } catch {} resoudre(v); } };
    s.setTimeout(delai, () => conclure(recu || null));
    s.on('data', d => { recu += d.toString('latin1'); });
    s.on('error', () => conclure(recu || null));
    s.on('close', () => conclure(recu || null));
    s.on('connect', () => s.write(lignes.join('\r\n') + '\r\n\r\n'));
  });
}

const enTete = (cl, extra = []) => [
  'POST /api/delete HTTP/1.1',
  `Host: ${HOTE}:${PORT}`,
  'X-Diskmap: 1',
  'Content-Type: application/json',
  `Content-Length: ${cl}`,
  ...extra,
];

// --- 1. une taille délirante ------------------------------------------------
const r1 = await brut(enTete(999999999999));
const code1 = r1 ? (r1.match(/HTTP\/1\.1 (\d+)/) || [])[1] : null;
verifier('une taille délirante reçoit un 413, et non une allocation',
  code1 === '413', r1 ? r1.split('\r\n')[0] : '(aucune réponse — le serveur est tombé)');

// --- 2. juste au-dessus de la borne ----------------------------------------
const r2 = await brut(enTete(4194305));
const code2 = r2 ? (r2.match(/HTTP\/1\.1 (\d+)/) || [])[1] : null;
verifier('un octet au-dessus de la borne est refusé',
  code2 === '413', r2 ? r2.split('\r\n')[0] : '(aucune réponse)');

// --- 3. exactement à la borne : doit être ACCEPTÉ ---------------------------
// Le serveur annonce lire 4 Mio et attend le corps : on ne l'envoie pas, donc
// l'absence de réponse est ici la preuve que la taille est acceptée. Un 413
// signifierait que la borne est trop basse pour l'usage réel.
const r3 = await brut(enTete(4194304), 900);
const code3 = r3 ? (r3.match(/HTTP\/1\.1 (\d+)/) || [])[1] : null;
verifier('une taille à la borne est acceptée (le serveur attend le corps)',
  code3 === null, code3 ? `HTTP ${code3} — la borne est trop basse` : 'aucune réponse, donc lecture en cours');

// --- 4. le serveur est-il toujours vivant ? ---------------------------------
let vivant = false;
try {
  const r = await fetch(new URL('/api/state', CIBLE));
  vivant = r.ok;
} catch { vivant = false; }
verifier('le serveur répond toujours après les trois essais', vivant,
  'le processus est mort — un simple en-tête a suffi');

console.log('');
console.log(`${verifs.filter(Boolean).length}/${verifs.length} vérifications vertes`);
if (echecs.length) { console.log('ÉCHECS :'); for (const e of echecs) console.log(`  - ${e}`); }
process.exit(echecs.length ? 1 : 0);
