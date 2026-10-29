"""MusiCNN runs in fixed-size groups (every model call one shape, padding never in the result), and
workers reach the main process's one GPU session through MusicnnServer."""
import os

import numpy as np

import musicnn_onnx


class FakeSession:
    """Embedding = each patch's mean, repeated: depends only on its own patch."""

    def __init__(self):
        self.shapes = []

    def run(self, _outputs, feeds):
        x = feeds["model/Placeholder"]
        self.shapes.append(x.shape)
        return [np.repeat(x.mean(axis=(1, 2))[:, None], musicnn_onnx.EMBEDDING_SIZE, axis=1).astype(np.float32)]


def _body(group):
    b = musicnn_onnx.MusicnnBody.__new__(musicnn_onnx.MusicnnBody)
    b.session, b.group, b._input, b.on_gpu = FakeSession(), group, "model/Placeholder", True
    return b


def _patches(n):
    rng = np.random.default_rng(7)
    return rng.standard_normal((n, musicnn_onnx.PATCH_FRAMES, musicnn_onnx.BANDS)).astype(np.float32)


def test_groups_are_one_shape_and_padding_is_dropped():
    patches = _patches(59)
    for group in (1, 4, 16):
        b = _body(group)
        out = b.run(patches)
        assert out.shape == (59, musicnn_onnx.EMBEDDING_SIZE)
        assert set(b.session.shapes) == {(group, musicnn_onnx.PATCH_FRAMES, musicnn_onnx.BANDS)}
        np.testing.assert_allclose(out[:, 0], patches.mean(axis=(1, 2)), rtol=1e-6)


def test_audio_shorter_than_a_patch_has_no_rows():
    b = _body(4)
    assert b.run(np.empty((0, musicnn_onnx.PATCH_FRAMES, musicnn_onnx.BANDS), np.float32)).shape == (0, musicnn_onnx.EMBEDDING_SIZE)
    assert b.session.shapes == []


def test_workers_get_the_servers_answers():
    server = musicnn_onnx.MusicnnServer(_body(4))
    patches = _patches(9)
    a, b = musicnn_onnx.RemoteBody(server.address), musicnn_onnx.RemoteBody(server.address)
    np.testing.assert_allclose(a.run(patches)[:, 0], patches.mean(axis=(1, 2)), rtol=1e-6)
    np.testing.assert_allclose(b.run(patches[:3])[:, 0], patches[:3].mean(axis=(1, 2)), rtol=1e-6)


def test_a_server_failure_fails_the_call_not_the_connection():
    body = _body(4)
    server = musicnn_onnx.MusicnnServer(body)
    remote = musicnn_onnx.RemoteBody(server.address)
    body.session.run = lambda *_: (_ for _ in ()).throw(RuntimeError("CUDA out of memory"))
    try:
        remote.run(_patches(2))
        raise AssertionError("expected the call to fail")
    except RuntimeError as e:
        assert "CUDA out of memory" in str(e)
    body.session = FakeSession()
    assert remote.run(_patches(2)).shape == (2, musicnn_onnx.EMBEDDING_SIZE)


def test_the_socket_refuses_a_wrong_key_and_keeps_serving():
    from multiprocessing.connection import Client, AuthenticationError
    server = musicnn_onnx.MusicnnServer(_body(4))
    try:
        Client(server.address[0], family="AF_UNIX", authkey=b"wrong")
        raise AssertionError("expected the key to be refused")
    except AuthenticationError:
        pass
    patches = _patches(3)
    np.testing.assert_allclose(musicnn_onnx.RemoteBody(server.address).run(patches)[:, 0], patches.mean(axis=(1, 2)), rtol=1e-6)


def test_a_silent_server_times_out_instead_of_hanging():
    body = _body(4)
    server = musicnn_onnx.MusicnnServer(body)
    remote = musicnn_onnx.RemoteBody(server.address)
    remote.REPLY_TIMEOUT_S = 0.5
    import threading
    gate = threading.Event()
    real = body.session.run
    body.session.run = lambda *a: (gate.wait(5), real(*a))[1]
    try:
        remote.run(_patches(1))
        raise AssertionError("expected a timeout")
    except TimeoutError:
        pass
    finally:
        gate.set()


