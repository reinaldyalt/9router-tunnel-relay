// tunnel-client.js — runs on the VM next to 9Router.
//
// Dials OUT to the relay over wss (works through the egress proxy) and
// forwards relayed HTTP requests to the local TARGET (9Router).
// Auto-reconnects with backoff, so Render free-tier sleep/wake is handled.
//
// Env:
//   RELAY_URL  e.g. https://nine-router-tunnel.onrender.com
//   TUNNEL_ID  unguessable id (also the public path: <RELAY_URL>/t/<TUNNEL_ID>/)
//   TARGET     local service to expose (default http://127.0.0.1:20128)

const http = require("http");
const { URL } = require("url");
const WebSocket = require("ws");

const RELAY_URL = process.env.RELAY_URL;
const TUNNEL_ID = process.env.TUNNEL_ID;
const TARGET = process.env.TARGET || "http://127.0.0.1:20128";

if (!RELAY_URL || !TUNNEL_ID) {
  console.error("Set RELAY_URL and TUNNEL_ID env vars.");
  process.exit(1);
}

function wsUrl() {
  const u = new URL("/tunnel", RELAY_URL);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.searchParams.set("id", TUNNEL_ID);
  return u.toString();
}

function send(ws, obj) {
  if (ws.readyState === 1) {
    try {
      ws.send(JSON.stringify(obj));
    } catch (_) {}
  }
}

function forward(ws, msg) {
  let target;
  try {
    target = new URL(msg.path + (msg.query || ""), TARGET);
  } catch (_) {
    send(ws, { type: "res-error", id: msg.id });
    return;
  }
  const headers = { ...(msg.headers || {}) };
  delete headers["host"];
  delete headers["connection"];
  delete headers["content-length"];
  const preq = http.request(
    target,
    { method: msg.method, headers },
    (pres) => {
      send(ws, {
        type: "res-head",
        id: msg.id,
        status: pres.statusCode,
        headers: pres.headers,
      });
      pres.on("data", (c) =>
        send(ws, { type: "res-chunk", id: msg.id, data: c.toString("base64") })
      );
      pres.on("end", () => send(ws, { type: "res-end", id: msg.id }));
      pres.on("error", () => send(ws, { type: "res-error", id: msg.id }));
    }
  );
  preq.on("error", () => send(ws, { type: "res-error", id: msg.id }));
  preq.setTimeout(110000, () => preq.destroy());
  if (msg.body) preq.write(Buffer.from(msg.body, "base64"));
  preq.end();
}

let backoff = 1000;

function connect() {
  const url = wsUrl();
  console.log(`[client] connecting to relay...`);
  const ws = new WebSocket(url);

  const hb = setInterval(() => {
    if (ws.readyState === 1) send(ws, { type: "ping" });
  }, 25000);

  ws.on("open", () => {
    backoff = 1000;
    console.log(`[client] tunnel connected -> ${TARGET}`);
  });
  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (_) {
      return;
    }
    if (msg.type === "pong") return;
    if (msg.type === "req") forward(ws, msg);
  });
  const retry = () => {
    clearInterval(hb);
    try {
      ws.removeAllListeners();
    } catch (_) {}
    const wait = backoff;
    backoff = Math.min(backoff * 2, 30000);
    console.log(`[client] disconnected, retry in ${wait}ms`);
    setTimeout(connect, wait);
  };
  ws.on("close", retry);
  ws.on("error", () => {
    /* close follows */
  });
}

connect();
