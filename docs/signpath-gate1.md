# Porte 1 — dossier d'acceptation diskmap avant SignPath

**Statut : PARTIEL au 2026-11-21.** A1, A2 et A10 sont prouvés (section « Preuves du 21/11/2026 »). A3–A9 restent à exécuter sur un volume jetable ; A11–A13 attendent un compte SignPath ; A14 appartient à Ro. Tant que ces cases sont vides, l'application n'est ni testée ni approuvée au sens du plan SignPath.

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
| A1 | Provenance | `diskmap.exe --version` | commit de la release, `arbre propre`, `github-actions`, date = date du commit | v0.1.100 : `diskmap 0.1.0 — 78d0f63a9d71` ; `78d0f63a9d71 · arbre propre · construit par github-actions le 2026-11-18 00:40:49 UTC` ; asset téléchargé le 21/11/2026. |
| A2 | Hash source | `Get-FileHash .\diskmap.exe -Algorithm SHA256` sur l'artefact **non signé** | identique à la release GitHub et au `diskmap.sha256` de l'artifact | asset, binaire de l'artifact et `diskmap.sha256` : `4084FB192459E5D412F5C6E732032CCD8AA8535BC5066B1EFCA798436CBB94E1` (les trois recalculés). |
| A3 | Scan réel | lancer sur un volume de travail, attendre la fin | scan terminé, totals cohérents, droits/refus listés plutôt que tus | _à remplir_ |
| A4 | Recherche et tri | mêmes critères via `/api/tree` et `/api/search` | ordre identique, troncature annoncée si `exact=false` | _à remplir_ |
| A5 | Arrêt en cours | demander l'arrêt pendant un scan | 409 puis arrêt propre, aucun `scan_running` résiduel | _à remplir_ |
| A6 | Aperçu de suppression | `mode=dry` avec `gen` courante | chemins figés, éléments protégés marqués `blocked`, jeton à usage unique | _à remplir_ |
| A7 | Corbeille | supprimer un fichier créé pour l'essai | `$I` présent, journal écrit, réversibilité constatée | _à remplir_ |
| A8 | Définitif | tenter sans `EFFACER`, puis avec | refus puis succès, journal distinguant les deux lots | _à remplir_ |
| A9 | Dossiers à nommer | lot touchant `.git` ou `Documents` | refus tant que le nom n'est pas saisi | _à remplir_ |
| A10 | Gardes HTTP | sondes `host`, `corps`, `entrees` | vertes en CI sur le commit fusionné | run [44209801027](https://github.com/Roger364/diskmap/actions/runs/44209801027), commit 78d0f63 : build/windows/sondes/release = success ; `host 34/34`, `corps 4/4`, `entrees 12/12`, `25/25 sondes vertes`. Réserve : la sonde `host` déclare la garde 403 non exercée (le parseur Node répond 400 avant). |
| A11 | Signature de test | `Get-AuthenticodeSignature .\diskmap.exe` sur le binaire **signé pour test** | `Status = Valid`, chaîne de certificat SignPath reconnue sur la machine de test | _à remplir_ |
| A12 | Hash signé | `Get-FileHash` sur le binaire signé pour test | consigné comme **nouveau** hash, distinct de A2 | _à remplir_ |
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

**Reste à faire, dans cet ordre :** A3–A9 sur un VHD jetable
(`tests/sondes/creer-volume-test.ps1`, élévation requise) ; puis A11–A13 après
une requête SignPath `test-signing` ; puis A14, décision de Ro. A10 est verte
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