def test_sixteen_workers_connecting_at_once_are_all_served_by_one_gpu_thread():
    import threading
    body = _body(4)
    callers = set()
    real = body.session.run
    def run(*a):
        callers.add(threading.get_ident())
        return real(*a)
    body.session.run = run
    server = musicnn_onnx.MusicnnServer(body)
    answers = []
    def work():
        answers.append(musicnn_onnx.RemoteBody(server.address).run(_patches(9)).shape)
    threads = [threading.Thread(target=work) for _ in range(16)]
    for t in threads: t.start()
    for t in threads: t.join(10)
    assert answers == [(9, musicnn_onnx.EMBEDDING_SIZE)] * 16
    assert len(callers) == 1


def _analyzer_module():
    import importlib.util, os, sys
    spec = importlib.util.spec_from_file_location("audio_analyzer_provider", os.path.join(os.path.dirname(os.path.abspath(__file__)), "analyzer.py"))
    analyzer = importlib.util.module_from_spec(spec)
    sys.modules["audio_analyzer_provider"] = analyzer
    spec.loader.exec_module(analyzer)
    return analyzer


def test_an_analyzer_started_without_the_gpu_says_so(tmp_path, monkeypatch):
    import json
    analyzer = _analyzer_module()
    (tmp_path / "gpu-onnx").mkdir()
    (tmp_path / "gpu-onnx" / "analysis-provider.json").write_text('{"active": true}')
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setattr(analyzer, "GPU_ANALYSIS", False)
    worker = analyzer.AnalysisWorker.__new__(analyzer.AnalysisWorker)
    assert worker._start_musicnn_server() is None
    assert json.loads((tmp_path / "gpu-onnx" / "analysis-provider.json").read_text())["active"] is False


def test_a_failed_gpu_session_runs_the_track_on_the_cpu_and_reconnects_next_time(monkeypatch):
    body = _body(4)
    server = musicnn_onnx.MusicnnServer(body)
    models = musicnn_onnx.MusicnnOnnx.__new__(musicnn_onnx.MusicnnOnnx)
    models.body = musicnn_onnx.RemoteBody(server.address)
    models._model_dir, models._threads, models.on_gpu = "/unused", 1, True
    models._cpu_body = _body(1)
    patches = _patches(5)
    monkeypatch.setattr(musicnn_onnx, "mel_patches", lambda _audio: patches)
    real = body.session.run
    body.session.run = lambda *_: (_ for _ in ()).throw(RuntimeError("CUDA error: an illegal memory access"))
    out = models.embeddings(np.zeros(16000, np.float32))
    np.testing.assert_allclose(out[:, 0], patches.mean(axis=(1, 2)), rtol=1e-6)
    assert models._cpu_body.session.shapes, "the CPU body answered"
    body.session.run = real
    models._cpu_body.session.shapes.clear()
    models.embeddings(np.zeros(16000, np.float32))
    assert not models._cpu_body.session.shapes, "the GPU session answered again"


def test_a_refused_key_runs_the_track_on_the_cpu(monkeypatch):
    server = musicnn_onnx.MusicnnServer(_body(4))
    models = musicnn_onnx.MusicnnOnnx.__new__(musicnn_onnx.MusicnnOnnx)
    models.body = musicnn_onnx.RemoteBody((server.address[0], b"not the server's key"))
    models._model_dir, models._threads, models.on_gpu = "/unused", 1, True
    models._cpu_body = _body(1)
    patches = _patches(3)
    monkeypatch.setattr(musicnn_onnx, "mel_patches", lambda _audio: patches)
    out = models.embeddings(np.zeros(16000, np.float32))
    np.testing.assert_allclose(out[:, 0], patches.mean(axis=(1, 2)), rtol=1e-6)
    assert models._cpu_body.session.shapes, "the CPU body answered"


def test_a_failed_status_write_leaves_no_earlier_answer(tmp_path, monkeypatch):
    analyzer = _analyzer_module()
    status = tmp_path / "gpu-onnx" / "analysis-provider.json"
    status.parent.mkdir()
    status.write_text('{"active": true}')
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setattr(analyzer.os, "replace", lambda *_: (_ for _ in ()).throw(OSError("disk full")))
    analyzer._record_gpu_provider(False)
    assert not status.exists()


