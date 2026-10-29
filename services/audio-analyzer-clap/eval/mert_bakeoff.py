"""Bake off a HF music encoder against the shipped model on the human sets.

The windowing recipe is imported from the shipped analyzer, so both models
hear the same five 10-second windows of every clip. Scores come from
vibe_eval.score_set; the triplet comparison against v1 is paired (exact
McNemar), reading v1's vectors from the eval cache so nothing is re-embedded.

    uv run --no-project --python 3.12 --with torch --with transformers \\
       --with librosa --with soundfile --with scipy --with numpy \\
       python mert_bakeoff.py --model m-a-p/MERT-v1-95M
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.dirname(HERE))  # the shipped analyzer module

import datasets as D  # noqa: E402
import metrics as M  # noqa: E402
import vibe_eval as V  # noqa: E402

SR = 24000


def _cache_paths(model_slug: str, set_name: str) -> str:
    return os.path.join(HERE, '.cache', 'emb', model_slug, f'{set_name}.npz')


_MODEL = None
_BACKEND = 'hf'
_SR = SR


def _init_worker(model_id: str, backend: str) -> None:
    # Module-level so the pool can pickle it by reference (nested functions
    # cannot be pickled, not even with the fork start method).
    os.environ['TOKENIZERS_PARALLELISM'] = 'false'
    global _MODEL, _BACKEND, _SR
    _BACKEND = backend
    if backend == 'onnx-v1':
        # The shipped tower itself, through the shipped ONNX backend.
        from onnx_backend import OnnxCLAPBackend
        from music_clap_mel import SAMPLE_RATE as CLAP_SAMPLE_RATE
        _MODEL = OnnxCLAPBackend()
        _MODEL.load_model()
        _SR = CLAP_SAMPLE_RATE
    elif backend == 'muq':
        # The checkpoint ships a fairseq-style config transformers won't map;
        # the official package carries the architecture itself.
        import torch
        torch.set_num_threads(2)
        from muq import MuQ
        _MODEL = MuQ.from_pretrained(model_id)
        _MODEL.eval()
    elif backend == 'clap-onnx':
        # The larger sibling of the shipped model: its ONNX audio tower and
        # its own ClapFeatureExtractor frontend (48 kHz), same deal the
        # shipped analyzer gives the v1 weights.
        import onnxruntime as ort
        from huggingface_hub import hf_hub_download
        from transformers import ClapFeatureExtractor
        _MODEL = (ort.InferenceSession(hf_hub_download(model_id, 'onnx/audio_model.onnx'),
                                       providers=['CPUExecutionProvider']),
                  ClapFeatureExtractor.from_pretrained(model_id))
        _SR = _MODEL[1].sampling_rate
    else:
        import torch
        torch.set_num_threads(2)
        from transformers import AutoModel
        # MERT ships its modeling code in the repo; eval-only, never in the image.
        _MODEL = AutoModel.from_pretrained(model_id, trust_remote_code=True)
        _MODEL.eval()


def _embed_one(item):
    import librosa
    import analyzer
    key, path = item
    try:
        y, sr = librosa.load(path, sr=_SR, mono=True)
        dur = len(y) / sr
        offs = analyzer.compute_window_offsets(dur)
        vecs = []
        for off in offs:
            seg = y[int(off * _SR):int(off * _SR) + 10 * _SR]
            vecs.append(_embed_window(seg))
        v = np.mean(vecs, axis=0).astype(np.float32)
        v /= np.linalg.norm(v) + 1e-12
        w = np.stack(vecs).astype(np.float32)
        # Short tracks tile to 5 windows so the cache array stays rectangular,
        # matching precompute_mels' padding.
        while len(w) < 5:
            w = np.concatenate([w, w[:1]])
        w = w[:5] / (np.linalg.norm(w, axis=1, keepdims=True) + 1e-12)
        return key, v, w, ''
    except Exception as e:
        return key, None, None, f'{type(e).__name__}: {e}'[:200]


def _embed_window(seg):
    if _BACKEND == 'onnx-v1':
        return _MODEL.embed_audio(seg)
    if _BACKEND == 'clap-onnx':
        sess, fe = _MODEL
        mel = fe(raw_speech=seg, sampling_rate=_SR, return_tensors='np')['input_features']
        return sess.run(None, {sess.get_inputs()[0].name: mel.astype('float32')})[0][0]
    import torch
    with torch.no_grad():
        x = torch.from_numpy(seg).unsqueeze(0)
        for kw in ('input_values', 'wavs', 'x'):
            try:
                out = _MODEL(**{kw: x})
                break
            except TypeError:
                continue
    hs = out.last_hidden_state
    if hs is None:
        hs = out.hidden_states[-1]
    return hs.mean(dim=1)[0].numpy()


def _embed_all(model_id: str, sets: dict, workers: int, retry_failed: bool, backend: str) -> dict:
    from concurrent.futures import ProcessPoolExecutor

    slug = f'{backend}-{model_id.replace("/", "-")}'
    out = {}
    for name, es in sets.items():
        cp = _cache_paths(slug, name)
        embs, wins, fails = ({}, {}, {})
        if os.path.exists(cp):
            z = np.load(cp)
            embs = {str(k): v for k, v in zip(z['ids'], z['emb'])}
            if 'win' in z:
                wins = {str(k): w for k, w in zip(z['ids'], z['win'])}
            fails = {str(k): str(r) for k, r in zip(z['fail_ids'], z['fail_reasons'])}
        todo = [(i, p) for i, p in zip(es.ids, es.paths)
                if i not in embs and (retry_failed or i not in fails)]
        print(f'[{name}] {len(embs)} cached, {len(todo)} to embed', flush=True)
        if todo:
            done = 0
            # default (spawn) context: forking a parent that has imported torch
            # is unsafe on macOS; the workers are module-level so spawn pickles fine
            with ProcessPoolExecutor(max_workers=workers, initializer=_init_worker,
                                     initargs=(model_id, backend)) as ex:
                for key, v, w, err in ex.map(_embed_one, todo, chunksize=8):
                    if v is None:
                        fails[key] = err
                    else:
                        embs[key], wins[key] = v, w
                    done += 1
                    if done % 200 == 0:
                        print(f'[{name}] {done}/{len(todo)}', flush=True)
            keys = sorted(embs)
            os.makedirs(os.path.dirname(cp), exist_ok=True)
            save = dict(ids=np.array(keys), emb=np.stack([embs[k] for k in keys]),
                        fail_ids=np.array(sorted(fails)),
                        fail_reasons=np.array([fails[k] for k in sorted(fails)]))
            if len(wins) == len(embs):
                save['win'] = np.stack([wins[k] for k in keys])
            np.savez_compressed(cp, **save)
        out[name] = embs
    return out


def v1_cache_embeddings(set_name: str) -> dict:
    # The cache key hashes the analyzer source, so a comment edit would change it. Take the
    # scored v1 cache by directory name instead of recomputing the hash.
    import glob
    import embedders as EM
    dirs = sorted(glob.glob(os.path.join(HERE, '.cache', 'emb', 'v1-model*')), reverse=True)
    for d in dirs:
        p = os.path.join(d, f'{set_name}.npz')
        if os.path.exists(p):
            embs, _ = EM._load_cache(p)
            return embs
    raise FileNotFoundError(f'no scored v1 cache for {set_name}')


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--model', default='m-a-p/MERT-v1-95M')
    ap.add_argument('--backend', default='hf', choices=['hf', 'clap-onnx', 'muq', 'onnx-v1'])
    ap.add_argument('--data', default=os.environ.get('KIMA_EVAL_DATA', './kima-eval-data'))
    ap.add_argument('--sets', nargs='+', default=['mtt_triplets', 'soundtracks_set1',
                                                  'isovat', 'deam', 'memo2496'])
    ap.add_argument('--workers', type=int, default=6)
    ap.add_argument('--retry-failed', action='store_true')
    ap.add_argument('--limit', type=int, default=0, help='smoke: first N clips per set')
    ap.add_argument('--out', default=None)
    args = ap.parse_args()

    sets = {n: D.LOADERS[n](args.data) for n in args.sets}
    if args.limit:
        for es in sets.values():
            keep = set(es.ids[:args.limit])
            es.paths = es.paths[:args.limit]
            es.ids = es.ids[:args.limit]
            es.ratings = {k: np.asarray(v)[:args.limit] for k, v in es.ratings.items()}
            if es.groups is not None:
                es.groups = es.groups[:args.limit]
            es.meta = {k: list(v)[:args.limit] for k, v in es.meta.items()}
            es.triplets = [t for t in es.triplets if all(c in keep for c in t)][:args.limit]
    for n, es in sets.items():
        print(f'[set] {n}: {len(es.ids)} clips' + (f', {len(es.triplets)} triplets' if es.triplets else ''))

    new = _embed_all(args.model, sets, args.workers, args.retry_failed, args.backend)

    report = {'generated': dt.datetime.now().isoformat(timespec='seconds'),
              'model': args.model, 'sets': {}, 'head_to_head_triplets': {}}
    for name, es in sets.items():
        r = V.score_set(es, new[name])
        r['failed_clips'] = len(set(es.ids) - set(new[name]))
        report['sets'][name] = {k: v for k, v in r.items() if not k.startswith('_')}
        if es.triplets:
            hits_new = M.triplet_hits(new[name], es.triplets)
            keys = es.triplets
            v1 = v1_cache_embeddings(name)
            hits_v1 = M.triplet_hits(v1, keys)
            report['head_to_head_triplets'][name] = {
                'new': M.triplet_score(hits_new), 'v1': M.triplet_score(hits_v1),
                'new_minus_v1': M.paired_difference(hits_new, hits_v1)}

    out = args.out or os.path.join(HERE, '.cache',
                                   f"mert-{args.model.replace('/', '-')}-{dt.datetime.now():%Y%m%d-%H%M%S}.json")
    with open(out, 'w') as f:
        json.dump(report, f, indent=2)
    print(json.dumps({k: v for k, v in report.items() if k != 'sets'}, indent=2))
    for name, r in report['sets'].items():
        line = [name]
        for dim in ('valence', 'arousal', 'energy', 'tension'):
            if dim in r:
                line.append(f"{dim} knn {r[dim]['knn10_neighbour_agreement']['r']:.3f}")
        print(' | '.join(line), flush=True)
    print(f'full results: {out}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
