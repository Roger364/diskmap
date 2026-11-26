# Spécification technique — « Doublons Smart » pour DiskMap

Ce document est la référence d'implémentation pour améliorer la détection et la gestion des doublons dans DiskMap (`src/doublons.rs`, `src/main.rs`, `src/win32.rs`, `ui/index.html`).

---

## 0. Règles d'or et invariants du dépôt (NE PAS CASSER)

1. **Architecture légère** : 1 binaire Rust + UI statique embarquée (`ui/index.html` via `include_str!`). Ne pas ajouter de framework JS ni de dépendance npm côté runtime. Côté Rust, réutiliser les crates déjà présentes dans `Cargo.toml` (`rayon`, `serde`, `serde_json`, `sha2`).
2. **Rétrocompatibilité API `/api/duplicates`** :
   - Conserver les paramètres query existants : `drive`, `min`, `max`, `budget`, `limit`, `base`, `sort`, `order`.
   - Conserver **tous** les champs JSON existants à la racine : `rows`, `groupes`, `groupes_total`, `fichiers`, `fichiers_total`, `gain`, `gain_total`, `truncated`, `exact`, `budget`, `octets_lus`, `modifies`, `illisibles`, `gen`.
   - Dans chaque objet de `rows` (`DupRow`), conserver `#[serde(flatten)] row: Row`, `groupe: u32`, `empreinte: String`. Les nouveaux champs sont **additifs**.
3. **Sécurité de suppression & CSRF** :
   - Ne jamais contourner `openDelete()`, `/api/delete` (`mode: 'dry'` puis exécution avec `gen` et `sel`), ni `blocked_reason()`.
   - Toute nouvelle route mutante ou déclenchant une action (`POST`) doit passer par la vérification `X-Diskmap` déjà en place dans `src/main.rs` (côté client, toujours utiliser `api(...)` ou passer `headers: ENTETE_ACTION`).
   - Ne jamais remplacer `requete` (jeton anti-réponses croisées dans `ui/index.html`) : toute réponse asynchrone périmée doit être ignorée si `mien !== requete`.
4. **Contrôles obligatoires du dépôt** :
   - `cargo fmt -- --check` et `cargo test` après toute modification Rust.
   - `node tests/sondes/verifier-page.mjs` après toute modification de `ui/index.html`.
   - `node tests/sondes/verifier-references.mjs` (si des numéros de lignes cités dans `README.md` / `SECURITY.md` se décalent, exécuter `python tests/sondes/recalage-references.py`).
   - **Attention à `node tests/sondes/verifier-libelles.mjs`** : ce script extrait toutes les erreurs HTTP `(400|403|404|409|503)` de `src/main.rs` et échoue si une nouvelle garde n'est pas citée dans une sonde de `tests/sondes/`. Si vous ajoutez un `Err(("400 Bad Request", ...))`, ajoutez une sonde correspondante dans `tests/sondes/` et vérifiez `node tests/sondes/verifier-libelles.mjs`.

---

## 1. Lot 1 — Moteur Rust rapide & Smart (`src/doublons.rs`, `src/main.rs`)

### 1.1 Pré-empreinte Tête + Queue (Head + Tail)
Dans `src/doublons.rs` :
- `PREFIXE: u64 = 64 * 1024` (64 Kio).
- Si `taille <= 2 * PREFIXE` (≤ 128 Kio) : hacher tout le fichier en une seule passe.
- Si `taille > 2 * PREFIXE` :
  1. Calculer d'abord la **pré-empreinte Tête + Queue** : SHA-256 des `64 Kio` de début + `seek(SeekFrom::End(-(PREFIXE as i64)))` + SHA-256 des `64 Kio` de fin (en incluant la taille dans le hasher). Cela élimine immédiatement les vidéos, ISO et archives qui partagent un en-tête identique.
  2. Ne calculer le SHA-256 **complet** que pour les fichiers ayant au moins un jumeau de même pré-empreinte.
- Conserver l'accounting strict du `budget` : toute lecture (tête, queue, complet) décrémente le budget restant via un `AtomicU64` (`fetch_sub` sécurisé / `compare_exchange` pour ne jamais dépasser le budget). Si le budget est insuffisant pour un candidat, marquer `res.exact = false`.

