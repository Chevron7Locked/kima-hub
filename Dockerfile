# Kima All-in-One Docker Image (Hardened)
# Contains: Backend, Frontend, PostgreSQL, Redis, Audio Analyzer (Essentia AI)
# Usage: docker run -d -p 3030:3030 -v /path/to/music:/music kima/kima

FROM node:20-slim

# Add PostgreSQL 16 repository (Debian Bookworm only has PG15 by default)
RUN apt-get update && apt-get install -y --no-install-recommends \
    gnupg lsb-release curl ca-certificates && \
    echo "deb http://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list && \
    curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /etc/apt/trusted.gpg.d/postgresql.gpg && \
    apt-get update

# Install system dependencies including Python for audio analysis
RUN apt-get install -y --no-install-recommends \
    postgresql-16 \
    postgresql-contrib-16 \
    postgresql-16-pgvector \
    redis-server \
    supervisor \
    ffmpeg \
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
    && rm -rf /var/lib/apt/lists/*

# Create directories
RUN mkdir -p /app/backend /app/frontend /app/audio-analyzer /app/models \
    /data/postgres /data/redis /run/postgresql /var/log/supervisor \
    && chown -R postgres:postgres /data/postgres /run/postgresql

# ============================================
# AUDIO ANALYZER SETUP (Essentia AI)
# ============================================
WORKDIR /app/audio-analyzer

# Install all Python dependencies in a single layer to minimize image size
# CPU-only torch/torchaudio: install first via the CPU index so downstream
# packages (laion-clap, transformers) reuse the already-installed CPU wheels.
# tensorflow-cpu replaces tensorflow to avoid pulling in CUDA runtime libs.
# essentia-tensorflow declares a dependency on `tensorflow` (not tensorflow-cpu)
# so we install it with --no-deps after tensorflow-cpu is already present.
RUN pip3 install --no-cache-dir --break-system-packages \
    torch torchaudio torchvision \
    --index-url https://download.pytorch.org/whl/cpu \
    && pip3 install --no-cache-dir --break-system-packages \
    'tensorflow-cpu>=2.13.0,<2.14.0' \
    && pip3 install --no-cache-dir --break-system-packages --no-deps \
    essentia-tensorflow \
    && pip3 install --no-cache-dir --break-system-packages \
    redis \
    psycopg2-binary \
    'laion-clap>=1.1.4' \
    'librosa>=0.10.0' \
    'transformers>=4.30.0' \
    'pgvector>=0.2.0' \
    'python-dotenv>=1.0.0' \
    'requests>=2.31.0' \
    'bullmq==2.19.5' \
    && pip cache purge \
    && find /usr -name "*.pyc" -delete \
    && find /usr -name "__pycache__" -type d -exec rm -rf {} + 2>/dev/null || true

# Download all ML models in a single layer (~800MB total)
# IMPORTANT: Using MusiCNN models to match analyzer.py expectations
RUN echo "Downloading ML models..." && \
    curl -L --retry 3 --retry-delay 5 --connect-timeout 30 --max-time 300 -o /app/models/msd-musicnn-1.pb \
        "https://essentia.upf.edu/models/autotagging/msd/msd-musicnn-1.pb" && \
    curl -L --retry 3 --retry-delay 5 --connect-timeout 30 --max-time 300 -o /app/models/mood_happy-msd-musicnn-1.pb \
        "https://essentia.upf.edu/models/classification-heads/mood_happy/mood_happy-msd-musicnn-1.pb" && \
    curl -L --retry 3 --retry-delay 5 --connect-timeout 30 --max-time 300 -o /app/models/mood_sad-msd-musicnn-1.pb \
        "https://essentia.upf.edu/models/classification-heads/mood_sad/mood_sad-msd-musicnn-1.pb" && \
    curl -L --retry 3 --retry-delay 5 --connect-timeout 30 --max-time 300 -o /app/models/mood_relaxed-msd-musicnn-1.pb \
        "https://essentia.upf.edu/models/classification-heads/mood_relaxed/mood_relaxed-msd-musicnn-1.pb" && \
    curl -L --retry 3 --retry-delay 5 --connect-timeout 30 --max-time 300 -o /app/models/mood_aggressive-msd-musicnn-1.pb \
        "https://essentia.upf.edu/models/classification-heads/mood_aggressive/mood_aggressive-msd-musicnn-1.pb" && \
    curl -L --retry 3 --retry-delay 5 --connect-timeout 30 --max-time 300 -o /app/models/mood_party-msd-musicnn-1.pb \
        "https://essentia.upf.edu/models/classification-heads/mood_party/mood_party-msd-musicnn-1.pb" && \
    curl -L --retry 3 --retry-delay 5 --connect-timeout 30 --max-time 300 -o /app/models/mood_acoustic-msd-musicnn-1.pb \
        "https://essentia.upf.edu/models/classification-heads/mood_acoustic/mood_acoustic-msd-musicnn-1.pb" && \
    curl -L --retry 3 --retry-delay 5 --connect-timeout 30 --max-time 300 -o /app/models/mood_electronic-msd-musicnn-1.pb \
        "https://essentia.upf.edu/models/classification-heads/mood_electronic/mood_electronic-msd-musicnn-1.pb" && \
    curl -L --retry 3 --retry-delay 5 --connect-timeout 30 --max-time 300 -o /app/models/danceability-msd-musicnn-1.pb \
        "https://essentia.upf.edu/models/classification-heads/danceability/danceability-msd-musicnn-1.pb" && \
    curl -L --retry 3 --retry-delay 5 --connect-timeout 30 --max-time 300 -o /app/models/voice_instrumental-msd-musicnn-1.pb \
        "https://essentia.upf.edu/models/classification-heads/voice_instrumental/voice_instrumental-msd-musicnn-1.pb" && \
    curl -L --retry 3 --retry-delay 5 --connect-timeout 30 --max-time 300 -o /app/models/music_audioset_epoch_15_esc_90.14.pt \
        "https://huggingface.co/lukewys/laion_clap/resolve/main/music_audioset_epoch_15_esc_90.14.pt" && \
    echo "All ML models downloaded" && \
    ls -lh /app/models/

# Copy audio analyzer scripts
COPY services/audio-analyzer/analyzer.py /app/audio-analyzer/

# ============================================
# CLAP ANALYZER SETUP (Vibe Similarity)
# ============================================
WORKDIR /app/audio-analyzer-clap

# Copy CLAP analyzer script
COPY services/audio-analyzer-clap/analyzer.py /app/audio-analyzer-clap/

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
COPY backend/healthcheck.js ./healthcheck-backend.js

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
ENV NEXT_PUBLIC_BACKEND_URL=http://127.0.0.1:3006
RUN npm run build

# ============================================
# SECURITY HARDENING
# ============================================
# Remove dangerous tools and build dependencies AFTER all builds are complete
# Keep: bash (supervisor), gosu (postgres user switching), python3 (audio analyzer)
RUN apt-get purge -y --auto-remove build-essential python3-dev 2>/dev/null || true && \
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
COPY healthcheck-prod.js /app/healthcheck.js

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
command=/bin/bash -c "sleep 10 && cd /app/frontend && npm start"
autostart=true
autorestart=true
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0
environment=NODE_ENV="production",BACKEND_URL="http://localhost:3006",PORT="3030"
priority=40

[program:audio-analyzer]
command=/bin/bash -c "/app/wait-for-db.sh 120 && cd /app/audio-analyzer && python3 analyzer.py"
autostart=true
autorestart=true
startretries=3
startsecs=10
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0
environment=DATABASE_URL="postgresql://kima:kima@localhost:5432/kima",REDIS_URL="redis://localhost:6379",MUSIC_PATH="/music",BATCH_SIZE="10",SLEEP_INTERVAL="5",MAX_ANALYZE_SECONDS="90",BRPOP_TIMEOUT="30",MODEL_IDLE_TIMEOUT="300",NUM_WORKERS="2",THREADS_PER_WORKER="1"
priority=50

[program:audio-analyzer-clap]
command=/bin/bash -c "/app/wait-for-db.sh 120 && cd /app/audio-analyzer-clap && python3 analyzer.py"
autostart=true
autorestart=true
startretries=3
startsecs=30
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0
environment=DATABASE_URL="postgresql://kima:kima@localhost:5432/kima",REDIS_URL="redis://localhost:6379",MUSIC_PATH="/music",BACKEND_URL="http://localhost:3006",SLEEP_INTERVAL="5",NUM_WORKERS="1",MODEL_IDLE_TIMEOUT="300",INTERNAL_API_SECRET="kima-internal-aio"
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

# Handle rename migration for existing databases
echo "Checking if rename migration needs to be marked as applied..."
if gosu postgres psql -d kima -tAc "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='SystemSettings' AND column_name='soulseekFallback');" 2>/dev/null | grep -q 't'; then
    echo "Old column exists, marking migration as applied..."
    gosu postgres psql -d kima -c "INSERT INTO \"_prisma_migrations\" (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count) VALUES (gen_random_uuid(), '', NOW(), '20250101000000_rename_soulseek_fallback', '', NULL, NOW(), 1) ON CONFLICT DO NOTHING;" 2>/dev/null || true
fi

if [ "$MIGRATIONS_EXIST" = "t" ]; then
    # Normal migration flow - migrations table exists
    echo "Migration history found, running migrate deploy..."
    if ! npx prisma migrate deploy 2>&1; then
        echo "FATAL: Database migration failed! Check logs above."
        exit 1
    fi
elif [ "$USER_TABLE_EXIST" = "t" ]; then
    # Database has data but no migrations table - needs baseline
    echo "Existing database detected without migration history."
    echo "Creating baseline from current schema..."
    # Mark the init migration as already applied (baseline)
    npx prisma migrate resolve --applied 20241130000000_init 2>&1 || true
    # Now run any subsequent migrations
    if ! npx prisma migrate deploy 2>&1; then
        echo "FATAL: Migration after baseline failed!"
        exit 1
    fi
else
    # Fresh database - run migrations normally
    echo "Fresh database detected, running initial migrations..."
    if ! npx prisma migrate deploy 2>&1; then
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
INTERNAL_API_SECRET=kima-internal-aio
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
