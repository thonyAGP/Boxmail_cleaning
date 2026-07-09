@echo off
rem =====================================================================
rem  Boxmail / Mail Assistant - lanceur Windows (double-clic)
rem  1) Recupere les mises a jour   2) Installe/compile   3) Demarre
rem  Si le serveur s'arrete (ex. mise a jour depuis l'interface),
rem  il est relance automatiquement sur le nouveau code.
rem =====================================================================
cd /d %~dp0
title Mail Assistant - serveur

echo.
echo [Mail Assistant] Mise a jour du code...
git pull --ff-only

echo.
echo [Mail Assistant] Dependances et base de donnees...
call npm install --no-audit --no-fund
call npm run db:setup

:loop
echo.
echo [Mail Assistant] Compilation...
call npm run build

echo.
echo [Mail Assistant] Demarrage : http://localhost:8787/admin
echo (Laisser cette fenetre ouverte. Ctrl+C pour arreter.)
node dist/index.js

echo.
echo [Mail Assistant] Serveur arrete - redemarrage dans 3 secondes...
timeout /t 3 /nobreak >nul
git pull --ff-only
call npm install --no-audit --no-fund
call npm run db:setup
goto loop
