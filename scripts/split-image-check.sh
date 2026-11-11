#!/bin/sh
# Builds the split images (backend/Dockerfile, frontend/Dockerfile) and starts them the way
# docker-compose.yml does, against a throwaway Postgres and Redis. Fails when either image does
# not come up, when the backend entrypoint logs an error, failure or skipped step before the
# server starts, or when the frontend cannot reach the backend's /api/health.
#
# Usage: scripts/split-image-check.sh
#   BACKEND_IMAGE / FRONTEND_IMAGE: use these already-built images instead of building.
#   KEEP_IMAGES=1: keep the images this script built.
# Everything it creates is named split-check-<pid> and removed on exit.
set -eu

cd "$(dirname "$0")/.."
ID="split-check-$$"
NET="$ID-net"
BUILT=""

cleanup() {
  docker rm -f "$ID-pg" "$ID-redis" "$ID-backend" "$ID-frontend" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  if [ -n "$BUILT" ] && [ "${KEEP_IMAGES:-0}" != "1" ]; then
    # shellcheck disable=SC2086
    docker rmi $BUILT >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

fail() {
  echo "[split-image-check] FAIL: $1"
  for c in backend frontend; do
    echo "--- $c log (last 40 lines)"
    docker logs "$ID-$c" 2>&1 | tail -40 || true
  done
  exit 1
}

if [ -z "${BACKEND_IMAGE:-}" ]; then
  BACKEND_IMAGE="$ID-backend:local"
  echo "[split-image-check] building backend/Dockerfile"
  docker build -q -t "$BACKEND_IMAGE" backend >/dev/null
  BUILT="$BUILT $BACKEND_IMAGE"
fi
if [ -z "${FRONTEND_IMAGE:-}" ]; then
  FRONTEND_IMAGE="$ID-frontend:local"
  echo "[split-image-check] building frontend/Dockerfile"
  docker build -q -t "$FRONTEND_IMAGE" \
    --build-arg NEXT_PUBLIC_BACKEND_URL=http://backend:3006 frontend >/dev/null
  BUILT="$BUILT $FRONTEND_IMAGE"
fi

docker pull -q pgvector/pgvector:0.8.6-pg16 >/dev/null
docker pull -q redis:7-alpine >/dev/null
docker network create "$NET" >/dev/null
docker run -d --name "$ID-pg" --network "$NET" \
  -e POSTGRES_USER=kima -e POSTGRES_PASSWORD=kima -e POSTGRES_DB=kima \
  pgvector/pgvector:0.8.6-pg16 >/dev/null
docker run -d --name "$ID-redis" --network "$NET" redis:7-alpine >/dev/null

i=0
until docker exec "$ID-pg" pg_isready -U kima >/dev/null 2>&1; do
  i=$((i + 1)); [ $i -ge 60 ] && fail "Postgres did not become ready"; sleep 1
done

# MUSIC_PATH must exist inside the image for config validation to pass, as a compose mount does.
docker run -d --name "$ID-backend" --network "$NET" --network-alias backend \
  --tmpfs /music \
  -e DATABASE_URL="postgresql://kima:kima@$ID-pg:5432/kima" \
  -e REDIS_URL="redis://$ID-redis:6379" \
  -e MUSIC_PATH=/music \
  -e SESSION_SECRET="split-image-check-session-secret-0000000000" \
  -e SETTINGS_ENCRYPTION_KEY="split-image-check-encryption-key-000000000" \
  "$BACKEND_IMAGE" >/dev/null
# The frontend's backend address is baked in at build time (NEXT_PUBLIC_BACKEND_URL above).
docker run -d --name "$ID-frontend" --network "$NET" "$FRONTEND_IMAGE" >/dev/null

wait_for() { # container, log text, seconds
  i=0
  until docker logs "$1" 2>&1 | grep -q "$2"; do
    [ "$(docker inspect -f '{{.State.Running}}' "$1")" = "true" ] || fail "$1 exited"
    i=$((i + 2)); [ $i -ge "$3" ] && fail "$1 did not log '$2' within $3 s"; sleep 2
  done
}
wait_for "$ID-backend" "Kima API running" 240
wait_for "$ID-frontend" "Ready" 120

# The entrypoint's own lines are everything up to its last echo, before the server takes over.
ENTRY_END="Kima Backend starting on port"
docker logs "$ID-backend" 2>&1 | grep -q "$ENTRY_END" \
  || fail "the backend entrypoint's last line ('$ENTRY_END') is missing; update ENTRY_END to match backend/docker-entrypoint.sh"
ENTRY=$(docker logs "$ID-backend" 2>&1 | sed "/$ENTRY_END/q")
# A logged [ERROR], an uncaught Node error, or a step that says it failed or was skipped.
BAD=$(printf '%s\n' "$ENTRY" | grep -E '\[ERROR\]|^[A-Za-z]*Error:|\b([Ff]ailed|[Ss]kipped)\b' || true)
[ -z "$BAD" ] || fail "backend entrypoint logged:
$BAD"

STATUS=$(docker exec "$ID-frontend" node -e \
  "fetch('http://localhost:3030/api/health').then(r=>console.log(r.status)).catch(e=>console.log('fetch failed: '+e.message))")
[ "$STATUS" = "200" ] || fail "frontend /api/health through the backend answered $STATUS"

echo "[split-image-check] OK: both split images start, the backend entrypoint is clean, and the frontend reaches the backend"