### 1.2 Parallélisme borné (`rayon`) + Annulation
- Utiliser `rayon` (déjà dans `Cargo.toml`) avec un pool local borné (ex. `rayon::ThreadPoolBuilder::new().num_threads(4).build()`) pour hacher les groupes candidats en parallèle sans saturer les disques mécaniques.
- Stocker le `Arc<AtomicBool>` d'annulation active dans `App` (ex. `dup_cancel: Mutex<Option<Arc<AtomicBool>>>`) afin qu'une route `POST /api/duplicates/cancel` puisse positionner `stopping.store(true, Ordering::Relaxed)` proprement.
- Le drapeau `app.dup` continue de garantir qu'une seule détection tourne à la fois.

### 1.3 Cache d'empreintes en mémoire
- Ajouter dans `App` un cache protégé par `Mutex` indexé par `(char /* drive */, u64 /* snap.gen */)` :
  - Si `(drive, snap.gen)` change, vider l'ancien cache du volume.
  - Clé d'entrée : `u32` (`file_idx`) ou `(u32, u64 /* size */, i64 /* mtime */)`.
  - Valeur : `prehash: Option<[u8; 32]>`, `fullhash: Option<[u8; 32]>`, `file_id: Option<(u32, u64)>`.
  - Plafonner le cache (ex. 200 000 entrées) pour borner la RAM.
  - Avant de lire un fichier sur disque, vérifier le cache ; ainsi, changer de filtre (`min`, `category`, `base`) ou de tri dans l'UI réutilise les empreintes déjà calculées sans relire le disque.

### 1.4 Heuristique « Smart Score » et désignation d'original
Implémenter une fonction pure et déterministe `score_smart(path: &str, mtime: i64, oldest_mtime: i64) -> i32` dans `src/doublons.rs` (facile à tester unitairement) :
- **Pénalités de dossier « vrac / temporaire »** (insensible à la casse sur les segments de chemin) :
  - `-40` : `\downloads\`, `\téléchargements\`, `\temp\`, `\tmp\`, `\$recycle.bin\`
  - `-25` : `\desktop\`, `\bureau\`, `\whatsapp`, `\telegram`, `\cache\`
  - `-15` : `\backup`, `\sauvegarde`, `\copie`, `\copy`, `\old`
- **Pénalités de nom de fichier dupliqué** :
  - `-30` : suffixe avant extension de type ` (1)`, ` (2)`, ` - copie`, ` - copy`, `_copy`, `_backup`
- **Bonus / malus structurel** :
  - `-1` par niveau de profondeur supplémentaire (préférer un chemin court/propre à égalité)
  - `+15` si c'est le fichier le **plus ancien** du groupe (`mtime == oldest_mtime` et `mtime > 0`)
- **Règle d'élection** : dans chaque groupe, le fichier ayant le **meilleur score** (départagé par `mtime` croissant, puis `path.len()` croissant, puis `path` lexicographique) reçoit `garder_recommande = true` (**exactement 1 par groupe**).

### 1.5 Tri par groupe (correction du bug actuel)
Dans `src/main.rs` (`duplicates`), **ne plus** aplatir et trier toutes les lignes avec `trier_lignes` (qui mélange les groupes `#1`, `#2`, etc.) :
- Trier **les groupes entre eux** selon `sort` et `order` :
  - `gain` (défaut) : gain récupérable du groupe (`taille * (copies_physiques - 1)`)
  - `size` : taille unitaire du fichier
  - `mtime` : date la plus récente (ou plus ancienne) du groupe
  - `count` : nombre de copies dans le groupe
  - `name` : nom du fichier de référence du groupe
- À l'intérieur de chaque groupe, ordonner les fichiers : l'original recommandé (`garder_recommande: true`) en premier, puis par chemin croissant.
- Conserver la coupe aux frontières de groupe selon `limit` (ne jamais couper un groupe en deux).

