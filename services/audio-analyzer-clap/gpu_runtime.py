"""
Installs and verifies the optional GPU ONNX runtime. The analyzer owns every
fact in state.json; the backend only writes the toggle and enabled.json.
Stdlib only at import, so nobody who leaves the toggle off pays for it.
"""

import ctypes
import hashlib
import json
import logging
import os
import platform
import shutil
import subprocess
import sys
import sysconfig
import threading
import time

import gpu_switch

logger = logging.getLogger(__name__)

ROOT = os.path.normpath(
    os.path.join(os.getenv('DATA_DIR', '/data'), 'gpu-onnx'))
SITE = os.path.join(ROOT, 'site')
STATE_PATH = os.path.join(ROOT, 'state.json')
ENABLED_PATH = os.path.join(ROOT, 'enabled.json')

PIP_TIMEOUT_S = 1800
PIP_ATTEMPTS = 3
STALE_INSTALLING_S = PIP_TIMEOUT_S * PIP_ATTEMPTS + 300
ABANDONED = 'install child abandoned (analyzer restarted mid-install)'

CUDA_DRIVER_MIN = 12040

# The set checked on an RTX 4060 Ti (cosine 1.0 against the CPU over 25 tracks). Transitive closure
# pinned with --no-deps so nothing here shadows the image's numpy/protobuf/flatbuffers.
PINS = [
    ('onnxruntime-gpu', '1.22.0'),
    ('nvidia-cuda-runtime-cu12', '12.9.79'),
    ('nvidia-cublas-cu12', '12.9.2.10'),
    ('nvidia-cudnn-cu12', '9.26.0.51'),
    ('nvidia-cufft-cu12', '11.4.1.4'),
    ('nvidia-curand-cu12', '10.3.10.19'),
    ('nvidia-nvjitlink-cu12', '12.9.86'),
    ('nvidia-cuda-nvrtc-cu12', '12.9.86'),
    ('coloredlogs', '15.0.1'),
    ('humanfriendly', '10.0'),
    ('mpmath', '1.3.0'),
    ('sympy', '1.14.0'),
]

# sha256 of each pinned wheel, keyed by normalized distribution name.
PIN_SHA256 = {
    'onnxruntime-gpu': 'd30c1512f22b1f01bacb4f177d49cbefd23e0f4bef56066f1282992d133e6ff8',
    'nvidia-cuda-runtime-cu12': '25bba2dfb01d48a9b59ca474a1ac43c6ebf7011f1b0b8cc44f54eb6ac48a96c3',
    'nvidia-cublas-cu12': 'e4f53a8ca8c5d6e8c492d0d0a3d565ecb59a751b19cfdaa4f6da0ab2104c1702',
    'nvidia-cudnn-cu12': 'ce8603d4ea88d134be5a92c5e0833d513bea1ce0ee4bbc5d649fcb8718d51cbf',
    'nvidia-cufft-cu12': 'c67884f2a7d276b4b80eb56a79322a95df592ae5e765cf1243693365ccab4e28',
    'nvidia-curand-cu12': '49b274db4780d421bd2ccd362e1415c13887c53c214f0d4b761752b8f9f6aa1e',
    'nvidia-nvjitlink-cu12': 'e3f1171dbdc83c5932a45f0f4c99180a70de9bd2718c1ab77d14104f6d7147f9',
    'nvidia-cuda-nvrtc-cu12': '210cf05005a447e29214e9ce50851e83fc5f4358df8b453155d5e1918094dcb4',
    'coloredlogs': '612ee75c546f53e92e70049c9dbfcc18c935a2b9a53b66085ce9ef6a6e5c0934',
    'humanfriendly': '1697e1a8a8f550fd43c2865cd84542fc175a61dcb779b6fee18cf6b6ccba1477',
    'mpmath': 'a0b2b9fe80bbcd81a6647ff13108738cfb482d481d826cc0e02f5b35e5c88d2c',
    'sympy': 'e091cc3e99d2141a0ba2847328f5479b05d94a6635cb96148ccb3f34671bd8f5',
}

PIN_SPECS = ['%s==%s' % (n, v) for n, v in PINS]

_lock = threading.Lock()
_install_thread = None
_cancel = threading.Event()


def _now():
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())


def read_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def write_json_atomic(path, payload):
    tmp = path + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(payload, f, indent=1)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def read_state():
    state = read_json(STATE_PATH)
    if not isinstance(state, dict):
        return {'status': 'idle'}
    if state.get('status') == 'installing' and \
            time.time() - float(state.get('startedEpoch') or 0) > STALE_INSTALLING_S:
        state = dict(state, status='failed', reason='install_failed', detail=ABANDONED)
        write_json_atomic(STATE_PATH, state)
    return state


