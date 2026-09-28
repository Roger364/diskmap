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
| Binaire sur le disque | **Périmé** — `diskmap-CI.exe` (02:51) ne contient aucun des correctifs |
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
(`src/main.rs:1520`) ; `execute` ne résout plus rien et ne supprime que les chemins
figés par l'aperçu (`struct Montre`, `src/main.rs:101`).

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
| Page web tierce | Rien. `X-Diskmap` sur tous les POST (`src/main.rs:861`), `Host` local sur **toutes** les routes, lectures comprises (`src/main.rs:783`) |
| DNS rebinding | Rien, pour la même raison |
| Processus local, même utilisateur | Tout : il peut supprimer directement. Le serveur n'est pas une frontière |
| **Volume au nom hostile** | **Effacer n'importe quel fichier, sans l'interface** — voir R1 |
| Utilisateur, usage normal | Effacer un fichier qu'il n'a pas coché, au-delà de 25 éléments — voir R2 |
| Utilisateur, app élevée | Tout hors les 7 noms réservés (`src/main.rs:1385`) — voir R5 |

---

## 5. Constats

### R1 — XSS stockée via le nom de volume → effacement arbitraire · **Haute** · *corrigé*

`ui/index.html:513-514` :

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

`ui/index.html:1067` : `for (const it of d.items.slice(0, 25))`, suivi de
`… et ${d.items.length - 25} autre(s)`. Rien n'empêche l'exécution de traiter les N.

« Tout sélectionner » dans un dossier de 200 entrées affiche donc 175 chemins que
l'utilisateur n'a jamais vus, puis un clic les supprime. Le garde-fou au 20 Go
(`ui/index.html:1056`) est lui aussi purement client, et ne couvre pas le *nombre*.

Le README affirme : « *it is impossible to delete something that was not shown first, or on
the strength of a stale list* ». **La seconde moitié est vraie ; la première est fausse au-delà
de 25 éléments.** C'est aujourd'hui le principal residual : c'est lui qui protège les
documents personnels, puisque `blocked_reason` (`src/main.rs:1385`) ne refuse que
`C:\Users\<profil>` et non son contenu (`C:\Users\Ro\Documents` est effaçable).

**Correctif proposé :** afficher la liste complète dans une zone défilante, et faire refuser
par le serveur toute suppression dont le nombre d'éléments dépasse un seuil — le refus doit
venir du serveur, seul endroit qui ne peut pas être contourné par l'interface.

### R3 — Les tests de sécurité de l'incident ne tournent pas en CI · **Moyenne** · *partiellement traité*

`.github/workflows/build.yml` lance
`node tests/sondes/lancer.mjs --volume D --sans generation,reelle,lot,ui,csrf,erreurs`.
Les six sondes exclues sont exactement celles qui couvrent l'incident. Un CI vert ne dit
rien de la sécurité de la suppression. Le choix est légitime et documenté (protéger un runner
auto-hébergé), mais il faut savoir que la régression n'est plus gardée automatiquement.

**Correctif proposé :** un second job sur `windows-latest` (runner éphémère, jetable par
définition) qui exécute l'ensemble des sondes avec `DISKMAP_SONDE_VOLUME=D` et
`DISKMAP_SONDE_RACINE` pointant sur un dossier dédié. Le job actuel reste inchangé pour les
runners auto-hébergés.

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

`journal` (`src/main.rs:2592`) écrivait l'issue, la taille et le chemin **réellement traité**.
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

`src/main.rs:1656` insère à chaque `dry` ; le `p.retain` (`src/main.rs:1661`) n'était
appelé que dans `execute` (`src/main.rs:1764`). Des aperçus répétés sans confirmation
faisaient croître la map sans borne — jusqu'à 4 Mio d'identifiants, soit une centaine de
milliers de chemins. La purge est désormais dans les deux, et le code le dit au même
endroit (`src/main.rs:1657`).

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
le serveur pose `rescan = done > 0` (`src/main.rs:1982`) et l'interface part en `poll()` ;
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
`sonde-identifiant.mjs`, 12/12 sur le runner comme en local.

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

**Le correctif.** Un jeton par requête (`ui/index.html:694`), incrémenté au départ de `load()` et
de `search()`, comparé à l'arrivée (`ui/index.html:753` et `ui/index.html:942`). La réponse
périmée rend la main sans rien écrire. Son **erreur** non plus n'est pas dite : la parler ferait
remonter d'un cran un dossier qui n'a pas disparu, puisque le chemin à remonter serait celui de la
requête périmée (`ui/index.html:730`).

**Épreuves, les deux sens.** Jeton retiré, 2 s de latence injectée sur `/api/tree` : deux verdicts
rougissent, et le nouveau — « l'ordre demandé n'a jamais été contredit à l'écran » — nomme la
contradiction au lieu de la constater. Jeton remis, même latence : 36/36, et l'historique des
peintures ne contient plus que les deux situations attendues.

