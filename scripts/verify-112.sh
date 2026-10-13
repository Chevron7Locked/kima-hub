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
GAIN_MAX_DB=30          # ledger M1.4 bar: no |trackGain| above this may ship
RG_REFERENCE_LUFS=-18   # backend/src/routes/subsonic/mappers.ts:74

[ -r "$CREDS_FILE" ] || { echo "FATAL: creds file not readable: $CREDS_FILE" >&2; exit 2; }
# shellcheck disable=SC1090
source "$CREDS_FILE"
BASE="${KIMA_TEST_BASE:-${KIMA_FULLTEST_BASE:-}}"
[ -n "$BASE" ] || { echo "FATAL: set KIMA_TEST_BASE (e.g. http://<media-server>:3056)" >&2; exit 2; }
: "${KIMA_TEST_USERNAME:?FATAL: KIMA_TEST_USERNAME missing in creds file}"
: "${KIMA_TEST_PASSWORD:?FATAL: KIMA_TEST_PASSWORD missing in creds file}"
export KIMA_TEST_USERNAME KIMA_TEST_PASSWORD BASE

PASSES=0
FAILS=0
SKIPS=0
mkdir -p "$(dirname "$EVIDENCE")"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

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

# parse_surface.py IN_JSON IDS_OUT -> stats line "rows obj gain outliers nids"
# (song list located by $ENVELOPE, e.g. searchResult3.song)
cat > "$T/parse_surface.py" <<'PY'
import json, os, re, sys
path, ids_out = sys.argv[1], sys.argv[2]
with open(path) as f:
    data = json.load(f)
node = data.get("subsonic-response", data) if isinstance(data, dict) else {}
for part in os.environ.get("ENVELOPE", "searchResult3.song").split("."):
    if part:
        node = node.get(part) if isinstance(node, dict) else None
songs = node if isinstance(node, list) else []
maxdb = float(os.environ.get("GAIN_MAX_DB", "30"))
rows = len(songs)
obj = sum(1 for s in songs if isinstance(s.get("replayGain"), dict))
gain = sum(1 for s in songs
           if isinstance(s.get("replayGain"), dict)
           and s["replayGain"].get("trackGain") is not None)
outl = sum(1 for s in songs
           if isinstance(s.get("replayGain"), dict)
           and isinstance(s["replayGain"].get("trackGain"), (int, float))
           and abs(s["replayGain"]["trackGain"]) > maxdb)
ok = re.compile(r"^[A-Za-z0-9_-]+$")
ids = [s["id"] for s in songs if isinstance(s.get("id"), str) and ok.match(s["id"])]
with open(ids_out, "w") as f:
    f.write("\n".join(ids))
print(f"{rows}\t{obj}\t{gain}\t{outl}\t{len(ids)}")
PY

# db_valid_for_ids IDS_FILE -> how many of those rows hold loudness that ships a gain
db_valid_for_ids() {
  local arr n
  n="$(grep -cE '^[A-Za-z0-9_-]+$' "$1" 2>/dev/null || true)"
  if [ "${n:-0}" -eq 0 ]; then echo 0; return 0; fi
  arr="$(ids_to_sql_array "$1")"
  db_q "SELECT count(*) FROM \"Track\" WHERE \"id\" = ANY(ARRAY[$arr]) AND \"loudness\" IS NOT NULL AND \"loudness\" > -60 AND \"loudness\" <= 0"
}

