# Neutralise les fenetres Explorateur qu'une sonde ouvre.
#
# Pourquoi ce fichier existe : la sonde d'interface prouve que `/api/reveal`
# ACCEPTE un chemin de la liste des illisibles. Pour le prouver, elle doit
# vraiment l'appeler — et le serveur ouvre alors l'Explorateur, comme il le doit
# pour un vrai clic. Le 27/09/2026, cette preuve laissait une fenetre « Bureau »
# a l'ecran par run, et 33 s'y sont accumulees. Une sonde qui salit le bureau de
# celui qui la lance n'est pas une sonde : elle est une intrusion.
#
# Le principe : on ne ferme que ce qu on a SOIT fait naitre. Un instantane des
# fenetres deja ouvertes est pris au demarrage, et seuls les descripteurs
# ABSENTS de cet instantane sont concernes. Une fenetre que l'utilisateur
# ouvre lui-meme pendant la surveillance n'est jamais touchee.
#
# On minimise AVANT de fermer, et immediatement des la creation. L'ordre n'est pas
# decoratif : une fenetre fermee directement peut laisser un clignotement, alors
# que minimisee puis fermee elle n'a jamais vole le focus. Et le guetteur tourne
# DEJA quand la sonde appelle la route — c'est ce qui rend la minimisation
# immediate au lieu d'une reaction.
#
# -DureeMs est un bail : on ne surveille que la fenetre de temps ou l'ouverture
# est annoncee. Passe ce delai, le guetteur rend la main et ne peut plus fermer
# une fenetre que l'utilisateur aurait ouverte apres coup.

param(
  [int]$DureeMs = 8000,
  [int]$DelaiCloseMs = 350
)

$ErrorActionPreference = 'Stop'

$code = @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class Fenetre {
  public IntPtr H;
  public string Titre;
  public string Classe;
}

public class Bureau {
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc f, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr SendMessageTimeoutW(IntPtr h, uint msg, IntPtr w, IntPtr l, uint flags, uint delai, out IntPtr rep);

  const uint WM_CLOSE = 0x0010;
  const int SW_MINIMIZE = 6;
  const uint SMTO_ABORTIFHUNG = 0x0002;

  delegate bool EnumWindowsProc(IntPtr h, IntPtr l);

  public static List<Fenetre> Explorateur() {
    var liste = new List<Fenetre>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var c = new StringBuilder(256);
      GetClassNameW(h, c, 256);
      if (c.ToString() != "CabinetWClass") return true;
      var t = new StringBuilder(512);
      GetWindowTextW(h, t, 512);
      liste.Add(new Fenetre { H = h, Titre = t.ToString(), Classe = c.ToString() });
      return true;
    }, IntPtr.Zero);
    return liste;
  }

  public static void Minimiser(IntPtr h) { ShowWindow(h, SW_MINIMIZE); }

  public static bool Fermer(IntPtr h) {
    // SendMessageTimeout plutot que PostMessage : on veut savoir si la fenetre a
    // recu l'ordre, pas seulement qu'on l'a poste. Un « non » se compte et se dit.
    IntPtr rep;
    return SendMessageTimeoutW(h, WM_CLOSE, IntPtr.Zero, IntPtr.Zero,
                               SMTO_ABORTIFHUNG, 1000, out rep) != IntPtr.Zero;
  }
}
'@

Add-Type -TypeDefinition $code -Language CSharp

# --- l'instantane ----------------------------------------------------------
$avant = New-Object 'System.Collections.Generic.HashSet[System.IntPtr]'
foreach ($f in [Bureau]::Explorateur()) { [void]$avant.Add($f.H) }

$neutralisees = New-Object System.Collections.ArrayList
$fermees = New-Object System.Collections.ArrayList
$echecs = New-Object System.Collections.ArrayList
$fin = [DateTime]::UtcNow.AddMilliseconds($DureeMs)
$premierTour = $true

while ([DateTime]::UtcNow -lt $fin) {
  Start-Sleep -Milliseconds 120

  foreach ($f in [Bureau]::Explorateur()) {
    if ($avant.Contains($f.H)) { continue }   # deja ouverte avant nous : pas nous
    [void]$avant.Add($f.H)                   # une seule fois par fenetre
    if ($premierTour) { $premierTour = $false }

    [Bureau]::Minimiser($f.H)
    [void]$neutralisees.Add($f.Titre)

    # On laisse le temps a Explorer d'ouvrir ses onglets avant de refermer :
    # fermer au milieu de l'ouverture laisse parfois un etat incoherent.
    Start-Sleep -Milliseconds $DelaiCloseMs
    if ([Bureau]::Fermer($f.H)) {
      [void]$fermees.Add($f.Titre)
    } else {
      [void]$echecs.Add($f.Titre)
    }
  }
}

# --- le compte rendu, sur une seule ligne lisible par la sonde --------------
$neutraliseesCount = $neutralisees.Count
$fermeesCount = $fermees.Count
$echecsCount = $echecs.Count
$liste = ($neutralisees | ForEach-Object { "'" + ($_ -replace "'", "''") + "'" }) -join ','
Write-Host ("FENETRES neutralisees={0} fermees={1} echecs={2} titres=[{3}]" -f `
  $neutraliseesCount, $fermeesCount, $echecsCount, $liste)
