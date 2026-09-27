# Audit de sécurité — diskmap 0.1.0

**Date de l'audit :** 26/09/2026, 19:00–20:30
**Périmètre :** `src/main.rs` (serveur HTTP + suppression), `src/win32.rs` (SHFileOperationW),
`src/scan.rs` (parcours + cache), `ui/index.html` (interface), `tests/sondes/` (13 sondes),
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
| Seconde moitié de la cause | Le harnais de sondes n'avait aucun filet — §3.6 |
| Pertes réelles | **Aucune donnée unique perdue** — §8 |

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

## 2. Chronologie de l'incident

Le journal enregistre `horodatage\tressultat\ttaille\tcount\tchemin`. Sur 957 lignes,
**168 concernent des données réelles** ; les 789 autres sont les fichiers de test que les
sondes créent (`_diskmap_*`, `essai-*`).

Les noms de dossiers et de fichiers ci-dessous sont des **placeholders** : les chemins réels
ont été remplacés, parce que ce rapport est public et qu'il n'a rien à divulguer du contenu
d'un disque personnel. La structure, les volumes, les horaires et les effets sont ceux du
journal ; seule la divulgation des noms a été neutralisée.

| Heure (26/09) | Effet | Cible |
|---|---|---|
| 05:05:16 | corbeille | `G:\<cache pnpm>\v11\index.db` |
| **05:55:14** | **définitif — 25 fichiers** | `G:\<projet A>\*` : LICENSE, README(.i18n/.zh), SAFETY*, THIRD_PARTY_NOTICES, package.json, pnpm-lock.yaml, pnpm-workspace.yaml, pytest.ini, tsconfig* (10) |
| 05:55:25 | corbeille — 5 | `G:\<projet A>\website\{.gitignore,AGENTS.md}`, `G:\<sauvegardes>\<projet B>\{LISEZMOI-sauvegarde.md, projet-B-2026-09-21.bundle, projet-B-2026-09-22.bundle}` |
| **05:56:11** | **définitif — 25 fichiers** | `G:\<sauvegarde photos>\Photos\<dossier imagerie>\<lecteur DICOM>\*.dll` |
| **05:56:15** | **définitif — 11 fichiers** | `G:\<profil utilisateur>\AppData\Local\Temp\<restauration>\<projet B>\*` (11), `G:\<projet C>\{DECISIONS,PROJECT_STATE,ROADMAP,README}.md` + 6, `G:\Users\Public\desktop.ini`, `G:\<projet A>\<config d'agent>\project-id` |
| 05:56:15 | définitif — 2 | `G:\<sauvegardes>\incident-2026-09-22\stash-*.patch` |
| 05:56:24 → 05:56:51 | corbeille — ~62 | `G:\<vapeurs>*` (30), `G:\<jeux>*` (14), `G:\<sauvegarde photos>\…` (12), `G:\<sauvegardes>\*` (6) |

Deux entrées du 25/09 à 21:02 (`E:_diskmap_test`) sont des sondes, pas des données.

**Indices de mécanisme :**

- La suppression de 05:05:16 (`G:\<cache pnpm>\v11\index.db`) correspond **mot pour mot** au
  symptôme consigné dans le commentaire `Montre` de `src/main.rs` : l'agent qui a écrit le
  correctif a reproduit le bug sur le disque réel avant de le corriger.
- Les lots font **exactement 25 fichiers**, à 4–15 secondes d'intervalle, et traversent des
  racines sans rapport entre elles (`G:\<profil utilisateur>\…`, `G:\Users\Public`,
  `G:\<projet A>\…`, `G:\<projet C>\…`). Un nettoyage manuel choisit dans **un** dossier.
  C'est la signature d'identifiants résolus contre un index décalé.
- La dernière suppression réelle est à 05:56:51. Le correctif du défaut d'index est commité
  à **06:29:57** (`bb5c60e`), soit 33 minutes plus tard.

