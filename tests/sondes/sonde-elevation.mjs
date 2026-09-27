// Que fait RÉELLEMENT une instance ÉLEVÉE, du premier pixel au dernier octet ?
//
// Une instance élevée est le seul contexte où les ACL de Windows cessent de
// s'appliquer : les fichiers que les droits du compte interdisaient deviennent
// effaçables. C'est un changement de fait, pas de posture — et il a deux
// conséquences dans l'application, qui doivent être VÉRIFIÉES toutes les deux :
//
//   1. l'interface l'ANNONCE, par un bandeau en haut de page ;
//   2. le serveur EXIGE alors le mot `EFFACER`, y compris en mode corbeille,
//      parce qu'une suppression dite « réversible » cesse de l'être.
//
// La première était affirmée, la seconde était testée, et le lien entre les deux
// n'était mesuré nulle part. Une affirmation non mesurée est une croyance, et
// celle-ci est la plus coûteuse du projet : un bandeau qui s'affiche pendant que
// la règle ne s'applique pas rassure l'utilisateur, et une règle qui s'applique
// sans bandeau l'oblige à deviner pourquoi on lui demande un mot de destruction.
//
// CE QUE CETTE SONDE FAIT, ET NE FAIT PAS
// ---------------------------------------
// Elle ne simule pas l'élévation, et ne prétend pas l'éprouver. Elle LIT l'instance
// réelle sur `/api/state`, puis éprouve la LOI correspondant à cette instance. La
// loi est la même des deux côtés, et c'est ce qui rend la sonde honnête partout :
//
//   corbeille disponible + lot sous le palier + mode corbeille
//     → `EFFACER` est exigé SI ET SEULEMENT SI l'instance est élevée.
//
// Sur le runner de GitHub Actions, qui est TOUJOURS élevé, c'est la moitié droite
// qui est éprouvée pour de bon. Sur la machine de développement, c'est la moitié
// gauche. Aucune des deux exécutions ne peut valider l'autre, et aucune ne peut
// mentir sur ce qu'elle a couvert : le journal dit l'instance, puis la loi.
//
// Elle ne supprime RIEN. Le bouton « Supprimer… » ouvre la modale, la modale
// se mesure, et son bouton D'EXECUTION n'est jamais cliqué : le mot est tapé
// puis effacé, le fichier est laissé en place. C'est ce qui permet d'éprouver
// le champ de saisie — qui n'existe que dans la modale — sans exécuter quoi
// que ce soit.
//
// Usage : node sonde-elevation.mjs http://127.0.0.1:8990/ V
import fs from 'fs';

import { chromium } from './navigateur.mjs';
import { dossier, racine, aCorbeille, estEleve, attendreFichier,
  VOLUME_DEFAUT, URL_DEFAUT } from './config.mjs';

const BASE = (process.argv[2] || URL_DEFAUT).replace(/\/$/, '');
const VOL = (process.argv[3] || VOLUME_DEFAUT).toUpperCase();
// Un nom de sonde doit être unique PARMI CE QUE LA SONDE ANALYSE : le volume de
// travail n'est pas vierge et ne le sera jamais sur un runner. Voir la leçon
// écrite dans `sonde-ui-suppression.mjs`, où le dossier s'appelait `ui` et que la
// recherche remontait avant celui de la sonde.
const NOM = 'sonde-elevation';
const DOSSIER = dossier(VOL, NOM);
const A_CORBEILLE = aCorbeille(VOL);

const verifs = [], echecs = [];
function verifier(nom, cond, mesure) {
  const ok = !!cond; verifs.push(ok);
  if (!ok) echecs.push(`${nom} — mesuré : ${mesure}`);
  console.log(`${ok ? 'ok   ' : 'ROUGE'} ${nom}${ok ? '' : `\n      mesuré : ${mesure}`}`);
}
const H = { 'Content-Type': 'application/json', 'X-Diskmap': '1' };
const post = (c, corps) => fetch(BASE + c, {
  method: 'POST', headers: H, body: JSON.stringify(corps),
}).then(async r => ({ status: r.status, j: await r.json().catch(() => null) }));

// ---------------------------------------------------------------- 1. le fait
//
// Tout commence par là, et c'est le point où sept sondes se sont trompées : lire
// l'instance, ne jamais la supposer. Le runner de GitHub Actions est TOUJOURS
// élevé, et une sonde qui suppose le contraire est fausse là-bas sans l'être ici.
const etat = await (await fetch(`${BASE}/api/state`)).json();
const ELEVE = await estEleve(BASE);
console.log(`--- ${VOL}: instance ${ELEVE ? 'ÉLEVÉE' : 'normale'}, corbeille `
  + `${A_CORBEILLE ? 'présente' : 'ABSENTE'} ---`);
