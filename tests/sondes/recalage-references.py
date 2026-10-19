"""Recaler les références de la doc sur le VRAI numéro de ligne du symbole annoncé.

La règle du dépôt : jamais par offset, par RECHERCHE DU SYMBOLE. On lit le
tableau ATTENDU de verifier-references.mjs, on cherche le fragment annoncé dans
le fichier visé, et on renumérote — dans les DEUX documents et dans le tableau
lui-même, puisque c'est lui la source de vérité. On répète jusqu'à stabilité,
parce qu'une référence corrigée peut en déplacer une autre.

Le script refuse d'écrire tant que le tableau n'est pas sans ambiguïté :

  - clé dupliquée dans un même bloc : JavaScript ne garde que la DERNIÈRE
    valeur, donc les autres affirmations ne sont jamais vérifiées ;
  - fragment absent du fichier visé, ou présent à plusieurs endroits sans que
    la ligne déclarée en fasse partie ;
  - une même citation qui désignerait deux numéros différents (la doc cite
    `src/main.rs:643` pour deux symboles) : rien ne dit laquelle des deux
    citations est visée, le script ne devine pas.

Codes de sortie :
  0  stable (rien à recaler, ou recalé jusqu'à stabilité)
  1  problème à traiter à la main, ou pas de stabilité après MAX_TOURS
  2  clé dupliquée
Dans les cas 1 et 2, aucun fichier n'est modifié au tour où le problème est vu.
"""
import collections
import io
import os
import re
import sys

ICI = os.path.dirname(os.path.abspath(__file__))
DEPOT = os.path.abspath(os.path.join(ICI, '..', '..'))
TABLE = os.path.join(ICI, 'verifier-references.mjs')
DOCS = [os.path.join(DEPOT, d) for d in ('SECURITY.md', 'README.md')]
MAX_TOURS = 6

# Même motif que verifier-references.mjs pour une référence citée dans la doc.
CITATION = re.compile(
    r'([A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*\.(?:rs|mjs|html|py|ps1|bat|toml|json|yml))'
    r':((?:\d+)(?:[,-]\d+)*)')
BLOC = re.compile(r"^  '([^']+)': \{\s*$")
FIN_BLOC = re.compile(r'^  \},?\s*$')
CLE = re.compile(r"^\s+'([^']*:\d+)':")
ENTREE = re.compile(r"^\s+'([^']*:\d+)':\s*('.*'|\".*\"),\s*$")


def lire(p):
    # newline='' : on relit et on réécrit les octets tels quels (CRLF compris).
    with io.open(p, encoding='utf-8', newline='') as f:
        return f.read()


def ecrire(p, texte):
    with io.open(p, 'w', encoding='utf-8', newline='') as f:
        f.write(texte)


def tableau(src):
    """Retourne (entrees, illisibles). Entrée : (bloc, référence, fragment, ligne)."""
    entrees, illisibles, bloc = [], [], None
    for n, ligne in enumerate(src.split('\n'), 1):
        m = BLOC.match(ligne)
        if m:
            bloc = m.group(1)
            continue
        if FIN_BLOC.match(ligne):
            bloc = None
            continue
        if bloc is None or not CLE.match(ligne):
            continue
        m = ENTREE.match(ligne)
        if m:
            frag = m.group(2)[1:-1].replace("\\'", "'").replace('\\\\', '\\')
            entrees.append((bloc, m.group(1), frag, n))
        else:
            illisibles.append(n)
    return entrees, illisibles


def doublons(entrees):
    """{(bloc, référence): [lignes]} pour chaque clé déclarée plus d'une fois."""
    vus = collections.defaultdict(list)
    for bloc, ref, _frag, n in entrees:
        vus[(bloc, ref)].append(n)
    return {cle: lignes for cle, lignes in vus.items() if len(lignes) > 1}


def lignes_de(fichier, frag):
    """Numéros (1-based) des lignes du fichier qui contiennent le fragment ; None si fichier absent."""
    chemin = os.path.join(DEPOT, fichier)
    if not os.path.isfile(chemin):
        return None
    return [i + 1 for i, l in enumerate(lire(chemin).split('\n')) if frag in l]


