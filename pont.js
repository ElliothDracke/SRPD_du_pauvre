/* Pont entre le Rich Presence du client Steam et Discord.
 *
 * Pourquoi ce detour : le texte « Playing Galactic Lozavatan Autocracy (Xenophobe...) in 2454 »
 * n'existe NI dans l'API web de Steam (verifie : elle ne rend que gameextrainfo et gameid),
 * NI sur la page de profil publique, NI via GetFriendRichPresence du SDK (reserve aux amis dans
 * le meme jeu). Il n'est compose que par le client Steam, qui est une application web.
 *
 * On ne gratte PAS son interface pour autant : le protocole DevTools donne acces a son contexte
 * JS interne, ou `friendStore.m_FriendsUIFriendStore.m_self.current_game_rich_presence` porte la
 * ligne deja composee et traduite. C'est la donnee de Steam, pas un rendu — donc rien ne casse
 * si l'interface change, et la liste d'amis n'a meme pas besoin d'etre ouverte.
 *
 * Cout, mesure : le pont tient dans 60 Mo et 0,003 % d'un processeur. Une lecture toutes les 10 s
 * sur UNE cible, et une ecriture vers Discord seulement quand la ligne a change — Discord plafonne
 * de toute facon setActivity a une mise a jour toutes les 15 s.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { execFile, spawn } = require("child_process");
const WebSocket = require("ws");
const DiscordRPC = require("discord-rpc");
const jeux = require("./stellaris");   // ce que la sauvegarde sait dire, quand on sait la lire

const RACINE = __dirname;
const CFG = path.join(RACINE, "config.json");
const CEF = "127.0.0.1:8080";
const PORT_GUI = +process.env.SRPD_PORT || 49731;        // plage privee : personne d'autre ne s'y attend
const JETON = require("crypto").randomBytes(16).toString("hex"); // exige a chaque appel : une page web ouverte ailleurs ne peut pas piloter le pont

const defauts = {
  applicationId: "880475977292079104",
  steamExe: "C:\\Program Files (x86)\\Steam\\steam.exe",
  intervalleMs: 10000,
  grandeImage: "steam_logo",
  apps: {},          // appid Steam -> identifiant d'application Discord, choisi A LA MAIN : prioritaire sur la table
  autoApp: true,     // sinon : chercher le jeu dans la table publique de Discord et emprunter son application
  montrerHeures: true,
  montrerSucces: true,
};
let cfg = { ...defauts };
try { cfg = { ...defauts, ...JSON.parse(fs.readFileSync(CFG, "utf8")) }; } catch (e) {}
// 🩹 un chemin errone dans config.json rendait muettes DEUX fonctions a la fois (detection du compte
//    et relance de Steam), sans le moindre message. On ne fait plus confiance au reglage sans verifier.
if (!fs.existsSync(cfg.steamExe)) {
  const pistes = [defauts.steamExe, "C:\\Program Files\\Steam\\steam.exe",
    path.join(process.env["ProgramFiles(x86)"] || "", "Steam", "steam.exe"),
    path.join(process.env.ProgramFiles || "", "Steam", "steam.exe")];
  const bon = pistes.find(p => p && fs.existsSync(p));
  if (bon) cfg.steamExe = bon;
}
const sauverCfg = () => { try { fs.writeFileSync(CFG, JSON.stringify(cfg, null, 2)); } catch (e) {} };

// ── etat partage, lu tel quel par l'interface ────────────────────────────────
const etat = {
  steam: "?",          // ok | eteint | sansDebug
  discord: "?",        // ok | absent
  jeu: null,
  ligne: null,         // la fameuse ligne de rich presence
  cible: null,         // titre de la cible CEF qui la fournit
  candidats: [], moi: null, moiSteam: null, avatar: null, statut: null, appid: null,
  nomApp: null, debut: null, heures: null, succes: null,
  details: "",         // la premiere ligne de la carte, composee UNE fois ici et lue telle quelle
  jaquette: null,      // l'adresse REELLE de l'image, demandee a Steam et non fabriquee
  partie: null,        // ce que la sauvegarde du jeu raconte — quand ce jeu-la sait etre lu
  auto: null,          // ce que la table publique de Discord sait de ce jeu : { id, nom }
  probleme: null,      // le dernier ennui, numerote : l'interface en fait un bandeau et ne le repete pas
  cibles: [],
  journal: [],
  actif: false,
  derniereEcriture: null,
};
/* 🔔 UN ENNUI DOIT SE VOIR. Tout partait au journal, replie par defaut : le pont pouvait tomber
   sans que rien ne bouge a l'ecran. Chaque « ko » porte desormais un numero, et l'interface
   affiche une seule fois ceux qu'elle n'a pas encore montres. */
let nProbleme = 0;
const dire = (t, niv) => {
  const l = { t: new Date().toLocaleTimeString("fr-FR"), m: t, n: niv || "info" };
  etat.journal.unshift(l); etat.journal.length = Math.min(etat.journal.length, 60);
  if (niv === "ko") etat.probleme = { n: ++nProbleme, m: t };
  console.log("  " + l.t + "  " + t);
};
// le minuteur est ETEINT des que la course est jouee : sinon chaque appel laissait derriere lui un
// timer vivant jusqu'a son echeance, et autant de raisons pour la boucle d'evenements de ne pas dormir
const avecDelai = (p, ms, quoi) => {
  let t;
  return Promise.race([p, new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error(quoi + " n'a pas repondu en " + Math.round(ms / 1000) + " s")), ms);
  })]).finally(() => clearTimeout(t));
};

