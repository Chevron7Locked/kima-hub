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

# Generate session secret if not provided
if [ -z "$SESSION_SECRET" ] || [ "$SESSION_SECRET" = "changeme-generate-secure-key" ]; then
  echo "[WARN] SESSION_SECRET not set or using default. Generating random key..."
  export SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
  echo "Generated SESSION_SECRET (will not persist across restarts - set it in .env for production)"
fi

# SETTINGS_ENCRYPTION_KEY is never defaulted: every stored credential is
# encrypted under it, so a generated key would make them unreadable after a
# restart. Without it the server stops with an error naming the variable and
# the command that generates one.

echo "[START] Kima Backend starting on port ${PORT:-3006}..."
echo "[CONFIG] Music path: ${MUSIC_PATH:-/music}"
echo "[CONFIG] Environment: ${NODE_ENV:-production}"

# Execute the main command
exec "$@"