**Un second détail que la mesure a refusé, et qui vaut d'être écrit.** La sonde lisait l'écran à
la **première** peinture. Le défaut se jouait deux secondes plus tard : son vert ne prouvait rien
sur la dernière réponse, et son rouge ne tombait que par hasard de charge — une fois sur un run
complet, jamais sur un volume rapide. Elle enregistre donc chaque peinture
(`tests/sondes/sonde-ui-suppression.mjs:520`) et attend que l'écran se taise
(`tests/sondes/sonde-ui-suppression.mjs:543`) avant de lire quoi que ce soit. Le verdict qui en
découle (`tests/sondes/sonde-ui-suppression.mjs:725`) est le seul qui voie les peintures
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
(`tests/sondes/sonde-generation.mjs:131`) ; c'est la forme des dix-neuf autres, qui n'avait jamais
été appliquée ici. Le harnais, lui, refuse le silence : sans `compte`, le code est forcé à `1`
(`tests/sondes/lancer.mjs:753`) et le motif est écrit (`tests/sondes/lancer.mjs:827`). Sans ce
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
(`tests/sondes/lancer.mjs:776`) ; l'écart est nommé avec les deux mesures
(`tests/sondes/lancer.mjs:830`). Un seul terme n'aurait pas suffi : un résumé écrit d'avance
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

**Ce que cette règle ne couvre toujours pas.** Elle compte des lignes de verdict à un
préfixe donné (`ok`, `ROUGE`). Une sonde qui écrirait son verdict ailleurs — en fin de ligne,
dans un tableau — ne serait pas comptée, et le décompte la déclarerait fausse à juste. C'est
un refus dans le bon sens : un verdict que le harnais ne sait pas lire est un verdict qu'il ne
peut pas vérifier. Mais il faut le savoir, et le dire. Le contrôle à double sens de
`verifier-references.mjs` a la même limite, et reste le suivant à traiter.

---

## 6. Ce qui est solide

Le travail de durcissement est de bon niveau ; ces points ne doivent pas être perdus.

- **La cible est figée à l'aperçu.** `Montre` porte le chemin résolu ; `execute` ne résout
  plus rien. C'est la bonne architecture : la seule façon de supprimer reste de décider ce
  qu'on supprime.
- **Une seule réponse peint** (`ui/index.html:694`). Une requête périmée rend la main sans
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
- **Une sonde muette est rouge** (`tests/sondes/lancer.mjs:753`), pas verte par défaut : le
  harnais exige un décompte écrit. C'est le seul garde-fou qui couvre la sonde elle-même —
  R12. Les vingt sondes en tiennent un.
- **`\\?\` interdit à l'effacement** (`src/win32.rs:242`) : ce préfixe court-circuite la
  corbeille. Le commentaire explique pourquoi le scan s'en sert et la suppression non.
- **La réversibilité se constate**, elle ne se déduit pas du code de retour : les fiches `$I`
  sont lues une fois après la boucle, filtrées par date, et l'issue est journalisée comme
  ce qui a eu lieu, pas comme ce qui était demandé.
- **Lectures bornées** : corps 4 Mio sans allocation préalable, ligne d'en-tête 8 Ko,
  en-têtes 32 Ko, 64 connexions, timeouts. Un `Content-Length: 999999999999` ne tue plus le
  processus.
- **Le harnais de sondes** ne nettoie que des noms connus sous une racine dédiée
  (`tests/sondes/lancer.mjs:553`) : `rm -rf` y serait un bug, et le code le dit.
- **Une cible s'adresse par son chemin** (`dossier_de`, `src/main.rs:1041`). Un
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
| **13** | Publication : anonymisation, CI verte sur GitHub | `SECURITY.md`, `.github/workflows/build.yml`, `tests/sondes/*.mjs` | **fait** — 11/11 vertes sur `windows-latest` |
| **14** | Le filet ne se rabat plus sur une racine inventee : une sonde destructive sans racine fait echouer le run | `tests/sondes/lancer.mjs` | **fait** — refus avant tout demarrage |
| **15** | La regle de refus PAR VOLUME du filet etait du code mort : `lettre('A:\\')` renvoyait `''`, la branche ne pouvait pas s executer | `tests/sondes/filet.mjs` | **fait** — 403 mesuré, et Covered par la sonde d'epreuve |
| **16** | Le harnais refuse un volume de travail qui n'est pas jetable, mesure avant de demarrer quoi que ce soit | `tests/sondes/config.mjs`, `lancer.mjs` | **fait** — 18/18, test qui echoue si on retire l'appel |
| **17** | Le binaire emporte sa provenance : commit, etat de l'arbre a la compilation, agent qui compile — parce qu'un binaire du 26/09 etait inexpliquable | `build.rs`, `src/main.rs` | **fait** — `diskmap --version`, arbre sale signale ; absent de git, dit « commit-inconnu » plutot qu'invente |
| **18** | Un lot qui touche un dossier dont la perte n'est pas anodine — `.git`, `.ssh`, `AppData` comme `Images` ou `Documents` — doit le nommer, dossier par dossier, avant d'agir ; et le harnais annonce les residus qu'il trouve sur le volume de travail | `src/main.rs` (`dossiers_a_nommer`), `ui/index.html`, `tests/sondes/sonde-dossiers-a-nommer.mjs`, `sonde-ui-suppression.mjs` | **fait** — 27/27 en sonde, 21/21 dans un vrai navigateur, 14/19 (rouge) quand on neutralise la garde |
| **19** | Une sonde qui sort en 0 sans avoir ecrit son decompte est un echec, pas un vert : elle ne se distingue d'une sonde morte que par une etiquette | `tests/sondes/sonde-generation.mjs`, `tests/sondes/lancer.mjs` | **fait** — 5/5 et lisible au journal ; resume retire, ROUGE et run en 1 |

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

---
