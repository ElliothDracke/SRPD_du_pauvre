@echo off
title SRPD_du_pauvre
cd /d "%~dp0"

rem Node est la SEULE chose a installer. Le dire en clair vaut mieux que de laisser passer un
rem « 'node' n'est pas reconnu en tant que commande interne » que personne ne sait traduire.
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js est requis, et il est introuvable sur cette machine.
  echo   Installe-le depuis https://nodejs.org ^(prends la version LTS^), puis relance ce fichier.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\discord-rpc" (
  echo   Premiere fois : installation des dependances...
  call npm install --no-audit --no-fund
  if not exist "node_modules\discord-rpc" (
    echo.
    echo   L'installation des dependances a echoue.
    echo   Si le message parle de CERTIFICAT, c'est un antivirus ou un reseau d'entreprise qui
    echo   inspecte le trafic. Dans ce cas :  npm config set strict-ssl false
    echo   puis relance ce fichier.
    echo.
    pause
    exit /b 1
  )
)

rem 🔗 UN .BAT NE PEUT PAS PORTER D'ICONE : Windows affiche celle du TYPE de fichier, la meme pour
rem tous. Un raccourci, si. On le cree donc ici, au premier lancement, plutot que de demander a
rem quelqu'un de lancer un script a part.
rem ⚠️ ET LE CODE EST PASSE EN LIGNE, PAS DANS UN .PS1 : un fichier de script est refuse des que la
rem strategie d'execution exige une signature — ce qui est le cas par defaut sur beaucoup de postes,
rem et sur tout fichier venant d'une archive telechargee. Le code inline n'y est pas soumis.
if not exist "SRPD_du_pauvre.lnk" (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$d = '%~dp0'.TrimEnd('\'); $s = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $d 'SRPD_du_pauvre.lnk')); $s.TargetPath = (Join-Path $d 'Lancer SRPD_du_pauvre.bat'); $s.WorkingDirectory = $d; $s.IconLocation = (Join-Path $d 'dragon.ico') + ',0'; $s.Description = 'Le rich presence de Steam, jusqu''a Discord'; $s.WindowStyle = 7; $s.Save()" >nul 2>nul
)

node pont.js
rem sortie normale = la fenetre a ete fermee : on s'en va sans rien demander.
rem On ne s'arrete QUE sur une vraie erreur, pour que le message reste lisible.
if errorlevel 1 (
  echo.
  echo   Le pont s'est arrete sur une erreur.
  pause
)