verifier('le serveur DIT si l’instance est élevée, et le dit en booléen',
  typeof etat.eleve === 'boolean', `eleve=${JSON.stringify(etat.eleve)}`);
verifier('l’instance est celle que le serveur annonce',
  etat.eleve === ELEVE, `état=${etat.eleve}, lu=${ELEVE}`);

// ---------------------------------------------------------------- 2. montage
//
// Un lot MINUSCULE : quelques octets. Aucun palier de taille n'est franchi, donc
// le seul mot possible est celui de l'instance — ce qui rend la loi lisible d'un
// coup d'œil, et impossible à confondre avec le palier.
fs.rmSync(DOSSIER, { recursive: true, force: true });
fs.mkdirSync(DOSSIER, { recursive: true });
fs.writeFileSync(`${DOSSIER}/cible.txt`, `cible-elevee-${Date.now()}\n`);
await post(`/api/scan/${VOL}`, {});
const indexe = await attendreFichier(BASE, VOL, 'cible.txt');
verifier('le lot d’essai est dans l’instantané', indexe,
  `« cible.txt » n’apparaît pas dans l’index de ${VOL}`);

// La descente par l'API, pour un SECOND avis indépendant de ce que l'interface a
// reçu. C'est la seule façon de mesurer l'accord entre les deux : l'interface
// pourrait afficher une liste de mots, et le serveur en exiger une autre, sans
// qu'aucune des deux pages ne s'en aperçoive. Le code de l'interface dit
// exactement ce risque — « le désaccord, c'est le garde-fou qui disparaît sans
// bruit » — et rien ne le mesurait.
async function tree(id) {
  const r = await fetch(`${BASE}/api/tree?drive=${VOL}&id=${id}&limit=400`);
  const texte = await r.text();
  // Le serveur ne renvoie pas du JSON quand il refuse : il répond en texte. Un
  // corps illisible est un fait, pas une panne — il revient comme tel.
  try { return JSON.parse(texte); } catch { return { error: texte.trim(), rows: null }; }
}
async function descendre(segments) {
  let t = await tree(0);
  let dernier = null;
  for (const nom of segments) {
    const r = (t.rows || []).find((x) => x.name === nom);
    if (!r) return { t: null, manque: nom, lu: segments.join('/') };
    dernier = r;
    t = await tree(r.id);
  }
  return { t, dernier, manque: null };
}

// -------------------------------------------------------- 3. l'interface, pour de vrai
const navigateur = await chromium.launch();
const page = await navigateur.newPage();
const erreursJs = [];
page.on('pageerror', (e) => erreursJs.push(e.message));

