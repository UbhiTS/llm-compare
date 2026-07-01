# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# Ubhi's LLM Matrix — container image.
# Node runtime + Python 3 (for /api/execute) + pygbag (to build the Pygame games
# to WebAssembly so they run in the browser). Designed for Google Cloud Run, but
# runs anywhere Docker does. PORT is provided by the platform (Cloud Run) and
# defaults to 8080; all other settings are env-overridable at deploy time.
# ---------------------------------------------------------------------------
FROM node:20-bookworm-slim

# System deps: python3 + pip (pygbag), tini (clean signal handling), CA certs.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip ca-certificates tini \
  && rm -rf /var/lib/apt/lists/*

# pygbag compiles the Pygame games to WASM (Debian bookworm needs --break-system-packages).
RUN pip3 install --no-cache-dir --break-system-packages pygbag==0.9.3

WORKDIR /app

# Install production node deps first for better layer caching.
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

# App source.
COPY . .

# Sensible container defaults (override at deploy time via env / --set-env-vars).
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PYTHON_CMD=python3 \
    AUTH_DATA_DIR=/tmp/auth

# Run as the image's built-in non-root user; /tmp is writable for auth data + pygbag builds.
USER node

EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
