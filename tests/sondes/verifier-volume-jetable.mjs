// Test mécanique de la regle « ce volume est-il jetable ? ».
//
// Ce test ne supprime RIEN. Il verifie une regle, pas l'application : le predicat
// est une fonction pure, et le cas le plus interessant — prouver que la regle
// est APPELÉE — se contente de lancer le harnais sur un volume qu'on sait
// refuse, et de constater qu'il s'arrete.
//
// Il existe parce qu'une garde qui n'est pas exercee est une intention. Ce depot
// comptait une regle de refus par volume dans `filet.mjs` qui ne pouvait pas se
// declencher : `lettre('A:\\')` renvoyait `''`. Elle etait ecrite, relue, et
// fausse. Un test doit donc verifier ce qui existe REELLEMENT, pas ce qu'on
// croit avoir ecrit — d'ou la section 3, qui lance le harnais pour le prouver
// plutot que de lire le code et de le supposer.

import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { volumeJetable, interrogerVolumes, decrireVolume } from './config.mjs';

const ICI = path.dirname(fileURLToPath(import.meta.url));
const LANCER = path.join(ICI, 'lancer.mjs');

const verifs = [], echecs = [];
function verifier(nom, cond, mesure) {
  const ok = !!cond;
  verifs.push(ok);
  if (!ok) echecs.push(`${nom} — mesuré : ${mesure}`);
  console.log(`${ok ? 'ok   ' : 'ROUGE'} ${nom}${ok ? '' : `\n      mesuré : ${mesure}`}`);
}

// --- 1. le predicat, sur des cas choisis ----------------------------------
// Des faits SYNTHETIQUES, volontairement : la regle doit se verifier meme sur
// une machine ou aucun VHD n'est monte, sinon le test ne couvre rien la ou il
// tourne.
console.log('--- 1. la regle, sur des faits choisis ---');

const VHD = { lettre: 'V', bus: 'File Backed Virtual', nomDisque: 'Msft Virtual Disk', partitions: 1 };
verifier('un disque virtuel est jetable', volumeJetable(VHD).jetable, JSON.stringify(volumeJetable(VHD)));

const PARTAGE = { lettre: 'G', bus: 'SATA', nomDisque: 'SSD', partitions: 3 };
verifier('un disque physique partage avec d autres volumes est refuse',
  !volumeJetable(PARTAGE).jetable, JSON.stringify(volumeJetable(PARTAGE)));

// Le cas que la taille ne rattrape pas. Un disque physique en UNE SEULE
// partition peut contenir les seules sauvegardes de quelqu'un : « il n y a rien
// a cote » ne dit rien du disque lui-meme. La regle doit donc le refuser aussi —
// et c'est precisement le cas qu on lirait « evident », et qu on ajouterait par
// erreur en croyant elargir la regle.
const SEUL = { lettre: 'W', bus: 'USB', nomDisque: 'Externe 4To', partitions: 1 };
verifier('un disque physique en une seule partition est quand meme refuse',
  !volumeJetable(SEUL).jetable, JSON.stringify(volumeJetable(SEUL)));

const BOOT = { lettre: 'C', bus: 'NVMe', nomDisque: 'Systeme', boot: true, systeme: true, partitions: 5 };
verifier('le disque de boot est refuse', !volumeJetable(BOOT).jetable, JSON.stringify(volumeJetable(BOOT)));

verifier('un volume absent est refuse, jamais presume jetable',
  !volumeJetable(null).jetable, JSON.stringify(volumeJetable(null)));

const INCONNU = { lettre: 'Z', bus: '', nomDisque: '', partitions: 0 };
verifier('un bus inconnu est refuse — pas de bus n est une garantie',
  !volumeJetable(INCONNU).jetable, JSON.stringify(volumeJetable(INCONNU)));

const SAMSUNG = { lettre: 'D', bus: 'SATA', nomDisque: 'Samsung', partitions: 3 };
verifier('le motif de refus nomme le disque et ce qu il partage',
  /Samsung/.test(volumeJetable(SAMSUNG).motif), volumeJetable(SAMSUNG).motif);

