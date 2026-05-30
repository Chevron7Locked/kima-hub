#!/bin/bash
set -e

# =============================================================================
# Kima Container Startup Script
# =============================================================================
# Orchestrates all services, database setup, and configuration

cat << "EOF"

╔═════════════════════════════════════════════════════════════════╗
║                                                                 ║
║         🎵 KIMA - Premium Self-Hosted Music Server 🎵             ║
║                                                                 ║
║  Features:                                                      ║
║    ✨ AI-Powered Vibe Matching (Essentia ML)                    ║
║    🎯 Smart Playlists & Mood Detection                          ║
║    🔊 High-Quality Audio Streaming                              ║
║                                                                 ║
║                                                                 ║
╚═════════════════════════════════════════════════════════════════╝

EOF

# =============================================================================
# Phase 0: Configure UID/GID (PUID/PGID support)
# =============================================================================
PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

# Modify kima user/group to match PUID/PGID
if [ "$(id -u kima)" != "$PUID" ] || [ "$(id -g kima)" != "$PGID" ]; then
  groupmod -o -g "$PGID" kima 2>/dev/null || true
  usermod -o -u "$PUID" kima 2>/dev/null || true
fi

echo "🔧 Phase 0: Configuring user permissions..."
echo "   PUID: $PUID"
echo "   PGID: $PGID"

# =============================================================================
# Phase 1: Prepare Environment
# =============================================================================
echo ""
echo "📋 Phase 1: Preparing environment..."

# Run directory preparation script
if [ -f /app/prepare-directories.sh ]; then
    bash /app/prepare-directories.sh
else
    echo "⚠️  Warning: prepare-directories.sh not found"
fi


# =============================================================================
# Phase 2: PostgreSQL Setup
# =============================================================================
echo ""
echo "🗄️  Phase 2: Setting up PostgreSQL..."

PG_BIN="/usr/lib/postgresql/16/bin"
PG_DATA="/data/postgres"

# Clean up stale PID file if exists
rm -f "$PG_DATA/postmaster.pid" 2>/dev/null || true

# Initialize PostgreSQL if not already done
if [ ! -f "$PG_DATA/PG_VERSION" ]; then
    echo "   Initializing PostgreSQL cluster..."
    gosu postgres "$PG_BIN/initdb" -D "$PG_DATA" \
        --auth=md5 \
        --auth-local=trust \
        --encoding=UTF8 \
        --locale=C.UTF-8
    echo "   ✅ PostgreSQL cluster initialized"
fi

# Start PostgreSQL temporarily for database setup
echo "   Starting PostgreSQL..."
gosu postgres "$PG_BIN/pg_ctl" -D "$PG_DATA" -w start >/dev/null 2>&1 >/dev/null || {
    echo "   ❌ Failed to start PostgreSQL"
    exit 1
}

# Create user and database if they don't exist
echo "   Setting up database and user..."
gosu postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname = 'kima'" 2>/dev/null | grep -q 1 || \
    gosu postgres psql -c "CREATE USER kima WITH PASSWORD 'kima';" 2>/dev/null || true
gosu postgres psql -tc "SELECT 1 FROM pg_database WHERE datname = 'kima'" 2>/dev/null | grep -q 1 || \
    gosu postgres psql -c "CREATE DATABASE kima OWNER kima;" 2>/dev/null || true

# Create pgvector extension
echo "   Creating pgvector extension..."
gosu postgres psql -d kima -c "CREATE EXTENSION IF NOT EXISTS vector;" 2>/dev/null || true

# Run database migrations
echo "   Running database migrations..."
cd /app/backend
export DATABASE_URL="postgresql://kima:kima@localhost:5432/kima"

# Check existing database state
MIGRATIONS_EXIST=$(gosu postgres psql -d kima -tAc "SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = '_prisma_migrations')" 2>/dev/null || echo "f")
USER_TABLE_EXIST=$(gosu postgres psql -d kima -tAc "SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'User')" 2>/dev/null || echo "f")



