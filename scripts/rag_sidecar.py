#!/usr/bin/env python3
"""Local RAG sidecar: multilingual-e5 embeddings and PDF text extraction.

Go owns document management, chunking, storage and retrieval; this process
only runs the two pieces that need Python libraries. It listens on localhost.

  GET  /                   -> {"status": "ok", "model": ..., "dim": 384}
  POST /embed              {"texts": [...], "kind": "query"|"passage"}
                           -> {"vectors": [[...]], "tokens": [n, ...], "truncated": k}
  POST /extract/pdf        raw PDF bytes -> {"pages": [{"page": 1, "text": "..."}]}

multilingual-e5 requires "query: " / "passage: " prefixes, attention-masked
mean pooling and L2 normalization (model card); inputs are truncated at 512.
"""
import argparse
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import onnxruntime as ort
import pymupdf
from tokenizers import Tokenizer

MAX_TOKENS = 512
MAX_BODY = 64 << 20


class Embedder:
    def __init__(self, model_dir, threads):
        self.tokenizer = Tokenizer.from_file(os.path.join(model_dir, "tokenizer.json"))
        self.tokenizer.enable_truncation(MAX_TOKENS)
        self.tokenizer.enable_padding(pad_id=1, pad_token="<pad>")  # XLM-R padding token
        options = ort.SessionOptions()
        if threads:
            options.intra_op_num_threads = threads
        self.session = ort.InferenceSession(os.path.join(model_dir, "model.onnx"), options, providers=["CPUExecutionProvider"])
        self.inputs = {i.name for i in self.session.get_inputs()}
        self.lock = threading.Lock()  # one inference at a time keeps latency predictable

    def embed(self, texts, kind):
        prefix = "query: " if kind == "query" else "passage: "
        untruncated = self.tokenizer.encode_batch([prefix + t for t in texts])
        ids = np.array([e.ids for e in untruncated], dtype=np.int64)
        mask = np.array([e.attention_mask for e in untruncated], dtype=np.int64)
        feed = {"input_ids": ids, "attention_mask": mask}
        if "token_type_ids" in self.inputs:
            feed["token_type_ids"] = np.zeros_like(ids)
        with self.lock:
            hidden = self.session.run(None, feed)[0]  # (batch, tokens, dim)
        m = mask[..., None].astype(np.float32)
        pooled = (hidden * m).sum(axis=1) / np.clip(m.sum(axis=1), 1e-9, None)
        pooled /= np.clip(np.linalg.norm(pooled, axis=1, keepdims=True), 1e-12, None)
        tokens = [int(e.attention_mask.count(1)) for e in untruncated]
        truncated = sum(1 for e in untruncated if e.overflowing)
        return pooled.astype(np.float32), tokens, truncated


def extract_pdf(data):
    pages = []
    with pymupdf.open(stream=data, filetype="pdf") as doc:
        if doc.needs_pass:
            raise ValueError("PDF is password-protected")
        for number, page in enumerate(doc, start=1):
            # Text blocks keep paragraph structure; image blocks (type 1) are skipped.
            blocks = [b[4].strip() for b in page.get_text("blocks") if b[6] == 0 and b[4].strip()]
            pages.append({"page": number, "text": "\n\n".join(blocks)})
    return pages


class Handler(BaseHTTPRequestHandler):
    embedder = None
    model_name = ""

    def log_message(self, fmt, *args):  # never log request contents
        pass

    def do_GET(self):
        self.reply(200, {"status": "ok", "model": self.model_name, "dim": int(self.embedder.session.get_outputs()[0].shape[-1] or 384)})

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        if length <= 0 or length > MAX_BODY:
            self.reply(413, {"error": "request body missing or too large"})
            return
        body = self.rfile.read(length)
        start = time.perf_counter()
        try:
            if self.path == "/embed":
                req = json.loads(body)
                texts, kind = req.get("texts") or [], req.get("kind", "passage")
                if not isinstance(texts, list) or not texts or len(texts) > 64 or kind not in ("query", "passage"):
                    raise ValueError("texts must be a list of 1-64 strings and kind query|passage")
                vectors, tokens, truncated = self.embedder.embed([str(t) for t in texts], kind)
                self.reply(200, {"vectors": vectors.tolist(), "tokens": tokens, "truncated": truncated, "ms": round((time.perf_counter() - start) * 1000, 1)})
            elif self.path == "/extract/pdf":
                pages = extract_pdf(body)
                self.reply(200, {"pages": pages, "ms": round((time.perf_counter() - start) * 1000, 1)})
            else:
                self.reply(404, {"error": "not found"})
        except Exception as error:
            self.reply(400, {"error": f"{type(error).__name__}: {error}"})

    def reply(self, status, payload):
        data = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--model-dir", default="models/embeddings/multilingual-e5-small")
    p.add_argument("--model-name", default="intfloat/multilingual-e5-small")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8084)
    p.add_argument("--threads", type=int, default=4)
    a = p.parse_args()
    if a.host not in ("127.0.0.1", "localhost", "::1"):
        raise SystemExit("the RAG sidecar must listen on localhost only")
    Handler.embedder, Handler.model_name = Embedder(a.model_dir, a.threads), a.model_name
    Handler.embedder.embed(["warm-up"], "query")  # load weights before the first real request
    print(f"rag sidecar {a.model_name} on http://{a.host}:{a.port}", flush=True)
    ThreadingHTTPServer((a.host, a.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
