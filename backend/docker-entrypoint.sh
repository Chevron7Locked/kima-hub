#!/bin/sh
set -e

# Security check: Refuse to run as root
if [ "$(id -u)" = "0" ]; then
  echo ""
  echo "╔══════════════════════════════════════════════════════════════╗"
  echo "║  FATAL: CANNOT START AS ROOT                                 ║"
  echo "║                                                              ║"
  echo "║  Running as root is a security risk. This container must    ║"
  echo "║  run as a non-privileged user.                              ║"
  echo "║                                                              ║"
  echo "║  Do NOT use:                                                 ║"
  echo "║    - docker run --user root                                  ║"
  echo "║    - user: root in docker-compose.yml                        ║"
  echo "║                                                              ║"
  echo "║  The container is configured to run as 'node' user.         ║"
  echo "╚══════════════════════════════════════════════════════════════╝"
  echo ""
  exit 1
fi

echo "[START] Starting Kima Backend..."

# Docker Compose health checks ensure database and Redis are ready
# Add a small delay to be extra safe
echo "[WAIT] Waiting for services to be ready..."
sleep 3
echo "Services are ready"

# Run database migrations (with automatic baselining for existing databases)
echo "[DB] Running database migrations..."
sh ./migrate-safe.sh

# Generate Prisma client (in case of schema changes)
echo "[DB] Generating Prisma client..."
npx prisma generate

# Clear Redis cache on deployment to prevent stale data (e.g., 404 images)
echo "[REDIS] Clearing cache for fresh deployment..."
node -e "
const { createClient } = require('redis');
const client = createClient({ url: process.env.REDIS_URL || 'redis://redis:6379' });
client.connect()
  .then(() => client.flushAll())
  .then(() => { console.log('[REDIS] Cache cleared successfully'); return client.quit(); })
  .catch(err => { console.warn('[REDIS] Cache clear failed (non-critical):', err.message); });
" || echo "[REDIS] Cache clear skipped (Redis unavailable)"

# Generate session secret if not provided
if [ -z "$SESSION_SECRET" ] || [ "$SESSION_SECRET" = "changeme-generate-secure-key" ]; then
  echo "[WARN] SESSION_SECRET not set or using default. Generating random key..."
  export SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
  echo "Generated SESSION_SECRET (will not persist across restarts - set it in .env for production)"
fi

# SETTINGS_ENCRYPTION_KEY is deliberately NOT defaulted here.
#
# This used to fall back to the literal string "default-encryption-key-change-me",
# which is the exact value src/utils/encryption.ts refuses to start under. That
# module derives its key at import time, so the fallback did not produce a
# working-but-insecure server as its message promised -- it produced a boot
# crash, on the documented onboarding path (.env.example ships the variable
# empty and docker-compose.yml passes the empty value straight through).
#
# It is not defaulted to a GENERATED key either, the way SESSION_SECRET is two
# blocks above. A session secret is disposable: regenerating it logs everyone
# out. This key is not -- every stored credential and 2FA secret is encrypted
# under it, so a fresh key each boot silently makes all of them permanently
# unreadable. Losing data quietly is worse than refusing to start.
#
# So the container now fails with encryption.ts's own error, which names the
# variable and gives the command to generate one. The unified all-in-one image
# takes the other route and can afford to: it generates a key and PERSISTS it to
# /data/secrets/encryption_key, so the same key comes back after a restart.
# Doing that here needs somewhere durable to put it, which is a compose change.

echo "[START] Kima Backend starting on port ${PORT:-3006}..."
echo "[CONFIG] Music path: ${MUSIC_PATH:-/music}"
echo "[CONFIG] Environment: ${NODE_ENV:-production}"

# Execute the main command
exec "$@"
