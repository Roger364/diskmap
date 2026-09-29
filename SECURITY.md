# Audit de sécurité — diskmap 0.1.0

**Références de ligne :** les `fichier:ligne` de ce document ont été revérifiés le
**27/09/2026**, chacun désigné par le **symbole** qu'il annonce et non par un décalage —
c'est ainsi qu'on a trouvé que trois d'entre eux pointaient vers la mauvaise fonction, et
qu'un décrivait un défaut déjà corrigé dans le code. Une référence de ligne est une
affirmation : elle se vérifie comme une. Le contrôle est automatisé par
`tests/sondes/verifier-references.mjs`, joint à `npm test` : il vérifie que chaque ligne
cité existe, qu'elle n'est pas vide, et qu'elle contient bien le symbole que la
documentation annonce. Une référence **nouvelle** échoue tant qu'elle n'a pas été relue
et déclarée dans le tableau du contrôle — une référence non vérifiée ne passe pas en
douce.

**Date de l'audit :** 26/09/2026, 19:00–20:30
**Périmètre :** `src/main.rs` (serveur HTTP + suppression), `src/win32.rs` (SHFileOperationW),
`src/scan.rs` (parcours + cache), `ui/index.html` (interface), `tests/sondes/` (13 sondes
à l'audit ; 20 au 27/09),
`.github/workflows/build.yml`.
**Méthode :** lecture intégrale du code, historique git, exécution de `cargo test`,
`cargo clippy --all-targets -- -D warnings` et `cargo fmt --check`, puis rejeu des sondes
sur un **volume virtuel jetable** (`V:`, 512 Mio) expresslyement monté pour cela. Relevé de
l'état : `%LOCALAPPDATA%\diskmap\suppressions.log` (lecture seule).

---

## 1. Résumé

| | |
|---|---|
| Incident | Le 26/09/2026 entre 05:05 et 05:57, 168 fichiers réels supprimés, dont **79 détruits définitivement** (4,1 Mo) |
| Cause | Trois défauts cumulés, tous corrigés dans les sources depuis 06:30 |
| État du code aujourd'hui | Les deux chemins vers « supprimer autre chose que ce qui est affiché » sont **fermés** |
| Binaire publié | `v0.1.59` (`72704dd`) — compilé et éprouvé par la CI de ce commit : fmt, clippy, 51 tests, 194/194 références, **21/21 sondes** (`run 36514287640`) |
| Risque résiduel le plus élevé | Aucun connu : R1 à R4 corrigés et vérifiés |
| Nouvelle découverte de cet audit | XSS stockée via le nom de volume → effacement arbitraire sans interface |
| Seconde moitié de la cause | Le harnais de sondes n'avait aucun filet — §3.7 |
| Pertes réelles | **Aucune donnée unique perdue** — inventaire en annexe |

Verdict : les six causes sont corrigées, R1 à R4 aussi, et le filet du harnais empêche
désormais qu'une sonde puisse viser hors de sa racine. Ce qui reste ouvert est listé en §7.

**Ajout postérieur à l'audit.** Le filet comportait une seconde règle de refus —
celle du volume — qui ne pouvait pas se déclencher : `lettre()` normalisait le
chemin, ce qui supprimait la barre oblique finale, alors que la regex exigeait
`\\` après les deux-points. `lettre('A:\\')` renvoyait `''`, la condition était
toujours fausse, et la garde n'avait jamais rien refusé. Elle est réparée (§7/15)
et désormais éprouvée. Par ailleurs, le filet se rabattait sur une racine
*inventée* pour le volume secondaire : poser `DISKMAP_SONDE_RACINE` sur `V:` faisait
apparaître `E:/_diskmap_sondes` parmi les racines autorisées, sur un volume réel
de 55 Go que personne n'avait désigné (§7/14). Enfin, le harnais refuse désormais
de lancer des sondes destructrices hors d'un volume qu'il sait jetable (§7/16).

---

> **Le récit de l'incident est en annexe.** Deux journées ont produit un récit :
> `docs/incident-2026-09-26.md` (chronologie minute par minute, inventaire des
> pertes, et comment reproduire le défaut d'origine) et
> `docs/incident-2026-09-27-sondes.md` (la journée où sept sondes sont tombées sur
> un séparateur de chemin, où l'épreuve de rupture a prouvé que les sondes
> mordaient, et où les corriger a trouvé un vrai défaut produit).
> Ce document-ci est la politique : les causes, le modèle de menace, les constats,
> et ce qui reste à traiter. L'essentiel de l'incident du 26/09 tient en une
> ligne : un identifiant d'instantané était une *position* et non une identité, et
> une sonde destructive a résolu ses identifiants contre un index réanalysé —
> 168 fichiers réels visés, 79 détruits définitivement. C'est corrigé (`bb5c60e`)
> et éprouvé (`generation`).

---


## 3. Causes racines

### 3.1 Un identifiant n'est pas une identité — `bb5c60e` (corrigé)

Avant le correctif :

```rust
struct PendingDel { drive: char, items: Vec<DeleteItem>, at_ms: i64 }  // des POSITIONS
...
for it in &pending.items {
    let Some(path) = resolve(snap, it) else { continue };   // snap = instantané COURANT
```

`dry` résolvait les identifiants pour l'affichage, puis `execute` **re-résolvait les mêmes
identifiants** contre l'instantané du moment de l'exécution. Un identifiant étant une
position dans `snap.files` / `snap.dirs`, et l'application relançant une analyse **après
chaque suppression** et **au démarrage pour les volumes sans cache**, la fenêtre de dérive
(10 min, durée de vie du jeton) était largement ouverte. L'aperçu annonçait un fichier,
l'application en supprimait un autre, sans un mot.

Correction actuelle : `dry` exige la `gen` du client et refuse (409) si l'index a bougé
(`src/main.rs:1631`) ; `execute` ne résout plus rien et ne supprime que les chemins
figés par l'aperçu (`struct Montre`, `src/main.rs:110`).

**La moitié navigation est restée ouverte jusqu'au 27/09/2026 — voir R10.** Le correctif
ci-dessus ferme l'éffacement, parce que c'est lui qui était mesuré. Mais l'interface
épinglait le dossier courant par un identifiant, et le redemandait après chaque analyse :
la même dérive, appliquée à la navigation, est restée en place pendant toute la
correction de l'effacement, et même après elle. Une cause racine corrigée pour un seul
appelant n'est pas une cause racine corrigée : c'est un appelant sur deux.

### 3.2 Une page tierce pouvait effacer n'importe quel fichier — `679ee7d` (corrigé)

Aucune garde d'en-tête sur les routes mutantes. Une page web d'une autre origine pouvait
`POST /api/delete` avec `mode:"permanent"` et `confirm:"EFFACER"` dans le corps du JSON —
donc **sans que l'utilisateur clique quoi que ce soit et sans jamais avoir à taper le mot
de confirmation**. Vérifié dans un vrai Chromium (3 essais sur 3) par l'auteur du correctif.

### 3.3 Le jeton de suppression se déduisait de lui-même — `fbfca9a` (corrigé)

Le jeton valait `<ms>-<xorshift(ms)>` : l'horodatage était publié en clair, et le reste
s'en déduisait. Une attaque par énumération (≈11 candidats par tranche de 5 ms) retrouvait
un jeton valide et rejouait une suppression déjà confirmée par l'utilisateur.

### 3.4 DNS rebinding — `18f4826` (corrigé)

Sans contrôle de `Host`, une page servie sous le nom d'un attaquant résolu vers `127.0.0.1`
faisait lire l'arbre complet, y compris `/api/tree`. Combiné à 3.2 et 3.3, la chaîne
« lecture du disque + effacement » était complète.

### 3.5 La corbeille détruisait en silence — `45b8185`, `34586cb` (corrigé)

`FOF_ALLOWUNDO` signifie « mettre à la corbeille **si possible** ». Un volume sans
`$RECYCLE.BIN` (exFAT, clé USB) voyait Windows détruire le fichier. En prime, le code de
retour de `SHFileOperationW` mentait (2 = succès) et toute suppression réversible était
rapportée comme un échec — donc l'utilisateur lisait « échec » pendant que le fichier avait
disparu.

---

### 3.6 « Réversible par défaut » reposait sur une croyance — **corrigé le 27/09/2026**

La seule affirmation du projet qui ne s'appuyait sur aucune mesure. Le reste du
travail dit « le fichier est-il DANS la corbeille » — et c'est une mesure, faite
après coup sur les fiches `$I`. Ce qui n'était mesuré nulle part, c'est la
question suivante : **la corbeille le gardera-t-elle ?**

Elle ne le garde pas toujours. Windows plafonne la corbeille de chaque volume
(`HKCU\…\Explorer\BitBucket\Volume\{GUID}\MaxCapacity`) et purge ses entrées les
plus anciennes quand il le décide, sans demander. Le 27/09/2026, sur cette
machine, **trois volumes** portaient `NeedToPurge` — le propre drapeau de Windows
qui annonce la purge. Aucune ligne de code ne le lisait.

Ce que la mesure a donné, et qu'aucune déduction n'aurait fourni :

| Mesuré le 27/09/2026 | Valeur |
| --- | --- |
| Plafond de `C:` | 48,5 Gio |
| Plafond de `G:` | 24,7 Gio (occupé 295 Mio) |
| Plafond de `V:` (jetable) | **51 Mio** |
| Lot de 72 Mio mis à la corbeille de `V:` | corbeille à **1,66 ×** son plafond |
| Fichiers détruits à cet instant | **0** — les 12 y étaient |

La dernière ligne est la plus importante, et elle a corrigé ce que le correctif
annonçait d'abord. Le plafond **n'est pas appliqué au moment de la suppression** :
rien n'est détruit, la corbeille déborde simplement, et la purge viendra plus
tard, au rythme de Windows. L'avertissement affiché dit donc ce qui est mesuré
— « rien ne sera détruit tout de suite, et rien n'est garanti pour la suite » —
et non « Windows va détruire », qui aurait été faux, et l'a été pendant une
heure.

`NeedToPurge` n'est pas utilisé : sa valeur vaut 1 aussi sur `G:`, à 1,2 % de
son plafond. Un drapeau dont on n'a pas établi le sens ne fonde pas une décision.

Trois défauts sont apparus en chemin, tous mesurés et non déduits :

- **`GetVolumeInformationW` n'a aucun paramètre de format.** Le drapeau
  `VOLUME_NAME_GUID` n'existe que sur `…ByHandleW`. La fonction rend le LIBELLE
  du volume, et le plafond n'était jamais mesuré. Corrigé par
  `GetVolumeNameForVolumeMountPointW`.
- **La taille d'une fiche `$I` est à l'octet 8**, pas à l'octet 4. Établi en
  mettant deux fichiers de tailles connues (1 000 000 et 12 345 678 o) à la
  corbeille, puis en relisant leurs `$I`. Un octet de décalage ne produit aucune
  erreur : il produit des tailles fausses.
- **Une `$I` illisible se faisait passer pour une taille.** Sur `G:`, une fiche
  de 152 o portait 4,4 Po à l'octet 8, et l'occupation de la corbeille valait
  `u64::MAX`. La date est désormais exigée plausible, et la charge `$R` doit
  exister : une `$I` sans `$R` est une fiche orpheline, elle décrit un fichier
  qui n'est plus là.

Quand le plafond n'est pas mesuré, `corbeille_deborde` vaut `null` et
l'interface **n'affirme rien**. Un plafond de 5 % documenté mais non relevé
produirait `Some(false)` — c'est-à-dire exactement le mensonge retiré de cette
page.

Vérification, sur le volume jetable `V:` : 13/13 sondes vertes, dont
`sonde-corbeille-plafond.mjs`, qui écrit 52 Mio pour un plafond de 51 Mio et
vérifie que l'annonce suit l'inégalité. `cargo test` 22/22, `clippy -D warnings`
propre, `fmt --check` propre.

---

### 3.7 Le harnais de sondes n'avait aucun filet — **corrigé le 26/09/2026**

La seconde moitié de la cause, celle qui est dans le dépôt et non dans l'application.

Chaque sonde vérifiait ses propres chemins, au cas par cas. Une vérification oubliée
recommence l'incident : il n'y avait **aucun point unique** où la sécurité pouvait être
garantie. Trois défauts concrets dans l'état d'avant :

- `racine(vol)` ignorait le volume dès que `DISKMAP_SONDE_RACINE` était posée. Une racine
  sur `C:` avec un scan de `G:` ne coincidait avec rien : les sondes créaient leurs
  fichiers à un endroit et interrogeaient l'instantané d'un autre.
- Cinq sondes cherchaient leur dossier de travail par un **nom en dur** (`_diskmap_perime`,
  `essai-suppression`, `_diskmap_lot_cout`…) qui ne correspondait plus à ce que
  `dossier()` crée. Elles échouaient donc toutes en « absent de l'instantané », sans jamais
  s'exécuter.
- `VOLUME_DEFAUT` vaut `G`, et les sondes destructives sont activées par défaut. Un simple
  `node tests/sondes/lancer.mjs` suffisait donc.

Le correctif est `tests/sondes/filet.mjs` : un proxy interposé entre les sondes et le
serveur, qui ne transmet une exécution que si l'aperçu correspondant ne nommait que des
chemins sous la racine de travail. C'est un proxy, et non un correctif de `fetch`, parce
que deux sondes pilotent un vrai Chromium : un patch de `fetch` ne les toucherait pas. Le
filet est **fermé par défaut** — ce qu'il ne comprend pas, il le bloque — et il ne
se substitue au serveur que là où la transmission serait destructive : une sonde doit
pouvoir vérifier que le serveur refuse un jeton inventé, sinon elle n'éprouve plus rien.

La sonde `sonde-filet.mjs` rejoue la mécanique de l'incident sur un fichier à elle et
vérifie que le filet refuse, et que le fichier est toujours là. Elle s'exécute **avant**
toute sonde destructive : après, un filet défaillant aurait déjà fait son œuvre.

## 4. Modèle de menace

| Acteur | Ce qu'il peut faire aujourd'hui |
|---|---|
| Page web tierce | Rien. `X-Diskmap` sur tous les POST (`src/main.rs:956`), `Host` local sur **toutes** les routes, lectures comprises (`src/main.rs:878`) |
| DNS rebinding | Rien, pour la même raison |
| Processus local, même utilisateur | Tout : il peut supprimer directement. Le serveur n'est pas une frontière |
| **Volume au nom hostile** | **Effacer n'importe quel fichier, sans l'interface** — voir R1 |
| Utilisateur, usage normal | Effacer un fichier qu'il n'a pas coché, au-delà de 25 éléments — voir R2 |
| Utilisateur, app élevée | Tout hors les 7 noms réservés (`src/main.rs:1496`) — voir R5 |

---

## 5. Constats

### R1 — XSS stockée via le nom de volume → effacement arbitraire · **Haute** · *corrigé*

`ui/index.html:524-525` :

```js
<span class="lbl">${d.label || ''}</span>
${d.fs ? `<span class="fs">${d.fs}</span>` : ''}
```

`d.label` et `d.fs` proviennent de `GetVolumeInformationW` (`src/win32.rs:471`) : le nom de
volume est une **donnée externe**, contrôlable par quiconque formate une clé USB, monte une
image disque ou renomme un partage. Elle est interpolée dans un `innerHTML` **sans
`escapeHtml`**, alors que tous les autres noms venus du disque (tableau, carte, recherche,
illisibles, aperçus) passent par `escapeHtml`.

Un volume nommé `<img src=x onerror="…">` exécute du JavaScript dans l'origine de diskmap.
Cette origine a le droit de poser `X-Diskmap: 1` : le script peut donc appeler
`POST /api/delete` en mode permanent et effacer n'importe quoi. C'est le seul vecteur
d'effacement sans interaction restant, et il ne demande qu'un support amovible.

**Correctif :** `escapeHtml(d.label || '')` et `escapeHtml(d.fs)`. Le test de non-régression
est simple : un volume de test dont le nom contient `<` et `"`, analysé, ne doit produire
aucun nœud texte cassé.

### R2 — L'aperçu montre 25 chemins, l'exécution en supprime N · **Haute** · *corrigé*

`ui/index.html:1116` : `for (const it of d.items.slice(0, 25))`, suivi de
`… et ${d.items.length - 25} autre(s)`. Rien n'empêche l'exécution de traiter les N.

« Tout sélectionner » dans un dossier de 200 entrées affiche donc 175 chemins que
l'utilisateur n'a jamais vus, puis un clic les supprime. Le garde-fou au 20 Go
(`ui/index.html:1105`) est lui aussi purement client, et ne couvre pas le *nombre*.

Le README affirme : « *it is impossible to delete something that was not shown first, or on
the strength of a stale list* ». **La seconde moitié est vraie ; la première est fausse au-delà
de 25 éléments.** C'est aujourd'hui le principal residual : c'est lui qui protège les
documents personnels, puisque `blocked_reason` (`src/main.rs:1496`) ne refuse que
`C:\Users\<profil>` et non son contenu (`C:\Users\Ro\Documents` est effaçable).

**Correctif proposé :** afficher la liste complète dans une zone défilante, et faire refuser
par le serveur toute suppression dont le nombre d'éléments dépasse un seuil — le refus doit
venir du serveur, seul endroit qui ne peut pas être contourné par l'interface.

### R3 — Les tests de sécurité de l'incident ne tournent pas en CI · **Moyenne** · *corrigé le 29/09/2026*

`.github/workflows/build.yml` écarte toujours `generation,reelle,lot,ui,csrf,erreurs` de son
premier job : ce job peut tourner sur un runner auto-hébergé, où « volume jetable » n'est pas une
garantie. Le second job, `sondes`, tourne sur `windows-latest` — runner éphémère, `D:` scratch — et
exécute **toutes** les sondes, filet compris. `release` déclare `needs: [windows, sondes]` : aucun
binaire n'est publié si l'une des deux échoue.

**Ce constat est resté écrit après son propre correctif, et c'est ce qui l'a rendu nuisible.**
Un lecteur de ce document en concluait que la régression du 26/09 n'était plus gardée, donc
qu'une release verte ne disait rien de la sécurité de la suppression. C'était faux — et c'est le
document, seule source de vérité par excellence, qui affirmait le contraire de la mesure. Le défaut
n'était pas dans le code : il était dans un paragraphe jamais recontrôlé.

**Mesuré le 29/09/2026** — `run 36514287640`, commit `72704dd` :

```
windows SUCCESS · sondes SUCCESS · release SUCCESS
21/21 sondes vertes sur le runner, 4 notes de 3 sondes
filet : 5 executions refusees, 3 incidents — tous produits par sa sonde d'epreuve
17/17 regle du volume jetable · 194/194 references de la documentation
release v0.1.59 publiee, binaire repris TEL QUEL dans l'artifact eprouve
```

La même série, sur un volume virtuel jetable monté en local (`V:`, « Msft Virtual Disk », file
backed) : **21/21**, mêmes verdicts, filet 5 refus / 3 incidents.

### R4 — Le cache n'est validé que par son numéro de série · **Moyenne** · *corrigé*

`src/scan.rs:526` : `load(path, expected_serial)` vérifie le magic, la version et le numéro
de série. La racine est lue ligne 522 (`let root = …`) puis **jamais comparée** à la lettre du
volume. Or `dir_path` reconstruit les chemins à partir de `dirs[0].name` (`src/scan.rs:503`),
c'est-à-dire de cette racine.

Un `C.bin` contenant l'arbre de `G:` serait accepté. Scénario réaliste : `C:` défaillante,
une clé USB prend la lettre `C:`, et beaucoup de clés USB bon marché partagent leur numéro
de série. L'interface montre alors l'ancien arbre de `C:` — et les chemins affichés
pointent vers des fichiers qui, eux, appartiennent à un autre volume.

**Correctif :** rejeter le cache si `root` ne vaut pas `format!("{letter}:\\")`, et écrire la
lettre dans l'en-tête du cache.

### R5 — Aucun avertissement quand l'application tourne élevée · **Faible** · *corrigé*

`App.eleve` est connu et exposé dans `/api/state`, mais l'interface ne disait jamais que le
niveau de privilège change ce qui est effaçable. Au-delà des sept noms de `blocked_reason`,
tout devient supprimable.

**Correctif :** deux bandeaux, dans `ui/index.html`. Le premier, sous la pastille de la
colonne de gauche, dit ce que l'élévation change — *les protections de Windows ne
s'appliquent plus, tout le reste est effaçable, y compris ce que les droits du compte
refuseraient*. Le second apparaît dans la modale de suppression, au moment de la décision :
c'est le seul endroit où l'utilisateur regarde une liste de chemins qui vont disparaître, et
un avertissement lu au lancement six minutes plus tôt n'y est plus.

**Complété le 27/09/2026 :** deux bandeaux n'étaient pas une règle. Un bandeau se ferme avec
l'onglet, et rien n'obligeait à l'avoir vu ; surtout, l'interface choisissait le mot
`EFFACER` elle-même, selon `mode === 'permanent' || !corbeille` — un calcul fait chez le
client, que le serveur ne connaissait pas. Le serveur exige désormais le mot, et le
**dit** : `DeletePreview` porte `mot_recycle` et `mot_permanent`, et l'interface lit ce champ
au lieu de le refaire. Les deux modes sont répondus parce que la simulation se fait en mode
`dry`, donc avant le choix du mode ; répondre pour un seul laisserait l'interface deviner
l'autre.

La règle est `mot_exige(to_trash, corbeille, eleve)` : le mot s'**ajoute** aux autres
règles, il ne les remplace pas. Instance élevée ⇒ le mot de la suppression définitive, même
en mode corbeille, parce que la corbeille ne protège plus de rien quand les ACL ne
s'appliquent plus. Et le mot n'est pas exigé quand tout va bien : une règle qui s'applique
trop devient une règle qu'on contourne, puis qu'on saisit machinalement.

Vérification : `sonde-mot-exige.mjs` confronte l'annonce du serveur à la règle du projet
mode par mode, et éprouve le refus avec un jeton inerte — un sélecteur hors bornes, que la
résolution ne peut pas résoudre, donc sans rien supprimer.

**Complété le 27/09/2026 — le palier de taille.** Un garde-fou qui tient pour la corbeille
et l'instance élevée tenait pour 400 Go. Le 26/09, un geste unique a envoyé **74,2 Go** à
la corbeille et détruit 79 fichiers définitifs — sans rien demander, pendant qu'une photo de
2 Mo exigeait le nom de son dossier. Le seuil n'est donc pas une intuition : c'est l'échelle
de ce qui s'est passé.

`mots_exiges(taille, to_trash, corbeille, eleve)` rend une **liste**, pas un mot. Les règles
s'additionnent — un lot de 600 Go en suppression définitive demande `SUPPRIMER TOUT` **et**
`EFFACER`, parce que les deux motifs sont vrais indépendamment. Un mot unique qui choisirait
« le plus fort » ferait perdre l'autre, et l'utilisateur ne saurait jamais lequel s'applique :
il taperait le mauvais, se ferait refuser, et recommencerait au hasard. Chaque mot voyage
avec sa raison, affichée dans son champ : un champ nu se tape par réflexe, et un mot tapé
par réflexe ne protège de rien.

Sous le palier, rien n'est demandé. Une règle qui se déclenche sur « ouvrir un dossier,
effacer un cache » apprend ce geste, et un geste appris n'arrête plus rien.

**Une faute corrigée en route.** La comparaison de la confirmation a d'abord été écrite en
ignorant la casse et les espaces superflus. `sonde-suppression.mjs` l'a attrapée : elle
imposait, pour `EFFACER` seul, que `effacer` et `EFFACER ` soient refusés. C'était un
affaiblissement du garde-fou fait pour supporter un mot de plus — exactement le
changement qui ne se voit pas dans une diff de fonctionnalité. La règle est revenue à
l'égalité exacte, dans l'ordre, et le test la fixe des deux côtés.

Vérification de bout en bout, dans un vrai navigateur, sur `C:\ComfyUI` (114,24 Go) : le
champ `SUPPRIMER` apparaît avec son motif ; `supprimer`, `SUPPRIMER ` et `SUPPRIMER TOUT`
laissent le bouton mort ; `SUPPRIMER` l'allume. Rien n'a été supprimé — vérifié au journal
et sur disque. `sonde-palier.mjs` refait le trajet en lecture seule : elle fait des `dry` sur
le plus gros dossier de la machine (`G:\ggames`, 344,2 Go) parce que le volume jetable fait
511 Mio et ne peut pas atteindre le palier.

**Le runner de GitHub Actions est TOUJOURS élevé — et cela a coûté sept sondes.**

Rien dans le dépôt ne demande l'élévation, et le workflow ne la demande pas non plus :
les actions GitHub tournent en administrateur par construction. Le premier run où la
règle d'élévation est entrée en vigueur l'a donc prise pour un défaut du produit, alors
que c'étaient sept sondes qui affirmaient « aucun mot n'est exigé » en mode corbeille —
une affirmation codée en dur, vraie sur ma machine et fausse là-bas, sans qu'une seule
ligne d'application change de comportement. Le test était faux, pas le produit.

La conséquence est une règle de rédaction du harnais, pas une règle de code :

> Une sonde ne suppose jamais l'instance. Elle la LIT sur `/api/state`, et elle en
> déduit la règle qu'elle va éprouver.

`tests\sondes\config.mjs` porte `estEleve()` et `motsExiges()`, une **seconde
implémentation** de la règle du serveur — dérivée des faits, jamais recopiée de sa
réponse, sinon elle ne vérifierait plus rien. Sept sondes l'utilisent.

**Vérifié de bout en bout : `sonde-elevation.mjs`**, dans un vrai navigateur et sans rien
supprimer. Elle mesure la bannière, le jeton d'instance, l'accord exact entre les mots
demandés par l'interface et ceux que le serveur exige pour le même lot, la destination
qui reste annoncée quand un mot est exigé, et le bouton d'exécution qui s'allume sur le
mot exact, au caractère près. Elle énonce une **loi** et non une branche — corbeille
présente, lot sous le palier, mode corbeille ⇒ `EFFACER` exigé si et seulement si
l'instance est élevée — de sorte que le runner éprouve la moitié droite et la machine de
développement la gauche, sans qu'aucune des deux puisse valider l'autre.

Résultat mesuré le 27/09/2026, run `36329398102` : **19/19** sur le runner élevé, **16/16**
sur instance normale. L'écart n'est pas du bruit : ce sont les vérifications qui n'ont de
sens que d'un seul côté.

### R6 — Le journal ne dit pas ce qui était prévu · **Faible, mais structurant** · *corrigé*

`journal` (`src/main.rs:2714`) écrivait l'issue, la taille et le chemin **réellement traité**.
Il ne conservait ni le chemin prévu par l'aperçu, ni l'origine de la requête. C'est
précisément ce qui a rendu l'incident impossible à qualifier.

**Correctif :** chaque ligne porte désormais le lot, la génération, le sélecteur reçu, le
chemin **prévu** et le chemin **réalisé** :

```
1790449303852	corbeille	15	1	V:\_diskmap_sondes\filet\pave.txt
  lot=1790449303752-855b7400610a6652	gen=9	sel=2147483677
  prevu=V:\_diskmap_sondes\filet\pave.txt	motif=
```

Les cinq premiers champs ne changent pas : les ~4 800 lignes déjà écrites — dont les 168 de
l'incident — restent lisibles avec le même parseur. Les refus sont désormais journalisés
aussi (`issue=refuse`, avec le motif) : un journal qui n'écrit que les succès laisse le même
vide que l'incident, où on a lu 168 suppressions sans pouvoir dire, pour aucune, ce que
l'utilisateur avait sélectionné.

Le prévu et le réalisé sont égaux par construction — `execute` ne résout plus rien. Ils sont
deux colonnes **pour que cette égalité se vérifie à la lecture** : le jour où un chemin
résolu à l'exécution réapparaîtrait, l'écart serait dans le journal, sans relire le code.

### R7 — `pending` n'est purgé que par une exécution · **Faible** · *corrigé*

`src/main.rs:1767` insère à chaque `dry` ; le `p.retain` (`src/main.rs:1772`) n'était
appelé que dans `execute` (`src/main.rs:1816`). Des aperçus répétés sans confirmation
faisaient croître la map sans borne — jusqu'à 4 Mio d'identifiants, soit une centaine de
milliers de chemins. La purge est désormais dans les deux, et le code le dit au même
endroit (`src/main.rs:1768`).

### R8 — `is_dir` est cru sans recoupement · **Faible** · *corrigé*

`resolve` faisait confiance au drapeau `is_dir` du client ; rien ne rattachait un
identifiant au type que l'index lui avait assigné, et la garde `gen` est globale, pas par
ligne. Or les deux espaces d'identifiants **se recouvrent** : le dossier 34 et le fichier 34
coexistent sur n'importe quel volume. Un `is_dir` faux — ou inversé — désignait donc un
*autre* chemin, un dossier à la place du fichier coché, avec la taille du dossier. La garde
de génération ne le voyait pas : les deux identifiants étaient valides à la même génération.

**Correctif : le type est dans l'identifiant.** Un sélecteur est un `u32` dont le bit haut
dit le type (`scan::BIT_FICHIER`) ; `/api/tree` et `/api/search` le servent dans `Row.sel`,
et `/api/delete` ne reçoit plus qu'une liste de sélecteurs. Un client qui se trompe de bit
n'atteint plus aucun autre chemin que celui qu'il désigne : il n'atteint rien, et l'aperçu
le déclare « identifiant irrésoluble ».

Deux gains que le correctif apporte par construction :

- **La taille ne peut plus mentir séparément du chemin.** `resolve` et `index_size` lisaient
  tous deux `is_dir` dans deux fonctions distinctes ; une incohérence entre les deux ne se
  serait vue nulle part. `Snapshot::entree` lit chemin, type, taille et compte dans le même
  `if`, et renvoie un seul type (`Entree`).
- **L'ancienne forme est refusée, pas tolérée.** `{id, is_dir}` ne se désérialise plus du
  tout (`400`, « invalid type: map, expected u32 »). Une forme héritée qui continue de
  fonctionner est une forme que l'on croit encore sûre ; ce serveur n'a qu'un client — son
  interface embarquée — et il a été mis à jour dans le même changement.

Coût assumé : l'espace des identifiants est borné à 2³¹ par volume, ce qui est hors de
portée de tout disque réel.

### R9 — Noms Windows normalisables · **Vérifié, sans défaut**

Le scan en mode verbatim voit des noms qu'un chemin normal ne peut pas adresser (espace ou
point final). Le risque annoncé : l'aperçu afficherait `foo ` et l'effacement viserait `foo`.

**Vérifié sur un VHD jetable, le 26/09/2026 : ce défaut n'existe pas.** Créé par
`CreateFileW` en forme `\\?\`, un fichier nommé `piege.txt ` (espace finale) :

- `listdir` le voit sous son vrai nom, `'piege.txt '` ;
- `os.path.exists` en forme **verbatim** renvoie `True`, en forme **normale** renvoie
  `False` — les deux ne désignent pas le même chemin ;
- l'instantané le liste correctement (`sel=2147483649`, `is_dir=false`), distinct de
  `normal.txt` ;
- l'aperçu affiche `V:\_r9\piege.txt ` **avec son espace**, et le déclare
  `blocked=true`, `deletable=0`, motif « introuvable sur le disque ».

Le refus vient de `delete_path` (`src/win32.rs:242`), qui interdit le préfixe `\\?\` —
justement parce qu'il court-circuite la corbeille. Un nom qui n'est adressable qu'en
verbatim est donc **visible mais jamais effaçable** : il ne peut pas viser un autre fichier,
il ne peut rien viser du tout. La classe de bug est fermée par une règle déjà en place,
sans code supplémentaire.

Reste un détail d'affichage assumé : l'interface rend `piege.txt ` sans le rendre visible
(espaces finales), ce qui peutcheonner un utilisateur qui cherche pourquoi le fichier est
refusé. Le motif dit « introuvable sur le disque », ce qui est vrai mais pas pédagogique.

### R10 — L'écran changeait de dossier après une réanalyse, sans le dire · **Haute** · *corrigé le 27/09/2026*

Le même identifiant en position que §3.1, appliqué à la navigation, et d'autant plus
grave : §3.1 pouvait faire supprimer le mauvais fichier, ce défaut faisait **viser le
mauvais dossier**, et la ligne cochée appartenait alors à ce dossier-là.

**Mesuré, sur le runner, le 27/09/2026.** L'interface se trouvait dans le dossier de la
sonde ; après une réanalyse, elle affichait `D:\a\diskmap` — le dépôt. La sonde a reçu le
clic (`memeNoeud: true`), `cur.id` est bien passé de 8 à 11, et la navigation a visé ce
que désignait le 11. La génération est passée de 28 à 29 pendant le clic.

**Déclencheur, et il est dans le geste normal de l'application.** Après une suppression,
le serveur pose `rescan = scan_ticket.is_some()` (`src/main.rs:2104`) et l'interface part en `poll()` ;
`poll()` attend la fin de l'analyse puis appelle `load()`, qui redemande `id: cur.id`.
La veille de fond voit en outre **toute** analyse lancée depuis une autre fenêtre et part
en `poll()` aussi. Un numéro d'index est réattribué dès qu'un dossier apparaît ou
disparaît ailleurs sur le volume — et le runner churn en permanence, ce qui l'a fait
naître là et jamais sur le volume de développement.

**La règle :**

> Une cible s'adresse par son chemin. Un identifiant est une position, et une position
> ne se demande pas comme une adresse.

**Le correctif, dans les deux sens.** `/api/tree` et `/api/open` résolvent un `chemin`
palier par palier depuis la racine ; chaque ligne, chaque palier du fil d'Ariane et la
clé de sélection portent le leur ; et le serveur renvoie toujours le chemin reconstruit
par l'index, jamais celui qu'il a reçu — donc un chemin venu du client n'ouvre que ce que
l'analyse a vue. Second sens : un dossier qui n'existe plus reçoit un **404 nommé**, que
l'interface affiche (« ce dossier n'existe plus ») avant de remonter d'un cran. Elle ne
montre surtout pas un autre dossier à la place.

**Épreuves, les deux sens cassés puis remis à l'octet près.** Résolution de chemin
renvoyant la racine : la navigation devient impossible et la sonde le dit. 404 remplacé en
silence par la racine : les deux verdicts « dossier disparu » rougissent, et la mesure
montre l'application à la racine, sans un mot. Tests Rust : `dossier_de` retrouve le même
dossier dans deux instantanés dont les numéros sont redistribués, refuse un chemin absent
au lieu de désigner un autre, ignore la casse et les deux séparateurs. Sonde bout en bout :
`sonde-identifiant.mjs`, 13/13 sur le runner comme en local.

**Ce que la sonde de R10 a coûté au run suivant, et qui vaut autant.** Le 28/09/2026, le
runner a rendu `identifiant` **rouge** : `identifiant 10 -> 10 sur ce volume`. Ce n'était pas un
retour en arrière de R10 — les onze autres verdicts passaient, dont « un dossier disparu est
DIT, pas remplacé » — mais une **démonstration** devenue impossible. La sonde prétend ne pas que
l'identifiant bouge : elle exige que son support soit réel, parce qu'une preuve qui ne se prouve
pas n'est pas une preuve.

**La cause est dans le scanneur, et elle est irréductible.** `src/scan.rs` lit les entrées par
`fs::read_dir` **sans les trier** (`src/scan.rs:977`). L'ordre est celui du système de fichiers, il n'est
pas le nôtre. Le remplissage de la sonde vivait à la racine du volume, donc en frère de la racine
de travail : NTFS pouvait l'énumérer avant ou après, et ce jour-là c'était après — les
identifiants ne bougeaient pas. Sur un volume calme, cette sonde ne pouvait donc pas prouver
ce qu'elle prétend, et le runner l'a montré en la faisant **rouge** — punir la sonde d'un volume
calme n'est pas un test, c'est un tirage à pile ou face.

**Le correctif, en deux temps.** Le remplissage passe **dans** la racine de travail, où il dispute
la position au dossier de la sonde dans le même parent : le décalage devient quasi certain, et le
ménage vient avec la racine. Puis le support est **vérifié** avant toute conclusion — le
remplissage a-t-il été vu par l'analyse ? Cette vérification-là est déterministe : un dossier
absent de l'instantané est un **échec**, pas une démonstration indisponible. Enfin, si le support
est bien là et que l'identifiant ne bouge quand même pas, la sonde **le dit** et le porte à son
résumé (`+1 non mesurable`), au lieu de rougir. Elle ne se déclare pas verte en silence non plus :
c'est le même refus que R12, appliqué à une démonstration.

**Épreuves.** Remplissage supprimé avant la réanalyse : `ROUGE le remplissage a bien été vu par
l'analyse`, mesuré `0/300`, run en `1` — et la note de démonstration indisponible sort **en même
temps**, ce qui prouve les deux chemins d'un coup. Tout remis : `13/13`. Le principe est celui
qu'un test doit honorer dans les deux sens : ne pas passer toujours, et ne pas échouer pour une
raison qui n'est pas celle qu'il mesure.

**Un détail que la mesure a refusé, et qui vaut d'être écrit.** Sur le volume jetable de
511 Mio, l'analyse est finie avant que la veille de quatre secondes ne la voie :
l'interface ne recharge rien. La sonde provoque donc le rechargement par un geste
d'utilisateur et exige que la génération affichée ait changé. Sans cela, son verdict « même
dossier » passait à vide — un test qui passe toujours ne prouve rien, et c'est la moitié
du travail de ce constat.

### R11 — Deux réglages coup sur coup : la réponse la plus ancienne peint l'écran · **Moyenne** · *corrigé le 28/09/2026*

Même famille que R10 et §3.1, et le même refus : **un écran qui montre autre chose que ce que
l'interface dit**. R10 visait le dossier, celui-ci vise l'ordre. La cible de suppression, elle,
n'était pas concernée : les lignes affichées étaient les bonnes, dans un autre ordre.

**Mesuré, en local, le 28/09/2026.** Deux sélecteurs — le tri, puis le sens — enchaînés. L'état
affiché portait `tri=name` et `ordre=asc`, et la liste était rangée par nom **décroissant**. Les
huit lignes étaient exactement celles du dossier de la sonde : ce n'était ni un volume instable
ni un tri cassé, c'était une réponse peinte à la place.

**Le serveur n'est pas en cause.** `/api/tree?order=asc` et `order=desc` rendent deux listes
opposées, mesuré sur la même requête. Le défaut est dans le client : `load()` n'avait aucun
séquencement, donc deux rechargements qui se croisent se peignent **dans l'ordre de leur
arrivée**.

**La règle :**

> Une seule réponse a le droit de peindre : la dernière demandée. Une réponse périmée ne touche
> même pas l'état — sinon la suivante hérite d'un état déjà mêlé.

**Le correctif.** Un jeton par requête (`ui/index.html:733`), incrémenté au départ de `load()` et
de `search()`, comparé à l'arrivée (`ui/index.html:769` et `ui/index.html:986`). La réponse
périmée rend la main sans rien écrire. Son **erreur** non plus n'est pas dite : la parler ferait
remonter d'un cran un dossier qui n'a pas disparu, puisque le chemin à remonter serait celui de la
requête périmée (`ui/index.html:792`).

**Épreuves, les deux sens.** Jeton retiré, 2 s de latence injectée sur `/api/tree` : deux verdicts
rougissent, et le nouveau — « l'ordre demandé n'a jamais été contredit à l'écran » — nomme la
contradiction au lieu de la constater. Jeton remis, même latence : 36/36, et l'historique des
peintures ne contient plus que les deux situations attendues.

**Un second détail que la mesure a refusé, et qui vaut d'être écrit.** La sonde lisait l'écran à
la **première** peinture. Le défaut se jouait deux secondes plus tard : son vert ne prouvait rien
sur la dernière réponse, et son rouge ne tombait que par hasard de charge — une fois sur un run
complet, jamais sur un volume rapide. Elle enregistre donc chaque peinture
(`tests/sondes/sonde-ui-suppression.mjs:537`) et attend que l'écran se taise
(`tests/sondes/sonde-ui-suppression.mjs:560`) avant de lire quoi que ce soit. Le verdict qui en
découle (`tests/sondes/sonde-ui-suppression.mjs:780`) est le seul qui voie les peintures
intermédiaires ; tous les autres lisent un instant, et cet instant peut précéder la dernière
réponse.

**Ce que la fenêtre de deux secondes est, et n'est pas.** Un choix, déclaré : une réponse périmée
peut arriver après le dernier rendu utile, et une fenêtre trop courte ne la verrait pas — son vert
ne prouverait alors que la rapidité de la machine. Deux secondes couvrent le service d'un
`/api/tree` sur un volume analysé, là où la course a été mesurée.

---

### R12 — Une sonde qui ne compte pas ses vérifications passait au vert · **Haute** · *corrigé le 28/09/2026*

Ni l'interface, ni le serveur : **le dispositif de mesure lui-même.** Même famille que R10 et R11 —
un test qui ne prouve rien vaut moins qu'un test absent — mais vue d'un côté qu'aucune des deux ne
couvre : ce qu'il advient quand la sonde, et non le produit, ment.

**Mesuré, sur le runner, le 28/09/2026.** Le harnais affichait, sur **tous** les runs verts depuis
des semaines :

```
vert   generation      SANS SYNTHESE
```

Le mot était juste : `sonde-generation.mjs` n'écrivait aucun décompte. Elle ne s'appuyait pas sur
le helper des dix-neuf autres sondes, mais sur un tableau `rouges` qui comptait les **échecs** —
et jamais le nombre total. Cinq vérifications, toutes faites, toutes justes, jamais comptées.

**Pourquoi c'est resté vert si longtemps.** Le mot `SANS SYNTHESE` avait été introduit exprès pour
rendre le symptôme visible — et il rendait service. Le harnais distinguait alors deux cas par un
tiret : un résumé absent, et une sonde **morte**. Rendre le premier visible avait rapproché les
deux, sans les séparer : un mort et un muet sortaient tous deux en `0`. Le mot signalait, rien ne
faisait échouer, donc rien ne pouvait être corrigé.

**La règle :**

> Une sonde qui sort en `0` sans avoir écrit son décompte n'a rien mesuré. C'est un échec, pas une
> note — et elle ne se distingue d'une sonde morte que parce qu'elle a eu la politesse de parler.

**Le correctif, en deux morceaux qui se répondent.** La sonde passe par un `verifier()` commun
(`tests/sondes/sonde-generation.mjs:37`) qui tient le décompte et écrit la dernière ligne
(`tests/sondes/sonde-generation.mjs:167`) ; c'est la forme des dix-neuf autres, qui n'avait jamais
été appliquée ici. Le harnais, lui, refuse le silence : sans `compte`, le code est forcé à `1`
(`tests/sondes/lancer.mjs:863`) et le motif est écrit (`tests/sondes/lancer.mjs:967`). Un résumé de zéro a sa propre porte : `tests/sondes/lancer.mjs:862`, motif `tests/sondes/lancer.mjs:963`. Sans ce
second morceau, le premier n'aurait rien empêché : une prochaine sonde sans résumé serait repassée
verte.

**La deuxième garde, trouvée en cherchant la limite de la première.** Ce qui précède
n'interdisait que le silence. Or une sonde écrivant son résumé **avant** ses vérifications
continuait de passer : le mot était là, juste, et faux. Le harnais ne recomptait rien — il
croyait la sonde sur parole.

**La règle, alors complétée :**

> Un résumé doit être un compte fidèle des verdicts écrits, **les deux termes**. Le
> numérateur dit ce qui a passé, le dénominateur dit ce qui a été vérifié — et un seul des deux
> laisse passer l'autre moitié du mensonge.

Le harnais compte donc les lignes de verdict réellement écrites et compare
(`tests/sondes/lancer.mjs:886`) ; l'écart est nommé avec les deux mesures
(`tests/sondes/lancer.mjs:970`). Un seul terme n'aurait pas suffi : un résumé écrit d'avance
donne « 5/5 » juste tant que tout passe. C'est le numérateur qui révèle qu'un verdict a
rougi après coup, et le dénominateur qu'une vérification a été ajoutée sans être comptée.

**Mesuré avant d'écrire, jamais après.** Les vingt sondes d'un run complet ont été
déchargées une à une : les vingt numérateurs égalaient le nombre de lignes `ok`, les vingt
dénominateurs le nombre de `ok` + `ROUGE`. Aucun `vert` en tête de ligne, donc ni l'un ni
l'autre n'entre dans le compte. La règle **ne sépare rien aujourd'hui** — elle interdit
seulement ce qui passerait désormais. C'était le point à vérifier avant d'écrire : un
contrôle « décompte égale totaux », plus grossier, aurait produit trois rouges sur
`aNommer`, `recherche` et `rechercheGrande`, qui écrivent du texte après leur résumé.

**Épreuves, dans les deux sens, et sur les deux termes.**

| Sonde falsifiée | Ce que le harnais dit | Sortie |
|---|---|---|
| résumé supprimé | `aucun décompte écrit : la sonde n'a rien rapporté` | `1` |
| une condition fausse (`409` → `418`) | `4/5 vérifications vertes`, mesure `HTTP 409` | `1` |
| résumé écrit **d'avance**, un verdict rouge, **sortie 0** | `annonce 5/5, et a écrit 4 ok et 1 ROUGE` | `1` |
| un verdict écrit **après** le résumé | `annonce 5/5, et a écrit 6 ok et 0 ROUGE` | `1` |

Les deux dernières sont les cas que la seule garde muette laissait passer, y compris le plus
grave des quatre : une sonde qui **ment sur son numérateur et sort en 0 quand même**. Le
journal affiche alors son `5/5 vérifications vertes` à côté du diagnostic qui le dément — la
preuve, à une ligne d'écart, que le mot ne disait rien.

Tout remis : `5/5`, puis `20/20 sondes vertes`, sans un seul `SANS SYNTHESE` au journal.


**La troisième garde, et ce qu'elle a révélé tout de suite.** Les deux premières interdisent
qu'une sonde **muette** ou qu'elle **mente sur son décompte**. Restait le cas le plus discret : une
sonde qui mesure ce qu'elle peut, **note** ce qu'elle n'a pas pu, et sort quand même en `0`. Le
harnais n'affiche la sortie d'une sonde **qu'en cas d'échec** — donc, sur un run **vert**, une note
n'atteignait jamais le journal. Non pas rare : impossible à voir.

**La règle :**

> Une note existe pour dire ce qu'un vert ne prouve pas. Si elle n'apparaît que sur les runs rouges,
> elle ne sert à rien — et pire, on ne peut même pas mesurer combien il y en a.

Le harnais les relève donc dans **chaque** verdict (`tests/sondes/lancer.mjs:916`) et les imprime
au résumé du run avec leur **texte**, pas seulement leur nombre
(`tests/sondes/lancer.mjs:1018`) : un compte sans dire de quoi n'apprend rien, et un diagnostic jeté
par l'outil censé l'afficher est un diagnostic absent.

**Mesuré à la première ligne qui compte : huit notes par run, sur quatre sondes, invisibles depuis
toujours.** Et la plus importante des huit disait, noir sur blanc :

```
erreurs : branche « écart négligeable » NON exercée — 5 volume(s), tous au-dessus
          du seuil. Ce vert-là ne prouve rien.
```

Une sonde qui reconnaît que son vert ne prouve rien, et que personne ne pouvait lire depuis des
mois. C'est exactement ce que la règle précédente faisait d'exister.

**Puis il a fallu nettoyer le signal, sinon il s'éteindrait de lui-même.** Sur ces huit notes,
**cinq étaient de l'avancement** — « corbeille : 1 sous-dossier lisible », « génération 32 -> 33 »,
« dossier de travail retiré » — et non un avertissement. Un signal dont trois quarts sont du bruit
s'apprend à être ignoré, et c'est lui qui disparaît en premier. Deux sondes ont donc reçu un canal
`info()` distinct, et `noter()` ne sert plus que pour ce qu'il faut savoir. Les trois notes qui
restent, sur un run local, sont toutes porteuses : une recherche **tronquée à 800**
(`exact=false, tronque=true`) et la branche non exercée ci-dessus.

**Ce que cela ne change pas.** Une note ne fait **pas** échouer le run. Ce serait la même erreur que
celle du 28/09 : punir la sonde d'un volume calme. La note est un fait à connaître, pas un défaut
de produit — et elle est désormais impossible à manquer.

**La limite qu'on croyaitataloguée — et ce que la mesure dit vraiment.** La règle compte des lignes
de verdict à un préfixe donné (`ok`, `ROUGE`). Une sonde qui écrirait son verdict ailleurs — en
fin de ligne, dans un tableau — ne serait pas comptée, et le décompte la déclarerait fausse à
juste. C'était écrit ici comme un risque de **faux vert**. Falsifié avant d'y toucher, parce
qu'un risque supposé ne mérite pas une règle :

| Falsification, une seule modification | Ce que le harnais a dit |
|---|---|
| le préfixe devient `vert` (le résumé, lui, reste honnête) | `décompte incohérent : la sonde annonce 5/5, et a écrit 0 ok et 0 ROUGE` |
| le résumé est figé à `0/0`, verdicts intacts | `décompte incohérent : la sonde annonce 0/0, et a écrit 5 ok et 0 ROUGE` |

**Aucun des deux ne passe, et aucun ne peut passer seul.** Le décompte à double terme rend la
convention auto-vérifiante : déplacer le préfixe sans toucher au résumé produit un rouge, et
figer le résumé sans déplacer le préfixe en produit un autre. Pour atteindre un faux vert, il
faudrait déplacer les deux **ensemble** — une édition coordonnée, donc une décision, pas une
dérive. La limite est réelle, mais c'est un **refus dans le bon sens** : un verdict que le
harnais ne sait pas lire est un verdict qu'il ne peut pas vérifier, et il le dit.

**La quatrième garde, trouvée en cherchant ce trou-là : un résumé de `0/0`.** En cherchant le
faux vert ci-dessus, il y en a un qui ne demandait **qu'une** modification — et il est passé.
Une sonde dont le jeu de cas est vide n'écrit aucun verdict, et son résumé, calculé comme les
autres, vaut `0/0`. Le harnais y voyait un résumé : la garde muette ne pouvait donc pas mordre.
La mesure, sur `generation` sortie avant son premier `verifier()` :

```
vert   generation      0/0
  1/1 sondes vertes
  aucune note
```

Exactement la même ligne qu'une sonde de trente-huit vérifications. Et le bilan du harnais
certifiait le silence : `1/1 sondes vertes`, `aucune note`. Le pire n'était pas le `0/0` — c'est
que **rien dans le journal ne pouvait le distinguer** d'un travail réellement fait.

**La règle :**

> Un résumé de `0/0` n'est pas un résumé. « Je n'avais rien à tester » n'est pas une mesure :
> c'est un défaut de la sonde, pas une propriété du volume, et cela se corrige.

**Pourquoi rouge, et non une note.** Une note, c'est « ce volume ne peut pas me montrer cela »,
et c'est légitime — c'est même ce que fait `identifiant` depuis le 28/09. Ici ce n'est pas le
volume qui décide : une sonde n'a pas de jeu de cas, ou son jeu de cas est vide. Si une sonde
n'a réellement rien à tester sur un volume donné, elle doit **vérifier qu'elle n'a rien à
tester** : l'absence est une mesure, comme le dit déjà R10 pour le support d'une démonstration.

**Mesuré avant d'écrire la règle, sur trois runs complets** (le 28/09/2026, deux fois en local
et une fois sur le runner) : la plus petite des vingt-et-une sondes annonce `1/1` — `palier` —
et les autres entre `3/3` et `38/38`. Aucune n'annonce `0`. La règle **ne sépare rien
aujourd'hui** ; elle interdit seulement ce qui passerait désormais.

