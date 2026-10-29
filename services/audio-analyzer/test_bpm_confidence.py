"""The tempo extractor's confidence is kept next to bpm, stored raw, and written by the save."""

import analyzer
from analyzer_fakes import RecordingDB, saved_features, stubbed_analyzer


def _analyze(monkeypatch, rhythm):
    monkeypatch.setattr(analyzer, "ESSENTIA_AVAILABLE", True)
    a = stubbed_analyzer(rhythm=rhythm, ml=lambda audio: (_ for _ in ()).throw(RuntimeError("stop here")))
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
    worker.db = RecordingDB()
    features = saved_features(bpm=120.0, bpmConfidence=3.27)
    assert worker._save_results({"trackId": "t1", "filePath": "/x.flac", "jobId": "t1-1-r0"}, features)
    sql, params = worker.db.cursor.statements[-1]
    assert sql.index('bpm = %s') < sql.index('"bpmConfidence" = %s') < sql.index('"beatsCount" = %s')
    assert params[:3] == (120.0, 3.27, None)