// ── protocole DevTools : lister les cibles, evaluer du JS dans l'une d'elles ──
const jsonCef = chemin => new Promise((res, rej) => {
  const r = http.get("http://" + CEF + chemin, { timeout: 4000 }, rep => {
    let b = ""; rep.on("data", d => b += d);
    rep.on("end", () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
  });
  r.on("timeout", () => { r.destroy(); rej(new Error("timeout")); });
  r.on("error", rej);
});

let idEval = 0;
const evaluer = (wsUrl, expression) => new Promise((res, rej) => {
  const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
  const id = ++idEval;
  const fini = setTimeout(() => { try { ws.close(); } catch (e) {} rej(new Error("evaluation trop longue")); }, 6000);
  ws.on("open", () => ws.send(JSON.stringify({
    id, method: "Runtime.evaluate",
    params: { expression, returnByValue: true, awaitPromise: true },
  })));
  ws.on("message", d => {
    let m = {}; try { m = JSON.parse(d.toString()); } catch (e) { return; }
    if (m.id !== id) return;
    clearTimeout(fini); try { ws.close(); } catch (e) {}
    if (m.error) return rej(new Error(m.error.message));
    const r = m.result && m.result.result;
    if (r && r.subtype === "error") return rej(new Error(r.description || "erreur JS"));
    res(r ? r.value : null);
  });
  ws.on("error", e => { clearTimeout(fini); rej(e); });
});

/* 🎯 ON NE GRATTE PLUS L'INTERFACE. Le premier plan etait de chercher la ligne dans le DOM de la
   liste d'amis — fragile, et dependant d'une fenetre ouverte. L'exploration de SharedJSContext a
   montre bien mieux : `friendStore.m_FriendsUIFriendStore.m_self` porte les champs de Steam
   LUI-MEME, dont `current_game_rich_presence` deja compose et traduit.
   Consequences : rien ne casse si Steam refait son interface, la liste d'amis n'a pas besoin d'etre
   ouverte, et le nom du jeu vient de la meme source — donc la cle d'API Steam n'est plus requise. */
// ⚠️ `m_nAppIDLastSeenPlaying` vaut 0 PENDANT qu'on joue — c'est un « vu la derniere fois », pas
//    l'app en cours. L'identifiant vit dans l'URL de l'icone : .../community_assets/images/apps/281990/…
//    Decoupage par chaine plutot que regex : rien a echapper en traversant le pont DevTools.
const LECTURE = `(() => {
  const s = window.friendStore && friendStore.m_FriendsUIFriendStore;
  const m = s && s.m_self;
  if (!m) return null;
  const icone = String(m.current_game_icon_url || "");
  const bout = icone.split("/apps/")[1];
  return {
    nom:   m.display_name || "",
    jeu:   m.current_game_name || "",
    rp:    m.current_game_rich_presence || "",
    appid: (bout ? bout.split("/")[0] : "") || String(m.m_nAppIDLastSeenPlaying || ""),
    statut: m.localized_online_status || "",
  };
})()`;

/* ── Discord ──────────────────────────────────────────────────────────────────
   🏷️ « Joue à SteamRPC » vient du NOM DE L'APPLICATION Discord, jamais d'un texte qu'on envoie —
   c'est ce qui empeche n'importe qui de se faire passer pour un jeu. On ne peut donc pas le changer…
   mais on peut CHANGER D'APPLICATION. Une application Discord nommee « Stellaris », associee a
   l'appid 281990, et la carte dit « Joue à Stellaris ». Le pont se rebranche tout seul quand le jeu
   change ; sans association, il retombe sur l'application par defaut. */
/* 🤖 …ET ON N'A RIEN A CREER POUR CA. Discord publie la liste des jeux qu'il sait reconnaitre, sans
   authentification — et chaque entree porte l'appid Steam correspondant dans `third_party_skus`.
   Mesure : 24 208 jeux, dont 19 192 appid Steam. Le detour par discord.com/developers (creer une
   application, la nommer, copier son identifiant) etait donc evitable : on lit l'appid du jeu en
   cours, on prend l'application OFFICIELLE de ce jeu, et « Joue à Stellaris » s'ecrit tout seul.
   La liste est stable et lourde : gardee sur disque une semaine, jamais retelechargee entre-temps. */
const TABLE = path.join(RACINE, ".jeux-discord.json");
let _table = null, _tableEnVol = null;
function tableDiscord() {
  if (_table) return Promise.resolve(_table);
  if (_tableEnVol) return _tableEnVol;              // pas quatre telechargements pour quatre appels
  try {
    const c = JSON.parse(fs.readFileSync(TABLE, "utf8"));
    if (c.jeux && Date.now() - c.quand < 7 * 864e5) { _table = c.jeux; return Promise.resolve(_table); }
  } catch (e) {}
  _tableEnVol = (async () => {
    try {
      const r = await avecDelai(fetch("https://discord.com/api/v10/applications/detectable"), 15000, "la table des jeux");
      if (!r.ok) throw new Error("HTTP " + r.status);
      const jeux = {};
      for (const a of await r.json())
        for (const s of a.third_party_skus || [])
          if (s.distributor === "steam" && s.id) jeux[s.id] = { id: a.id, nom: a.name };
      _table = jeux;
      try { fs.writeFileSync(TABLE, JSON.stringify({ quand: Date.now(), jeux })); } catch (e) {}
      dire("table des jeux Discord chargee — " + Object.keys(jeux).length + " jeux reconnus");
      return jeux;
    } catch (e) { dire("table des jeux Discord indisponible : " + e.message, "ko"); return null; }
    finally { _tableEnVol = null; }
  })();
  return _tableEnVol;
}
/* 🚫 CE QUE DISCORD A REFUSE, ON NE LE REPROPOSE PLUS. Sans cette liste, une application invalide
   redevenait la cible au tour suivant : repli, re-choix, re-refus — une boucle toutes les huit
   secondes. Un refus suffit a la retirer jusqu'au prochain lancement. */
const refusees = new Set();
// l'association A LA MAIN reste prioritaire : la table propose, l'utilisateur dispose
const trouve = () => {
  const a = (cfg.autoApp !== false && etat.appid && _table && _table[etat.appid]) || null;
  return a && !refusees.has(a.id) ? a : null;
};
const clientVoulu = () => {
  const main = cfg.apps && etat.appid && cfg.apps[etat.appid];
  return (main && !refusees.has(main) ? main : null) || (trouve() || {}).id || cfg.applicationId;
};
// 🎯 l'application suit le jeu MEME A L'ARRET : ce qui est affiche doit etre ce qui partira
async function accorderDiscord() {
  if (!clientActuel || clientVoulu() === clientActuel) return;
  dire("application Discord : " + ((trouve() || {}).nom || clientVoulu()));
  await brancherDiscord();
}

let rpc = null, pret = false, debut = null, clientActuel = null;
/* 🧟 UN CLIENT MORT NE SE FERME PAS TOUT SEUL — et c'est ce qui gelait l'application entiere.
   `destroy()` attend l'evenement `close` de son transport ; quand la socket est DEJA tombee, cet
   evenement n'arrive jamais et l'attente est eternelle. Le `rpc = null` qui suivait ne s'executait
   donc plus : chaque tentative suivante rajoutait un ecouteur sur le MEME transport (« 11 close
   listeners »), la requete HTTP du bouton ⟳ ne repondait pas, et le navigateur — six connexions
   par origine — finissait par ne plus rien pouvoir demander du tout. D'ou les « … » partout.
   Deux regles depuis : on lache la reference AVANT d'attendre, et on n'attend jamais sans borne. */
async function jeter(vieux) {
  if (!vieux) return;
  try { vieux.removeAllListeners(); } catch (e) {}
  try { await avecDelai(vieux.destroy(), 2500, "la fermeture Discord"); } catch (e) {}
}
// ce que Discord dit quand l'identifiant ne lui dit rien — le reste est passager, pas un verdict
const REFUS = /closed|invalid|unknown|not found/i;
// 🔗 un seul branchement a la fois : deux poignees de main concurrentes se coupaient la socket
let fileDiscord = Promise.resolve(), dernierEssai = 0;
const brancherDiscord = id => (fileDiscord = fileDiscord.catch(() => {}).then(() => _brancher(id)));
/* 🔁 UNE CONNEXION PERDUE SE RATTRAPE TOUTE SEULE. Sans ceci, un echec passager laissait Discord
   « absent » pour de bon : la cible n'ayant pas change, plus rien ne cherchait a s'y rebrancher et
   il fallait cliquer ⟳ pour retrouver sa presence. On retente — mais SANS retenir la lecture :
   un Discord ferme met dix secondes a le dire, et Steam n'a pas a les attendre. */
function veillerDiscord() {
  if (pret && rpc && etat.discord === "ok") return;
  if (Date.now() - dernierEssai < 30000) return;
  brancherDiscord();   // volontairement sans await
}
async function _brancher(id, repli) {
  dernierEssai = Date.now();
  if (!id) await tableDiscord().catch(() => {});   // savoir quelle application viser avant de viser
  const cible = id || clientVoulu();
  const vieux = rpc;
  rpc = null; pret = false; etat.discord = "?";
  await jeter(vieux);
  clientActuel = cible; dernierEnvoye = null;      // nouvelle application = il faut tout re-pousser
  const c = new DiscordRPC.Client({ transport: "ipc" });
  // 👤 `rpc.user` arrive avec la poignee de main : identifiant, pseudo ET empreinte d'avatar. Rien
  //    a demander de plus, l'aperçu peut donc montrer TON visage et pas un carre gris.
  c.on("ready", () => {
    pret = true; etat.discord = "ok";
    const u = c.user || {};
    etat.moi = u.global_name || u.username || "";
    etat.avatar = u.id && u.avatar
      ? "https://cdn.discordapp.com/avatars/" + u.id + "/" + u.avatar + ".png?size=64"
      : "https://cdn.discordapp.com/embed/avatars/0.png";
    dire("Discord connecte (" + (u.username || "?") + ")", "ok");
  });
  rpc = c;
  let ennui = null;
  try { await avecDelai(c.login({ clientId: cible }), 12000, "la connexion Discord"); }
  catch (e) {
    ennui = e.message;
    if (rpc === c) { rpc = null; pret = false; }
    etat.discord = "absent";
    await jeter(c);
  }
  // 🏷️ le nom que Discord AFFICHERA : son point public le donne sans authentification. Mieux vaut
  //    le montrer que laisser deviner — c'est toute la question que se pose l'utilisateur.
  try {
    const r = await avecDelai(fetch("https://discord.com/api/v10/applications/" + encodeURIComponent(cible) + "/rpc"), 8000, "Discord");
    etat.nomApp = r.ok ? (await r.json()).name : null;
  } catch (e) { etat.nomApp = null; }
  if (!ennui) return { ok: true, msg: etat.nomApp ? "connecté — Discord affichera « Joue à " + etat.nomApp + " »" : "connecté à Discord" };
  /* 🪂 UN MAUVAIS IDENTIFIANT NE DOIT PAS CONDAMNER LE PONT. Une application inconnue de Discord
     fait tomber la socket : sans ce repli, l'association d'un jeu suffisait a rendre Discord
     injoignable pour de bon, y compris apres l'avoir retiree.
     ⚖️ MAIS UN REFUS N'EST PAS UNE PANNE, et les confondre coutait cher. Discord FERME la socket
     quand l'identifiant ne lui dit rien ; il repond RPC_CONNECTION_TIMEOUT quand il est seulement
     occupe — mesure : en enchainant les reconnexions, deux sur trois echouent ainsi. Sans cette
     distinction, un simple hoquet mettait l'application du jeu en liste noire, et « Joue à
     Stellaris » retombait en silence sur l'application par defaut jusqu'au prochain lancement. */
  if (REFUS.test(ennui) && !repli && cible !== cfg.applicationId) {
    refusees.add(cible);
    dire("Discord a refuse l'application " + cible + " — repli sur celle par defaut", "ko");
    return _brancher(cfg.applicationId, true);
  }
  dire("Discord injoignable : " + ennui, "ko");
  return { ok: false, msg: "Discord injoignable : " + ennui };
}

/* 🖼️ L'ADRESSE DE LA JAQUETTE NE SE DEVINE PLUS. La convention `…/steam/apps/<appid>/header.jpg` a
   marche des annees ; les jeux recents rangent desormais leurs images sous un dossier de HACHAGE
   qu'aucune regle ne permet d'inventer :
       …/store_item_assets/steam/apps/2807960/c12d12ce3c7d2173…/header.jpg
   Le piege : l'ancienne adresse repond 200, avec un substitut de 1441 octets au lieu des 40 ko
   attendus. Aucune erreur a intercepter, aucun `onerror` ne se declenche — l'image se charge « avec
   succes » et reste vide. On demande donc l'adresse a Steam (point public appdetails) et on la garde ;
   l'ancienne convention reste le repli quand le magasin ne repond pas. */
const _jaquettes = {};
const jaquetteHeritee = a => "https://cdn.cloudflare.steamstatic.com/steam/apps/" + a + "/header.jpg";
async function jaquette(appid) {
  if (!appid) return null;
  if (_jaquettes[appid] !== undefined) return _jaquettes[appid];
  _jaquettes[appid] = jaquetteHeritee(appid);   // pose avant d'attendre : deux tours ne demandent pas deux fois
  try {
    const r = await avecDelai(fetch("https://store.steampowered.com/api/appdetails?appids=" + appid + "&filters=basic"), 10000, "le magasin Steam");
    const j = await r.json(), d = j && j[appid];
    if (d && d.success && d.data && d.data.header_image) _jaquettes[appid] = d.data.header_image;
    else dire("pas de jaquette declaree pour l'app " + appid + " — on garde l'ancienne adresse");
  } catch (e) { dire("jaquette : magasin Steam injoignable (" + e.message + ")", "ko"); }
  return _jaquettes[appid];
}

/* 🏆 HEURES ET SUCCES — les deux seules choses que l'API web sache mieux dire que le client.
   Elles bougent lentement : on les relit toutes les cinq minutes, pas a chaque tour. Un jeu sans
   succes repond 403 (« Requested app has no stats ») : ce n'est pas une panne, c'est une reponse. */
let _stats = { appid: null, quand: 0, heures: null, succes: null };
async function statsSteam(appid) {
  if (!cfg.steamApiKey || !cfg.steamId || !appid) return null;
  if (_stats.appid === appid && Date.now() - _stats.quand < 300000) return _stats;
  const q = async (chemin, extra) => {
    const u = new URL("https://api.steampowered.com" + chemin);
    Object.entries({ key: cfg.steamApiKey, steamid: cfg.steamId, ...extra }).forEach(([k, v]) => u.searchParams.set(k, v));
    const r = await fetch(u); return r.ok ? r.json() : null;
  };
  const neuf = { appid, quand: Date.now(), heures: null, succes: null };
  // GetOwnedGames plutot que GetRecentlyPlayedGames : ce dernier ne liste que les quinze derniers jours
  try {
    const j = await q("/IPlayerService/GetOwnedGames/v1/", { include_played_free_games: 1 });
    const g = j && j.response && (j.response.games || []).find(x => String(x.appid) === String(appid));
    if (g) neuf.heures = Math.round(g.playtime_forever / 6) / 10;
  } catch (e) { dire("heures indisponibles : " + e.message, "ko"); }
  try {
    const j = await q("/ISteamUserStats/GetPlayerAchievements/v0001/", { appid });
    const a = j && j.playerstats && j.playerstats.achievements;
    if (Array.isArray(a)) neuf.succes = { total: a.length, faits: a.filter(x => x.achieved === 1).length };
  } catch (e) {}
  _stats = neuf;
  etat.heures = neuf.heures; etat.succes = neuf.succes;
  return neuf;
}
/* ce qui s'affiche sur la premiere ligne : le jeu, puis ce qu'on sait de plus.
   🔁 …sauf que l'application s'appelle maintenant comme le jeu : « Joue à Stellaris » suivi de
   « Stellaris » repetait le titre deux fois sur la carte. On ne le redit que s'il apporte quelque
   chose — c'est-a-dire quand l'application porte un autre nom, ou qu'il n'y a rien d'autre a dire. */
const detailJeu = (jeu, s) => {
  const plus = [
    cfg.montrerHeures && s && s.heures != null ? s.heures.toFixed(1) + " h" : null,
    cfg.montrerSucces && s && s.succes ? "🏆 " + s.succes.faits + "/" + s.succes.total : null,
  ].filter(Boolean);
  const redit = etat.nomApp && jeu && etat.nomApp.toLowerCase() === jeu.toLowerCase();
  return [redit && plus.length ? null : jeu, ...plus].filter(Boolean).join("  ·  ");
};

let dernierEnvoye = null;
async function pousser(jeu, ligne) {
  if (!pret || !rpc) return;   // le raccord d'application se fait en amont, des la lecture
  const signature = jeu + "\u0000" + (ligne || "");
  // 🖼️ la jaquette du CDN Steam plutot que le logo generique : c'est la MEME url que celle du
  //    moniteur, on l'a deja sous la main des que l'appid est connu.
  const image = etat.jaquette || cfg.grandeImage;
  const details = etat.details = detailJeu(jeu, await statsSteam(etat.appid));
  /* ⚠️ LA SIGNATURE PORTE TOUT CE QUI PART — jeu, ligne, premiere ligne composee ET image.
     Avec le jeu et la ligne seuls, un succes debloque ne repartait jamais, et la jaquette qui
     arrive UN TOUR APRES le nom du jeu (l'appid se lit plus tard) restait le logo pour toujours. */
  if (signature + details + image === dernierEnvoye) return;   // rien n'a change : on n'ecrit pas
  if (!debut) debut = Date.now();
  etat.debut = debut;   // l'aperçu recalcule le chrono lui-meme, comme le fait Discord
  const act = {
    details,
    largeImageKey: image,
    largeImageText: jeu,
    startTimestamp: debut,
  };
  if (ligne) act.state = ligne.length > 128 ? ligne.slice(0, 125) + "..." : ligne;
  try { await rpc.setActivity(act); dernierEnvoye = signature + details + image; etat.derniereEcriture = new Date().toLocaleTimeString("fr-FR");
    dire("envoye a Discord : " + jeu + (ligne ? " — " + ligne : ""), "ok"); }
  catch (e) { dire("echec setActivity : " + e.message, "ko"); }
}
async function effacer() {
  if (!pret || !rpc) return;
  if (dernierEnvoye === null) return;
  try { await rpc.clearActivity(); } catch (e) {}
  dernierEnvoye = null; debut = null; dire("plus de jeu — carte effacee");
}

/* ── un tour de lecture ───────────────────────────────────────────────────────
   👀 ON REGARDE MEME A L'ARRET. « Steam : … » et « Discord : … » restaient indefinis tant qu'on
   n'avait pas clique Démarrer — l'interface ne disait rien de ce qu'elle savait pourtant deja lire,
   et on croyait le pont casse. La sonde LIT en permanence ; seul Démarrer donne le droit d'ECRIRE
   vers Discord. C'est la difference entre `pousse` vrai et faux, et c'est la seule. */
/* ⚖️ QUAND `tasklist` ECHOUE, ON NE SAIT PAS — et « je ne sais pas » ne doit pas devenir « Steam est
   ferme », qui est l'affirmation la plus alarmante des deux. On retient l'hypothese la plus probable
   et la plus douce : ouvert, mais pas encore lisible. */
const steamTourne = () => new Promise(res => execFile("tasklist", ["/FI", "IMAGENAME eq steam.exe", "/NH"],
  { timeout: 5000 }, (e, out) => res(e ? true : /steam\.exe/i.test(String(out)))));
let enLecture = false, echecsLecture = 0;
async function unTour(pousse) {
  if (enLecture) return;              // la sonde et le battement ne doivent pas se marcher dessus
  enLecture = true;
  try { await _tour(pousse); } finally { enLecture = false; }
  veillerDiscord();                   // chaque tour est aussi l'occasion de retrouver Discord
}
async function _tour(pousse) {
  let cibles;
  try { cibles = await jsonCef("/json"); }
  catch (e) {
    /* 🔎 « PAS DE PORT DE DEBOGAGE » NE DIT PAS POURQUOI. Steam ferme et Steam lance sans le drapeau
       se ressemblent vus d'ici — mais le geste a faire n'est pas le meme : ouvrir Steam, ou cliquer
       sur ⟳ relancer Steam. On regarde donc si le processus existe. Un `tasklist` seulement quand la
       lecture a echoue : dans le cas normal, ca ne coute rien. */
    /* 🚦 UN ECHEC ISOLE N'EST PAS UN DIAGNOSTIC. Au lancement, la premiere lecture tombe souvent
       avant que Steam n'ait fini d'ouvrir son port : annoncer aussitot « Steam n'est pas ouvert »
       etait faux une seconde plus tard, et faisait clignoter une alarme pour rien. On reste sur
       « recherche… » jusqu'a une deuxieme confirmation. */
    if (++echecsLecture < 2) { etat.cible = null; return; }
    etat.steam = (await steamTourne()) ? "sansDebug" : "eteint";
    etat.cible = null; etat.cibles = []; etat.ligne = null;
    await parApiWeb(pousse);
    return;
  }
  echecsLecture = 0;
  etat.steam = "ok";
  etat.cibles = cibles.map(c => ({ titre: c.title, url: (c.url || "").slice(0, 70) }));
  const sjc = cibles.find(c => c.title === "SharedJSContext" && c.webSocketDebuggerUrl);
  if (!sjc) { etat.cible = null; dire("SharedJSContext introuvable — Steam a-t-il fini de demarrer ?", "ko"); return; }

  let d = null;
  try { d = await evaluer(sjc.webSocketDebuggerUrl, LECTURE); }
  catch (e) { dire("lecture refusee : " + e.message, "ko"); return; }
  if (!d) { etat.cible = null; dire("friendStore pas encore pret", "ko"); return; }

  etat.cible = "SharedJSContext"; etat.moiSteam = d.nom; etat.statut = d.statut;
  etat.jeu = d.jeu || null;
  etat.appid = d.appid && d.appid !== "0" ? d.appid : null;
  etat.ligne = d.rp || null;
  etat.candidats = d.rp ? [d.rp] : [];
  if (etat.appid && !_table) await tableDiscord().catch(() => {});   // savoir quoi proposer, meme a l'arret
  etat.auto = trouve();
  await accorderDiscord();
  // 👁️ l'aperçu doit montrer CE QUI PART : il lit donc la ligne composee ici, il ne la refabrique pas
  etat.jaquette = await jaquette(etat.appid);
  etat.details = etat.jeu ? detailJeu(etat.jeu, await statsSteam(etat.appid)) : "";
  try { lirePartie(); } catch (e) { etat.partie = null; }   // un jeu illisible ne casse pas la lecture
  if (!etat.jeu) { if (pousse) await effacer(); return; }
  if (pousse) await pousser(etat.jeu, etat.ligne);
}

// ── secours quand le debogage est eteint : l'API web donne le NOM, jamais la ligne ──
async function parApiWeb(pousse) {
  if (!cfg.steamApiKey || !cfg.steamId) { etat.jeu = null; etat.appid = null; if (pousse) await effacer(); return; }
  try {
    const u = new URL("https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/");
    u.searchParams.set("key", cfg.steamApiKey); u.searchParams.set("steamids", cfg.steamId);
    const r = await avecDelai(fetch(u), 10000, "l'API Steam"); const j = await r.json();
    const p = j.response && j.response.players && j.response.players[0];
    etat.jeu = p && p.gameextrainfo ? p.gameextrainfo : null;
    etat.appid = p && p.gameid ? String(p.gameid) : null;   // sert a la jaquette et au lien SteamDB
    if (etat.appid && !_table) await tableDiscord().catch(() => {});
    etat.auto = trouve();
    etat.jaquette = await jaquette(etat.appid);
    await accorderDiscord();
    if (!pousse) return;
    if (etat.jeu) await pousser(etat.jeu, null); else await effacer();
  } catch (e) { dire("API Steam injoignable : " + e.message, "ko"); }
}

let minuteur = null;
const battement = () => unTour(true);
function demarrer() {
  if (etat.actif) return;
  etat.actif = true; dire("pont demarre", "ok");
  battement();
  minuteur = setInterval(battement, Math.max(5000, cfg.intervalleMs));
}
// la sonde tourne en continu, mais s'efface des que le battement fait le travail
setInterval(() => { if (!etat.actif) unTour(false); }, 8000);
function arreter() {
  etat.actif = false; clearInterval(minuteur); minuteur = null;
  effacer(); dire("pont arrete");
}

// ── relancer Steam avec le drapeau de debogage ───────────────────────────────
/* 🛑 `steam -shutdown` avec un jeu lance peut FERMER LA PARTIE EN COURS.
   ⚠️ La premiere version se fiait a `etat.jeu`, qui vaut null tant que le pont n'a pas tourne :
      bouton clique pont a l'arret = garde-fou muet, et Steam se coupait sous une partie ouverte.
      On regarde donc les PROCESSUS reels, pas notre propre etat. */
function jeuEnCours() {
  return new Promise(res => {
    execFile("powershell", ["-NoProfile", "-NonInteractive", "-Command",
      "(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '*steamapps\\common*' } | Select-Object -First 1 -Expand Name)"],
      { timeout: 8000 }, (e, out) => res(e ? null : String(out).trim() || null));
  });
}
async function relancerSteam(force) {
  const enCours = await jeuEnCours();
  if ((enCours || etat.jeu) && !force) {
    dire("refus : " + (enCours || etat.jeu) + " tourne. Quitte le jeu d'abord (ou force depuis l'interface).", "ko");
    return false;
  }
  /* ⏳ ON ATTEND QUE STEAM SOIT REELLEMENT MORT. Une premiere version relancait apres un delai fixe
     de 6 s : Steam met souvent plus longtemps a se fermer, et relancer par-dessus une instance qui
     s'eteint encore laisse un client a moitie initialise — assez pour qu'un jeu refuse de demarrer
     ensuite sans qu'aucun journal ne l'explique. On sonde jusqu'a 40 s, puis on renonce. */
  dire("fermeture de Steam...");
  await new Promise(res => execFile(cfg.steamExe, ["-shutdown"], () => res()));
  const mort = () => new Promise(res => execFile("tasklist", ["/FI", "IMAGENAME eq steam.exe", "/NH"],
    { timeout: 5000 }, (e, out) => res(!!e || !/steam\.exe/i.test(String(out)))));
  for (let i = 0; i < 40; i++) {
    if (await mort()) break;
    await new Promise(r => setTimeout(r, 1000));
    if (i === 39) { dire("Steam ne s'est pas ferme en 40 s — relance annulee", "ko"); return false; }
  }
  await new Promise(r => setTimeout(r, 2500));   // il lui faut encore un instant apres la disparition du processus
  /* 🪟 PAS DE `-silent` ICI. Steam demarre en silencieux au boot de Windows, et j'avais recopie ce
     drapeau — donc il revenait cache dans la zone de notification. Mais on arrive ici parce que
     quelqu'un a CLIQUE : voir la fenetre revenir est la seule preuve que le bouton a fait son travail. */
  dire("relance avec -cef-enable-debugging");
  try {
    spawn(cfg.steamExe, ["-cef-enable-debugging"], { detached: true, stdio: "ignore" }).unref();
    return true;
  } catch (e) { dire("relance impossible : " + e.message, "ko"); return false; }
}

/* 📍 OU EST INSTALLE UN JEU — et ceci, contrairement a la lecture de sa sauvegarde, marche pour
   N'IMPORTE LEQUEL. Steam le dit deux fois : `libraryfolders.vdf` liste les bibliotheques (un jeu
   peut vivre sur un autre disque), et `appmanifest_<appid>.acf` donne le nom du dossier. Aucune
   cle d'API, aucun reseau — c'est de la lecture de fichier. */
function dossierJeu(appid) {
  const bases = [path.join(path.dirname(cfg.steamExe), "steamapps")];
  try {
    const v = fs.readFileSync(path.join(bases[0], "libraryfolders.vdf"), "utf8");
    for (const m of v.matchAll(/"path"\s+"([^"]+)"/g)) bases.push(path.join(m[1].replace(/\\\\/g, "\\"), "steamapps"));
  } catch (e) {}
  for (const b of bases) {
    try {
      const d = (fs.readFileSync(path.join(b, "appmanifest_" + appid + ".acf"), "utf8").match(/"installdir"\s+"([^"]+)"/) || [])[1];
      if (d) { const p = path.join(b, "common", d); if (fs.existsSync(p)) return p; }
    } catch (e) {}
  }
  return null;
}
/* 📂 ON NE CHOISIT PAS LE DOSSIER DOCUMENTS, ON LES ESSAIE TOUS. Mesure ici meme : OneDrive\Documents
   EXISTE mais ne contient aucun jeu Paradox — les sauvegardes vivent dans le Documents du profil.
   Prendre « le premier qui existe » donnait donc le mauvais, en silence. C'est au lecteur de chaque
   jeu de dire lequel contient ce qu'il cherche. */
const DOCS = [...new Set([process.env.OneDrive && path.join(process.env.OneDrive, "Documents"),
  path.join(process.env.USERPROFILE || "", "Documents"),
  process.env.USERPROFILE && path.join(process.env.USERPROFILE, "OneDrive", "Documents"),
].filter(d => d && fs.existsSync(d)))];

let _drapeau = null;
/* 🎌 CE QUE STEAM NE SAURA JAMAIS DIRE : le nom de l'empire, la date en jeu, la flotte, le drapeau.
   Ca ne vient que du fichier de sauvegarde — donc d'un format prive, donc d'un lecteur par jeu.
   Le pont, lui, ne connait que le registre : il demande, il recoit, ou il ne recoit rien. */
function lirePartie() {
  if (!etat.appid || !jeux.connait(etat.appid)) { etat.partie = null; _drapeau = null; return; }
  const racine = dossierJeu(etat.appid);
  if (!racine) { etat.partie = null; return; }
  const r = jeux.lire(etat.appid, racine, DOCS);
  etat.partie = r ? r.info : null;
  _drapeau = r ? r.png : null;
}

// ── trois verifications, pour ne pas avoir a deviner ses reglages ────────────
// 🪪 le SteamID se lit DANS l'installation locale : aucune cle, aucun reseau. loginusers.vdf
//    liste les comptes deja connectes sur cette machine, avec leur pseudo.
function comptesLocaux() {
  try {
    const f = path.join(path.dirname(cfg.steamExe), "config", "loginusers.vdf");
    const t = fs.readFileSync(f, "utf8");
    return [...t.matchAll(/"(\d{17})"\s*\{([^}]*)\}/g)].map(m => ({
      id: m[1],
      nom: (m[2].match(/"PersonaName"\s*"([^"]*)"/) || [])[1] || "?",
      recent: (m[2].match(/"MostRecent"\s*"1"/) || []).length > 0,
    }));
  } catch (e) { return []; }
}
async function testerApi() {
  if (!cfg.steamApiKey || !cfg.steamId) return { ok: false, msg: "SteamID ou cle manquante" };
  try {
    const u = new URL("https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/");
    u.searchParams.set("key", cfg.steamApiKey); u.searchParams.set("steamids", cfg.steamId);
    const r = await fetch(u);
    if (r.status === 403) return { ok: false, msg: "cle refusee (403)" };
    const j = await r.json();
    const p = j.response && j.response.players && j.response.players[0];
    if (!p) return { ok: false, msg: "aucun profil pour ce SteamID" };
    return { ok: true, msg: p.personaname + (p.gameextrainfo ? " — en jeu : " + p.gameextrainfo : " — aucun jeu en cours") };
  } catch (e) { return { ok: false, msg: e.message }; }
}
// 🏷️ Discord affiche toujours le NOM DE L'APPLICATION, jamais un texte libre. Son point public
//    le donne sans authentification : autant le montrer plutot que de le faire deviner.
async function testerDiscord() {
  try {
    const r = await fetch("https://discord.com/api/v10/applications/" + encodeURIComponent(cfg.applicationId) + "/rpc");
    if (!r.ok) return { ok: false, msg: "identifiant inconnu de Discord (" + r.status + ")" };
    const j = await r.json();
    return { ok: true, msg: "Discord affichera « Joue à " + j.name + " »" };
  } catch (e) { return { ok: false, msg: e.message }; }
}