# ---- M1.1 / M5.1 / M5.2: replayGain on every song row of a surface ----
gain_surface() { # gain_surface CHECK ENVELOPE CMD URL [curl params...]
  local check="$1" envelope="$2" cmd="$3" url="$4"
  shift 4
  local out="$T/$check.json" ids="$T/$check.ids" stats="$T/$check.stats"
  local code stats_line rows obj gain outl nids dbv cov numbers
  code="$(rest_get "$out" "$url" "$@" 2>/dev/null || echo 000)"
  stats_line="$(ENVELOPE="$envelope" GAIN_MAX_DB="$GAIN_MAX_DB" \
    python3 "$T/parse_surface.py" "$out" "$ids" 2>/dev/null || printf '0\t0\t0\t0\t0')"
  IFS=$'\t' read -r rows obj gain outl nids <<<"$stats_line"
  printf '%s\n' "$stats_line" > "$stats"
  if [ "$code" != "200" ]; then
    record "$check" false "$cmd" "{\"http\":$code,\"rows\":$rows}" "HTTP $code from $url"
    return 0
  fi
  numbers="{\"http\":$code,\"rows\":$rows,\"with_replayGain_object\":$obj,\"with_trackGain\":$gain,\"api_gain_outliers\":$outl}"
  if [ "$rows" -eq 0 ]; then
    record "$check" false "$cmd" "$numbers" "surface returned 0 song rows"
    return 0
  fi
  if ! dbv="$(db_valid_for_ids "$ids")"; then
    record "$check" false "$cmd" "$numbers" "DB census query failed"
    return 0
  fi
  cov="$(python3 -c "print(round($gain * 100.0 / $rows, 1))")"
  numbers="{\"http\":$code,\"rows\":$rows,\"with_replayGain_object\":$obj,\"with_trackGain\":$gain,\"db_valid_loudness_rows\":${dbv:-0},\"coverage_pct\":$cov,\"api_gain_outliers\":$outl}"
  if [ "$obj" -eq "$rows" ] && [ "$gain" -eq "${dbv:-0}" ] && [ "$outl" -eq 0 ]; then
    record "$check" true "$cmd" "$numbers"
  else
    record "$check" false "$cmd" "$numbers" \
      "replayGain object $obj/$rows; trackGain $gain vs db-valid ${dbv:-?}; outliers $outl"
  fi
}

check_search3() {
  gain_surface search3_gain "searchResult3.song" \
    "curl -G $BASE/rest/search3.view?query=&songCount=500&f=json (u,p from test-creds.env; M1.1+M5.1)" \
    "$BASE/rest/search3.view" \
    --data-urlencode "query=" --data-urlencode "songCount=500"
}

check_album() {
  local alb
  alb="$(db_q "SELECT al.\"id\" FROM \"Album\" al JOIN \"Track\" t ON t.\"albumId\"=al.\"id\" WHERE al.\"location\"='LIBRARY' AND t.\"corrupt\"=false AND t.\"missingSince\" IS NULL AND t.\"loudness\" IS NOT NULL GROUP BY al.\"id\" ORDER BY count(*) DESC LIMIT 1" | head -1)"
  if [ -z "$alb" ]; then
    record album_gain false "psql pick album (SELECT-only)" '{"rows":0}' \
      "no LIBRARY album with measured tracks in DB (or DB census query failed)"
    return 0
  fi
  gain_surface album_gain "album.song" \
    "curl -G $BASE/rest/getAlbum.view?id=$alb&f=json (u,p from test-creds.env; M1.1 album door)" \
    "$BASE/rest/getAlbum.view" --data-urlencode "id=$alb"
}

check_random() {
  gain_surface random_gain "randomSongs.song" \
    "curl -G $BASE/rest/getRandomSongs.view?size=100&f=json (u,p from test-creds.env; M5.2 476a0e22 inline builder)" \
    "$BASE/rest/getRandomSongs.view" --data-urlencode "size=100"
}

