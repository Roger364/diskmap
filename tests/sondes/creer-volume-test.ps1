# Volume de test des sondes diskmap.
#
# POURQUOI UN SCRIPT
# ------------------
# Les sondes qui detruisent ne peuvent tourner que sur un volume jetable. Le
# hazard le plus evident n'est pas le disque de la sonde : c'est `G:`, le volume
# de travail par defaut, sur une machine qui contient des donnees. Le 26/09/2026
# c'est exactement ce qui s'est produit — 65 fichiers reels detruits, 68 autres
# a la corbeille.
#
# Un VHD est la reponse la plus honnete : un volume a part entiere, que rien
# d'autre ne partage, et qui disparait avec le fichier. Un dossier jetable ne
# suffirait pas — l'incident venait Precisement d'un volume ou cohabitaient des
# fichiers qui n'etaient pas ceux de la sonde.
#
#   .\creer-volume-test.ps1                    cree et monte V:
#   .\creer-volume-test.ps1 -Detacher          demonte et supprime le VHD
#   .\creer-volume-test.ps1 -Lettre W -Taille 2G
#
# Le montage demande des droits d'administrateur. C'est normal et c'est le
# prix : monter un volume, c'est deja une privilege.

[CmdletBinding()]
param(
    [switch] $Detacher,
    [string] $Lettre = 'V',
    [string] $Taille = '512MB',
    [string] $Racine = '_diskmap_sondes'
)

$ErrorActionPreference = 'Stop'
$vhd = Join-Path $env:TEMP 'diskmap-sonde.vhdx'

# --------------------------------------------------------------- démontage
if ($Detacher) {
    $monte = Get-VHD -Path $vhd -ErrorAction SilentlyContinue
    if ($monte -and $monte.Attached) {
        Dismount-VHD -Path $vhd
        Write-Host "VHD demonte."
    }
    if (Test-Path $vhd) {
        Remove-Item $vhd -Force
        Write-Host "VHD supprime : $vhd"
    }
    else {
        Write-Host "Rien a demonter : $vhd n'existe pas."
    }
    return
}

# ---------------------------------------------------------------- création
# `New-VHD -SizeBytes` attend un entier. On convertit pour accepter « 512MB »
# comme « 2G » sans que l'utilisateur ait à calculer.
$octets = switch -Regex ($Taille.ToUpper()) {
    '^([0-9]+)GB?$' { [int64]$Matches[1] * 1GB; break }
    '^([0-9]+)MB?$' { [int64]$Matches[1] * 1MB; break }
    '^([0-9]+)KB?$' { [int64]$Matches[1] * 1KB; break }
    '^([0-9]+)$'    { [int64]$Matches[1]; break }
    default          { throw "Taille illisible : $Taille" }
}

if (Test-Path $vhd) {
    Write-Host "Un VHD existe deja : $vhd"
}
else {
    New-VHD -Path $vhd -SizeBytes $octets -Dynamic | Out-Null
    Write-Host "VHD cree : $vhd ($Taille, dynamique)"
}

$monte = Get-VHD -Path $vhd
if (-not $monte.Attached) {
    Mount-VHD -Path $vhd
    Write-Host "VHD monte."
}

$disque = Get-VHD -Path $vhd | Get-Disk
# `IsInitialized` ne dit pas ce qu'il semble dire sur un disque deja monte :
# le tester a fait rejouer `Initialize-Disk` sur un volume pret, qui echoue
# bruyamment alors que tout va bien. Le style de partition, lui, est l'etat
# reel : `RAW` tant qu'aucune table n'existe.
if ($disque.PartitionStyle -eq 'RAW') {
    $disque | Initialize-Disk -PartitionStyle MBR -Confirm:$false | Out-Null
    Write-Host "Disque initialise (MBR)."
    $disque = Get-VHD -Path $vhd | Get-Disk
}

$partition = $disque | Get-Partition | Where-Object { $_.DriveLetter -eq $Lettre }
if (-not $partition) {
    $partition = $disque | New-Partition -DriveLetter $Lettre -UseMaximumSize
    Write-Host "Partition creee sur ${Lettre}:."
}

$volume = $partition | Get-Volume
if ($volume.FileSystem -ne 'NTFS') {
    $partition | Format-Volume -FileSystem NTFS -NewFileSystemLabel 'SONDES' `
        -Confirm:$false -Force | Out-Null
    Write-Host "Volume formate en NTFS."
}

$cible = "${Lettre}:\$Racine"
if (-not (Test-Path $cible)) {
    New-Item -ItemType Directory -Path $cible | Out-Null
}

Get-Volume -DriveLetter $Lettre | Format-Table DriveLetter, FileSystem, Size
Write-Host ''
Write-Host "Racine de travail des sondes : $cible"
Write-Host ''
Write-Host "Lancer les sondes :"
Write-Host "  set DISKMAP_SONDE_VOLUME=$Lettre"
Write-Host "  set DISKMAP_SONDE_RACINE=$cible"
Write-Host "  node tests\sondes\lancer.mjs --volume $Lettre"
Write-Host ''
Write-Host "Nettoyer apres coup :"
Write-Host "  .\creer-volume-test.ps1 -Detacher"