def update_state(**fields):
    with _lock:
        return _write_state(fields)


def _write_state(fields):
    """Caller holds _lock."""
    state = dict(read_state())
    state.update(fields)
    state['updatedAt'] = _now()
    write_json_atomic(STATE_PATH, state)
    return state


def read_enabled():
    """Whether the runtime is wanted: either switch (sound vectors, audio analysis) is on."""
    projection = read_json(ENABLED_PATH)
    return bool(projection and projection.get('enabled'))


def is_installed():
    return read_state().get('status') == 'installed' and os.path.isdir(
        os.path.join(SITE, 'onnxruntime'))


def request_gpu():
    """True only when the sound-vector switch is on, the runtime is installed, and this process started with it
    (a process without it on its path cannot open a GPU session)."""
    return gpu_switch.started_with_runtime() and gpu_switch.runtime_for('soundVectors') is not None


def busy():
    """True while an install is running in this process."""
    thread = _install_thread
    return thread is not None and thread.is_alive()


def nvidia_lib_dirs(site_dir):
    base = os.path.join(site_dir, 'nvidia')
    dirs = []
    try:
        for pkg in sorted(os.listdir(base)):
            lib = os.path.join(base, pkg, 'lib')
            if os.path.isdir(lib):
                dirs.append(lib)
    except OSError:
        pass
    return dirs


def record_provider(active, detail=None, measured=True):
    """measured: the answer of a session this start opened with the runtime, rather than the reset a start
    records before it has one. A data directory that cannot be written costs the settings page this answer,
    never the analyzer."""
    try:
        update_state(provider={'active': bool(active), 'measured': bool(measured), 'recordedAt': _now(),
                               'detail': detail})
    except OSError as exc:
        logger.warning('gpu-runtime: could not record the GPU answer: %r', exc)


def _dir_bytes(path):
    total = 0
    for dirpath, _, files in os.walk(path):
        for name in files:
            total += os.path.getsize(os.path.join(dirpath, name))
    return total


def _platform_ok():
    if sys.platform != 'linux' or platform.machine() != 'x86_64':
        return 'unsupported_platform', 'linux/x86_64 required, got %s/%s' % (
            sys.platform, platform.machine())
    if sys.version_info[:2] != (3, 11):
        return 'unsupported_platform', 'CPython 3.11 required (pinned wheels), got %d.%d' % sys.version_info[:2]
    return None


def _gpu_visible():
    if not os.path.exists('/dev/nvidia0'):
        return 'no_gpu', 'no /dev/nvidia0 — the container has no NVIDIA device access'
    try:
        libcuda = ctypes.CDLL('libcuda.so.1')
    except OSError:
        return 'no_gpu', 'libcuda.so.1 not loadable — driver not visible in this container'
    try:
        if libcuda.cuInit(0) != 0:
            return 'no_gpu', 'cuInit failed — driver refused the handshake'
        version = ctypes.c_int(0)
        if libcuda.cuDriverGetVersion(ctypes.byref(version)) != 0:
            return 'no_gpu', 'cuDriverGetVersion failed'
        if version.value < CUDA_DRIVER_MIN:
            return 'driver_too_old', 'driver reports CUDA %d, need >= %d' % (
                version.value, CUDA_DRIVER_MIN)
    except Exception as exc:
        return 'no_gpu', 'driver handshake error: %s' % exc
    return None


def _externally_managed() -> bool:
    return os.path.exists(os.path.join(sysconfig.get_paths()['stdlib'], 'EXTERNALLY-MANAGED'))


def _pip(args, env=None, timeout=PIP_TIMEOUT_S, cancellable=False):
    """Run pip. A cancellable run is killed as soon as a cancel is asked for (returncode None then)."""
    cmd = [sys.executable, '-m', 'pip'] + args
    if _externally_managed():
        cmd += ['--disable-pip-version-check']
    if not cancellable:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=env)
    deadline = time.monotonic() + timeout
    with subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env) as proc:
        while True:
            try:
                out, err = proc.communicate(timeout=1)
                return subprocess.CompletedProcess(cmd, proc.returncode, out, err)
            except subprocess.TimeoutExpired:
                if _cancel.is_set():
                    proc.kill()
                    out, err = proc.communicate()
                    return subprocess.CompletedProcess(cmd, None, out, err)
                if time.monotonic() > deadline:
                    proc.kill()
                    proc.communicate()
                    raise subprocess.TimeoutExpired(cmd, timeout)


def _pip_output(proc):
    return (proc.stdout or '') + (proc.stderr or '')


def _pip_tail(proc):
    return '\n'.join(_pip_output(proc).strip().splitlines()[-20:])


