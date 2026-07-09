@echo off
rem ==============================================================
rem  Mail Assistant - lanceur STABLE (ne sera plus jamais modifie,
rem  pour ne pas etre corrompu par les mises a jour en cours de route).
rem  Toute la logique vit dans scripts\supervisor.mjs.
rem ==============================================================
cd /d %~dp0
title Mail Assistant - serveur
node scripts\supervisor.mjs
echo.
echo [Mail Assistant] Superviseur arrete. Appuie sur une touche pour fermer.
pause >nul
