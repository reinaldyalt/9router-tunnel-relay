# 9Router Tunnel Relay

Relay publik minimal untuk mengekspos 9Router yang jalan di VM lewat URL publik,
tanpa butuh inbound connection (Cloudflare quick tunnel diblokir jaringan VM).

## Cara kerja

- `relay.js` jalan di Render (free tier). Menerima koneksi WebSocket dari client
  dan meneruskan HTTP publik `GET /t/<TUNNEL_ID>/*` ke client tersebut.
- `tunnel-client.js` jalan di VM di sebelah 9Router. Dial **keluar** ke relay
  lewat `wss` (lolos egress proxy), auto-reconnect kalau Render sleep/wake.

## Deploy relay (Render)

1. Push repo ini ke GitHub (publik).
2. Render → New → Web Service → Public Git repository → repo ini.
   - Region: Singapore, Branch: main, Plan: **Free**
   - Build Command: `npm install`
   - Start Command: `node relay.js`
3. Catat URL-nya, mis. `https://nine-tunnel-xxxx.onrender.com`.

## Jalankan client (VM)

```bash
cd ~/workspace/9router-tunnel
npm install
RELAY_URL=https://<relay>.onrender.com \
TUNNEL_ID=<id-acak-32-hex> \
node tunnel-client.js
```

Dashboard 9Router lalu bisa dibuka di:

```
https://<relay>.onrender.com/t/<TUNNEL_ID>/
```

Login dashboard pakai password 9Router seperti biasa. `TUNNEL_ID` adalah
bagian dari URL — perlakukan seperti secret (tidak bisa ditebak).
