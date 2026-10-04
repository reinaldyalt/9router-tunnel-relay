// relay.js — public relay for the 9Router tunnel (single-tunnel, root-serving).
//
// The tunnel client (tunnel-client.js) dials OUT from the VM over wss and
// registers a tunnel id. Public HTTP traffic is forwarded over that socket to
// the client's local target (the 9Router dashboard/API).
//
// Why root-serving: 9Router issues absolute-path redirects (e.g. / -> /dashboard)
// and references absolute asset/API paths (/_next/..., /api/...). Serving the
// tunnel under a sub-path (/t/<id>/) breaks all of that, so the single
// registered tunnel is served at the relay root. /t/<id>/* still works too.
//
// Security: because the relay root is effectively public, every forwarded
// request must pass a password gate (except /health and the /tunnel ws).
// Set TUNNEL_PASSWORD env var on the host. First visit shows a login form;
// success sets an HttpOnly HMAC cookie valid for 30 days.
//
// Endpoints:
//   GET  /health          -> {ok:true} (no auth, for keepalive)
//   GET  /__auth           -> password login form
//   POST /__auth           -> check password, set cookie, redirect to /
//   WS   /tunnel?id=<id>   -> tunnel client registration
//   *    /*                -> proxied to the tunnel client (auth required)

const http = require("http");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const MAX_BODY = 10 * 1024 * 1024; // 10 MB
const REQ_TIMEOUT_MS = 120000;
const ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const TUNNEL_PASSWORD = process.env.TUNNEL_PASSWORD || "";
const AUTH_COOKIE = "__tunnel_auth";
const COOKIE_MAX_AGE = 30 * 24 * 3600; // 30 days

const tunnels = new Map(); // id -> ws
const pending = new Map(); // reqId -> { res, timer, headSent }
let reqSeq = 0;

function expectedCookie() {
  return crypto.createHmac("sha256", TUNNEL_PASSWORD).update("tunnel-auth-v1").digest("hex");
}

function isAuthed(req) {
  if (!TUNNEL_PASSWORD) return true; // gate disabled when no password set
  const header = req.headers.cookie || "";
  const m = header.match(new RegExp(`${AUTH_COOKIE}=([a-f0-9]{64})`));
  if (!m) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(m[1], "utf8"), Buffer.from(expectedCookie(), "utf8"));
  } catch (_) {
    return false;
  }
}

