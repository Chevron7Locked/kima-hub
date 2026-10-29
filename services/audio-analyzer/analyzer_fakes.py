"""Stand-ins the analyzer's tests share: a database that records what the save path runs, and an analyzer whose every
measurement is stubbed so analyze() runs without audio or models."""
from typing import Any, Callable, Optional

import numpy as np

import analyzer


class RecordingCursor:
    """Records every statement; a claim check (FOR SHARE) finds its claim held."""

    def __init__(self):
        self.statements: list[tuple[str, Any]] = []
        self.rowcount = 1

    def execute(self, sql, params=None):
        self.statements.append((sql, params if params is not None else ()))
        self.rowcount = 1

    def fetchone(self):
        return {"held": 1}

    def fetchall(self):
        return []

    def close(self):
        pass


class RecordingDB:
    def __init__(self):
        self.cursor = RecordingCursor()
        self.commits = 0
        self.rollbacks = 0

    def get_cursor(self) -> RecordingCursor:
        return self.cursor

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1


def saved_features(**overrides) -> dict:
    """A finished analysis's features, every measurement empty unless given."""
    features: dict[str, Any] = {k: None for k in (
        "bpm", "beatsCount", "key", "keyScale", "keyStrength", "energy",
        "loudness", "dynamicRange", "danceability", "valence", "arousal")}
    features.update(essentiaGenres=[], analysisMode="enhanced")
    features.update(overrides)
    return features


def _tone() -> np.ndarray:
    t = np.arange(10 * 44100) / 44100
    return (0.5 * np.sin(2 * np.pi * 440 * t)).astype(np.float32)[np.newaxis, :]


def stubbed_analyzer(
    rhythm: Callable = lambda audio: (120.0, [0.5, 1.0], 3.0, None, [0.5]),
    loudness: tuple = (-14.0, 6.0),
    ml: Callable = lambda audio: {"valence": 0.5, "arousal": 0.5},
    audio: Optional[np.ndarray] = None,
    heads: Optional[dict] = None,
) -> Any:
    """An AudioAnalyzer with its models loaded in name only: the decode answers `audio` (10 s of a tone by default),
    the extractors answer fixed readings, and MusiCNN answers `ml`. The caller sets ESSENTIA_AVAILABLE."""
    a = object.__new__(analyzer.AudioAnalyzer)
    a.enhanced_mode = True
    a.prediction_models = heads or {}
    a.musicnn_model = lambda audio: np.zeros((4, 200), dtype=np.float32)
    decoded = _tone() if audio is None else audio
    a.load_audio = lambda path: decoded
    a.rhythm_extractor = rhythm
    a.key_extractor = lambda audio: ("A", "minor", 0.8)
    a.rms = lambda frame: 0.1
    a.loudness_ebu = lambda pair: (None, None, *loudness)
    a.resampler = lambda audio: audio
    a._extract_ml_features = ml
    return a
