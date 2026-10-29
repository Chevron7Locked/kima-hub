"""On the GPU every sound-model call is made by one thread (ONNX Runtime gives each calling thread
its own GPU workspace), and a failed call fails its caller, not the thread."""
import threading

import pytest

from onnx_backend import OneThread


def test_sixteen_callers_one_calling_thread():
    runner = OneThread("test-gpu")
    callers, answers = set(), []

    def model(x):
        callers.add(threading.get_ident())
        return x * 2

    threads = [threading.Thread(target=lambda i=i: answers.append(runner.call(model, i))) for i in range(16)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(10)
    assert sorted(answers) == [i * 2 for i in range(16)]
    assert len(callers) == 1 and threading.get_ident() not in callers


def test_a_failed_call_raises_in_its_caller_and_the_next_call_works():
    runner = OneThread("test-gpu")

    def boom():
        raise RuntimeError("CUDA out of memory")

    with pytest.raises(RuntimeError, match="out of memory"):
        runner.call(boom)
    assert runner.call(lambda: 7) == 7


def test_a_call_with_no_answer_raises_instead_of_waiting_forever(monkeypatch):
    runner = OneThread("test-gpu")
    monkeypatch.setattr(OneThread, "CALL_TIMEOUT_S", 0.2)
    release = threading.Event()
    with pytest.raises(TimeoutError):
        runner.call(release.wait)
    release.set()


def test_reloading_the_model_reuses_the_one_gpu_thread():
    import onnx_backend
    assert onnx_backend.gpu_thread() is onnx_backend.gpu_thread()


def test_idle_unload_frees_the_onnx_sessions_and_the_next_track_loads_them_again(monkeypatch):
    import analyzer
    import onnx_backend

    loads = []

    class FakeBackend:
        def __init__(self, path):
            self._sess = None

        def load_model(self):
            loads.append(1)
            self._sess = object()

        def embed_clips(self, clips):
            import numpy as np
            return np.ones((len(clips), 512), dtype=np.float32)

    monkeypatch.setattr(onnx_backend, "OnnxCLAPBackend", FakeBackend)
    a = analyzer.CLAPAnalyzer()
    held = a._ensure_onnx_backend()
    assert a._model_loaded, "the idle check sees an ONNX model as loaded"
    a.unload_model()
    assert a.onnx_backend is None and not a._model_loaded
    assert held.embed_clips([0]).shape == (1, 512), "a track already embedding keeps its model"
    assert a._ensure_onnx_backend() is not held and len(loads) == 2
