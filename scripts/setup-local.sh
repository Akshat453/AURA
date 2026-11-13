#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
RUNTIME="$ROOT/runtime"
WHISPER="$RUNTIME/whisper.cpp"
PIPER_VENV="$RUNTIME/piper-venv"
mkdir -p "$RUNTIME" "$ROOT/models/whisper" "$ROOT/models/piper"

PIPER_PYTHON=${PIPER_PYTHON:-python3.10}
for tool in node npm cmake git curl "$PIPER_PYTHON"; do
  command -v "$tool" >/dev/null || { echo "Missing prerequisite: $tool" >&2; exit 1; }
done

if [[ ! -d "$WHISPER/.git" ]]; then
  git clone --branch v1.9.4 --depth 1 https://github.com/ggml-org/whisper.cpp.git "$WHISPER"
fi
cmake -S "$WHISPER" -B "$WHISPER/build" -DGGML_METAL=ON -DCMAKE_BUILD_TYPE=Release
cmake --build "$WHISPER/build" --config Release -j 4 --target whisper-server
if [[ ! -f "$ROOT/models/whisper/ggml-small.bin" ]]; then
  "$WHISPER/models/download-ggml-model.sh" small "$ROOT/models/whisper"
fi
# Hindi, Hinglish and auto-detection (see docs/STT_EVALUATION.md).
if [[ ! -f "$ROOT/models/whisper/ggml-large-v3-turbo-q5_0.bin" ]]; then
  "$WHISPER/models/download-ggml-model.sh" large-v3-turbo-q5_0 "$ROOT/models/whisper"
fi
# base is faster but inaccurate for Hindi; download it only for comparisons.
if [[ "${WHISPER_DOWNLOAD_BASE:-0}" == "1" && ! -f "$ROOT/models/whisper/ggml-base.bin" ]]; then
  "$WHISPER/models/download-ggml-model.sh" base "$ROOT/models/whisper"
fi

if [[ ! -x "$PIPER_VENV/bin/pip" ]]; then "$PIPER_PYTHON" -m venv "$PIPER_VENV"; fi
"$PIPER_VENV/bin/pip" install --upgrade 'piper-tts[http]==1.8.0'
(
  cd "$ROOT/models/piper"
  "$PIPER_VENV/bin/python" -m piper.download_voices en_US-lessac-medium hi_IN-priyamvada-medium
)

# Local RAG: multilingual-e5-small (MIT) as ONNX + PyMuPDF/onnxruntime in their own venv.
# RAG_PYTHON must be a Python 3.10+ whose pip works (Homebrew python@3.10 on macOS 26 does not).
RAG_PYTHON=${RAG_PYTHON:-python3}
if [[ "${RAG_ENABLED:-true}" == "true" ]]; then
  if ! "$RAG_PYTHON" -c 'import pyexpat, ensurepip, sys; assert sys.version_info >= (3, 10)' 2>/dev/null; then
    echo "RAG_PYTHON=$RAG_PYTHON cannot create a working venv; set RAG_PYTHON to e.g. /opt/anaconda3/bin/python" >&2
    exit 1
  fi
  [[ -x "$RUNTIME/rag-venv/bin/pip" ]] || "$RAG_PYTHON" -m venv "$RUNTIME/rag-venv"
  "$RUNTIME/rag-venv/bin/pip" install -r "$ROOT/scripts/rag-requirements.txt"
  E5="$ROOT/models/embeddings/multilingual-e5-small"
  E5_REV=614241f622f53c4eeff9890bdc4f31cfecc418b3
  mkdir -p "$E5"
  for f in onnx/model.onnx tokenizer.json config.json; do
    [[ -f "$E5/$(basename "$f")" ]] || curl -fL -o "$E5/$(basename "$f")" "https://huggingface.co/intfloat/multilingual-e5-small/resolve/$E5_REV/$f"
  done
  echo "ca456c06b3a9505ddfd9131408916dd79290368331e7d76bb621f1cba6bc8665  $E5/model.onnx" | shasum -a 256 -c -
fi

cd "$ROOT"
# Node.js backend (Node 24 LTS or newer).
npm ci --prefix "$ROOT/backend" --no-audit --no-fund
echo "Setup complete. Copy .env.example to .env, add GEMINI_API_KEY, then run scripts/start-local.sh"
