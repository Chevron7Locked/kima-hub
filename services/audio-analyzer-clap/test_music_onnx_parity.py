"""
The music CLAP ONNX export (music_audio.onnx, music_text.onnx, music_clap_mel.py) gives the same
vectors as the original checkpoint run through laion_clap and torch: cosine >= 0.9999 for every
clip under both window recipes (1.10's one random 10 s of the middle minute, 1.11's five 10 s
windows) and for every prompt.

Skips when the checkpoint, torch or laion_clap is missing; fails when the checkpoint is there
but is not the music one, or the ONNX files are missing.
  MUSIC_CLAP_CKPT       the .pt (default cache/music_ckpt/music_audioset_epoch_15_esc_90.14.pt)
  MUSIC_CLAP_ONNX_DIR   music_audio.onnx and music_text.onnx (default cache/music_onnx)
  MUSIC_PARITY_CLIPS    more audio files or folders, separated by ':' (default: test_fixtures)
music_onnx_parity.py runs the same comparison on 50+ real songs and reports the table.
"""
import hashlib
import importlib.util
import os
import subprocess
import sys
import unittest

import numpy as np

SVC = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SVC)

import music_onnx_parity as mp  # noqa: E402

CKPT = os.getenv('MUSIC_CLAP_CKPT', os.path.join(
    SVC, 'cache', 'music_ckpt', 'music_audioset_epoch_15_esc_90.14.pt'))
ONNX_DIR = os.getenv('MUSIC_CLAP_ONNX_DIR', os.path.join(SVC, 'cache', 'music_onnx'))
CKPT_SHA256 = 'fae3e9c087f2909c28a09dc31c8dfcdacbc42ba44c70e972b58c1bd1caf6dedd'
PARITY_MIN = 0.9999
AUDIO_EXT = ('.wav', '.mp3', '.flac', '.ogg', '.opus', '.m4a')


def _clips():
    paths = [os.path.join(SVC, 'test_fixtures', f)
             for f in sorted(os.listdir(os.path.join(SVC, 'test_fixtures')))
             if f.endswith('.wav')]
    for entry in filter(None, os.getenv('MUSIC_PARITY_CLIPS', '').split(':')):
        if os.path.isdir(entry):
            paths += [os.path.join(entry, f) for f in sorted(os.listdir(entry))
                      if f.lower().endswith(AUDIO_EXT)]
        else:
            paths.append(entry)
    return paths


def _missing_reference():
    if not os.path.exists(CKPT):
        return f'music checkpoint not present at {CKPT}'
    for mod in ('torch', 'laion_clap'):
        if importlib.util.find_spec(mod) is None:
            return f'{mod} not installed (use a venv with requirements-torch.txt)'
    return None


def _sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 22), b''):
            h.update(chunk)
    return h.hexdigest()


