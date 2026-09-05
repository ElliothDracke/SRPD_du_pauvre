// Sonde jetable : que peut-on lire dans le contexte JS interne de Steam ?
const WebSocket = require("ws");
const ev = (url, expr) => new Promise((res, rej) => {
  const ws = new WebSocket(url, { perMessageDeflate: false });
  const t = setTimeout(() => { try { ws.close(); } catch (e) {} rej(new Error("timeout")); }, 8000);
  ws.on("open", () => ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate",
    params: { expression: expr, returnByValue: true, awaitPromise: true } })));
  ws.on("message", d => { const m = JSON.parse(d.toString()); if (m.id !== 1) return;
    clearTimeout(t); try { ws.close(); } catch (e) {}
    if (m.error) return rej(new Error(m.error.message));
    const r = m.result && m.result.result;
    if (r && r.subtype === "error") return rej(new Error(r.description || "erreur"));
    res(r ? r.value : null); });
  ws.on("error", e => { clearTimeout(t); rej(e); });
});

(async () => {
  const cibles = await (await fetch("http://127.0.0.1:8080/json")).json();
  const sjc = cibles.find(c => c.title === "SharedJSContext");
  if (!sjc) return console.log("SharedJSContext introuvable");

  const q = async (nom, expr) => {
    try { const v = await ev(sjc.webSocketDebuggerUrl, expr);
      console.log("\n── " + nom + " ──\n" + JSON.stringify(v, null, 1).slice(0, 1400));
    } catch (e) { console.log("\n── " + nom + " ── erreur : " + e.message); }
  };

  await q("m_FriendsUIFriendStore : ses membres",
    `(() => { const f = friendStore.m_FriendsUIFriendStore; if(!f) return "absent";
       const o = []; let p = f; for (let d=0; d<3 && p; d++, p = Object.getPrototypeOf(p)) o.push(...Object.getOwnPropertyNames(p));
       return [...new Set(o)].filter(k=>!k.startsWith("__")).slice(0,90); })()`);

  await q("mon propre profil",
    `(() => { const f = friendStore.m_FriendsUIFriendStore;
       for (const n of ["GetMySelf","GetSelf","MySelf","GetMyPersona","m_self","self"]) {
         try { const v = typeof f[n] === "function" ? f[n].call(f) : f[n];
           if (v) return { via: n, cles: Object.getOwnPropertyNames(v).slice(0,50) }; } catch(e){}
       }
       return "aucun accesseur evident"; })()`);

  await q("tout ce qui ressemble a du rich presence",
    `(() => { const out=[]; const f=friendStore.m_FriendsUIFriendStore;
       let p=f; for(let d=0;d<3&&p;d++,p=Object.getPrototypeOf(p))
         out.push(...Object.getOwnPropertyNames(p).filter(k=>/rich|presence|display|status/i.test(k)));
       return [...new Set(out)]; })()`);
})();
