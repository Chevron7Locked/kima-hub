"""
MusiCNN and its classification heads on ONNX Runtime, on the CPU or the GPU.

The input is Essentia's own: 512-sample frames every 256 samples of 16 kHz audio,
96 mel bands from TensorflowInputMusiCNN, cut into patches of 187 frames every 93
with the last partial patch dropped (Essentia tensorflowpredictmusicnn.cpp/.h).
The graphs are Essentia's, converted by convert_musicnn.py, which proves at build
time that they answer as Essentia's TensorFlow does.
"""

import logging
import os
import queue
import secrets
import shutil
import tempfile
import threading
from multiprocessing.connection import AuthenticationError, Client, Listener
from typing import Dict, List, Optional, Tuple

import numpy as np

FRAME_SIZE = 512
HOP_SIZE = 256
BANDS = 96
PATCH_FRAMES = 187
PATCH_HOP = 93
# The shortest 16 kHz signal that yields one patch: 187 frames of 512 samples every 256.
PATCH_SECONDS = ((PATCH_FRAMES - 1) * HOP_SIZE + FRAME_SIZE) / 16000.0
EMBEDDING_SIZE = 200

# Patches per model call. One call over a whole 90 s track (59 patches) held 2.4-3.9 GB per worker
# process in ONNX Runtime's memory pool and was slower. On four library tracks: CPU at 1 patch takes
# 1.71 s a track and 129 MB, GPU at 4 patches 108 ms. Every call has the same shape (the last group
# is padded), so the pool stays at one size.
CPU_GROUP = 1
GPU_GROUP = 4

# name -> file stem under the model directory; the embedding graph's output is its dense layer.
GRAPHS: Dict[str, str] = {
    'musicnn': 'msd-musicnn-1',
    'danceability': 'danceability-msd-musicnn-1',
    'deam': 'deam-msd-musicnn-2',
    'emomusic': 'emomusic-msd-musicnn-2',
}


def mel_patches(audio_16k: np.ndarray) -> np.ndarray:
    """Essentia's MusiCNN input for a 16 kHz signal: ``(patches, 187, 96)`` float32."""
    import essentia.standard as es
    mel = es.TensorflowInputMusiCNN()
    frames = es.FrameGenerator(np.asarray(audio_16k, dtype=np.float32), frameSize=FRAME_SIZE, hopSize=HOP_SIZE)
    bands = np.array([mel(frame) for frame in frames], dtype=np.float32).reshape(-1, BANDS)
    if bands.shape[0] < PATCH_FRAMES:
        return np.empty((0, PATCH_FRAMES, BANDS), dtype=np.float32)
    starts = range(0, bands.shape[0] - PATCH_FRAMES + 1, PATCH_HOP)
    return np.stack([bands[s:s + PATCH_FRAMES] for s in starts])


# Essentia's TensorFlow answers for gate_signal(), recorded at build (convert_musicnn.py).
ANSWERS_FILE = 'musicnn-answers.npz'
MIN_COSINE = 0.99999


def gate_signal() -> np.ndarray:
    """30 s at 16 kHz: chords, a pulse and noise, fixed by seed."""
    t = np.arange(16000 * 30) / 16000.0
    rng = np.random.default_rng(1011)
    tones = sum(np.sin(2 * np.pi * f * t) for f in (110, 220, 277.2, 329.6, 440, 659.3))
    pulse = (np.sin(2 * np.pi * 2 * t) > 0.95).astype(np.float64) * rng.standard_normal(t.size)
    return (0.05 * tones + 0.2 * pulse + 0.02 * rng.standard_normal(t.size)).astype(np.float32)


def embedding_cosine(run, answers_path: str) -> float:
    """The lowest cosine between ``run``'s embeddings of gate_signal() and Essentia's."""
    expected = np.load(answers_path)['musicnn']
    got = run(mel_patches(gate_signal()))
    if got.shape != expected.shape or got.shape[0] == 0:
        raise ValueError(f'MusiCNN embeddings {got.shape}, Essentia {expected.shape}')
    return float(((got * expected).sum(1) / np.linalg.norm(got, axis=1) / np.linalg.norm(expected, axis=1)).min())


