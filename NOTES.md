# Notes de conception

Ce que la construction a appris, gardé ici pour ne pas le réapprendre.

## Où vit vraiment le rich presence

Quatre pistes explorées, une seule ouverte :

| piste | verdict |
|---|---|
| API web (`GetPlayerSummaries`) | **fermée** — tous les champs vidés : `gameextrainfo` et `gameid`, rien d'autre |
| page de profil publique | **fermée** — « Currently In-Game: Stellaris », le texte enrichi n'y est pas |
| SDK Steamworks (`GetFriendRichPresence`) | **fermée** — réservé aux amis *dans le même jeu* ; une appli tierce ne peut pas se faire passer pour le jeu |
| contexte JS du client Steam | ✅ |

Le plan initial était de **gratter le DOM** de la liste d'amis. L'exploration a trouvé bien mieux :

```js
friendStore.m_FriendsUIFriendStore.m_self
  .current_game_name
  .current_game_rich_presence   // déjà composée ET traduite par Steam
  .m_nAppIDLastSeenPlaying
  .localized_online_status
```

C'est la **donnée** de Steam, pas son rendu. Trois conséquences : rien ne casse si l'interface change,
la liste d'amis n'a pas besoin d'être ouverte, et la clé d'API n'est plus requise (elle ne sert plus
que de secours quand le débogage est éteint, et ne donne alors que le nom du jeu).

`explore.js` est la sonde qui a servi à trouver ça — gardée, elle resservira si Steam déplace ses champs.

## Discord publiait déjà la table qu'on construisait à la main

« Joue à X » est le **nom de l'application** Discord, jamais un texte qu'on envoie. La conclusion
paraissait donc être : créer une application sur `discord.com/developers`, la nommer, copier son
identifiant, recommencer pour chaque jeu. C'était faux, et le point qui le prouve est public :

```
GET https://discord.com/api/v10/applications/detectable      (sans authentification)
```

24 208 jeux, dont **19 192 portent leur appid Steam** dans `third_party_skus` :

```json
{ "id": "363408909962182683", "name": "Stellaris",
  "third_party_skus": [{ "distributor": "steam", "id": "281990" }] }
```

L'appid du jeu en cours suffit donc à trouver **l'application officielle** de ce jeu. Aucune création,
aucune copie, et le nom affiché est celui que Discord utilise pour tout le monde. La liste est stable
et lourde : gardée sur disque une semaine. L'association à la main reste prioritaire quand elle existe.

⚠️ **Ce qu'une application refusée coûte**, et pourquoi il faut une liste noire : un identifiant
invalide fait tomber la socket. Sans repli, l'association d'un jeu rendait Discord injoignable pour de
bon — même après l'avoir retirée. Et sans mémoire du refus, la cible redevenait la même au tour
suivant : refus, repli, re-choix, re-refus, toutes les huit secondes.

## Une seule requête sans réponse gelait toute l'application

Symptômes rapportés, apparemment sans rapport : le bouton ⟳ ne fait rien · « Tester » reste sur `…`
indéfiniment · « Détecter » ne fait rien · l'état ne se rafraîchit plus. **Une seule cause.**

`rpc.destroy()` attend l'événement `close` de son transport. Quand la socket est *déjà* tombée, cet
événement n'arrive jamais :

```js
if (rpc) { try { await rpc.destroy(); } catch (e) {} rpc = null; }   // ← ce rpc = null ne s'exécute plus
```

La référence n'était donc jamais lâchée : chaque tentative suivante rajoutait un écouteur sur le
**même** transport — d'où le `MaxListenersExceededWarning: 11 close listeners` — et la requête HTTP
du bouton ne répondait pas. Or **un navigateur ne garde que six connexions par origine** : au sixième
clic, toutes les requêtes suivantes attendaient derrière celles qui ne revenaient jamais. L'interface
entière paraissait morte alors que le pont, lui, tournait.

Trois règles depuis : on lâche la référence **avant** d'attendre, on n'attend **jamais** sans borne
(`Promise.race` avec un délai), et `/action` répond **toujours** — un filet répond à sa place au bout
de 25 s. Cette panne-là est devenue structurellement impossible.

## Le drapeau n'existe nulle part : il se reconstitue

Le `.sav` de Stellaris est un zip de deux entrées : `gamestate` (63 Mo déplié, jamais ouvert) et
`meta`, 852 caractères. Le `meta` donne le nom de l'empire, la date **en jeu**, les DLC, le portrait,
`meta_fleets`, `meta_planets`, et le drapeau — mais sous forme de *références*, pas d'image :

