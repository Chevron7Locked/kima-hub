"""
With the GPU toggle off: the provider plan is CPU only, the env wrapper
exports nothing, no CUDA module loads, and the image's dependency files never
name the GPU runtime.
"""
import importlib.util
import json
import os
import subprocess
import sys

SERVICE_DIR = os.path.dirname(os.path.abspath(__file__))

# Runs in a fresh interpreter: other tests in this session may have imported torch.
CUDAISH_PROBE = """
import importlib.util, os, sys
for name in ("gpu_runtime", "onnx_backend"):
    spec = importlib.util.spec_from_file_location(name, os.path.join(sys.argv[1], name + ".py"))
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
assert sys.modules["gpu_runtime"].request_gpu() is False
keys = ("cuda", "nvidia", "cudnn", "cublas", "cufft", "curand")
print("\\n".join(m for m in sys.modules if any(k in m.lower() for k in keys)))
"""


def _load(name, filename, data_dir):
    os.environ["DATA_DIR"] = str(data_dir)
    spec = importlib.util.spec_from_file_location(name, os.path.join(SERVICE_DIR, filename))
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


def test_plan_stays_cpu_when_toggle_off_even_with_cuda_available():
    ob = _load("obA", "onnx_backend.py", "/tmp/nonexistent-gpu-onnx-test-dir")
    assert ob.plan_providers(False, ["CUDAExecutionProvider", "CPUExecutionProvider"]) == \
        ["CPUExecutionProvider"]


def test_plan_stays_cpu_when_this_runtime_cannot_offer_cuda():
    ob = _load("obB", "onnx_backend.py", "/tmp/nonexistent-gpu-onnx-test-dir")
    assert ob.plan_providers(True, ["CPUExecutionProvider"]) == ["CPUExecutionProvider"]


def test_plan_asks_cuda_only_when_toggled_and_available():
    ob = _load("obC", "onnx_backend.py", "/tmp/nonexistent-gpu-onnx-test-dir")
    assert ob.plan_providers(True, ["CUDAExecutionProvider", "CPUExecutionProvider"]) == \
        ["CUDAExecutionProvider", "CPUExecutionProvider"]


def test_request_gpu_false_on_empty_data_dir_and_no_cudaish_modules():
    gr = _load("grA", "gpu_runtime.py", "/tmp/nonexistent-gpu-onnx-test-dir")
    assert gr.read_enabled() is False
    assert gr.is_installed() is False
    assert gr.request_gpu() is False
    out = subprocess.run(
        [sys.executable, "-c", CUDAISH_PROBE, SERVICE_DIR],
        env={**os.environ, "DATA_DIR": "/tmp/nonexistent-gpu-onnx-test-dir"},
        capture_output=True, text=True, check=True).stdout
    assert out.split() == []


def test_nobody_downloads_anything_unless_they_turn_a_switch_on(tmp_path):
    gr = _load("grB", "gpu_runtime.py", tmp_path)
    assert gr.reconcile() == "nothing_to_do"
    assert gr.dispatch("install") == "skipped_disabled"
    assert not (tmp_path / "gpu-onnx").exists()


def test_an_installed_runtime_with_both_switches_off_stays_and_is_never_removed_by_a_start(tmp_path):
    gr = _load("grC", "gpu_runtime.py", tmp_path)
    root = tmp_path / "gpu-onnx"
    (root / "site" / "onnxruntime").mkdir(parents=True)
    (root / "state.json").write_text(json.dumps({"status": "installed"}))
    (root / "enabled.json").write_text(json.dumps({"enabled": False, "soundVectors": False, "analysis": False}))
    assert gr.reconcile() == "nothing_to_do"
    assert (root / "site" / "onnxruntime").is_dir()
    assert gr.request_gpu() is False


def _wrapped_env_text(data_dir, **extra):
    """The environment gpu_env.sh hands the analyzer, as `env` prints it, from empty library paths."""
    return subprocess.run(
        ["bash", os.path.join(SERVICE_DIR, "gpu_env.sh"), "env"],
        env={**os.environ, "DATA_DIR": str(data_dir), "PYTHONPATH": "", "LD_LIBRARY_PATH": "", **extra},
        capture_output=True, text=True, check=True).stdout


def test_env_wrapper_exports_nothing_when_toggle_off(tmp_path):
    out = _wrapped_env_text(tmp_path)
    assert "gpu-onnx" not in out
    lines = dict(l.split("=", 1) for l in out.splitlines() if "=" in l)
    assert lines.get("PYTHONPATH", "") == ""
    assert lines.get("LD_LIBRARY_PATH", "") == ""


def test_env_wrapper_activates_only_when_enabled_and_installed(tmp_path):
    site = tmp_path / "gpu-onnx" / "site"
    (site / "onnxruntime").mkdir(parents=True)
    (site / "nvidia" / "cublas" / "lib").mkdir(parents=True)
    root = tmp_path / "gpu-onnx"
    (root / "state.json").write_text(json.dumps({"status": "installed"}))
    # Installed but NOT enabled: still nothing (the toggle is the only switch).
    out = _wrapped_env_text(tmp_path)
    assert "gpu-onnx" not in out
    # Only the audio-analysis switch on: the sound-vector analyzer still gets nothing.
    (root / "enabled.json").write_text(json.dumps({"enabled": True, "soundVectors": False, "analysis": True}))
    def wrapped_env(**extra):
        return dict(l.split("=", 1) for l in _wrapped_env_text(tmp_path, **extra).splitlines() if "=" in l)
    assert str(site) not in wrapped_env().get("PYTHONPATH", "")
    analysis = wrapped_env(KIMA_GPU_FOR="analysis")
    assert str(site / "nvidia" / "cublas" / "lib") in analysis.get("LD_LIBRARY_PATH", "")
    assert analysis.get("KIMA_GPU_RUNTIME") == "1"
    # Its own switch on: the sound-vector analyzer gets the runtime.
    (root / "enabled.json").write_text(json.dumps({"enabled": True, "soundVectors": True, "analysis": False}))
    lines = wrapped_env()
    assert str(site) in lines.get("PYTHONPATH", "")
    assert str(site / "nvidia" / "cublas" / "lib") in lines.get("LD_LIBRARY_PATH", "")
    assert lines.get("KIMA_GPU_RUNTIME") == "1"
    assert "KIMA_GPU_RUNTIME" not in wrapped_env(KIMA_GPU_FOR="analysis")


def test_shipped_dependency_files_never_mention_the_runtime():
    # The 3.4 GB CUDA set is pip-installed into the data volume at runtime.
    # If it ever leaks into the image files, every user pays — this is the tripwire.
    repo = os.path.dirname(os.path.dirname(SERVICE_DIR))
    files = [os.path.join(SERVICE_DIR, "requirements.txt"), os.path.join(SERVICE_DIR, "Dockerfile"),
             os.path.join(repo, "Dockerfile"), os.path.join(repo, "services", "audio-analyzer", "Dockerfile"),
             os.path.join(repo, "services", "audio-analyzer", "requirements.txt")]
    for path in files:
        with open(path) as f:
            body = f.read().lower()
        for needle in ("onnxruntime-gpu", "nvidia", "cudnn", "cuda"):
            assert needle not in body, f"{os.path.relpath(path, repo)} mentions {needle!r}"
