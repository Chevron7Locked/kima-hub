"""
Embedders under test, cached on disk. `v1` imports the shipped analyzer (ONNX,
five 10 s windows, mean, L2); `engine` is vibe_engine's Ear. The cache key
hashes the model and recipe source, so a change starts a fresh cache.
"""
from __future__ import annotations

import hashlib
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from typing import Callable, Optional

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE_DIR = os.path.dirname(HERE)
DEFAULT_ENGINE_DIR = os.path.expanduser('~/projects/kima/kima-hub/services/vibe-engine')


def _sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


class EmbedderSpec:
    """Picklable description of an embedder (sent to worker processes)."""

    def __init__(self, kind: str, model_path: str, engine_dir: str = DEFAULT_ENGINE_DIR):
        if kind not in ('v1', 'engine'):
            raise ValueError(f'unknown embedder {kind!r}')
        self.kind = kind
        self.model_path = os.path.abspath(model_path)
        self.engine_dir = os.path.abspath(engine_dir)
        if not os.path.isfile(self.model_path):
            raise FileNotFoundError(self.model_path)
        if kind == 'v1':
            self.recipe_files = [os.path.join(SERVICE_DIR, f)
                                 for f in ('analyzer.py', 'onnx_backend.py', 'music_clap_mel.py')]
        else:
            self.recipe_files = [os.path.join(self.engine_dir, 'vibe_engine', 'ear', '__init__.py')]
        self.model_sha256 = _sha256(self.model_path)
        rh = hashlib.sha256()
        for f in self.recipe_files:
            rh.update(_sha256(f).encode())
        self.recipe_sha256 = rh.hexdigest()

    @property
    def cache_id(self) -> str:
        return f'{self.kind}-model{self.model_sha256[:12]}-recipe{self.recipe_sha256[:12]}'

    def describe(self) -> dict:
        return {'kind': self.kind, 'model_path': self.model_path,
                'model_sha256': self.model_sha256,
                'recipe_files': self.recipe_files, 'recipe_sha256': self.recipe_sha256}


def default_spec(kind: str, engine_dir: str = DEFAULT_ENGINE_DIR) -> EmbedderSpec:
    if kind == 'v1':
        model = os.getenv('CLAP_ONNX_MODEL_PATH', os.path.join(SERVICE_DIR, 'models', 'hf_audio.onnx'))
    else:
        model = os.path.join(engine_dir, 'models', 'clap_audio_fp32.onnx')
    return EmbedderSpec(kind, model, engine_dir)


# ---- worker side ---------------------------------------------------------
_embed_fn: Optional[Callable[[str], Optional[np.ndarray]]] = None


def _init_worker(spec: EmbedderSpec, threads: int) -> None:
    global _embed_fn
    for v in ('OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS',
              'NUMEXPR_MAX_THREADS', 'VECLIB_MAXIMUM_THREADS'):
        os.environ[v] = str(threads)
    if spec.kind == 'v1':
        os.environ['THREADS_PER_WORKER'] = str(threads)
        os.environ['CLAP_ONNX_MODEL_PATH'] = spec.model_path
        sys.path.insert(0, SERVICE_DIR)
        import logging
        import analyzer  # the shipped module, not a copy
        logging.getLogger('clap-analyzer').setLevel(logging.WARNING)
        a = analyzer.CLAPAnalyzer()

        _embed_fn = a.get_audio_embedding
    else:
        os.environ['VIBE_ENGINE_CLAP_MODEL_PATH'] = spec.model_path
        sys.path.insert(0, spec.engine_dir)
        # vibe_engine's settings read a .env from the working directory; import
        # from a neutral directory so no unrelated .env is picked up.
        cwd = os.getcwd()
        os.chdir(HERE)
        try:
            from vibe_engine.ear import Ear
        finally:
            os.chdir(cwd)
        ear = Ear()
        _embed_fn = lambda path: np.asarray(ear.embed(path), dtype=np.float32)  # noqa: E731


def _embed_one(item: tuple[str, str]) -> tuple[str, Optional[np.ndarray], str]:
    key, path = item
    try:
        v = _embed_fn(path)  # type: ignore[misc]
        if v is None:
            return key, None, 'embedder returned None'
        v = np.asarray(v, dtype=np.float32)
        if v.shape != (512,) or not np.all(np.isfinite(v)):
            return key, None, f'bad vector shape={v.shape}'
        return key, v, ''
    except Exception as e:  # recorded and reported, never dropped silently
        return key, None, f'{type(e).__name__}: {e}'[:300]


# ---- cache ---------------------------------------------------------------
def _cache_path(cache_dir: str, spec: EmbedderSpec, set_name: str) -> str:
    return os.path.join(cache_dir, 'emb', spec.cache_id, f'{set_name}.npz')


def _load_cache(path: str) -> tuple[dict[str, np.ndarray], dict[str, str]]:
    if not os.path.exists(path):
        return {}, {}
    z = np.load(path, allow_pickle=False)
    embs = {str(k): e for k, e in zip(z['ids'], z['emb'])}
    fails = {str(k): str(r) for k, r in zip(z['fail_ids'], z['fail_reasons'])}
    return embs, fails


def _save_cache(path: str, embs: dict[str, np.ndarray], fails: dict[str, str]) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    keys = sorted(embs)
    tmp = path + '.writing.npz'
    np.savez(tmp,
             ids=np.array(keys, dtype=str),
             emb=(np.vstack([embs[k] for k in keys]) if keys else np.zeros((0, 512))).astype(np.float32),
             fail_ids=np.array(sorted(fails), dtype=str),
             fail_reasons=np.array([fails[k] for k in sorted(fails)], dtype=str))
    os.replace(tmp, path)  # atomic: a crash never leaves a half-written cache


def embed_set(spec: EmbedderSpec, set_name: str, ids: list[str], paths: list[str],
              cache_dir: str, workers: int, threads: int,
              retry_failed: bool = False) -> tuple[dict[str, np.ndarray], dict[str, str]]:
    """Embed every (id, path) not already cached. Returns (embeddings, failures)."""
    cpath = _cache_path(cache_dir, spec, set_name)
    embs, fails = _load_cache(cpath)
    if retry_failed:
        fails = {}
    todo = [(k, p) for k, p in zip(ids, paths) if k not in embs and k not in fails]
    if not todo:
        return embs, fails
    print(f'  [{spec.kind}:{set_name}] embedding {len(todo)} clips '
          f'({len(embs)} cached) with {workers} worker(s)', flush=True)
    t0 = time.time()
    done = 0
    with ProcessPoolExecutor(max_workers=workers, initializer=_init_worker,
                             initargs=(spec, threads)) as ex:
        for key, vec, err in ex.map(_embed_one, todo, chunksize=2):
            done += 1
            if vec is not None:
                embs[key] = vec
            else:
                fails[key] = err
            if done % 100 == 0 or done == len(todo):
                _save_cache(cpath, embs, fails)
                el = time.time() - t0
                print(f'    {done}/{len(todo)} ok={len(embs)} failed={len(fails)} '
                      f'{el / 60:.1f} min, ~{(len(todo) - done) * el / done / 60:.1f} min left', flush=True)
    _save_cache(cpath, embs, fails)
    return embs, fails
