# Brief d'audit — <sujet>

> Modèle. Copier dans `scratchpad/BRIEF.md`, remplir les `<…>`, laisser le reste.
> Un auditeur qui n'a que ce fichier et le dépôt doit pouvoir travailler.

**Plage :** `<base>..<head>` — N commits, F fichiers, +X / −Y
**HEAD :** `<sha>` · arbre `<tree>` (disque = commit)
**Contrat :** `<chemin de la spec>` — sections utiles
**Capacités requises :** lecture de fichiers. Optionnel : `cargo`, `node` (voir §Commandes).
**Mode :** lecture seule. Aucun commit, push, dépendance ni reformatage.

## Ordre demandé

1. **Audit libre orienté risques** : `<sécurité, concurrence, logique Win32, UX/XSS…>`.
2. **Puis** recoupement avec les invariants. Un désaccord argumenté vaut mieux qu'un
   « OK » global ; les invariants sont une couverture, pas un plafond.

## Invariants à casser

1. `<invariant 1>`
2. `<invariant 2>`
3. `<invariant 3>`
4. `<invariant 4>`
5. `<invariant 5>`

## Zones de risque (angles morts assumés)

- `<zone 1 : ce qu'on n'a pas testé et pourquoi c'est risqué>`
- `<zone 2>`
- `<zone 3>`

## Déjà vert — ne pas rejouer

`<ce que la CI couvre, hash d'arbre ou date du run>`. Ne rejoue un gate que si tu
contestes un chiffre ; les mesures manuelles ne sont pas rejouables telles quelles,
dérive-les du code ou d'une fixture.

## Ne pas citer (réfuté)

- `<chiffre ou affirmation réfutée — raison>`

## Livrable

Verdict global ; défauts **S1/S2/S3** avec `fichier:ligne`, reproduction minimale et
diff proposé **non appliqué** ; section « non vérifié » explicite.

Rapport : `scratchpad/AUDIT-<AAAA-MM-JJ>-<auditeur>.md`
Registre : ajouter une ligne dans `scratchpad/AUDITS.md` (voir le modèle).

<!-- Modèle de brief — copié depuis .hermes/handoff/BRIEF-TEMPLATE.md -->
