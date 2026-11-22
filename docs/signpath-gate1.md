# Porte 1 — dossier d'acceptation diskmap avant SignPath

**Statut : PARTIEL au 2026-11-21.** A1, A2, A3–A9 et A10 sont prouvés (A1, A2 et A10 dans « Preuves du 21/11/2026 », A3–A9 dans la table des contrôles). A11–A13 attendent un compte SignPath ; A14 appartient à Ro. Tant que ces cases sont vides, l'application n'est ni testée ni approuvée au sens du plan SignPath.

**Référence :** plan SignPath déposé dans le vault `team-memory`, note `2026-11-17_workbuddy_diskmap-plan-signpath.md`.
**Prérequis organisationnel :** satisfait pour la revue — PR #1 et #2 sont fusionnées (17–18/11/2026). La ruleset `27500006` n'a pas été vérifiée dans cette passe.

## Correction importante au plan initial

La signature modifie le hash d'un binaire. Il ne faut donc **pas** exiger que le binaire test-signé garde le SHA-256 de l'artefact CI non signé. La chaîne correcte est :

1. hash de l'artefact **non signé** envoyé à SignPath = hash publié dans la release CI ;
2. SignPath renvoie un binaire **signé**, avec un nouveau hash, à consigner séparément ;
3. la resubmission en `release-signing` porte sur la **même requête SignPath** (`Resubmit signing request`), pas sur une recompilation, conformément à `docs.signpath.io/signing-code`.

## Contrôles d'acceptation

