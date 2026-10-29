"""The save path: a finished analysis writes the Track's features and nothing else (the server owns the stage record
and the failure ledger), only under the job's still-held claim, and a failed write is reported as the track's failure.
Real ``_save_results`` on a recording database."""

import json
import re
import types
import unittest
from typing import Any

import analyzer
from analyzer_fakes import RecordingDB, saved_features


def _worker() -> Any:
    w: Any = analyzer.AnalysisWorker.__new__(analyzer.AnalysisWorker)
    w.db = RecordingDB()
    w.redis = types.SimpleNamespace(publish=lambda *a: None)
    return w


class SuccessLeavesLedgerTest(unittest.TestCase):
    def setUp(self):
        self.worker = _worker()
        self.db = self.worker.db

    def _save_results(self) -> None:
        self.worker._save_results({"trackId": "t1", "filePath": "/x.flac", "jobId": "t1-1-r0"}, saved_features())

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



class ResultWriteTest(unittest.TestCase):
    def test_the_jobs_claim_is_held_before_the_write(self):
        w = _worker()
        self.assertTrue(w._save_results({"trackId": "t1", "filePath": "/x.flac", "jobId": "t1-3-r1"}, saved_features()))
        (claim_sql, claim_params), (update_sql, _) = w.db.cursor.statements
        self.assertIn('FOR SHARE', claim_sql)
        self.assertEqual(claim_params, ('t1', 'analysis', 'working', 3, 1))
        self.assertTrue(update_sql.lstrip().startswith('UPDATE "Track"'))
        self.assertEqual(w.db.commits, 1)

    def test_a_reissued_claim_writes_and_reports_nothing(self):
        w = _worker()
        published = []
        w.redis = types.SimpleNamespace(publish=lambda channel, body: published.append(body))
        w.db.cursor.fetchone = lambda: None
        self.assertFalse(w._save_results({"trackId": "t1", "filePath": "/x.flac", "jobId": "t1-3-r1"}, saved_features()))
        self.assertEqual(len(w.db.cursor.statements), 1)
        self.assertEqual((w.db.commits, w.db.rollbacks), (0, 1))
        self.assertEqual(published, [])

    def test_a_job_naming_no_claim_is_not_written(self):
        w = _worker()
        self.assertFalse(w._save_results({"trackId": "t1", "filePath": "/x.flac", "jobId": "t1"}, saved_features()))
        self.assertEqual(w.db.cursor.statements, [])

    def test_a_failed_write_is_reported_as_the_tracks_failure(self):
        w = _worker()
        published = []
        w.redis = types.SimpleNamespace(publish=lambda channel, body: published.append(json.loads(body)))
        w.db.cursor.execute = lambda *a: (_ for _ in ()).throw(RuntimeError("server closed the connection"))
        saved = w._save_results({"trackId": "t1", "filePath": "/x.flac", "jobId": "t1-1-r0"}, saved_features())
        self.assertFalse(saved)
        self.assertEqual(w.db.rollbacks, 1)
        self.assertEqual([(p['status'], p['jobId']) for p in published], [('failed', 't1-1-r0')])
        self.assertIn('server closed the connection', published[0]['error'])

    def test_save_results_does_not_touch_clap_columns(self):
        w = _worker()
        w._save_results({"trackId": "t1", "filePath": "/x.flac", "jobId": "t1-1-r0"}, saved_features())
        update_sql, update_params = w.db.cursor.statements[1]
        self.assertNotIn('acousticness', update_sql)
        self.assertNotIn('instrumentalness', update_sql)
        # The shared valence/arousal pair is derived by the server from both analyzers' raws.
        self.assertIsNone(re.search(r'\b(valence|arousal)\s*=', update_sql))
        self.assertEqual(update_sql.count('%s'), len(update_params))

    def test_save_results_leaves_moods_to_the_mood_step(self):
        w = _worker()
        w._save_results({"trackId": "t1", "filePath": "/x.flac", "jobId": "t1-1-r0"}, saved_features())
        update_sql, _ = w.db.cursor.statements[1]
        self.assertNotIn('moodTags', update_sql)
        self.assertNotIn('moodHappy', update_sql)



if __name__ == "__main__":
    unittest.main()
