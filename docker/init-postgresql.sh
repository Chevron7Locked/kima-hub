#!/bin/bash
set -e

PG_BIN="/usr/lib/postgresql/16/bin"
PG_DATA="/data/postgres"

echo "🗄️  Initializing PostgreSQL..."

# Check if database already exists
if [ ! -d "$PG_DATA" ] || [ ! -f "$PG_DATA/PG_VERSION" ]; then
    echo "Creating new PostgreSQL cluster..."
    gosu postgres "$PG_BIN/initdb" -D "$PG_DATA" \
        --auth=md5 \
        --auth-local=trust \
        --encoding=UTF8 \
        --locale=C.UTF-8
    echo "✅ PostgreSQL cluster initialized"
else
    echo "✅ PostgreSQL data directory already exists"
fi

# Start PostgreSQL
echo "Starting PostgreSQL..."
gosu postgres "$PG_BIN/postgres" -D "$PG_DATA" &
PG_PID=$!

# Wait for PostgreSQL to be ready (with timeout)
echo "Waiting for PostgreSQL to be ready..."
for i in {1..30}; do
    if gosu postgres "$PG_BIN/pg_isready" -D "$PG_DATA" >/dev/null 2>&1; then
        echo "✅ PostgreSQL is ready"
        exit 0
    fi
    echo "Attempt $i/30: PostgreSQL not ready yet, waiting..."
    sleep 1
done

echo "❌ PostgreSQL failed to start"
kill $PG_PID 2>/dev/null || true
exit 1
