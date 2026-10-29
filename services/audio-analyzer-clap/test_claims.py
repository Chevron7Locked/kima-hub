"""A sound-vector job does work and writes its vector only while its claim is the stage record's current one: a job
whose claim was re-issued, or moved while it ran, leaves the record alone."""
import numpy as np

import analyzer


class FakeDb:
    """A connection pool whose one cursor answers `row` and records every statement and transaction step."""

    def __init__(self, row=None):
        self.row, self.statements = row, []

    def getconn(self):
        return self

    def putconn(self, conn):
        pass

    def cursor(self):
        return self

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def execute(self, sql, params=None):
        self.statements.append((sql, params))

    def fetchone(self):
        return self.row

    def commit(self):
        self.statements.append(("COMMIT", None))

    def rollback(self):
        self.statements.append(("ROLLBACK", None))


def _service(db):
    service = analyzer.BullMQVibeWorker.__new__(analyzer.BullMQVibeWorker)
    service._db_pool = db
    return service


def test_a_sound_vector_job_whose_claim_was_reissued_does_no_work():
    db = FakeDb(("working", 3, 0))
    service = _service(db)
    assert service._claim_is_current("t", "vibe-t-3-r0") is True
    assert service._claim_is_current("t", "vibe-t-2-r0") is False
    assert service._claim_is_current("t", "manual") is True
    done = FakeDb(("done", 3, 0))
    service._db_pool = done
    assert service._claim_is_current("t", "vibe-t-3-r0") is False
    # Most stage rows have migration ids, not "<track>__<stage>": every lookup is by track and stage.
    queries = [(sql, params) for sql, params in db.statements + done.statements if sql not in ("COMMIT", "ROLLBACK")]
    assert len(queries) == 3, queries
    for sql, params in queries:
        assert '"trackId" = %s AND stage = %s' in sql and params == ("t", "embedding"), (sql, params)


def test_a_vector_is_not_written_once_its_claim_has_moved(monkeypatch):
    monkeypatch.setattr(analyzer, "register_vector", lambda conn: None)
    db = FakeDb(None)
    service = _service(db)
    vec = np.zeros(512, dtype=np.float32)
    vec[0] = 1.0
    assert service._store_result("t", vec, 0.5, 0.5, 0.1, 0.1, "vibe-t-3-r0") == "stale"
    statements = db.statements
    assert statements[0][1] == ("t", "embedding", "working", 3, 0) and "FOR SHARE" in statements[0][0]
    assert not any("track_embeddings" in sql for sql, _ in statements) and statements[-1][0] == "ROLLBACK"