// --- 2. la regle, sur les vrais volumes de cette machine --------------------
// Les memes faits, releves pour de vrai. Un cas non mesure ne vaut ni succes ni
// echec : sans PowerShell, on le dit et on sort en 2.
console.log('\n--- 2. la regle, sur les volumes reellement montes ---');
const faits = interrogerVolumes();
if (!faits.length) {
  console.log('PAS PU EPROUVER : aucun volume releve (PowerShell indisponible).');
  console.log('  La regle pure (section 1) a bien ete verifiee ; celle-ci n a pas pu l etre.');
  process.exit(2);
}
for (const f of [...faits].sort((a, b) => a.lettre.localeCompare(b.lettre))) {
  const j = volumeJetable(f);
  console.log(`  ${(j.jetable ? 'jetable' : 'refuse ')}  ${decrireVolume(f)}`);
}

const c = faits.find((f) => f.lettre === 'C');
verifier('le volume de boot de Windows est refuse — vrai sur toute machine Windows',
  c ? !volumeJetable(c).jetable : null, c ? decrireVolume(c) : 'C: absent');

// Au moins deux profils differents, sinon la regle n'a rien distingue sur cette
// machine et une regle qui refuserait tout passerait ce test aussi.
const profils = new Set(faits.map((f) => `${f.bus}|${f.partitions}`));
verifier('les volumes de cette machine ne sont pas tous identiques — le test a du mordant',
  profils.size > 1, `${faits.length} volumes, ${profils.size} profils : ${[...profils].join(' , ')}`);

const jetables = faits.filter((f) => volumeJetable(f).jetable);
if (jetables.length) {
  verifier('les volumes acceptes sont exactement les disques virtuels',
    jetables.every((f) => f.bus === 'File Backed Virtual'),
    jetables.map((f) => `${f.lettre} (${f.bus})`).join(', '));
} else {
  console.log('  (aucun volume jetable monte — la suite de sondes ne peut pas tourner ici)');
}

// --- 3. la regle est-elle APPELÉE ? ----------------------------------------
// C'est le point qui manquait. Une regle peut etre ecrite, relue, approuvee, et
// ne jamais s executer. Ici on lance le harnais sur C: — que toute machine
// Windows refuse — et on exige qu il s ARRETE, avant de demarrer quoi que ce
// soit. Si quelqu'un retire l'appel a `exigerVolumeJetable`, ce test tombe au
// lieu de passer en silence.
//
// UNE CONTRAINTE QUI S'IMPOSE A CE TEST, ET QUI A COUTE CHER
// ------------------------------------------------------------
// Ce test a ete ecrit SANS `--sans`, en ne comptant que sur la regle pour
// qu'aucune sonde ne s'execute. C etait faux, et la demonstration l'a montre :
// en neutralisant l'appel pour verifier que le test echouait, le harnais a
// reellement lance les sondes destructrices — 29 fichiers de test crees,
// supprimes et laisses sur C:\_diskmap_sondes, tous confines a leur dossier,
// tous recuperables, et malgre tout cela une perte qu on ne peut pas justifier
// par « le test le demandait ».
//
// Un test de securite doit rester sur DROIT meme quand la securite qu il
// eprouve est cassee. Donc `--sans` est passe ici, et la seule sonde laissee est
// `arret`, qui ne detruit rien. Le test detecte toujours la porte manquante ; il
// ne peut plus rien abimer, porte ouverte ou pas.
const SAUTES3 = 'filet,corps,suppression,generation,reelle,lot,ui,csrf,erreurs,host';
console.log('\n--- 3. le harnais appelle-t-il vraiment la regle ? ---');
if (!c) {
  console.log('PAS PU EPROUVER : C: absent, impossible de produire le refus attendu.');
  process.exit(2);
}
const r = spawnSync(process.execPath, [LANCER, '--volume', 'C', '--attendre', '60', '--sans', SAUTES3],
  {
    cwd: ICI, encoding: 'utf8', timeout: 120_000, windowsHide: true,
    env: { ...process.env, DISKMAP_SONDE_VOLUME: 'C', DISKMAP_SONDE_RACINE: 'C:\\_diskmap_sondes' },
  });
