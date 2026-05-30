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
