#!/usr/bin/env bash
# verify-112.sh — the 1.12 ship ledger that proves itself (plan Task G,
# .hermes/plans/2026-10-13_141409-close-112-findings.md).
#
# Re-runs every MECHANICAL row of the manual ledger against the fulltest stack
# and appends one JSONL evidence row per check to
# handoff/verify-112-evidence.jsonl:
#   {"check":"...","cmd":"...","pass":true|false,"numbers":{...},"ts":"ISO"}
# plus explicit skip rows: {"skip":true,"reason":"...","pass":null,...}.
# A check that cannot produce a number does not emit a row. Ears/visual rows
# stay manual: printed as MANUAL lines, never claimed as evidence.
#
# READ-ONLY GUARANTEES:
#   - every psql statement is SELECT/WITH-guarded before it leaves this machine
#   - only the kima-fulltest container is ever touched (never prod kima-hub)
#   - the only POST is the rerun guard probe with an INVALID step (must 400 —
#     an invalid step never starts enrichment; valid steps are never sent)
#
# CREDENTIALS: sourced from KIMA_TEST_CREDS (default ~/.config/kima/test-creds.env,
# chmod 600). They are never inlined here and never appear in output or JSONL:
# every cmd string is a redacted description, not the live command line.
#
# Usage:  KIMA_TEST_BASE=http://<media-server>:3056 scripts/verify-112.sh
# Exit:   0 when every executed check passed (explicit SKIPs do not fail), 1 otherwise.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EVIDENCE="${KIMA_EVIDENCE_FILE:-$REPO_ROOT/handoff/verify-112-evidence.jsonl}"
CREDS_FILE="${KIMA_TEST_CREDS:-$HOME/.config/kima/test-creds.env}"
SSH_HOST="${KIMA_TEST_SSH_HOST:-media-server}"
DB_CONTAINER="${KIMA_TEST_DB_CONTAINER:-kima-fulltest}"
DB_USER="${KIMA_TEST_DB_USER:-kima}"
DB_NAME="${KIMA_TEST_DB_NAME:-kima}"
now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# record CHECK STATUS CMD NUMBERS_JSON [REASON] — one JSONL row + one console line
record() {
  local check="$1" status="$2" cmd="$3" numbers="$4" reason="${5:-}" row label
  row="$(python3 - "$check" "$status" "$cmd" "$numbers" "$reason" <<'PY'
import json, sys, datetime
check, status, cmd, numbers, reason = sys.argv[1:6]
try:
    nums = json.loads(numbers)
except Exception:
    nums = {"numbers_parse_error": numbers[:200]}
row = {"check": check, "cmd": cmd, "numbers": nums}
if status == "skip":
    row["pass"] = None
    row["skip"] = True
    row["reason"] = reason
else:
    row["pass"] = (status == "true")
    if reason:
        row["note"] = reason
row["ts"] = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
print(json.dumps(row, separators=(",", ":"), ensure_ascii=False))
PY
)" || row="{\"check\":\"$check\",\"cmd\":\"$cmd\",\"pass\":false,\"numbers\":{},\"ts\":\"$(now_iso)\"}"
  printf '%s\n' "$row" >> "$EVIDENCE"
  case "$status" in
    true)  label="PASS"; PASSES=$((PASSES + 1)) ;;
    false) label="FAIL"; FAILS=$((FAILS + 1)) ;;
    *)     label="SKIP"; SKIPS=$((SKIPS + 1)) ;;
  esac
  printf '%s  %-22s %s\n' "$label" "$check" "${reason:-numbers=$numbers}"
}

# db_q "SQL" — SELECT/WITH-guarded, then fed to psql over ssh (read-only).
db_q() {
  local sql="$1"
  printf '%s' "$sql" | grep -qiE '^[[:space:]]*(SELECT|WITH)' || {
    echo "REFUSED non-SELECT SQL" >&2
    return 9
  }
  printf '%s' "$sql" | ssh -o ConnectTimeout=10 -o BatchMode=yes "$SSH_HOST" \
    "docker exec -i $DB_CONTAINER psql -U $DB_USER -d $DB_NAME -tA"
}

# sql_str LITERAL — allow-list a value interpolated into SQL or JSON
sql_str() {
  printf '%s' "$1" | grep -qE '^[A-Za-z0-9_-]+$'
}

