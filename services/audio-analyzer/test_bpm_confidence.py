"""The tempo extractor's confidence is kept next to bpm, stored raw, and written by the save."""

import numpy as np

import analyzer
from analyzer import AudioAnalyzer
from test_results_leave_ledger import _RecordingDB


def _analyze(monkeypatch, rhythm):
    monkeypatch.setattr(analyzer, "ESSENTIA_AVAILABLE", True)
    a = object.__new__(AudioAnalyzer)
    a.enhanced_mode = True
    t = np.arange(10 * 44100) / 44100
    a.load_audio = lambda path, max_duration=None: (0.5 * np.sin(2 * np.pi * 440 * t)).astype(np.float32)[np.newaxis, :]
    a.rhythm_extractor = rhythm
    a.key_extractor = lambda audio: ("A", "minor", 0.8)
    a.rms = lambda frame: 0.1
    a.loudness_ebu = lambda pair: (None, None, -14.0, 6.0)
    a.resampler = lambda audio: audio
    a._extract_ml_features = lambda audio: (_ for _ in ()).throw(RuntimeError("stop here"))
    return a.analyze("/music/x.flac")


def test_the_extractors_third_output_is_kept_raw(monkeypatch):
    out = _analyze(monkeypatch, lambda audio: (120.0, [0.5, 1.0], 3.27, [120.0], [0.5]))
    assert out["bpm"] == 120.0
    assert out["bpmConfidence"] == 3.27


def test_a_failed_extractor_leaves_no_confidence(monkeypatch):
    def fails(audio):
        raise RuntimeError("no tempo")
    out = _analyze(monkeypatch, fails)
    assert out["bpm"] is None
    assert out["bpmConfidence"] is None


def test_the_save_writes_the_confidence_next_to_bpm():
    worker = analyzer.AnalysisWorker.__new__(analyzer.AnalysisWorker)
    worker.db = _RecordingDB()
    features = {k: None for k in (
        "bpm", "beatsCount", "key", "keyScale", "keyStrength", "energy",
        "loudness", "dynamicRange", "danceability", "valence", "arousal")}
    features.update(bpm=120.0, bpmConfidence=3.27, moodTags=[], essentiaGenres=[], analysisMode="enhanced")
    assert worker._save_results({"trackId": "t1", "filePath": "/x.flac", "jobId": "t1-1-r0"}, features)
    sql, params = worker.db.cursor.statements[-1]
    assert sql.index('bpm = %s') < sql.index('"bpmConfidence" = %s') < sql.index('"beatsCount" = %s')
    assert params[:3] == (120.0, 3.27, None)
