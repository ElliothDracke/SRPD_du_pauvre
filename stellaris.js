/* Ce que la sauvegarde d'un jeu sait dire de la partie en cours — et que Steam ignore.
 *
 * ⚠️ CE FICHIER EST, PAR NATURE, LE SEUL QUI NE SE GENERALISE PAS. Tout le reste du pont marche
 * avec n'importe quel jeu parce qu'il ne lit que Steam et Discord ; ici on ouvre un format prive.
 * D'ou le registre en bas : un jeu = une fonction, ajoutee sans toucher au pont.
 *
 * Le .sav de Stellaris est un zip de deux entrees : `gamestate` (63 Mo une fois deplie — on n'y
 * touche pas) et `meta`, 852 caracteres qui portent le nom de l'empire, la date EN JEU, les DLC,
 * le portrait, le drapeau, la flotte et le nombre de planetes.
 *
 * 🎨 LE DRAPEAU SE RECONSTITUE, il n'existe nulle part en image. Mesure, pas supposition :
 *   · les DDS sont NON COMPRESSES (fourcc vide, 32 bits, masques ARGB) — aucun DXT a decoder ;
 *   · le fond est un MASQUE COMPLEMENTAIRE a deux couleurs : sur les 40 000 pixels de flag_BG_36,
 *     zero ne s'ecarte de R+G = 254. Le canal R porte la couleur 1, le G la couleur 2, le B est
 *     vide (moyenne 2,7) et l'alpha vaut 255 partout ;
 *   · l'icone, elle, est un dessin quasi blanc (1,1 % de gris purs, exemples autour de 210) avec
 *     un vrai canal alpha : on la multiplie par la troisieme couleur.
 * Le PNG est ecrit a la main — zlib suffit, il n'y a que trois blocs et un CRC.
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

// ── un zip lu par son catalogue, pas en devinant ─────────────────────────────
function entreeZip(fichier, nom) {
  const fd = fs.openSync(fichier, "r");
  try {
    const taille = fs.fstatSync(fd).size;
    // la fin du catalogue est a la fin du fichier, precedee d'un commentaire de longueur variable
    const queue = Buffer.alloc(Math.min(66000, taille));
    fs.readSync(fd, queue, 0, queue.length, taille - queue.length);
    let fin = -1;
    for (let i = queue.length - 22; i >= 0; i--) if (queue.readUInt32LE(i) === 0x06054b50) { fin = i; break; }
    if (fin < 0) throw new Error("catalogue introuvable");
    const nb = queue.readUInt16LE(fin + 10), debut = queue.readUInt32LE(fin + 16);
    const cat = Buffer.alloc(queue.readUInt32LE(fin + 12));
    fs.readSync(fd, cat, 0, cat.length, debut);
    let p = 0;
    for (let i = 0; i < nb; i++) {
      if (cat.readUInt32LE(p) !== 0x02014b50) throw new Error("catalogue abime");
      const lnom = cat.readUInt16LE(p + 28), lextra = cat.readUInt16LE(p + 30), lcom = cat.readUInt16LE(p + 32);
      if (cat.toString("utf8", p + 46, p + 46 + lnom) === nom) {
        const methode = cat.readUInt16LE(p + 10), taillec = cat.readUInt32LE(p + 20), pos = cat.readUInt32LE(p + 42);
        const tete = Buffer.alloc(30);
        fs.readSync(fd, tete, 0, 30, pos);
        const donnees = Buffer.alloc(taillec);
        fs.readSync(fd, donnees, 0, taillec, pos + 30 + tete.readUInt16LE(26) + tete.readUInt16LE(28));
        return methode === 0 ? donnees : zlib.inflateRawSync(donnees);
      }
      p += 46 + lnom + lextra + lcom;
    }
    throw new Error("entree « " + nom + " » absente");
  } finally { fs.closeSync(fd); }
}

// ── le PNG, ecrit a la main : trois blocs, un CRC, zlib pour le reste ────────
const TABLE_CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();
const crc32 = b => { let c = -1; for (let i = 0; i < b.length; i++) c = TABLE_CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function bloc(type, donnees) {
  const t = Buffer.concat([Buffer.from(type, "ascii"), donnees]);
  const l = Buffer.alloc(4); l.writeUInt32BE(donnees.length, 0);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc32(t), 0);
  return Buffer.concat([l, t, c]);
}
function png(w, h, rgba) {
  const ligne = w * 4 + 1, brut = Buffer.alloc(ligne * h);   // un octet de filtre (0) par ligne
  for (let y = 0; y < h; y++) rgba.copy(brut, y * ligne + 1, y * w * 4, (y + 1) * w * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;   // 8 bits par canal, RGBA
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    bloc("IHDR", ihdr), bloc("IDAT", zlib.deflateSync(brut, { level: 9 })), bloc("IEND", Buffer.alloc(0))]);
}

// ── DDS non compresse : 128 octets d'en-tete, puis du BGRA brut ──────────────
function dds(fichier) {
  const b = fs.readFileSync(fichier);
  if (b.toString("ascii", 0, 4) !== "DDS ") throw new Error("pas un DDS");
  const h = b.readUInt32LE(12), w = b.readUInt32LE(16);
  if (b.readUInt32LE(84) !== 0) throw new Error("DDS compresse (fourcc present)");
  if (b.length - 128 < w * h * 4) throw new Error("DDS tronque");
  return { w, h, px: b.subarray(128) };
}

/* 🎨 TEINTER OU NON : C'EST L'ICONE QUI DECIDE, PAS NOUS. Certaines sont des FORMES en niveaux de
   gris, faites pour prendre la troisieme couleur ; d'autres sont des dessins deja peints. Mesure
   sur lithoid_12 : 1,1 % de pixels gris seulement, teintes dominantes beiges (208,176,144). La
   multiplier par « black » la rendait noire — alors que le jeu l'affiche beige. On regarde donc
   ce qu'elle contient avant d'y toucher, au lieu d'appliquer une regle a l'aveugle. */
