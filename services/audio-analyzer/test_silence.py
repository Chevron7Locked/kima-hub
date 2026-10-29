"""Silence and very short audio are stored with no measured values: every
Essentia algorithm still prints a number for them (silence reads 738 BPM)."""
import importlib.util
import os
import sys

import numpy as np

_ANALYZER_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "analyzer.py")
_spec = importlib.util.spec_from_file_location("audio_analyzer_silence", _ANALYZER_PATH)
analyzer = importlib.util.module_from_spec(_spec)
sys.modules["audio_analyzer_silence"] = analyzer
_spec.loader.exec_module(analyzer)

SR = 44100


def _analyze(monkeypatch, audio):
    """The result, and whether the analyzer went on to measure the tempo."""
    monkeypatch.setattr(analyzer, "ESSENTIA_AVAILABLE", True)
    a = object.__new__(analyzer.AudioAnalyzer)
    a.enhanced_mode = True
    a.load_audio = lambda path: audio[np.newaxis, :]
    measured = []

    def rhythm(_):
        measured.append(True)
        raise RuntimeError("stop here")

    a.rhythm_extractor = rhythm
    try:
        result = a.analyze("/music/x.flac")
    except Exception:
        result = None
    return result, bool(measured)


def _tone(seconds, peak):
    t = np.arange(int(seconds * SR)) / SR
    return (peak * np.sin(2 * np.pi * 440 * t)).astype(np.float32)


def test_under_three_seconds_is_not_measured(monkeypatch):
    result, measured = _analyze(monkeypatch, _tone(2.9, 0.5))
    assert result["analysisMode"] == "silent" and not measured
    assert result["bpm"] is None and result["key"] is None and result["energy"] is None


def test_digital_silence_is_not_measured(monkeypatch):
    result, measured = _analyze(monkeypatch, np.zeros(10 * SR, dtype=np.float32))
    assert result["analysisMode"] == "silent" and not measured
    assert result["loudness"] is None and result["valence"] is None


def test_below_minus_80_dbfs_is_not_measured(monkeypatch):
    result, measured = _analyze(monkeypatch, _tone(10, 10 ** (-85 / 20)))
    assert result["analysisMode"] == "silent" and not measured


def test_quiet_music_is_measured(monkeypatch):
    assert _analyze(monkeypatch, _tone(10, 10 ** (-60 / 20)))[1]
    assert _analyze(monkeypatch, _tone(3.1, 0.5))[1]


def test_audio_too_short_for_one_musicnn_patch_is_not_measured(monkeypatch):
    # 3.0 s holds 186 of the 187 frames one patch needs (3.008 s); the models could answer nothing.
    result, measured = _analyze(monkeypatch, _tone(3.0, 0.5))
    assert result["analysisMode"] == "silent" and not measured
