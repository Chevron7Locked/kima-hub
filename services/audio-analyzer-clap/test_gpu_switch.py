"""A GPU switch takes effect on its own: each analyzer asks whether its switch, or the runtime's install,
changed since it started, and restarts between tracks when it did. Every image ships the rule beside the
wrapper and the analyzers."""
import json
import os
import re
import sys

SERVICE_DIR = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(SERVICE_DIR))
sys.path.insert(0, SERVICE_DIR)

import gpu_runtime  # noqa: E402
import gpu_switch  # noqa: E402


def _settled(monkeypatch):
    monkeypatch.setattr(gpu_switch, "_started", __import__("time").monotonic() - gpu_switch.SETTLE_SECONDS)


def _data(tmp_path, monkeypatch, *, switches, installed):
    root = tmp_path / "gpu-onnx"
    (root / "site" / "nvidia" / "cublas" / "lib").mkdir(parents=True, exist_ok=True)
    runtime = root / "site" / "onnxruntime"
    if installed:
        runtime.mkdir(exist_ok=True)
    elif runtime.exists():
        runtime.rmdir()
    (root / "state.json").write_text(json.dumps({"status": "installed" if installed else "installing"}))
    (root / "enabled.json").write_text(json.dumps({"enabled": any(switches.values()), **switches}))
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    return root


def test_the_runtime_is_wanted_only_when_its_switch_is_on_and_it_is_installed(tmp_path, monkeypatch):
    _data(tmp_path, monkeypatch, switches={"soundVectors": True, "analysis": False}, installed=True)
    site, libs = gpu_switch.runtime_for("soundVectors")
    assert site.endswith("site") and libs[0].endswith(os.path.join("cublas", "lib"))
    assert gpu_switch.runtime_for("analysis") is None
    _data(tmp_path, monkeypatch, switches={"soundVectors": True, "analysis": True}, installed=False)
    assert gpu_switch.runtime_for("soundVectors") is None


