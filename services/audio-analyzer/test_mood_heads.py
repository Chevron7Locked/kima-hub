"""Each Essentia mood head is read from its positive-class column: column 0 for
happy, aggressive, acoustic, electronic and danceability, column 1 for sad,
relaxed and party (from each head's model metadata)."""

import re
import json
import types
import unittest
from unittest import mock
from typing import Any

import numpy as np


import analyzer


# Positive-class column per head, straight from each head's metadata "classes".
EXPECTED_POSITIVE_COLUMN = {
    'mood_happy': 0,        # ['happy', 'non_happy']
    'mood_sad': 1,          # ['non_sad', 'sad']
    'mood_relaxed': 1,      # ['non_relaxed', 'relaxed']
    'mood_aggressive': 0,   # ['aggressive', 'not_aggressive']
    'mood_party': 1,        # ['non_party', 'party']
    'mood_acoustic': 0,     # ['acoustic', 'non_acoustic']
    'mood_electronic': 0,   # ['electronic', 'non_electronic']
    'danceability': 0,      # ['danceable', 'not_danceable']
}


class _Head:
    """Fake TensorflowPredict2D: every frame returns the same softmax row."""

    def __init__(self, row, fail=False):
        self.row = row
        self.fail = fail

    def __call__(self, embeddings):
        if self.fail:
            raise RuntimeError("boom")
        return np.tile(np.array(self.row, dtype=np.float32), (len(embeddings), 1))


def _analyzer_with(heads):
    a = analyzer.AudioAnalyzer.__new__(analyzer.AudioAnalyzer)
    a.musicnn_model = lambda audio: np.zeros((4, 200), dtype=np.float32)
    a.prediction_models = heads
    return a


class PositiveColumnTest(unittest.TestCase):
    def test_every_loaded_head_has_a_metadata_column(self):
        self.assertEqual(set(analyzer.HEAD_CLASSES), set(EXPECTED_POSITIVE_COLUMN))

    def test_positive_column_matches_metadata(self):
        for head, col in EXPECTED_POSITIVE_COLUMN.items():
            self.assertEqual(analyzer.positive_class_index(head), col, head)


