#!/bin/bash
# Watchdog: keeps 9Router and the tunnel client running on the VM.
# VM replacements wipe /usr/lib (global npm) and kill processes, but ~
# persists — so reinstall what's missing, then (re)start what's dead.
# Safe to run every few minutes (idempotent).
export PATH=/usr/local/bin:/usr/bin:/bin
LOG=/tmp/9router-watchdog.log
ts() { date '+%F %T'; }

if ! pgrep -f "[9]router -n --skip-update" >/dev/null 2>&1; then
  if ! command -v 9router >/dev/null 2>&1; then
    echo "$(ts) 9router binary missing (VM was probably replaced) -> npm install -g 9router" >>"$LOG"
    npm install -g 9router --no-audit --no-fund >>"$LOG" 2>&1
  fi
  echo "$(ts) 9router not running -> starting" >>"$LOG"
  cd /home/hatch && INITIAL_PASSWORD=123456 nohup 9router -n --skip-update >>/tmp/9router.log 2>&1 &
fi

if ! pgrep -f "[t]unnel-client.js" >/dev/null 2>&1; then
  if [ ! -d /home/hatch/workspace/9router-tunnel/node_modules/ws ]; then
    echo "$(ts) tunnel deps missing -> npm install" >>"$LOG"
    cd /home/hatch/workspace/9router-tunnel && npm install --no-audit --no-fund >>"$LOG" 2>&1
  fi
  echo "$(ts) tunnel-client not running -> starting" >>"$LOG"
  cd /home/hatch/workspace/9router-tunnel \
    && RELAY_URL=https://ninerouter-tunnel.onrender.com TUNNEL_ID=$(cat .tunnel-id) \
       TARGET=http://127.0.0.1:20128 nohup node tunnel-client.js >>/tmp/tunnel-client.log 2>&1 &
fi