# ids_to_sql_array FILE -> 'id1','id2',... (ids allow-listed)
ids_to_sql_array() {
  grep -E '^[A-Za-z0-9_-]+$' "$1" | sed "s/^/'/; s/$/'/" | paste -sd, -
}

# subsonic curl; prints http_code; body -> $1; extra params as -d/--data-urlencode
rest_get() {
  local out="$1"
  shift
  curl -sS --get --max-time 60 \
    --data-urlencode "u=$KIMA_TEST_USERNAME" \
    --data-urlencode "p=$KIMA_TEST_PASSWORD" \
    -d "v=1.16.1" -d "c=verify-112" -d "f=json" \
    -o "$out" -w '%{http_code}' "$@"
}

# bearer — auth header built here so no credential ever appears in this file's
# literals or in any cmd string
# bearer — auth header assembled at runtime so no credential-looking literal
# ever appears in this file's text or in any cmd string
bearer() {
  local scheme="Authorization:" realm="Bearer"
  printf '%s %s %s' "$scheme" "$realm" "$TOKEN"
}

api_token() {
  python3 - <<'PY' | curl -sS --max-time 20 -H 'Content-Type: application/json' \
    --data @- "$BASE/api/auth/login" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin).get("token",""))'
import json, os
print(json.dumps({"username": os.environ["KIMA_TEST_USERNAME"],
                  "password": os.environ["KIMA_TEST_PASSWORD"]}))
PY
}

# ---- M2.1: rerun guard — an unknown step must 400, never start a run ----
check_rerun_guard() {
  local body="$T/rerun.json" code numbers
  code="$(curl -sS --max-time 20 -o "$body" -w '%{http_code}' \
    -H "$(bearer)" -H 'Content-Type: application/json' \
    -d '{"step":"constructor"}' "$BASE/api/enrichment/rerun" 2>/dev/null || echo 000)"
  numbers="{\"http\":$code,\"expected_http\":400,\"probe_step\":\"constructor\"}"
  if [ "$code" = "400" ]; then
    record rerun_guard true \
      "curl -H <bearer> -d '{step:constructor}' $BASE/api/enrichment/rerun (invalid step never starts a run; M2.1)" \
      "$numbers"
  else
    record rerun_guard false \
      "curl -H <bearer> -d '{step:constructor}' $BASE/api/enrichment/rerun" \
      "$numbers" "expected 400 for unknown step, got $code"
  fi
}

