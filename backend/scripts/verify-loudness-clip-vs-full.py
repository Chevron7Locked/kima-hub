#!/usr/bin/env python3
"""Does the shipped last-90s R128 loudness reading match a full-file reading?

The shipped analyzer (services/audio-analyzer/analyzer.py) decodes only the
last MAX_ANALYZE_SECONDS = 90 s of each song (the whole song when shorter) and
stores Essentia LoudnessEBUR128 integrated loudness of that decode in
Track.loudness. CHANGELOG claimed "measured ... for its full track". This
script measures the honest number: for a decile-stratified sample of library
tracks it runs a full-file ffmpeg ebur128 pass and compares it with the stored
(clip) reading.

Input:  DATABASE_URL (plain psql) or --psql-cmd (e.g.
        "docker exec kima-fulltest psql -U kima -d kima"), MUSIC_ROOT, --n
        (default 500, stratified by stored loudness).
Output: JSON {n, median_abs_lu, p95_abs_lu, max_abs_lu,
        worst: {track_id, title, clip_lufs, full_lufs, delta_lu}, rows: [...]}
Pass bar (set before running): p95_abs_lu <= 1.0 (1 dB ~ just-noticeable
difference). Exit 0 iff the bar is met with a real sample.

Read-only by construction: every DB statement runs inside BEGIN READ ONLY;
audio files are only ever opened for reading.
"""

import argparse
import csv
import io
import json
import math
import os
import shlex
import statistics
import subprocess
import sys
import time
from datetime import datetime, timezone
from multiprocessing import Pool

TRACK_SQL = (
    'SELECT t.id, t.title, t."filePath", t.loudness FROM "Track" t '
    "WHERE t.loudness IS NOT NULL AND t.corrupt = false "
    'AND t."missingSince" IS NULL ORDER BY t.loudness ASC'
)

COUNT_SQL = (
    'SELECT count(*) FROM "Track" t '
    "WHERE t.loudness IS NOT NULL AND t.corrupt = false "
    'AND t."missingSince" IS NULL'
)

# Physical bounds for a stored integrated reading: below the -70 LUFS gate
# floor nothing measurable is playing; real program audio cannot integrate
# above ~0 LUFS, 10 leaves generous headroom for clipped/short clips.
JUNK_RANGE = (-70.0, 10.0)
JUNK_SQL = (
    'SELECT count(*) FROM "Track" t '
    "WHERE t.loudness IS NOT NULL AND (t.loudness < %(lo)s OR t.loudness > %(hi)s)"
)


def psql_base_args(args):
    argv = shlex.split(args.psql_cmd)
    if args.database_url:
        argv += ["--dbname", args.database_url]
    return argv