def test_a_gpu_session_that_answers_off_essentias_is_not_used(tmp_path, monkeypatch):
    import json
    import os
    analyzer = _analyzer_module()
    (tmp_path / "gpu-onnx").mkdir()
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setattr(analyzer, "GPU_ANALYSIS", True)
    monkeypatch.setattr(analyzer, "ML_MODELS_AVAILABLE", True)
    gpu_body = _body(4)
    monkeypatch.setattr(analyzer, "MusicnnBody", lambda model_dir, use_gpu: gpu_body)
    worker = analyzer.AnalysisWorker.__new__(analyzer.AnalysisWorker)
    provider = tmp_path / "gpu-onnx" / "analysis-provider.json"
    checked = []

    def answers(cosine):
        def check(run, path):
            checked.append((run, os.path.basename(path)))
            return cosine
        return check

    monkeypatch.setattr(analyzer, "embedding_cosine", answers(0.9990))
    assert worker._start_musicnn_server() is None
    assert checked == [(gpu_body.run, "musicnn-answers.npz")]
    assert json.loads(provider.read_text())["active"] is False

    monkeypatch.setattr(analyzer, "embedding_cosine", answers(0.9999998))
    assert worker._start_musicnn_server() is not None
    assert json.loads(provider.read_text())["active"] is True


def test_an_idle_analyzer_lets_the_gpu_session_go_and_opens_it_again_with_work(tmp_path, monkeypatch):
    import os
    analyzer = _analyzer_module()
    (tmp_path / "gpu-onnx").mkdir()
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setattr(analyzer, "GPU_ANALYSIS", True)
    monkeypatch.setattr(analyzer, "ML_MODELS_AVAILABLE", True)
    bodies = [_body(4), _body(4)]
    monkeypatch.setattr(analyzer, "MusicnnBody", lambda model_dir, use_gpu: bodies.pop(0))
    monkeypatch.setattr(analyzer, "embedding_cosine", lambda run, path: 0.9999999)

    class Pool:
        def shutdown(self, wait=True):
            pass

    worker = analyzer.AnalysisWorker.__new__(analyzer.AnalysisWorker)
    worker._gpu_server = None
    worker.musicnn_server = worker._start_musicnn_server()
    first = worker.musicnn_server
    worker.executor, worker.pool_active = Pool(), True

    worker._shutdown_pool()
    assert worker.musicnn_server is None and worker._gpu_server is None
    assert not os.path.exists(first[0]), "the idle analyzer still serves a GPU session"

    monkeypatch.setattr(worker, "_new_pool", lambda: Pool())
    worker._ensure_pool()
    assert worker.musicnn_server is not None and worker.musicnn_server != first
    np.testing.assert_allclose(musicnn_onnx.RemoteBody(worker.musicnn_server).run(_patches(3))[:, 0],
                               _patches(3).mean(axis=(1, 2)), rtol=1e-6)


def test_replacing_a_stuck_pool_kills_its_workers(monkeypatch):
    import multiprocessing
    import time as real_time
    from concurrent.futures import ProcessPoolExecutor

    analyzer = _analyzer_module()
    pool = ProcessPoolExecutor(max_workers=1)
    job = pool.submit(real_time.sleep, 60)
    deadline = real_time.time() + 30
    while not job.running() and real_time.time() < deadline:
        real_time.sleep(0.05)
    real_time.sleep(0.5)
    stuck = multiprocessing.active_children()
    assert job.running() and stuck

    worker = analyzer.AnalysisWorker.__new__(analyzer.AnalysisWorker)
    worker.executor, worker.pool_active = pool, True
    worker._drop_pool()
    assert worker.executor is None and not worker.pool_active, "dropping the pool started a new one"

    # Asked of the kernel: the pool's own thread can reap a killed worker first, and then the Process object never
    # learns its exit code and reports it alive for good.
    def gone(pid):
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return True
        return False

    for process in stuck:
        until = real_time.time() + 10
        while not gone(process.pid) and real_time.time() < until:
            real_time.sleep(0.05)
        assert gone(process.pid)
