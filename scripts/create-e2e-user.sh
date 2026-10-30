#!/usr/bin/env bash
# Creates the E2E test user inside a running Kima container and prints the
# credentials for Playwright. Env: KIMA_TEST_USERNAME (default kima_e2e),
# KIMA_TEST_PASSWORD (default random), KIMA_CONTAINER (default kima-test).

set -euo pipefail

CONTAINER="${KIMA_CONTAINER:-kima-test}"
TEST_USER="${KIMA_TEST_USERNAME:-kima_e2e}"
TEST_PASS="${KIMA_TEST_PASSWORD:-$(openssl rand -hex 20)}"

# Validate username to prevent SQL injection via the heredoc
if [[ ! "${TEST_USER}" =~ ^[a-zA-Z0-9_]{3,32}$ ]]; then
    echo "[e2e setup] ERROR: KIMA_TEST_USERNAME must be 3-32 alphanumeric/underscore characters" >&2
    exit 1
fi

echo "[e2e setup] Creating test user '${TEST_USER}' in container '${CONTAINER}'..."

# Generate bcrypt hash inside the container where bcrypt is installed.
# Pass the password via -e so Docker sets it as an env var -- avoids shell
# quoting and expansion issues with special characters in the password.
HASH=$(docker exec -e "TEST_PASS=${TEST_PASS}" "${CONTAINER}" bash -c '
  cd /app/backend && node -e "
    const b = require(\"bcrypt\");
    b.hash(process.env.TEST_PASS, 10).then(h => process.stdout.write(h));
  "
')

# Write SQL to a temp file inside the container to avoid dollar sign expansion.
# The bcrypt hash contains $2b$10$... which bash would mangle if embedded in
# a double-quoted string passed to docker exec.
docker exec -e "HASH=${HASH}" -e "TEST_USER=${TEST_USER}" "${CONTAINER}" bash -c '
  # Heredoc is unquoted so ${TEST_USER} and ${HASH} expand (env vars set via -e above).
  # SQL single quotes are plain literals here -- no shell escaping needed.
  # Stop at the first error, so a schema change that breaks this script fails the setup instead of passing quietly.
  psql -v ON_ERROR_STOP=1 -U kima -d kima <<ENDSQL
INSERT INTO "User" (id, username, "passwordHash", role, "onboardingComplete")
VALUES ('\''e2e_test_user_kima'\'', '\''${TEST_USER}'\'', '\''${HASH}'\'', '\''admin'\'', true)
ON CONFLICT (username) DO UPDATE
  SET "passwordHash" = EXCLUDED."passwordHash",
      role = EXCLUDED.role;
INSERT INTO "UserSettings" ("userId", "playbackQuality", "wifiOnly")
SELECT id, '\''original'\'', false FROM "User" WHERE username = '\''${TEST_USER}'\''
ON CONFLICT ("userId") DO NOTHING;
ENDSQL
'

echo "[e2e setup] Test user '${TEST_USER}' ready."