const estMasque = im => {
  let gris = 0, opaques = 0;
  for (let i = 0; i < im.w * im.h; i++) {
    if (im.px[i * 4 + 3] < 200) continue;
    opaques++;
    const b = im.px[i * 4], g = im.px[i * 4 + 1], r = im.px[i * 4 + 2];
    if (Math.abs(r - g) < 12 && Math.abs(g - b) < 12) gris++;
  }
  return opaques > 0 && gris / opaques > 0.9;
};

/* LE MONTAGE. Fond = couleur1 x (R/255) + couleur2 x (G/255) ; icone posee au centre et fondue par
   son alpha. C'est exactement ce que les mesures ont montre, et rien de plus : aucun reglage
   invente pour « faire joli ». */
function composer(fond, icone, c) {
  const w = fond.w, h = fond.h, out = Buffer.alloc(w * h * 4);
  const [c1, c2, c3] = c;
  for (let i = 0; i < w * h; i++) {
    const r = fond.px[i * 4 + 2] / 255, g = fond.px[i * 4 + 1] / 255;
    out[i * 4] = Math.min(255, c1[0] * r + c2[0] * g);
    out[i * 4 + 1] = Math.min(255, c1[1] * r + c2[1] * g);
    out[i * 4 + 2] = Math.min(255, c1[2] * r + c2[2] * g);
    out[i * 4 + 3] = 255;
  }
  if (!icone) return { w, h, px: out };
  const teinter = estMasque(icone);
  const dx = (w - icone.w) >> 1, dy = (h - icone.h) >> 1;
  for (let y = 0; y < icone.h; y++) {
    const oy = y + dy; if (oy < 0 || oy >= h) continue;
    for (let x = 0; x < icone.w; x++) {
      const ox = x + dx; if (ox < 0 || ox >= w) continue;
      const s = (y * icone.w + x) * 4, a = icone.px[s + 3] / 255;
      if (!a) continue;
      const d = (oy * w + ox) * 4;
      for (let k = 0; k < 3; k++) {
        const v = icone.px[s + (2 - k)];                      // BGRA -> RGB
        out[d + k] = out[d + k] * (1 - a) + (teinter ? v * c3[k] / 255 : v) * a;
      }
    }
  }
  return { w, h, px: out, teintee: teinter };
}