// ── interface ────────────────────────────────────────────────────────────────
const gui = fs.readFileSync(path.join(RACINE, "gui.html"), "utf8");
const adresse = () => "http://127.0.0.1:" + PORT_GUI + "/?j=" + JETON;

/* 🚪 LA CONSOLE EST L'APPLICATION, LA FENETRE N'EN EST QU'UNE VUE.
   Premiere version : fermer la fenetre tuait le pont. Mauvais choix pour une presence — on veut
   qu'elle tourne PENDANT qu'on joue, sans fenetre dans les pattes, et pouvoir la rouvrir. Fermer
   une vue ne ferme donc plus rien ; on peut en ouvrir plusieurs, ce sont des vues du meme pont.
   Pour tout arreter : le bouton « Quitter », ou fermer la console. */
let dernierContact = 0, sortiePrevue = null, pidFenetre = null;
/* 🧹 ON FERME PAR PROFIL, PAS PAR ARBRE. `taskkill /T` sur le processus qu'on a lance n'en tuait
   qu'une partie (16 → 10 mesure) : Edge re-oriente ses processus, celui qu'on a cree n'est plus
   leur parent. On cible donc tous les msedge dont la ligne de commande porte NOTRE dossier de
   profil — precis, et sans jamais toucher a l'Edge habituel de l'utilisateur. */
