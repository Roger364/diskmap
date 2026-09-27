# Annexe — la journée du 27/09/2026, récit

Ce fichier est le **récit** de la journée du 27/09/2026, comme
`incident-2026-09-26.md` est le récit de la veille. Il porte, lui non plus, ni la
politique de sécurité — c'est `SECURITY.md` — ni le mode d'emploi des sondes —
c'est `README.md`.

Ce qu'il raconte tient en une phrase : **sept sondes sont tombées le même jour,
et la cause n'était dans aucun des rapports.** Elle était dans une ligne du
workflow que personne n'avait lue comme une affirmation, et dans une
conversation avec soi-même où l'on croyait avoir compris.

Rien ici n'est secret. Le code des sondes est dans le dépôt, les logs sont
cités avec leurs identifiants de run, et les chemins sont ceux d'un runner
jetable. La séparation avec `SECURITY.md` répond au même besoin que la veille :
ce texte se lit une fois d'un bout à l'autre, il ne se consulte pas par
fragments.

---

## 1. Le symptôme

Sept sondes étaient rouges, échecs de nature très différentes : la confirmation
sacrée ne demandait plus rien, un mot exigé n'était plus affiché, le bandeau
d'élévation avait disparu, la navigation aboutissait dans le mauvais dossier. Rien
de commun entre elles, et c'est ce qui rendait le diagnostic impossible : sept
symptômes qui témoignent tous « la règle a changé » alors qu'aucune règle n'avait
changé.

Le premier réflexe a été de chercher un commit. Il n'y en avait pas. Le second a
été d'en écrire un, pour voir.

## 2. La cause : un séparateur, et un commentaire qui l'accusait d'autre chose

Le workflow posait :

```yaml
DISKMAP_SONDE_RACINE: 'D:\_diskmap_sondes'
```

Des **antislashs**. Or le défaut de `racine()` emploie la **barre oblique**. Une
sonde qui lisait la racine, la coupait en segments pour chercher le dossier dans
l'instantané, et obtenait **un seul segment** : `D:\_diskmap_sondes` entier,
antislash compris. Elle cherchait ce segment dans l'instantané, ne le trouvait
pas, et concluait que le dossier de travail manquait.

Le dossier existait. C'est pour cela que l'échec ne disait rien : il ne disait pas
« absent », il disait « absent selon une découpe que personne n'a vérifiée ».

Le correctif tient en une ligne (`tests/sondes/config.mjs`) :

```js
return r.replace(/(?:\\|\/)+/g, '/');
```

Il ne corrige pas le workflow. Il supprime **la classe** du défaut : la forme
écrite du chemin cesse d'avoir de l'importance. Trois sondes qui codaient
`'_diskmap_sondes'` en dur ont suivi, et lisent désormais le dernier segment de
`racine(VOL)`.

### Le commentaire qui disait faux

Pendant la recherche, le commentaire de `renderDrives` portait le diagnostic : il
accusait la fenêtre de 400 résultats d'un rendu tronqué. C'était plausible, et
c'était faux. La vraie cause était un séparateur.

La différence entre les deux n'était pas la qualité du raisonnement, elle était
**la méthode** : une explication tirée de la structure du code, face à une
explication tirée d'un fait observé. Une seule des deux pouvait être vérifiée en
une minute — poser `D:\_diskmap_sondes` dans l'instantané et regarder ce que la
sonde en dit — et c'est celle-là qu'il fallait poser d'abord.

## 3. Le fait qu'aucune sonde ne supposait : le runner est toujours élevé

Une **seconde** cause, indépendante de la première, est sortie de là — et c'est
elle qui a fait le plus de dégâts de fond.

Le runner de GitHub Actions tourne **toujours en administrateur**. Aucune sonde ne
le disait. Ce n'est pas un oubli de lecture : tout le monde sait que
l'application a un bandeau « relancé en administrateur », donc que le cas existe.
Ce que personne ne savait, c'est que *ce cas-là*, lui, ne s'était jamais produit
dans un test — parce que le seul endroit où il se produit est précisément
l'endroit où personne ne lance de test à la main.