| ID | Contrôle | Commande ou observation | Attendu | Preuve à joindre |
|---|---|---|---|---|
| A1 | Provenance | `diskmap.exe --version` | commit de la release, `arbre propre`, `github-actions`, date = date du commit | v0.1.117 (binaire soumis) : `diskmap 0.1.0 — f192e3df80f5` ; `f192e3df80f5 · arbre propre · construit par github-actions le 2026-11-22 05:59:57 UTC`. Historique : v0.1.115 `9c7f08c76e63`, v0.1.100 `78d0f63a9d71`. |
| A2 | Hash source | `Get-FileHash .\diskmap.exe -Algorithm SHA256` sur l'artefact **non signé** | identique à la release GitHub et au `diskmap.sha256` de l'artifact | v0.1.117 (soumis) : `767362C1E859D761041C7DFA237A4AA80EB7A4109F07F40AF407A7644CEED4B0`, identique au `digest` de l'asset et aux notes de release. Historique : v0.1.115 `5A4AD285…E1D2`, v0.1.100 `4084FB19…94E1`. |
| A3 | Scan réel | lancer sur un volume de travail, attendre la fin | scan terminé, totals cohérents, droits/refus listés plutôt que tus | V: jetable (Msft Virtual Disk), run local `node tests/sondes/lancer.mjs --volume V` → `suppression 34/34`, `reelle 38/38`, `aNommer 27/27` ; scan de V: (3 dossiers, 0 fichiers) et C: (724 820 dossiers, 3 758 182 fichiers) terminé ; droits/refus listés (5 exécutions refusées par le filet). Journal brut archivé : `evidence/sondes-run-V.log` (25/25 sondes vertes, exit 0). |
| A4 | Recherche et tri | mêmes critères via `/api/tree` et `/api/search` | ordre identique, troncature annoncée si `exact=false` | `recherche 25/25`, `rechercheGrande 7/7` (noms distincts 634/800, `package.json` sur C: total 27 569, rendu 800, `exact=false`, `tronque=true`). |
| A5 | Arrêt en cours | demander l'arrêt pendant un scan | 409 puis arrêt propre, aucun `scan_running` résiduel | `arret 9/9`, `arret-idle 3/3`, `arret-running 4/4` (serveur dédié 8811). |
| A6 | Aperçu de suppression | `mode=dry` avec `gen` courante | chemins figés, éléments protégés marqués `blocked`, jeton à usage unique | `suppression 34/34` ; filet : aperçu douteux (1/1) neutralisé, jeton à usage unique. |
| A7 | Corbeille | supprimer un fichier créé pour l'essai | `$I` présent, journal écrit, réversibilité constatée | `reelle 38/38`, `reversibilite 10/10` (scénario 1 joué ; scénario 2 NukeOnDelete non exercé — pas de volume désigné). |
| A8 | Définitif | tenter sans `EFFACER`, puis avec | refus puis succès, journal distinguant les deux lots | `reelle 38/38` (refus sans `EFFACER` puis succès avec, journal distinguant les deux lots). |
| A9 | Dossiers à nommer | lot touchant `.git` ou `Documents` | refus tant que le nom n'est pas saisi | `aNommer 27/27`. |
| A10 | Gardes HTTP | sondes `host`, `corps`, `entrees` | vertes en CI sur le commit fusionné | run [44209801027](https://github.com/Roger364/diskmap/actions/runs/44209801027), commit 78d0f63 : build/windows/sondes/release = success ; `host 34/34`, `corps 4/4`, `entrees 12/12`, `25/25 sondes vertes`. Réserve : la sonde `host` déclare la garde 403 non exercée (le parseur Node répond 400 avant). |
| A11 | Signature de test | `Get-AuthenticodeSignature .\diskmap.exe` sur le binaire **signé pour test** | `Status = Valid`, chaîne de certificat SignPath reconnue sur la machine de test | _à remplir_ |
| A12 | Hash signé | `Get-FileHash` sur le binaire signé pour test | consigné comme **nouveau** hash, distinct de A2 — pour v0.1.117, donc distinct de `767362C1…ED4B0` | _à remplir_ |
| A13 | Comportement signé | rejouer A1, A3, A6, A7 avec le binaire signé pour test | mêmes résultats qu'en non signé | _à remplir_ |
| A14 | Décision | Ro lit les preuves A1–A13 et statue | `APPROUVÉ` ou `REFUSÉ`, daté et signé | _à remplir_ |

Aucune suppression réelle ne doit être faite sur un disque contenant des données. Les essais A7–A9 se font sur un volume jetable (`tests/sondes/creer-volume-test.ps1`) ou sur les artefacts créés par la sonde elle-même.

## Preuves du 21/11/2026

Binaire de référence : asset `diskmap.exe` de la release **v0.1.100**, commit
`78d0f63`, non signé, 739 840 o.

| ID | Preuve | Commande reproductible |
|---|---|---|
| A1 | Le binaire déclare `78d0f63`, arbre propre, `github-actions`, 2026-11-18 00:40:49 UTC. | `./diskmap.exe --version` |
| A2 | Les trois hashes concordent : `4084FB19…94E1`. | `sha256sum diskmap.exe artifact/diskmap.exe` ; `cat artifact/diskmap.sha256` |
| A10 | Jobs `build`, `windows`, `sondes`, `release` verts ; `host 34/34`, `corps 4/4`, `entrees 12/12` ; `25/25 sondes vertes`. | `gh run view 44209801027 --json jobs` ; journal du job `sondes` |

Le binaire, le journal CI complet et la fiche `A1-A2-A10.md` sont archivés hors
dépôt dans `G:/workspaces/workbuddy-ai/_sauvegardes/diskmap-2026-11-21/evidence/`.

Les preuves A3–A9 proviennent d'un run local sur `V:` jetable le 2026-11-21 ;
leurs chiffres sont repris de la sortie de
`node tests/sondes/lancer.mjs --volume V` dans la table des contrôles. Le journal
brut de ce run est archivé : `evidence/sondes-run-V.log` (75 lignes, sha256
`d11cd11f…f12a4000`, `25/25 sondes vertes`, exit 0).

Ces mêmes compteurs sont reproductibles publiquement : le job `sondes` du run
[44956721088](https://github.com/Roger364/diskmap/actions/runs/44956721088)
(commit `a6e658f`, tête de cette branche) donne `25/25 sondes vertes` et, à
l'identique, `suppression 34/34`, `reelle 38/38`, `aNommer 27/27`,
`recherche 25/25`, `rechercheGrande 7/7`, `arret 9/9`, `arret-idle 3/3`,
`arret-running 4/4`, `reversibilite 10/10`. Journal du job archivé hors dépôt :
`evidence/ci-44956721088-sondes.log`. Restent locales, parce que liées à la
machine, les deux comptages de scan (`V:` 3 dossiers / 0 fichier, `C:` 724 820
dossiers / 3 758 182 fichiers), tels quels dans `evidence/sondes-run-V.log`, et
les compteurs que l'environnement du runner
décale (`tickets`, `plafond`, `palier`, `ui`, `elevation`, `csrf`, `erreurs`).

**Reste à faire, dans cet ordre :** A11–A13 après une requête SignPath
`test-signing` ; puis A14, décision de Ro. Le journal du run local et celui du
job CI sont archivés et hashés dans `SHA256SUMS`. A10 est verte
mais porte la réserve structurelle de la sonde `host` : elle ne prouve pas la
garde 403 de l'application.

## Brouillon de configuration SignPath

À créer dans l'interface SignPath, sans rien soumettre à ce stade. Sources : `docs.signpath.io/projects`, `docs.signpath.io/signing-code`, `docs.signpath.io/artifact-configuration/syntax`.

### Projet

| Champ | Valeur proposée |
|---|---|
| Name | `diskmap` |
| Slug | `diskmap` |
| Repository URL | `https://github.com/Roger364/diskmap` |
| Trusted build system | `GitHub.com`, lié au projet |
| Readers / Configurators | Ro |

### Policies

| Slug | Purpose | Certificat | Soumetteurs | Approbation | Origine |
|---|---|---|---|---|---|
| `test-signing` | test | certificat de test | CI uniquement | aucune | non requise |
| `release-signing` | release | certificat de release | CI uniquement | 1 approbation de Ro | vérifiée, branche `master` |

### Configuration d'artefact

Le job `build` téléverse `diskmap.exe` **et** `diskmap.sha256` dans un même artifact, donc sous forme ZIP par défaut. Configuration minimale proposée :

```xml
<artifact-configuration xmlns="http://signpath.io/artifact-configuration/v1">
  <zip-file>
    <pe-file path="diskmap.exe">
      <authenticode-sign/>
    </pe-file>
  </zip-file>
</artifact-configuration>
```

Point à vérifier lors de la création dans SignPath : la façon dont l'interface traite le second fichier `diskmap.sha256`. La documentation confirme l'élément générique `<file path="…">`, mais pas explicitement un mode « fichier non signé » sans directive. La méthode la plus sûre est d'**uploader un échantillon réel** et de laisser SignPath générer la configuration, puis de comparer avec le snippet ci-dessus. Ne pas inventer d'attribut `sign="false"`.

### Secret

`SIGNPATH_API_TOKEN` ne sera créé qu'à la porte 4, avec la valeur fournie par Ro. Aucun token, identifiant d'organisation ou slug définitif n'est écrit ici : ils doivent venir de la configuration SignPath réelle, pas d'une supposition.

## Suite après approbation

1. Resubmettre la requête `test-signing` en `release-signing` depuis l'interface SignPath — même artefact, même origine.
2. Remplacer dans `.github/workflows/build.yml` le fallback PFX par la consommation de l'artefact signé.
3. Publier avec SHA-256 du binaire signé et empreinte du certificat dans les notes de release.
4. Mettre à jour `README.md` et `SECURITY.md` : fin de la mention « release unsigned », commande `Get-AuthenticodeSignature`.

## Preuves du 22/11/2026 — release v0.1.115 (première build avec ressources PE)

PR #3 fusionnée le 2026-11-22T05:13:25Z → `master` = `9c7f08c`
(`Merge pull request #3 from Roger364/prep/gate1-preuves`). Run 44988460699 :
`build`, `windows`, `sondes`, `release` = `success`.

Binaire de référence : asset `diskmap.exe` de la release **v0.1.115**, commit
`9c7f08c`, non signé, 740 864 o, sha256
`5A4AD2858DCCAB83C6C97F5901945AC196CF933FF393413296BA04254C96E1D2`.

| ID | Preuve | Commande reproductible |
|---|---|---|
| A1 | Le binaire déclare `9c7f08c`, arbre propre, `github-actions`, 2026-11-22 05:13:25 UTC. | `./diskmap.exe --version` |
| A2 | Hash de l'asset = `5A4AD285…E1D2`, identique au `digest` de l'asset et à la ligne des notes de release. | `Get-FileHash .\diskmap.exe -Algorithm SHA256` ; comparer au `digest` de l'asset GitHub |
| PE | `ProductName=diskmap`, `ProductVersion=0.1.0`, `FileVersion=0.1.0`, `CompanyName=Roger364`, `OriginalFilename=diskmap.exe`, `FileDescription=Disk space explorer for Windows`. | `(Get-Item .\diskmap.exe).VersionInfo` |
| Sig | `Get-AuthenticodeSignature` → `NotSigned` (normal, aucun certificat). | `Get-AuthenticodeSignature .\diskmap.exe` |

## Binaire soumis à SignPath — release v0.1.117

Le binaire envoyé en `test-signing` (A11) puis resoumis en `release-signing`
est l'asset de la **v0.1.117** : c'est la dernière release et elle correspond à
`master`. PR #4 (docs seulement : `signpath-eligibility.md` +1/−1,
`signpath-gate1.md` +21/−0) fusionnée le 2026-11-22T05:59:57Z → `master` =
`f192e3d` ; run
[44991750829](https://github.com/Roger364/diskmap/actions/runs/44991750829) :
`build`, `windows`, `sondes`, `release` = `success` ; release
[v0.1.117](https://github.com/Roger364/diskmap/releases/tag/v0.1.117) publiée le
2026-11-22T06:12:42Z.

Binaire de référence : asset `diskmap.exe` de **v0.1.117**, commit `f192e3d`,
non signé, 740 864 o, sha256
`767362C1E859D761041C7DFA237A4AA80EB7A4109F07F40AF407A7644CEED4B0`.

| ID | Preuve | Commande reproductible |
|---|---|---|
| A1 | Le binaire déclare `f192e3df80f5`, arbre propre, `github-actions`, 2026-11-22 05:59:57 UTC. | `./diskmap.exe --version` |
| A2 | Hash de l'asset = `767362C1…ED4B0`, identique au `digest` de l'asset et à la ligne des notes de release. | `Get-FileHash .\diskmap.exe -Algorithm SHA256` ; comparer au `digest` de l'asset GitHub |
| PE | `ProductName=diskmap`, `ProductVersion=0.1.0`, `FileVersion=0.1.0`, `CompanyName=Roger364`, `OriginalFilename=diskmap.exe`, `FileDescription=Disk space explorer for Windows`. | `(Get-Item .\diskmap.exe).VersionInfo` |
| Sig | `Get-AuthenticodeSignature` → `NotSigned` (normal, aucun certificat). | `Get-AuthenticodeSignature .\diskmap.exe` |

Le hash à reporter dans A12 est celui du binaire **signé** : il sera donc
différent de `767362C1…ED4B0`.

Réserve opérationnelle (édition *Open Source Code Signing*) : SignPath exige la
vérification du trusted build system et de l'origine, et interdit alors les
submitters interactifs. L'artefact doit donc être téléversé par GitHub Actions
(`upload-artifact` puis `SignPath/github-action-submit-signing-request`) dans le
run qui l'a produit. Si le job de signature est ajouté après coup, le fichier
réellement soumis sera celui du run de signature : même code, hash différent
(ligne d'origine du nouveau commit). A2 devra alors être recalculé sur ce
fichier **avant** A11 ; `767362C1…ED4B0` reste la référence de la forme publiée
au 22/11 et de ses métadonnées PE.

### Pourquoi v0.1.115 et v0.1.117 n'ont pas le même hash

`build.rs` compile le hash court du commit dans le binaire — c'est la chaîne que
`--version` affiche. `9c7f08c` et `f192e3d` sont deux commits différents, donc
deux chaînes différentes, donc deux fichiers différents : même taille (740 864 o),
mais `5A4AD285…E1D2` pour v0.1.115 et `767362C1…ED4B0` pour v0.1.117, alors que
le code Rust est identique (la PR #4 ne touche que `docs/`).

Ce n'est donc pas une non-reproductibilité du build : c'est une ligne de version
volontairement embarquée. Conséquence pratique : ne jamais citer « le hash de
diskmap » sans le tag de la release. Un rebuild du même commit devrait
réembarquer la même ligne d'origine, mais l'égalité octet par octet entre deux
builds n'a pas été mesurée et n'est pas exigée par la porte 1.