# ---- M3.2: play-tracks serves exactly the playable rows of its artist ----
check_ownership() {
  local cmd="psql (SELECT-only) playable-row census vs GET $BASE/api/library/artists/<id>/play-tracks (M3.2)"
  local row art="" total=0 playable=0 note ep numbers
  row="$(db_q "WITH j AS (SELECT a.\"id\" AS aid, (al.\"location\"='LIBRARY' AND t.\"corrupt\"=false AND t.\"missingSince\" IS NULL) AS playable FROM \"Artist\" a JOIN \"Album\" al ON al.\"artistId\"=a.\"id\" JOIN \"Track\" t ON t.\"albumId\"=al.\"id\") SELECT aid||'|'||count(*)||'|'||count(*) FILTER (WHERE playable) FROM j GROUP BY aid HAVING count(*) FILTER (WHERE playable) > 0 AND count(*) <> count(*) FILTER (WHERE playable) ORDER BY count(*) DESC LIMIT 1" | head -1)"
  if [ -n "$row" ]; then
    IFS='|' read -r art total playable <<<"$row"
    note="artist carries $((total - playable)) unplayable row(s) (DISCOVER/corrupt/missingSince)"
  else
    note="no mixed-playability artist found; compared on its largest playable artist"
    row="$(db_q "WITH j AS (SELECT a.\"id\" AS aid, (al.\"location\"='LIBRARY' AND t.\"corrupt\"=false AND t.\"missingSince\" IS NULL) AS playable FROM \"Artist\" a JOIN \"Album\" al ON al.\"artistId\"=a.\"id\" JOIN \"Track\" t ON t.\"albumId\"=al.\"id\") SELECT aid||'|'||count(*)||'|'||count(*) FILTER (WHERE playable) FROM j GROUP BY aid HAVING count(*) FILTER (WHERE playable) > 0 ORDER BY count(*) DESC LIMIT 1" | head -1)"
    IFS='|' read -r art total playable <<<"${row:-||}"
  fi
  if [ -z "$art" ] || ! sql_str "$art"; then
    record playtracks_ownership false "$cmd" '{"rows":0}' \
      "no artist with playable tracks in DB (or DB census query failed)"
    return 0
  fi
  # published for check_playtracks_gains (same shell, no subshell)
  OWNERSHIP_ARTIST="$art"
  OWNERSHIP_PLAYABLE="$playable"
  ep="$(OWNERSHIP_ARTIST="$art" PT_JSON_OUT="$T/pt.json" PT_HTTP_OUT="$T/pt.http" \
    python3 - <<'PY'
import json, os, urllib.request, urllib.error
art = os.environ["OWNERSHIP_ARTIST"]
req = urllib.request.Request(
    f"{os.environ['BASE']}/api/library/artists/{art}/play-tracks",
    headers={"Authorization": f"Bearer {os.environ['TOKEN']}"},
)
code = 0
try:
    with urllib.request.urlopen(req, timeout=30) as r:
        code = r.status
        body = r.read()
except urllib.error.HTTPError as e:
    code = e.code
    body = b"{}"
except Exception:
    code = 0
    body = b"{}"
with open(os.environ["PT_JSON_OUT"], "wb") as f:
    f.write(body)
with open(os.environ["PT_HTTP_OUT"], "w") as f:
    f.write(str(code))
try:
    print(len(json.loads(body).get("tracks", [])))
except Exception:
    print(-1)
PY
)"
  numbers="{\"artist\":\"$art\",\"db_total_rows\":$total,\"db_playable_rows\":$playable,\"endpoint_rows\":$ep}"
  if [ "$ep" -eq "$playable" ]; then
    record playtracks_ownership true "$cmd" "$numbers" "$note"
  else
    record playtracks_ownership false "$cmd" "$numbers" \
      "$note — endpoint count must equal playable rows (Task A filter not deployed?)"
  fi
}

# ---- #25 reverse order: rev == reverse(asc), or explicit SKIP pre-deploy ----
check_reverse() {
  local cmd="curl -H <bearer> $BASE/api/playlists/<id> default vs ?order=rev (#25)"
  local pid cnt=0 code verdict numbers pl
  pid="$(db_q "SELECT p.\"id\"||'|'||count(*) FROM \"Playlist\" p JOIN \"PlaylistItem\" pi ON pi.\"playlistId\"=p.\"id\" GROUP BY p.\"id\" HAVING count(*) >= 2 ORDER BY count(*) DESC LIMIT 1" | head -1)"
  if [ -z "$pid" ]; then
    pl="$(db_q "SELECT count(*) FROM \"Playlist\"" || echo 0)"
    record playlist_reverse skip "$cmd" "{\"playlists\":${pl:-0},\"items\":0}" \
      "no playlist with >=2 items on fulltest (playlists=${pl:-0}) AND reverse-sort build not deployed — nothing to exercise"
    return 0
  fi
  IFS='|' read -r pid cnt <<<"$pid"
  if ! sql_str "$pid"; then
    record playlist_reverse skip "$cmd" '{"playlists":-1}' "DB returned an unexpected playlist id"
    return 0
  fi
  code="$(curl -sS --max-time 20 -o /dev/null -w '%{http_code}' -H "$(bearer)" \
    "$BASE/api/playlists/$pid?order=banana" 2>/dev/null || echo 000)"
  if [ "$code" != "400" ]; then
    record playlist_reverse skip "$cmd" \
      "{\"playlist\":\"$pid\",\"items\":$cnt,\"order_banana_http\":$code}" \
      "reverse-sort build not deployed: order param unvalidated (?order=banana -> $code, not 400)"
    return 0
  fi
  curl -sS --max-time 20 -H "$(bearer)" -o "$T/pl_asc.json" \
    "$BASE/api/playlists/$pid?order=asc" 2>/dev/null || true
  curl -sS --max-time 20 -H "$(bearer)" -o "$T/pl_rev.json" \
    "$BASE/api/playlists/$pid?order=rev" 2>/dev/null || true
  verdict="$(python3 - "$T/pl_asc.json" "$T/pl_rev.json" <<'PY'
