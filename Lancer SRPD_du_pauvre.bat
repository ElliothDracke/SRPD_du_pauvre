@echo off
title SRPD_du_pauvre
cd /d "%~dp0"

rem ATTENTION : CE FICHIER RESTE EN ASCII PUR ET EN CRLF.
rem cmd.exe le lit dans le codage OEM de la machine, pas en UTF-8 : un emoji ou une lettre accentuee
rem s'y decode en octets parasites, et une fin de ligne LF seule lui fait couper des lignes en plein
rem milieu. Les deux ensemble transforment ce fichier en suite de commandes inconnues. Mesure faite :
rem apres ajout d'un emoji en commentaire, cmd tentait d'executer 're', 'ue', 'TALLER'...

rem CE FICHIER N'INSTALLE PAS NODE, et n'installe rien en dehors de ce dossier.
rem Il verifie que Node est la, puis pose les deux dependances dans .\node_modules : rien de global,
rem rien dans Program Files, rien dans le registre. Desinstaller = supprimer le dossier.
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js est requis, et il est introuvable sur cette machine.
  echo   A INSTALLER TOI-MEME depuis https://nodejs.org ^(version LTS^) : ce fichier
  echo   n'installe rien a ta place et ne touche a rien hors de son dossier.
  echo.
  pause
  exit /b 1
)

rem LA PRESENCE NE SUFFIT PAS, LA VERSION COMPTE. Le pont appelle fetch, qui n'est global qu'a
rem partir de Node 18. Avec une version plus ancienne il demarrait, puis echouait sur un
rem "fetch is not defined" incomprehensible. On refuse avant, en le disant.
node -e "process.exit(+process.versions.node.split('.')[0] >= 18 ? 0 : 1)"
if errorlevel 1 (
  for /f "delims=" %%v in ('node -v') do set "VNODE=%%v"
  echo.
  call echo   Node %%VNODE%% est trop ancien : il en faut au moins la version 18.
  echo   Le pont utilise fetch, qui n'existe pas avant.
  echo   Mets a jour depuis https://nodejs.org ^(version LTS^), puis relance ce fichier.
  echo.
  pause
  exit /b 1
)

rem --omit=optional N'EST PAS UN DETAIL : discord-rpc traine une dependance OPTIONNELLE,
rem register-scheme, tiree de GitHub et compilee en natif. Sans compilateur C++ installe, npm
rem lance node-gyp et l'installation reste bloquee plusieurs minutes, sans message. Notre code
rem n'appelle jamais register(). Mesure : 814 ms et 1,1 Mo sans elle, contre une compilation
rem interminable avec.
if not exist "node_modules\discord-rpc" (
  echo   Premiere fois : installation de 2 dependances dans .\node_modules ^(~1 Mo^)...
  call npm install --omit=optional --no-audit --no-fund
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

rem UN .BAT NE PEUT PAS PORTER D'ICONE : Windows affiche celle du TYPE de fichier, la meme pour
rem tous. Un raccourci, si. On le cree donc ici, au premier lancement, plutot que de demander a
rem quelqu'un de lancer un script a part.
rem ET LE CODE EST PASSE EN LIGNE, PAS DANS UN .PS1 : un fichier de script est refuse des que la
rem strategie d'execution exige une signature, ce qui est le cas par defaut sur beaucoup de postes,
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