const sortie = `${r.stdout || ''}${r.stderr || ''}`;
verifier('le harnais refuse C: au lieu de lancer les sondes', r.status === 2,
  `code ${r.status} — ${sortie.slice(0, 200)}`);
verifier('le refus nomme la regle et son motif',
  /REFUS/.test(sortie) && /partagent ce disque|disque virtuel/.test(sortie), sortie.slice(0, 200));
verifier('le refus arrive AVANT le demarrage du serveur', !/serveur\s*:/.test(sortie),
  sortie.includes('serveur :') ? 'le serveur a demarre avant le refus' : 'aucun serveur demarre');
verifier('le refus dit quoi faire, pas seulement que non', /creer-volume-test/.test(sortie), sortie.slice(0, 200));

// --- 4. la declaration est-elle bruyante ? ---------------------------------
// Le point faible assume du choix fait pour la CI : une declaration est un
// drapeau, et un drapeau pose une fois dans un workflow devient un rituel.
// La seule parade est qu il ne puisse pas disparaitre du log.
//
// On lance donc le harnais sur un volume refuse AVEC declaration, et on exige
// que le mot pose soit repris a l ecran. Seule la sonde `arret` reste : elle ne
// detruit rien, donc ce test ne peut rien abimer meme s il se trompe. `C:` est
// analyse avec un delai court exprès : le harnais n'exige que le volume de
// travail, et c'est ce qui garde ce test rapide.
console.log('\n--- 4. la declaration reste-t-elle visible ? ---');
const MOT = 'runner-de-test-vraiment-furtif';
const SAUTES = 'filet,corps,suppression,generation,reelle,lot,ui,csrf,erreurs,host';
const d2 = spawnSync(process.execPath, [LANCER, '--volume', 'C', '--attendre', '60', '--sans', SAUTES],
  {
    cwd: ICI, encoding: 'utf8', timeout: 180_000, windowsHide: true,
    env: {
      ...process.env,
      DISKMAP_SONDE_VOLUME: 'C',
      DISKMAP_SONDE_RACINE: 'C:\\_diskmap_sondes',
      DISKMAP_SONDE_MACHINE_EPHEMERE: MOT,
    },
  });
const sortie2 = `${d2.stdout || ''}${d2.stderr || ''}`;
verifier('la declaration est reprise mot pour mot dans la sortie',
  sortie2.includes(MOT), sortie2.slice(0, 300));
verifier('elle est encadree, pas noyee dans la sortie',
  /={5,}[\s\S]*DECLARATION[\s\S]*={5,}/.test(sortie2), sortie2.slice(0, 300));
verifier('elle dit qu elle repose sur une affirmation, pas sur une mesure',
  /DECLARATION, pas sur mesure/.test(sortie2), sortie2.slice(0, 300));
verifier('le volume refuse reste refuse quand rien ne le declare',
  (() => {
    const s3 = spawnSync(process.execPath, [LANCER, '--volume', 'C', '--attendre', '60', '--sans', SAUTES],
      {
        cwd: ICI, encoding: 'utf8', timeout: 180_000, windowsHide: true,
        env: { ...process.env, DISKMAP_SONDE_VOLUME: 'C', DISKMAP_SONDE_RACINE: 'C:\\_diskmap_sondes', DISKMAP_SONDE_MACHINE_EPHEMERE: '' },
      });
    return s3.status === 2;
  })(), 'le run a passe sans declaration');

console.log('');
console.log(`  ${verifs.filter(Boolean).length}/${verifs.length} verifications`);
if (echecs.length) {
  console.log('ECHECS :');
  for (const e of echecs) console.log(`  - ${e}`);
  process.exit(1);
}
process.exit(0);
