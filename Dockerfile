# =============================================================================
# Stage 1: Backend Build
# =============================================================================
FROM node:25-trixie-slim AS backend-build

WORKDIR /build/backend

# Copy package files and schema
COPY backend/package*.json ./
COPY backend/prisma ./prisma/

# Install dependencies and generate Prisma client
RUN npm ci && \
    npx prisma generate

# Copy source code
COPY backend/src ./src
COPY backend/tsconfig.json ./

# Build TypeScript and remove unnecessary files
RUN npm run build && \
    npm prune --production && \
    npm cache clean --force && \
    rm -rf src __tests__ tests tsconfig*.json


# =============================================================================
# Stage 2: Frontend Build
# =============================================================================
FROM node:25-trixie-slim AS frontend-build

WORKDIR /build/frontend

COPY frontend/package*.json ./

# Install dependencies (frontend doesn't have separate dev/prod distinction)
RUN npm ci && \
    npm cache clean --force

# Copy source and build
COPY frontend/ ./

# Build Next.js application
ENV NEXT_PUBLIC_BACKEND_URL=http://127.0.0.1:3006
RUN MALLOC_ARENA_MAX=1 NODE_OPTIONS="--max-old-space-size=2048" npm run build && \
    rm -rf .next/cache


#=============================================================================
#Stage 3: Download ML Models
#=============================================================================
FROM python:3.13-slim-trixie AS ml-downloader

RUN echo "Downloading ML models..." && \
    apt-get update && apt-get install -y aria2 && \
    pip install --no-cache-dir --prefer-binary  --index-url https://download.pytorch.org/whl/cpu torch numpy && \
    mkdir -p /app/models && \
    cd /app/models && \
    aria2c -x 16 -o "msd-musicnn-1.pb" "https://essentia.upf.edu/models/autotagging/msd/msd-musicnn-1.pb" && \
    aria2c -x 16 -o "mood_happy-msd-musicnn-1.pb" "https://essentia.upf.edu/models/classification-heads/mood_happy/mood_happy-msd-musicnn-1.pb" && \
    aria2c -x 16 -o "mood_sad-msd-musicnn-1.pb" "https://essentia.upf.edu/models/classification-heads/mood_sad/mood_sad-msd-musicnn-1.pb" && \
    aria2c -x 16 -o "mood_relaxed-msd-musicnn-1.pb" "https://essentia.upf.edu/models/classification-heads/mood_relaxed/mood_relaxed-msd-musicnn-1.pb" && \
    aria2c -x 16 -o "mood_aggressive-msd-musicnn-1.pb" "https://essentia.upf.edu/models/classification-heads/mood_aggressive/mood_aggressive-msd-musicnn-1.pb" && \
    aria2c -x 16 -o "mood_party-msd-musicnn-1.pb" "https://essentia.upf.edu/models/classification-heads/mood_party/mood_party-msd-musicnn-1.pb" && \
    aria2c -x 16 -o "mood_acoustic-msd-musicnn-1.pb" "https://essentia.upf.edu/models/classification-heads/mood_acoustic/mood_acoustic-msd-musicnn-1.pb" && \
    aria2c -x 16 -o "mood_electronic-msd-musicnn-1.pb" "https://essentia.upf.edu/models/classification-heads/mood_electronic/mood_electronic-msd-musicnn-1.pb" && \
    aria2c -x 16 -o "danceability-msd-musicnn-1.pb" "https://essentia.upf.edu/models/classification-heads/danceability/danceability-msd-musicnn-1.pb" && \
    aria2c -x 16 -o "emomusic-msd-musicnn-2.pb" "https://essentia.upf.edu/models/classification-heads/deam/deam-msd-musicnn-2.pb" && \
    aria2c -x 16 -o "clap_full.pt" "https://huggingface.co/lukewys/laion_clap/resolve/main/music_audioset_epoch_15_esc_90.14.pt" && \
    python3 -c "import torch; ckpt = torch.load('clap_full.pt', map_location='cpu', weights_only=False); torch.save({'state_dict': ckpt['state_dict']}, '/app/models/music_audioset_epoch_15_esc_90.14.pt')" && \
    rm clap_full.pt && \
    echo "All ML models downloaded"