# ---- M1.4: no outlier |trackGain| > GAIN_MAX_DB ships to any client ----
check_outliers() {
  local cmd="psql (SELECT-only) full-library shipped-gain math + api surface scan (M1.4)"
  local db_stats junk would_ship abs30 api_outl sampled f numbers
  if ! db_stats="$(db_q "WITH playable AS (SELECT t.\"loudness\" AS l FROM \"Track\" t JOIN \"Album\" al ON al.\"id\"=t.\"albumId\" WHERE t.\"corrupt\"=false AND t.\"missingSince\" IS NULL AND t.\"loudness\" IS NOT NULL) SELECT count(*) FILTER (WHERE l > 0 OR l <= -60), count(*) FILTER (WHERE l > -60 AND l <= 0 AND l < $((RG_REFERENCE_LUFS - GAIN_MAX_DB))), count(*) FILTER (WHERE abs(l) > $GAIN_MAX_DB) FROM playable")"; then
    record gain_outliers false "$cmd" '{}' "DB census query failed"
    return 0
  fi
  IFS='|' read -r junk would_ship abs30 <<<"${db_stats:-0|0|0}"
  sampled=0
  for f in "$T"/*.ids; do
    [ -e "$f" ] || continue
    sampled=$((sampled + $(grep -cE '^[A-Za-z0-9_-]+$' "$f" 2>/dev/null || true)))
  done
  api_outl="$(awk -F'\t' 'NF>=4 {s+=$4} END {print s+0}' "$T"/*.stats 2>/dev/null || echo 0)"
  numbers="{\"db_unshippable_junk_rows\":${junk:-0},\"db_would_ship_gt${GAIN_MAX_DB}db\":${would_ship:-0},\"db_abs_loudness_gt${GAIN_MAX_DB}db\":${abs30:-0},\"api_observed_gt${GAIN_MAX_DB}db\":${api_outl:-0},\"api_rows_scanned\":$sampled}"
  if [ "${would_ship:-1}" -eq 0 ] && [ "${api_outl:-1}" -eq 0 ]; then
    record gain_outliers true "$cmd" "$numbers"
  else
    record gain_outliers false "$cmd" "$numbers" "outlier gains would ship / shipped"
  fi
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

# ---- M1.1 on the iOS surface: served rows carry valid loudness ----
check_playtracks_gains() {
  local art="${OWNERSHIP_ARTIST:-}"
  if [ -z "$art" ]; then
    record playtracks_gain false \
      "curl $BASE/api/library/artists/<id>/play-tracks" '{"rows":0}' \
      "no artist resolved by the ownership check"
    return 0
  fi
  local stats rows withloud valid http dbv cov numbers
  stats="$(PT_JSON="$T/pt.json" PT_HTTP="$(cat "$T/pt.http" 2>/dev/null || echo 0)" \
    python3 - <<'PY'
import json, os
try:
    d = json.load(open(os.environ["PT_JSON"]))
except Exception:
    d = {}
tracks = d.get("tracks", [])
loud = [t.get("loudness") for t in tracks]
withloud = sum(1 for v in loud if v is not None)
valid = sum(1 for v in loud if isinstance(v, (int, float)) and -60 < v <= 0)
print(f"{len(tracks)}\t{withloud}\t{valid}\t{os.environ.get('PT_HTTP', '0')}")
PY
)"
  IFS=$'\t' read -r rows withloud valid http <<<"$stats"
  if ! dbv="$(db_q "SELECT count(*) FROM \"Track\" t JOIN \"Album\" al ON al.\"id\"=t.\"albumId\" WHERE al.\"artistId\"='$art' AND al.\"location\"='LIBRARY' AND t.\"corrupt\"=false AND t.\"missingSince\" IS NULL AND t.\"loudness\" IS NOT NULL AND t.\"loudness\" > -60 AND t.\"loudness\" <= 0")"; then
    record playtracks_gain false \
      "curl $BASE/api/library/artists/$art/play-tracks" '{"rows":0}' "DB census query failed"
    return 0
  fi
  cov="$(python3 -c "print(round($valid * 100.0 / max($rows, 1), 1))")"
  numbers="{\"http\":$http,\"rows\":$rows,\"rows_with_loudness\":$withloud,\"rows_valid_loudness\":$valid,\"db_playable_valid_loudness\":${dbv:-0},\"coverage_pct\":$cov}"
  if [ "$valid" -eq "${dbv:-0}" ] && [ "$rows" -eq "${OWNERSHIP_PLAYABLE:-$rows}" ]; then
    record playtracks_gain true \
      "curl $BASE/api/library/artists/$art/play-tracks (loudness is the gain field iOS consumes; M1.1)" \
      "$numbers"
  else
    record playtracks_gain false \
      "curl $BASE/api/library/artists/$art/play-tracks (loudness is the gain field iOS consumes; M1.1)" \
      "$numbers" \
      "served rows must be exactly the playable valid-loudness set (same root cause as playtracks_ownership until Task A deploys)"
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
MANUAL  M1.3  audible mechanism: stream RMS with gain vs -(loudness - target) clamped; final ears = Kevin
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
run_check search3_gain         check_search3
run_check album_gain           check_album
run_check random_gain          check_random
run_check gain_outliers        check_outliers
run_check rerun_guard          check_rerun_guard
run_check playtracks_ownership check_ownership
run_check playtracks_gain      check_playtracks_gains
run_check playlist_reverse     check_reverse
run_check update_status        check_update_status
run_check transformers_pin     check_transformers_pin

echo
print_manual
echo
total_rows="$(grep -c . "$EVIDENCE" 2>/dev/null || echo 0)"
echo "summary: $PASSES pass / $SKIPS skip / $FAILS fail (evidence rows now in file: $total_rows)"
[ "$FAILS" -eq 0 ]