const PROFIL = () => process.env.SRPD_PROFIL || path.join(RACINE, ".fenetre");
/* 📌 UNE ADRESSE PAR PORT. Ce fichier etait commun a toutes les instances : deux ponts sur deux
   ports differents s'ecrasaient l'adresse, et le premier qui s'arretait effacait celle de l'autre —
   qui devenait alors introuvable, avec un « le port est occupe par autre chose que SRPD » en prime
   alors que c'etait bien SRPD. */
const FIL_URL = path.join(RACINE, ".fenetre-url-" + PORT_GUI);
/* 🗕 RÉDUIRE — aucune API du navigateur ne le permet depuis la page (`window.minimize` n'existe pas).
   Mais on connait la fenetre : c'est celle dont le titre est le notre. ShowWindowAsync(…, 6) la reduit.
   ⚠️ ET LA CONSOLE AVEC. Reduire la seule fenetre laissait « SRPD_du_pauvre » dans la barre des
   taches : on avait range la vue, pas l'application. Le titre du .bat vaut le notre, donc le meme
   filtre attrape les deux — sans nommer de processus, et sans jamais toucher a autre chose. */
const reduireFenetre = () => new Promise(res => {
  execFile("powershell", ["-NoProfile", "-NonInteractive", "-Command",
    "Add-Type -Name W -Namespace N -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool ShowWindowAsync(IntPtr h, int c);'; " +
    "Get-Process -EA SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like '*SRPD*' } | " +
    "ForEach-Object { [N.W]::ShowWindowAsync($_.MainWindowHandle, 6) }"],
    { timeout: 8000 }, () => res());
});
const fermerFenetre = () => new Promise(res => {
  const profil = PROFIL();
  execFile("powershell", ["-NoProfile", "-NonInteractive", "-Command",
    "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | " +
    "Where-Object { $_.CommandLine -like '*" + profil.replace(/'/g, "''") + "*' } | " +
    "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"],
    { timeout: 8000 }, () => { pidFenetre = null; res(); });
});
const annulerSortie = () => { if (sortiePrevue) { clearTimeout(sortiePrevue); sortiePrevue = null; } };
function programmerSortie(ms, motif) {
  annulerSortie();
  sortiePrevue = setTimeout(() => {
    dire(motif + " — arret du pont");
    /* ⚠️ LE NETTOYAGE NE DOIT PAS RETENIR LA SORTIE. Une premiere version faisait `await effacer()`
       avant de quitter : quand `clearActivity` reste suspendu (deux clients Discord ouverts, par
       exemple), le processus ne mourait jamais. On part au plus tard apres 1,2 s, quoi qu'il arrive. */
    const partir = () => process.exit(0);
    setTimeout(partir, 1800);   // filet : on part meme si le nettoyage traine
    Promise.allSettled([effacer(), fermerFenetre()]).then(() => setTimeout(partir, 250));
  }, ms);
}
/* 🪟 UNE VRAIE FENETRE, PAS UN ONGLET. `--app=` ouvre Edge ou Chrome sans barre d'adresse, sans
   onglets, avec sa propre entree dans la barre des taches : ca se comporte comme une application.
   C'est le meme moteur qu'un vrai .exe en WebView2 — sauf qu'il n'y a rien a installer ni a compiler.
   Repli sur le navigateur par defaut si aucun des deux n'est la. */
