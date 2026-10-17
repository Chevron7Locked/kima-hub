"""
ONNX backend for the CLAP analyzer, so it runs without PyTorch. The model is LAION-CLAP's music checkpoint
(music_audioset_epoch_15_esc_90.14.pt), exported by export_music_onnx.py. Audio: 48 kHz mono, 10 s windows,
music_clap_mel's front end (laion_clap's int16 round trip, then its log-mel) as [n, 1, 1001, 64] into
music_audio.onnx, 512-d and L2-normalised. Text: music_text.onnx. Both equal laion_clap with torch
(test_music_onnx_parity.py).
"""
import os
import logging
import queue
import threading
from typing import Optional
import numpy as np

logger = logging.getLogger('clap-analyzer')

CLAP_SAMPLE_RATE = 48000
EPS = 1e-12

# The validated export the images copy next to the analyzer; CLAP_ONNX_MODEL_PATH overrides it.
ONNX_MODEL_PATH = os.getenv(
    'CLAP_ONNX_MODEL_PATH',
    os.path.join(os.path.dirname(os.path.abspath(__file__)), 'models', 'music_audio.onnx'),
)

def plan_providers(gpu_wanted: bool, available) -> list:
    """CUDA is requested only when the switch and the install both say so and this onnxruntime
    offers it. Every other path is exactly ['CPUExecutionProvider'], so nobody who leaves the
    switch off pays anything."""
    if gpu_wanted and 'CUDAExecutionProvider' in available:
        return ['CUDAExecutionProvider', 'CPUExecutionProvider']
    return ['CPUExecutionProvider']


class OneThread:
    """Runs every call on one thread. ONNX Runtime gives each thread that calls a GPU session its
    own GPU workspace: 16 analyzer threads calling the sound model held 2.4 GB of an 8 GB card;
    one thread making the calls holds one. A call that gets no answer in CALL_TIMEOUT_S raises, so a
    hung GPU fails tracks instead of stopping the analyzer."""

    CALL_TIMEOUT_S = 120

    def __init__(self, name: str):
        self._requests: queue.Queue = queue.Queue()
        threading.Thread(target=self._loop, name=name, daemon=True).start()

    def _loop(self) -> None:
        while True:
            fn, args, reply, done = self._requests.get()
            try:
                reply['value'] = fn(*args)
            except BaseException as e:
                reply['error'] = e
            done.set()

    def call(self, fn, *args):
        reply: dict = {}
        done = threading.Event()
        self._requests.put((fn, args, reply, done))
        if not done.wait(self.CALL_TIMEOUT_S):
            raise TimeoutError(f'the GPU thread gave no answer in {self.CALL_TIMEOUT_S} s')
        if 'error' in reply:
            raise reply['error']
        return reply['value']


_gpu_thread: Optional[OneThread] = None
_gpu_thread_lock = threading.Lock()


def gpu_thread() -> OneThread:
    """The process's one GPU-calling thread, made on first use and kept when the model is
    unloaded and loaded again."""
    global _gpu_thread
    with _gpu_thread_lock:
        if _gpu_thread is None:
            _gpu_thread = OneThread('clap-gpu')
        return _gpu_thread


class OnnxCLAPBackend:
    """Thin wrapper over onnxruntime's clap audio encoder."""

    def __init__(self, model_path: str = ONNX_MODEL_PATH):
        self.model_path = model_path
        self._sess = None
        self._run = None
        self._fe = None

    def load_model(self) -> None:
        if self._sess is not None:
            return
        import onnxruntime as ort
        import gpu_runtime
        providers = plan_providers(gpu_runtime.request_gpu(),
                                   ort.get_available_providers())
        want_cuda = providers[0] == 'CUDAExecutionProvider'
        self._sess = ort.InferenceSession(self.model_path, providers=providers)
        if want_cuda:
            active = self._sess.get_providers()
            if active and active[0] == 'CUDAExecutionProvider':
                gpu_runtime.record_provider(True)
                logger.info(f'ONNX CLAP audio session active on CUDA '
                            f'(providers={active})')
            else:
                gpu_runtime.record_provider(False, f'session providers: {active}')
                logger.warning(
                    f'gpu-onnx: CUDA requested but session did not go active '
                    f'(providers={active}) — embeddings still correct, CPU speed')
        self._in_name = self._sess.get_inputs()[0].name
        self._out_name = self._sess.get_outputs()[0].name
        on_gpu = self._sess.get_providers()[0] == 'CUDAExecutionProvider'
        self._run = (lambda gpu: lambda feeds: gpu.call(self._sess.run, [self._out_name], feeds))(
            gpu_thread()) if on_gpu else (lambda feeds: self._sess.run([self._out_name], feeds))
        from music_clap_mel import MusicClapMel
        self._fe = MusicClapMel()
        logger.info(f'ONNX CLAP backend loaded from {self.model_path} '
                    f'(torch-free front end via music_clap_mel)')

    def _prepare_input(self, audio: np.ndarray) -> np.ndarray:
        """The model's whole input, [1, 1, 1001, 64]: laion_clap's int16 round trip and log-mel of the
        clip, tiled to 10 s when shorter. A clip over 10 s (a 44.1 kHz source resampled can run a sample
        over) is cut at its start, where laion_clap would cut at random."""
        return self._fe(audio, 0)[np.newaxis, np.newaxis, ...].astype(np.float32)

    def embed_clips(self, clips: list) -> np.ndarray:
        """``(len(clips), 512)`` L2-normalised embeddings of 48 kHz mono clips in one
        model call: on the GPU one batch costs about what one clip does. The
        spectrograms are built first, on the calling thread; on the GPU the call
        itself is made by the one GPU thread."""
        self.load_model()
        batch = np.concatenate([self._prepare_input(clip) for clip in clips], axis=0)
        out = self._run({self._in_name: batch})[0]
        return (out / (np.linalg.norm(out, axis=1, keepdims=True) + EPS)).astype(np.float32)

    def embed_audio(self, audio: np.ndarray) -> np.ndarray:
        """512-d L2-normalised embedding of a 48 kHz mono clip."""
        return self.embed_clips([audio])[0]


# The music checkpoint's text tower (music_text.onnx) sits in models/; CLAP_ONNX_TEXT_MODEL_PATH points at a
# copy elsewhere.
def _default_text_model_path() -> str:
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(here, 'models', 'music_text.onnx')


ONNX_TEXT_MODEL_PATH = os.getenv(
    'CLAP_ONNX_TEXT_MODEL_PATH',
    _default_text_model_path(),
)


class OnnxTextCLAPBackend:
    """Text encoder on music_text.onnx through music_clap_onnx.MusicClapText: laion_clap's tokenizer
    (RobertaTokenizer 'roberta-base', every prompt padded to 77 tokens) with its attention mask, so a
    prompt's vector does not depend on the others in its batch."""

    def __init__(self, model_path: str = ONNX_TEXT_MODEL_PATH):
        self.model_path = model_path
        self._model = None

    def load_model(self) -> None:
        if self._model is not None:
            return
        from music_clap_onnx import MusicClapText
        self._model = MusicClapText(self.model_path)
        logger.info(f'ONNX text backend loaded from {self.model_path}')

    def embed_text(self, texts: list[str]) -> np.ndarray:
        """[n, 512] L2-normalised text embeddings."""
        self.load_model()
        return self._model.embed_text(texts)