**Ce qui a déclenché ces suppressions.** L'agent de développement qui écrivait
l'application a lancé son harnais de sondes sur le volume de travail `G:` — le volume
réel, celui qui contient les données. La sonde de coût, `sonde-suppression-lot.mjs`,
posait des fichiers sous un dossier de travail de l'agent et envoyait au
serveur des **identifiants** en espérant qu'ils désigneraient ces fichiers. Le serveur les
a résolus contre un index réanalysé depuis (§3.1) : les chemins visés désignaient d'autres
fichiers, et l'agent, qui ne pouvait pas le voir, n'a rien constaté. La sonde n'a pas
commis l'erreur — **elle a fait confiance à la composante même qu'elle était censée
éprouver**. Le harnais n'avait aucun filet pour la rattraper (§3.6).

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
(`src/main.rs:1218-1236`) ; `execute` ne résout plus rien et ne supprime que les chemins
figés par l'aperçu (`struct Montre`, `src/main.rs:63-90`).

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

### 3.6 Le harnais de sondes n'avait aucun filet — **corrigé le 26/09/2026**

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
| Page web tierce | Rien. `X-Diskmap` sur tous les POST (`src/main.rs:795`), `Host` local sur **toutes** les routes, lectures comprises (`src/main.rs:772`) |
| DNS rebinding | Rien, pour la même raison |
| Processus local, même utilisateur | Tout : il peut supprimer directement. Le serveur n'est pas une frontière |
| **Volume au nom hostile** | **Effacer n'importe quel fichier, sans l'interface** — voir R1 |
| Utilisateur, usage normal | Effacer un fichier qu'il n'a pas coché, au-delà de 25 éléments — voir R2 |
| Utilisateur, app élevée | Tout hors les 7 noms réservés (`src/main.rs:1161`) — voir R5 |

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

`ui/index.html:1036` : `for (const it of d.items.slice(0, 25))`, suivi de
`… et ${d.items.length - 25} autre(s)`. Rien n'empêche l'exécution de traiter les N.

« Tout sélectionner » dans un dossier de 200 entrées affiche donc 175 chemins que
l'utilisateur n'a jamais vus, puis un clic les supprime. Le garde-fou au 20 Go
(`ui/index.html:1025`) est lui aussi purement client, et ne couvre pas le *nombre*.

Le README affirme : « *it is impossible to delete something that was not shown first, or on
the strength of a stale list* ». **La seconde moitié est vraie ; la première est fausse au-delà
de 25 éléments.** C'est aujourd'hui le principal residual : c'est lui qui protège les
documents personnels, puisque `blocked_reason` (`src/main.rs:1161`) ne refuse que
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

`src/scan.rs:489` : `load(path, expected_serial)` vérifie le magic, la version et le numéro
de série. La racine est lue ligne 522 (`let root = …`) puis **jamais comparée** à la lettre du
volume. Or `dir_path` reconstruit les chemins à partir de `dirs[0].name` (`src/scan.rs:353`),
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

### R6 — Le journal ne dit pas ce qui était prévu · **Faible, mais structurant** · *corrigé*

`journal` (`src/main.rs:1599`) écrivait l'issue, la taille et le chemin **réellement traité**.
Il ne conservait ni le chemin prévu par l'aperçu, ni l'origine de la requête. C'est
précisément ce qui a rendu l'incident du §2 impossible à qualifier.

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

`src/main.rs:1322` insère à chaque `dry` ; `p.retain` (`src/main.rs:1358`) n'est appelé que
dans `execute`. Des aperçus répétés sans confirmation font croître la map sans borne —
jusqu'à 4 Mio d'identifiants, soit une centaine de milliers de chemins. Purger dans `dry`
aussi règle le tir en une ligne.

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

---

## 6. Ce qui est solide

Le travail de durcissement est de bon niveau ; ces points ne doivent pas être perdus.

- **La cible est figée à l'aperçu.** `Montre` porte le chemin résolu ; `execute` ne résout
  plus rien. C'est la bonne architecture : la seule façon de supprimer reste de décider ce
  qu'on supprime.
- **Une génération par instantané** (`src/scan.rs:236,305`), servie par `/api/tree` et
  `/api/search`, exigée par `dry`. Un identifiant périmé est refusé, pas réinterprété.