/* 🧹 UN PROFIL QUI GROSSIT SANS FIN. Mesure : 223 Mo, dont 168 pour `component_crx_cache` — Edge y
   telecharge ses composants et ses modeles (extraction d'entites, detection de langue) alors que
   notre page est un fichier local qui n'en a aucun usage. `--disable-component-update` coupe la
   source ; ce menage ramasse ce qui a deja ete ecrit, et ce que la prochaine version d'Edge
   inventera. Tout ce qui est liste ici se reconstruit : ni historique, ni compte, rien a perdre.
   On ne pese QUE ces dossiers-la, pas le profil entier — meme information, bien moins de travail. */
const JETABLES = ["component_crx_cache", "BrowserMetrics", "GrShaderCache", "ShaderCache", "Crashpad",
  "Edge Entity Extraction", "EdgeLanguageDetectionModel", "OptimizationHints", "SafetyTips",
  path.join("Default", "Cache"), path.join("Default", "Code Cache"), path.join("Default", "Service Worker")];
const peser = d => {
  let s = 0;
  try {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      try { s += e.isDirectory() ? peser(p) : fs.statSync(p).size; } catch (err) {}
    }
  } catch (err) {}
  return s;
};
function menageProfil(profil, plafondMo) {
  const dossiers = JETABLES.map(j => path.join(profil, j));
  const avant = dossiers.reduce((s, d) => s + peser(d), 0);
  if (avant < plafondMo * 1048576) return;
  for (const d of dossiers) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} }
  dire("profil Edge degonfle : " + Math.round(avant / 1048576) + " Mo de caches supprimes");
}

