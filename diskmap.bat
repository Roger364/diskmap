@echo off
REM Lance l'explorateur d'espace disque.
REM Le binaire ouvre le navigateur sur http://127.0.0.1:8756/ au démarrage.
REM Options utiles : --port 9000    --no-browser
"%~dp0target\release\diskmap.exe" %*