// ── les couleurs nommees : « flag = rgb { R G B } », le reste ne nous regarde pas ──
function couleurs(racine) {
  const t = fs.readFileSync(path.join(racine, "flags", "colors.txt"), "utf8");
  const m = {};
  for (const l of t.split("\n")) {
    const c = l.match(/^\s*(\w+)\s*=\s*\{\s*flag\s*=\s*rgb\s*\{\s*(\d+)\s+(\d+)\s+(\d+)\s*\}/);
    if (c) m[c[1]] = [+c[2], +c[3], +c[4]];
  }
  return m;
}

// ── le meta, format Paradox : on ne prend que ce qu'on affiche ───────────────
function lireMeta(t) {
  const un = re => (t.match(re) || [])[1] || null;
  const accolades = nom => {
    const i = t.indexOf(nom + "=");
    if (i < 0) return null;
    const j = t.indexOf("{", i), f = t.indexOf("}", j);
    return j < 0 || f < 0 ? null : t.slice(j + 1, f);
  };
  const drapeau = () => {
    const i = t.indexOf("flag=");
    if (i < 0) return null;
    const s = t.slice(i);
    const part = nom => {
      const j = s.indexOf(nom + "=");
      if (j < 0) return null;
      const bout = s.slice(j, j + 200);
      return { categorie: (bout.match(/category="([^"]*)"/) || [])[1], fichier: (bout.match(/file="([^"]*)"/) || [])[1] };
    };
    const c = accolades("colors");
    return { icone: part("icon"), fond: part("background"),
      couleurs: c ? [...c.matchAll(/"([^"]*)"/g)].map(m => m[1]) : [] };
  };
  const dlc = accolades("required_dlcs");
  return {
    nom: un(/name="([^"]*)"/),
    date: un(/date="([^"]*)"/),
    version: un(/version="([^"]*)"/),
    portrait: un(/player_portrait="([^"]*)"/),
    dlcs: dlc ? [...dlc.matchAll(/"([^"]*)"/g)].map(m => m[1]) : [],
    flottes: +un(/meta_fleets=(\d+)/) || null,
    planetes: +un(/meta_planets=(\d+)/) || null,
    flag: drapeau(),
  };
}

/* La sauvegarde la plus recente, tous empires confondus : c'est la partie en cours. Chercher par
   nom d'empire serait plus precis mais suppose de connaitre ce nom AVANT de l'avoir lu. */
function derniereSauvegarde(dossier) {
  let meilleure = null;
  for (const d of fs.readdirSync(dossier, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    for (const f of fs.readdirSync(path.join(dossier, d.name))) {
      if (!f.endsWith(".sav")) continue;
      const p = path.join(dossier, d.name, f), m = fs.statSync(p).mtimeMs;
      if (!meilleure || m > meilleure.quand) meilleure = { chemin: p, quand: m };
    }
  }
  return meilleure;
}

let _cache = { chemin: null, quand: 0, info: null, png: null };
function lireStellaris(racineJeu, docs) {
  // 📂 plusieurs Documents possibles (profil, OneDrive) : c'est celui qui CONTIENT le jeu qui gagne
  const dossier = docs.map(d => path.join(d, "Paradox Interactive", "Stellaris", "save games"))
    .find(d => fs.existsSync(d));
  if (!dossier) return null;
  const s = derniereSauvegarde(dossier);
  if (!s) return null;
  // 🗄️ une sauvegarde ne change qu'a l'autosave : inutile de deplier un zip toutes les dix secondes
  if (_cache.chemin === s.chemin && _cache.quand === s.quand) return _cache;
  const m = lireMeta(entreeZip(s.chemin, "meta").toString("utf8"));
  const info = { jeu: "Stellaris", nom: m.nom, date: m.date, version: m.version,
    dlcs: m.dlcs.length, flottes: m.flottes, planetes: m.planetes, portrait: m.portrait,
    fichier: path.basename(s.chemin), quand: s.quand, drapeau: false };
  let image = null;
  try {
    const noms = couleurs(racineJeu);
    const c = (m.flag.couleurs || []).map(n => noms[n] || [128, 128, 128]);
    while (c.length < 3) c.push([128, 128, 128]);
    const fond = dds(path.join(racineJeu, "flags", m.flag.fond.categorie, m.flag.fond.fichier));
    let icone = null;
    try { icone = dds(path.join(racineJeu, "flags", m.flag.icone.categorie, m.flag.icone.fichier)); } catch (e) {}
    const im = composer(fond, icone, c);
    image = png(im.w, im.h, im.px);
    info.drapeau = true;
    info.teintes = (m.flag.couleurs || []).slice(0, 3);
  } catch (e) { info.erreurDrapeau = e.message; }
  _cache = { chemin: s.chemin, quand: s.quand, info, png: image };
  return _cache;
}

/* 📇 UN JEU = UNE FONCTION. Le pont ne connait que ce registre : ajouter Crusader Kings ou Rimworld
   ne demande de toucher a rien d'autre. Ce qui NE se generalise pas, c'est le contenu de la
   fonction — chaque editeur invente son format. Ce qui se generalise, c'est tout le reste du pont. */
const LECTEURS = { "281990": lireStellaris };
module.exports = {
  connait: appid => !!LECTEURS[appid],
  lire: (appid, racineJeu, docs) => {
    const f = LECTEURS[appid];
    if (!f) return null;
    try { return f(racineJeu, docs); } catch (e) { return { info: { erreur: e.message }, png: null }; }
  },
};