async function ouvrirFenetre(url) {
  /* 🧟 UNE FENETRE SURVIVANTE FAIT UNE FENETRE GEANTE. Si un Edge tourne encore sur NOTRE profil
     (console fermee brutalement, vue restee ouverte), le lancement suivant s'y RATTACHE au lieu de
     creer un processus — et un Edge rattache ignore `--window-size`, d'ou le retour de la fenetre
     demesuree. On repart donc toujours d'un profil sans processus. */
  await fermerFenetre();
  menageProfil(PROFIL(), 40);   // apres la fermeture : on ne vide pas les caches sous un Edge vivant
  const pistes = [
    path.join(process.env["ProgramFiles(x86)"] || "", "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(process.env.ProgramFiles || "", "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(process.env["ProgramFiles(x86)"] || "", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env.ProgramFiles || "", "Google", "Chrome", "Application", "chrome.exe"),
  ];
  const exe = pistes.find(p => p && fs.existsSync(p));
  /* 📏 `--user-data-dir` N'EST PAS UN DETAIL : sans lui, Edge rattache la fenetre a la session deja
     ouverte et IGNORE `--window-size` — d'ou une fenetre de 1500 px pour un contenu de 640, avec
     des marges enormes des deux cotes. Un profil a nous garantit une fenetre neuve, a notre taille. */
  const profil = PROFIL();
  /* 🤐 FAIRE TAIRE LE PARCOURS DE PREMIERE OUVERTURE. Un profil neuf declenche a chaque fois la
     bienvenue d'Edge et sa proposition d'enregistrer un compte. Les drapeaux seuls n'y suffisent
     pas : Chromium se fie surtout a un fichier temoin « First Run » et a ses preferences. On seme
     donc le profil une fois, comme s'il avait deja ete configure et refuse. */
  try {
    fs.mkdirSync(path.join(profil, "Default"), { recursive: true });
    const temoin = path.join(profil, "First Run");
    if (!fs.existsSync(temoin)) fs.writeFileSync(temoin, "");
    const prefs = path.join(profil, "Default", "Preferences");
    if (!fs.existsSync(prefs)) fs.writeFileSync(prefs, JSON.stringify({
      credentials_enable_service: false,
      credentials_enable_autosignin: false,
      signin: { allowed: false, allowed_on_next_startup: false },
      browser: { has_seen_welcome_page: true, show_home_button: false },
      profile: { exit_type: "Normal", exited_cleanly: true,
        password_manager_enabled: false, default_content_setting_values: {} },
      sync: { requested: false },
    }));
  } catch (e) {}
  try {
    if (exe) {
      // 🧹 on RETIENT le processus : c'est nous qui avons ouvert cette fenetre, c'est a nous de la
      //    refermer en partant. Sinon dix processus Edge survivaient au pont, sur notre propre profil.
      //    Et un cache borne : ce dossier avait deja pris 100 Mo.
      const p = spawn(exe, ["--app=" + url, "--window-size=680,940", "--user-data-dir=" + profil,
        "--disk-cache-size=8000000", "--no-first-run", "--no-default-browser-check",
        // 🔇 rien de tout ca ne concerne une fenetre d'application : ni compte, ni synchronisation,
        //    ni promotion, ni trafic de fond. Et surtout : ce profil est A NOUS, il ne touche jamais
        //    a l'Edge habituel — c'est aussi ce qui empeche la taille de cette fenetre de deteindre.
        // 📦 --disable-component-update : la source des 168 Mo. Le service de composants d'Edge
        //    telechargeait modeles et extensions internes dans notre profil, pour une page locale.
        "--disable-sync", "--disable-signin-promo", "--disable-default-apps", "--disable-component-update",
        "--disable-background-networking", "--no-service-autorun", "--disable-breakpad",
        "--disable-features=EdgeSignInPromo,msImplicitSignIn,ImplicitSignInOnFirstRun,msEdgeWelcomePage,msEdgeShoppingHub,EdgeDiscoverHub"],
        { detached: true, stdio: "ignore" });
      pidFenetre = p.pid; p.unref();
    } else spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
  } catch (e) { console.log("  ouverture manuelle : " + url); }
}
const serveur = http.createServer(async (req, rep) => {
  const u = new URL(req.url, "http://x");
  // 🔒 le jeton est la vraie serrure : le port n'est qu'une adresse, il ne protege rien
  if (u.searchParams.get("j") !== JETON) { rep.writeHead(403, { "content-type": "text/plain" }); return rep.end("jeton invalide"); }
  dernierContact = Date.now(); annulerSortie();   // toute requete valide prouve qu une fenetre est encore la
  if (u.pathname === "/") { rep.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return rep.end(gui.replace(/%JETON%/g, JETON)); }
  /* 🎌 le drapeau n'existe nulle part en image : il est recompose a partir des masques du jeu, puis
     servi ici. Il reste LOCAL — Discord exigerait une image publiquement accessible. */
  if (u.pathname === "/drapeau.png") {
    if (!_drapeau) { rep.writeHead(404); return rep.end(); }
    rep.writeHead(200, { "content-type": "image/png", "cache-control": "no-cache" });
    return rep.end(_drapeau);
  }
  if (u.pathname === "/etat") {
    rep.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    return rep.end(JSON.stringify({ ...etat, clientActuel, lieAuJeu: (cfg.apps && etat.appid && cfg.apps[etat.appid]) || "", cfg: { ...cfg, steamApiKey: cfg.steamApiKey ? "(enregistree)" : "" } }));
  }
  if (u.pathname === "/action") {
    /* ⏱️ UNE ACTION REPOND TOUJOURS, ET VITE. Une seule qui ne repondait pas — la reconnexion
       Discord, bloquee sur un client mort — a suffi a geler toute l'interface : le navigateur ne
       garde que six connexions par origine, et les requetes suivantes attendaient derriere celles
       qui ne revenaient jamais. Boutons muets, verdicts figes sur « … », etat plus rafraichi.
       Le filet ci-dessous rend cette panne-la structurellement impossible. */
    let repondu = false;
    const repondre = o => { if (repondu) return; repondu = true;
      rep.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      rep.end(JSON.stringify(o || {})); };
    const filet = setTimeout(() => repondre({ ok: false, msg: "l'action n'a pas répondu à temps" }), 25000);
    try { repondre(await action(u)); }
    catch (e) { dire("action impossible : " + e.message, "ko"); repondre({ ok: false, msg: e.message }); }
    clearTimeout(filet);
    return;
  }
  rep.writeHead(404); rep.end();
});
// 🧾 chaque action rend un verdict : l'interface en fait un bandeau, au lieu de laisser deviner
async function action(u) {
  const quoi = u.searchParams.get("q");
  if (quoi === "start") { demarrer(); return {}; }
  if (quoi === "stop") { arreter(); return {}; }
  if (quoi === "steam") return { ok: await relancerSteam(u.searchParams.get("force") === "1") };
  if (quoi === "discord") return brancherDiscord();
  if (quoi === "lier") {
    const a = u.searchParams.get("appid"), d = (u.searchParams.get("app") || "").trim();
    if (!a) return { ok: false, msg: "aucun jeu détecté à associer" };
    cfg.apps = cfg.apps || {};
    if (d) { cfg.apps[a] = d; dire("application Discord liee a la main a l'app " + a, "ok"); }
    else { delete cfg.apps[a]; dire("association manuelle retiree pour l'app " + a); }
    sauverCfg();
    return brancherDiscord();
  }
  if (quoi === "quitter") { programmerSortie(0, "demande de l'utilisateur"); return {}; }
  if (quoi === "reduire") { await reduireFenetre(); return {}; }
  if (quoi === "choisir") { etat.ligne = u.searchParams.get("l"); dernierEnvoye = null; await pousser(etat.jeu, etat.ligne); return {}; }
  if (quoi === "cfg") {
    for (const k of ["montrerHeures", "montrerSucces", "autoApp"]) {   // interrupteurs : absent = false, il faut donc les lire a part
      const v = u.searchParams.get(k); if (v !== null) cfg[k] = v === "1";
    }
    for (const k of ["applicationId", "steamId", "steamApiKey", "intervalleMs", "grandeImage"]) {
      const v = u.searchParams.get(k);
      if (v !== null && v !== "" && v !== "(enregistree)") cfg[k] = k === "intervalleMs" ? +v : v;
    }
    sauverCfg(); dire("reglages enregistres", "ok");
    // l'application visee a pu changer avec ces reglages : on se rebranche si besoin, sans bloquer
    if (clientActuel && clientVoulu() !== clientActuel) brancherDiscord();
    return {};
  }
  if (quoi === "comptes") return { comptes: comptesLocaux() };
  if (quoi === "testApi") return testerApi();
  if (quoi === "testDiscord") return testerDiscord();
  return {};
}
// 🚪 lancer deux fois donnait une trace Node brute sur EADDRINUSE : illisible, et rien ne disait
//    qu une instance tournait deja. On le dit, et on ne laisse pas une console mourir en silence.
/* 🔁 RELANCER = ROUVRIR LA FENETRE. Le pont vit dans sa console ; fermer sa fenetre ne l'arrete pas,
   et il fallait donc un moyen de la retrouver. Un second lancement ne se plaint plus : il lit
   l'adresse laissee par le pont vivant, ouvre une vue dessus, et s'efface. Double-clic = fenetre. */
serveur.on("error", e => {
  if (e.code === "EADDRINUSE") {
    let url = null;
    try { url = fs.readFileSync(FIL_URL, "utf8").trim(); } catch (err) {}
    if (url) {
      console.log("\n  SRPD_du_pauvre tourne deja — sa fenetre se rouvre.\n");
      // le menage du profil precede l'ouverture : on ne part qu'une fois la fenetre lancee
      ouvrirFenetre(url).then(() => setTimeout(() => process.exit(0), 2000));
      return;
    }
    console.log("\n  Le port " + PORT_GUI + " est occupe par autre chose que SRPD.\n");
  } else console.log("\n  Impossible de demarrer : " + e.message + "\n");
  setTimeout(() => process.exit(1), 5000);   // le temps de lire avant que la console se ferme
});
serveur.listen(PORT_GUI, "127.0.0.1", () => {
  try { fs.writeFileSync(FIL_URL, adresse()); } catch (e) {}   // pour qu'un second lancement rouvre la fenetre
  console.log("\n  SRPD_du_pauvre");
  console.log("  Interface : " + adresse());
  console.log("  Le pont tourne TANT QUE CETTE CONSOLE EST OUVERTE.");
  console.log("  Fermer sa fenetre ne l'arrete pas — relance le raccourci pour la rouvrir.\n");
  ouvrirFenetre(adresse());
});
// l'adresse ne doit pas survivre au pont : sinon un lancement suivant ouvrirait une vue sur du vide
// ⚠️ ON N'EFFACE QUE SA PROPRE ADRESSE. En s'arretant, une instance supprimait le fichier sans le
//    lire : si une autre venait de demarrer sur le meme port, c'est SON adresse qui disparaissait,
//    et le lancement suivant ne retrouvait plus la fenetre d'un pont pourtant bien vivant.
const oublierUrl = () => {
  try { if (fs.readFileSync(FIL_URL, "utf8").trim() === adresse()) fs.unlinkSync(FIL_URL); } catch (e) {}
};
process.on("exit", oublierUrl);
process.on("SIGINT", () => { oublierUrl(); process.exit(0); });

brancherDiscord();
