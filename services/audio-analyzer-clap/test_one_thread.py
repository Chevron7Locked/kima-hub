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


def test_a_sound_vector_job_whose_claim_was_reissued_does_no_work():
    import analyzer

    class Cursor:
        def __init__(self, row):
            self.row = row
        def __enter__(self):
            return self
        def __exit__(self, *a):
            return False
        def execute(self, sql, params):
            # Most stage rows have migration ids, not "<track>__<stage>": the lookup must be by track and stage.
            assert '"trackId" = %s AND stage = %s' in sql and params == ("t", "embedding"), (sql, params)
        def fetchone(self):
            return self.row

    class Conn:
        def __init__(self, row):
            self.row = row
        def cursor(self):
            return Cursor(self.row)
        def commit(self):
            pass

    class Pool:
        def __init__(self, row):
            self.row = row
        def getconn(self):
            return Conn(self.row)
        def putconn(self, conn):
            pass

    service = analyzer.BullMQVibeWorker.__new__(analyzer.BullMQVibeWorker)
    service._db_pool = Pool(("working", 3, 0))
    assert service._claim_is_current("t", "vibe-t-3-r0") is True
    assert service._claim_is_current("t", "vibe-t-2-r0") is False
    assert service._claim_is_current("t", "manual") is True
    service._db_pool = Pool(("done", 3, 0))
    assert service._claim_is_current("t", "vibe-t-3-r0") is False


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


def test_a_vector_is_not_written_once_its_claim_has_moved(monkeypatch):
    import numpy as np
    import analyzer

    statements = []

    class Cursor:
        def __enter__(self):
            return self
        def __exit__(self, *a):
            return False
        def execute(self, sql, params=None):
            statements.append((sql, params))
        def fetchone(self):
            return None

    class Conn:
        def cursor(self):
            return Cursor()
        def commit(self):
            statements.append(("COMMIT", None))
        def rollback(self):
            statements.append(("ROLLBACK", None))

    class Pool:
        def getconn(self):
            return Conn()
        def putconn(self, conn):
            pass

    monkeypatch.setattr(analyzer, "register_vector", lambda conn: None)
    service = analyzer.BullMQVibeWorker.__new__(analyzer.BullMQVibeWorker)
    service._db_pool = Pool()
    vec = np.zeros(512, dtype=np.float32)
    vec[0] = 1.0
    assert service._store_result("t", vec, 0.5, 0.5, 0.1, 0.1, "vibe-t-3-r0") == "stale"
    assert statements[0][1] == ("t", "embedding", "working", 3, 0) and "FOR SHARE" in statements[0][0]
    assert not any("track_embeddings" in sql for sql, _ in statements) and statements[-1][0] == "ROLLBACK"
