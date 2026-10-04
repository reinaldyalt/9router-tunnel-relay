// relay.js — public relay for the 9Router tunnel.
//
// The tunnel client (tunnel-client.js) dials OUT from the VM over wss and
// registers a tunnel id. Public HTTP traffic to /t/<id>/* is forwarded over
// that socket to the client's local target (the 9Router dashboard/API).
//
// Endpoints:
//   GET /health          -> {ok:true}
//   WS  /tunnel?id=<id>  -> tunnel client registration
//   *   /t/<id>/*        -> proxied to the tunnel client

const http = require("http");
const { WebSocketServer } = require("ws");

const MAX_BODY = 10 * 1024 * 1024; // 10 MB
const REQ_TIMEOUT_MS = 120000;
const ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

const tunnels = new Map(); // id -> ws
const pending = new Map(); // reqId -> { res, timer }
let reqSeq = 0;

function sendJson(ws, obj) {
  if (ws.readyState === 1) {
    try {
      ws.send(JSON.stringify(obj));
    } catch (_) {}
  }
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
    res.end(JSON.stringify({ ok: true, tunnels: tunnels.size }));
    return;
  }

  const m = url.pathname.match(/^\/t\/([A-Za-z0-9_-]+)(\/.*)?$/);
  if (!m || !ID_RE.test(m[1])) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return;
  }
  const id = m[1];
  const ws = tunnels.get(id);
  if (!ws || ws.readyState !== 1) {
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
    const rest = m[2] || "/";
    const timer = setTimeout(() => {
      pending.delete(reqId);
      if (!res.writableEnded) {
        res.writeHead(504, { "content-type": "text/plain" });
        res.end("tunnel timeout");
      }
    }, REQ_TIMEOUT_MS);
    pending.set(reqId, { res, timer });
    sendJson(ws, {
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

// Drop dead client sockets so a stale registration never answers 200.
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