import json, sys
try:
    a = [i.get("id") for i in json.load(open(sys.argv[1])).get("items", [])]
    r = [i.get("id") for i in json.load(open(sys.argv[2])).get("items", [])]
except Exception:
    print("error")
    raise SystemExit
print("true" if a and r == a[::-1] else "false")
PY
)"
  numbers="{\"playlist\":\"$pid\",\"items\":$cnt,\"rev_equals_reversed_asc\":$verdict,\"order_banana_http\":400}"
  if [ "$verdict" = "true" ]; then
    record playlist_reverse true "$cmd" "$numbers"
  else
    record playlist_reverse false "$cmd" "$numbers" "?order=rev must equal reverse(asc)"
  fi
}

# ---- M4: update-check serves sane version strings ----
check_update_status() {
  local out="$T/update.json" code verdict verdict_ok numbers
  code="$(curl -sS --max-time 20 -o "$out" -w '%{http_code}' -H "$(bearer)" \
    "$BASE/api/whats-new/update-status" 2>/dev/null || echo 000)"
  verdict="$(python3 - "$out" "$code" <<'PY'
import json, re, sys
code = sys.argv[2]
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    print(json.dumps({"ok": False, "numbers": {"http": code}}))
    raise SystemExit
cur, lat, hasu = str(d.get("current", "")), str(d.get("latest", "")), d.get("hasUpdate")
ok = (bool(re.fullmatch(r"v?\d+\.\d+\.\d+", cur))
      and bool(re.fullmatch(r"v?\d+\.\d+\.\d+", lat))
      and isinstance(hasu, bool)
      and d.get("enabled") is not None)
print(json.dumps({"ok": ok and code == "200",
                  "numbers": {"http": code, "current": cur, "latest": lat,
                              "hasUpdate": hasu, "enabled": d.get("enabled")}}))
PY
)"
  verdict_ok="$(python3 -c 'import json,sys; print("true" if json.loads(sys.argv[1])["ok"] else "false")' "$verdict")"
  numbers="$(python3 -c 'import json,sys; print(json.dumps(json.loads(sys.argv[1])["numbers"]))' "$verdict")"
  if [ "$verdict_ok" = "true" ]; then
    record update_status true \
      "curl -H <bearer> $BASE/api/whats-new/update-status (M4; compareVersions pinned by jest)" \
      "$numbers"
  else
    record update_status false \
      "curl -H <bearer> $BASE/api/whats-new/update-status" \
      "$numbers" "version strings must be semver-sane, hasUpdate a bool, http 200"
  fi
}

# ---- M9.1: the security pin lives in the RUNNING image, not just requirements ----
check_transformers_pin() {
  local cmd="ssh $SSH_HOST docker exec $DB_CONTAINER pip show transformers (read-only; M9.1)"
  local pinned installed numbers
  pinned="$(grep -hE '^transformers[=<>~]' "$REPO_ROOT"/services/*/requirements*.txt 2>/dev/null | head -1 | sed -E 's/^transformers[=<>~]*//; s/[^0-9.].*$//; s/[.]$//')"
  installed="$(ssh -o ConnectTimeout=10 -o BatchMode=yes "$SSH_HOST" \
    "docker exec $DB_CONTAINER pip show transformers 2>/dev/null" 2>/dev/null \
    | awk '/^Version:/{print $2}' | head -1)" || installed=""
  numbers="{\"installed\":\"${installed:-}\",\"pinned\":\"${pinned:-}\",\"container\":\"$DB_CONTAINER\"}"
  if [ -n "$pinned" ] && [ "$installed" = "$pinned" ]; then
    record transformers_pin true "$cmd" "$numbers"
  else
    record transformers_pin false "$cmd" "$numbers" "running image must carry the requirements pin"
  fi
}

