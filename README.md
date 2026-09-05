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

## Current game

When a game can be read, a card shows what Steam will never tell you — for Stellaris: empire name,
in-game date, fleet, planets, DLCs, and the **flag rebuilt** from the game's own masks (it exists
nowhere as an image).

This part doesn't generalise: every publisher invents its own save format. Adding a game means
writing one function in `stellaris.js` and listing it in the `LECTEURS` registry — without touching
the bridge. Everything else (the line, cover art, playtime, achievements, Discord application,
install folder) works with **any** Steam game.

## What it costs

- one read every 10 s, against a **single** target once it's found;
- a write to Discord **only when what goes out has changed**;
- Discord caps `setActivity` at one update every 15 s anyway.

Measured: **74 MB** of memory and **0.6 s of CPU for 800 requests**. Across those 800 requests,
handle count goes from 304 to 306 and thread count doesn't move — nothing accumulates.

## Security

The interface listens on `127.0.0.1` only, on an unlikely port, and requires a **random token
regenerated at every launch**. Without it, every call is refused (403) — so a web page open
elsewhere in your browser cannot drive the bridge.

`config.json` holds your Steam API key, if you set one. It's in `.gitignore`, is never sent back to
the interface (which only ever displays `(enregistrée)`), and **must not be copied** if you hand the
folder to someone else.

## License

Do whatever you want with it.