La sonde d'élévation, une fois remise en marche, l'a établi par la mesure :
**`elevation` 19/19 sur le runner élevé, 16/16 en local**, à volume logique
identique. Dix-neuf vérifications qui n'avaient jamais eu lieu, pas dix-neuf
qui échouaient.

La règle retenue est courte et se lit dans `SECURITY.md` §R5 :

> **Une sonde ne suppose jamais l'instance.**

Elle ne dit pas « teste les deux ». Elle dit : que la loi que tu vérifies
s'applique, et si tu en dépends, mesure d'abord que tu es dans le cas.

Une sonde d'élévation a été écrite pour l'énoncer (`tests/sondes/sonde-elevation.mjs`,
run `36329398102`, `elevation 19/19`). Elle cherche son volume par **nom** via
`/api/search`, elle énonce une loi et non une branche, et elle est enregistrée
dans le harnais entre `ui` et `csrf`.

## 4. L'épreuve de rupture

Corriger un défaut qu'on a compris ne prouve pas qu'on l'a compris. Pour le
prouver, il faut **casser la règle, vérifier que les sondes rougissent, remettre,
et revalider**.

La règle cassée : `eleve_change_le_geste()` amenée à ne plus rien changer, et
le bandeau masqué. Commit `0b94ebe`, poussé sur une branche de travail, run
`36332300684` — **failure**, comme prévu.

### Ce qui a rougi

| Où | Mesure | Attendu |
|---|---|---|
| `cargo test` | 28/29 — `tests::les_mots_s_additionnent_ils_ne_se_remplacent_pas` | rouge |
| `mot` | 4/5 — `mots_recycle=[]`, attendu `["EFFACER"]` (corbeille=true, élevée=true) | rouge |
| `ui` | `0 champ(s) pour le mot "EFFACER"`, puis `locator.fill` timeout sur `#dbody .dconfirm` | rouge |
| `elevation` | 14/17 — bandeau absent, conséquence vide, et **LA LOI** : `mots=[]` | rouge |
| `release` | **skipped** | skipped |

`14/17 sondes vertes`, `ROUGES : mot, ui, elevation`. Le test Rust échoue sur
`["SUPPRIMER"]` contre `["SUPPRIMER", "EFFACER"]` — les règles s'additionnent, et
en couper une n'en supprime pas les autres : c'est exactement ce que l'assertion
écrit.

`release: skipped` est la ligne la plus importante du tableau. Elle dit que la
garantie tient : un binaire cassé n'atteint pas `main`. C'est une promesse de
pipeline, et elle ne se vérifie qu'en la relevant.

### Ce qui est resté vert, et pourquoi c'était attendu

**La vérification d'accord interface ↔ serveur est restée verte.** Elle vérifie
un *accord*, pas une justesse : que l'interface demande exactement les mots que
le serveur exige. Les deux avaient changé de la même façon, donc ils
s'accordaient toujours.

C'est une limite de la famille, pas un défaut de cette vérification. Un test qui
suppose que le serveur a raison ne peut pas détecter que le serveur a tort — il ne
peut que détecter que les deux se contredisent. C'est le rôle de `elevation`, qui
énonce la loi à partir de l'instance réelle et non d'un accord.

## 5. Une prédiction que j'ai annoncée et qui n'est pas arrivée

Avant le run, j'avais écrit que la sonde `erreurs` rougirait. **Elle est restée
verte, 26/26.**

L'argument n'était pas absurde : `erreurs` **connaît** l'instance — l'un de ses
cinq points est le conseil d'élévation, et la rupture venait précisément de
l'instance. Sur 26 vérifications, 3 allaient rougir ; il était raisonnable de
parier que ce seraient celles-là.

Le pari était mal placé, et pour une raison instructive : les trois sondes qui
ont rougi — `mot`, `ui`, `elevation` — portaient toutes sur **la même cause**, et
cette cause (`eleve_change_le_geste()`) ne touche que l'interface. `erreurs` avait
bien reçu la nouvelle valeur de l'instance ; elle l'avait trouvée **conforme à ce
qu'elle attendait**, parce que son attente porte sur une interface masquée, pas
sur la donnée. Un test ne rougit pas parce qu'il est proche du défaut ; il rougit
seulement si le défaut entre dans ce qu'il mesure.