# =============================================================================
# Stage: Python ML Dependencies
# =============================================================================
FROM python:3.13-slim-trixie AS python-packages

ENV VIRTUAL_ENV=/opt/ml-packages \
    PATH="/opt/ml-packages/bin:$PATH"
# Install ML packages into /opt/ml-packages virtual environment
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    build-essential && \
    pip install --break-system-packages --no-cache-dir --prefer-binary uv && \
    uv venv /opt/ml-packages && \
    uv pip install  \
      --no-cache-dir \
      --index-strategy unsafe-best-match\
      --index-url https://pypi.org/simple \
      --extra-index-url https://download.pytorch.org/whl/cpu \
      torchvision \
      'laion-clap>=1.1.4' \
      'librosa>=0.10.0' \
      'numpy>=1.24.0' \
      'pgvector>=0.2.0' \
      'psycopg2-binary>=2.9.0' \
      'python-dotenv>=1.0.0' \
      'bullmq==2.19.5' \
      'requests>=2.31.0' \
      'torch>=2.5.1' \
      'torchaudio>=2.5.1' \
      'transformers>=4.30.0' \
      'yt-dlp>=2024.12.0' && \
      uv pip install  \
      --no-cache-dir \
      --index-strategy unsafe-best-match\
      --index-url https://pypi.org/simple \
      --extra-index-url https://download.pytorch.org/whl/cpu \
      essentia-tensorflow \
      || echo "[ARM64] tensorflow-cpu/essentia-tensorflow unavailable -- MusiCNN analysis disabled"

# Keep scipy/pandas aligned with tensorflow's numpy constraint in the shared Python env.
# Force exact wheel versions to avoid resolver drift leaving incompatible pandas/scipy.
#RUN uv pip uninstall pandas scipy numpy || true \
#    && uv pip install --no-cache-dir --force-reinstall \
#    'numpy==1.24.4' \
#    'scipy==1.10.1' \
#    'pandas==2.0.3'

# Fail fast during build if CLAP/Transformers dependency resolution regresses.
RUN python3 -c "import numpy, scipy, pandas, torch, torchaudio, laion_clap; from transformers import BertModel; print(f'CLAP deps OK: torch={torch.__version__} torchaudio={torchaudio.__version__} numpy={numpy.__version__} scipy={scipy.__version__} pandas={pandas.__version__}')"

# Cleanup
RUN   pip cache purge && \
      find /opt/ml-packages -name "*.pyc" -delete && \
      find /opt/ml-packages -name "__pycache__" -type d -exec rm -rf {} +
    


# =============================================================================
# Stage 3: Make runtime image
# =============================================================================