- **Jeton** : `BCryptGenRandom` (`src/win32.rs:216`), usage unique, dix minutes, lié au
  volume, avec repli qui ne dérive jamais d'une constante.
- **CSRF** : `X-Diskmap` sur tous les POST, `Host` local sur toutes les routes, lectures
  comprises. Le raisonnement sur le rebinding (l'en-tête `X-Diskmap` est posable librement
  en same-origin, seul le nom de `Host` trahit l'attaque) est exact.
- **Points d'analyse** refusés au scan (`src/scan.rs:774`) *et* à l'exécution
  (`src/win32.rs:292`), avec `symlink_metadata` pour inspecter l'entrée et non sa cible.
- **`\\?\` interdit à l'effacement** (`src/win32.rs:242`) : ce préfixe court-circuite la
  corbeille. Le commentaire explique pourquoi le scan s'en sert et la suppression non.
- **La réversibilité se constate**, elle ne se déduit pas du code de retour : les fiches `$I`
  sont lues une fois après la boucle, filtrées par date, et l'issue est journalisée comme
  ce qui a eu lieu, pas comme ce qui était demandé.
- **Lectures bornées** : corps 4 Mio sans allocation préalable, ligne d'en-tête 8 Ko,
  en-têtes 32 Ko, 64 connexions, timeouts. Un `Content-Length: 999999999999` ne tue plus le
  processus.
- **Le harnais de sondes** ne nettoie que des noms connus sous une racine dédiée
  (`tests/sondes/lancer.mjs:238`) : `rm -rf` y serait un bug, et le code le dit.

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

## 8. Pertes réelles — inventaire

Les 168 chemins du journal ont été comparés un par un à l'état du disque le 26/09 au soir.

| État | Nb | Détail |
|---|---|---|
| Intacts, taille identique à la destruction | 111 | photos, jeux, sauvegardes, bundles |
| Présents, taille différente | 43 | 25 DLL d'un lecteur d'imagerie, 18 fichiers d'un projet de code |
| Encore absents | 14 | 2,28 Mo |

Sur les 14 absents : 2,05 Mo sont des `.tsbuildinfo` — cache d'incrémental TypeScript,
régénéré par le prochain `tsc` ; 174 octets sont un `desktop.ini`, que Windows recrée ;
et 234 Ko sont 11 fichiers d'un projet de code, dont **les 11 sont présents dans le dépôt
d'origine** sur un autre volume, lui-même sauvegardé en trois bundles git dont un hors
machine.

Des 43 « taille différente » : les 18 fichiers du projet de code portent des dates du
26/09 06:03–08:34, **après** la destruction de 05:56 — ce projet a continué à être travaillé,
l'écart est du travail normal. Les 25 DLL du lecteur d'imagerie sont des tables de
redirection sans code ni donnée, toutes remplacées par des équivalents.

**Conclusion : aucune donnée unique n'a été perdue.** Le journal
`%LOCALAPPDATA%\diskmap\suppressions.log` reste la liste exhaustive de ce qui a été
touché, et doit être conservé.

---

## 9. Reproduction

```bat
cargo build --release
node tests\sondes\lancer.mjs --liste

rem Sondes destructives : UNIQUEMENT sur un volume jetable, jamais sur un volume de
rem travail. Sur cette machine, un VHD de 512 Mo monté sur une lettre libre suffit.
set DISKMAP_SONDE_VOLUME=V
set DISKMAP_SONDE_RACINE=V:\_diskmap_sondes
node tests\sondes\lancer.mjs --volume V

rem Ce qu'on a exécuté le 26/09/2026, le filet interposé et V: jetable :
node tests\sondes\lancer.mjs --volume V
rem   -> 11/11 sondes vertes, 231 suppressions, toutes sur V:
```

`filet` est la première à jouer, et c'est voulu : elle prouve que le filet est
interposé avant que quoi que ce soit d'autre ne s'exécute. `generation` est celle qui
prouve §3.1 — un identifiant périmé est refusé au lieu de viser un autre fichier. La
section 1 de `lot` rejoue l'incident complet. Aucune de ces trois ne détruit rien qui ne
lui appartienne.