def _download(wheels_dir):
    """None when the wheels are in wheels_dir, 'cancelled' when a cancel stopped it, else (reason, detail)."""
    last = None
    attempts = 0
    while attempts < PIP_ATTEMPTS:
        proc = _pip(['download', '--no-deps', '--only-binary=:all:',
                     '--timeout', '30', '--retries', '2',
                     '-d', wheels_dir] + PIN_SPECS, cancellable=True)
        if _cancel.is_set():
            return 'cancelled'
        if proc.returncode is None:
            continue  # killed by a cancel, then switched back on before this look: start the download again
        attempts += 1
        if proc.returncode == 0:
            return None
        last = proc
        text = _pip_output(proc)
        if 'Could not find a version' in text or 'No matching distribution' in text:
            return ('install_failed', 'index rejected the pinned set\n' + _pip_tail(proc))
    text = _pip_output(last)
    if 'Connection' in text or 'NewConnectionError' in text or \
            'Max retries' in text or 'Temporary failure' in text or \
            'timed out' in text.lower():
        return ('no_network', _pip_tail(last))
    return ('install_failed', _pip_tail(last))


def _verify_checksums(wheels_dir):
    by_name = {}
    for fname in sorted(os.listdir(wheels_dir)):
        if not fname.endswith('.whl'):
            continue
        dist = fname.split('-')[0].lower().replace('_', '-')
        by_name[dist] = os.path.join(wheels_dir, fname)
    missing = [n for n, _ in PINS if n not in by_name]
    if missing:
        return 'checksum_mismatch', 'wheel missing after download: %s' % ', '.join(missing)
    for name, _ in PINS:
        path = by_name[name]
        digest = hashlib.sha256()
        with open(path, 'rb') as f:
            while True:
                chunk = f.read(1 << 20)
                if not chunk:
                    break
                digest.update(chunk)
        expected = PIN_SHA256.get(name)
        if expected is None:
            return 'checksum_mismatch', 'no pinned sha256 for %s' % name
        if digest.hexdigest() != expected:
            return 'checksum_mismatch', '%s: got %s want %s' % (name, digest.hexdigest(), expected)
    return None


