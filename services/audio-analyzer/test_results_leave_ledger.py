"""A successful analysis writes the Track's features and nothing else: the
server owns the stage record and the failure ledger. Real ``_save_results`` on a
recording cursor."""

import unittest
from typing import Any

import analyzer


class _RecordingCursor:
    """Records every statement the save path executes."""

    def __init__(self):
        self.statements: list[tuple[str, tuple]] = []
        self.rowcount = 1

    def execute(self, sql, params=None):
        self.statements.append((sql, params if params is not None else ()))
        self.rowcount = 1

    def fetchone(self):
        return {"?column?": 1}

    def fetchall(self):
        return []

    def close(self):
        pass


class _RecordingDB:
    def __init__(self):
        self.cursor: _RecordingCursor = _RecordingCursor()
        self.commits = 0
        self.rollbacks = 0

    def get_cursor(self) -> _RecordingCursor:
        return self.cursor

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1


class SuccessLeavesLedgerTest(unittest.TestCase):
    def setUp(self):
        self.worker: Any = analyzer.AnalysisWorker.__new__(analyzer.AnalysisWorker)
        self.db = _RecordingDB()
        self.worker.db = self.db

    def _save_results(self) -> None:
        features: dict[str, Any] = {k: None for k in (
            "bpm", "beatsCount", "key", "keyScale", "keyStrength", "energy",
            "loudness", "dynamicRange", "danceability", "valence", "arousal")}
        features.update(essentiaGenres=[], analysisMode="enhanced")
        self.worker._save_results({"trackId": "t1", "filePath": "/x.flac", "jobId": "t1-1-r0"}, features)

    def test_no_statement_touches_enrichmentfailure(self):
        self._save_results()

        self.assertTrue(self.db.cursor.statements, "save path executed nothing")
        for sql, _ in self.db.cursor.statements:
            self.assertNotIn(
                "EnrichmentFailure",
                sql,
                f"the success path writes to the failure ledger: {sql[:120]}",
            )

    def test_writes_the_features_and_leaves_the_stage_record_to_the_server(self):
        self._save_results()

        sqls = [sql for sql, _ in self.db.cursor.statements]
        self.assertTrue(any('UPDATE "Track"' in sql for sql in sqls))
        writes = ('UPDATE "TrackStage"', 'INSERT INTO "TrackStage"', 'DELETE FROM "TrackStage"')
        self.assertFalse(
            any(w in sql for sql in sqls for w in writes),
            "the server settles the stage record from the completion event; the analyzer only reads it",
        )
        self.assertEqual(self.db.commits, 1)


if __name__ == "__main__":
    unittest.main()