```
flag = { icon = { category="lithoid" file="lithoid_12.dds" }
         background = { category="backgrounds" file="flag_BG_36.dds" }
         colors = { "black" "pink" "black" "null" } }
```

Ce que la mesure a établi, et qu'il ne fallait pas deviner :

| | mesure | conséquence |
|---|---|---|
| format DDS | fourcc **vide**, 32 bits, `160128 = 200×200×4 + 128` | non compressé, aucun DXT à décoder |
| fond | **0 pixel sur 40 000** hors de `R+G = 254` | masque complémentaire : R = couleur 1, G = couleur 2, B vide, A opaque |
| icône | 1,1 % de gris seulement, teintes dominantes `rgb(208,176,144)` | **dessin déjà peint** — la teinter par « black » la rendait noire |
| couleurs | `flags/colors.txt` → `nom = { flag = rgb { R G B } }` | `black` = 27,27,27 |

⚠️ **La leçon de l'icône.** J'avais appliqué la règle « icône = forme à teindre par `colors[2]` », qui
est vraie pour beaucoup d'icônes — et le drapeau est sorti noir sur noir. La capture du jeu montrait
une icône beige. La règle correcte ne se choisit pas à l'avance : **on regarde ce que l'image
contient** (plus de 90 % de pixels gris ⇒ c'est un masque à teindre, sinon on la dessine telle
quelle). Le PNG est écrit à la main — trois blocs, un CRC32, `zlib` pour le reste.

Coût mesuré : **24 ms** pour ouvrir le zip, lire le `meta` et composer le drapeau ; 4 ms ensuite,
le résultat étant gardé tant que la sauvegarde n'a pas changé de date.

## L'adresse de la jaquette ne se devine plus

`…/steam/apps/<appid>/header.jpg` a marché pendant des années. Les jeux récents rangent leurs images
sous un dossier de **hachage** qu'aucune règle ne permet d'inventer :

```
…/store_item_assets/steam/apps/2807960/c12d12ce3c7d217398d3fcad77427bfc9d57c570/header.jpg
```

⚠️ **Le piège n'est pas le 404 — c'est qu'il n'y en a pas.** L'ancienne adresse répond `200`, avec
un substitut de **1441 octets** au lieu des 39 851 attendus. Rien à intercepter : `onerror` ne se
déclenche jamais, l'image se charge « avec succès » et reste vide. Un écran noir, et aucune trace.

La bonne adresse se demande à Steam, sur un point public et sans clé :

```
GET https://store.steampowered.com/api/appdetails?appids=<appid>&filters=basic  →  data.header_image
```

Gardée par appid ; l'ancienne convention reste le repli quand le magasin ne répond pas. Corollaire
général : **une réponse `200` n'est pas une preuve que la ressource existe** — quand un CDN peut
servir un substitut, c'est la taille qui tranche, pas le code.

## Ce qui se généralise, et ce qui ne se généralise pas

| | dynamique ? |
|---|---|
| ligne de rich presence, nom du jeu, appid | ✅ tout jeu Steam |
| jaquette, lien SteamDB, heures, succès | ✅ tout jeu Steam |
| **application Discord du jeu** | ✅ tout jeu — la table `detectable` en couvre 19 192 |
| **trouver où un jeu est installé** | ✅ tout jeu — `libraryfolders.vdf` + `appmanifest_<appid>.acf` |
| lire la partie en cours (empire, drapeau…) | ❌ **un format par éditeur** |

D'où le registre `LECTEURS = { "281990": lireStellaris }` dans `stellaris.js` : ajouter un jeu, c'est
écrire une fonction, sans toucher au pont. Ce qui ne se généralise pas, c'est le *contenu* de cette
fonction, pas sa place.

⚠️ **Deux pièges de chemin, tous deux muets.** Stellaris n'est pas forcément sur le disque de Steam :
il faut passer par `libraryfolders.vdf`, sinon `appmanifest` est introuvable. Et `OneDrive\Documents`
peut **exister sans contenir les sauvegardes** — prendre « le premier Documents qui existe » donnait
le mauvais, sans erreur. On essaie donc tous les candidats et c'est celui qui contient le jeu qui gagne.

## Trois gardes spéculatives, trois pannes

Toutes écrites contre des accidents jamais observés, toutes plus coûteuses que le risque :