def _session_options(threads: int):
    import onnxruntime as ort
    options = ort.SessionOptions()
    options.intra_op_num_threads = max(1, threads)
    options.inter_op_num_threads = 1
    return options


class MusicnnBody:
    """The MusiCNN graph alone, on the GPU when asked and available, else the CPU."""

    def __init__(self, model_dir: str, use_gpu: bool, threads: int = 1):
        import onnxruntime as ort
        providers: list = ['CPUExecutionProvider']
        if use_gpu and 'CUDAExecutionProvider' in ort.get_available_providers():
            # TF32 (on by default for this GPU) moved head values by up to 6e-4; full float32
            # matches the CPU within 2e-6 at the same speed.
            providers = [('CUDAExecutionProvider', {'use_tf32': 0}), 'CPUExecutionProvider']
        path = os.path.join(model_dir, GRAPHS['musicnn'] + '.onnx')
        if not os.path.exists(path):
            raise FileNotFoundError(f'MusiCNN graph missing from {model_dir}')
        self.session = ort.InferenceSession(path, _session_options(threads), providers=providers)
        self.on_gpu = self.session.get_providers()[0] == 'CUDAExecutionProvider'
        self.group = GPU_GROUP if self.on_gpu else CPU_GROUP
        self._input = self.session.get_inputs()[0].name

    def run(self, patches: np.ndarray) -> np.ndarray:
        """``(patches, 200)`` embeddings, the patches fed ``group`` at a time."""
        if patches.shape[0] == 0:
            return np.empty((0, EMBEDDING_SIZE), dtype=np.float32)
        out = []
        for start in range(0, patches.shape[0], self.group):
            part = patches[start:start + self.group]
            real = part.shape[0]
            if real < self.group:
                part = np.concatenate([part, np.zeros((self.group - real, PATCH_FRAMES, BANDS), np.float32)])
            out.append(self.session.run(None, {self._input: part})[0][:real])
        return np.concatenate(out)


class MusicnnServer:
    """One GPU session for every analysis worker process: a session per worker held about 406 MB
    of GPU memory and 1.1 GB of RAM in GPU libraries, so 16 workers would fill an 8 GB card.
    Workers connect over a socket only this user can open and send a track's patches. One thread
    makes every GPU call: ONNX Runtime gives each calling thread its own GPU workspace, and 16
    calling threads held 2.4 GB."""

    def __init__(self, body: MusicnnBody):
        self.body = body
        self._requests: "queue.Queue[Tuple[np.ndarray, dict, threading.Event]]" = queue.Queue()
        self._dir = tempfile.mkdtemp(prefix='kima-musicnn-')
        self.address: Tuple[str, bytes] = (os.path.join(self._dir, 'body.sock'), secrets.token_bytes(32))
        # Every worker of a new pool connects at once; Listener's default queue holds one.
        self._listener = Listener(self.address[0], family='AF_UNIX', backlog=64, authkey=self.address[1])
        threading.Thread(target=self._run_gpu, name='musicnn-gpu', daemon=True).start()
        threading.Thread(target=self._accept, name='musicnn-server', daemon=True).start()

    def close(self) -> None:
        """Stop serving and let the GPU session go, freeing its GPU memory. Called with no
        worker connected (the pool is already shut down)."""
        self._listener.close()
        self._requests.put(None)
        self.body = None
        shutil.rmtree(self._dir, ignore_errors=True)

    def _run_gpu(self) -> None:
        while True:
            request = self._requests.get()
            if request is None:
                return
            patches, reply, done = request
            try:
                reply['value'] = ('ok', self.body.run(patches))
            except Exception as e:
                reply['value'] = ('error', f'{type(e).__name__}: {e}')
            done.set()

    def _accept(self) -> None:
        while True:
            try:
                conn = self._listener.accept()
            except (AuthenticationError, EOFError, ConnectionError):
                continue
            except OSError:
                return
            threading.Thread(target=self._serve, args=(conn,), name='musicnn-worker', daemon=True).start()

    def _serve(self, conn) -> None:
        with conn:
            while True:
                try:
                    patches = conn.recv()
                except (EOFError, OSError):
                    return
                reply: dict = {}
                done = threading.Event()
                self._requests.put((patches, reply, done))
                done.wait()
                try:
                    conn.send(reply['value'])
                except OSError:
                    return