FROM debian:trixie-slim AS runtime
# Add PostgreSQL 16 repository
RUN apt-get update && apt-get install -y --no-install-recommends \
    gnupg lsb-release ca-certificates curl gnupg && \
    install -d /usr/share/postgresql-common/pgdg && \
    curl -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc --fail https://www.postgresql.org/media/keys/ACCC4CF8.asc && \
    echo 'deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt trixie-pgdg main' > /etc/apt/sources.list.d/pgdg.list && \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -  && \
    apt-get update && \
    apt-get install -y --no-install-recommends \
    postgresql-16 \
    postgresql-contrib-16 \
    postgresql-16-pgvector \
    redis-server \
    supervisor \
    ffmpeg \
    openssl \
    libsndfile1 \
    tini \
    gosu \
    python3 \
    nodejs && \
    curl -LsSf https://astral.sh/uv/install.sh | sh - && \
    rm -rf /var/lib/apt/lists/* && \
    groupadd -g 1000 kima && \
    useradd -u 1000 -g kima -s /bin/bash -m kima && \
    mkdir -p /app/backend && \
    mkdir -p /app/frontend && \
    mkdir -p /app/audio-analyzer && \
    mkdir -p /app/audio-analyzer-clap && \
    mkdir -p /app/models && \
    mkdir -p /music && \
    chown -R kima:kima /app /music && \
    mkdir -p /run/postgresql /data/postgres /data/redis /var/log/supervisor && \
    chown -R postgres:postgres /run/postgresql /data/postgres && \
    chown -R redis:redis /data/redis && \
    ln -s /usr/bin/python3 /usr/local/bin/python

COPY --from=python-packages /opt/ml-packages /opt/ml-packages
ENV PATH="/opt/ml-packages/bin:$PATH"

WORKDIR /app

# Copy startup scripts
COPY --chown=kima:kima docker/ /app/
COPY --chown=kima:kima backend/docker-entrypoint.sh /app/backend/
COPY --chown=kima:kima backend/healthcheck.js /app/backend/healthcheck.js
# Copy health check and startup
COPY --chown=kima:kima healthcheck-prod.js /app/healthcheck.js

RUN mv /app/supervisord.conf /etc/supervisor/conf.d/kima.conf && \
    chmod +x /app/*.sh && \
    chmod +x /app/backend/docker-entrypoint.sh


# Copy ML models
COPY --from=ml-downloader --chown=kima:kima /app/models/ /app/models/

# Copy audio analyzers
COPY --chown=kima:kima services/audio-analyzer/analyzer.py /app/audio-analyzer/
COPY --chown=kima:kima services/audio-analyzer-clap/analyzer.py /app/audio-analyzer-clap/

# Copy built backend
COPY --from=backend-build --chown=kima:kima /build/backend/node_modules /app/backend/node_modules
COPY --from=backend-build --chown=kima:kima /build/backend/dist /app/backend/dist
COPY --from=backend-build --chown=kima:kima /build/backend/prisma /app/backend/prisma
COPY --chown=kima:kima backend/package*.json /app/backend/
COPY --chown=kima:kima backend/tsconfig.json /app/backend/

# Copy built frontend
COPY --from=frontend-build --chown=kima:kima /build/frontend/.next /app/frontend/.next
COPY --from=frontend-build --chown=kima:kima /build/frontend/node_modules /app/frontend/node_modules
COPY --from=frontend-build --chown=kima:kima /build/frontend/public /app/frontend/public
COPY --chown=kima:kima frontend/package*.json /app/frontend/
COPY --chown=kima:kima frontend/next.config.ts /app/frontend/
COPY --chown=kima:kima frontend/tsconfig.json /app/frontend/

ENV KIMA_MUSIC_PATH="/music" \
    KIMA_AUDIO_ANALYZER_BATCH_SIZE=10 \
    KIMA_AUDIO_ANALYZER_SLEEP_INTERVAL=5 \
    KIMA_AUDIO_ANALYZER_MAX_ANALYZE_SECONDS=90 \
    KIMA_AUDIO_ANALYZER_BRPOP_TIMEOUT=30 \
    KIMA_AUDIO_ANALYZER_MODEL_IDLE_TIMEOUT=300 \
    KIMA_AUDIO_ANALYZER_NUM_WORKERS=2 \
    KIMA_AUDIO_ANALYZER_THREADS_PER_WORKER=1 \
    KIMA_CLAP_ENABLED=true \
    KIMA_CLAP_SLEEP_INTERVAL=5 \
    KIMA_CLAP_NUM_WORKERS=1 \
    KIMA_CLAP_MODEL_IDLE_TIMEOUT=300
# Expose ports
EXPOSE 3030

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD node /app/healthcheck.js

# Volume mounts
VOLUME ["/music", "/data"]
# Use tini for proper signal handling
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/app/start.sh"]
