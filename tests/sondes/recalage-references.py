"""Recaler les references de la doc sur le VRAI numero de ligne du symbole annonce.

La regle du depot : jamais par offset, par RECHERCHE DU SYMBOLE. On lit le
tableau ATTENDU de verifier-references.mjs, on cherche le fragment annonce dans
le fichier vise, et on renumerote — dans les DEUX documents et dans le tableau
lui-meme, puisque c est lui la source de verite. On repete jusqu a stabilite,
parce qu une reference corrigee peut en deplacer une autre.
"""
import io
import os
import re
import sys

ICI = os.path.dirname(os.path.abspath(__file__))
DEPOT = os.path.abspath(os.path.join(ICI, '..', '..'))
TABLE = os.path.join(ICI, 'verifier-references.mjs')


def lire(p):
    return io.open(p, encoding='utf-8').read().split('\n')


def ecrire(p, lignes):
    io.open(p, 'w', encoding='utf-8', newline='\n').write('\n'.join(lignes))


def attendu(src):
    """{reference -> fragment} pour le tableau courant."""
    out = {}
    for ligne in src.split('\n'):
        m = re.match(r"^\s+'([^']*:\d+)':\s*('.*'|\".*\"),\s*$", ligne)
        if m:
            frag = m.group(2)[1:-1].replace("\\'", "'").replace('\\\\', '\\')
            out[m.group(1)] = frag
    return out


def main():
    tours = 0
    while True:
        tours += 1
        src = io.open(TABLE, encoding='utf-8').read()
        subs = {}
        for ref, frag in attendu(src).items():
            fichier, num = ref.rsplit(':', 1)
            if not os.path.exists(os.path.join(DEPOT, fichier)):
                continue
        # la table ne porte que des references de ce depot : on les resout une a une
        for ref, frag in attendu(src).items():
            fichier, num = ref.rsplit(':', 1)
            chemin = os.path.join(DEPOT, fichier)
            if not os.path.exists(chemin):
                continue
            cible = lire(chemin)
            trouve = [i + 1 for i, l in enumerate(cible) if frag in l]
            if len(trouve) == 1 and trouve[0] != int(num):
                subs[ref] = '%s:%d' % (fichier, trouve[0])
        deplacees = 0
        cibles = [os.path.join(DEPOT, d) for d in ('SECURITY.md', 'README.md')] + [TABLE]
        for chemin in cibles:
            lignes = lire(chemin)
            for i, l in enumerate(lignes):
                neuf = l
                for vieux, trouve in subs.items():
                    if vieux in neuf:
                        neuf = neuf.replace(vieux, trouve)
                if neuf != l:
                    lignes[i] = neuf
                    deplacees += 1
            ecrire(chemin, lignes)
        print('tour %d : %d reference(s) deplacee(s), %d recalage(s) trouve(s)'
              % (tours, deplacees, len(subs)))
        if not subs or tours > 6:
            return 0 if not subs else 1


sys.exit(main())
