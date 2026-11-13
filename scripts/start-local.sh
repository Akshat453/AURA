#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
RUN="$ROOT/runtime/run"
LOG="$ROOT/runtime/log"
mkdir -p "$RUN" "$LOG"
if [[ -f "$ROOT/.env" ]]; then set -a; source "$ROOT/.env"; set +a; fi
: "${GEMINI_API_KEY:?Set GEMINI_API_KEY in $ROOT/.env before starting services}"
cd "$ROOT"

WHISPER_MODEL=${WHISPER_MODEL:-models/whisper/ggml-small.bin}
# Hindi, Hinglish and auto-detection use a second, more accurate model.
# Set WHISPER_MULTILINGUAL_URL= (empty) in .env to run a single server.
WHISPER_MULTILINGUAL_URL=${WHISPER_MULTILINGUAL_URL-http://127.0.0.1:8082}
WHISPER_MULTILINGUAL_MODEL=${WHISPER_MULTILINGUAL_MODEL:-models/whisper/ggml-large-v3-turbo-q5_0.bin}
[[ -z "$WHISPER_MULTILINGUAL_URL" ]] || [[ -e "$WHISPER_MULTILINGUAL_MODEL" ]] || { echo "Missing $WHISPER_MULTILINGUAL_MODEL; run scripts/setup-local.sh first" >&2; exit 1; }
for required in \
  "$ROOT/runtime/whisper.cpp/build/bin/whisper-server" \
  "$WHISPER_MODEL" \
  "$ROOT/runtime/piper-venv/bin/python"; do
  [[ -e "$required" ]] || { echo "Missing $required; run scripts/setup-local.sh first" >&2; exit 1; }
done

# port_of extracts the port from a service URL in .env, so each local service
# listens exactly where the assistant will look for it.
port_of() {
  local hostport=${1#*://}
  hostport=${hostport%%/*}
  if [[ "$hostport" != *:* || ! "${hostport##*:}" =~ ^[0-9]+$ ]]; then
    echo "$2 must include an explicit port, e.g. http://127.0.0.1:8081 (got '$1')" >&2
    exit 1
  fi
  echo "${hostport##*:}"
}
WHISPER_PORT=$(port_of "${WHISPER_URL:-http://127.0.0.1:8081}" WHISPER_URL)
PIPER_EN_PORT=$(port_of "${PIPER_EN_URL:-http://127.0.0.1:5000}" PIPER_EN_URL)
PIPER_HI_PORT=$(port_of "${PIPER_HI_URL:-http://127.0.0.1:5001}" PIPER_HI_URL)
[[ -z "$WHISPER_MULTILINGUAL_URL" ]] || WHISPER_MULTILINGUAL_PORT=$(port_of "$WHISPER_MULTILINGUAL_URL" WHISPER_MULTILINGUAL_URL)
RAG_SIDECAR_PORT=$(port_of "${RAG_SIDECAR_URL:-http://127.0.0.1:8084}" RAG_SIDECAR_URL)
RAG_MODEL_DIR=${RAG_EMBEDDING_MODEL_DIR:-models/embeddings/multilingual-e5-small}
# Seconds ggml keeps Whisper's Metal buffers wired after the last request
# (ggml's own default is 180 s); see docs/STT_EVALUATION.md "Idle latency".
WHISPER_RESIDENCY_KEEP_ALIVE_S=${WHISPER_RESIDENCY_KEEP_ALIVE_S:-3600}
STARTED=" "
trap 'echo "start-local interrupted: services already started keep running; stop them with ./scripts/stop-local.sh" >&2; exit 130' INT TERM

start_one() {
  local name=$1; shift
  local pidfile="$RUN/$name.pid" cmdfile="$RUN/$name.cmd"
  if [[ -f "$pidfile" ]] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    # A running process keeps executing its old code and settings, so restart it
    # when its executable was rebuilt or its command line (model, voice) changed.
    if [[ "$*${STAMP:-}" == "$(cat "$cmdfile" 2>/dev/null)" && ! "$1" -nt "$pidfile" ]]; then echo "$name is already running"; return; fi
    echo "Restarting $name (binary or configuration changed)"
    kill "$(cat "$pidfile")"
    for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$(cat "$pidfile")" 2>/dev/null || break; sleep 0.3; done
  fi
  nohup "$@" >"$LOG/$name.log" 2>&1 &
  echo $! >"$pidfile"
  echo "$*${STAMP:-}" >"$cmdfile"
  STARTED="$STARTED$name "
  echo "Started $name (PID $!)"
}

# wait_ready polls a service until it answers, failing fast (with its log)
# if the process exits, e.g. a model that cannot load or a port in use.
wait_ready() {
  local name=$1 url=$2 pid
  pid=$(cat "$RUN/$name.pid" 2>/dev/null) || return 0
  for _ in $(seq 1 240); do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "$name exited during startup; last log lines ($LOG/$name.log):" >&2
      tail -n 8 "$LOG/$name.log" >&2
      exit 1
    fi
    curl -s -o /dev/null --max-time 2 "$url" && return 0
    sleep 0.5
  done
  echo "$name did not become ready within 120 s; inspect $LOG/$name.log" >&2
  exit 1
}

# warm_whisper runs one short inference on a freshly started Whisper server so
# Metal kernels and model buffers are ready before the first real question.
warm_whisper() {
  local name=$1 url=$2 t
  [[ "$STARTED" == *" $name "* ]] || return 0
  t=$(curl -s -o /dev/null -w '%{time_total}' --max-time 60 "$url/inference" -F file=@"$ROOT/runtime/whisper.cpp/samples/jfk.wav" -F language=en -F response_format=json) \
    && echo "Warmed $name (${t}s)" || echo "Warm-up of $name failed (it will warm on first use)" >&2
}

export GGML_METAL_RESIDENCY_KEEP_ALIVE_S=$WHISPER_RESIDENCY_KEEP_ALIVE_S
STAMP=" keepalive:$WHISPER_RESIDENCY_KEEP_ALIVE_S" start_one whisper "$ROOT/runtime/whisper.cpp/build/bin/whisper-server" --host 127.0.0.1 --port "$WHISPER_PORT" --model "$WHISPER_MODEL" --language auto
if [[ -n "$WHISPER_MULTILINGUAL_URL" ]]; then
  STAMP=" keepalive:$WHISPER_RESIDENCY_KEEP_ALIVE_S" start_one whisper-multi "$ROOT/runtime/whisper.cpp/build/bin/whisper-server" --host 127.0.0.1 --port "$WHISPER_MULTILINGUAL_PORT" --model "$WHISPER_MULTILINGUAL_MODEL" --language auto
elif [[ -f "$RUN/whisper-multi.pid" ]] && kill -0 "$(cat "$RUN/whisper-multi.pid")" 2>/dev/null \
  && ps -p "$(cat "$RUN/whisper-multi.pid")" -o command= | grep -q whisper-server; then
  kill "$(cat "$RUN/whisper-multi.pid")"; rm -f "$RUN/whisper-multi.pid" "$RUN/whisper-multi.cmd"
  echo "Stopped whisper-multi (WHISPER_MULTILINGUAL_URL is empty)"
fi
unset GGML_METAL_RESIDENCY_KEEP_ALIVE_S
start_one piper-en "$ROOT/runtime/piper-venv/bin/python" -m piper.http_server -m "${PIPER_EN_VOICE:-en_US-lessac-medium}" --data-dir "$ROOT/models/piper" --host 127.0.0.1 --port "$PIPER_EN_PORT"
start_one piper-hi "$ROOT/runtime/piper-venv/bin/python" -m piper.http_server -m "${PIPER_HI_VOICE:-hi_IN-priyamvada-medium}" --data-dir "$ROOT/models/piper" --host 127.0.0.1 --port "$PIPER_HI_PORT"
# Local document search (embeddings + PDF extraction). Without it the assistant
# still runs; document search falls back to keywords and PDFs cannot be indexed.
if [[ "${RAG_ENABLED:-true}" == "true" ]]; then
  if [[ -x "$ROOT/runtime/rag-venv/bin/python" && -f "$RAG_MODEL_DIR/model.onnx" ]]; then
    start_one rag "$ROOT/runtime/rag-venv/bin/python" "$ROOT/scripts/rag_sidecar.py" --model-dir "$RAG_MODEL_DIR" \
      --model-name "${RAG_EMBEDDING_MODEL:-intfloat/multilingual-e5-small}" --host 127.0.0.1 --port "$RAG_SIDECAR_PORT"
  else
    echo "RAG sidecar not installed (run scripts/setup-local.sh); document search will be keyword-only" >&2
  fi
fi
# Node.js backend: install dependencies when missing or when the lockfile changed.
command -v node >/dev/null || { echo "Missing prerequisite: node (Node.js 24 LTS or newer)" >&2; exit 1; }
if [[ ! -d "$ROOT/backend/node_modules" || "$ROOT/backend/package-lock.json" -nt "$ROOT/backend/node_modules/.package-lock.json" ]]; then
  npm ci --prefix "$ROOT/backend" --no-audit --no-fund
fi
# The assistant reads its settings from the environment, so .env edits restart it;
# so do changes to the backend code or web UI (hash of the sources).
CODE_STAMP=$(find "$ROOT/backend/src" "$ROOT/backend/public" "$ROOT/backend/package-lock.json" -type f -print0 | sort -z | xargs -0 shasum | shasum | cut -c1-12)
STAMP=" env:$(cat "$ROOT/.env" 2>/dev/null | shasum | cut -c1-12) code:$CODE_STAMP" start_one assistant node "$ROOT/backend/src/server.js"
# Readiness: every service must answer before we report success.
wait_ready whisper "http://127.0.0.1:$WHISPER_PORT/"
[[ -z "$WHISPER_MULTILINGUAL_URL" ]] || wait_ready whisper-multi "http://127.0.0.1:$WHISPER_MULTILINGUAL_PORT/"
wait_ready piper-en "http://127.0.0.1:$PIPER_EN_PORT/info"
wait_ready piper-hi "http://127.0.0.1:$PIPER_HI_PORT/info"
[[ "${RAG_ENABLED:-true}" != "true" || ! -f "$RUN/rag.pid" ]] || wait_ready rag "http://127.0.0.1:$RAG_SIDECAR_PORT/"
wait_ready assistant "http://${VOICE_ADDR:-127.0.0.1:8090}/healthz"
warm_whisper whisper "http://127.0.0.1:$WHISPER_PORT"
[[ -z "$WHISPER_MULTILINGUAL_URL" ]] || warm_whisper whisper-multi "http://127.0.0.1:$WHISPER_MULTILINGUAL_PORT"
echo "All services ready. Open http://${VOICE_ADDR:-127.0.0.1:8090}"