def _smoke_test(site_dir):
    # The new download's own CUDA libraries: the live SITE may be absent or an older pin.
    libs = nvidia_lib_dirs(site_dir)
    env = dict(os.environ, PYTHONPATH=site_dir)
    if libs:
        env['LD_LIBRARY_PATH'] = ':'.join(libs)
    try:
        proc = subprocess.run(
            [sys.executable, '-c',
             'import json, onnxruntime; print(json.dumps(onnxruntime.get_available_providers()))'],
            capture_output=True, text=True, timeout=120, env=env)
    except subprocess.TimeoutExpired:
        return 'install_failed', 'post-install import test timed out'
    if proc.returncode != 0:
        return 'install_failed', 'post-install import failed\n' + _pip_tail(proc)
    try:
        providers = json.loads(proc.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        return 'install_failed', 'post-install import test printed nothing usable'
    if 'CUDAExecutionProvider' not in providers:
        return 'install_failed', 'runtime installed but CUDA EP absent: %s' % providers
    return None


def _swap_site(tmp_site):
    old = SITE + '.old'
    shutil.rmtree(old, ignore_errors=True)
    if os.path.isdir(SITE):
        os.rename(SITE, old)
    try:
        os.rename(tmp_site, SITE)
    except OSError:
        if os.path.isdir(old):
            os.rename(old, SITE)
        raise
    shutil.rmtree(old, ignore_errors=True)


def _clear_abandoned_installs():
    """Download folders an install left when its process was killed (this thread is the only installer)."""
    for name in os.listdir(ROOT) if os.path.isdir(ROOT) else []:
        if name.startswith('.install-'):
            shutil.rmtree(os.path.join(ROOT, name), ignore_errors=True)


def _failed(reason, detail):
    """Record a failed step. A data directory that cannot be written is logged, not raised, so the step still
    ends as failed and is not repeated."""
    try:
        update_state(status='failed', reason=reason, detail=detail)
    except OSError as exc:
        logger.error('gpu-runtime: %s (%s), and the state could not be written: %r', reason, detail, exc)
    return 'failed'


def _install():
    """Download, check and swap in the runtime: 'installed', 'cancelled' or 'failed'."""
    tmp_root = os.path.join(ROOT, '.install-%d' % int(time.time()))
    wheels_dir = os.path.join(tmp_root, 'wheels')
    tmp_site = os.path.join(tmp_root, 'site')
    try:
        _clear_abandoned_installs()
        os.makedirs(wheels_dir)
        update_state(status='installing', startedEpoch=time.time(),
                     startedAt=_now(), reason=None, detail=None)
        failure = _platform_ok() or _gpu_visible()
        if failure:
            return _failed(*failure)
        if _cancel.is_set():
            update_state(status='idle', reason=None, detail='cancelled before download')
            return 'cancelled'
        failure = _download(wheels_dir)
        if failure == 'cancelled':
            update_state(status='idle', reason=None, detail='cancelled during download')
            return 'cancelled'
        if failure:
            return _failed(*failure)
        failure = _verify_checksums(wheels_dir)
        if failure:
            return _failed(*failure)
        args = ['install', '--no-deps', '--no-index', '--no-cache-dir',
                '--find-links', wheels_dir, '--target', tmp_site]
        if _externally_managed():
            args.append('--break-system-packages')
        proc = _pip(args + PIN_SPECS, timeout=600)
        if proc.returncode != 0:
            return _failed('install_failed', 'pip --target failed\n' + _pip_tail(proc))
        failure = _smoke_test(tmp_site)
        if failure:
            return _failed(*failure)
        _swap_site(tmp_site)
        if not os.path.isdir(os.path.join(SITE, 'onnxruntime')):
            return _failed('install_failed', 'the runtime is missing after the swap')
        update_state(status='installed', installedAt=_now(), reason=None, detail=None,
                     pinned=PIN_SPECS, bytes=_dir_bytes(SITE))
        return 'installed'
    except Exception as exc:
        return _failed('install_failed', 'unhandled installer error: %r' % exc)
    finally:
        shutil.rmtree(tmp_root, ignore_errors=True)


def _next_action(retry_failed):
    """What the switches ask of the disk: install when the runtime is wanted and missing (after a failed
    attempt only when retry_failed). Nothing is ever removed: an installed runtime that nothing wants stays
    on disk, inert (each process puts it on its path only while its own switch is on)."""
    status = read_state().get('status')
    if not read_enabled():
        return None
    if is_installed() or status == 'installing':
        return None
    return 'install' if retry_failed or status != 'failed' else None


def _start(action):
    """Caller holds _lock."""
    global _install_thread
    if action == 'install':
        _cancel.clear()
    _install_thread = threading.Thread(target=_converge, args=(action,), name='gpu-runtime-install',
                                       daemon=True)
    _install_thread.start()


def _converge(action):
    """Run `action`, then whatever the switches ask for by the time it ends, so a request that came in
    while this thread was busy is carried out. A failed step ends the run instead of repeating."""
    global _install_thread
    while action:
        outcome = _install()
        with _lock:
            action = None if outcome == 'failed' else _next_action(retry_failed=False)
            if not read_enabled():
                _forget_failure()  # both switches went off while it ran: nobody is waiting on this answer
            if action == 'install':
                _cancel.clear()
            if action is None:
                _install_thread = None


def _forget_failure():
    """A failed step nobody wants any more (both switches off) is no longer worth reporting."""
    if read_state().get('status') == 'failed':
        _write_state({'status': 'idle', 'reason': None, 'detail': None})


def dispatch(action):
    """Entry point for control messages. While an install runs, an install request is left to it (it looks at
    the switches again when it ends). 'cancel' stops a running download; once the download is done the
    install finishes and the runtime stays, unused. Nothing installed is ever deleted."""
    with _lock:
        if action == 'cancel':
            # A cancel that arrives after a switch went back on (two quick clicks) is stale: the switches win.
            if read_enabled():
                return 'still_wanted'
            if busy():
                _cancel.set()
                return 'cancelling'
            # A download left by a killed install is half a runtime nobody can use: clear it.
            _clear_abandoned_installs()
            _forget_failure()
            return 'nothing_to_cancel'
        if action != 'install':
            return 'unknown_action'
        if busy():
            # Switched on again while an earlier "off" was stopping the download: let it carry on.
            _cancel.clear()
            return 'busy'
        if not read_enabled():
            return 'skipped_disabled'
        if is_installed():
            return 'skipped_installed'
        _start(action)
        return 'started'


def reconcile():
    """At start, install what the switches ask for if it is missing: this carries out a request sent while the
    process was down, and tries a failed install again. It never removes anything. An install still marked
    running was this process's predecessor's, killed with it."""
    with _lock:
        if busy():
            return 'busy'
        recorded = read_json(STATE_PATH)
        # Nothing runs yet in this process, so any download folder is a killed predecessor's: clear it.
        _clear_abandoned_installs()
        if isinstance(recorded, dict) and recorded.get('status') == 'installing':
            _write_state({'status': 'failed', 'reason': 'install_failed', 'detail': ABANDONED})
        if not read_enabled():
            _forget_failure()
        action = _next_action(retry_failed=True)
        if action is None:
            return 'nothing_to_do'
        _start(action)
        return action