1. **Un `AbortSignal` de 8 s** sur les `fetch`, « au cas où l'hôte serait muet ». Dans une sandbox
   Perchance, `fetch` est relayé au parent par `postMessage` : un `AbortSignal` **n'est pas clonable**,
   l'appel échouait avant de partir. Plus de documentation, plus de changelog.
2. **Un recul « on ne retente pas avant 60 s »** après un échec réseau. Un appel raté en devenait
   **quatre**, en silence.
3. **Une relance de Steam après un délai fixe de 6 s** au lieu d'attendre sa fermeture réelle. Steam
   met souvent plus longtemps ; relancer par-dessus une instance qui s'éteint laisse un client à
   moitié initialisé, et **le jeu suivant refuse de démarrer sans écrire un seul journal**.

Le fil commun : **un délai fixe posé à la place d'une vraie condition.** Avant d'ajouter une garde,
deux questions — *cette panne s'est-elle déjà produite ?* et *le garde-fou attend-il un ÉVÉNEMENT ou
un chronomètre ?*

Corollaire du même jour : **un garde-fou qui lit notre propre état ne protège rien quand cet état
n'est pas à jour.** Le refus « un jeu tourne » se fiait à une variable nulle tant que le pont n'avait
pas démarré — bouton cliqué pont à l'arrêt, Steam se coupait sous une partie ouverte. Il regarde
maintenant les processus réels sous `steamapps\common`.

## La console est l'application, la fenêtre n'en est qu'une vue

Premier modèle : fermer la fenêtre tuait le pont (signal `sendBeacon` + battement de cœur).
Mauvais choix pour une présence — on la veut vivante **pendant** qu'on joue, sans fenêtre dans les
pattes. D'où le modèle actuel :

| geste | effet |
|---|---|
| fermer la fenêtre | rien du tout — le pont continue |
| relancer le raccourci | rouvre une vue sur le pont vivant (il lit `.fenetre-url`) |
| plusieurs fenêtres | aucun problème, ce sont des vues du même pont |
| bouton **réduire** | réduit la fenêtre, le pont continue |
| bouton **quitter** ou fermer la console | arrête tout |

Deux détails qui ont demandé une mesure :

- **Réduire ne peut pas venir de la page** : `window.minimize` n'existe pas. C'est le serveur qui
  appelle `ShowWindowAsync(hwnd, 6)` sur la fenêtre dont le titre porte notre nom.
- **Fermer la fenêtre ne se fait pas avec `taskkill /T`** : Edge ré-oriente ses processus, celui
  qu'on a lancé n'est plus leur parent — mesuré, 16 processus devenaient 10. On cible donc tous les
  `msedge` dont la ligne de commande porte **notre dossier de profil**, ce qui ne touche jamais
  l'Edge habituel de l'utilisateur.

## Détails qui coûtent du temps quand on les oublie

- **Un `.bat` ne peut pas porter d'icône** : Windows affiche celle du *type de fichier*. Seul un
  raccourci `.lnk` en accepte une. Le `.lnk` contient des chemins absolus, d'où `Creer le raccourci.ps1`.
- **`--app=` n'est pas une application**, c'est Edge sans onglets ni barre d'adresse, avec sa propre
  entrée dans la barre des tâches. Un vrai `.exe` (Tauri) utiliserait **WebView2** — le même moteur,
  composant séparé. La seule option réellement « sans navigateur » est native, et elle interdirait
  le tube, les lignes de balayage et la pluie.
- **Une classe CSS bat l'attribut `hidden`** du navigateur : `.veille { display:flex }` empêchait
  `hidden` de fonctionner. Il faut redire `.veille[hidden] { display:none }`.
- **Une animation permanente empêche le compositeur de se rendormir.** La pluie tourne à 15 images
  par seconde, **s'arrête complètement quand l'onglet passe en arrière-plan**, et un bouton la coupe
  pour de bon. Mesuré à vide : 60 Mo, 0,003 % d'un processeur.
- **Un chemin Windows mal échappé ne lève rien.** `"C:Program Files (x86)Steamsteam.exe"` a rendu
  muettes deux fonctions à la fois, sans message. Le chemin est vérifié au démarrage, avec repli.

## Sécurité

L'interface écoute sur `127.0.0.1` seulement — mais **le port ne protège rien** : n'importe quelle
page web ouverte dans le navigateur peut taper sur un port local. La vraie serrure est le **jeton
aléatoire régénéré à chaque lancement**, exigé sur chaque appel. Sans lui : 403.

`config.json` (clé d'API Steam) est dans `.gitignore` et n'est jamais renvoyé à l'interface, qui
n'affiche que `(enregistrée)`.