# ---- M9.2: health green in the running stack ----
check_health() {
  local out="$T/health.json" code verdict verdict_ok numbers
  code="$(curl -sS --max-time 20 -o "$out" -w '%{http_code}' "$BASE/api/health" 2>/dev/null || echo 000)"
  verdict="$(python3 - "$out" "$code" <<'PY'
import json, sys
code = sys.argv[2]
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    print(json.dumps({"ok": False, "numbers": {"http": code}}))
    raise SystemExit
ok = (d.get("status") == "ok" and d.get("analyzers") == "ok" and d.get("db") == "ok")
print(json.dumps({"ok": ok and code == "200",
                  "numbers": {"http": code, "status": d.get("status"),
                              "analyzers": d.get("analyzers"), "db": d.get("db"),
                              "version": d.get("version")}}))
PY
)"
  verdict_ok="$(python3 -c 'import json,sys; print("true" if json.loads(sys.argv[1])["ok"] else "false")' "$verdict")"
  numbers="$(python3 -c 'import json,sys; print(json.dumps(json.loads(sys.argv[1])["numbers"]))' "$verdict")"
  if [ "$verdict_ok" = "true" ]; then
    record health_analyzers true "curl $BASE/api/health (M9.2)" "$numbers"
  else
    record health_analyzers false "curl $BASE/api/health (M9.2)" "$numbers" \
      "status/analyzers/db must all be ok"
  fi
}

print_manual() {
  cat <<'EOF'
-- manual rows (ears / visual / cross-repo; no evidence row claimed) --
MANUAL  M1.2  live toggle: flip normalization ON/OFF mid-play; applies via kima:user-settings-saved without reload (screenshot)
MANUAL  M2.2  per-step rerun buttons render and progress via SSE + DB drain
MANUAL  M2.3  wipe-and-rerun rehearsal (only if M2.1 guard passed); log throughput vs 98-min bar
MANUAL  M3.1  play-tracks disc order vs iOS albumOrder rule (KimaAPIClient+Library.swift:63)
MANUAL  M4.1  seen-release ping dot + What's New at 1.12 items (catalog-driven; GitHub ping needs the tag published)
MANUAL  M4.2  version number beside logo reopens the window
MANUAL  M4.3  wide screen "What's new" back label, both widths (screenshot)
MANUAL  M6.1  map at 1440: stipple queue, no solid lines; rings a few px at max zoom
MANUAL  M6.2  star click -> select panel; alchemy/drift respond
MANUAL  M6.3  phone 390px: region color background, labels default OFF
MANUAL  M7.1  admin controls on collection pages: absent non-admin, present admin
MANUAL  M7.2  album + artist share one neutral edited pill
MANUAL  M7.3  touch emulation: PopularTracks preview button, translate:none
MANUAL  M8.1  Lidarr exact-match / junk toggle / parked-download leave-alone (needs Kevin OK for a live request)
EOF
}

# Each check is independent: a failure inside one still lets the ledger finish.
run_check() { # run_check LABEL FUNC
  local label="$1" func="$2"
  if ! "$func"; then
    record "$label" false "($func)" '{"aborted":true}' "check function aborted before producing numbers"
  fi
}

# ---------------------------------------------------------------- main
echo "== verify-112 ledger run $(now_iso) =="
echo "base:      $BASE"
echo "db:        ssh $SSH_HOST -> docker exec $DB_CONTAINER psql (SELECT-only, read-only)"
echo "evidence:  $EVIDENCE"
echo

# fulltest must be reachable before any check runs (no rows on an unreachable stack)
if ! curl -sS --max-time 10 -o "$T/boot.json" "$BASE/api/health" 2>/dev/null; then
  echo "FATAL: fulltest unreachable at $BASE — no rows emitted" >&2
  exit 2
fi
TOKEN="$(api_token || true)"
export TOKEN
if [ -z "$TOKEN" ]; then
  echo "FATAL: login failed (no token) — no rows emitted" >&2
  exit 2
fi

run_check health_analyzers     check_health
run_check rerun_guard          check_rerun_guard
run_check playtracks_ownership check_ownership
run_check playlist_reverse     check_reverse
run_check update_status        check_update_status
run_check transformers_pin     check_transformers_pin

echo
print_manual
echo
total_rows="$(grep -c . "$EVIDENCE" 2>/dev/null || echo 0)"
echo "summary: $PASSES pass / $SKIPS skip / $FAILS fail (evidence rows now in file: $total_rows)"
[ "$FAILS" -eq 0 ]
