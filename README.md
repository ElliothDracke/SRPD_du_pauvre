# SRPD_du_pauvre

Ptite app pour récupérer le rich presence de Steam pour didi !

A small script that display Steam's rich presence inside discord's activity module !

## Requirements : 

- Latest Node.js version 18 or later. ([nodejs.org](https://nodejs.org), version LTS).

-----------------------------------

| source | What discord normally shows |
|---|---|
| API web Steam (`GetPlayerSummaries`) | `gameextrainfo` et `gameid`. **C'est tout.** |
| page de profil publique | « Currently In-Game: Stellaris ». Rien de plus. |
| SDK Steamworks (`GetFriendRichPresence`) | réservé aux amis **dans le même jeu** — une appli tierce ne peut pas se faire passer pour le jeu |
| **client Steam** | ✅ la ligne complète, déjà composée et traduite |

Le client Steam est une application web. On s'y branche par le protocole DevTools — mais on ne
**gratte pas son interface** pour autant : on lit sa *donnée*, dans
`friendStore.m_FriendsUIFriendStore.m_self`. 
Conséquence : rien ne casse si Steam refait son
interface, et la liste d'amis n'a même pas besoin d'être ouverte.

## Installation

- Double-clic on **`Lancer SRPD_du_pauvre.bat`**. - It will detect if your node.js is up to date, install dependencies and open its own GUI window.

## Utilisation

1. Open Steam.
2. Clic on **⟳ relancer Steam**. It will close/reopen with the option `-cef-enable-debugging`, which opens a Devtool port. Nothing is modified inside your steam settings.
   ⚠️ The button won't work if you have a Steam game already running ! Close/save it before launching the script.
3. Clic on **Démarrer**.

That's it ! No account, no keys, no discord app to be created. 
The script will tell you what to do if there's an issue and will guide you until you clic on **Démarrer**

If you want to never use **relancer Steam** again so the 'detection mode' will always be on when launching Steam, you can add `-cef-enable-debugging` as an argument inside your steam shortcut. Not necessary at all !

### Optional settings

Steam's key API (`steamcommunity.com/dev/apikey`) and SteamID64 only serve for **hours played and achievemements** display by your Discord activity tab. Without them everything still works without issue but those two settings.

## Displayed name — « Playing … »

Discord always shows a **Discord application name**, never the text corresponding to the game's name itself : That's what prevent anyone/thing to pretend being an legit game.

Discord publish the list of name it can recognize— **19 192 jeux Steam**, each one with it's official name. 
SRPD searches for the displayed name and borrows it : for e.g « Playing at Stellaris » will write itself alone and automatically.
The bouton *changer** exists to correct, display very niche game or any text possible.

## App console 

| action | effect |
|---|---|
| Close the window | **nothing** — bridges continue to turn in background|
| Relaunch shortcut | rouvre une vue sur le pont vivant |
| **🗕 réduire** | range la fenêtre *et* la console — le pont continue |
| **⏻ quitter**, ou fermer la console | arrête tout |

## Partie en cours

Quand le jeu sait être lu, une carte affiche ce que Steam ne saura jamais dire — pour Stellaris :
nom de l'empire, date en jeu, flotte, planètes, DLC, et le **drapeau reconstitué** à partir des
masques du jeu (il n'existe nulle part en image).

Ça ne se généralise pas : chaque éditeur invente son format de sauvegarde. Ajouter un jeu, c'est
écrire une fonction dans `stellaris.js` et l'inscrire au registre `LECTEURS` — sans toucher au pont.
Tout le reste (ligne, jaquette, heures, succès, application Discord, dossier d'installation) marche
avec **n'importe quel** jeu Steam.

## Ce que ça coûte

- une lecture toutes les 10 s, sur **une seule** cible une fois trouvée ;
- une écriture vers Discord **uniquement quand ce qui part a changé** ;
- Discord plafonne de toute façon `setActivity` à une mise à jour toutes les 15 s.

Mesuré : **74 Mo** de mémoire et **0,6 s de processeur pour 800 requêtes**. Sur 800 requêtes, les
handles passent de 304 à 306 et les threads ne bougent pas — rien ne s'accumule.

## Sécurité

L'interface écoute sur `127.0.0.1` uniquement, sur un port improbable, et exige un **jeton aléatoire
régénéré à chaque lancement**. Sans lui, tout appel est refusé (403) — une page web ouverte ailleurs
dans ton navigateur ne peut donc pas piloter le pont.

`config.json` contient ta clé d'API Steam s'il y en a une. Il est dans `.gitignore`, n'est jamais
renvoyé à l'interface (qui n'affiche que `(enregistrée)`), et **ne doit pas être copié** si tu passes
le dossier à quelqu'un.

## Licence

Fais-en ce que tu veux.
