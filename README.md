# diskmap

Explorateur d'espace disque pour Windows : pour chaque volume, le poids et la
date des dossiers **et** des fichiers, triables, avec navigation dans l'arbre et
recherche globale.

Un serveur HTTP local sert une interface unique ; le parcours des volumes est
écrit en Rust et parallélisé.

## Ce qu'on peut faire

- **Poids d'un dossier = tout son contenu**, pas seulement ses fichiers directs.
- **Dernière activité** : la date d'écriture la plus récente dans le sous-arbre.
  C'est la colonne qui sert à décider : un dossier de 100 Go plus touché depuis
  deux ans saute aux yeux.
- Tri par taille, dernière activité, nom ou nombre de fichiers.
- Recherche globale insensible à la casse sur tout le volume — « node_modules »
  remonte chaque occurrence avec son poids et son chemin.
- Vue **carte** (treemap) en plus du tableau.
- Ouverture de n'importe quelle entrée dans l'explorateur Windows.

## Pourquoi c'est rapide

Deux causes, et une seule était atteignable.

**La MFT n'est pas accessible sans élévation.** Lire la table des fichiers
directement prendrait quelques secondes, mais ouvrir un handle sur `\\.\C:`
exige les droits administrateur. Mesuré sur une session non élevée : `C:`, `D:`
et `G:` refusent l'ouverture, seul `E:` passe. La vitesse vient donc du
parallélisme : fork/join rayon, un job par sous-dossier jusqu'à 16 niveaux de
profondeur.

**L'agrégation a été sortie du parcours.** Remonter les tailles vers les parents
pendant le scan coûte un verrou par fichier et par niveau de profondeur. On ne
garde que `(parent, taille, date)`, puis on agrège après coup en deux passes
linéaires : l'identifiant d'un dossier étant attribué avant celui de ses enfants,
`parent < enfant`, et la remontée se fait en une seule boucle descendante sur les
index.

Les chemins sont en forme verbatim `\\?\C:\`, sinon la limite `MAX_PATH` de 260
caractères fait échouer les `node_modules` profonds. Jonctions et liens
symboliques ne sont pas suivis : les suivre doublerait les compteurs
(`C:\Documents and Settings` pointe vers `C:\Users`) et risquerait des cycles.

### Mesures

Sur une machine à 24 cœurs logiques, disques NVMe :

| Volume | Fichiers | Dossiers | Taille | Scan à froid |
|---|---|---|---|---|
| `C:` | 2 256 830 | 297 990 | 873 Go | **35 s** |
| `G:` | 1 086 153 | 179 309 | 438 Go | 9 s |
| `E:` | 24 350 | 1 044 | 40 Go | 0,45 s |

Soit environ 73 000 entrées/s. Le résultat est mis en cache en binaire sous
`%LOCALAPPDATA%\diskmap\` : les lancements suivants se chargent en une seconde
au lieu de re-parcourir.

Contre-épreuve utile : `DirEntry::metadata()` était soupçonné d'ouvrir un handle
par fichier. Mesuré sur `System32`, 2,15 ms contre 2,91 ms pour
`FindFirstFileW` brut. L'hypothèse était fausse, l'API standard est conservée.

## Compiler et lancer

```bat
cargo build --release
diskmap.bat
```

Le binaire ouvre `http://127.0.0.1:8756/` automatiquement. Options :
`--port 9000`, `--no-browser`.

`diskmap bench <LETTRE>` mesure le parcours d'un volume seul, sans serveur ni
interface — utile pour vérifier les performances sur une autre machine plutôt
que les supposer.

## Limites

- **Windows uniquement** : appels Win32 directs, chemins verbatim, lancement de
  l'explorateur. Aucune abstraction n'a été prévue pour POSIX.
- Sans élévation, certaines entrées restent inaccessibles (ruches du Registre,
  répertoires système protégés) : 123 sur le `C:` de référence. Elles sont
  comptées et affichées, pas masquées.
- Les caches `*.bin` contiennent l'arborescence complète des volumes analysés.
  Ils sont exclus par `.gitignore` et ne doivent jamais être versionnés.

## Licence

MIT — voir `LICENSE`.