@unittest.skipIf(_missing_reference(), _missing_reference())
class TestMusicOnnxParity(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        import librosa
        import torch
        import laion_clap
        from music_clap_onnx import MusicClapAudio, MusicClapText

        digest = _sha256(CKPT)
        if digest != CKPT_SHA256:
            raise AssertionError(f'{CKPT} is not the music checkpoint (sha256 {digest})')
        for name in ('music_audio.onnx', 'music_text.onnx'):
            if not os.path.exists(os.path.join(ONNX_DIR, name)):
                raise AssertionError(f'{name} missing from {ONNX_DIR}; run export_music_onnx.py')

        cls.torch = torch
        model = laion_clap.CLAP_Module(enable_fusion=False, amodel='HTSAT-base', device='cpu')
        model.load_ckpt(CKPT, verbose=False)  # as v1.10.0 analyzer.py:111-115
        cls.ref = model.eval()
        cls.audio = MusicClapAudio(os.path.join(ONNX_DIR, 'music_audio.onnx'))
        cls.text = MusicClapText(os.path.join(ONNX_DIR, 'music_text.onnx'))
        cls.librosa = librosa
        cls.offsets = staticmethod(mp.shipped_window_offsets())

    def _ref(self, audio, seed):
        np.random.seed(seed)
        with self.torch.no_grad():
            return self.ref.get_audio_embedding_from_data([audio], use_tensor=False)[0]

    def _pair(self, audio, seed):
        """(reference, candidate) for one clip, cut at the same random start."""
        cand = self.audio.embed_windows([audio], [mp.replay_crop(len(audio), seed)])[0]
        return self._ref(audio, seed), cand

    def _assert_close(self, ref, cand, what):
        c = mp.cos(ref, cand)
        self.assertGreaterEqual(c, PARITY_MIN, f'{what}: cosine {c:.6f}')

    def test_v110_recipe(self):
        """One random 10 s of the middle 60 s (v1.10.0 analyzer.py:151-188, 223-229)."""
        for n, path in enumerate(_clips()):
            duration = self.librosa.get_duration(path=path)
            if duration > mp.V110_SECONDS:
                audio, _ = self.librosa.load(path, sr=mp.SR, mono=True, duration=mp.V110_SECONDS,
                                             offset=(duration - mp.V110_SECONDS) / 2)
            else:
                audio, _ = self.librosa.load(path, sr=mp.SR, mono=True)
            self._assert_close(*self._pair(audio, 1000 + n), f'1.10 {path}')

    def test_v111_recipe(self):
        """Five 10 s windows from analyzer.compute_window_offsets, averaged."""
        for n, path in enumerate(_clips()):
            duration = self.librosa.get_duration(path=path)
            refs, cands = [], []
            for k, start in enumerate(self.offsets(duration)):
                start = max(0.0, min(start, max(0.0, duration - 1e-3)))
                take = min(10, max(0.0, duration - start))
                w, _ = self.librosa.load(path, sr=mp.SR, mono=True, offset=start,
                                         duration=(take if take > 0 else None))
                r, c = self._pair(w, 2000 + 10 * n + k)
                refs.append(mp.unit(r))
                cands.append(c)
            self._assert_close(mp.unit(np.mean(refs, 0)), mp.unit(np.mean(cands, 0)),
                               f'1.11 {path}')

    def test_short_and_off_by_one_clips(self):
        """A clip under 10 s is tiled and zero-padded; one sample over 10 s is cut at random."""
        audio, _ = self.librosa.load(_clips()[0], sr=mp.SR, mono=True)
        for length, seed in ((3 * mp.SR + 17, 1), (mp.WIN + 1, 2), (mp.WIN + 1, 3), (mp.WIN, 4)):
            self._assert_close(*self._pair(audio[:length], seed), f'{length} samples')

    def test_batch_matches_one_at_a_time(self):
        """A batch of windows gives each window's own vector (the analyzer embeds a track's
        windows in one call)."""
        audio, _ = self.librosa.load(_clips()[0], sr=mp.SR, mono=True)
        windows = [audio[k * mp.WIN:(k + 1) * mp.WIN] for k in range(len(audio) // mp.WIN)][:5]
        self.assertGreaterEqual(len(windows), 2)
        batch = self.audio.embed_windows(windows)
        for k, w in enumerate(windows):
            self._assert_close(self.audio.embed_windows([w])[0], batch[k], f'batch row {k}')

    def test_text(self):
        prompts = mp.all_prompts()
        self.assertGreaterEqual(len(prompts), 50)
        with self.torch.no_grad():
            ref = self.ref.get_text_embedding(prompts, use_tensor=False)
        cand = self.text.embed_text(prompts)
        for p, r, c in zip(prompts, ref, cand):
            self._assert_close(r, c, f'text {p[:40]!r}')
        # A prompt's vector does not depend on the others in its batch.
        np.testing.assert_allclose(self.text.embed_text([prompts[0]])[0], cand[0], atol=1e-5)


class TestCandidateIsTorchFree(unittest.TestCase):

    def test_no_torch_import(self):
        code = ('import sys; sys.path.insert(0, %r); import music_clap_onnx, music_clap_mel; '
                'assert "torch" not in sys.modules, "torch imported"' % SVC)
        subprocess.run([sys.executable, '-I', '-c', code], check=True)


if __name__ == '__main__':
    unittest.main()
