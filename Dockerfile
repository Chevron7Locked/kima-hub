# Kima All-in-One Docker Image (Hardened)
# Contains: Backend, Frontend, PostgreSQL, Redis, Audio Analyzer (Essentia AI)
# Usage: docker run -d -p 3030:3030 -v /path/to/music:/music chevron7locked/kima

# ============================================================
# CLAP ONNX BUILDER STAGE
# Exports both towers of LAION-CLAP's music checkpoint from the PUBLIC
# lukewys/laion_clap file (revision b3708341..., sha-gated) with the pinned
# toolchain in services/audio-analyzer-clap/requirements-export.txt:
#   music_audio.onnx  sha256 ab1bf5eba067b246198c630f153f774e8f1c3169b3924d4d6a4dc247bd73de97
#   music_text.onnx   sha256 6dbba074b27f8973d84c5c7ae9acd0b9139a6cd9dd82bea6e87954dc3b835956
# The same pins gave these bytes on linux/arm64, linux/amd64 and macOS arm64.
# The sha gate fails the build on any drift: the checkpoint, the toolchain, the
# export script, or the roberta-base config laion_clap fetches by name. The
# checkpoint (2.4 GB) stays in this stage.
FROM python:3.11-slim AS clap-onnx-builder
WORKDIR /build
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates

COPY services/audio-analyzer-clap/requirements-export.txt .
RUN pip3 install --no-cache-dir --no-deps \
    --index-url https://download.pytorch.org/whl/cpu \
    --extra-index-url https://pypi.org/simple \
    -r requirements-export.txt
COPY services/audio-analyzer-clap/export_music_onnx.py .
# NOTE: mkdir -p ckpt is required — curl -o does NOT create parent dirs.
RUN mkdir -p ckpt \
    && curl -fL --retry 5 --retry-delay 5 --retry-all-errors -o ckpt/music_audioset_epoch_15_esc_90.14.pt \
        'https://huggingface.co/lukewys/laion_clap/resolve/b3708341862f581175dba5c356a4ebf74a9b6651/music_audioset_epoch_15_esc_90.14.pt' \
    && echo 'fae3e9c087f2909c28a09dc31c8dfcdacbc42ba44c70e972b58c1bd1caf6dedd  ckpt/music_audioset_epoch_15_esc_90.14.pt' | sha256sum -c -
RUN python3 export_music_onnx.py --ckpt ckpt/music_audioset_epoch_15_esc_90.14.pt --out-dir . \
    && echo 'ab1bf5eba067b246198c630f153f774e8f1c3169b3924d4d6a4dc247bd73de97  music_audio.onnx' | sha256sum -c - \
    && echo '6dbba074b27f8973d84c5c7ae9acd0b9139a6cd9dd82bea6e87954dc3b835956  music_text.onnx' | sha256sum -c - \
    && echo '[builder] music_audio.onnx and music_text.onnx exported and sha-verified'

# ============================================================
# MUSICNN MODELS (vendored ONNX + reference answers)
# MusiCNN and its three heads (danceability, DEAM and emoMusic valence/arousal) ship as converted ONNX checked into the repo
# (services/audio-analyzer/models/), together with the reference answers
# recorded from the validated pipeline. The build gate below runs the vendored
# graphs on this image's own ONNX Runtime and fails unless they answer within
# 1e-4 of the reference pass -- a tampered or drifted weights file fails the
# build. The frozen TensorFlow originals (pb/) and the converter
# (convert_musicnn.py) stay in the repo so anyone can re-derive the ONNX and
# re-verify; they are no longer part of any image build.

FROM node:24-slim