class ExtractMoodsTest(unittest.TestCase):
    def _heads(self, **overrides):
        # Column 0 always holds 0.9, column 1 holds 0.1. A correct reader
        # therefore stores 0.9 for column-0-positive heads and 0.1 for the rest.
        heads = {h: _Head([0.9, 0.1]) for h in EXPECTED_POSITIVE_COLUMN}
        heads.update(deam=_Head([5.0, 5.0]), emomusic=_Head([5.0, 5.0]))
        heads.update(overrides)
        return heads

    def test_each_head_reads_its_positive_column(self):
        out = _analyzer_with(self._heads())._extract_ml_features(np.zeros(16000))
        self.assertEqual(out['moodHappy'], 0.9)
        self.assertEqual(out['moodAggressive'], 0.9)
        self.assertEqual(out['moodAcoustic'], 0.9)
        self.assertEqual(out['moodElectronic'], 0.9)
        self.assertEqual(out['danceabilityMl'], 0.9)
        self.assertEqual(out['danceability'], 0.9)
        self.assertEqual(out['moodSad'], 0.1)
        self.assertEqual(out['moodRelaxed'], 0.1)
        self.assertEqual(out['moodParty'], 0.1)

    def test_heads_are_independent_not_paired(self):
        # Bittersweet: confidently happy AND sad. Each head keeps its own value; the pair
        # need not sum to 1.
        heads = self._heads(mood_happy=_Head([0.8, 0.2]), mood_sad=_Head([0.3, 0.7]),
                            mood_relaxed=_Head([0.01, 0.99]),
                            mood_aggressive=_Head([0.01, 0.99]))
        out = _analyzer_with(heads)._extract_ml_features(np.zeros(16000))
        self.assertEqual(out['moodHappy'], 0.8)
        self.assertEqual(out['moodSad'], 0.7)
        # A calm track: relaxed 0.99, aggressive 0.01, not 0.5/0.5 for saturated heads.
        self.assertEqual(out['moodRelaxed'], 0.99)
        self.assertEqual(out['moodAggressive'], 0.01)

    def test_a_failed_head_fails_the_track_rather_than_storing_a_gap(self):
        for head in ('mood_party', 'deam', 'danceability'):
            heads = self._heads(**{head: _Head(None, fail=True)})
            with self.assertRaises(RuntimeError, msg=head):
                _analyzer_with(heads)._extract_ml_features(np.zeros(16000))

    def test_valence_and_arousal_are_the_mean_of_both_regressions(self):
        heads = self._heads(deam=_Head([6.0, 4.0]), emomusic=_Head([4.0, 6.0]))
        out = _analyzer_with(heads)._extract_ml_features(np.zeros(16000))
        self.assertEqual((out['valence'], out['arousal']),
                         (analyzer.map_va('valence', 5.0), analyzer.map_va('arousal', 5.0)))

    def test_the_mapping_keeps_the_heads_range_off_the_edges(self):
        # The heads answer within about 3-8 on their 1-9 scale; none of that is pinned at 0 or 1, where
        # the x2.5 stretch clipped at 1-9 pinned everything outside 3.4-6.6.
        for axis in ('valence', 'arousal'):
            lo, hi = analyzer.map_va(axis, 3.0), analyzer.map_va(axis, 8.0)
            self.assertTrue(0.0 < lo < hi < 1.0, (axis, lo, hi))

    @mock.patch.object(analyzer, 'ESSENTIA_AVAILABLE', True)
    def test_without_the_models_a_track_fails_with_the_reason(self):
        a = _analyzer_with(self._heads())
        a.enhanced_mode = False
        a.models_error = 'MusiCNN models failed to load: out of memory'
        a.load_audio = lambda path, max_duration=None: self.fail('nothing is decoded without the models')
        out = a.analyze('/music/x.flac')
        self.assertEqual(out['_error'], 'MusiCNN models failed to load: out of memory')

    @mock.patch.object(analyzer, 'ESSENTIA_AVAILABLE', True)
    def test_a_failed_musicnn_fails_the_track_instead_of_estimating(self):
        a = _analyzer_with(self._heads())
        a.enhanced_mode = True
        a.load_audio = lambda path, max_duration=None: np.full((2, 10 * 44100), 0.1, dtype=np.float32)
        a.rhythm_extractor = lambda audio: (120.0, [0.5, 1.0], 3.0, None, [0.5])
        a.key_extractor = lambda audio: ('A', 'minor', 0.8)
        a.rms = lambda frame: 0.1
        a.loudness_ebu = lambda pair: (None, None, -14.0, 6.0)
        a.resampler = lambda audio: audio
        a._extract_ml_features = lambda audio: (_ for _ in ()).throw(RuntimeError('MusiCNN server: CUDA out of memory'))
        out = a.analyze('/music/x.flac')
        self.assertIn('ML analysis failed', out.get('_error', ''))


class NoMoodTagsTest(unittest.TestCase):
    """Mood tags come from the backend's mood step, relative to the library; the analyzer makes none."""

    @mock.patch.object(analyzer, 'ESSENTIA_AVAILABLE', True)
    def test_an_analysis_carries_no_mood_tags(self):
        a = _analyzer_with({})
        a.enhanced_mode = True
        a.load_audio = lambda path, max_duration=None: np.full((2, 10 * 44100), 0.1, dtype=np.float32)
        a.rhythm_extractor = lambda audio: (150.0, [0.5, 1.0], 3.0, None, [0.5])
        a.key_extractor = lambda audio: ('A', 'minor', 0.8)
        a.rms = lambda frame: 0.1
        a.loudness_ebu = lambda pair: (None, None, -14.0, 6.0)
        a.resampler = lambda audio: audio
        # Values past every cut-off the analyzer used to tag with.
        a._extract_ml_features = lambda audio: dict(
            moodHappy=0.9, moodSad=0.9, moodRelaxed=0.9, moodAggressive=0.9,
            valence=0.9, arousal=0.9, danceability=0.9)
        out = a.analyze('/music/x.flac')
        self.assertNotIn('_error', out)
        self.assertEqual((out['bpm'], out['analysisMode']), (150.0, 'enhanced'))
        self.assertNotIn('moodTags', out)