def renumeroter(texte, carte):
    """Remplace chaque numéro cité `fichier:n` (listes `n,m` et plages `n-m` comprises).

    Une seule passe : une renumérotation ne peut pas en enchaîner une autre.
    Retourne (texte, nombre de citations changées).
    """
    compte = [0]

    def sub(m):
        fichier = m.group(1)
        morceaux = []
        for t in re.split(r'([,-])', m.group(2)):
            if t.isdigit():
                neuf = carte.get((fichier, int(t)), int(t))
                if neuf != int(t):
                    compte[0] += 1
                morceaux.append(str(neuf))
            else:
                morceaux.append(t)
        return '%s:%s' % (fichier, ''.join(morceaux))

    return CITATION.sub(sub, texte), compte[0]


def renumeroter_tableau(src, carte):
    """Renumérote la CLÉ de chaque entrée du tableau, jamais le fragment."""
    sortie = []
    for ligne in src.split('\n'):
        m = CLE.match(ligne)
        if m:
            cle = m.group(1)
            neuve, _ = renumeroter(cle, carte)
            ligne = ligne.replace("'%s':" % cle, "'%s':" % neuve, 1)
        sortie.append(ligne)
    return '\n'.join(sortie)


def analyser(entrees):
    """Retourne (carte, problemes). carte : {(fichier, ancien) -> nouveau} à appliquer."""
    problemes = []
    # (fichier, numéro cité) -> [(bloc, fragment, numéro où il doit aller)]
    destins = collections.defaultdict(list)
    for bloc, ref, frag, _n in entrees:
        fichier, num = ref.rsplit(':', 1)
        num = int(num)
        lignes = lignes_de(fichier, frag)
        if lignes is None:
            problemes.append("%s · %s : fichier « %s » introuvable" % (bloc, ref, fichier))
        elif num in lignes:
            destins[(fichier, num)].append((bloc, frag, num))
        elif not lignes:
            problemes.append("%s · %s : « %s » n'existe plus dans %s" % (bloc, ref, frag, fichier))
        elif len(lignes) > 1:
            problemes.append("%s · %s : « %s » apparaît en lignes %s — ambigu, à départager à la main"
                             % (bloc, ref, frag, lignes))
        else:
            destins[(fichier, num)].append((bloc, frag, lignes[0]))

    carte = {}
    for (fichier, ancien), occ in destins.items():
        cibles = {d for _b, _f, d in occ}
        if len(cibles) > 1:
            detail = ', '.join("« %s » -> %d" % (f, d) for _b, f, d in occ)
            problemes.append("%s:%d désigne plusieurs symboles (%s) — la doc cite le même numéro "
                             "pour des choses différentes ; corriger la citation à la main"
                             % (fichier, ancien, detail))
        elif cibles != {ancien}:
            carte[(fichier, ancien)] = cibles.pop()
    return carte, problemes


def main():
    nom_table = os.path.basename(TABLE)
    for tour in range(1, MAX_TOURS + 1):
        src = lire(TABLE)
        entrees, illisibles = tableau(src)
        if illisibles:
            for n in illisibles:
                print('ILLISIBLE : %s:%d ressemble à une entrée mais ne se lit pas' % (nom_table, n))
            return 1
        dups = doublons(entrees)
        if dups:
            for (bloc, ref), lignes in sorted(dups.items()):
                print('DOUBLON : %s · %s est déclaré %d fois (lignes %s)'
                      % (bloc, ref, len(lignes), ', '.join(map(str, lignes))))
            print("Aucun fichier modifié. JavaScript garde la dernière valeur d'une clé répétée : "
                  "les autres affirmations ne sont jamais vérifiées. Corriger la référence à la main.")
            return 2
        carte, problemes = analyser(entrees)
        if problemes:
            for p in problemes:
                print('PROBLEME : ' + p)
            print('Aucun fichier modifié tant que ces problèmes ne sont pas réglés.')
            return 1
        if not carte:
            print('tour %d : rien à recaler — tableau et documentation stables' % tour)
            return 0

        nouveau_src = renumeroter_tableau(src, carte)
        cit = 0
        textes = {}
        for chemin in DOCS:
            texte = lire(chemin)
            neuf, n = renumeroter(texte, carte)
            cit += n
            textes[chemin] = (texte, neuf)
        for chemin, (texte, neuf) in textes.items():
            if neuf != texte:
                ecrire(chemin, neuf)
        if nouveau_src != src:
            ecrire(TABLE, nouveau_src)
        print('tour %d : %d renumérotation(s) dans le tableau, %d citation(s) recalée(s) dans la doc'
              % (tour, len(carte), cit))
    print('pas de stabilité après %d tours' % MAX_TOURS)
    return 1


sys.exit(main())