**L'épreuve, dans le sens qui compte.** La sonde falsifiée sort en `1`, le motif est écrit, et
sa propre sortie reste sous le diagnostic — `aucun cas a tester sur ce volume`, puis
`0/0 vérifications vertes` — pour qu'on voie ce qu'elle a fait de son absence :

```
ROUGE  generation      0/0
         résumé vide : la sonde annonce 0/0 vérification, donc elle n en a
         fait aucune. « Je n avais rien à tester » n'est pas une mesure :
         sur un volume qui ne donne rien, c est cela qu il faut vérifier.
         aucun cas a tester sur ce volume
         0/0 vérifications vertes
  0/1 sondes vertes
  ROUGES : generation
```

**Ce qui reste ouvert.** Le contrôle à double sens de `verifier-references.mjs` a exactement la
même limite — il lit ses propres lignes `ok` / `ROUGE` pour les compter. Pour lui, le refus est
dans le bon sens aussi : il annonce lui-même un compte, donc un `verifier()` qui n'écrirait rien
serait vu. Mais il ne distingue pas un `verifier()` renommé d'un `verifier()` absent, et c'est
le suivant à traiter.


### R13 — Tout lancement scripté ouvrait une fenêtre du navigateur à l'écran · **Moyenne** · *corrigé le 28/09/2026*

