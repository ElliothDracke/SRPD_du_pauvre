# SRPD_du_pauvre (Steam Rich Presence for Discord)

Ptite app pour récupérer le rich presence de Steam pour didi !

A small script that display Steam's rich presence inside Discord's activity module !

Still in beta/under works.

## Main features :

A web applet to link anything displayed under your Steam activity directly on your Discord activity page, without any Discord app required ! 

Uses steam's Devtool to locally open a 127.0.0.x applet web page with an interactive UI, allowing you to stop/launch the script anytime or toggle on/off display of achievements or hours played.

Gui applet with an option panel, a fake retro PC screen to display your currently playing game cover art+link to steam db, and a journal log. If anything goes wrong, is missing ( like wrong Id, missing dependencies, steam not launched, discord not connected .. ) it will detect it and tell you what to do.

Can display : Game name, game's cover art, Steam rich presence, total game time played and number of achievements. ( you can also write any text inside of the game's name using the 

No need to manually write anything : your Discord ID, Steam ID, game ID, Game cover art and SteamDb links are automatically fetched and displayed inside the GUI then in your Discord activity tab.

| source | What discord normally shows |
|---|---|
| API web Steam (`GetPlayerSummaries`) | `gameextrainfo` et `gameid`. **that's it* |
| public profile page | « Currently In-Game: Stellaris ». Nothing more |
| SDK Steamworks (`GetFriendRichPresence`) | Reserved to friends in same game = a third app can't be recognized as game |
| **client Steam** | ✅ Complete translated line |

Steam's client is a web app. By using DevTool's protocol we can read its data inside : `friendStore.m_FriendsUIFriendStore.m_self`;
meaning we can easily read what's displayed there without even having to keep steam's friends tab open.

----------------

## Requirements : 

- Latest Node.js version 18 or later. ([nodejs.org](https://nodejs.org), version LTS).

## Installation

- Double-clic on **`Lancer SRPD_du_pauvre.bat`** : It will detect if your node.js is up to date, install dependencies and open its own GUI window.

## Utilisation

1. Open Steam.

2. Clic on **⟳ relancer Steam**. It will close/reopen with the option `-cef-enable-debugging` which opens a Steam Devtool port. (Nothing is modified inside your steam settings.)
   ⚠️ The button won't work if you have a Steam game already running ! Close/save it before launching the script.
   
3. Clic on **Démarrer**.

That's it ! No account, no keys, no discord app to be created. 
The script will tell you what to do if there's an issue and will guide you until you clic on **Démarrer**

If you want to never use **relancer Steam** again so the 'detection mode' will always stay ON when launching Steam, you can add `-cef-enable-debugging` as an argument inside your steam shortcut. Not necessary at all !

### Optional settings

Steam's key API (`steamcommunity.com/dev/apikey`) and SteamID64 only serve for **hours played and achievemements** display by your Discord activity tab. 
Without them everything still works without issue but those two settings.

## Displayed name : « Playing … »

Discord always shows a **Discord application name**, never the text corresponding to the game's name itself : That's what prevent anyone/thing to pretend being an legit game.

Discord also publishes the list of name it can recognize : **19 192 Steam games**, each one with its official name. 

SRPD searches for the displayed name and borrows it : for e.g « Playing at Stellaris » will write itself alone and automatically.

The button *changer** exists to correct the displayed name on your discord activity tab, allowing you to display very niche game or write any text possible.

## App console 

| action | effect |
|---|---|
| Close the window | **nothing** bridges continue to turn in background|
| Relaunch shortcut | Reopens the GUI applet without killing bridge |
| **🗕 réduire** | Puts console + GUI in taskbar without killing bridge |
| **⏻ quitter**, ou fermer la console | Kills all |

## Current save game (only for Stellaris for now !)

When a game savefile can be read, a card will appear under 'Etat' inside the applet's GUI, showing you what Steam's rich presence doesn't. 
e.g for Stellaris: empire name, in-game date, fleet, planets, DLCs, and the **flag rebuilt** from the game's own masks (it exists nowhere as an image).

This part doesn't generalise: every publisher invents its own save format. Adding a game means writing one function in `stellaris.js` and listing it in the `LECTEURS` registry — without touching the bridge. Everything else (the line, cover art, playtime, achievements, Discord application, install folder) works with **any** Steam game.

## What it costs

- one read every 10 s, against a **single** target once it's found;
- a write to Discord **only when what goes out has changed**;
- Discord caps `setActivity` at one update every 15 s anyway.

Measured: **74 MB** of memory and **0.6 s of CPU for 800 requests**. 
Across those 800 requests, handle count goes from 304 to 306 and thread count doesn't move — nothing accumulates.

## Security

The interface listens on `127.0.0.1` only, on an unlikely port, and requires a **random token regenerated at every launch**. 

Without it, every call is refused (403). A web page open elsewhere in your browser cannot drive the bridge.

`config.json` holds your Steam API key, if you set one. 
It's in `.gitignore`, is never sent back to the interface (which only ever displays `(enregistrée)`), and **must not be copied** if you hand the folder to someone else, it's yours !!

## License

Do whatever you want with it :)
