#!/usr/bin/env bash
# Smoke test for a built Professor Voice Assistant.
#
# Starts the server (the Node.js backend entry point, or a Docker image with
# --docker), waits for /healthz, checks that the web UI is served, and stops
# it again. No speech services, no real Gemini key and no network access are
# needed: the server starts without them and /healthz only checks the backend.
#
#   bash scripts/ci/smoke-test.sh backend/src/server.js
#   bash scripts/ci/smoke-test.sh --docker professor-voice-assistant:ci
set -euo pipefail

PORT="${SMOKE_PORT:-18090}"
BASE="http://127.0.0.1:${PORT}"
WORK="$(mktemp -d)"
PID=""
CONTAINER=""

cleanup() {
  if [[ -n "$PID" ]]; then kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true; fi
  if [[ -n "$CONTAINER" ]]; then docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT

show_logs() {
  echo "----- server log -----"
  if [[ -n "$CONTAINER" ]]; then docker logs "$CONTAINER" 2>&1 | tail -n 60 || true
  else tail -n 60 "$WORK/server.log" 2>/dev/null || true; fi
}

if [[ "${1:-}" == "--docker" ]]; then
  IMAGE="${2:?usage: smoke-test.sh --docker <image>}"
  CONTAINER="pva-smoke-$$"
  docker run -d --name "$CONTAINER" -p "127.0.0.1:${PORT}:8090" \
    -e GEMINI_API_KEY=ci-smoke-placeholder \
    -e WEB_SEARCH_PROVIDER=none \
    "$IMAGE" >/dev/null
else
  BIN="$(cd "$(dirname "${1:?usage: smoke-test.sh <backend/src/server.js>}")" && pwd)/$(basename "$1")"
  (
    cd "$WORK"
    VOICE_ADDR="127.0.0.1:${PORT}" \
    GEMINI_API_KEY=ci-smoke-placeholder \
    WEB_SEARCH_PROVIDER=none \
    RAG_STORAGE_PATH="$WORK/data/rag" \
    PROFESSOR_DATA_PATH="$WORK/data/professor" \
    AURA_ENV_FILE=/nonexistent \
    exec node "$BIN"
  ) >"$WORK/server.log" 2>&1 &
  PID=$!
fi

echo "Waiting for ${BASE}/healthz ..."
for i in $(seq 1 60); do
  if body="$(curl -fsS "${BASE}/healthz" 2>/dev/null)"; then
    echo "healthz: ${body}"
    break
  fi
  if [[ -n "$PID" ]] && ! kill -0 "$PID" 2>/dev/null; then
    echo "::error::server exited during startup"; show_logs; exit 1
  fi
  if [[ "$i" == 60 ]]; then echo "::error::server did not become healthy in 30s"; show_logs; exit 1; fi
  sleep 0.5
done

grep -q '"status":"ok"' <<<"$body" || { echo "::error::unexpected /healthz body: $body"; show_logs; exit 1; }

code="$(curl -s -o "$WORK/index.html" -w '%{http_code}' "${BASE}/")"
if [[ "$code" != "200" ]] || ! grep -qi '<html' "$WORK/index.html"; then
  echo "::error::web UI not served (HTTP $code)"; show_logs; exit 1
fi
echo "web UI: HTTP 200"

# /readyz reports the local speech services; they are absent in CI, so only
# check that the endpoint answers (any HTTP status), not that it is ready.
code="$(curl -s --max-time 20 -o /dev/null -w '%{http_code}' "${BASE}/readyz" || true)"
echo "readyz: HTTP ${code} (speech services are not running in CI; informational only)"

echo "Smoke test passed."
