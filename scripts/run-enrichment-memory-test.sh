#!/usr/bin/env bash
# Runs the enrichment-cycle Playwright test and fails if host SUnreclaim grows
# more than SUNRECLAIM_LIMIT_MB (default 1024). Usage: [container-name].
# Env: KIMA_TEST_PASSWORD and KIMA_UI_BASE_URL (both required; never port 3030,
# the production server), KIMA_TEST_USERNAME, KIMA_CONTAINER (default kima-test).

set -euo pipefail

CONTAINER="${KIMA_CONTAINER:-kima-test}"

# This run wipes and re-enriches the library, so the address must be given and must not be production.
if [[ -z "${KIMA_UI_BASE_URL:-}" ]]; then
    echo "[error] KIMA_UI_BASE_URL is not set. Set it to the address of the test server"
    echo "        (for example http://127.0.0.1:3056). The tests never choose a server on their own."
    exit 1
fi
BASE_URL="${KIMA_UI_BASE_URL}"
if [[ ! "${BASE_URL}" =~ ^https?://[^/:]+(:([0-9]+))?(/.*)?$ ]]; then
    echo "[error] KIMA_UI_BASE_URL is not a web address: \"${BASE_URL}\""
    exit 1
fi
if [[ "${BASH_REMATCH[2]}" == "3030" ]]; then
    echo "[error] KIMA_UI_BASE_URL points at port 3030, which is the production Kima server."
    echo "        These tests never run against it. Point KIMA_UI_BASE_URL at a test server."
    exit 1
fi
export KIMA_UI_BASE_URL
SUNRECLAIM_LIMIT="${SUNRECLAIM_LIMIT_MB:-1024}"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

sunreclaim_mb() {
    awk '/^SUnreclaim:/ { printf "%d", $2 / 1024 }' /proc/meminfo
}

container_mem_mb() {
    docker stats --no-stream --format "{{.MemUsage}}" "${CONTAINER}" 2>/dev/null \
        | awk '{ match($0, /^([0-9.]+)([GMkB]+)/, arr); v=arr[1]; u=arr[2]; if(u~/GiB/) printf "%d", v*1024; else if(u~/MiB/) printf "%d", v; else printf "%d", v/1024 }'
}

# ---------------------------------------------------------------------------
# Pre-flight
# ---------------------------------------------------------------------------

if ! docker ps --format "{{.Names}}" | grep -q "^${CONTAINER}$"; then
    echo "[error] Container '${CONTAINER}' is not running."
    echo "        Start a Kima container with that name first."
    exit 1
fi

if [[ -z "${KIMA_TEST_PASSWORD:-}" ]]; then
    echo "[error] KIMA_TEST_PASSWORD is not set."
    exit 1
fi

echo "[memory-test] Waiting for health check..."
timeout 30 bash -c "until curl -sf ${BASE_URL}/api/health > /dev/null; do sleep 2; done"

# ---------------------------------------------------------------------------
# Baseline memory snapshot
# ---------------------------------------------------------------------------

SUNRECLAIM_BEFORE=$(sunreclaim_mb)
CONTAINER_MEM_BEFORE=$(container_mem_mb)

echo ""
echo "=========================================================="
echo "  Memory baseline"
echo "  Host SUnreclaim:   ${SUNRECLAIM_BEFORE} MB"
echo "  Container RSS:     ${CONTAINER_MEM_BEFORE} MB"
echo "=========================================================="
echo ""

# ---------------------------------------------------------------------------
# Run the Playwright enrichment-cycle spec
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND_DIR="${SCRIPT_DIR}/../frontend"

echo "[memory-test] Running enrichment-cycle spec..."
TEST_EXIT=0
npx --prefix "${FRONTEND_DIR}" playwright test \
    tests/e2e/enrichment-cycle.spec.ts \
    --reporter=list || TEST_EXIT=$?

# ---------------------------------------------------------------------------
# Post-test memory snapshot
# ---------------------------------------------------------------------------

SUNRECLAIM_AFTER=$(sunreclaim_mb)
CONTAINER_MEM_AFTER=$(container_mem_mb)
SUNRECLAIM_DELTA=$(( SUNRECLAIM_AFTER - SUNRECLAIM_BEFORE ))
CONTAINER_MEM_DELTA=$(( CONTAINER_MEM_AFTER - CONTAINER_MEM_BEFORE ))

echo ""
echo "=========================================================="
echo "  Memory after enrichment cycle"
echo "  Host SUnreclaim:   ${SUNRECLAIM_AFTER} MB  (delta: +${SUNRECLAIM_DELTA} MB)"
echo "  Container RSS:     ${CONTAINER_MEM_AFTER} MB  (delta: +${CONTAINER_MEM_DELTA} MB)"
echo "=========================================================="
echo ""

# ---------------------------------------------------------------------------
# Fail if slab growth exceeds threshold
# ---------------------------------------------------------------------------

if (( SUNRECLAIM_DELTA > SUNRECLAIM_LIMIT )); then
    echo "[FAIL] Host SUnreclaim grew by ${SUNRECLAIM_DELTA} MB -- exceeds limit of ${SUNRECLAIM_LIMIT} MB."
    echo "       This indicates kernel slab (anon_vma_chain) accumulation from the enrichment pipeline."
    echo "       Check: /proc/slabinfo | grep anon_vma -- if anon_vma_chain is large, suspect"
    echo "       excessive process forks or repeated VMA splits during audio processing."
    exit 1
fi

echo "[memory-test] Slab growth within acceptable range (${SUNRECLAIM_DELTA} MB < ${SUNRECLAIM_LIMIT} MB limit)."

# Propagate Playwright exit code
exit "${TEST_EXIT}"
