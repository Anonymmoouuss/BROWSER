#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$PWD"
export APP_MODE="${APP_MODE:-development}"
export GATEWAY_PORT="${GATEWAY_PORT:-8080}"
export CADDY_ADDRESS="${CADDY_ADDRESS:-:$GATEWAY_PORT}"
if [[ -n "${CODESPACE_NAME:-}" ]]; then
  export FORWARDED_PROTO="${FORWARDED_PROTO:-https}"
fi
START_APP="${START_APP:-1}"
START_GATEWAY="${START_GATEWAY:-1}"
START_WATCHDOG="${START_WATCHDOG:-1}"
if [[ "$APP_MODE" = production ]]; then START_WATCHDOG=0; fi

say() { printf '[start-all] %s\n' "$*"; }
for executable in bun node curl setsid; do
  command -v "$executable" >/dev/null || { say "Missing prerequisite: $executable (see SETUP.md)"; exit 1; }
done
node -e 'if (Number(process.versions.node.split(".")[0]) < 20) process.exit(1)' || {
  say "Node.js 20.9 or newer is required"; exit 1;
}
if [[ "$START_GATEWAY" = 1 ]]; then
  command -v caddy >/dev/null || { say "Install Caddy or use START_GATEWAY=0 (see SETUP.md)"; exit 1; }
fi
mkdir -p .runtime db
if [[ ! -f .env ]]; then cp .env.example .env; fi
if [[ ! -d node_modules ]]; then bun install --frozen-lockfile; fi
bun run db:generate
bun run db:push
for service in scramjet face-auth; do
  if [[ ! -d "mini-services/$service/node_modules" ]]; then
    bun install --cwd "mini-services/$service" --frozen-lockfile
  fi
done
if [[ "$START_APP" = 1 && "$APP_MODE" = production && ! -f .next/standalone/server.js ]]; then
  bun run build
fi

start_service() {
  local name="$1" port="$2" path="$3" directory="$4"
  shift 4
  if curl --fail --silent --max-time 2 "http://127.0.0.1:$port$path" >/dev/null; then
    say "$name :$port is already healthy"
    return
  fi
  local pidfile="$ROOT/.runtime/$name.pid"
  if [[ -f "$pidfile" ]] && kill -0 "$(<"$pidfile")" 2>/dev/null; then
    say "$name is already starting (see .runtime/$name.log)"
    return
  fi
  say "Starting $name :$port"
  (cd "$directory" && exec nohup setsid "$@" >> "$ROOT/.runtime/$name.log" 2>&1 < /dev/null) &
  printf '%s\n' "$!" > "$pidfile"
}

if [[ "$START_APP" = 1 ]]; then
  if [[ "$APP_MODE" = production ]]; then
    start_service app 3000 /api/health "$ROOT" bun run start
  else
    start_service app 3000 /api/health "$ROOT" bun run dev
  fi
fi
start_service browser-backend 3030 /health "$ROOT/mini-services/browser-backend" bun index.ts
start_service scramjet 3031 /health "$ROOT/mini-services/scramjet" node supervisor.mjs
start_service face-auth 3032 /health "$ROOT/mini-services/face-auth" node index.js
if [[ "$START_WATCHDOG" = 1 ]]; then
  start_service watchdog 3034 /health "$ROOT/mini-services/watchdog" node index.js
fi
if [[ "$START_GATEWAY" = 1 ]]; then
  start_service gateway "$GATEWAY_PORT" /api/health "$ROOT" caddy run --config Caddyfile --adapter caddyfile
fi
CHECK_APP="$START_APP" CHECK_GATEWAY="$START_GATEWAY" CHECK_WATCHDOG="$START_WATCHDOG" \
  node scripts/healthcheck.mjs --wait
say "Ready: http://localhost:$GATEWAY_PORT (logs: .runtime/)"