Même famille que le filet des fenêtres, et le même refus : **ne pas toucher au bureau de celui qui
a lancé le programme.** Le filet traitait l'Explorateur ouvert par `/api/reveal` ; celui-ci traite
l'autre extrémité du binaire, celle qu'aucune sonde ne surveille — parce qu'aucune ne la provoque.

**Mesuré, sur le poste de l'auteur de ces lignes, le 28/09/2026.** Une fenêtre `Espace disque —
Brave` apparaissait sur le bureau. Ce n'étaient ni les sondes ni le harnais : `lancer.mjs` passe
`--no-browser` depuis le début (`tests/sondes/lancer.mjs:384`). C'étaient les lancements manuels,
et ceux d'un agent — `diskmap --port 8990` — dont **personne ne se rappelait le drapeau**.
`open_in_browser` n'écoutait que `--no-browser`, donc tout ce qui ne le passait pas ouvrait une
fenêtre. Le harnais était discret par une convention qu'il était le seul à connaître.

**La règle :**

> Le navigateur ne s'ouvre que pour un lancement **interactif**. Le signal est le même que partout
> ailleurs dans ce binaire : y a-t-il une console ? Au double-clic, oui. Depuis un script, non.

**Pourquoi pas l'autre sens.** On pourrait faire de `--no-browser` la norme, mais la décision
resterait une convention : le défaut qui ouvre reste le défaut, et le premier lancement sans
drapeau recommence. Ici l'absence de fenêtre est le défaut, et l'ouverture est une exception
qu'il faut demander. Ouvrir une fenêtre qu'on n'a pas demandée est une intrusion, quelle que soit
l'innocence du code.

**Le correctif.** Une fonction pure et testable (`src/main.rs:212`), alimentée par le signal réel
(`src/main.rs:340`). Les deux drapeaux restent, et **priment sur le signal** : `--browser` pour
forcer, `--no-browser` pour interdire. Un comportement qu'on ne peut ni forcer ni interdire n'est
pas une règle, c'est une pente. Quand les deux sont présents, l'interdit l'emporte — l'ordre des
deux lignes décidait de l'issue, et une règle dont l'issue tient à l'ordre de deux lignes n'en
est pas une.

**Et il le dit.** Sans console, le serveur affiche pourquoi il n'ouvre rien
(`src/main.rs:345`). Un serveur qui se tait laisse croire à un défaut ; celui qui n'explique pas sa
décision ne la méritait pas.

**Épreuves, les deux sens.** Lancement sans drapeau, sans console, fenêtres comptées avant et
après : **0 fenêtre apparue**, et la ligne d'explication à l'écran. Ancien comportement remis,
même lancement : **1 fenêtre**, `Espace disque — Brave`, `iconic=False` — le symptôme reproduit,
déterministiquement, et non « peut-être ». `--browser` remis : la fenêtre revient, donc
l'échappatoire fonctionne et n'est pas un interrupteur décoratif.

**L'instrument, et sa limite.** L'énumération des fenêtres ne fonctionne **que** depuis un
PowerShell lancé par node : lancé depuis Git Bash, il ne rend rien, alors que le navigateur
existe. Un cas non mesuré ne vaut ni vert ni rouge, et le dire a évité de conclure à partir d'un
zéro affiché qui était un angle mort. C'est aussi ce qui a coûté du temps le 28/09 : `tasklist`
et `Get-Process` annonçaient `0` processus pendant qu'un Chromium tournait.

**Ce que la règle ne couvre pas.** Elle repose sur le signal de console, qui est une convention du
système d'exploitation, pas une garantie. Une personne qui lance `diskmap` avec son entrée
standard redirigée verra le message qui explique pourquoi, et `--browser` sera là.

---

### R14 — La veille de fond suivait l'état, jamais l'écran · **Haute** · *corrigé le 28/09/2026*

Même famille que le 404 du 27/09 et que R11 : **un écran ne doit pas contredire ce que le
serveur dit.** Ici le contreditement était silencieux, durable, et ne se voyait pas — parce
qu'aucune sonde ne le cherchait, et parce qu'il ne se voyait que sur un volume assez lent pour
qu'une analyse dure plus de quelques secondes.

**Le code annonçait le contraire de ce qu'il faisait.** Sa propre documentation, à deux lignes
de l'endroit :

> Veille de fond : elle ne sert qu'à suivre un volume analysé depuis une autre fenêtre.

Une analyse déclenchée **ailleurs** — depuis une seconde fenêtre, ou par une sonde — laissait
cette fenêtre afficher l'instantané précédent. Le rechargement de l'arbre n'existait que dans
`poll()`, or `poll()` n'est lancé que par deux gestes locaux : « Analyser », et le démarrage
si une analyse est déjà en cours. Il **s'éteint** après un tour. Une analyse étrangère ne le
déclenche donc jamais.

**Mesuré, sur le poste de l'auteur de ces lignes, le 28/09/2026.** Trois lectures de l'état
client prises au moment du geste, puis soixante secondes plus tard :

```
avant    {gen 9, statut scanning, scanning 'C',  veille vive, requete 6}
immediat {gen 9, statut scanning, scanning 'C',  veille vive, requete 6}
final    {gen 9, statut ready,     scanning null, veille vive, requete 6}
```

**`scanning` n'est pas un booléen, et le l'écrire comme tel a coûté une vérification.** Le champ
`scanning` de `/api/state` porte la **lettre** du volume en cours — `"C"`, `"V"` — ou `null`
quand rien ne tourne : `scanning: Mutex<Option<char>>` (`src/main.rs:125`), sérialisé en
`Option<String>`. Ce tableau le décrivait `true` / `false`, parce que le champ `status` du même
volume vaut `"scanning"` : les deux se confondent d'un mot.

Le coût n'est pas théorique. Le 29/09, `arret-running` a comparé `scanning === true` pour
décider « une analyse court-elle ? ». La comparaison ne pouvait jamais être vraie, la branche
« le serveur analyse sans publier de numéro » n'était donc jamais atteinte, et neutraliser la
publication du numéro ne faisait pas rougir la sonde : elle passait en 3/3 avec une note
« volume trop rapide ». Un document qui décrit mal une forme d'API ne se contente pas de
tromper : il écrit à sa place des prédicats impossibles.

`requete` ne bouge pas : **la requête n'est jamais partie.** Le geste de l'utilisateur — changer
le tri — appelle `load(true)`, qui rend la main quand le volume affiché n'est pas prêt. Le
geste est perdu, silencieusement. Et la veille voit bien l'analyse se terminer (`scanning: null`
à `final`) : elle **voit**, et ne recharge rien. Le compteur de requêtes le prouve mieux qu'une
lecture de code : après soixante secondes et un cycle complet de veille, l'écran portait encore
exactement le même instantané.

**L'hypothèse que j'ai vérifiée avant de l'écrire, et qui était fausse.** Ma première idée
était une course entre l'annonce de fin d'analyse et la publication du nouvel instantané : le
serveur dirait « terminé » avant de servir l'arbre nouveau. Falsifiée par la mesure — en
interrogeant `/api/state` et `/api/tree` toutes les 100 ms pendant une reanalyse de `G:`
(180 708 dossiers, 1 097 990 fichiers) :

```
13.511 s  finished_ms -> 1790584764505  (gen servi : 6)
13.511 s  gen -> 6
  ECART : finished_ms a +10392 ms, gen a +10392 ms  ->  0 ms
