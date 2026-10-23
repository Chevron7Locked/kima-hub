"""Real-audio, real-Postgres proof that bpmConfidence reaches the Track column.

Runs the real AudioAnalyzer on real audio, then AnalysisWorker._save_results against a real
database row, and reads the row back. Skipped when the model files, audio or database are missing
(and under the unit-test conftest, which replaces psycopg2 with a stub).

  Env: KIMA_REAL_AUDIO="a.mp3:b.mp3"  KIMA_REAL_DB=postgresql://...   (MODEL_DIR as the analyzer reads it)
  Direct: python3 test_bpm_confidence_real.py     (inside the Kima image, worktree on sys.path)
"""
import json
import os
import sys
import uuid


AUDIO = [p for p in os.environ.get("KIMA_REAL_AUDIO", "").split(":") if p]
DB_URL = os.environ.get("KIMA_REAL_DB", "")


def _real_psycopg2():
    import psycopg2
    return psycopg2 if getattr(psycopg2, "__file__", None) else None


def run():
    import analyzer
    psycopg2 = _real_psycopg2()
    a = analyzer.AudioAnalyzer()
    assert a.enhanced_mode, a.models_error
    conn = psycopg2.connect(DB_URL)
    cur = conn.cursor()
    suffix = uuid.uuid4().hex[:8]
    artist, album = f"bpmconf-artist-{suffix}", f"bpmconf-album-{suffix}"
    cur.execute('INSERT INTO "Artist"(id,name,"identityKey") VALUES (%s,%s,%s)', (artist, artist, artist))
    cur.execute('INSERT INTO "Album"(id,"rgMbid","artistId",title,"primaryType") VALUES (%s,%s,%s,%s,%s)',
                (album, album, artist, album, "Album"))
    conn.commit()
    rows = []
    try:
        for n, path in enumerate(AUDIO):
            feats = a.analyze(path)
            assert not feats.get("_error"), feats.get("_error")
            conf = feats["bpmConfidence"]
            print(f"analyzer {os.path.basename(path)}: bpm={feats['bpm']} bpmConfidence={conf!r}")
            assert isinstance(conf, float) and 0.0 <= conf <= 5.5, conf
            tid = f"bpmconf-track-{suffix}-{n}"
            cur.execute('INSERT INTO "Track"(id,"albumId",title,"trackNo",duration,"filePath","fileModified","fileSize","updatedAt")'
                        " VALUES (%s,%s,%s,1,30,%s,now(),1,now())", (tid, album, tid, f"/nonexistent/{tid}.mp3"))
            cur.execute('INSERT INTO "TrackStage"(id,"trackId",stage,status,attempt,redelivered) VALUES (%s,%s,%s,%s,%s,%s)',
                        (tid, tid, "analysis", "working", 1, 0))
            conn.commit()
            worker = analyzer.AnalysisWorker.__new__(analyzer.AnalysisWorker)
            worker.db = analyzer.DatabaseConnection(DB_URL)
            published = []
            worker.redis = type("R", (), {"publish": lambda s, ch, msg: published.append((ch, msg))})()
            ok = worker._save_results({"trackId": tid, "jobId": f"{tid}-1-r0"}, feats)
            assert ok is True, published
            cur.execute('SELECT bpm, "bpmConfidence", "beatsCount", "analysisMode" FROM "Track" WHERE id=%s', (tid,))
            row = cur.fetchone()
            conn.commit()
            print(f"read-back {tid}: bpm={row[0]} bpmConfidence={row[1]!r} beatsCount={row[2]} analysisMode={row[3]}")
            print("published:", published)
            assert row[0] == feats["bpm"] and row[1] == conf
            rows.append(row)
    finally:
        conn.rollback()
        cur.execute('DELETE FROM "Track" WHERE "albumId"=%s', (album,))
        cur.execute('DELETE FROM "Album" WHERE id=%s', (album,))
        cur.execute('DELETE FROM "Artist" WHERE id=%s', (artist,))
        conn.commit()
        cur.execute('SELECT (SELECT count(*) FROM "Track" WHERE "albumId"=%s),(SELECT count(*) FROM "Album" WHERE id=%s),'
                    '(SELECT count(*) FROM "Artist" WHERE id=%s)', (album, album, artist))
        print("leftover Track/Album/Artist rows after cleanup:", cur.fetchone())
        conn.close()
    return rows


def test_bpm_confidence_reaches_the_track_column():
    import pytest
    if not (AUDIO and DB_URL and all(os.path.exists(p) for p in AUDIO) and _real_psycopg2()):
        pytest.skip("needs KIMA_REAL_AUDIO, KIMA_REAL_DB and the real psycopg2 (not the unit-test stub)")
    if not os.path.isdir(os.environ.get("MODEL_DIR", "/app/models")):
        pytest.skip("model files missing")
    assert len(run()) == len(AUDIO)


if __name__ == "__main__":
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "audio-analyzer-clap"))
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    run()
