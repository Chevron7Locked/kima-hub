"""The loudness gate: an implausible measurement is stored as no measurement.
Found in the wild on real files: +2868.2 LUFS and a 47.06 LU range from corrupt
decodes. The gate lets every real reading through — including genuinely quiet
audio — and nulls only what the meter or a decode got wrong; a warning names the
file either way."""

import numpy as np

import analyzer
from analyzer import AudioAnalyzer


def gate(integrated, loudness_range):
    return AudioAnalyzer._plausible_loudness(integrated, loudness_range, "/music/test.flac")


def test_real_readings_pass():
    assert gate(-9.0, 11.2) == (-9.0, 11.2)
    assert gate(-23.0, 20.0) == (-23.0, 20.0)
    # the bounds themselves: a master pushed to the ceiling, a floor of near-silence
    assert gate(0.5, 0.0) == (0.5, 0.0)
    assert gate(-70.0, 5.0) == (-70.0, 5.0)


def test_the_garbage_found_stored_is_nulled():
    # the prod rows the audit named
    assert gate(2868.2, 47.06) == (None, None)
    assert gate(232.2, 43.64) == (None, None)
    assert gate(15.6, 38.6) == (None, None)
    # a meter that failed outright never becomes a stored number
    assert gate(None, 11.2) == (None, None)
    assert gate(-9.0, None) == (None, None)
    # NaN fails every comparison, so the gate closes on it
    assert gate(float("nan"), 11.2) == (None, None)


def test_quiet_real_audio_passes_even_when_the_window_was_wrong():
    # -55.7 LUFS is a valid measurement of near-silent content (a classical outro, the
    # silent tail of a file), so the gate passes it. Where a reading is quiet because the
    # window landed in silence, the window is what moves, never the gate.
    assert gate(-55.7, 11.8) == (-55.7, 11.8)


def test_range_beyond_whole_scale_is_nulled():
    # R128 is defined over the audible scale; a range past 60 LU is the meter lost
    assert gate(-9.0, 61.0) == (None, None)



def _analyze_with_meter(monkeypatch, integrated, loudness_range):
    """The real analyze(), with every measurement stubbed except the loudness gate and the fields it fills."""
    monkeypatch.setattr(analyzer, "ESSENTIA_AVAILABLE", True)
    a = object.__new__(AudioAnalyzer)
    a.enhanced_mode = True
    t = np.arange(10 * 44100) / 44100
    a.load_audio = lambda path, max_duration=None: (0.5 * np.sin(2 * np.pi * 440 * t)).astype(np.float32)[np.newaxis, :]
    a.rhythm_extractor = lambda audio: (120.0, [0.5, 1.0], None, None, None)
    a.key_extractor = lambda audio: ("A", "minor", 0.8)
    a.rms = lambda frame: 0.1
    a.loudness_ebu = lambda pair: (None, None, integrated, loudness_range)
    a.resampler = lambda audio: audio
    a._extract_ml_features = lambda audio: {"valence": 0.5, "arousal": 0.5}
    a._generate_mood_tags = lambda result: []
    return a.analyze("/music/test.flac")


def test_an_implausible_reading_is_stored_as_none_and_the_analysis_stands(monkeypatch):
    result = _analyze_with_meter(monkeypatch, 2868.2, 47.06)
    assert "_error" not in result
    assert (result["loudness"], result["dynamicRange"]) == (None, None)
    assert (result["bpm"], result["analysisMode"]) == (120.0, "enhanced")


def test_a_real_reading_is_stored_rounded(monkeypatch):
    result = _analyze_with_meter(monkeypatch, -9.123, 11.267)
    assert "_error" not in result
    assert (result["loudness"], result["dynamicRange"]) == (-9.12, 11.27)