# Point-release the base layer before anything is installed: the node:24-slim
# digest on the build cache predates the current bookworm security updates
# (trivy found 42 fixable HIGH/CRIT in the Debian layer of rc-* images).
RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/* && apt-get update

# Add PostgreSQL 16 repository (Debian Bookworm only has PG15 by default)
RUN apt-get install -y --no-install-recommends \
    gnupg lsb-release curl ca-certificates && \
    echo "deb http://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list && \
    curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /etc/apt/trusted.gpg.d/postgresql.gpg && \
    apt-get update

# Install system dependencies including Python for audio analysis
# pgvector pinned to the 0.8.x series (0.8.6 verified running): ef_search /
# iterative_scan behaviour is version-sensitive and an unpinned PGDG package
# floats across releases on rebuild.
RUN apt-get install -y --no-install-recommends \
    postgresql-16 \
    postgresql-contrib-16 \
    postgresql-16-pgvector=0.8.* \
    redis-server \
    supervisor \
    ffmpeg \
    libchromaprint-tools \
    tini \
    openssl \
    bash \
    gosu \
    # Python for audio analyzer
    python3 \
    python3-pip \
    python3-numpy \
    # Build tools (needed for some Python packages)
    build-essential \
    python3-dev \
    pkg-config \
    # Essentia source build: headers for the build, runtime libs kept after purge
    libeigen3-dev \
    libfftw3-dev \
    libyaml-dev \
    libsamplerate0-dev \
    libfftw3-single3 \
    libsamplerate0 \
    libyaml-0-2 \
    && rm -rf /var/lib/apt/lists/* \
    # ssl-cert generates a key pair at build time that every pull of the image
    # would share; Kima's Postgres runs its own initdb cluster with SSL off.
    && rm -f /etc/ssl/private/ssl-cert-snakeoil.key /etc/ssl/certs/ssl-cert-snakeoil.pem

# Create directories
RUN mkdir -p /app/backend /app/frontend /app/audio-analyzer /app/models \
    /data/postgres /data/redis /run/postgresql /var/log/supervisor \
    && chown -R postgres:postgres /data/postgres /run/postgresql

# ============================================
# AUDIO ANALYZER SETUP (Essentia AI)
# ============================================
WORKDIR /app/audio-analyzer

# Core Python dependencies -- must succeed on all architectures (AMD64 + ARM64)
RUN pip3 install --no-cache-dir --break-system-packages \
    redis \
    psycopg2-binary \
    'pgvector>=0.2.0' \
    'requests>=2.31.0' \
    # 3.x is the binding of the backend's bullmq 6 (one upstream release); it
    # pins msgpack 1.2.3, the fixed release for GHSA-j586-36cw-2gc2.
    'bullmq==3.4.5' \
    'msgpack==1.2.3' \
    'yt-dlp>=2024.12.0'

# ML dependencies -- ONNX Runtime for CLAP (audio + text) and MusiCNN.
# Exact versions: the sound vectors and the MusiCNN parity were validated on these, and a
# rebuild must not drift onto others (onnxruntime 1.30.0, librosa 0.11.0, soundfile 0.14.0).
# The PyTorch stack is not installed: the analyzer runs CLAP through ONNX Runtime only.
# PyTorch lives in the export stage above, which builds the ONNX model.
# transformers supplies the tokenizer (RobertaTokenizer) for the text encoder;
# the sound model's front end is numpy and librosa's mel filter bank
# (music_clap_mel.py). The same pins as services/audio-analyzer-clap/
# requirements.txt (test_onnx_runtime_ready.py checks). transformers is exact:
# torchless imports crash on unvetted releases, so a bump ships only with a
# full ONNX re-validation. 5.10.4 is validated (mel, tokenizer, 512-d
# audio and text embeddings bit-identical to 4.57.6) and closes
# CVE-2026-4372/5241/9856 in the model-loading path.
RUN pip3 install --no-cache-dir --break-system-packages \
    'onnxruntime==1.30.0' \
    'transformers==5.10.4' \
    'librosa==0.11.0' \
    'soundfile==0.14.0'

# Essentia for the signal analysis and MusiCNN's input features; MusiCNN itself runs on
# ONNX Runtime, so no TensorFlow is installed. Essentia publishes Linux wheels for
# x86_64 only: it is built from source at the dev1389 pin (upstream commit 36ec3d92)
# on every architecture, so amd64 and arm64 run the same build. The source build
# matches the wheel's answers to 1e-6 on library tracks; the gate below proves it
# works on this image before anything ships. A failed build here fails the image.
RUN pip3 install --no-cache-dir --break-system-packages 'numpy==1.24.4' 'six' 'pyyaml' \
    && curl -fsSL --retry 5 -o /tmp/essentia.tar.gz \
        'https://github.com/MTG/essentia/archive/36ec3d929402d491cbbb1120c54631e8c205b0ff.tar.gz' \
    && mkdir /tmp/essentia-src && tar xzf /tmp/essentia.tar.gz -C /tmp/essentia-src --strip-components=1 \
    && cd /tmp/essentia-src \
    && python3 waf configure --mode=release --with-python \
    && python3 waf -j"$(nproc)" \
    && python3 waf install \
    && ldconfig \
    && LIB="$(python3 -c 'import sysconfig; print(sysconfig.get_path("purelib"))')" \
    && if [ -d /usr/local/lib/python3/dist-packages/essentia ] && [ ! -e "$LIB/essentia" ]; then \
        mv /usr/local/lib/python3/dist-packages/essentia "$LIB/"; fi \
    && python3 -c 'import essentia; print("essentia importable:", essentia.__version__)' \
    && cd / && rm -rf /tmp/essentia-src /tmp/essentia.tar.gz

# numpy 1.24.4 is what Essentia, the MusiCNN gate and the CLAP parity were validated with.
# Force exact wheel versions to avoid resolver drift leaving incompatible pandas/scipy.
RUN pip3 uninstall -y pandas scipy numpy || true \
    && pip3 install --no-cache-dir --break-system-packages --force-reinstall \
    'numpy==1.24.4' \
    'scipy==1.10.1' \
    'pandas==2.0.3'

# Fail fast during build if the CLAP ONNX runtime stack imports cleanly.
RUN python3 -c "import numpy, scipy, pandas, onnxruntime, librosa, transformers; from transformers import RobertaTokenizer; from transformers.audio_utils import spectrogram, mel_filter_bank, window_function; print(f'CLAP ONNX deps OK: ort={onnxruntime.__version__} transformers={transformers.__version__} numpy={numpy.__version__}')" 

# Cleanup
RUN pip cache purge \
    && find /usr -name "*.pyc" -delete \
    && find /usr -name "__pycache__" -type d -exec rm -rf {} + 2>/dev/null || true

# MusiCNN and its heads as vendored ONNX, checked on this image's own ONNX
# Runtime against the vendored reference answers. The answers stay in the image:
# the analyzer checks its GPU session against them at every start.
COPY services/audio-analyzer/models/ /app/models/
COPY services/audio-analyzer/convert_musicnn.py services/audio-analyzer/musicnn_onnx.py /tmp/musicnn-gate/
RUN cd /tmp/musicnn-gate && python3 convert_musicnn.py gate /app/models /app/models/musicnn-answers.npz \
    && rm -rf /tmp/musicnn-gate

# analyzer.py imports classifier and musicnn_onnx at load.
COPY services/audio-analyzer/analyzer.py services/audio-analyzer/classifier.py services/audio-analyzer/musicnn_onnx.py services/audio-analyzer-clap/gpu_switch.py /app/audio-analyzer/

# ============================================
# CLAP ANALYZER SETUP (Vibe Similarity)
# ============================================
WORKDIR /app/audio-analyzer-clap

# Copy the CLAP analyzer -- BOTH runtime modules. analyzer.py imports
# onnx_backend at module load (unconditional), so an image that copies only
# analyzer.py cannot start its CLAP analyzer at all: it dies with
# "ModuleNotFoundError: No module named 'onnx_backend'" before doing any work.
# verify_runtime.py + test_fixtures ride along for the build-time parity gate.
COPY services/audio-analyzer-clap/analyzer.py /app/audio-analyzer-clap/
COPY services/audio-analyzer-clap/onnx_backend.py /app/audio-analyzer-clap/
COPY services/audio-analyzer-clap/music_clap_mel.py services/audio-analyzer-clap/music_clap_onnx.py /app/audio-analyzer-clap/
COPY services/audio-analyzer-clap/verify_runtime.py /app/audio-analyzer-clap/
COPY services/audio-analyzer-clap/gpu_runtime.py services/audio-analyzer-clap/gpu_switch.py /app/audio-analyzer-clap/
COPY services/audio-analyzer-clap/gpu_env.sh /app/audio-analyzer-clap/
RUN chmod +x /app/audio-analyzer-clap/gpu_env.sh
COPY services/audio-analyzer-clap/test_fixtures/ /app/audio-analyzer-clap/test_fixtures/

# Prove the analyzer is importable in the image, so a missing file fails the
# build instead of shipping a dead analyzer. Needs no model weights.
RUN cd /app/audio-analyzer-clap &&     python3 -c "import onnx_backend; print('[CLAP] onnx_backend importable')"

# ============================================================
# CLAP ONNX WEIGHTS -- PUBLIC SOURCES ONLY, SHA-GATED IN THE BUILDER
# Both towers of the music checkpoint, exported and sha-checked in the
# clap-onnx-builder stage above.
RUN mkdir -p /app/audio-analyzer-clap/models
COPY --from=clap-onnx-builder /build/music_audio.onnx /build/music_text.onnx /app/audio-analyzer-clap/models/

# ============================================================
# OFFLINE HUGGINGFACE CACHE (boot without network)
# The text model's tokenizer, RobertaTokenizer.from_pretrained('roberta-base'),
# loads lazily at first use. Without a baked cache the first text embedding
# requires huggingface.co to be up. Pin the exact revision; sha-gate every file.
RUN ROB='https://huggingface.co/roberta-base/resolve/e2da8e2f811d1448a5b465c236feacd80ffbac7b' \
    && RDIR='/root/.cache/huggingface/hub/models--roberta-base' \
    && RS="$RDIR/snapshots/e2da8e2f811d1448a5b465c236feacd80ffbac7b" \
    && mkdir -p "$RS" "$RDIR/refs" \
    && printf '%s' 'e2da8e2f811d1448a5b465c236feacd80ffbac7b' > "$RDIR/refs/main" \
    && curl -fsSL --retry 5 --retry-all-errors -o "$RS/vocab.json" "$ROB/vocab.json" \
    && echo '9e7f63c2d15d666b52e21d250d2e513b87c9b713cfa6987a82ed89e5e6e50655  '"$RS"'/vocab.json' | sha256sum -c - \
    && curl -fsSL --retry 5 --retry-all-errors -o "$RS/merges.txt" "$ROB/merges.txt" \
    && echo '1ce1664773c50f3e0cc8842619a93edc4624525b728b188a9e0be33b7726adc5  '"$RS"'/merges.txt' | sha256sum -c - \
    && curl -fsSL --retry 5 --retry-all-errors -o "$RS/tokenizer.json" "$ROB/tokenizer.json" \
    && echo '847bbeab6174d66a88898f729d52fa8d355fafe1bea101cf960dd404581df70e  '"$RS"'/tokenizer.json' | sha256sum -c - \
    && curl -fsSL --retry 5 --retry-all-errors -o "$RS/tokenizer_config.json" "$ROB/tokenizer_config.json" \
    && echo '994f46754c5bf4014f1aa92d34b1374319c3a6b3f702105cd5b742beaecd18ce  '"$RS"'/tokenizer_config.json' | sha256sum -c -

# ============================================================
# BUILD-TIME PARITY GATE
# Embed the tracked fixtures through the image's own runtime stack (offline --
# HF_HUB_OFFLINE=1 proves the baked cache suffices) and require cosine
# >= 0.999 against expected_music_embeddings.npy, laion_clap's own embeddings
# of the fixtures on the music checkpoint. Any preprocessing/toolchain drift fails the build.
# Also exercises the text encoder end to end.
RUN cd /app/audio-analyzer-clap \
    && HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 python3 verify_runtime.py

# Create database readiness check script
RUN cat > /app/wait-for-db.sh << 'EOF'
#!/bin/bash
TIMEOUT=${1:-120}
COUNTER=0

echo "[wait-for-db] Waiting for Redis and database schema (timeout: ${TIMEOUT}s)..."

# Wait for Redis to finish loading
echo "[wait-for-db] Checking Redis readiness..."
REDIS_COUNTER=0
while [ $REDIS_COUNTER -lt $TIMEOUT ]; do
    if redis-cli -h localhost ping 2>/dev/null | grep -q PONG; then
        echo "[wait-for-db] ✓ Redis is ready!"
        break
    fi
    sleep 1
    REDIS_COUNTER=$((REDIS_COUNTER + 1))
done

if [ $REDIS_COUNTER -ge $TIMEOUT ]; then
    echo "[wait-for-db] ERROR: Redis not ready after ${TIMEOUT}s"
    exit 1
fi

# Quick check for schema ready flag
if [ -f /data/.schema_ready ]; then
    echo "[wait-for-db] Schema ready flag found, verifying connection..."
fi

while [ $COUNTER -lt $TIMEOUT ]; do
    if PGPASSWORD=kima psql -h localhost -U kima -d kima -c "SELECT 1 FROM \"Track\" LIMIT 1" > /dev/null 2>&1; then
        echo "[wait-for-db] ✓ Database is ready and schema exists!"
        exit 0
    fi
    
    if [ $((COUNTER % 15)) -eq 0 ]; then
        echo "[wait-for-db] Still waiting... (${COUNTER}s elapsed)"
    fi
    
    sleep 1
    COUNTER=$((COUNTER + 1))
done

echo "[wait-for-db] ERROR: Database schema not ready after ${TIMEOUT}s"
echo "[wait-for-db] Listing available tables:"
PGPASSWORD=kima psql -h localhost -U kima -d kima -c "\dt" 2>&1 || echo "Could not list tables"
exit 1
EOF

RUN chmod +x /app/wait-for-db.sh && \
    sed -i 's/\r$//' /app/wait-for-db.sh

# ============================================
# BACKEND BUILD
# ============================================
WORKDIR /app/backend

# Copy backend package files and install dependencies
COPY backend/package*.json ./
COPY backend/prisma ./prisma/
RUN echo "=== Migrations copied ===" && ls -la prisma/migrations/ && echo "=== End migrations ==="
RUN npm ci && npm cache clean --force
RUN npx prisma generate

# Copy backend source and build
COPY backend/src ./src
COPY backend/tsconfig.json ./
RUN npm run build && \
    npm prune --production && \
    rm -rf src tests __tests__ tsconfig*.json

COPY backend/docker-entrypoint.sh ./

# Create log directory (cache will be in /data volume)
RUN mkdir -p /app/backend/logs

# ============================================
# FRONTEND BUILD
# ============================================
WORKDIR /app/frontend

# Copy frontend package files and install dependencies
COPY frontend/package*.json ./
RUN npm ci && npm cache clean --force

# Copy frontend source and build
COPY frontend/ ./

# Build Next.js (production)
# MALLOC_ARENA_MAX=1 reduces mmap arena churn during build.
# Build needs 2GB for tsc; runtime stays at 512MB (set in supervisor config).
ENV NEXT_PUBLIC_BACKEND_URL=http://127.0.0.1:3006

# Marks a non-release build in the UI, so a screenshot or a bug report says
# which channel the image came from. The pre-release workflow passes "preview";
# a tagged release passes nothing and renders a bare version number.
ARG NEXT_PUBLIC_BUILD_TYPE=""
ENV NEXT_PUBLIC_BUILD_TYPE=${NEXT_PUBLIC_BUILD_TYPE}

# Drop dev dependencies after the build: the runtime needs only next + react,
# and the dev tree ships advisories the app never executes (the braces chain).
RUN MALLOC_ARENA_MAX=1 NODE_OPTIONS="--max-old-space-size=2048" npm run build \
    && npm prune --omit=dev && npm cache clean --force

# ============================================
# SECURITY HARDENING
# ============================================
# Remove dangerous tools and build dependencies AFTER all builds are complete
# Keep: bash (supervisor), gosu (postgres user switching), python3 (audio analyzer)
# npm/npx are build-time tools: the node image ships its own copy at
# /usr/local/lib/node_modules/npm, and trivy scored that tree CRITICAL (tar,
# undici, ip-address). Nothing in the running app may invoke npm — the
# supervisor launches node/next/prisma directly — so the tree is deleted.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
        /usr/local/bin/yarn /usr/local/bin/yarnpkg 2>/dev/null || true && \
    apt-get purge -y --auto-remove build-essential python3-dev pkg-config \
        libeigen3-dev libfftw3-dev libyaml-dev libsamplerate0-dev 2>/dev/null || true && \
    rm -f /usr/bin/wget /bin/wget 2>/dev/null || true && \
    rm -f /usr/bin/curl /bin/curl 2>/dev/null || true && \
    rm -f /usr/bin/nc /bin/nc /usr/bin/ncat /usr/bin/netcat 2>/dev/null || true && \
    rm -f /usr/bin/ftp /usr/bin/tftp /usr/bin/telnet 2>/dev/null || true && \
    rm -rf /var/lib/apt/lists/*

# ============================================
# CONFIGURATION
# ============================================
WORKDIR /app

# Copy healthcheck script
COPY frontend/healthcheck.js /app/healthcheck.js

# Create supervisord config - logs to stdout/stderr for Docker visibility
RUN cat > /etc/supervisor/conf.d/kima.conf << 'EOF'
[supervisord]
nodaemon=true
logfile=/dev/null
logfile_maxbytes=0
pidfile=/var/run/supervisord.pid
user=root

[program:postgres]
command=/usr/lib/postgresql/16/bin/postgres -D /data/postgres
user=postgres
autostart=true
autorestart=true
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0
priority=10

[program:redis]
command=/usr/bin/redis-server --dir /data/redis --appendonly yes
user=redis
autostart=true
autorestart=true
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0
priority=20

[program:backend]
command=/bin/bash -c "/app/wait-for-db.sh 120 && cd /app/backend && node dist/index.js"
autostart=true
autorestart=true
startretries=3
startsecs=10
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0
directory=/app/backend
priority=30

[program:frontend]
command=/bin/bash -c "sleep 10 && cd /app/frontend && exec node node_modules/next/dist/bin/next start -H 0.0.0.0 -p 3030"
autostart=true
autorestart=true
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0
environment=NODE_ENV="production",BACKEND_URL="http://localhost:3006",PORT="3030",MALLOC_ARENA_MAX="1",NODE_OPTIONS="--max-old-space-size=512"
priority=40

[program:audio-analyzer]
command=/bin/bash -c "/app/wait-for-db.sh 120 && cd /app/audio-analyzer && KIMA_GPU_FOR=analysis /app/audio-analyzer-clap/gpu_env.sh python3 analyzer.py"
autostart=true
autorestart=true
startretries=3
startsecs=10
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0
environment=DATABASE_URL="postgresql://kima:kima@localhost:5432/kima",REDIS_URL="redis://localhost:6379",MUSIC_PATH="/music",MAX_ANALYZE_SECONDS="90",BRPOP_TIMEOUT="5",MODEL_IDLE_TIMEOUT="300",NUM_WORKERS="2",THREADS_PER_WORKER="1"
priority=50

[program:audio-analyzer-clap]
command=/bin/bash -c "/app/wait-for-db.sh 120 && cd /app/audio-analyzer-clap && ./gpu_env.sh python3 analyzer.py"
autostart=true
autorestart=true
startretries=3
startsecs=30
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0
environment=DATABASE_URL="postgresql://kima:kima@localhost:5432/kima",REDIS_URL="redis://localhost:6379",MUSIC_PATH="/music",BACKEND_URL="http://localhost:3006",MODEL_IDLE_TIMEOUT="300",HF_HUB_OFFLINE="1",TRANSFORMERS_OFFLINE="1"
priority=60
EOF

# Fix Windows line endings in supervisor config
RUN sed -i 's/\r$//' /etc/supervisor/conf.d/kima.conf

# Create startup script with root check
RUN cat > /app/start.sh << 'EOF'
#!/bin/bash
set -e

# Security check: Warn if running internal services as root
# Note: This container runs multiple services, some require root for initial setup
# but individual services (postgres, backend processes) run as non-root users

echo ""
echo "============================================================"
echo "  Kima - Premium Self-Hosted Music Server"
echo ""
echo "  Features:"
echo "    - AI-Powered Vibe Matching (Essentia ML)"
echo "    - Smart Playlists & Mood Detection"
echo "    - High-Quality Audio Streaming"
echo ""
echo "  Security:"
echo "    - Hardened container (no wget/curl/nc)"
echo "    - Auto-generated encryption keys"
echo "============================================================"
echo ""

# Find PostgreSQL binaries (version may vary)
PG_BIN=$(find /usr/lib/postgresql -name "bin" -type d | head -1)
if [ -z "$PG_BIN" ]; then
    echo "ERROR: PostgreSQL binaries not found!"
    exit 1
fi
echo "Using PostgreSQL from: $PG_BIN"

# Prepare data directories (bind-mount safe)
echo "Preparing data directories..."
mkdir -p /data/postgres /data/redis /run/postgresql

if id postgres >/dev/null 2>&1; then
    chown -R postgres:postgres /data/postgres /run/postgresql 2>/dev/null || true
    chmod 700 /data/postgres 2>/dev/null || true
    if ! gosu postgres test -w /data/postgres; then
        POSTGRES_UID=$(id -u postgres)
        POSTGRES_GID=$(id -g postgres)
        echo "ERROR: /data/postgres is not writable by postgres (${POSTGRES_UID}:${POSTGRES_GID})."
        echo "If you bind-mount /data, ensure the host path is writable by that UID/GID."
        exit 1
    fi
fi

if id redis >/dev/null 2>&1; then
    chown -R redis:redis /data/redis 2>/dev/null || true
    chmod 700 /data/redis 2>/dev/null || true
    if ! gosu redis test -w /data/redis; then
        REDIS_UID=$(id -u redis)
        REDIS_GID=$(id -g redis)
        echo "ERROR: /data/redis is not writable by redis (${REDIS_UID}:${REDIS_GID})."
        echo "If you bind-mount /data, ensure the host path is writable by that UID/GID."
        exit 1
    fi
fi

# Clean up stale PID file if exists
rm -f /data/postgres/postmaster.pid 2>/dev/null || true

# Initialize PostgreSQL if not already done
if [ ! -f /data/postgres/PG_VERSION ]; then
    echo "Initializing PostgreSQL database..."
    gosu postgres $PG_BIN/initdb -D /data/postgres

    # Configure PostgreSQL
    echo "host all all 0.0.0.0/0 md5" >> /data/postgres/pg_hba.conf
    echo "listen_addresses='*'" >> /data/postgres/postgresql.conf
fi

# Start PostgreSQL temporarily to create database and user
gosu postgres $PG_BIN/pg_ctl -D /data/postgres -w start

# Migrate from Lidify -> Kima: rename old database and user if they exist
if gosu postgres psql -tc "SELECT 1 FROM pg_database WHERE datname = 'lidify'" | grep -q 1; then
    echo "Found legacy 'lidify' database, migrating to 'kima'..."
    # Terminate any connections to the old database
    gosu postgres psql -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'lidify' AND pid <> pg_backend_pid();" 2>/dev/null || true
    # Rename the database
    gosu postgres psql -c "ALTER DATABASE lidify RENAME TO kima;"
    echo "✓ Database renamed: lidify -> kima"
    # Rename the user if it exists
    if gosu postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname = 'lidify'" | grep -q 1; then
        gosu postgres psql -c "ALTER USER lidify RENAME TO kima;"
        gosu postgres psql -c "ALTER USER kima WITH PASSWORD 'kima';"
        echo "✓ User renamed: lidify -> kima"
    fi
fi

# Create user and database if they don't exist (fresh install)
gosu postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname = 'kima'" | grep -q 1 || \
    gosu postgres psql -c "CREATE USER kima WITH PASSWORD 'kima';"
gosu postgres psql -tc "SELECT 1 FROM pg_database WHERE datname = 'kima'" | grep -q 1 || \
    gosu postgres psql -c "CREATE DATABASE kima OWNER kima;"

# Create pgvector extension as superuser (required before migrations)
echo "Creating pgvector extension..."
gosu postgres psql -d kima -c "CREATE EXTENSION IF NOT EXISTS vector;"

# Run Prisma migrations
cd /app/backend
export DATABASE_URL="postgresql://kima:kima@localhost:5432/kima"
echo "Running Prisma migrations..."
ls -la prisma/migrations/ || echo "No migrations directory!"

# Check if _prisma_migrations table exists (indicates previous Prisma setup)
MIGRATIONS_EXIST=$(gosu postgres psql -d kima -tAc "SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = '_prisma_migrations')" 2>/dev/null || echo "f")

# Check if User table exists (indicates existing data)
USER_TABLE_EXIST=$(gosu postgres psql -d kima -tAc "SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'User')" 2>/dev/null || echo "f")

# Resolve the soulseekFallback column split before migrate deploy, idempotent:
# on databases carrying legacy fake _prisma_migrations rows, deploy alone would
# skip the corrective migration. `|| true` keeps this compat step off the
# boot-critical path; the migration itself logs via RAISE NOTICE.
echo "Resolving soulseekFallback column split (idempotent)..."
gosu postgres psql -d kima -f /app/backend/prisma/migrations/20260916000000_resolve_soulseek_fallback_split/migration.sql 2>&1 || true

if [ "$MIGRATIONS_EXIST" = "t" ]; then
    # Normal migration flow - migrations table exists
    echo "Migration history found, running migrate deploy..."
    if ! node node_modules/prisma/build/index.js migrate deploy 2>&1; then
        echo "FATAL: Database migration failed! Check logs above."
        exit 1
    fi
elif [ "$USER_TABLE_EXIST" = "t" ]; then
    # Database has data but no migrations table - needs baseline
    echo "Existing database detected without migration history."
    echo "Creating baseline from current schema..."
    # Mark the init migration as already applied (baseline)
    node node_modules/prisma/build/index.js migrate resolve --applied 20251130000000_init 2>&1 || true
    # Now run any subsequent migrations
    if ! node node_modules/prisma/build/index.js migrate deploy 2>&1; then
        echo "FATAL: Migration after baseline failed!"
        exit 1
    fi
else
    # Fresh database - run migrations normally
    echo "Fresh database detected, running initial migrations..."
    if ! node node_modules/prisma/build/index.js migrate deploy 2>&1; then
        echo "FATAL: Initial migration failed. Check database connection and schema."
        exit 1
    fi
fi
echo "✓ Migrations completed successfully"

# Verify schema exists before starting services
echo "Verifying database schema..."
if ! gosu postgres psql -d kima -c "SELECT 1 FROM \"Track\" LIMIT 1" >/dev/null 2>&1; then
    echo "FATAL: Track table does not exist after migration!"
    echo "Database schema verification failed. Container will exit."
    exit 1
fi
echo "✓ Schema verification passed"

# Create flag file for wait-for-db.sh
touch /data/.schema_ready
echo "✓ Schema ready flag created"

# Stop PostgreSQL (supervisord will start it)
gosu postgres $PG_BIN/pg_ctl -D /data/postgres -w stop

# Create persistent cache directories in /data volume
mkdir -p /data/cache/covers /data/cache/transcodes /data/secrets

# Load or generate persistent secrets
if [ -f /data/secrets/session_secret ]; then
    SESSION_SECRET=$(cat /data/secrets/session_secret)
    echo "Loaded existing SESSION_SECRET"
else
    SESSION_SECRET=$(openssl rand -hex 32)
    echo "$SESSION_SECRET" > /data/secrets/session_secret
    chmod 600 /data/secrets/session_secret
    echo "Generated and saved new SESSION_SECRET"
fi

if [ -f /data/secrets/encryption_key ]; then
    SETTINGS_ENCRYPTION_KEY=$(cat /data/secrets/encryption_key)
    echo "Loaded existing SETTINGS_ENCRYPTION_KEY"
else
    SETTINGS_ENCRYPTION_KEY=$(openssl rand -hex 32)
    echo "$SETTINGS_ENCRYPTION_KEY" > /data/secrets/encryption_key
    chmod 600 /data/secrets/encryption_key
    echo "Generated and saved new SETTINGS_ENCRYPTION_KEY"
fi

# Write environment file for backend
cat > /app/backend/.env << ENVEOF
NODE_ENV=production
DATABASE_URL=postgresql://kima:kima@localhost:5432/kima
REDIS_URL=redis://localhost:6379
PORT=3006
MUSIC_PATH=/music
TRANSCODE_CACHE_PATH=/data/cache/transcodes
SESSION_SECRET=$SESSION_SECRET
SETTINGS_ENCRYPTION_KEY=$SETTINGS_ENCRYPTION_KEY
DISABLE_CLAP=${DISABLE_CLAP:-}
ENVEOF

# Optionally disable CLAP audio analyzer (for low-memory deployments)
if [ "${DISABLE_CLAP:-false}" = "true" ] || [ "${DISABLE_CLAP:-0}" = "1" ]; then
    python3 -c "
import re
conf = open('/etc/supervisor/conf.d/kima.conf').read()
conf = re.sub(
    r'(\[program:audio-analyzer-clap\][^\[]*autostart=)true',
    r'\g<1>false',
    conf,
    flags=re.DOTALL
)
open('/etc/supervisor/conf.d/kima.conf', 'w').write(conf)
"
    echo "CLAP audio analyzer disabled (DISABLE_CLAP=${DISABLE_CLAP})"
fi

echo "Starting Kima..."
exec env \
    NODE_ENV=production \
    DATABASE_URL="postgresql://kima:kima@localhost:5432/kima" \
    SESSION_SECRET="$SESSION_SECRET" \
    SETTINGS_ENCRYPTION_KEY="$SETTINGS_ENCRYPTION_KEY" \
    /usr/bin/supervisord -c /etc/supervisor/supervisord.conf
EOF

# Fix Windows line endings (CRLF -> LF) and make executable
RUN sed -i 's/\r$//' /app/start.sh && chmod +x /app/start.sh

# Expose ports
EXPOSE 3030

# Health check using Node.js (no wget)
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD ["node", "/app/healthcheck.js"]

# Volumes
VOLUME ["/music", "/data"]

# Use tini for proper signal handling
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/app/start.sh"]