if [ "$MIGRATIONS_EXIST" = "t" ]; then
    echo "   📊 Migration history found"
    npx prisma migrate deploy 2>&1 || {
        echo "   ❌ Migration failed"
        exit 1
    }
elif [ "$USER_TABLE_EXIST" = "t" ]; then
    echo "   📊 Existing database detected (baselined)"
    npx prisma migrate resolve --applied 20241130000000_init || true
    npx prisma migrate deploy || {
        echo "   ❌ Migration failed"
        exit 1
    }
else
    echo "   📊 Fresh database, running initial migrations"
    npx prisma migrate deploy || {
        echo "   ❌ Migration failed"
        exit 1
    }
fi

# Verify schema
if ! gosu postgres psql -d kima -c "SELECT 1 FROM \"Track\" LIMIT 1"; then
    echo "   ❌ Schema verification failed"
    exit 1
fi
echo "   ✅ Schema verified"

# Create schema ready marker
touch /data/.schema_ready

KIMA_MUSIC_PATH=$(gosu postgres psql -d kima -tAc 'SELECT "musicPath" FROM "SystemSettings" LIMIT 1;' 2>/dev/null \
  | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')

if [ -z "$KIMA_MUSIC_PATH" ] || [ "$KIMA_MUSIC_PATH" = "null" ]; then
    KIMA_MUSIC_PATH="/music"
fi

export KIMA_MUSIC_PATH
echo "   🎵 KIMA_MUSIC_PATH: $KIMA_MUSIC_PATH"


# Stop PostgreSQL (supervisord will restart it)
gosu postgres "$PG_BIN/pg_ctl" -D "$PG_DATA" -w stop >/dev/null 2>&1

# =============================================================================
# Phase 3: Secrets Setup
# =============================================================================
echo ""
echo "🔐 Phase 3: Setting up secrets..."

mkdir -p /data/cache/{covers,transcodes} /data/secrets

# Load or generate persistent secrets
if [ -f /data/secrets/session_secret ]; then
    SESSION_SECRET=$(cat /data/secrets/session_secret)
else
    SESSION_SECRET=$(openssl rand -hex 32)
    echo "$SESSION_SECRET" > /data/secrets/session_secret
    chmod 600 /data/secrets/session_secret
fi

if [ -f /data/secrets/encryption_key ]; then
    SETTINGS_ENCRYPTION_KEY=$(cat /data/secrets/encryption_key)
else
    SETTINGS_ENCRYPTION_KEY=$(openssl rand -hex 32)
    echo "$SETTINGS_ENCRYPTION_KEY" > /data/secrets/encryption_key
    chmod 600 /data/secrets/encryption_key
fi

echo "   ✅ Secrets ready"

# =============================================================================
# Phase 4: Backend Configuration
# =============================================================================
echo ""
echo "⚙️  Phase 4: Configuring backend..."

cat > /app/backend/.env << ENVEOF
NODE_ENV=production
DATABASE_URL=postgresql://kima:kima@localhost:5432/kima
REDIS_URL=redis://localhost:6379
PORT=3006
MUSIC_PATH=${KIMA_MUSIC_PATH}
TRANSCODE_CACHE_PATH=/data/cache/transcodes
SESSION_SECRET=$SESSION_SECRET
SETTINGS_ENCRYPTION_KEY=$SETTINGS_ENCRYPTION_KEY
INTERNAL_API_SECRET=kima-internal-aio
ENVEOF

echo "   ✅ Configuration complete"

# =============================================================================
# Phase 5: Start Services
# =============================================================================
echo ""
echo "🚀 Phase 5: Starting services..."
echo ""

exec env \
    NODE_ENV=production \
    DATABASE_URL="postgresql://kima:kima@localhost:5432/kima" \
    REDIS_URL="redis://localhost:6379" \
    SESSION_SECRET="$SESSION_SECRET" \
    SETTINGS_ENCRYPTION_KEY="$SETTINGS_ENCRYPTION_KEY" \
    /usr/bin/supervisord -c /etc/supervisor/conf.d/kima.conf
