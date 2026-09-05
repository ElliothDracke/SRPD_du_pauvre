# SRPD_du_pauvre

Ptite app pour récupérer le rich presence de Steam pour didi — la vraie ligne, celle qui dit
`Playing Galactic Lozavatan Autocracy (Xenophobe, Militarist, Materialist) in 2470` —
jusqu'à ta carte Discord.

## Pourquoi ce détour

Cette ligne n'existe qu'à un seul endroit, et ce n'est pas là où on la cherche d'abord :

| source | ce qu'elle donne |
|---|---|
| API web Steam (`GetPlayerSummaries`) | `gameextrainfo` et `gameid`. **C'est tout.** |
| page de profil publique | « Currently In-Game: Stellaris ». Rien de plus. |
| SDK Steamworks (`GetFriendRichPresence`) | réservé aux amis **dans le même jeu** — une appli tierce ne peut pas se faire passer pour le jeu |
| **client Steam** | ✅ la ligne complète, déjà composée et traduite |

Le client Steam est une application web. On s'y branche par le protocole DevTools — mais on ne
**gratte pas son interface** pour autant : on lit sa *donnée*, dans
`friendStore.m_FriendsUIFriendStore.m_self`. Conséquence : rien ne casse si Steam refait son
interface, et la liste d'amis n'a même pas besoin d'être ouverte.

## Installation

**Node.js requis** ([nodejs.org](https://nodejs.org), version LTS). C'est la seule chose à installer.

Ensuite, double-clic sur **`Lancer SRPD_du_pauvre.bat`**. Au premier lancement il installe les
dépendances, crée un raccourci avec l'icône du dragon, et ouvre l'interface dans sa propre fenêtre.

### ⚠️ « Ce fichier ne contient pas de signature numérique valide »

**Un seul fichier est concerné** — les `.js` sont *lus* par Node, jamais lancés par l'explorateur :

> clic droit sur `Lancer SRPD_du_pauvre.bat` → **Propriétés** → cocher **Débloquer** → OK

Mieux : débloque le `.zip` **avant** de l'extraire (mêmes clics), et aucun fichier extrait ne portera
la marque. La boîte propose de toute façon **Exécuter**, ou *Informations complémentaires →
Exécuter quand même*.

**Et si tu préfères ne rien lancer de téléchargé**, ouvre un terminal dans le dossier :

```
npm install
node pont.js
```

Aucun avertissement : c'est toi qui lances `node`, pas Windows qui lance un fichier venu d'ailleurs.
Le `.bat` ne fait rien de plus, sinon vérifier que Node est là et créer le raccourci avec l'icône.

## Utilisation

1. Ouvre Steam.
2. Clique **⟳ relancer Steam**. Il se ferme et repart dans un mode où SRPD peut le lire
   (l'option `-cef-enable-debugging`, qui ouvre son port DevTools local). Rien n'est modifié dans
   tes réglages Steam.
   ⚠️ Le bouton refuse d'agir si un jeu tourne : fermer Steam pourrait fermer ta partie.
3. Clique **Démarrer**.

C'est tout. Aucun compte, aucune clé, aucune application à créer. L'app te dit à chaque instant
ce qu'il reste à faire — jusqu'à « Tout est bon — clique sur Démarrer ! ».

Pour ne plus jamais toucher à ce bouton, ajoute `-cef-enable-debugging` aux arguments de ton
raccourci Steam : il démarrera toujours lisible.

### Réglages optionnels

La clé d'API Steam (`steamcommunity.com/dev/apikey`) et le SteamID64 ne servent **qu'aux heures de
jeu et aux succès** affichés sur la carte. Sans eux, tout le reste marche.

## Le nom affiché — « Joue à … »

Discord montre toujours le **nom d'une application Discord**, jamais un texte fourni par le
programme : c'est ce qui empêche n'importe qui de se faire passer pour un jeu.

Mais Discord publie la liste des jeux qu'il sait reconnaître — **19 192 jeux Steam**, chacun avec
son application officielle. SRPD y cherche le jeu en cours et emprunte la sienne : « Joue à
Stellaris » s'écrit tout seul, sans rien créer. Le bouton **changer** reste là pour les jeux absents
de la liste, ou pour afficher tout autre chose.

## La console est l'application, la fenêtre n'en est qu'une vue

| geste | effet |
|---|---|
| fermer la fenêtre | **rien** — le pont continue de tourner |
| relancer le raccourci | rouvre une vue sur le pont vivant |
| **🗕 réduire** | range la fenêtre *et* la console — le pont continue |
| **⏻ quitter**, ou fermer la console | arrête tout |

C'est fait exprès : on veut la présence vivante **pendant** qu'on joue, sans fenêtre dans les pattes.

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