Le corollaire est celui qui compte, et il a été appris de travers : **une
affirmation qu'on n'a pas mesurée n'a pas le statut d'un fait, même quand elle est
bien construite.** Elle va dans les notes, ou nulle part — et surtout pas dans
la tête de celui qui répartit le budget du diagnostic, où elle se comporte
comme une donnée et fait écran aux causes réelles.

Une seconde leçon, plus sèche : la sonde `erreurs` est restée verte à travers la
rupture *et* la restauration. Une sonde qui ne peut pas rougir est une sonde qui
ne prouve rien, et le harnais le sait — c'est pourquoi il refuse d'inclure une
sonde qui ne mord pas (§ R5, le filet). Une sonde verte par défaut n'est pas
une sonde : c'est un décor.

## 6. Le retour à la normale, et ce qu'il a trouvé

Revert `b8611d7`. `git diff 0b94ebe~1 HEAD -- src/main.rs ui/index.html` est
**vide** : la restauration est exacte, pas approximative. 29 tests verts.

Puis le run de restauration (`36333151071`) a **échoué**, et pour une raison qui
n'avait rien à voir avec la rupture : `ui` 13/15 sur le clic.

```
mesuré : fil : D:\a\_actions2 éléments · 2,1 Mo dans ce dossier · 2 ligne(s) :
        actions [clic] | dtolnay [clic]
```

`D:\a\_actions` est le répertoire de travail du runner. La sonde cliquait sur un
dossier, et la navigation aboutissait **ailleurs**. C'est un défaut produit, et il
était là depuis le début : personne ne l'avait vu parce que personne n'avait cliqué
dans la fenêtre exacte où il se manifeste.

La cause : `renderRows()` reconstruisait `#rows` de zéro à chaque appel, et
`poll()` appelle `load()` **toutes les 700 ms** pendant une analyse. Entre le
`innerHTML = ''` et le remplissage, un clic part sur un nœud détaché : le serveur
reçoit l'identifiant d'une ligne qui n'existe plus.

`renderDrives` portait déjà la règle — ne reconstruire que si ce qui est affiché
change. `renderRows` l'avait oubliée, et c'est elle qui est périodique : le
défaut est plus grave précisément parce qu'il revient tout seul.

Le correctif (`a91be86`) introduit une signature de ce qui est affiché, incluant
le tri, l'ordre et la sélection. Inclure la sélection n'est pas un détail : une
signature calculée sans elle afficherait une liste toute décochée, ce qui serait
pire que le défaut corrigé.

Quatre mesures ont été ajoutées en fin de sonde, prouvées par **l'identité du
nœud** et non par le contenu. Deux entrées de même taille rendent le même ordre
quel que soit le réglage : une vérification par le contenu n'aurait pas su
distinguer « le réglage n'a pas été appliqué » de « l'ordre demandé rendait la
même liste qu'avant ».

## 7. Une sonde qui salissait le bureau de celui qui la lance

`sonde-erreurs.mjs` prouve que `/api/reveal` **accepte** un chemin de la liste
des illisibles. Pour le prouver, elle appelle la route — et le serveur ouvre
l'Explorateur, comme il le doit pour un vrai clic. Chaque run laissait une
fenêtre à l'écran. Le 27/09, **33 fenêtres « Bureau »** s'étaient accumulées sur la
machine de l'auteur de ces lignes.

Une sonde qui salit le bureau de celui qui la lance n'est plus une sonde.

Le remède n'est pas côté serveur : `/api/reveal` doit continuer d'ouvrir une
fenêtre visible, c'est ce que demande la personne qui clique sur « révéler ». Il
est autour de l'appel (`tests/sondes/fenetres.mjs`), et selon une seule règle :
**fermer ce qu'on a fait naître**. Un instantané des fenêtres déjà ouvertes est
pris avant la route, et un descripteur qui y figure n'est jamais touché — une
fenêtre que l'utilisateur ouvre de son côté pendant la sonde lui reste. Le
guetteur démarre **avant** l'appel, ce qui permet de minimiser la fenêtre à sa
naissance au lieu de la rattraper une seconde plus tard, quand elle a déjà volé
le focus.

