# Registre d'audits — DiskMap

Une ligne par audit, jamais réécrite ; le rapport détaillé vit à côté.

Un verdict est lié à un **hash d'arbre**. Tout commit postérieur le rend `stale` :
on ne cite plus un verdict périmé comme s'il couvrait le code courant.

## Audits

| Date | Auditeur | Plage @ arbre | Verdict | S1 | S2 | S3 | Rapport |
|---|---|---|---|---|---|---|---|
| 2026-11-26 | CHO (opencode/deepseek-v4.1-flash-free) | 06dcbbd..eb0091d @ 211ff50a | réserves | 0 | 1 | 6 | 0132 (hermes) / 0133 (freebuff) |
| 2026-11-26 | Freebuff (static) | 06dcbbd..eb0091d @ 211ff50a | réserves | 1* | 2 | 6 | 0133-freebuff-hermes.md |
| 2026-11-26 | Hermes (self) | eb0091d..4fdcd76 @ HEAD | accepté (correctifs S1/S2 + S3 partiel) | 0 | 0 | 4 | STATE.md |
| 2026-11-27 | Hermes (libry) | 6c309ed..worktree @ 009bcf77 | réserves | 0 | 0 | 2 | AUDIT-2026-11-27-hermes.md |
| 2026-11-27 | Hermes (libry) | 6c309ed..worktree @ 1c45c1d2 | accepté | 0 | 0 | 0 | 0137-hermes-freebuff.md |

`*` conditionnel (index 0 sur SMB, non mesuré sur ce poste).

## Couverture

| Invariant / zone | Dernier audit @ arbre | État |
|---|---|---|
| total/freed par inode | 4fdcd76 | couvert (total_par_inode + tests) |
| gainSelection (mode doublons) | 4fdcd76 | couvert (inode_count) |
| file_id index 0 / non NTFS | 4fdcd76 | couvert (garde index 0) |
| confirmation mots (aperçu vs exécution) | 4fdcd76 | couvert (taille_du_lot) |
| freed partiel (lien dur) | 4fdcd76 | couvert (inode_success/total) |
| freed en mode corbeille (espace réel) | — | non couvert (question ouverte) |
| perf réseau (5000 CreateFileW) | — | non mesuré |
| Lot 4 | — | non défini dans la spec (clôture audit) |

## Règles

- Un rapport par audit, immuable ; le registre pointe dessus.
- `audit: none` est une **ligne**, pas un vide : l'absence d'audit se lit.
- `stale` dès qu'un commit change l'arbre audité — on relance le paquet concerné.
- Un chiffre non reproduit par une commande reste « contesté », jamais « vérifié ».
- Un auditeur ne rejoue pas les gates couverts par la CI (amendement v6.3).

<!-- Registre rempli le 2026-11-26 (Lot 4 = clôture audit) -->