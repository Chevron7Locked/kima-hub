"""What MusiCNN adds to an analysis: the danceability head read from its positive-class column (column 0, from the
head's model metadata), valence and arousal as the mean of the two regressions, and a track that fails without the
models or when MusiCNN fails. The analyzer makes no mood tags; the backend's mood step does."""

import unittest
from unittest import mock

import numpy as np

import analyzer
from analyzer_fakes import stubbed_analyzer


# Positive-class column per head, straight from each head's metadata "classes".
EXPECTED_POSITIVE_COLUMN = {
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
        self.assertEqual(out['danceabilityMl'], 0.9)
        self.assertEqual(out['danceability'], 0.9)

    def test_a_failed_head_fails_the_track_rather_than_storing_a_gap(self):
        for head in ('emomusic', 'deam', 'danceability'):
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
        a.load_audio = lambda path: self.fail('nothing is decoded without the models')
        out = a.analyze('/music/x.flac')
        self.assertEqual(out['_error'], 'MusiCNN models failed to load: out of memory')

    @mock.patch.object(analyzer, 'ESSENTIA_AVAILABLE', True)
    def test_a_failed_musicnn_fails_the_track_instead_of_estimating(self):
        a = stubbed_analyzer(
            heads=self._heads(),
            ml=lambda audio: (_ for _ in ()).throw(RuntimeError('MusiCNN server: CUDA out of memory')),
        )
        out = a.analyze('/music/x.flac')
        self.assertIn('ML analysis failed', out.get('_error', ''))


class NoMoodTagsTest(unittest.TestCase):
    """Mood tags come from the backend's mood step, relative to the library; the analyzer makes none."""

    @mock.patch.object(analyzer, 'ESSENTIA_AVAILABLE', True)
    def test_an_analysis_carries_no_mood_tags(self):
        # Extreme readings (fast tempo, high valence, arousal and danceability) produce no mood tags.
        a = stubbed_analyzer(
            rhythm=lambda audio: (150.0, [0.5, 1.0], 3.0, None, [0.5]),
            ml=lambda audio: dict(valence=0.9, arousal=0.9, danceability=0.9),
        )
        out = a.analyze('/music/x.flac')
        self.assertNotIn('_error', out)
        self.assertEqual((out['bpm'], out['analysisMode']), (150.0, 'enhanced'))
        self.assertNotIn('moodTags', out)


if __name__ == '__main__':
    unittest.main()