try {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('#drives .drive', { timeout: 30000 });
  // La recherche est refusée tant qu'aucun volume n'est choisi : sans ce clic,
  // la fonction sort en silence et la liste reste vide, ce qui ressemble à une
  // interface cassée.
  await page.click(`#drives .drive[data-letter="${VOL}"]`);
  await page.waitForTimeout(800);

  // --- LA BANNIÈRE, premier fait mesuré -------------------------------------
  // Le bandeau doit être présent SI ET SEULEMENT SI l'instance est élevée. Une
  // règle « si » n'est pas une preuve : sur une machine normale, une bannière
  // qui s'affiche quand même se prouve ici, et une bannière absente sur le runner
  // se prouve là-bas. La formulation « si et seulement si » couvre les deux
  // exécutions avec une seule vérification.
  const chip = (await page.textContent('#eleve .chip').catch(() => '')) || '';
  const bandeau = (await page.textContent('#eleve .warn').catch(() => '')) || '';
  verifier('le jeton d’interface reflète l’instance réelle',
    /administrateur/i.test(chip) === ELEVE,
    `chip=« ${chip.trim()} », élevée=${ELEVE}`);
  verifier('le bandeau est présent SI ET SEULEMENT SI l’instance est élevée',
    (bandeau.trim() !== '') === ELEVE,
    `bandeau=« ${bandeau.trim().slice(0, 90) || 'absent'} », élevée=${ELEVE}`);
  if (ELEVE) {
    // Un bandeau qui ne dit pas ce qui change informe sans prévenir. Les deux
    // mots qui font la différence : l'état (élevée) et la conséquence
    // (les protections de Windows ne s'appliquent plus).
    verifier('le bandeau nomme la CONSÉQUENCE, pas seulement l’état',
      /élev/i.test(bandeau) && /protection|ACL|droits/i.test(bandeau),
      `« ${bandeau.trim().slice(0, 160)} »`);
  }

  // --- ouvrir la modale, sans rien effacer ----------------------------------
  await page.fill('#q', NOM);
  await page.press('#q', 'Enter');
  const ligneDossier = page.locator('#rows tr')
    .filter({ has: page.getByText(NOM, { exact: true }) }).first();
  const contenuLignes = async () => {
    const t = await page.locator('#rows tr').allTextContents().catch(() => []);
    return t.length ? `lignes affichées : ${JSON.stringify(t.slice(0, 5))}` : 'aucune ligne dans #rows';
  };
  let dossierTrouve = false;
  try {
    await ligneDossier.locator('.nm').waitFor({ state: 'visible', timeout: 60000 });
    dossierTrouve = true;
  } catch { /* le verdict est rendu juste après */ }
  verifier('le dossier d’essai apparaît dans la recherche', dossierTrouve, await contenuLignes());

  let modaleOuverte = false;
  if (dossierTrouve) {
    // On attend que le FIL change : un clic suivi d'un délai ne distingue pas
    // « la navigation a eu lieu » de « le clic n'a rien fait ».
    const avant = await page.textContent('#crumbs').catch(() => '');
    await ligneDossier.locator('.nm').click();
    try {
      await page.waitForFunction(
        (a) => document.querySelector('#crumbs')?.textContent !== a,
        avant, { timeout: 60000 });
    } catch { /* mesuré par la suite */ }
    const ligneFichier = page.locator('#rows tr')
      .filter({ has: page.getByText('cible.txt', { exact: true }) }).first();
    try {
      await ligneFichier.locator('.chk').waitFor({ state: 'visible', timeout: 30000 });
      await ligneFichier.locator('.chk').check();
      await page.waitForSelector('#delbtn', { state: 'visible', timeout: 30000 });
      await page.click('#delbtn');
      // La modale ne s'ouvre que si le POST « dry » de l'interface est accepté.
      // Un 403 la laisserait fermée, et la suite conclurait que l'interface ne
      // demande rien.
      await page.waitForSelector('#modal:not(.hidden)', { timeout: 60000 });
      modaleOuverte = true;
    } catch { /* le verdict est rendu juste après */ }
  }
  verifier('la modale s’ouvre — donc l’interface a obtenu son aperçu', modaleOuverte,
    erreursJs.slice(0, 2).join(' | ') || 'elle ne s’est pas ouverte');

  if (modaleOuverte) {
    const corps = (await page.textContent('#dbody')).replace(/\s+/g, ' ');
    // Les champs de confirmation RENDUS, lus une fois. Tout ce qui suit porte
    // sur cet etat-la, et non sur ce qu on suppose qu il devrait etre.
    const motsInterface = await page.$$eval('#dbody .dconfirm',
      (ins) => ins.map((i) => i.getAttribute('placeholder')));

    // --- LA DESTINATION, fait independant du mot ----------------------------
    // Ce n est pas un detail d affichage : sur une instance elevee, le mode
    // corbeille exige `EFFACER`, et c etait precisement quand un mot
    // apparaissait que l interface cessait d annoncer la corbeille. L
    // utilisateur tapait un mot de suppression DEFINITIVE pendant que l ecran
    // ne disait plus rien du sort des fichiers. La destination est donc
    // mesuree DANS le cas ou un mot est exige, et pas seulement dans celui ou
    // il n y en a pas.
    const annonceCorbeille = /corbeille/i.test(corps);
    verifier('la destination est annoncee — corbeille, mode choisi',
      annonceCorbeille, `corps=« ${corps.slice(0, 200)} »`);
    verifier('la destination reste annoncee quand un mot est exige',
      motsInterface.length === 0 || annonceCorbeille,
      `${motsInterface.length} mot(s) exige(s) · destination `
      + `${annonceCorbeille ? 'annoncee' : 'ABSENTE'}`);

    // --- L ACCORD ENTRE L INTERFACE ET LE SERVEUR ---------------------------
    // Le chemin est ABSOLUT, segment par segment, et non « le dossier de la
    // sonde » : la racine de travail ne s appelle pas toujours
    // `_diskmap_sondes`. Sur le runner elle vaut `D:/a/_temp`, et c est en
    // remontant qu on descendrait alors dans le depot au lieu du dossier
    // d essai — la faute que `sonde-ui-suppression.mjs` a deja commise.
    const chemin = racine(VOL).split('/').filter(Boolean)
      .filter((x) => !/^[A-Za-z]:$/.test(x)).concat(NOM);
    const d = await descendre(chemin);
    const fichier = (d.t && (d.t.rows || []).find((x) => x.name === 'cible.txt')) || null;
    let serveur = null;
    if (fichier) {
      const r = await post('/api/delete', {
        drive: VOL, items: [fichier.sel], mode: 'dry', gen: d.t.gen,
      });
      serveur = r.j;
    }
    const motsServeur = (serveur && (serveur.mots_recycle || []).map((m) => m.mot)) || null;
    verifier('un second avis a pu etre obtenu sur le meme lot',
      motsServeur !== null,
      `fichier=${fichier ? 'trouve' : 'absent'}, lu=`
      + `${JSON.stringify(d.lu || chemin.join('/'))}, manque=${d.manque || 'rien'}`);

    if (motsServeur !== null) {
      verifier('l interface demande EXACTEMENT les mots que le serveur exige',
        JSON.stringify(motsInterface) === JSON.stringify(motsServeur),
        `interface=${JSON.stringify(motsInterface)}, serveur=${JSON.stringify(motsServeur)}`);
      verifier('un mot exige porte le motif qui le justifie',
        (serveur.mots_recycle || []).every((m) => m.raison && m.raison.length > 0),
        JSON.stringify(serveur.mots_recycle));
    }

    // --- LA LOI, enoncee sans parler de branche ----------------------------
    // C est la verification qui porte le nom de cette sonde. Elle ne dit pas
    // « sur une instance elevee, un mot est exige » : elle dit LA REGLE, et
    // elle est donc fausse si le serveur l enfreint dans un sens comme dans
    // l autre. Ni « attendue » ni « refusee » : une seule loi, deux moities,
    // et le journal dit en tete laquelle des deux cette execution a mesuree.
    const attendu = ELEVE ? ['EFFACER'] : [];
    verifier('LA LOI : corbeille presente, lot sous le palier, mode corbeille'
      + ' → `EFFACER` exige SI ET SEULEMENT SI l instance est elevee',
      JSON.stringify(motsInterface) === JSON.stringify(attendu),
      `mots=${JSON.stringify(motsInterface)}, attendu ${JSON.stringify(attendu)} `
      + `(corbeille=${A_CORBEILLE}, elevee=${ELEVE})`);

    // --- LE BOUTON : actif exactement quand la saisie satisfait --------------
    const actif = async () => page.$eval('#ddo', (b) => !b.disabled).catch(() => null);
    const saisir = async (v) => {
      const champs = await page.$$('#dbody .dconfirm');
      for (const c of champs) await c.fill(v);
    };
    if (motsInterface.length === 0) {
      // Rien a taper : le bouton doit etre actif d emblee. Une regle qui exige
      // un mot qui n est pas demande rend le geste impossible.
      verifier('sans mot exige, le bouton est actif sans rien taper',
        (await actif()) === true, `disabled=${!(await actif())}`);
    } else {
      verifier('avec un mot exige, le bouton reste inactif tant qu il est vide',
        (await actif()) === false, `disabled=${!(await actif())}`);
      await saisir('EFFACER ');
      verifier('un mot suivi d une espace n allume PAS le bouton',
        (await actif()) === false, `disabled=${!(await actif())}`);
      await saisir('EFFACER');
      verifier('le mot exact, au caractere pres, allume le bouton',
        (await actif()) === true, `disabled=${!(await actif())}`);
    }

    // --- RIEN N A DISPARU ---------------------------------------------------
    verifier('la verification n a rien efface : le fichier est toujours la',
      fs.existsSync(`${DOSSIER}/cible.txt`), `${DOSSIER}/cible.txt`);
  }
} finally {
  await navigateur.close().catch(() => {});
}

verifier('aucune erreur JavaScript dans l’interface', erreursJs.length === 0,
  erreursJs.slice(0, 3).join(' | '));

fs.rmSync(DOSSIER, { recursive: true, force: true });
await post(`/api/scan/${VOL}`, {});

console.log('');
console.log(`${verifs.filter(Boolean).length}/${verifs.length} vérifications vertes`);
if (echecs.length) {
  console.log('ÉCHECS :');
  for (const e of echecs) console.log(`  - ${e}`);
}
process.exit(echecs.length ? 1 : 0);
