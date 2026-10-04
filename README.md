# 9Router Tunnel Relay

Relay publik minimal untuk mengekspos 9Router yang jalan di VM lewat URL publik,
tanpa butuh inbound connection (Cloudflare quick tunnel diblokir jaringan VM).

## Cara kerja

- `relay.js` jalan di Render (free tier). Menerima koneksi WebSocket dari client
  dan meneruskan HTTP publik ke client tersebut.
- `tunnel-client.js` jalan di VM di sebelah 9Router. Dial **keluar** ke relay
  lewat `wss` (lolos egress proxy; pakai `https-proxy-agent` kalau proxy
  dikonfigurasi), auto-reconnect kalau Render sleep/wake.
- `watchdog.sh` dijalankan cron tiap 5 menit di VM: me-reinstall `9router`
  (global npm hilang tiap VM diganti) dan me-restart 9Router / tunnel client
  yang mati. 9Router di-start dengan `INITIAL_PASSWORD=123456`.

Karena 9Router memakai redirect dan path absolut (`/dashboard`, `/_next/...`,
`/api/...`), satu-satunya tunnel yang terdaftar disajikan langsung di **root**
relay (bukan sub-path) — jadi semua redirect dan asset dashboard jalan normal.
Path lama `/t/<TUNNEL_ID>/*` tetap didukung.

## Keamanan

Root relay bersifat publik, jadi ada password gate: set env `TUNNEL_PASSWORD`
di Render. Kunjungan pertama menampilkan form login; sukses → cookie HttpOnly
HMAC 30 hari. `/health` tetap terbuka untuk keepalive.

## Deploy relay (Render)

1. Push repo ini ke GitHub (publik).
2. Render → New → Web Service → Public Git repository → repo ini.
   - Region: Singapore, Branch: main, Plan: **Free**
   - Build Command: `npm install`
   - Start Command: `node relay.js`
   - Environment → tambah `TUNNEL_PASSWORD` = password pilihanmu.
3. Dashboard 9Router: `https://<service>.onrender.com/` → masukkan tunnel
   password → login dashboard 9Router seperti biasa.

## Jalankan client (VM)

```bash
cd ~/workspace/9router-tunnel
npm install
RELAY_URL=https://<service>.onrender.com \
TUNNEL_ID=<id-acak-32-hex> \
node tunnel-client.js
```

`TUNNEL_ID` hanya dipakai untuk registrasi WebSocket client (tidak lagi bagian
dari URL publik).