function loginPage() {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>9Router Tunnel</title>
<style>body{background:#0b0e14;color:#e6e6e6;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{background:#151a24;border:1px solid #2a3344;border-radius:12px;padding:32px;width:min(360px,90vw);box-shadow:0 8px 32px rgba(0,0,0,.4)}
h1{font-size:20px;margin:0 0 8px}p{color:#9aa4b2;font-size:14px;margin:0 0 20px}
input{width:100%;box-sizing:border-box;background:#0b0e14;border:1px solid #2a3344;color:#e6e6e6;border-radius:8px;padding:12px;font-size:15px;margin-bottom:12px}
button{width:100%;background:#3b82f6;border:0;color:#fff;border-radius:8px;padding:12px;font-size:15px;cursor:pointer}
button:hover{background:#2563eb}</style></head><body>
<div class="card"><h1>9Router Tunnel</h1><p>Masukkan password tunnel untuk membuka dashboard.</p>
<form method="POST" action="/__auth"><input type="password" name="password" placeholder="Tunnel password" autocomplete="current-password" autofocus required><button type="submit">Buka Dashboard</button></form></div>
</body></html>`;
}

function sendJson(ws, obj) {
  if (ws.readyState === 1) {
    try {
      ws.send(JSON.stringify(obj));
    } catch (_) {}
  }
}

// Resolve which tunnel serves this request, and how many leading path
// characters to strip before forwarding.
function resolveTunnel(pathname) {
  const m = pathname.match(/^\/t\/([A-Za-z0-9_-]+)(\/.*)?$/);
  if (m && ID_RE.test(m[1])) {
    const ws = tunnels.get(m[1]);
    if (ws && ws.readyState === 1) return { ws, strip: 3 + m[1].length };
    return null;
  }
  if (tunnels.size === 1) {
    const ws = [...tunnels.values()][0];
    if (ws && ws.readyState === 1) return { ws, strip: 0 };
  }
  return null;
}

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, "http://x");
  } catch (_) {
    res.writeHead(400);
    res.end("bad request");
    return;
  }

  if (url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (url.pathname === "/__auth") {
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(loginPage());
      return;
    }
    if (req.method === "POST") {
      let body = "";
      req.on("data", (c) => {
        body += c.toString();
        if (body.length > 4096) req.destroy();
      });
      req.on("end", () => {
        const pw = (body.match(/(?:^|&)password=([^&]*)/) || [])[1] || "";
        let ok = false;
        try {
          const a = Buffer.from(decodeURIComponent(pw.replace(/\+/g, " ")), "utf8");
          const b = Buffer.from(TUNNEL_PASSWORD, "utf8");
          ok = TUNNEL_PASSWORD.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
        } catch (_) {
          ok = false;
        }
        if (ok) {
          res.writeHead(302, {
            "set-cookie": `${AUTH_COOKIE}=${expectedCookie()}; HttpOnly; Secure; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}; Path=/`,
            location: "/",
          });
          res.end();
        } else {
          res.writeHead(401, { "content-type": "text/html; charset=utf-8" });
          res.end(loginPage().replace("</form>", '</form><p style="color:#f87171">Password salah.</p>'));
        }
      });
      return;
    }
  }

  // Password gate for everything forwarded to the tunnel.
  if (!isAuthed(req)) {
    res.writeHead(401, { "content-type": "text/html; charset=utf-8" });
    res.end(loginPage());
    return;
  }

  const target = resolveTunnel(url.pathname);
  if (!target) {
    res.writeHead(502, { "content-type": "text/plain" });
    res.end("tunnel offline");
    return;
  }

  const chunks = [];
  let size = 0;
  let aborted = false;
  req.on("data", (c) => {
    size += c.length;
    if (size > MAX_BODY) {
      aborted = true;
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on("aborted", () => {
    aborted = true;
  });
  req.on("error", () => {
    aborted = true;
  });
  req.on("end", () => {
    if (aborted || res.writableEnded) return;
    const reqId = "r" + ++reqSeq + "-" + Date.now().toString(36);
    const headers = { ...req.headers };
    delete headers["host"];
    delete headers["connection"];
    let rest = target.strip ? url.pathname.slice(target.strip) : url.pathname;
    if (!rest.startsWith("/")) rest = "/" + rest;
    const timer = setTimeout(() => {
      pending.delete(reqId);
      if (!res.writableEnded) {
        res.writeHead(504, { "content-type": "text/plain" });
        res.end("tunnel timeout");
      }
    }, REQ_TIMEOUT_MS);
    pending.set(reqId, { res, timer, headSent: false });
    sendJson(target.ws, {
      type: "req",
      id: reqId,
      method: req.method,
      path: rest,
      query: url.search || "",
      headers,
      body: size ? Buffer.concat(chunks).toString("base64") : null,
    });
  });
});

const wss = new WebSocketServer({ server, path: "/tunnel" });

wss.on("connection", (ws, req) => {
  let id = null;
  try {
    id = new URL(req.url, "http://x").searchParams.get("id");
  } catch (_) {}
  if (!id || !ID_RE.test(id)) {
    ws.close(4001, "bad id");
    return;
  }
  const old = tunnels.get(id);
  if (old && old !== ws) {
    try {
      old.close(4002, "replaced");
    } catch (_) {}
  }
  tunnels.set(id, ws);
  console.log(`[relay] tunnel registered: ${id} (total ${tunnels.size})`);
  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });
  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (_) {
      return;
    }
    if (msg.type === "ping") {
      sendJson(ws, { type: "pong" });
      return;
    }
    const p = pending.get(msg.id);
    if (!p) return;
    if (msg.type === "res-head") {
      if (!p.res.writableEnded && !p.headSent) {
        p.headSent = true;
        const h = { ...(msg.headers || {}) };
        delete h["transfer-encoding"];
        p.res.writeHead(msg.status || 200, h);
      }
    } else if (msg.type === "res-chunk") {
      if (p.headSent && !p.res.writableEnded) {
        p.res.write(Buffer.from(msg.data || "", "base64"));
      }
    } else if (msg.type === "res-end" || msg.type === "res-error") {
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (!p.res.writableEnded) {
        if (!p.headSent) {
          p.res.writeHead(msg.type === "res-error" ? 502 : 200);
        }
        p.res.end();
      }
    }
  });
  const cleanup = () => {
    if (tunnels.get(id) === ws) {
      tunnels.delete(id);
      console.log(`[relay] tunnel gone: ${id} (total ${tunnels.size})`);
    }
  };
  ws.on("close", cleanup);
  ws.on("error", cleanup);
});

// Drop dead client sockets so a stale registration never answers.
setInterval(() => {
  for (const [id, ws] of tunnels) {
    if (ws.isAlive === false) {
      try {
        ws.terminate();
      } catch (_) {}
      tunnels.delete(id);
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch (_) {}
  }
}, 30000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`[relay] listening on ${PORT}`));
