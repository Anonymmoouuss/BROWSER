#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "$(id -u)" = 0 ]]; then
  mkdir -p db
  chown -R node:node db
  exec gosu node bash "$0" "$@"
fi
if [[ -n "${BACKEND_ORIGIN:-}" ]]; then
  printf 'BACKEND_ORIGIN belongs on Vercel, not on the backend container.\n' >&2
  exit 1
fi
if [[ ! -s db/custom.db ]]; then cp prisma/empty.db db/custom.db; fi
chmod 700 db
if [[ -f db/access-engine.key ]]; then chmod 600 db/access-engine.key; fi
export GATEWAY_PORT="${PORT:-8080}"
export CADDY_ADDRESS=":$GATEWAY_PORT"
export DATABASE_URL="${DATABASE_URL:-file:$PWD/db/custom.db}"
children=()

cleanup() {
  trap - EXIT TERM INT
  for child in "${children[@]}"; do kill -TERM "$child" 2>/dev/null || true; done
  wait || true
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

env PORT=3000 HOSTNAME=0.0.0.0 node server.js &
children+=("$!")
bun mini-services/browser-backend/index.ts &
children+=("$!")
node mini-services/scramjet/index.js &
children+=("$!")
node mini-services/face-auth/index.js &
children+=("$!")
caddy run --config Caddyfile --adapter caddyfile &
children+=("$!")
wait -n
printf 'A backend service exited; restarting the container is required.\n' >&2
exit 1