"""The post-install check imports the new download with that download's own CUDA libraries on the library path,
not the live install's. A real subprocess; the downloaded onnxruntime is a stand-in that reports CUDA only when
its own site's nvidia libs are on LD_LIBRARY_PATH."""
import os
import sys

SERVICE_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SERVICE_DIR)

import gpu_runtime  # noqa: E402

FAKE_ORT = '''import os
_site = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
def get_available_providers():
    ours = os.path.join(_site, "nvidia", "cublas", "lib")
    path = os.environ.get("LD_LIBRARY_PATH", "").split(":")
    return ["CUDAExecutionProvider", "CPUExecutionProvider"] if ours in path else ["CPUExecutionProvider"]
'''


def _site(root):
    (root / "nvidia" / "cublas" / "lib").mkdir(parents=True)
    (root / "onnxruntime").mkdir()
    (root / "onnxruntime" / "__init__.py").write_text(FAKE_ORT)
    return str(root)


def test_the_check_uses_the_new_download_libs(tmp_path, monkeypatch):
    monkeypatch.setattr(gpu_runtime, "SITE", str(tmp_path / "live-site-absent"))
    assert gpu_runtime._smoke_test(_site(tmp_path / "tmp-site")) is None


def test_the_live_install_libs_do_not_stand_in(tmp_path, monkeypatch):
    live = tmp_path / "live"
    (live / "nvidia" / "cublas" / "lib").mkdir(parents=True)
    monkeypatch.setattr(gpu_runtime, "SITE", str(live))
    new = _site(tmp_path / "tmp-site")
    assert gpu_runtime.nvidia_lib_dirs(new) == [os.path.join(new, "nvidia", "cublas", "lib")]