```

Les deux changent dans le **même échantillon**. La fenêtre est sous les 100 ms, et elle n'est
pas la cause. Écrire la règle sur cette hypothèse aurait produit un correctif pour un défaut
qui n'existait pas — et un écran « corrigé » qui resterait faux.

**La règle :**

> Un écran affiche un instantané du disque. Si le disque a été réanalysé depuis, l'écran ment,
> et il doit se recharger — même si l'analyse vient d'ailleurs, et même si le dernier geste de
> l'utilisateur a été perdu en route.

**Le correctif.** Un repère unique : l'écran note, à chaque peinture, le `finished_ms` du volume
qu'il montre (`ui/index.html:427`). La veille compare (`ui/index.html:1868`) : tant que le
repère vaut celui de l'état, elle ne fait rien ; dès qu'il diffère, elle recharge
(`ui/index.html:1873`). Le rechargement passe par `rechargerTri()` et non `load()` : la
**sélection** se garde — c'est une cible de suppression, et un rechargement de fond n'a pas le
droit de la déplacer — et une recherche en cours reste une recherche.

Un second morceau, sans lequel le premier ne tiendrait pas : `poll()` rendait son drapeau. Il
faisait `clearInterval(pollTimer)` en s'éteignant, sans remettre la variable à zéro — le
drapeau restait donc vrai pour toujours après la première analyse lancée depuis cette fenêtre, et
la veille n'aurait plus jamais rien fait. Le nom du drapeau est le contrat : il vaut « une
analyse lancée d'ici est en cours », donc il est faux quand il n'y en a pas.

**Épreuves, dans les deux sens, sur un run complet.**

| | `identifiant` | `ui` |
|---|---|---|
| avant | `12/13`, `generation 8 -> 8` | `25/27`, *« le clic n'a pas navigué »* |
| après | `13/13` | `37/37` |

Les deux sondes étaient rouges **sur le même code** que le runner, où elles sont vertes : la
différence n'est pas la version, c'est la **durée**. Sur le `D:` du runner une analyse dure
moins d'une seconde et l'interface ne peut pas manquer le moment ; sur `G:` elle dure assez
pour qu'un geste tombe dedans et soit perdu. C'est la première fois qu'un défaut de ce
projet-ci n'apparaît que sur une machine lente.

**Ce que cette règle ne couvre pas.** Elle dépend de `finished_ms`, que le serveur écrit quand
l'analyse **se termine**. Une analyse qui n'a pas encore commencé — un fichier créé entre deux
analyses — ne fait pas bouger le repère : l'écran reste alors légitimement en retard, et c'est
le comportement voulu. Elle ne dit rien non plus d'un second écran, et la règle suppose qu'il n'y en a qu'un. Une seule instance,
et c'est déjà le modèle du binaire.

---

### R15 — Une demande d'analyse pendant une analyse en cours était acceptée, puis perdue · **Haute** · *corrigé le 28/09/2026*

Même famille que R14 et que le 404 du 27/09 : **une réponse qui contredit ce qui s'est passé.**
Ici la réponse disait `{"ok":true}` à une demande que le serveur avait jetée sans la regarder.

**Le code, avant le correctif.** `POST /api/scan/<volume>` répond `ok` sans condition. La fonction
qui porte la demande faisait :

```rust
if *app.scanning.lock().unwrap() == Some(letter) {
    return;
}
```

Un retour muet, dans une fonction dont le seul contrat est d'**accepter**. Le client reçoit `ok`,
croit avoir obtenu une analyse, et n'a rien obtenu.

**Mesuré, le 28/09/2026, sur le poste de l'auteur.** La sonde `generation` crée son dossier,
demande l'analyse, attend la fin, puis va chercher le dossier par `/api/search`. Il n'y est pas :

```
[listing] rien nommé « perime » — total=356 rendu=356 tronque=false exact=true
[listing] dossier attendu : G:/_diskmap_sondes/perime — existe : true
```

Trois faits dans ces deux lignes. Le dossier **existe** sur le disque. La recherche répond
`exact=true, tronque=false` — le serveur affirme avoir tout donné. Et parmi les 356 réponses,
chacune contient `experimental` : le serveur a cherché `perime` et n'a **pas** trouvé le dossier
qu'il vient de créer. Ce n'est pas une recherche tronquée, c'est un **instantané pris avant sa
création** : la demande avait été absorbée par l'analyse déjà en cours, laquelle avait commencé
avant que le dossier existe.

**Pourquoi le runner ne le voyait pas.** Un `D:` de 511 Mio s'analyse en moins d'une seconde :
deux demandes ne se croisent jamais. Sur `G:` — 476 Go, 180 708 dossiers, 1 097 990 fichiers —
une analyse dure assez pour que la fenêtre s'ouvre. Le défaut ne dépend pas de la version mais
de la **durée d'une analyse**, comme R14.

**La règle :**

> Ce qui couvre une demande d'analyse, c'est une analyse **postérieure** à la demande. Une
> analyse en cours ne la couvre pas : son instantané a été pris avant qu'elle existe.

**Le correctif.** Chaque analyse demandée reçoit un ticket monotone par volume : `start_scan`
(`src/main.rs:643`) le rend dans la réponse HTTP, et `/api/state` publie `scan_requested` et
`scan_completed`. Le client peut ainsi attendre le ticket de SA demande sans manquer une analyse
courte ni confondre la fin du scan courant avec celle du scan demandé. Les demandes répétées sont
coalescées dans la file (`demande_couverte`, `src/main.rs:643`, et `en_attente.push(letter)`,
`src/main.rs:643`) : dix demandes pendant le même scan demandent une seule analyse supplémentaire,
pas dix. L'analyse déjà en cours n'est jamais créditée pour une demande qu'elle précède.

La fin est publiée seulement avec l'instantané complet. L'ordre des verrous est conservé
(`scanning` → `queue` → `drives`), et l'arrêt prend la même barrière avant de bloquer de nouvelles
demandes : une demande acceptée n'est donc ni perdue, ni publiée comme terminée trop tôt.
Le compteur refuse proprement le débordement plutôt que de réutiliser un ticket.

**Contre-épreuve, sur la même séquence de sondes :** ancien comportement remis,
`generation` retombe en `SANS SYNTHESE` avec le même `TypeError`. Ce que `recherche` en fait
n'a pas bougé — la contre-épreuve est ce qui empêche de lui attribuer le mérite.

**Ce que le correctif n'a pas suffi à régler, et qui n'est pas un défaut produit.** En run
complet, `generation` levait toujours son `TypeError`. La cause est la même, un cran plus bas :
le serveur ne perd plus la demande, mais **le client n'a toujours pas de raison de savoir quand
la sienne aura eu lieu**. Trois attentes se sont révélées fausses, et elles ne l'étaient pas par
hasard :

- `!scanning` est **vrai** dans l'intervalle entre la fin de l'analyse en vol et le début de celle
  qu'on vient de demander ;
- `finished_ms` change à la fin de la première, pas de la seconde — attendre « un changement »
  n'attend pas « *mon* changement » ;
- seul le **fait** ne ment pas : l'entrée que la sonde vient d'écrire apparaît-elle dans
  l'instantané ?

`generation` attend désormais l'entrée, et l'absence est un **résultat** : elle revient `null` et
la sonde le dit. Elle ne lève plus de `TypeError`. C'est la même famille que R12 vue par l'autre
bout : une sonde qui plante n'écrit pas de résumé, donc elle sort en `SANS SYNTHESE` — la ligne
exactement identique à celle d'une sonde morte.

À l'étape R15, l'attente par le fait avait été factorisée entre une recherche par nom
(`attendreEntree`) et deux helpers de fichier (`attendreFichier`, `attendreFichierDans`). R16 a
supprimé `attendreEntree` et `attendreFichierDans`, et changé la signature d'`attendreFichier`
(de volume + nom à volume + chemin du dossier + nom). L'API actuelle garde `attendreDossier` et
`attendreFichier`, toutes deux adressées par le chemin du dossier ; le nom du fichier n'est
recherché qu'à l'intérieur du dossier ciblé.

**Mesuré, sur le run complet, avant et après.**

| | avant | après |
|---|---|---|
| `generation` | `SANS SYNTHESE` — `TypeError` | `6/6` |
| `recherche` | `20/25` | `25/25` |
| `identifiant` | `12/13` | `13/13` |
| `ui` | `25/27` | `37/37` |
| `sans-corbeille` | `10/10` ou `SANS SYNTHESE`, d'un run à l'autre | `10/10` |
| `csrf` | `0/3` | `12/12` |
| total | 17/21 | **21/21**, deux runs complets de suite |

Les deux dernières lignes sont arrivées après, et pour la même cause. `recherche` attendait un
**changement de génération** — un fait indirect : c'est celui de l'analyse déjà en cours au
moment où la sonde a écrit ses fichiers. Elle attend désormais **son** fichier, par son chemin.
`csrf` cherchait son dossier par `q=csrf`, un nom que tous les `node_modules` du disque
contiennent : la recherche étant plafonnée, le dossier sortait de la première page et `sel`
valait `null` — trois verdicts qui affirmaient que la victime n'était pas dans l'instantané, sur
une sonde dont tout l'objet est de conclure que l'attaque a échoué. Elle l'adresse par son
chemin, qui est unique par construction.

Un nom n'est une adresse que tant qu'il est rare. Un chemin en est une.

**Le ticket, consommé par les clients — 29/09/2026.** Le correctif côté serveur restait une
promesse que personne n'encaissait : l'interface et les sondes continuaient d'attendre le
drapeau global, dont la mesure montre qu'il ment entre deux analyses. Désormais :

- `POST /api/scan` répond `{ok, ticket}`, et chaque client attend **son** ticket :
  `attendreTicket` (`tests/sondes/config.mjs:428`) boucle sur `scan_completed >= ticket` et ne
  consulte jamais `!scanning` pour conclure ;
- l'interface note le ticket rendu (`ui/index.html:681`) et `poll()` s'arrête sur sa publication
  (`ui/index.html:699`) ; la réanalyse après suppression attend le `scan_ticket` rendu par
  l'exécution (`ui/index.html:1566`) ;
- `generation` demande son analyse et attend son ticket (`tests/sondes/sonde-generation.mjs:71`)
  — l'attente par le fait, plus bas, reste sa preuve d'existence ;
- la sonde `tickets` (`tests/sondes/sonde-tickets.mjs:62`) éprouve le contrat du point de vue
  client : ticket rendu, publication, coalescence mesurée (deux demandes rapprochées pendant un
  scan → deux tickets distincts honorés par la même publication), et fichier créé avant la
  demande présent dans l'instantané publié sous ce ticket.

**La garde de génération, éprouvée de la même façon.** Neutraliser `gen_vue != snap.gen` (`src/main.rs`) — le refus 409 qui empêche un sélecteur périmé de viser un autre fichier — fait passer `generation` de 6/6 à **5/6**, code 1. La mesure dit ce que le défaut produirait, pas seulement qu'il existe : l'aperçu a répondu `200` sur `V:\$RECYCLE.BIN\…\$I2NRAIU.txt` alors que la sonde demandait `perime/p2.txt`. C'est l'incident du 26/09 en une ligne — un fichier jamais montré, supprimable. Restaurée : 6/6, code 0. §7/23.

**Une preuve, et pas une intention.** La publication du numéro en vol a été neutralisée pour l'épreuve : `ds.scan_running = ticket` est devenu `0` dans `src/main.rs`, et `arret-running` est passée de 4/4 à **3/4**, code de sortie 1, en mesurant `scanning = C, scan_running = 0` et un écran qui affiche « analyse en cours… » sans numéro. La première version de cette vérification interrogeait l'état APRÈS `/api/quit` — donc après la mort du serveur, où la requête échoue et où la vérification passe quoi qu'il arrive. Elle ne pouvait pas rougir ; elle a été remplacée par la capture en vol, avant l'arrêt. §7/22.

**Ce qui reste une limite : plus rien sur ce point — et la moitié de ce qui était écrit
n'en était pas une.** `attendreDossier` et `attendreFichier` interrogent `/api/tree` sous
`!scanning`, présenté ici comme une porte de second rang. C'est un garde-fou de SERVICE : il évite
de lire un instantané au milieu d'une publication, et la boucle ne rend jamais la main par lui —
elle rend sur le fait (`r.ok` pour un dossier, la ligne pour un fichier) ou sur sa borne.
`attendreAnalyse`, elle, était une véritable attente par substitut : c'est elle que les deux
affirmations confondaient.

Elle est **supprimée** (29/09/2026). Son dernier appelant — `lot`, la sonde qui rejoue l'incident
du 26/09 — attendait `attendreAnalyse(VOL, 0)` juste après son `POST /api/scan` : la fonction
rendait la main au premier tour où `scanning` était faux, donc sur l'instantané du run PRÉCÉDENT,
et le `dry` suivant partait avec une génération périmée. La garde `gen` a repoussé, à raison, et
l'échec s'est manifesto par une exception muette sur une liste vide — un accident de course qui
accusait un défaut de suppression inexistant. `lot` attend désormais le ticket qu'elle a demandé
(`attendreTicket`, `tests/sondes/config.mjs:428`), puis, pour chaque lot, l'instantané qui porte
tous les noms visés. Mesuré le 29/09/2026 : `lot` 9/9 au run complet, filet inchangé.

---

### R16 — Un plafond négatif invalide le verdict sur les coûts positifs · **Moyenne, harness** · *corrigé le 28/09/2026*

**Ce qui a été trouvé.** En nettoyant l'API des attentes du harnais, un run complet a
sorti `lot` en ROUGE sur son verdict « pas de terme quadratique ». Mesuré : marginal
1→25 à **−1,8 ms/fichier**, 25→100 à **54,5**. Le seuil du verdict étant
`pente1 * 1,5 + 2`, il valait environ **−0,7** (calculé sur les mesures arrondies).

Avec ce plafond, le verdict rejetait toute pente marginale non négative, de 0 à 10⁶ : il ne
pouvait donc pas confirmer une pente nulle, et sa rougeur ne démontrait pas à elle seule un
terme quadratique. C'est la famille de R12, vue du côté du seuil au lieu du résumé : dans les
deux cas, un instrument annonçait une couleur sans établir une mesure valable.

**La cause de l'écart n'est pas établie.** Au run `r16b`, les temps corbeille étaient 1835 ms
(N=1), 1792 ms (N=25) et 5883 ms (N=100) : 25 fichiers ont pris moins de temps qu'un seul.
Dans un essai distinct après amorçage, ce lot d'amorçage a pris 62 ms, puis les lots comparés
50, 906 et 2438 ms — pentes positives, 35,7 puis 20,4 ms/fichier. Cela montre que cette
séquence a produit un plafond positif ; cela n'identifie pas la cause du 1835 ms du run
précédent et ne prouve pas que toutes les exécutions seront stables.

**Le correctif change ce qui est mesuré.** Une requête d'amorçage en mode corbeille est
exécutée avant les lots comparés ; son temps est exclu. On compare ainsi deux intervalles
mesurés après cette première requête, sans prétendre avoir identifié la cause de l'écart
antérieur. Un garde-fou vérifie `seuil > 0` **avant** la comparaison : si le plafond calculé
n'est pas positif, le test le signale au lieu de présenter sa rougeur comme une preuve de
complexité quadratique.

**Contre-épreuve exploratoire, par modèle, pas par mesure du produit.** Le modèle
`T(N) = f + c·N + I·[N=1]` a trois paramètres ajustés sur les trois durées corbeille de
`r16b` : les reproduire exactement est donc tautologique, et n'explique pas l'écart. Sur les
deux durées « permanent », le modèle linéaire a un résidu maximal de 4,5 ms.

En extrapolant ce modèle après suppression de `I`, le critère passe pour `q=0` et rougit pour
`q=0,6`. Il laisse toutefois passer `q=0,1` et `q=0,2` pour les paramètres essayés : le
verdict ne prouve pas l'absence de toute courbure. Dans six combinaisons synthétiques de coût fixe et de coût linéaire, tous les cas `q=0`
passent ; deux autres cas `q=0,6` rougissent. Ce balayage borné vérifie le comportement de ces
exemples, pas la robustesse à toutes les machines ni à toutes les courbes.

**La même famille, trouvée dans le même passage.** `sonde-reversibilite.mjs` gardait une
attente locale par `!scanning`, puis cherchait son dossier par nom. Le run `r16` a montré
`sel=null` et `SANS SYNTHESE` pour `sans-corbeille` sur `E:`. La sonde attend maintenant le
fichier dans son dossier par chemin et utilise le même helper que les autres. Le run suivant,
`r16b`, donne `sans-corbeille` 10/10 ; après le correctif du verdict `lot`, le run complet
`r16e` donne 21/21, avec `lot` à 9/9, `sans-corbeille` à 10/10 et `reversibilite` à 8/8.
Ces mesures valident ces exécutions, pas toutes les conditions possibles.

**Ce que ça ne couvre toujours pas.** La cause de l'écart reste inconnue. Le garde-fou
`seuil > 0` rend invalide une calibration non positive, sans expliquer pourquoi elle l'est. R16 ne
porte que sur le verdict du coût : l'attente qui précède chaque lot — le ticket demandé, puis
l'instantané qui porte tous les noms — n'est pas couverte par ce constat.

---

## 6. Ce qui est solide

Le travail de durcissement est de bon niveau ; ces points ne doivent pas être perdus.

- **La cible est figée à l'aperçu.** `Montre` porte le chemin résolu ; `execute` ne résout
  plus rien. C'est la bonne architecture : la seule façon de supprimer reste de décider ce
  qu'on supprime.
- **Une seule réponse peint** (`ui/index.html:733`). Une requête périmée rend la main sans
  toucher l'état, et son erreur non plus n'est pas dite — R11. Le même refus que pour la cible :
  l'écran ne montre jamais autre chose que ce que l'interface déclare.
- **Une génération par instantané** (`src/scan.rs:386,455`), servie par `/api/tree` et
  `/api/search`, exigée par `dry`. Un identifiant périmé est refusé, pas réinterprété.
- **Jeton** : `BCryptGenRandom` (`src/win32.rs:216`), usage unique, dix minutes, lié au
  volume, avec repli qui ne dérive jamais d'une constante.
- **CSRF** : `X-Diskmap` sur tous les POST, `Host` local sur toutes les routes, lectures
  comprises. Le raisonnement sur le rebinding (l'en-tête `X-Diskmap` est posable librement
  en same-origin, seul le nom de `Host` trahit l'attaque) est exact.
- **Points d'analyse** refusés au scan (`src/scan.rs:1004`) *et* à l'exécution
  (`src/win32.rs:292`), avec `symlink_metadata` pour inspecter l'entrée et non sa cible.
- **Une sonde muette est rouge** (`tests/sondes/lancer.mjs:863`), pas verte par défaut : le
  harnais exige un décompte écrit. Et un décompte de **`0/0`** est rouge aussi
  (`tests/sondes/lancer.mjs:862`, motif `tests/sondes/lancer.mjs:963`) : « je n'avais rien à
  tester » n'est pas une mesure, c'est une sonde dont le jeu de cas est vide. C'est le seul
  garde-fou qui couvre la sonde elle-même — R12. Les vingt sondes en tiennent un, et aucune
  n'annonce `0` : mesuré sur trois runs complets avant d'écrire la règle.
- **À taille égale, l'écran range par nom croissant** — et c'est **mesuré à l'écran**, pas
  déduit du code. Le départage du serveur (`src/scan.rs`, `.then_with(|| a.name.cmp(&b.name))`)
  tient dans les deux sens, et un test Rust le vérifie côté serveur ; mais l'écran montrait
  l'égalité sans jamais la trancher, faute de support. Le support existe
  (`tests/sondes/sonde-ui-suppression.mjs:101`) : deux fichiers de **même taille**, créés dans
  l'ordre **inverse** de l'ordre alphabétique, donc un serveur sans départage les afficherait
  `zztaille-z` avant `zztaille-a`. Le verdict
  (`tests/sondes/sonde-ui-suppression.mjs:718`) exige alors qu'à taille égale les noms soient
  croissants — invariant **indépendant du serveur** : comparer l'écran à l'interface ne
  prouverait que leur accord, y compris s'ils ont tort ensemble.
- **Une demande d'analyse n'est acceptée que si elle sera honorée.** `POST /api/scan`
  répondait `ok` à une demande que `start_scan` jetait sans un mot quand le volume était déjà en
  cours — or un instantané pris **avant** la demande ne peut pas contenir ce qu'elle voulait
  voir. Mesuré : un dossier créé, la demande répondue `ok`, et `/api/search` qui le déclare
  introuvable tout en répondant `exact=true, tronque=false` sur 356 résultats. Ce qui couvre une
  demande, c'est une analyse **postérieure** à elle — donc la file, et jamais l'analyse en cours
  (`src/main.rs:643`) — R15.
- **L'écran se recharge quand le disque a bougé depuis qu'il a été peint.** La veille de fond
  suivait l'état d'un volume analysé ailleurs, jamais l'arbre : le rechargement n'existait que
  dans `poll()`, qui ne démarre que sur un geste local et s'éteint après un tour. Une analyse
  étrangère laissait donc l'écran afficher un instantané que le serveur ne servait plus, sans un
  mot — et un geste de l'utilisateur survenu **pendant** l'analyse était perdu sans bruit,
  mesuré par un compteur de requêtes qui ne bougeait pas. Le repère est le `finished_ms` noté à
  chaque peinture (`ui/index.html:427`), comparé par la veille (`ui/index.html:1868`) — R14.
- **Le navigateur ne s'ouvre que pour un lancement interactif**
  (`src/main.rs:212`). Au double-clic il y a une console, donc il s'ouvre ; depuis un
  script, non — et le serveur **dit** pourquoi. `--browser` et `--no-browser` priment
  tous deux sur ce signal, l'interdit en cas de conflit. Ouvrir une fenêtre sur le bureau
  de celui qui a lancé le programme est une intrusion, même sans intention — R13.
- **`\\?\` interdit à l'effacement** (`src/win32.rs:242`) : ce préfixe court-circuite la
  corbeille. Le commentaire explique pourquoi le scan s'en sert et la suppression non.
- **La réversibilité se constate**, elle ne se déduit pas du code de retour : les fiches `$I`
  sont lues une fois après la boucle, filtrées par date, et l'issue est journalisée comme
  ce qui a eu lieu, pas comme ce qui était demandé.
- **Lectures bornées** : corps 4 Mio sans allocation préalable, ligne d'en-tête 8 Ko,
  en-têtes 32 Ko, 64 connexions, timeouts. Un `Content-Length: 999999999999` ne tue plus le
  processus.
- **Le harnais de sondes** ne nettoie que des noms connus sous une racine dédiée
  (`tests/sondes/lancer.mjs:613`) : `rm -rf` y serait un bug, et le code le dit.
- **Une cible s'adresse par son chemin** (`dossier_de`, `src/main.rs:1151`). Un
  identifiant reste une position et ne sert plus qu'à l'intérieur d'un instantané ; la
  navigation, la sélection et l'ouverture dans l'explorateur passent par le chemin, et le
  serveur ne renvoie jamais le chemin qu'il a reçu mais celui qu'il a reconstruit. C'est la
  même propriété que « la cible est figée à l'aperçu », appliquée à la navigation — et la
  seconde était la première sans la garantie de la génération (voir R10).

État de la chaîne de qualité au 26/09, après R1–R8 : `cargo test` 10/10, `cargo clippy
--all-targets -- -D warnings` propre, `cargo fmt --check` propre. Dépendances : `rayon`,
`serde`, `serde_json` et leur transitive — `zmij` est le formateur de flottants de
`serde_json` 1.0.151, pas une dépendance inattendue.

---

## 7. Plan de remédiation

| # | Action | Fichiers | État |
|---|---|---|---|
| **0** | Supprimer `diskmap-CI.exe` (périmé, gitignoré) et ne lancer que `diskmap.bat` | — | **fait** |
| **1** | Échapper le nom et le format de volume | `ui/index.html` | **fait** |
| **2** | Liste d'aperçu complète + plafond serveur à 5 000 éléments | `ui/index.html`, `src/main.rs` | **fait** |
| **3** | Job CI éphémère exécutant les sondes destructives | `.github/workflows/build.yml` | **fait** |
| **4** | Valider la lettre de volume dans le cache, avec test de non-régression | `src/scan.rs` | **fait** |
| **5** | Journaliser le prévu et le réalisé, avec le lot | `src/main.rs` | **fait** |
| **6** | Purger `pending` dans `dry` | `src/main.rs` | **fait** |
| **7** | Dérive le type de l'index plutôt que du client | `src/scan.rs`, `src/main.rs` | **fait** |
| **8** | Bandeau d'avertissement en mode élevé | `ui/index.html` | **fait** |
| **9** | Filet global dans le harnais + sonde d'épreuve | `tests/sondes/filet.mjs`, `sonde-filet.mjs` | **fait** |
| **10** | `racine()` refuse une racine posée sur un autre volume | `tests/sondes/config.mjs` | **fait** |
| **11** | Aligner les noms de dossiers des cinq sondes sur `dossier()` | `tests/sondes/*.mjs` | **fait** |
| **12** | Vérifier R9 sur un nom à espace finale (au lieu de le supposer) | `src/win32.rs`, `src/scan.rs` | **vérifié, sans défaut** |
| **13** | Publication : anonymisation, CI verte sur GitHub | `SECURITY.md`, `.github/workflows/build.yml`, `tests/sondes/*.mjs` | **fait** — **21/21** vertes sur `windows-latest` (`run 36514287640`), les trois jobs verts, release `v0.1.59` publiée |
| **14** | Le filet ne se rabat plus sur une racine inventee : une sonde destructive sans racine fait echouer le run | `tests/sondes/lancer.mjs` | **fait** — refus avant tout demarrage |
| **15** | La regle de refus PAR VOLUME du filet etait du code mort : `lettre('A:\\')` renvoyait `''`, la branche ne pouvait pas s executer | `tests/sondes/filet.mjs` | **fait** — 403 mesuré, et Covered par la sonde d'epreuve |
| **16** | Le harnais refuse un volume de travail qui n'est pas jetable, mesure avant de demarrer quoi que ce soit | `tests/sondes/config.mjs`, `lancer.mjs` | **fait** — 18/18, test qui echoue si on retire l'appel |
| **17** | Le binaire emporte sa provenance : commit, etat de l'arbre a la compilation, agent qui compile — parce qu'un binaire du 26/09 etait inexpliquable | `build.rs`, `src/main.rs` | **fait** — `diskmap --version`, arbre sale signale ; absent de git, dit « commit-inconnu » plutot qu'invente |
| **18** | Un lot qui touche un dossier dont la perte n'est pas anodine — `.git`, `.ssh`, `AppData` comme `Images` ou `Documents` — doit le nommer, dossier par dossier, avant d'agir ; et le harnais annonce les residus qu'il trouve sur le volume de travail | `src/main.rs` (`dossiers_a_nommer`), `ui/index.html`, `tests/sondes/sonde-dossiers-a-nommer.mjs`, `sonde-ui-suppression.mjs` | **fait** — 27/27 en sonde, 21/21 dans un vrai navigateur, 14/19 (rouge) quand on neutralise la garde |
| **19** | Une sonde qui sort en 0 sans avoir ecrit son decompte est un echec, pas un vert : elle ne se distingue d'une sonde morte que par une etiquette | `tests/sondes/sonde-generation.mjs`, `tests/sondes/lancer.mjs` | **fait** — 5/5 et lisible au journal ; resume retire, ROUGE et run en 1 |
| **20** | Le navigateur ne s'ouvre que pour un lancement interactif : un script qui lance le serveur n'a pas a ouvrir une fenetre sur le bureau de celui qui l'a lance | `src/main.rs` (`decider_le_navigateur`), `tests/sondes/lancer.mjs` | **fait** — 0 fenetre mesuree, 1 fenetre avec l'ancien comportement ; `--browser` force toujours |
| **21** | Les modes `idle` et `running` de la sonde `arret` n'étaient jamais exercés : `running` appelle `POST /api/quit`, qui aurait tué le serveur unique du harnais | `tests/sondes/sonde-arret.mjs`, `tests/sondes/lancer.mjs` | **fait** — `serveurDedie` donne à ces deux sondes leur propre serveur sur un autre port ; le binaire ne verrouille que par port. `arret-idle` 3/3, `arret-running` 4/4, dont `scan_running` observé **en vol** et l'invariant « aucun scan_running collé après l'arrêt » |
| **22** | Prouver que la publication du numéro d'analyse en vol mord, et non qu'elle passe par habitude | `tests/sondes/sonde-arret.mjs` | **fait** — neutraliser `ds.scan_running = ticket` (`src/main.rs`) fait passer `arret-running` de **4/4 à 3/4**, code 1 ; restaurée, 4/4 code 0 |
| **23** | Prouver que la garde de génération d'instantané mord | `tests/sondes/sonde-generation.mjs`, `src/main.rs` | **fait** — neutraliser `gen_vue != snap.gen` fait passer `generation` de **6/6 à 5/6**, code 1, et la mesure nomme le fichier visé : l'aperçu répond 200 sur `V:\$RECYCLE.BIN\…\$I2NRAIU.txt` au lieu de `perime/p2.txt` — un sélecteur périmé qui désigne un fichier de corbeille. Restaurée : 6/6, code 0 |
| **24** | Rendre les épreuves de morsure REPRODUCTIBLES, et non des gestes de session | `tests/sondes/epreuve.mjs` | **fait** — `node tests/sondes/epreuve.mjs` neutralise chaque garde, exige le ROUGE **et la mesure attendue**, restaure, exige le VERT, et vérifie que le dépôt est revenu propre. Il refuse de partir sur un arbre sale : la restauration réécrit un fichier du dépôt. Les deux épreuves sont au catalogue ; une garde qui ne mord pas est un échec du script |
| **25** | Rendre l'écart mesurable : combien de constats ont une preuve rejouable | `tests/sondes/verifier-preuves.mjs` | **fait** — croise les preuves déclarées au catalogue d'épreuves avec les constats et causes racines du document. Mesuré le 29/09/2026 : **2/23**, les 21 autres nommés. Il échoue sur une preuve qui désigne un constat inexistant, pas sur une couverture incomplète — sinon il serait rouge en permanence, et un contrôle rouge en permanence n'est plus un contrôle |
| **26** | Une garde qui bloque tout peut n'être éprouvée par PERSONNE | `tests/sondes/sonde-host.mjs`, `tests/sondes/epreuve.mjs` | **fait** — la garde `X-Diskmap` n'était vérifiée par aucune requête directe : les POST de `host` portaient `Host: evil.test`, et leur 403 venait de l'autre garde — même code, même forme de corps. Le navigateur ne pouvait pas combler le trou, puisqu'il bloque la requête avant le serveur. Cas ajouté, épreuve au catalogue : neutralisée 32/33 (la requête atteint la route, `HTTP 404`), restaurée 33/33. **3/23** constats prouvés |
| **27** | Repérer les gardes que PERSONNE ne regarde, plutôt que celles qui n'ont pas d'épreuve | `tests/sondes/verifier-libelles.mjs` | **fait** — croise le libellé de refus de chaque garde avec les sondes. Mesuré le 29/09/2026 : **37 gardes**, 5 dont le texte entier est cité, 28 regardées par un extrait, **4 que personne ne regarde** — toutes des validations d'entrée (`lettre manquante`, `id invalide`, `chemin invalide`, `route inconnue`), dont aucune ne peut coûter un fichier. Le résultat est rassurant, et il se relira à chaque build |

**Ce que les runs sur GitHub ont révélé — et qui ne concerne pas
l'application.** Cinq échecs successifs, tous dans le harnais, tous masqués
par des messages trompeurs. Aucun ne venait de l'application ; tous étaient
des tests qui incapacité une machine différente à mesurer quoi que ce soit :

1. `cargo build --offline` échouait sur un runner vierge (`no matching package
   named rayon`). C'était ma commande, et le message d'aide du harnais la
   conseillait.
2. Le délai de 180 s par volume était dépassé sur `C:`, qui contient toute
   l'image de l'agent — et le harnais rapportait « ECHEC », ce qui accuse
   l'application d'un défaut qu'elle n'a pas. Un dépassement est désormais
   rapporté comme tel.
3. Trois sondes attendaient `!scanning` avant d'interroger l'instantané. Sur
   un runner lent, l'analyse se termine avant que les fichiers créés soient
   vus : les sondes repartaient sur un index incomplet et concluaient « absent »
   ou « les protections ne fonctionnent plus ». **Un verdict faux, sur un
   défaut inexistant** — la pire des fautes pour un test de sécurité. Elles
   attendent désormais que le FAIT soit constaté (`attendreFichier`), pas qu'un
   drapeau soit baissé.
4. Trois tests étaient réglés sur la machine de l'auteur : 10 ms par fichier,
   1500 ms de rendu, 20 s de navigation. Le runner en fait 7,1 ms, ne rend pas
   dans ces délais, et expire sur l'IP privée. Le premier annonçait que le coût
   venait de l'API — ce qui reste vrai ; le deuxième concluait « l'interface ne
   liste rien » ; le troisième, « la protection CSRF a cédé ». Aucun n'avait
   mesuré quoi que ce soit.
5. La sonde `ui` nommait son dossier d'essai `ui` — comme le dossier de
   l'interface du dépôt. Sur le runner, le dépôt est sur le volume analysé : la
   recherche remontait le mauvais dossier, et la sonde naviguait dans le code
   au lieu de ses propres fichiers.

**Le point commun est plus important que la liste.** Aucun de ces tests ne
mesurait un défaut de l'application ; tous produisaient un **verdict faux**,
et rien dans leur sortie ne permettait de le distinguer d'un échec réel. Pour
un test de sécurité, c'est la faute la plus coûteuse qui soit : un test qui
accuse à tort apprend à ignorer les ROUGE, et le jour où une protection cède
vraiment, personne ne le regarde.

Trois règles en découlent, toutes appliquées :

- **Une attente constate ce qu'elle attend**, jamais un substitut. Un drapeau
  qui baisse n'est pas un fait ; compter des fichiers du volume mesure
  l'activité des AUTRES sondes, pas la sienne.
- **Un cas non mesuré ne vaut ni succès ni échec.** Une page inatteignable se
  dit telle quelle : la compter comme un échec de sécurité affirmait une
  attaque réussie qui n'a pas eu lieu.
- **Un nom de sonde est unique parmi ce que la sonde analyse.** Le volume de
  travail n'est pas vierge, et sur un runner il ne le sera jamais.

État au 26/09/2026, après publication :

```
run 36271618869 : windows SUCCESS · sondes SUCCESS
11/11 sondes vertes sur windows-latest, aucun cas non mesuré
231 suppressions, toutes sur D: — le runner est éphémère et jeté après le job
```

Aucune des neuf conclusions du rapport n'est restée ouverte après vérification. R9 était le
dernier doute, et il est fermé : un nom non adressable en forme normale est visible dans
l'index, refusé à l'aperçu, et ne peut viser aucun autre fichier.

Vérification, sur un volume virtuel jetable `V:` monté pour l'occasion, après R5/R6/R7 :

```
11/11 sondes vertes, code de sortie 0
231 suppressions, toutes sur V: — 9 lots, 129 corbeille, 102 définitif
0 écart entre le chemin prévu et le chemin réalisé, sur les 231 lignes
deux exécutions consécutives : mêmes issues, mêmes tailles, mêmes chemins
cargo test 10/10 · clippy --all-targets -D warnings propre · fmt --check propre
```

Le contrôle du journal est fait **autour** de chaque exécution, pas seulement dedans : le
diff avant/après est la seule preuve qu'aucun autre volume n'a été touché. C'est aussi ce
qui permet de lire `prevu=` et de le comparer à la colonne 5 ligne à ligne — 231 fois, sans
exception.

La section 1 de `sonde-suppression-lot.mjs` rejoue exactement l'incident : la sonde
supprime un fichier, en retire un autre, force une réanalyse, et vérifie que
l'application supprime le fichier **annoncé** et aucun autre.

`sonde-filet.mjs` prouve la seconde moitié : un aperçu hors racine suivi de son
exécution est refusé (403), et le fichier témoin est toujours là. Elle s'exécute avant
toute sonde destructive — après, un filet défaillant aurait déjà fait son œuvre.

**Une limite du filet, dite franchement.** Le filet est un serveur Node, et Node refuse
lui-même, à son parseur, une requête HTTP/1.1 sans en-tête `Host`. Cette requête
n'atteint donc jamais l'application, et `sonde-host.mjs` le note au lieu de le masquer.
Le filet n'est pas transparent : il couvre le DELETE, et il se contente de relayer le
reste. C'est le prix d'un point unique, et il est préférable à une vérification
répliquée — donc oubliée — dans chacune des sondes.

### 7/28 Un rapport de trous ne garde que le rapport · **corrigé le 29/09/2026**

`verifier-libelles.mjs` extrait les gardes de `src/main.rs` et affiche celles dont
aucune sonde ne cite le libellé. Le 29/09/2026, il en a affichées quatre, et il
est sorti **en vert** — décision volontaire, écrite dans le fichier : « un contrôle
rouge en permanence cesse d'être consulté ».

L'argument est juste et la décision a produit exactement ce qu'elle annonçait :
le rapport n'a jamais été consulté. Les quatre gardes sont restées nues.

Il y a plus grave que la garde. Ces quatre entrées — « lettre manquante »
(`src/main.rs:972`), « id invalide » (`src/main.rs:1012`), « chemin invalide »
(`src/main.rs:1033`), « route inconnue » (`src/main.rs:1074`) — sont les
validations du routeur, et **aucune requête ne les atteint jamais**. Un serveur
qui refuse tout les produirait, aussi bien que le bon. C'est la définition
d'une preuve absente, et elle était écrite en clair dans un fichier vert.

Trois changements, dont deux mesurés :

**1. Le contrôle exige au lieu de signaler.** `PLANCHER_SANS_REGARD` vaut 0, et
une garde sans regard fait désormais rouge la chaîne. *Mesuré le 29/09 : une
garde renommée en un libellé que personne ne cite fait passer le contrôle de
6/6 à 5/6, et nomme `src/main.rs:1074`.* Le plancher est une arme, pas une
déclaration.

**2. Le contrôle a lui-même une embuscade.** Un contrôle qui n'a jamais rougi ne
sait pas rougir, et « 0/0 muettes » est indiscernable d'une règle cassée qui
n'en verrait aucune. Le script fabrique donc une garde muette et exige qu'elle
soit vue, et une garde réellement citée qu'il ne range pas parmi les muettes
(`tests/sondes/verifier-libelles.mjs:217`). Un contrôle qui ne sait dire ni
« vu » ni « pas vu » ne sait rien.

*L'embuscade a rougi le premier jour, pour une raison qui n'était pas un défaut
de la règle : le leurre contenait « jamais » et « sonde », présents dans toutes
les sondes, et la règle lax — deux mots de plus de quatre caractères — le
comptait donc comme regardé. Le contrôle a rouge sur son propre leurre, et le
diagnostic était juste : un test de contrôle qui n'est pas exact ne mesure
rien.*

**3. `sonde-entrees.mjs` couvre les quatre gardes.** Huit requêtes, un témoin
par garde. Un témoin, parce qu'un statut seul ne prouve pas : « id invalide »
et « dossier hors bornes » répondent tous deux 400, et seule la citation du
libellé les distingue. Le témoin de « route inconnue » est le plus parlant —
même 404, autre message, donc une sonde qui ne lirait que le statut
compterait la route comme correctement refusée.

*Mesuré le 29/09/2026 contre un serveur réel : 10/10 vertes. Contre-épreuve : la
neutralisation de la garde « chemin invalide » — le `None` de `rsplit_once`
devient impossible — fait passer la sonde à **9/10, rouge sur le bon cas**, avec
la mesure attendue : `HTTP 404 · ce dossier n'existe plus`. La sonde mord, et
l'application revient.*

Le même jour, le conseil qui suivait ces travaux était d'abandonner la course
aux preuves une par une — une demi-heure chacune, pour vingt constats — au profit
de la recherche des gardes non regardées. C'est ce que la mesure a confirmé :
ces quatre-là coûtaient une seconde chacune, et étaient invisibles précisément
parce qu'elles ne faisaient pas de bruit.

Avant l'ajout : `verifier-libelles.mjs` annonçait 37 gardes, dont **4 que
personne ne regardait**. Après : 0. Le contrôle passe de 2 vérifications à 6 —
les quatre nouvelles sont le leurre, la détection, la reconnaissance, et le
plancher. `verifier-references.mjs` est monté de 196 à **208/208** : les
insertions dans `lancer.mjs` avaient décalé dix-neuf références de la
documentation, et le contrôle les a signalées toutes, une par une, avant que
quiconque ne les remarque.

### 7/29 Un rouge qui ne dit pas sa cause ne se laisse pas corriger · **corrigé le 30/09/2026**

Le run complet du 29/09/2026 a rendu `elevation` **ROUGE 5/8**, après sept runs
consécutifs où la même sonde rendait 16/16. Le compte est un fait ; le message,
non : la sonde affichait `Failed to fetch | Failed to fetch` et trois lignes de
listing. Ni la requête, ni la raison, ni le moment.

La cause du ROUGE, je ne la connais toujours pas : isolée, sur un `V:` propre,
la sonde repasse 16/16. Ce que j'ai cherché n'était pas la cause — c'est
**pourquoi elle était invisible**.

Les quatre sondes qui pilotent un navigateur (`sonde-elevation.mjs`,
`sonde-erreurs.mjs`, `sonde-identifiant.mjs`, `sonde-ui-suppression.mjs`)
n'écoutaient que `pageerror`, c'est-à-dire le **code** de la page. Or une
requête qui n'aboutit pas ne lève aucune exception de ce côté : elle finit en
`TypeError: Failed to fetch`, attrapé quelque part plus haut, puis en silence.
Une page dont la requête est morte affiche une liste vide ou figée, passe le
verdict « aucune erreur JavaScript », et le composant cassé se déclare sain. Une
garde que personne ne regarde, de la même famille que celles de 7/28 : elle ne
rougissait jamais, et sa matière première — la panne réseau — était déjà
arrivée, une fois, devant elle.

Trois changements, tous mesurés :

**1. `suivreRequetes(page, navigateur)`** (`tests/sondes/navigateur.mjs:66`)
écoute `requestfailed` et conserve `méthode URL — raison` : `net::
ERR_CONNECTION_REFUSED`, `net::ERR_UNSAFE_PORT`, une coupe au milieu de la
réponse. Le lieu est commun aux quatre sondes, parce que le faire quatre fois
serait quatre endroits où l'oubli est possible.

**2. Un verdict de plus par sonde** — « aucune requête de l'interface n'a échoué »
— qui lit ce tableau. Il est distinct du verdict JavaScript, et il ne s'y
substitue pas : une page muette et une page injoignable ne se ressemblent pas,
et les deux verdicts du dessus ne peuvent voir que la première.

**3. Un contrôle de même ligne dans chaque sonde.** Un test qui n'a jamais rougi
ne sait pas rougir, et « 0 échec réseau » est, sans plus, indiscernable d'un
écouteur qui n'écoute rien. Chaque sonde provoque donc un échec qu'elle connaît —
une requête vers `127.0.0.1:1`, port que Chromium refuse lui-même avant toute
connexion (`net::ERR_UNSAFE_PORT`, mesuré : ni DNS, ni serveur, ni réseau, donc
le même verdict sur la machine de développement et sur le runner hors ligne) —
et exige que le collecteur le voie.

*Contre-épreuve du collecteur, 30/09 : le contrôle voit l'échec voulu, une
requête morte non marquée est bien rapportée dans le tableau que la garde lit, et
la console de la page mesurée reste vide. La garde n'est donc pas un rapport de
trous : elle lit exactement ce que la contre-épreuve remplit.*

**Le témoin a d'abord saliva sur la mesure.** Dans sa première version il
s'exécutait sur la page mesurée. Un échec de ressource écrit aussi une ligne de
console — `Failed to load resource: net::ERR_UNSAFE_PORT` — et deux des quatre
sondes lisent cette console : `identifiant` et `ui` ont rougi sur le seul témoin
(14/15 et 38/39), avec une mesure qui ne parle pas de la faute. Le témoin vit
désormais sur une page jetable, avec son propre contexte. *Mesuré après
correction : `identifiant` 15/15, `ui` 39/39, `elevation` 18/18, `erreurs` 46/46
— deux vérifications de plus chacune, toutes vertes.*

Un détail du même episode, mesuré : sur une page née de `browser.newPage()`,
Playwright refuse d'en ouvrir une voisine (`Please use browser.newContext()`).
Le navigateur est donc demandé en second argument, plutôt que déduit de la page.

`verifier-references.mjs` est monté de 208 à **210/210**. Les quatre références
à `sonde-ui-suppression.mjs` avaient glissé de sept lignes — les sept lignes du
témoin et de son contrôle — et la nouvelle référence au collecteur a d'abord été
refusée, faute d'entrée dans le tableau : un pointeur que rien ne garde n'est
qu'un pointeur.

Ce que ce travail ne fait **pas** : expliquer le ROUGE du 29/09. Il rend le
prochain capable de le dire. C'est la même exigence que 7/28, appliquée à
l'autre moitié du test — non plus la garde qu'on laisse nue, mais le témoin qui
ne peut pas rendre son verdict muet.

*Run complet du 30/09/2026, après les deux ajouts : **24/24 sondes vertes**,
filet à 0 incident hors épreuve volontaire, aucun avertissement de volume sale.
`entrees` 10/10, `identifiant` 15/15, `ui` 39/39, `elevation` 18/18, `erreurs`
46/46 — les huit vérifications nouvelles, quatre contrôles et quatre verdicts
réseau, y compris dans le run qui les anime toutes.*

La CI qui a validé l'état précédent, `run 36531666709`, est verte sur ses trois
jobs (`windows`, `sondes`, `release`).

---



---
