# Porte 1 — dossier d'acceptation diskmap avant SignPath

**Statut : À REMPLIR.** Ce document ne certifie rien. Il décrit les preuves à réunir avant toute resubmission en `release-signing`. Tant que les cases « Preuve » sont vides, l'application n'est ni testée ni approuvée au sens du plan SignPath.

**Référence :** plan SignPath déposé dans le vault `team-memory`, note `2026-11-17_workbuddy_diskmap-plan-signpath.md`.
**Prérequis organisationnel :** PR #1 (`prep/signpath-gate2 → master`) doit être revue et fusionnée par Ro. La ruleset `27500006` reste désactivée jusqu'à ce que la revue soit réellement en place.

## Correction importante au plan initial

La signature modifie le hash d'un binaire. Il ne faut donc **pas** exiger que le binaire test-signé garde le SHA-256 de l'artefact CI non signé. La chaîne correcte est :

1. hash de l'artefact **non signé** envoyé à SignPath = hash publié dans la release CI ;
2. SignPath renvoie un binaire **signé**, avec un nouveau hash, à consigner séparément ;
3. la resubmission en `release-signing` porte sur la **même requête SignPath** (`Resubmit signing request`), pas sur une recompilation, conformément à `docs.signpath.io/signing-code`.

## Contrôles d'acceptation

| ID | Contrôle | Commande ou observation | Attendu | Preuve à joindre |
|---|---|---|---|---|
| A1 | Provenance | `diskmap.exe --version` | commit de la release, `arbre propre`, `github-actions`, date = date du commit | _à remplir_ |
| A2 | Hash source | `Get-FileHash .\diskmap.exe -Algorithm SHA256` sur l'artefact **non signé** | identique à la release GitHub et au `diskmap.sha256` de l'artifact | _à remplir_ |
| A3 | Scan réel | lancer sur un volume de travail, attendre la fin | scan terminé, totals cohérents, droits/refus listés plutôt que tus | _à remplir_ |
| A4 | Recherche et tri | mêmes critères via `/api/tree` et `/api/search` | ordre identique, troncature annoncée si `exact=false` | _à remplir_ |
| A5 | Arrêt en cours | demander l'arrêt pendant un scan | 409 puis arrêt propre, aucun `scan_running` résiduel | _à remplir_ |
| A6 | Aperçu de suppression | `mode=dry` avec `gen` courante | chemins figés, éléments protégés marqués `blocked`, jeton à usage unique | _à remplir_ |
| A7 | Corbeille | supprimer un fichier créé pour l'essai | `$I` présent, journal écrit, réversibilité constatée | _à remplir_ |
| A8 | Définitif | tenter sans `EFFACER`, puis avec | refus puis succès, journal distinguant les deux lots | _à remplir_ |
| A9 | Dossiers à nommer | lot touchant `.git` ou `Documents` | refus tant que le nom n'est pas saisi | _à remplir_ |
| A10 | Gardes HTTP | sondes `host`, `corps`, `entrees` | vertes en CI sur le commit fusionné | _à remplir_ |
| A11 | Signature de test | `Get-AuthenticodeSignature .\diskmap.exe` sur le binaire **signé pour test** | `Status = Valid`, chaîne de certificat SignPath reconnue sur la machine de test | _à remplir_ |
| A12 | Hash signé | `Get-FileHash` sur le binaire signé pour test | consigné comme **nouveau** hash, distinct de A2 | _à remplir_ |
| A13 | Comportement signé | rejouer A1, A3, A6, A7 avec le binaire signé pour test | mêmes résultats qu'en non signé | _à remplir_ |
| A14 | Décision | Ro lit les preuves A1–A13 et statue | `APPROUVÉ` ou `REFUSÉ`, daté et signé | _à remplir_ |

Aucune suppression réelle ne doit être faite sur un disque contenant des données. Les essais A7–A9 se font sur un volume jetable (`tests/sondes/creer-volume-test.ps1`) ou sur les artefacts créés par la sonde elle-même.

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
