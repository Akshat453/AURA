#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
RUN="$ROOT/runtime/run"
for name in demo assistant rag piper-hi piper-en whisper-multi whisper; do
  pidfile="$RUN/$name.pid"
  [[ -f "$pidfile" ]] || continue
  pid=$(cat "$pidfile")
  if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
    command=$(ps -p "$pid" -o command= 2>/dev/null || true)
    case "$name:$command" in
      assistant:*backend/src/server.js*|demo:*backend/src/server.js*|piper-hi:*piper.http_server*|piper-en:*piper.http_server*|whisper:*whisper-server*|whisper-multi:*whisper-server*|rag:*rag_sidecar.py*) kill "$pid"; echo "Stopped $name" ;;
      *) echo "Refusing to stop PID $pid: it is not the recorded $name process" >&2 ;;
    esac
  fi
  rm -f "$pidfile" "$RUN/$name.cmd"
done
