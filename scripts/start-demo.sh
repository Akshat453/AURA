#!/usr/bin/env bash
# Starts a second assistant (Node.js backend) on DEMO_ADDR (default http://127.0.0.1:8091) that
# uses the seeded demo databases in DEMO_DATA_PATH (default ./data/demo).
# The professor's own data and the main app on 8090 are not touched.
#   ./scripts/start-demo.sh        start (seeds the demo data first if needed)
#   ./scripts/start-demo.sh stop   stop only the demo instance
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
RUN="$ROOT/runtime/run"
PIDFILE="$RUN/demo.pid"
mkdir -p "$RUN" "$ROOT/runtime/log"

stop_demo() {
  [[ -f "$PIDFILE" ]] || { echo "Demo is not running"; return; }
  local pid; pid=$(cat "$PIDFILE")
  if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
    if ps -p "$pid" -o command= | grep -q backend/src/server.js; then kill "$pid"; echo "Stopped demo"
    else echo "Refusing to stop PID $pid: it is not the demo assistant" >&2; fi
  fi
  rm -f "$PIDFILE"
}
if [[ "${1:-}" == "stop" ]]; then stop_demo; exit 0; fi

# Speech recognition, voices and the embedding sidecar are shared with the main app.
"$ROOT/scripts/start-local.sh"

if [[ -f "$ROOT/.env" ]]; then set -a; source "$ROOT/.env"; set +a; fi
DEMO="${DEMO_DATA_PATH:-./data/demo}"
ADDR="${DEMO_ADDR:-127.0.0.1:8091}"
[[ -f "$DEMO/professor/professor.db" ]] || node "$ROOT/backend/bin/db.js" seed

if [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  stop_demo # restart so a rebuilt binary or changed .env is picked up
fi
# Integrations that act outside this Mac stay off in the demo.
VOICE_ADDR="$ADDR" PROFESSOR_DATA_PATH="$DEMO/professor" RAG_STORAGE_PATH="$DEMO/rag" DEVICE_ADDR= \
  GOOGLE_CALENDAR_ENABLED=false GMAIL_DRAFTS_ENABLED=false REMINDER_MACOS_NOTIFICATIONS=false \
  nohup node "$ROOT/backend/src/server.js" >"$ROOT/runtime/log/demo.log" 2>&1 &
echo $! >"$PIDFILE"
for _ in $(seq 1 120); do
  if curl -fs "http://$ADDR/healthz" >/dev/null 2>&1; then echo "Demo ready. Open http://$ADDR"; exit 0; fi
  kill -0 "$(cat "$PIDFILE")" 2>/dev/null || { echo "The demo assistant exited:"; tail -n 20 "$ROOT/runtime/log/demo.log"; exit 1; }
  sleep 0.25
done
echo "The demo assistant did not answer in 30 s; see runtime/log/demo.log"; exit 1
