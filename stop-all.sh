#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

for service in watchdog gateway browser-backend scramjet face-auth app; do
  if [[ "$service" = app && "${STOP_APP:-1}" = 0 ]]; then continue; fi
  pidfile=".runtime/$service.pid"
  if [[ ! -f "$pidfile" ]]; then continue; fi
  pid="$(<"$pidfile")"
  if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
    directory="$(readlink "/proc/$pid/cwd" 2>/dev/null || true)"
    if [[ "$directory" = "$PWD" || "$directory" = "$PWD/mini-services/"* ]]; then
      kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
      printf '[stop-all] Stopped %s (process group %s)\n' "$service" "$pid"
    else
      printf '[stop-all] Skipping reused or unmanaged PID %s\n' "$pid"
    fi
  fi
  rm -f "$pidfile"
done
