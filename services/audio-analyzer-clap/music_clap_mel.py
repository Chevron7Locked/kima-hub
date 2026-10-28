"""
The music CLAP checkpoint's audio front end (music_audioset_epoch_15_esc_90.14.pt) in numpy, no
PyTorch. It turns a 48 kHz mono clip into the [1001, 64] log-mel the ONNX audio tower takes.

Every step copies laion_clap 1.1.7 / torchlibrosa 0.1.0, which v1.10.0 ran:
  1. int16 round trip: laion_clap/hook.py:177 calls training/data.py:93-99
     (clip to [-1, 1], * 32767, cast to int16, / 32767).
  2. 10 s fit, non-fusion: training/data.py:416-501. Longer clips are cut to 480000 samples at a
     start drawn by np.random.randint(0, overflow + 1) (data.py:466-468, 'rand_trunc'); shorter
     ones are tiled whole int(480000 / n) times, then zero-padded (data.py:472-482, 'repeatpad').
  3. STFT: torchlibrosa/stft.py:155-245 via htsat.py:668-681. Periodic hann of 1024, reflect pad
     of 512 each side (center=True), hop 480, a 1024-point DFT, power 2 (stft.py:661). 1001 frames.
  4. Mel: stft.py:686-707, librosa.filters.mel(sr=48000, n_fft=1024, n_mels=64, fmin=50,
     fmax=14000), librosa's defaults (Slaney scale, Slaney area norm). Settings from
     clap_module/model_configs/HTSAT-base.json.
  5. dB: stft.py:719-731 with htsat.py:671-673: 10 * log10(max(x, 1e-10)), ref 1.0, no top_db.
The checkpoint stores steps 3 and 4 as weights; they equal what this file computes to 2.1e-7
(DFT) and 2.8e-9 (mel). bn0 and everything after it are inside the ONNX graph.
"""
from typing import Optional

import numpy as np

SAMPLE_RATE = 48000
WINDOW_SAMPLES = 480000
N_FFT = 1024
HOP = 480
N_MELS = 64
FMIN = 50
FMAX = 14000
AMIN = 1e-10


def quantize(audio: np.ndarray) -> np.ndarray:
    """laion_clap's int16 round trip (training/data.py:93-99)."""
    x = np.clip(audio, a_min=-1.0, a_max=1.0)
    return ((x * 32767.0).astype(np.int16) / 32767.0).astype(np.float32)


def fit_window(audio: np.ndarray, crop_start: Optional[int] = None) -> np.ndarray:
    """Cut or tile a clip to exactly 480000 samples the way laion_clap's non-fusion path does.

    A clip longer than 10 s starts at `crop_start`; laion_clap draws it at random, so pass
    np.random.randint(0, overflow + 1) to reproduce that, or any fixed start to be deterministic.
    """
    n = audio.shape[0]
    if n > WINDOW_SAMPLES:
        start = 0 if crop_start is None else int(crop_start)
        if not 0 <= start <= n - WINDOW_SAMPLES:
            raise ValueError(f'crop_start {start} outside 0..{n - WINDOW_SAMPLES}')
        return audio[start:start + WINDOW_SAMPLES]
    if n < WINDOW_SAMPLES:
        if n == 0:
            raise ValueError('empty clip')
        tiled = np.tile(audio, int(WINDOW_SAMPLES / n))
        return np.pad(tiled, (0, WINDOW_SAMPLES - tiled.shape[0]), mode='constant')
    return audio


class MusicClapMel:
    """Log-mel of a 480000-sample window, [1001, 64] float32."""

    def __init__(self):
        import librosa  # only for the filter bank, the same call torchlibrosa makes
        self.mel_basis = librosa.filters.mel(
            sr=SAMPLE_RATE, n_fft=N_FFT, n_mels=N_MELS, fmin=FMIN, fmax=FMAX).T.astype(np.float64)
        n = np.arange(N_FFT)
        # Periodic hann, the same as librosa get_window('hann', 1024, fftbins=True).
        self.window = 0.5 - 0.5 * np.cos(2.0 * np.pi * n / N_FFT)

    def logmel(self, window: np.ndarray) -> np.ndarray:
        if window.shape[0] != WINDOW_SAMPLES:
            raise ValueError(f'expected {WINDOW_SAMPLES} samples, got {window.shape[0]}')
        padded = np.pad(window.astype(np.float64), (N_FFT // 2, N_FFT // 2), mode='reflect')
        n_frames = 1 + (padded.shape[0] - N_FFT) // HOP
        frames = np.lib.stride_tricks.as_strided(
            padded, shape=(n_frames, N_FFT),
            strides=(padded.strides[0] * HOP, padded.strides[0]))
        spec = np.fft.rfft(frames * self.window, n=N_FFT, axis=1)
        power = spec.real ** 2 + spec.imag ** 2
        mel = power @ self.mel_basis
        return (10.0 * np.log10(np.maximum(mel, AMIN))).astype(np.float32)

    def __call__(self, audio: np.ndarray, crop_start: Optional[int] = None) -> np.ndarray:
        """Quantize, fit to 10 s and take the log-mel: the whole front end for one clip."""
        return self.logmel(fit_window(quantize(audio), crop_start))
