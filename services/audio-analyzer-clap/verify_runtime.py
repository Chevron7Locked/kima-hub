#!/usr/bin/env python
"""Verifies the CLAP ONNX stack offline (HF_HUB_OFFLINE=1): the fixtures must embed at
cosine >= 0.999 to expected_music_embeddings.npy (laion_clap with torch on the music
checkpoint; music_onnx_parity.py fixture) with no torch fallback, the clips embedded together
in one call (as tracks are) must match each clip embedded alone, and two text prompts must
embed distinguishably.
Usage: python3 verify_runtime.py <fixtures_dir>; exit 0 = pass.
"""
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from onnx_backend import OnnxCLAPBackend, OnnxTextCLAPBackend  # noqa: E402

import librosa  # noqa: E402

MIN_COS = 0.999
BATCH_MIN_COS = 0.99999


def main() -> int:
    fixtures = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, 'test_fixtures')
    expected = np.load(os.path.join(fixtures, 'expected_music_embeddings.npy'))
    names = ['sine440.wav', 'white.wav', 'sine880.wav']

    audio_backend = OnnxCLAPBackend()
    audio_backend.load_model()
    ok = True
    singles = []
    for i, name in enumerate(names):
        wav = os.path.join(fixtures, name)
        if not os.path.exists(wav):
            print(f'FAIL: fixture missing: {wav}')
            return 1
        sig, _sr = librosa.load(wav, sr=48000, mono=True)
        emb = audio_backend.embed_audio(sig)
        singles.append((sig, emb))
        cos = float(np.dot(emb, expected[i]) /
                    (np.linalg.norm(emb) * np.linalg.norm(expected[i]) + 1e-12))
        status = 'PASS' if cos >= MIN_COS else 'FAIL'
        print(f'[{status}] audio {name}: cosine={cos:.6f} (min {MIN_COS})')
        ok &= cos >= MIN_COS
    together = audio_backend.embed_clips([sig for sig, _emb in singles])
    worst = min(float(np.dot(together[i], emb)) for i, (_sig, emb) in enumerate(singles))
    status = 'PASS' if worst >= BATCH_MIN_COS else 'FAIL'
    print(f'[{status}] {len(singles)} clips in one call vs one at a time: lowest cosine={worst:.8f} (min {BATCH_MIN_COS})')
    ok &= worst >= BATCH_MIN_COS

    text_backend = OnnxTextCLAPBackend()
    text_backend.load_model()
    embs = text_backend.embed_text(['sound of rain on a roof', 'heavy distorted electric guitar'])
    if embs.shape != (2, 512):
        print(f'FAIL: text embeddings shape {embs.shape} != (2, 512)')
        ok = False
    else:
        norms = np.linalg.norm(embs, axis=1)
        cos_tt = float(np.dot(embs[0], embs[1]))
        if not np.all(np.abs(norms - 1.0) < 1e-3):
            print(f'FAIL: text norms {norms} not unit')
            ok = False
        elif cos_tt > 0.999:
            print(f'FAIL: text prompts indistinguishable (cos={cos_tt:.6f})')
            ok = False
        else:
            print(f'[PASS] text backend: shape (2,512), unit norms, cos(rain,guitar)={cos_tt:.4f}')

    print('VERIFY-RUNTIME:', 'PASS' if ok else 'FAIL')
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