Deux détails ont coûté une passe, et valent d'être notés. Le premier : le titre
de ces fenêtres est `Bureau` + **espace insécable** (U+00A0) + `: Explorateur de
fichiers`. Une comparaison « raisonnable » échoue en silence ; il a fallu lire les
points de code. Le second : le processus `explorer.exe` **n'est jamais tué** — c'est
le bureau, pas une fenêtre.

Si le guetteur échoue, la sonde le **dit** au lieu de passer au vert. Un vert
mesuré par un capteur qui ne mesurait plus rien ne vaut rien.

### Ce que les fuites faisaient aux runs

En fermant les 33 fenêtres avant un run, `generation` est repassée verte
(`SANS SYNTHESE`, 17/17 sondes vertes). Elle échouait depuis deux runs sur une
assertion libuv :

```
Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76
```

**Les fenêtres accumulées dégradaient la machine, et la sonde qui les laissait
fuyait dégradait la suivante.** Une fuite dans le harnais se paie deux fois : une
fois dans le bureau de l'utilisateur, une fois dans la fiabilité des mesures. Sur
un runner, cela se voit encore plus, où rien d'autre ne tourne.

L'assertion elle-même n'a pas été diagnostiquée. Elle a **disparu** quand la charge
a baissé, ce qui est un fait, pas un diagnostic. Elle est notée ici comme
*récidive possible* et non comme cause résolue.

## 8. Ce qui reste ouvert

- **`#sort` et `#order` sont inertes tant qu'une recherche est active.** Le handler
  teste `if (!$('#q').value.trim())` avant de recharger. C'est un choix, pas un
  accident — mais le contrôle reste visible et semble donc agir. Un sélecteur
  inerte est un mensonge de l'interface.
- **Le sélecteur de tri ne sépare pas deux entrées de même taille.** La sonde ne
  peut pas mesurer un changement de tri sur un dossier dont deux entrées font la
  même taille : elle compare le contenu, et le contenu ne change pas. La
  correction de `renderRows` a résolu le défaut, pas cette limite de mesure.
- **L'assertion libuv de §7.** Non diagnostiquée. Recidive déclarée.

## 9. Ce que la journée donne comme règles

1. **Une sonde ne suppose jamais l'instance.** Elle mesure qu'elle est dans le cas
   qu'elle vérifie. (`SECURITY.md` §R5, `README.md`.)
2. **Corriger un défaut ne prouve pas qu'on l'a compris.** Le casser, voir rougir,
   remettre, revalider : c'est le seul contrôle qui distingue une compréhension
   d'une explication.
3. **Un test qui suppose que le serveur a raison ne peut pas voir qu'il a tort.**
   Il faut une loi énoncée depuis l'instance réelle.
4. **Une affirmation non mesurée n'a pas le statut d'un fait**, même bien
   construite. §5 est la démonstration.
5. **Chercher d'abord la cause la plus stupide, et la vérifier.** Le séparateur
   (§2) coûtait moins d'une minute à trouver. L'accusation du rendu tronqué,
   elle, coûtait une hypothèse de plus.
6. **Une sonde doit rendre la machine dans l'état où elle l'a trouvée.** Fenêtres,
   corbeille, fichiers : la règle vaut aussi pour ce qui s'affiche.
7. **Comparer un chemin suppose de connaître sa forme exacte.** U+00A0.

---

## Références

| Élément | Où |
|---|---|
| Règle de l'instance | `SECURITY.md` §R5, `README.md` |
| Normalisation de la racine | `tests/sondes/config.mjs`, `racine()` — `87accee` |
| Loi énoncée sur l'instance | `tests/sondes/sonde-elevation.mjs` — `d2726f0`, `37df9b9` |
| Re-rendu de la liste | `ui/index.html`, `sonde-ui-suppression.mjs` — `a91be86` |
| Guetteur de fenêtres | `tests/sondes/fenetres.mjs`, `fenetres.ps1` — `53bd3ce` |
| Rupture / restauration | `0b94ebe` / `b8611d7` |
| Runs | `36329398102` (élévation), `36332300684` (rupture), `36333151071` (restauration) |
