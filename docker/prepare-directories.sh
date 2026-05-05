#!/bin/bash
set -e

# Prepare data directories (bind-mount safe)
echo "📁 Preparing data directories..."
mkdir -p /data/postgres /data/redis /data/cache/{covers,transcodes} /data/secrets /run/postgresql

# Fix PostgreSQL directory permissions
    if ! gosu postgres test -w /data/postgres; then
        chown -R postgres:postgres /data/postgres /run/postgresql 2>/dev/null || true
    fi

# Fix Redis directory permissions
    if ! gosu redis test -w /data/redis; then
        chown -R redis:redis /data/redis 2>/dev/null || true
    fi

# Fix kima user directory permissions (application files and cache)
    if ! gosu kima test -w /data/cache; then
        chown -R kima:kima /data/cache 2>/dev/null || true
    fi
    if ! gosu kima test -w /app; then
        chown -R kima:kima /app 2>/dev/null || true
    fi

echo "✅ Directories prepared successfully"