### 1.6 Enrichissement de `DupRow` et filtres serveur
Ajouter dans `DupRow` :
- `groupe_gain: u64`
- `groupe_count: usize`
- `smart_score: i32`
- `garder_recommande: bool`
- `categorie: &'static str` (`"video"`, `"image"`, `"archive"`, `"audio"`, `"doc"`, `"autre"` selon l'extension)
- `hardlink: bool` (`false` en Lot 1, renseigné en Lot 3)

Ajouter le paramètre optionnel `category` sur `/api/duplicates` (`all`, `video`, `image`, `archive`, `audio`, `doc`) filtrant les candidats avant le hachage.

---

## 2. Lot 2 — Interface « Doublons Smart » (`ui/index.html`)

### 2.1 Barre de contrôle dédiée au mode `dup`
Quand `cur.mode === 'dup'`, afficher juste au-dessus du tableau un panneau compact (`.dup-bar`, respectant les variables CSS `--panel`, `--panel2`, `--line`, `--accent`, `--hot`, `--warm`, `--cool`) contenant :
1. **Synthèse temps réel** :
   - `X groupes · Y Go récupérables`
   - `Sélectionné : N fichiers (Z Go à libérer)` — recalculé immédiatement à chaque case cochée/décochée.
2. **Filtres rapides** (chaque changement relance `duplicates()` avec le jeton `requete`) :
   - Portée : `Tout le disque` vs `Dossier courant` (`dupScope: 'drive' | 'base'`)
   - Taille min : `100 Ko` (`102400`), `1 Mo` (`1048576`, défaut), `10 Mo` (`10485760`), `100 Mo` (`104857600`)
   - Catégorie : `Tout`, `Vidéos`, `Images`, `Archives & ISO`, `Audio`, `Documents`
   - Budget lecture : `500 Mo`, `2 Go` (défaut), `8 Go`
3. **Sélection intelligente (« Smart Select »)** :
   - Boutons/menu :
     - `✨ Smart (recommandé)` : pour chaque groupe, décoche l'élément `garder_recommande === true` et coche les autres.
     - `Garder plus ancien` : garde le `mtime` min de chaque groupe, coche les autres.
     - `Garder plus récent` : garde le `mtime` max de chaque groupe, coche les autres.
     - `Garder chemin le plus court` : garde `path.length` min, coche les autres.
     - `Protéger un dossier…` : ouvre un petit prompt/champ (pré-rempli avec `cur.chemin` si disponible) ; pour tout groupe ayant au moins 1 copie dans ce dossier, décoche les copies dans ce dossier et coche celles à l'extérieur (si aucune copie n'est dans ce dossier, ne touche pas au groupe).
     - `Tout décocher`.
4. **État d'analyse & Annulation** :
   - Pendant l'attente de `/api/duplicates`, afficher un bandeau sobre avec bouton `Annuler` appelant `POST /api/duplicates/cancel` (avec `ENTETE_ACTION`).

### 2.2 Rendu par groupes visuels & Garde-fou « dernier survivant »
- **En-tête de groupe (`tr.dup-grp-hdr`)** avant les lignes de chaque groupe :
  - Affiche `#groupe`, taille unitaire (`hsize`), nombre de copies, **gain récupérable** (`+hsize(groupe_gain)`), bouton discret `Replier/Déplier`, et action rapide `Smart sur ce groupe` / `Ignorer (décocher)`.
- **Badges sur chaque fichier** :
  - Si `r.garder_recommande` : pill vert discrète `Original conseillé`.
  - Si `r.hardlink` : pill neutre `Lien dur (0 o libérés)` (et ne pas le compter comme gain récupérable).
- **Garde-fou anti-suppression totale d'un groupe** :
  - Les règles automatiques (`Smart Select`) garantissent qu'au moins **1 fichier reste décoché** dans chaque groupe.
  - Si l'utilisateur coche *manuellement* le dernier fichier non coché d'un groupe :
    - Colorer l'en-tête du groupe en alerte (`--hot` / `--warm`) avec un badge `⚠ Aucun exemplaire conservé dans ce groupe !`.
    - Dans `openDelete()`, si un groupe présent dans `cur.rows` a **100 % de ses copies sélectionnées**, afficher un avertissement explicite rouge en haut de la modale de confirmation listant le(s) groupe(s) concerné(s).