def test_nothing_is_wanted_without_the_files(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    assert gpu_switch.runtime_for("soundVectors") is None


def test_a_restart_is_needed_exactly_when_the_wanted_runtime_differs_from_the_one_started_with(tmp_path, monkeypatch):
    _settled(monkeypatch)
    _data(tmp_path, monkeypatch, switches={"soundVectors": True, "analysis": False}, installed=True)
    monkeypatch.delenv("KIMA_GPU_RUNTIME", raising=False)
    assert gpu_switch.restart_needed("soundVectors") is True
    assert gpu_switch.restart_needed("analysis") is False
    monkeypatch.setenv("KIMA_GPU_RUNTIME", "1")
    assert gpu_switch.restart_needed("soundVectors") is False
    assert gpu_switch.restart_needed("analysis") is True


def test_the_sound_vector_analyzer_waits_for_an_install_to_finish(tmp_path, monkeypatch):
    import importlib.util
    spec = importlib.util.spec_from_file_location("clap_analyzer_switch", os.path.join(SERVICE_DIR, "analyzer.py"))
    assert spec and spec.loader
    analyzer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(analyzer)
    _settled(monkeypatch)
    _data(tmp_path, monkeypatch, switches={"soundVectors": True, "analysis": False}, installed=True)
    monkeypatch.delenv("KIMA_GPU_RUNTIME", raising=False)
    monkeypatch.setattr(gpu_runtime, "busy", lambda: True)
    assert analyzer.gpu_switch_changed() is False
    monkeypatch.setattr(gpu_runtime, "busy", lambda: False)
    assert analyzer.gpu_switch_changed() is True


def test_every_image_ships_the_rule_beside_the_wrapper_and_the_analyzers():
    def copies(dockerfile):
        with open(os.path.join(REPO, dockerfile)) as f:
            instructions = re.sub(r"\\\n\s*", " ", f.read())
        return re.findall(r"^COPY .*gpu_switch\.py.*$", instructions, re.M)
    all_in_one = " ".join(copies("Dockerfile"))
    assert "/app/audio-analyzer-clap/" in all_in_one and "/app/audio-analyzer/" in all_in_one
    assert copies("services/audio-analyzer/Dockerfile"), "the analysis image lacks gpu_switch.py"
    assert copies("services/audio-analyzer-clap/Dockerfile"), "the sound-vector image lacks gpu_switch.py"


def test_a_start_forgets_the_last_start_s_gpu_answer(tmp_path, monkeypatch):
    root = _data(tmp_path, monkeypatch, switches={"soundVectors": False, "analysis": True}, installed=True)
    _runtime_at(tmp_path, monkeypatch)
    gpu_runtime.record_provider(True)
    assert json.loads((root / "state.json").read_text())["provider"]["active"] is True
    import importlib.util
    spec = importlib.util.spec_from_file_location("clap_analyzer_start", os.path.join(SERVICE_DIR, "analyzer.py"))
    assert spec and spec.loader
    analyzer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(analyzer)
    monkeypatch.setattr(analyzer, "BullMQVibeWorker", lambda *a, **k: type("W", (), {"start": lambda self: None})())
    monkeypatch.setattr(analyzer, "TextEmbedHandler", lambda *a, **k: type("T", (), {"start": lambda self: None})())
    monkeypatch.setattr(analyzer, "ControlHandler", lambda *a, **k: type("C", (), {"start": lambda self: None})())
    monkeypatch.setattr(analyzer, "load_configured_workers", lambda: 1)
    monkeypatch.setattr(analyzer.time, "sleep", lambda s: (_ for _ in ()).throw(KeyboardInterrupt()))
    analyzer.main()
    assert json.loads((root / "state.json").read_text())["provider"]["active"] is False
    assert json.loads((root / "state.json").read_text())["provider"]["measured"] is False
    monkeypatch.setattr(analyzer, "CLAP_BACKEND", "torch")
    analyzer.main()
    provider = json.loads((root / "state.json").read_text())["provider"]
    assert provider["measured"] is True and provider["active"] is False, "a torch start left the page applying"


def _runtime_at(tmp_path, monkeypatch):
    root = tmp_path / "gpu-onnx"
    root.mkdir(exist_ok=True)
    for name, value in (("ROOT", root), ("SITE", root / "site"), ("STATE_PATH", root / "state.json"),
                        ("ENABLED_PATH", root / "enabled.json")):
        monkeypatch.setattr(gpu_runtime, name, str(value))
    monkeypatch.setattr(gpu_runtime, "_install_thread", None)
    return root


def _want(root, on):
    (root / "enabled.json").write_text(json.dumps({"enabled": on, "soundVectors": on, "analysis": False}))


def _fake_steps(root, monkeypatch, gate=None, install_fails=False):
    import threading
    ran = []

    def install():
        ran.append("install")
        if gate:
            gate.wait(5)
        if install_fails:
            gpu_runtime.update_state(status="failed", reason="no_network", detail="index unreachable")
            return "failed"
        (root / "site" / "onnxruntime").mkdir(parents=True, exist_ok=True)
        gpu_runtime.update_state(status="installed")
        return "installed"

    monkeypatch.setattr(gpu_runtime, "_install", install)
    return ran, threading


def _settle():
    import time
    deadline = time.time() + 5
    while gpu_runtime.busy() and time.time() < deadline:
        time.sleep(0.01)
    assert not gpu_runtime.busy()


def test_switching_off_during_a_download_cancels_the_download_and_deletes_nothing(tmp_path, monkeypatch):
    root = _runtime_at(tmp_path, monkeypatch)
    gate = __import__("threading").Event()
    ran = []

    def install():
        ran.append("install")
        gate.wait(5)
        if gpu_runtime._cancel.is_set():
            gpu_runtime.update_state(status="idle", detail="cancelled after download")
            return "cancelled"
        (root / "site" / "onnxruntime").mkdir(parents=True, exist_ok=True)
        gpu_runtime.update_state(status="installed")
        return "installed"

    monkeypatch.setattr(gpu_runtime, "_install", install)
    _want(root, True)
    assert gpu_runtime.dispatch("install") == "started"
    _want(root, False)
    assert gpu_runtime.dispatch("cancel") == "cancelling"
    gate.set()
    _settle()
    assert ran == ["install"]
    assert gpu_runtime.read_state()["status"] == "idle"
    assert not gpu_runtime.is_installed()


def test_switching_off_and_straight_back_on_during_a_download_lets_the_download_finish(tmp_path, monkeypatch):
    root = _runtime_at(tmp_path, monkeypatch)
    gate = __import__("threading").Event()
    ran = []

    def install():
        ran.append("install")
        gate.wait(5)
        if gpu_runtime._cancel.is_set():
            gpu_runtime.update_state(status="idle", detail="cancelled after download")
            return "cancelled"
        (root / "site" / "onnxruntime").mkdir(parents=True, exist_ok=True)
        gpu_runtime.update_state(status="installed")
        return "installed"

    monkeypatch.setattr(gpu_runtime, "_install", install)
    _want(root, True)
    assert gpu_runtime.dispatch("install") == "started"
    _want(root, False)
    assert gpu_runtime.dispatch("cancel") == "cancelling"
    _want(root, True)
    assert gpu_runtime.dispatch("install") == "busy"
    gate.set()
    _settle()
    assert ran == ["install"]
    assert gpu_runtime.is_installed()


def test_switching_off_with_nothing_downloading_changes_nothing_on_disk(tmp_path, monkeypatch):
    root = _runtime_at(tmp_path, monkeypatch)
    (root / "site" / "onnxruntime").mkdir(parents=True)
    gpu_runtime.update_state(status="installed")
    ran, _ = _fake_steps(root, monkeypatch)
    _want(root, False)
    assert gpu_runtime.dispatch("cancel") == "nothing_to_cancel"
    assert gpu_runtime.dispatch("install") == "skipped_disabled"
    _settle()
    assert ran == [] and gpu_runtime.is_installed()


def test_switching_on_again_after_both_were_off_needs_no_download(tmp_path, monkeypatch):
    root = _runtime_at(tmp_path, monkeypatch)
    (root / "site" / "onnxruntime").mkdir(parents=True)
    gpu_runtime.update_state(status="installed")
    ran, _ = _fake_steps(root, monkeypatch)
    _want(root, False)
    _want(root, True)
    assert gpu_runtime.dispatch("install") == "skipped_installed"
    assert ran == []
    assert gpu_runtime.is_installed()


def test_a_start_never_removes_an_installed_runtime_whatever_the_switches_say(tmp_path, monkeypatch):
    root = _runtime_at(tmp_path, monkeypatch)
    (root / "site" / "onnxruntime").mkdir(parents=True)
    gpu_runtime.update_state(status="installed")
    ran, _ = _fake_steps(root, monkeypatch)
    _want(root, False)
    assert gpu_runtime.reconcile() == "nothing_to_do"
    _settle()
    assert ran == [] and gpu_runtime.is_installed()
    assert gpu_runtime._next_action(retry_failed=True) is None


def test_a_start_retries_an_install_its_predecessor_was_killed_in(tmp_path, monkeypatch):
    root = _runtime_at(tmp_path, monkeypatch)
    gpu_runtime.update_state(status="installing", startedEpoch=__import__("time").time())
    ran, _ = _fake_steps(root, monkeypatch)
    _want(root, True)
    assert gpu_runtime.reconcile() == "install"
    _settle()
    assert ran == ["install"] and gpu_runtime.is_installed()


def test_a_failed_download_is_not_repeated_and_waits_for_a_restart_or_a_click(tmp_path, monkeypatch):
    root = _runtime_at(tmp_path, monkeypatch)
    ran, _ = _fake_steps(root, monkeypatch, install_fails=True)
    _want(root, True)
    assert gpu_runtime.dispatch("install") == "started"
    _settle()
    assert ran == ["install"]
    assert gpu_runtime._next_action(retry_failed=False) is None
    assert gpu_runtime._next_action(retry_failed=True) == "install"


def test_a_restart_finishes_running_jobs_within_their_lock_while_search_keeps_answering(monkeypatch):
    import importlib.util
    import threading
    import time as real_time
    spec = importlib.util.spec_from_file_location("clap_analyzer_drain", os.path.join(SERVICE_DIR, "analyzer.py"))
    assert spec and spec.loader
    analyzer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(analyzer)
    search_stop = []
    seen = []

    class StuckJobs:
        def __init__(self, _analyzer, stop, concurrency):
            self.stop = stop

        def start(self):
            self.stop.wait()
            seen.append(not search_stop[0].is_set())
            threading.Event().wait()

    class Search:
        def __init__(self, _analyzer, stop):
            search_stop.append(stop)

        def start(self):
            search_stop[0].wait()

    class Control:
        def __init__(self, stop, worker=None):
            self.stop = stop

        def start(self):
            self.stop.wait()

    class Clock:
        time = staticmethod(real_time.time)
        sleep = staticmethod(lambda s: real_time.sleep(min(s, 0.01)))

    monkeypatch.setattr(analyzer, "BullMQVibeWorker", StuckJobs)
    monkeypatch.setattr(analyzer, "TextEmbedHandler", Search)
    monkeypatch.setattr(analyzer, "ControlHandler", Control)
    monkeypatch.setattr(analyzer, "load_configured_workers", lambda: 1)
    monkeypatch.setattr(analyzer, "gpu_switch_changed", lambda: True)
    monkeypatch.setattr(analyzer, "JOB_LOCK_MS", 300)
    monkeypatch.setattr(analyzer, "time", Clock)
    monkeypatch.setattr(analyzer.signal, "signal", lambda *a: None)
    started = real_time.time()
    analyzer.main()
    assert real_time.time() - started < 3, "a stuck job held the restart past its lock"
    assert seen == [True], "search stopped before the running jobs were done"


def test_a_new_process_waits_before_acting_on_a_switch_so_its_exit_is_not_a_failed_start(tmp_path, monkeypatch):
    _data(tmp_path, monkeypatch, switches={"soundVectors": True, "analysis": False}, installed=True)
    monkeypatch.delenv("KIMA_GPU_RUNTIME", raising=False)
    monkeypatch.setattr(gpu_switch, "_started", __import__("time").monotonic())
    assert gpu_switch.restart_needed("soundVectors") is False
    _settled(monkeypatch)
    assert gpu_switch.restart_needed("soundVectors") is True


def test_the_wait_covers_every_analyzer_program_s_start_window_in_the_all_in_one_image():
    with open(os.path.join(REPO, "Dockerfile")) as f:
        dockerfile = f.read()
    windows = {name: int(secs) for name, secs in re.findall(
        r"\[program:(audio-analyzer[\w-]*)\][^\[]*?startsecs=(\d+)", dockerfile)}
    assert set(windows) == {"audio-analyzer", "audio-analyzer-clap"}
    assert all(gpu_switch.SETTLE_SECONDS >= secs for secs in windows.values()), windows


def test_a_process_without_the_runtime_never_asks_for_a_gpu_session(tmp_path, monkeypatch):
    _data(tmp_path, monkeypatch, switches={"soundVectors": True, "analysis": False}, installed=True)
    monkeypatch.delenv("KIMA_GPU_RUNTIME", raising=False)
    assert gpu_runtime.request_gpu() is False
    monkeypatch.setenv("KIMA_GPU_RUNTIME", "1")
    assert gpu_runtime.request_gpu() is True


def test_a_start_leaves_a_running_install_alone(tmp_path, monkeypatch):
    import threading
    root = _runtime_at(tmp_path, monkeypatch)
    gpu_runtime.update_state(status="installing", startedEpoch=__import__("time").time())
    _want(root, True)
    hold = threading.Event()
    running = threading.Thread(target=hold.wait, daemon=True)
    running.start()
    monkeypatch.setattr(gpu_runtime, "_install_thread", running)
    assert gpu_runtime.reconcile() == "busy"
    assert gpu_runtime.read_state()["status"] == "installing"
    hold.set()


def test_a_data_folder_that_cannot_be_written_costs_the_answer_never_the_analyzer(tmp_path, monkeypatch):
    root = _runtime_at(tmp_path, monkeypatch)
    _want(root, True)
    root.chmod(0o555)
    try:
        gpu_runtime.record_provider(False, "not measured since this start", measured=False)
        assert gpu_runtime.dispatch("install") == "started"
        _settle()
        assert gpu_runtime._install_thread is None, "the failed install ran again"
    finally:
        root.chmod(0o755)
    assert not any(p.name.startswith(".install-") for p in root.iterdir())


def test_compose_s_shared_gpu_volume_is_a_folder_every_image_gives_to_its_user():
    def text(path):
        with open(os.path.join(REPO, path)) as f:
            return re.sub(r"\\\n\s*", " ", f.read())
    compose = text("docker-compose.yml")
    mounts = set(re.findall(r"gpu_runtime_data:(\S+)", compose))
    assert mounts == {"/app/gpu-onnx", "/gpu-onnx"}, mounts
    assert re.search(r"mkdir -p [^&]*/app/gpu-onnx.*chown -R node:node /app", text("backend/Dockerfile"))
    for image in ("services/audio-analyzer/Dockerfile", "services/audio-analyzer-clap/Dockerfile"):
        body = text(image)
        assert re.search(r"mkdir -p /gpu-onnx.*chown -R analyzer:analyzer [^\n]*/gpu-onnx", body), image
        assert body.index("chown -R analyzer:analyzer /app /gpu-onnx") < body.index("USER analyzer"), image


def test_the_sound_vector_worker_keeps_its_heartbeat_while_it_finishes_running_jobs(monkeypatch):
    import asyncio
    import importlib.util
    spec = importlib.util.spec_from_file_location("clap_analyzer_close", os.path.join(SERVICE_DIR, "analyzer.py"))
    assert spec and spec.loader
    analyzer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(analyzer)
    monkeypatch.setattr(analyzer, "HEARTBEAT_SECONDS", 0.05)
    beats = []

    class Redis:
        def set(self, key, value):
            beats.append(key)

    class SlowClose:
        async def close(self):
            await asyncio.sleep(0.4)

    worker = analyzer.BullMQVibeWorker.__new__(analyzer.BullMQVibeWorker)
    worker._redis_client, worker._active_concurrency = Redis(), 1
    asyncio.run(worker._close(SlowClose()))
    assert beats.count("clap:worker:heartbeat") >= 3, beats


def test_a_runtime_without_cuda_libraries_adds_no_empty_entry_to_the_library_path(tmp_path, monkeypatch):
    import subprocess
    root = tmp_path / "gpu-onnx"
    (root / "site" / "onnxruntime").mkdir(parents=True)
    (root / "state.json").write_text(json.dumps({"status": "installed"}))
    (root / "enabled.json").write_text(json.dumps({"enabled": True, "soundVectors": True, "analysis": False}))
    env = {k: v for k, v in os.environ.items() if k != "LD_LIBRARY_PATH"}
    for start in (None, "/opt/lib"):
        run_env = dict(env, DATA_DIR=str(tmp_path), **({"LD_LIBRARY_PATH": start} if start else {}))
        out = subprocess.run(["bash", os.path.join(SERVICE_DIR, "gpu_env.sh"), "env"], env=run_env,
                             capture_output=True, text=True, check=True).stdout
        lines = dict(line.split("=", 1) for line in out.splitlines() if "=" in line)
        assert lines.get("KIMA_GPU_RUNTIME") == "1"
        assert lines.get("LD_LIBRARY_PATH") == start, lines.get("LD_LIBRARY_PATH")


def test_a_fresh_install_runs_the_sound_vector_workers_the_settings_page_shows():
    with open(os.path.join(REPO, "backend", "prisma", "schema.prisma")) as f:
        schema_default = int(re.search(r"clapWorkers\s+Int\s+@default\((\d+)\)", f.read()).group(1))
    with open(os.path.join(SERVICE_DIR, "analyzer.py")) as f:
        code_default = int(re.search(r"NUM_WORKERS = int\(os.getenv\('NUM_WORKERS', '(\d+)'\)\)", f.read()).group(1))
    with open(os.path.join(REPO, "Dockerfile")) as f:
        program = re.search(r"\[program:audio-analyzer-clap\][^\[]*", f.read()).group(0)
    assert code_default == schema_default
    assert "NUM_WORKERS" not in program, "the all-in-one image overrides the sound-vector worker default"


def test_switching_off_clears_a_download_a_killed_install_left(tmp_path, monkeypatch):
    root = _runtime_at(tmp_path, monkeypatch)
    (root / ".install-abandoned").mkdir(parents=True)
    _want(root, False)
    assert gpu_runtime.dispatch("cancel") == "nothing_to_cancel"
    assert not (root / ".install-abandoned").exists()


def test_a_start_clears_a_download_a_killed_install_left_even_with_both_switches_off(tmp_path, monkeypatch):
    root = _runtime_at(tmp_path, monkeypatch)
    (root / ".install-abandoned" / "wheels").mkdir(parents=True)
    _want(root, False)
    assert gpu_runtime.reconcile() == "nothing_to_do"
    assert not (root / ".install-abandoned").exists()


def test_switching_off_forgets_any_failed_step_including_a_removal_an_older_version_left(tmp_path, monkeypatch):
    root = _runtime_at(tmp_path, monkeypatch)
    _want(root, False)
    for reason in ("no_network", "removal_failed"):
        gpu_runtime.update_state(status="failed", reason=reason, detail="left over")
        assert gpu_runtime.dispatch("cancel") == "nothing_to_cancel"
        assert gpu_runtime.read_state().get("status") == "idle"
        assert gpu_runtime.read_state().get("reason") is None


def test_a_start_with_both_switches_off_forgets_a_failure_left_by_a_killed_install_or_an_older_version(tmp_path, monkeypatch):
    root = _runtime_at(tmp_path, monkeypatch)
    ran, _ = _fake_steps(root, monkeypatch)
    _want(root, False)
    gpu_runtime.update_state(status="failed", reason="removal_failed", detail="left files")
    assert gpu_runtime.reconcile() == "nothing_to_do"
    assert gpu_runtime.read_state().get("status") == "idle"
    gpu_runtime.update_state(status="installing", startedEpoch=__import__("time").time())
    assert gpu_runtime.reconcile() == "nothing_to_do"
    assert gpu_runtime.read_state().get("status") == "idle"
    assert ran == []


def test_a_start_with_a_switch_on_keeps_the_failure_and_tries_again(tmp_path, monkeypatch):
    root = _runtime_at(tmp_path, monkeypatch)
    ran, _ = _fake_steps(root, monkeypatch)
    _want(root, True)
    gpu_runtime.update_state(status="failed", reason="no_network", detail="index unreachable")
    assert gpu_runtime.reconcile() == "install"
    _settle()
    assert ran == ["install"]


def test_switching_off_kills_a_running_download_at_once(tmp_path, monkeypatch):
    import subprocess
    import threading
    import time
    _runtime_at(tmp_path, monkeypatch)
    started = []
    real_popen = subprocess.Popen

    def slow_pip(cmd, **kwargs):
        child = real_popen(["sleep", "60"], **kwargs)
        started.append(child)
        return child

    monkeypatch.setattr(gpu_runtime.subprocess, "Popen", slow_pip)
    gpu_runtime._cancel.clear()
    threading.Timer(0.5, gpu_runtime._cancel.set).start()
    began = time.monotonic()
    try:
        assert gpu_runtime._download(str(tmp_path / "wheels")) == "cancelled"
    finally:
        gpu_runtime._cancel.clear()
    assert time.monotonic() - began < 5
    assert len(started) == 1 and started[0].poll() is not None


def test_a_download_killed_by_a_cancel_that_was_then_taken_back_starts_again(tmp_path, monkeypatch):
    import subprocess
    _runtime_at(tmp_path, monkeypatch)
    replies = [subprocess.CompletedProcess([], None, "", ""), subprocess.CompletedProcess([], 0, "", "")]
    monkeypatch.setattr(gpu_runtime, "_pip", lambda *a, **k: replies.pop(0))
    monkeypatch.setattr(gpu_runtime, "PIP_ATTEMPTS", 1)  # the killed run must not use up the one attempt
    assert gpu_runtime._download(str(tmp_path / "wheels")) is None
    assert replies == []


def test_a_cancel_that_arrives_after_a_switch_went_back_on_changes_nothing(tmp_path, monkeypatch):
    root = _runtime_at(tmp_path, monkeypatch)
    gate = __import__("threading").Event()
    ran, _ = _fake_steps(root, monkeypatch, gate=gate)
    _want(root, True)
    assert gpu_runtime.dispatch("install") == "started"
    assert gpu_runtime.dispatch("cancel") == "still_wanted"
    assert not gpu_runtime._cancel.is_set()
    gate.set()
    _settle()
    assert ran == ["install"] and gpu_runtime.is_installed()


def test_a_cancelled_download_ends_as_cancelled_even_if_a_switch_goes_back_on_at_that_moment(tmp_path, monkeypatch):
    root = _runtime_at(tmp_path, monkeypatch)
    _want(root, True)
    monkeypatch.setattr(gpu_runtime, "_platform_ok", lambda: None)
    monkeypatch.setattr(gpu_runtime, "_gpu_visible", lambda: None)

    def download(_):
        gpu_runtime._cancel.clear()  # the switch went back on between the kill and the installer's look
        return "cancelled"

    monkeypatch.setattr(gpu_runtime, "_download", download)
    monkeypatch.setattr(gpu_runtime, "_verify_checksums", lambda _: (_ for _ in ()).throw(AssertionError("checked an unfinished download")))
    assert gpu_runtime._install() == "cancelled"
    assert gpu_runtime.read_state()["status"] == "idle"


def test_an_install_that_fails_after_both_switches_went_off_leaves_no_failure_behind(tmp_path, monkeypatch):
    root = _runtime_at(tmp_path, monkeypatch)
    gate = __import__("threading").Event()
    ran, _ = _fake_steps(root, monkeypatch, gate=gate, install_fails=True)
    _want(root, True)
    assert gpu_runtime.dispatch("install") == "started"
    _want(root, False)
    gate.set()
    _settle()
    assert ran == ["install"]
    assert gpu_runtime.read_state().get("status") == "idle"
