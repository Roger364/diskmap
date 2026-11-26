# Registre d'audits — <projet>

> Modèle. Copier dans `scratchpad/AUDITS.md`. Une ligne par audit, jamais réécrite ;
> le rapport détaillé vit à côté.

Un verdict est lié à un **hash d'arbre**. Tout commit postérieur le rend `stale` : on ne
cite plus un verdict périmé comme s'il couvrait le code courant.

## Audits

| Date | Auditeur | Plage @ arbre | Verdict | S1 | S2 | S3 | Rapport |
|---|---|---|---|---|---|---|---|
| `<AAAA-MM-JJ>` | `<nom/modèle>` | `<base>..<head>` @ `<tree>` | `<accepté / réserves / refusé / none>` | 0 | 0 | 0 | `<fichier>` |

## Couverture

| Invariant / zone | Dernier audit @ arbre | État |
|---|---|---|
| `<invariant 1>` | `—` | `non couvert` |
| `<invariant 2>` | `—` | `non couvert` |

## Règles

- Un rapport par audit, immuable ; le registre pointe dessus.
- `audit: none` est une **ligne**, pas un vide : l'absence d'audit se lit.
- `stale` dès qu'un commit change l'arbre audité — on relance le paquet concerné.
- Un chiffre non reproduit par une commande reste « contesté », jamais « vérifié ».
- Un auditeur ne rejoue pas les gates couverts par la CI (amendement v6.3).

<!-- Modèle de registre — copié depuis .hermes/handoff/AUDITS-TEMPLATE.md -->