class _Cursor:
    def __init__(self):
        self.statements = []
        self.rowcount = 1

    def execute(self, sql, params=None):
        self.statements.append((sql, params))

    def fetchall(self):
        return []

    def fetchone(self):
        return {"count": 0}

    def close(self):
        pass


class _DB:
    def __init__(self):
        self.cursor = _Cursor()
        self.commits = 0
        self.rollbacks = 0

    def get_cursor(self):
        return self.cursor

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1


def _worker() -> Any:
    w: Any = analyzer.AnalysisWorker.__new__(analyzer.AnalysisWorker)
    w.db = _DB()
    w.redis = types.SimpleNamespace(publish=lambda *a: None)
    return w


def _features() -> dict:
    features: dict[str, Any] = {k: None for k in (
        'bpm', 'beatsCount', 'key', 'keyScale', 'keyStrength', 'energy',
        'loudness', 'dynamicRange', 'danceability', 'valence', 'arousal')}
    features.update(essentiaGenres=[], analysisMode='enhanced')
    return features


class ResultWriteTest(unittest.TestCase):
    def test_the_jobs_claim_is_held_before_the_write(self):
        w = _worker()
        self.assertTrue(w._save_results({"trackId": "t1", "filePath": "/x.flac", "jobId": "t1-3-r1"}, _features()))
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
        self.assertFalse(w._save_results({"trackId": "t1", "filePath": "/x.flac", "jobId": "t1-3-r1"}, _features()))
        self.assertEqual(len(w.db.cursor.statements), 1)
        self.assertEqual((w.db.commits, w.db.rollbacks), (0, 1))
        self.assertEqual(published, [])

    def test_a_job_naming_no_claim_is_not_written(self):
        w = _worker()
        self.assertFalse(w._save_results({"trackId": "t1", "filePath": "/x.flac", "jobId": "t1"}, _features()))
        self.assertEqual(w.db.cursor.statements, [])

    def test_a_failed_write_is_reported_as_the_tracks_failure(self):
        w = _worker()
        published = []
        w.redis = types.SimpleNamespace(publish=lambda channel, body: published.append(json.loads(body)))
        w.db.cursor.execute = lambda *a: (_ for _ in ()).throw(RuntimeError("server closed the connection"))
        saved = w._save_results({"trackId": "t1", "filePath": "/x.flac", "jobId": "t1-1-r0"}, _features())
        self.assertFalse(saved)
        self.assertEqual(w.db.rollbacks, 1)
        self.assertEqual([(p['status'], p['jobId']) for p in published], [('failed', 't1-1-r0')])
        self.assertIn('server closed the connection', published[0]['error'])

    def test_save_results_does_not_touch_clap_columns(self):
        w = _worker()
        w._save_results({"trackId": "t1", "filePath": "/x.flac", "jobId": "t1-1-r0"}, _features())
        update_sql, update_params = w.db.cursor.statements[1]
        self.assertNotIn('acousticness', update_sql)
        self.assertNotIn('instrumentalness', update_sql)
        # The shared valence/arousal pair is derived by the server from both analyzers' raws.
        self.assertIsNone(re.search(r'\b(valence|arousal)\s*=', update_sql))
        self.assertEqual(update_sql.count('%s'), len(update_params))

    def test_save_results_leaves_mood_tags_to_the_mood_step(self):
        w = _worker()
        w._save_results({"trackId": "t1", "filePath": "/x.flac", "jobId": "t1-1-r0"}, _features())
        update_sql, _ = w.db.cursor.statements[1]
        self.assertNotIn('moodTags', update_sql)


if __name__ == '__main__':
    unittest.main()