def psql_query(args, sql):
    """Run one SELECT inside an enforced read-only transaction; return CSV rows."""
    cmd = psql_base_args(args) + [
        "--csv", "-X", "-q", "-v", "ON_ERROR_STOP=1",
        "-c", "BEGIN TRANSACTION READ ONLY; " + sql + "; COMMIT;",
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if proc.returncode != 0:
        raise RuntimeError(
            "psql failed ({}): {}".format(proc.returncode, proc.stderr.strip()[:500])
        )
    rows = list(csv.reader(io.StringIO(proc.stdout)))
    return rows[1:]  # drop header


def resolve_path(file_path, music_root, mount_dest):
    """Map the container's music path onto the host filesystem (read-only use)."""
    candidates = [file_path]
    if music_root:
        candidates.append(os.path.join(music_root, file_path.lstrip("/")))
        if mount_dest and file_path.startswith(mount_dest + "/"):
            candidates.append(os.path.join(music_root, file_path[len(mount_dest):].lstrip("/")))
    for cand in candidates:
        if os.path.isfile(cand):
            return cand
    return None


def parse_summary_i(stderr_text):
    """Return the Integrated loudness (LUFS) from the ebur128 Summary block."""
    tail = stderr_text.rsplit("Summary:", 1)[-1]
    for line in tail.splitlines():
        stripped = line.strip()
        if stripped.startswith("I:"):
            value = stripped.split("I:", 1)[1].replace("LUFS", "").strip()
            try:
                value = float(value)
            except ValueError:
                return None
            return value if math.isfinite(value) else None  # e.g. "-inf" on pure silence
    return None


def measure(row):
    """Full-file ebur128 for one track. Row: (id, title, filePath, loudness)."""
    track_id, title, file_path, clip_lufs = row
    out = {
        "track_id": track_id,
        "title": title,
        "clip_lufs": clip_lufs,
        "full_lufs": None,
        "delta_lu": None,
        "abs_delta_lu": None,
        "file_path": file_path,
        "error": None,
    }
    path = resolve_path(file_path, ARGS.music_root, ARGS.mount_dest)
    if path is None:
        out["error"] = "file-not-found"
        return out
    cmd = ["ffmpeg", "-nostats", "-i", path, "-af", "ebur128=peak=true",
           "-f", "null", "-"]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    except subprocess.TimeoutExpired:
        out["error"] = "ffmpeg-timeout"
        return out
    stderr_text = proc.stderr or ""
    if proc.returncode != 0:
        lines = [ln for ln in stderr_text.strip().splitlines() if ln.strip()]
        out["error"] = (lines[-1] if lines else
                        "ffmpeg exit {}".format(proc.returncode))[:200]
        return out
    full_lufs = parse_summary_i(stderr_text)
    if full_lufs is None:
        out["error"] = "no-summary-i-parsed"
        return out
    delta_lu = round(clip_lufs - full_lufs, 2)  # +: clip reading louder than full-file
    out["full_lufs"] = round(full_lufs, 2)
    out["delta_lu"] = delta_lu
    out["abs_delta_lu"] = round(abs(delta_lu), 2)
    return out


def stratified_sample(rows, n):
    """Decile-stratified by stored loudness (rows already sorted by loudness)."""
    total = len(rows)
    if n >= total:
        return list(rows)
    picked, seen = [], set()
    for decile in range(10):
        lo, hi = decile * total // 10, (decile + 1) * total // 10
        m = hi - lo
        k = min(m, n // 10 + (1 if decile < n % 10 else 0))
        for j in range(k):
            idx = lo + (j * (m - 1) // (k - 1)) if k > 1 else lo
            if idx not in seen:
                seen.add(idx)
                picked.append(rows[idx])
    picked.sort(key=lambda r: r[3])  # keep loudness order
    return picked


def pct_nearest_rank(sorted_values, p):
    return sorted_values[max(0, math.ceil(p * len(sorted_values)) - 1)]


def main():
    global ARGS
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--database-url", default=os.getenv("DATABASE_URL"),
                        help="libpq connection string (default $DATABASE_URL)")
    parser.add_argument("--psql-cmd", default="psql",
                        help='psql command prefix, e.g. "docker exec kima-fulltest psql -U kima -d kima"')
    parser.add_argument("--music-root", default=os.getenv("MUSIC_ROOT", ""),
                        help="host path the music library is mounted at")
    parser.add_argument("--mount-dest", default="/music",
                        help="music mount destination inside the container (filePath prefix)")
    parser.add_argument("--n", type=int, default=500, help="sample size (decile-stratified)")
    parser.add_argument("--parallel", type=int, default=8, help="concurrent ffmpeg runs")
    parser.add_argument("--output", default="loudness-clip-vs-full.json")
    parser.add_argument("--pass-bar-lu", type=float, default=1.0,
                        help="p95 |delta| pass bar in LU (set before running)")
    ARGS = parser.parse_args()

    t0 = time.time()
    library_total = int(psql_query(ARGS, COUNT_SQL)[0][0])
    junk = int(psql_query(ARGS, JUNK_SQL % {"lo": JUNK_RANGE[0],
                                            "hi": JUNK_RANGE[1]})[0][0])
    rows = [(r[0], r[1], r[2], float(r[3])) for r in psql_query(ARGS, TRACK_SQL)]
    if not rows:
        print("no tracks with stored loudness found", file=sys.stderr)
        return 2
    sample = stratified_sample(rows, ARGS.n)
    print("library tracks with loudness: {} (outside range {}: {}); "
          "sampling {} stratified by stored loudness, -{} workers".format(
              library_total, JUNK_RANGE, junk, len(sample), ARGS.parallel),
          flush=True)

    results, done = [], 0
    with Pool(processes=ARGS.parallel) as pool:
        for res in pool.imap_unordered(measure, sample, chunksize=1):
            results.append(res)
            done += 1
            if done % 25 == 0 or done == len(sample):
                print("measured {}/{} ({:.0f}s)".format(done, len(sample),
                                                        time.time() - t0),
                      flush=True)

    failed = [r for r in results if r["error"]]
    ok = [r for r in results if r["error"] is None]
    abs_deltas = sorted(r["abs_delta_lu"] for r in ok)
    if not abs_deltas:
        print("no successful measurements", file=sys.stderr)
        return 2
    median_abs = round(statistics.median(abs_deltas), 2)
    p95_abs = round(pct_nearest_rank(abs_deltas, 0.95), 2)
    max_abs = round(abs_deltas[-1], 2)
    worst = max(ok, key=lambda r: r["abs_delta_lu"])
    passed = p95_abs <= ARGS.pass_bar_lu

    ok_sorted = sorted(ok, key=lambda r: r["abs_delta_lu"])
    artifact = {
        "generated_at_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "what": "Shipped Track.loudness (Essentia LoudnessEBUR128 over the analyzer's "
                "last-90s decode; whole song when shorter) vs a full-file ffmpeg "
                "ebur128 integrated reading of the same file.",
        "full_file_cmd": "ffmpeg -nostats -i FILE -af ebur128=peak=true -f null -",
        "delta_definition": "delta_lu = clip_lufs - full_lufs "
                            "(positive: clip reading louder)",
        "clip_source": "Track.loudness column (shipped analyzer reading)",
        "sampling": "decile-stratified by stored loudness over {} tracks "
                    "with loudness".format(library_total),
        "pass_bar": "p95_abs_lu <= {} (1 LU ~ just-noticeable difference)".format(
            ARGS.pass_bar_lu),
        "p95_method": "nearest-rank: sorted_abs[ceil(0.95*n)-1]",
        "library_total_with_loudness": library_total,
        "valid_range_lufs": list(JUNK_RANGE),
        "n_outside_range": junk,
        "n_requested": ARGS.n,
        "n": len(ok),
        "n_failed": len(failed),
        "median_abs_lu": median_abs,
        "p95_abs_lu": p95_abs,
        "max_abs_lu": max_abs,
        "pass": passed,
        "worst": {k: worst[k] for k in
                  ("track_id", "title", "clip_lufs", "full_lufs", "delta_lu")},
        "rows": ok_sorted,
        "failed_rows": failed,
        "elapsed_s": round(time.time() - t0, 1),
    }
    with open(ARGS.output, "w") as fh:
        json.dump(artifact, fh, indent=2)
        fh.write("\n")

    print("\nn={} failed={} median|delta|={} LU p95|delta|={} LU max|delta|={} LU"
          .format(len(ok), len(failed), median_abs, p95_abs, max_abs))
    print("worst: {} {!r} clip={} full={} delta={} LU".format(
        worst["track_id"], worst["title"], worst["clip_lufs"],
        worst["full_lufs"], worst["delta_lu"]))
    print("PASS BAR p95 <= {} LU: {}".format(
        ARGS.pass_bar_lu, "PASS" if passed else "FAIL"))
    print("wrote {} ({:.0f}s total)".format(ARGS.output, time.time() - t0))
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