class RemoteBody:
    """A worker's handle on the main process's MusicnnServer."""

    on_gpu = True
    # A track takes about 0.1 s on the GPU; no answer in this long means the server is gone.
    REPLY_TIMEOUT_S = 120

    def __init__(self, address: Tuple[str, bytes]):
        self._address = address
        self._conn = None

    def run(self, patches: np.ndarray) -> np.ndarray:
        try:
            if self._conn is None:
                self._conn = Client(self._address[0], family='AF_UNIX', authkey=self._address[1])
            self._conn.send(patches)
            if not self._conn.poll(self.REPLY_TIMEOUT_S):
                raise TimeoutError(f'MusiCNN server gave no answer in {self.REPLY_TIMEOUT_S} s')
            status, value = self._conn.recv()
        except BaseException:
            # A broken or silent connection is not reused: the next call connects again.
            if self._conn is not None:
                self._conn.close()
            self._conn = None
            raise
        if status != 'ok':
            raise RuntimeError(f'MusiCNN server: {value}')
        return value


class MusicnnOnnx:
    """MusiCNN and whichever heads exist under ``model_dir``. The body runs here, or in the main
    process's MusicnnServer when ``server`` is its address. The heads are one or two small layers
    over 200 numbers a patch and always run here on the CPU."""

    def __init__(self, model_dir: str, use_gpu: bool, threads: int = 1,
                 server: Optional[Tuple[str, bytes]] = None):
        import onnxruntime as ort
        self._model_dir, self._threads = model_dir, threads
        self.body = RemoteBody(server) if server else MusicnnBody(model_dir, use_gpu, threads)
        self._cpu_body: Optional[MusicnnBody] = None
        self.on_gpu = self.body.on_gpu
        self.sessions = {}
        for name, stem in GRAPHS.items():
            path = os.path.join(model_dir, stem + '.onnx')
            if name != 'musicnn' and os.path.exists(path):
                self.sessions[name] = ort.InferenceSession(
                    path, _session_options(threads), providers=['CPUExecutionProvider'])

    def heads(self) -> List[str]:
        return list(self.sessions)

    def embeddings(self, audio_16k: np.ndarray) -> np.ndarray:
        """``(patches, 200)`` embeddings; no rows when the audio is shorter than one patch.
        If the main process's GPU session fails, this track runs on this worker's CPU (the
        same model; within 2e-6 of the GPU, measured) and the next one tries the GPU again."""
        patches = mel_patches(audio_16k)
        if not isinstance(self.body, RemoteBody):
            return self.body.run(patches)
        try:
            return self.body.run(patches)
        except (OSError, EOFError, TimeoutError, RuntimeError, AuthenticationError) as e:
            logging.getLogger('audio-analyzer').warning(f'MusiCNN GPU session failed ({e}); this track runs on the CPU')
            if self._cpu_body is None:
                self._cpu_body = MusicnnBody(self._model_dir, use_gpu=False, threads=self._threads)
            return self._cpu_body.run(patches)

    def predict(self, head: str, embeddings: np.ndarray) -> Optional[np.ndarray]:
        """One row per patch: class probabilities, or valence and arousal on 1-9."""
        session = self.sessions.get(head)
        if session is None or embeddings.shape[0] == 0:
            return None
        return session.run(None, {session.get_inputs()[0].name: embeddings.astype(np.float32)})[0]
