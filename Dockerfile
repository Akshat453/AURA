# syntax=docker/dockerfile:1
#
# Container image for the Professor Voice Assistant backend (Node.js: web UI,
# API, professor tools, document index, ESP32 device gateway). Speech
# recognition (whisper.cpp), speech synthesis (Piper) and the RAG embedding
# sidecar stay on the host, where they can use the GPU; point the container at
# them with WHISPER_URL, PIPER_EN_URL, PIPER_HI_URL and RAG_SIDECAR_URL (see
# docs/CI_CD.md, "Running the image").

ARG NODE_VERSION=24

# Dependencies. better-sqlite3 uses a prebuilt binary when one matches this
# Node/platform, and otherwise compiles, so the build stage has a toolchain;
# the runtime stage does not.
FROM node:${NODE_VERSION}-bookworm-slim AS deps
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:${NODE_VERSION}-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/backend/node_modules ./backend/node_modules
COPY backend/package.json ./backend/
COPY backend/src ./backend/src
COPY backend/bin ./backend/bin
COPY backend/public ./backend/public
COPY backend/assets ./backend/assets
RUN mkdir -p /app/data && chown -R node:node /app/data
ENV VOICE_ADDR=0.0.0.0:8090 \
    RAG_STORAGE_PATH=/app/data/rag \
    PROFESSOR_DATA_PATH=/app/data/professor \
    DEVICE_TLS_DIR=/app/data/device-tls \
    DEVICE_REGISTRY=/app/data/devices.json \
    GOOGLE_TOKEN_PATH=/app/data/google-token.json
VOLUME ["/app/data"]
EXPOSE 8090
USER node
ENTRYPOINT ["node", "/app/backend/src/server.js"]