- **Tri compatible** : dans le sélecteur `#sort`, en mode `dup`, proposer `Gain récupérable` (`gain`), `Taille unitaire` (`size`), `Date` (`mtime`), `Nb de copies` (`count`), `Nom` (`name`).

---

## 3. Lot 3 — Fonctions avancées (Hardlinks NTFS, Dossiers jumeaux, Aperçu)

### 3.1 Détection des hardlinks NTFS (`src/win32.rs` + `src/doublons.rs`)
- Ajouter dans `src/win32.rs` une fonction sûre `file_id(path: &Path) -> Option<(u32, u64)>` via `CreateFileW` (`0` access, `FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE`, `OPEN_EXISTING`, `FILE_FLAG_BACKUP_SEMANTICS`) + `GetFileInformationByHandle` (`dwVolumeSerialNumber`, `(nFileIndexHigh << 32) | nFileIndexLow`).
- Pour chaque groupe de doublons confirmés :
  - Le premier fichier portant un `(vol, file_index)` donné a `hardlink = false`.
  - Les occurrences suivantes portant le **même** `(vol, file_index)` ont `hardlink = true`.
  - Le `groupe_gain` et `gain_total` ne comptent que `taille * (nb_physiques_distincts - 1)` (si tous les fichiers du groupe sont le même inode, `groupe_gain = 0`, et on peut soit masquer le groupe par défaut soit l'afficher avec mention `0 o libérés (liens durs)`).

### 3.2 Vue « Dossiers jumeaux »
- Côté `src/doublons.rs`, à partir des groupes de doublons trouvés, agréger les paires de dossiers parents `(dir_a, dir_b)` qui partagent plusieurs fichiers identiques :
  - Calculer `shared_files`, `shared_bytes`, et comparer au nombre total de fichiers / taille du plus petit dossier (`snap.dirs` ou comptage dans `snap.files`).
  - Retourner `folder_pairs` (top 100 trié par `shared_bytes` décroissant) avec `{ dir_a, dir_b, shared_files, shared_bytes, ratio_a, ratio_b }`.
- Côté `ui/index.html`, ajouter un onglet/toggle dans la barre doublons : `Par fichiers` | `Dossiers jumeaux` permettant d'ouvrir chacun des deux dossiers ou de sélectionner en 1 clic les fichiers dupliqués d'un dossier entier.

### 3.3 Panneau d'aperçu sécurisé (images / texte / métadonnées)
- Route optionnelle `GET /api/preview?drive=X&id=IDX&gen=GEN` :
  - **Obligatoire** : valider `gen == snap.gen` et que `id` est un index valide de `snap.files` (jamais de chemin arbitraire venu du client !).
  - Refuser les fichiers bloqués ou hors extensions sûres (`png`, `jpg`, `jpeg`, `webp`, `gif`, `txt`, `md`, `log`, `json`, `csv`).
  - Plafonner la lecture (ex. max 10 Mio pour image, max 32 Kio UTF-8 pour texte) et ajouter `X-Content-Type-Options: nosniff`.
- Côté UI, un tiroir léger à droite (fermable) affichant la vignette ou les premières lignes + chemin complet, date et taille.

---

## 4. Tests unitaires et sondes attendus

- **Tests unitaires Rust (`src/doublons.rs`)** :
  - `score_smart` privilégie un chemin propre hors `Downloads`/`Desktop`/`(1)` et plus ancien.
  - Pré-empreinte tête+queue distingue deux fichiers de même taille et même en-tête de 64 Kio mais queue différente.
  - Respect strict du `budget` (ne jamais dépasser `o.budget`, `exact == false` si atteint).
  - Tri par groupe préserve l'intégrité des groupes (aucun mélange entre groupes).
  - Déduplication hardlink ne compte pas 2× le gain (si testable sur NTFS ou via abstraction pure).
- **Vérifications CLI à lancer systématiquement** :
  - `cargo fmt -- --check`
  - `cargo test`
  - `node tests/sondes/verifier-page.mjs`
  - `node tests/sondes/verifier-references.mjs`
  - `node tests/sondes/verifier-libelles.mjs`
