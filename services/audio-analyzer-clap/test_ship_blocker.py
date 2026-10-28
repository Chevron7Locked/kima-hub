"""
The image can run ONNX: requirements.txt carries onnxruntime, _ensure_onnx_backend loads the model eagerly, and a
window failure fails the track.
"""
import contextlib
import importlib.util
import os
import sys

import numpy as np

SERVICE_DIR = os.path.dirname(os.path.abspath(__file__))

_spec = importlib.util.spec_from_file_location("clap_analyzer_under_test", os.path.join(SERVICE_DIR, "analyzer.py"))
assert _spec and _spec.loader
analyzer = importlib.util.module_from_spec(_spec)
sys.modules["clap_analyzer_under_test"] = analyzer
_spec.loader.exec_module(analyzer)
CLAPAnalyzer = analyzer.CLAPAnalyzer


def test_ensure_onnx_backend_eagerly_loads_model(monkeypatch):
    # Construction and load must happen in _ensure_onnx_backend (which the
    # startup path calls before claiming ONNX works), and the load must not
    # raise when the shipped model and onnxruntime are present.
    a = CLAPAnalyzer()
    a._ensure_onnx_backend()
    assert a.onnx_backend is not None
    assert a.onnx_backend._sess is not None, "model session not loaded eagerly"


def test_ensure_onnx_backend_raises_on_broken_model(monkeypatch, tmp_path):
    # A broken model path must fail LOUDLY at ensure time (startup), not at the
    # first embed call.
    a = CLAPAnalyzer()
    dead = str(tmp_path / "does-not-exist.onnx")
    import onnx_backend
    import pytest

    class BrokenBackend(onnx_backend.OnnxCLAPBackend):
        def __init__(self, *args, **kwargs):
            super().__init__(dead)

    # Patched at the source module: _ensure_onnx_backend imports OnnxCLAPBackend at call time.
    monkeypatch.setattr(onnx_backend, "OnnxCLAPBackend", BrokenBackend)
    with pytest.raises(Exception):
        a._ensure_onnx_backend()


def test_a_failed_window_fails_the_track(monkeypatch):
    # One window that fails to load means no vector: the other windows are never
    # averaged as the whole track.
    a = CLAPAnalyzer()
    loads = {"n": 0}

    class Backend:
        def embed_clips(self, clips):
            raise AssertionError("must not embed a track with a failed window")

    def load(path, start, seconds, duration):
        loads["n"] += 1
        return (None, 0) if loads["n"] == 3 else (np.zeros(480000, dtype=np.float32), 48000)

    a.onnx_backend = Backend()
    monkeypatch.setattr(a, "_load_window", load)
    monkeypatch.setattr(analyzer.os.path, "exists", lambda p: True)
    monkeypatch.setattr(analyzer.librosa, "get_duration", lambda path: 240.0)
    assert a.get_audio_embedding("/music/x.flac") is None
    assert loads["n"] == 3


def _pins(text: str) -> dict:
    import re
    return {m.group(1).lower(): m.group(2) for m in re.finditer(r"^'?([A-Za-z0-9_.-]+)==([^\s'\\]+)", text, re.M)}


def test_the_runtime_stack_is_pinned_exactly_and_the_same_in_every_image():
    with open(os.path.join(SERVICE_DIR, "requirements.txt")) as f:
        pinned = _pins(f.read())
    for name in ("onnxruntime", "transformers", "librosa", "soundfile", "numpy"):
        assert name in pinned, f"{name} is not pinned with == in requirements.txt"
    with open(os.path.join(SERVICE_DIR, "..", "..", "Dockerfile")) as f:
        image = _pins("\n".join(line.strip() for line in f))
    for name in ("onnxruntime", "transformers", "librosa", "soundfile", "numpy", "bullmq", "msgpack"):
        assert image.get(name) == pinned[name], f"the all-in-one image pins {name}=={image.get(name)}"
    with open(os.path.join(SERVICE_DIR, "..", "audio-analyzer", "requirements.txt")) as f:
        analysis = _pins(f.read())
    for name in ("onnxruntime", "numpy"):
        assert analysis.get(name) == pinned[name], f"the analysis service pins {name}=={analysis.get(name)}"
