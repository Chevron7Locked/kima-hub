"""
The music CLAP checkpoint on ONNX Runtime, without PyTorch: 10 s windows through
music_clap_mel's front end and music_audio.onnx, and prompts through music_text.onnx.
Built by export_music_onnx.py; matched against laion_clap by test_music_onnx_parity.py.
Not wired into the analyzer.
"""
from typing import Optional, Sequence

import numpy as np

from music_clap_mel import MusicClapMel

TEXT_MAX_LENGTH = 77  # laion_clap hook.py:64-72 pads every prompt to 77 tokens


def _session(path: str, threads: Optional[int]):
    import onnxruntime as ort
    opts = ort.SessionOptions()
    if threads:
        opts.intra_op_num_threads = threads
        opts.inter_op_num_threads = 1
    return ort.InferenceSession(path, sess_options=opts, providers=['CPUExecutionProvider'])


class MusicClapAudio:
    """512-d L2-normalised vectors for 48 kHz mono windows."""

    def __init__(self, model_path: str, threads: Optional[int] = None):
        self.sess = _session(model_path, threads)
        self.mel = MusicClapMel()

    def embed_windows(self, windows: Sequence[np.ndarray],
                      crop_starts: Optional[Sequence[Optional[int]]] = None) -> np.ndarray:
        """One vector per window. A window over 480000 samples is cut at its crop start
        (laion_clap picks that at random; see music_clap_mel.fit_window)."""
        starts = crop_starts if crop_starts is not None else [None] * len(windows)
        mels = np.stack([self.mel(w, s) for w, s in zip(windows, starts)])[:, None]
        out = self.sess.run(['embedding'], {'mel': mels})[0]
        return (out / np.maximum(np.linalg.norm(out, axis=1, keepdims=True), 1e-12)).astype(
            np.float32)


class MusicClapText:
    """512-d L2-normalised vectors for prompts, tokenised the way laion_clap does."""

    def __init__(self, model_path: str, tokenizer=None, threads: Optional[int] = None):
        self.sess = _session(model_path, threads)
        if tokenizer is None:
            from transformers import RobertaTokenizer
            tokenizer = RobertaTokenizer.from_pretrained('roberta-base')
        self.tok = tokenizer

    def tokens(self, texts: Sequence[str]) -> dict:
        enc = self.tok(list(texts), padding='max_length', truncation=True,
                       max_length=TEXT_MAX_LENGTH, return_tensors='np')
        return {'input_ids': enc['input_ids'].astype(np.int64),
                'attention_mask': enc['attention_mask'].astype(np.int64)}

    def embed_text(self, texts: Sequence[str]) -> np.ndarray:
        out = self.sess.run(['embedding'], self.tokens(texts))[0]
        return (out / np.maximum(np.linalg.norm(out, axis=1, keepdims=True), 1e-12)).astype(
            np.float32)
