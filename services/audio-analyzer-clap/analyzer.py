#!/usr/bin/env python3
"""
CLAP analyzer: 512-d LAION CLAP embeddings for audio (vibe similarity) and for
text queries. BullMQVibeWorker embeds tracks into pgvector, TextEmbedHandler
answers text queries over Redis pub/sub, ControlHandler applies worker changes.
"""

import os
import signal
import json
import re
import time
import logging
import gc
import asyncio
import secrets
import threading
from typing import Optional, Tuple
import numpy as np
import librosa
import requests

# CPU thread limits, set before the numeric libraries load.
THREADS_PER_WORKER = int(os.getenv('THREADS_PER_WORKER', '1'))
os.environ['OMP_NUM_THREADS'] = str(THREADS_PER_WORKER)
os.environ['OPENBLAS_NUM_THREADS'] = str(THREADS_PER_WORKER)
os.environ['MKL_NUM_THREADS'] = str(THREADS_PER_WORKER)
os.environ['NUMEXPR_MAX_THREADS'] = str(THREADS_PER_WORKER)

import redis
import psycopg2
import psycopg2.pool
from psycopg2.extras import RealDictCursor
from pgvector.psycopg2 import register_vector

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger('clap-analyzer')

# Configuration from environment
REDIS_URL = os.getenv('REDIS_URL', 'redis://localhost:6379')
DATABASE_URL = os.getenv('DATABASE_URL', '')
MUSIC_PATH = os.getenv('MUSIC_PATH', '/music')
NUM_WORKERS = int(os.getenv('NUM_WORKERS', '2'))
BACKEND_URL = os.getenv('BACKEND_URL', 'http://backend:3006')
MODEL_IDLE_TIMEOUT = int(os.getenv('MODEL_IDLE_TIMEOUT', '300'))
# How long a job holds its BullMQ lock; CLAP inference can take 30-60 s.
JOB_LOCK_MS = 300000
HEARTBEAT_SECONDS = 30
# The in-flight count lives no longer than its writer keeps beating: a count
# no live worker refreshes is gone after 3 heartbeats, so a stale count is
# never what holds analysis back.
INFLIGHT_TTL_SECONDS = 3 * HEARTBEAT_SECONDS
# Resolve the ONNX model path the same way the backend does: default to the
# analyzer's own models/ directory (where the validated music_audio.onnx lives),
# overridable with CLAP_ONNX_MODEL_PATH.
from onnx_backend import ONNX_MODEL_PATH as CLAP_ONNX_MODEL_PATH

# Queue and channel names
VIBE_QUEUE_NAME = 'enrichment-vibe'  # BullMQ queue consumed by BullMQVibeWorker
TEXT_EMBED_CHANNEL = 'audio:text:embed'
TEXT_EMBED_RESPONSE_PREFIX = 'audio:text:embed:response:'
CONTROL_CHANNEL = 'audio:clap:control'
INTERNAL_SECRET_KEY = 'kima:internal-secret'

# The label every stored vector carries. The backend matches only vectors under its feel probe's label
# (backend matching/feelProbe.json), so a new model or window recipe needs a new label.
MODEL_VERSION = 'laion-clap-music-onnx-v1'
# A stage job id ends in its claim: <key>-<attempt>-r<redelivered> (backend `claimOf`).
CLAIM_IN_JOB_ID = re.compile(r'-(\d+)-r(\d+)$')

# Zero-shot valence/arousal: score = sigmoid(a * margin + b), calibrate_platt.py's fit for the music model, chosen in
# the music-switch-2026-10-17 fits.json (lab archive): valence fitted on Memo2496, arousal on DEAM (the Memo2496 fit pinned 18% of
# a rock-heavy library at >= 0.99). The general model's fit is eval/calibration/platt-memo2496.json. A new model
# needs a new fit.
VA_CALIB = {'valence': (8.264, 0.249), 'arousal': (10.654, 0.018)}

# The zero-shot prompt groups. A changed prompt changes every stored score that reads it.
PROMPTS = {
    'vocal': ["music with singing vocals", "song with a singer", "vocal music with lyrics"],
    'instrumental': [
        "instrumental music without vocals",
        "instrumental track with no singing",
        "music without any vocals or singing",
    ],
    'acoustic': [
        "soft acoustic guitar and piano music",
        "unplugged unamplified intimate performance",
        "gentle stripped-back acoustic recording",
    ],
    'electronic': [
        "heavily produced studio track with electric instruments",
        "distorted electric guitar and amplified drums",
        "polished pop production with layered synths and effects",
    ],
    'happy': ["happy cheerful uplifting music", "joyful bright positive song", "feel good upbeat music"],
    'sad': ["sad melancholic somber music", "dark gloomy depressing song", "sorrowful mournful music"],
    'high_energy': ["intense energetic powerful music", "loud fast aggressive song", "high energy driving music"],
    'low_energy': ["calm relaxing peaceful music", "soft quiet gentle song", "mellow soothing ambient music"],
}

# Audio processing: sample the whole track with several short windows.
# Five 10-second windows (at 10/30/50/70/90% of the duration) capture the
# intro/verse/chorus/bridge/outro better than one mid-song slice, and the
# mean of their vectors is still a single 512-d embedding downstream.
WINDOW_COUNT = 5
WINDOW_SECONDS = 10  # each window is 10 seconds (matches the ONNX backend)
CLAP_SAMPLE_RATE = 48000  # 48kHz for CLAP model


def compute_window_offsets(duration: float,
                           count: int = WINDOW_COUNT,
                           window_seconds: float = WINDOW_SECONDS) -> list:
    """Start offsets, in seconds, for `count` windows of `window_seconds`.

    A long track gets windows starting at 10/30/50/70/90% of its length; a short
    one gets only the non-overlapping windows that fit, tiled from 0 to the end.
    No window reads past `duration`.
    """
    if duration <= 0:
        return [0.0] * count
    count = max(1, int(count))
    window_seconds = max(0.0, float(window_seconds))
    max_start = max(0.0, duration - window_seconds)

    # Number of non-overlapping windows of this length that actually fit.
    n = min(count, max(1, int(duration // window_seconds)))
    if n == 1:
        # Not even one full window fits; read from the start.
        return [0.0]

    if n < count:
        # Short track: only the non-overlapping windows that fit are used,
        # tiled so the first starts at 0 and the last ends at the file end.
        step = (duration - window_seconds) / (n - 1)
        return [i * step for i in range(n)]

    # Long track: windows start at 10/30/50/70/90% of the duration. The last
    # one is clamped to the file end so it never reads past it.
    starts = [(i + 0.5) / count * duration for i in range(count)]
    starts[-1] = min(starts[-1], max_start)
    if count > 1 and starts[-1] < starts[-2] + window_seconds:
        # Clamping made the last window overlap its neighbour (50-66.7 s with
        # the defaults); tile evenly from 0 to the file end instead.
        step = (duration - window_seconds) / (count - 1)
        starts = [i * step for i in range(count)]
    return starts


class CLAPAnalyzer:
    """
    LAION CLAP model wrapper for generating audio and text embeddings.

    Runs LAION-CLAP's music checkpoint (music_audioset_epoch_15_esc_90.14, HTSAT-base audio encoder)
    exported to ONNX. Supports idle model unloading to free memory when no work is pending.
    """

    def __init__(self):
        self.onnx_backend = None
        self.onnx_text_backend = None
        self._lock = threading.Lock()
        self.last_work_time: float = time.time()
        self._model_loaded = False
        self._prompt_embs: dict = {}

    def _ensure_onnx_backend(self):
        """Load the ONNX backend on first use and return it. The caller keeps that reference, so an
        idle unload cannot pull the model out from under a track being embedded; a broken model
        fails here, not at the first embed."""
        with self._lock:
            if self.onnx_backend is not None:
                return self.onnx_backend
            from onnx_backend import OnnxCLAPBackend
            backend = OnnxCLAPBackend(CLAP_ONNX_MODEL_PATH)
            backend.load_model()  # raises if onnxruntime or the model are broken
            self.onnx_backend = backend
            self._model_loaded = True
            logger.info(f"[CLAP] ONNX backend: True ({CLAP_ONNX_MODEL_PATH})")
            return backend

    def _ensure_onnx_text_backend(self):
        """Load the ONNX text backend on first use. It is apart from the audio backend: the text model
        is a different 500MB file and loads only when a text path is used."""
        if self.onnx_text_backend is None:
            from onnx_backend import OnnxTextCLAPBackend, ONNX_TEXT_MODEL_PATH
            backend = OnnxTextCLAPBackend(ONNX_TEXT_MODEL_PATH)
            backend.load_model()
            self.onnx_text_backend = backend
            self._model_loaded = True
            logger.info(f"[CLAP] ONNX text backend verified: {ONNX_TEXT_MODEL_PATH}")
        return self.onnx_text_backend

    def _text_embeddings(self, prompts: list[str]) -> list:
        """A list of 512-d float32 vectors from OnnxTextCLAPBackend, one unpadded prompt at a time."""
        text_backend = self._ensure_onnx_text_backend()
        try:
            embs = text_backend.embed_text(prompts)
            return [embs[i] for i in range(embs.shape[0])]
        except Exception as e:
            logger.critical(f"ONNX text backend failed; text embeddings for {len(prompts)} prompts: {e}", exc_info=True)
            raise

    def unload_model(self):
        """Unload the ONNX sound and text sessions to free memory; they load again with the
        next track or search."""
        with self._lock:
            if self.onnx_backend is None and self.onnx_text_backend is None:
                return
            logger.info("Unloading CLAP model to free memory...")
            self.onnx_backend = None
            self.onnx_text_backend = None
            self._model_loaded = False
            gc.collect()
            # Force glibc to return freed pages to the OS (Python holds RSS otherwise)
            try:
                import ctypes
                ctypes.CDLL("libc.so.6").malloc_trim(0)
            except (OSError, AttributeError):  # not glibc: nothing to trim
                pass
            logger.info("CLAP model unloaded")

    def _load_window(self, audio_path: str, start: float, window_seconds: float,
                     duration: float) -> Tuple[Optional[np.ndarray], int]:
        """Load a window from `start` of a track `duration` seconds long, clamped to its end; (None, 0)
        on error."""
        try:
            # Clamp so we never start past the end of the file.
            start = max(0.0, min(start, max(0.0, duration - 1e-3)))
            available = max(0.0, duration - start)
            take = min(window_seconds, available)

            audio, sr = librosa.load(
                audio_path,
                sr=CLAP_SAMPLE_RATE,
                offset=start,
                duration=(take if take > 0 else None),
                mono=True
            )

            return audio, sr

        except Exception as e:
            logger.exception(f"Failed to load window at {start:.1f}s from {audio_path}: {e}")
            return None, 0

    def get_audio_embedding(self, audio_path: str) -> Optional[np.ndarray]:
        """512-d embedding of a track: five 10 s windows (see window offsets) embedded together,
        averaged and L2-normalised. The length is the file's own, to the sample. Returns None
        on error.
        """
        self.last_work_time = time.time()
        onnx_backend = self._ensure_onnx_backend()

        if not os.path.exists(audio_path):
            logger.error(f"Audio file not found: {audio_path}")
            return None

        try:
            duration = librosa.get_duration(path=audio_path)
        except Exception as e:
            logger.exception(f"Failed to determine duration of {audio_path}: {e}")
            return None

        offsets = compute_window_offsets(duration)
        logger.debug(f"Embedding {audio_path} with {len(offsets)} windows at "
                     f"offsets={[round(o, 1) for o in offsets]}")

        # A track with a window that failed has no vector: the other windows are never
        # averaged as if they were the whole track.
        clips = []
        for start in offsets:
            audio, _ = self._load_window(audio_path, start, WINDOW_SECONDS, duration)
            if audio is None:
                logger.error(f"Window at {start:.1f}s of {audio_path} failed to load; no vector")
                return None
            clips.append(audio)
        try:
            vectors = list(onnx_backend.embed_clips(clips))
        except Exception as e:
            logger.critical(f"ONNX backend failed on {audio_path}: {e}", exc_info=True)
            return None

        # Mean of the window vectors, then L2-normalize -> 512-d.
        combined = np.mean(np.vstack(vectors), axis=0).astype(np.float32)
        norm = np.linalg.norm(combined)
        if norm > 0:
            combined = combined / norm
        return combined.astype(np.float32)

    def get_text_embedding(self, text: str) -> Optional[np.ndarray]:
        """512-d embedding of a text query, or None on error."""
        self.last_work_time = time.time()

        if not text or not text.strip():
            logger.error("Empty text provided for embedding")
            return None

        try:
            with self._lock:
                # CLAP expects a list of text prompts
                embeddings = self._text_embeddings([text])

                embedding = embeddings[0]

                if embedding.shape[0] != 512:
                    logger.warning(f"Unexpected text embedding dimension: {embedding.shape}")

                return embedding.astype(np.float32)

        except Exception as e:
            logger.exception(f"Failed to generate text embedding: {e}")
            return None

    def _prompt_similarity(self, audio_embedding: np.ndarray, group: str) -> float:
        """Mean cosine between a track's vector and one prompt group's text vectors, which are
        embedded once per process."""
        embs = self._prompt_embs.get(group)
        if embs is None:
            with self._lock:
                embs = self._prompt_embs.get(group)
                if embs is None:
                    embs = [e / (np.linalg.norm(e) + 1e-8) for e in self._text_embeddings(PROMPTS[group])]
                    self._prompt_embs[group] = embs
        audio_norm = audio_embedding / (np.linalg.norm(audio_embedding) + 1e-8)
        return float(np.mean([float(np.dot(audio_norm, e)) for e in embs]))

    def detect_vocals(self, audio_embedding: np.ndarray) -> float:
        """Instrumentalness: 0 = vocals present, 1 = instrumental."""
        share = _softmax_share(self._prompt_similarity(audio_embedding, 'instrumental'),
                               self._prompt_similarity(audio_embedding, 'vocal'))
        return round(max(0.0, min(1.0, share)), 3)

    def detect_acousticness(self, audio_embedding: np.ndarray) -> float:
        """Acousticness: 0 = electronic or heavily produced, 1 = acoustic."""
        share = _softmax_share(self._prompt_similarity(audio_embedding, 'acoustic'),
                               self._prompt_similarity(audio_embedding, 'electronic'))
        return round(max(0.0, min(1.0, share)), 3)

    def detect_emotion(self, audio_embedding: np.ndarray) -> tuple:
        """(valence, arousal), each in [0, 1]: the prompt groups' margin through VA_CALIB's
        Platt mapping. Valence 0 sad, 1 happy; arousal 0 calm, 1 intense."""
        def platt(axis: str, pos: str, neg: str) -> float:
            a, b = VA_CALIB[axis]
            margin = self._prompt_similarity(audio_embedding, pos) - self._prompt_similarity(audio_embedding, neg)
            return round(max(0.0, min(1.0, float(1.0 / (1.0 + np.exp(-(a * margin + b)))))), 3)

        return platt('valence', 'happy', 'sad'), platt('arousal', 'high_energy', 'low_energy')


def _softmax_share(winner: float, other: float, temperature: float = 15) -> float:
    """The winner's share of a softmax over two mean similarities; the temperature spreads small
    cosine gaps."""
    a, b = np.exp(winner * temperature), np.exp(other * temperature)
    return float(a / (a + b))


def load_configured_workers() -> int:
    """Concurrent jobs from SystemSettings.clapWorkers, which the settings
    screen writes; NUM_WORKERS when the row or database is unavailable."""
    if not DATABASE_URL:
        return NUM_WORKERS
    conn = None
    try:
        conn = psycopg2.connect(DATABASE_URL, connect_timeout=5,
                       application_name="clap-analyzer")
        with conn.cursor() as cur:
            cur.execute('SELECT "clapWorkers" FROM "SystemSettings" WHERE id = %s', ("default",))
            row = cur.fetchone()
        if row and row[0]:
            configured = max(1, min(os.cpu_count() or 8, int(row[0])))
            logger.info(f"Worker concurrency from SystemSettings.clapWorkers: {configured}")
            return configured
    except Exception as e:
        logger.warning(f"Could not read clapWorkers from the database ({e}); using NUM_WORKERS={NUM_WORKERS}")
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass
    return NUM_WORKERS


class BullMQVibeWorker:
    """Consumes 'enrichment-vibe' jobs on an asyncio loop in a background
    thread. Each job takes its own pooled DB connection via run_in_executor;
    CLAPAnalyzer._lock serialises inference, so extra concurrency overlaps DB
    I/O with inference."""

    def __init__(self, analyzer: CLAPAnalyzer, stop_event: threading.Event,
                 concurrency: int = None):
        self.analyzer = analyzer
        self.stop_event = stop_event
        self._redis_client = None
        self._db_pool = None  # psycopg2.pool.ThreadedConnectionPool
        self._db_pool_lock = threading.Lock()
        self._server_max_connections = None
        # Concurrency is live, not frozen at import. The settings screen writes
        # SystemSettings.clapWorkers and publishes set_workers; this is where
        # that number lands. Guarded because ControlHandler sets it from a
        # different thread.
        self._concurrency_lock = threading.Lock()
        self._desired_concurrency = (
            max(1, min(os.cpu_count() or 8, int(concurrency))) if concurrency else load_configured_workers()
        )
        self._active_concurrency = None
        # Jobs this worker is computing right now. The backend reads the published
        # count to keep MusiCNN and CLAP one at a time across a re-run, where a
        # track's embedding stage rows are reset to pending while the job CLAP
        # already took is still running.
        self._jobs_in_flight = 0

    def set_concurrency(self, count: int) -> int:
        """Ask the worker to run `count` jobs at once. Applied within seconds."""
        count = max(1, min(os.cpu_count() or 8, int(count)))
        with self._concurrency_lock:
            self._desired_concurrency = count
        return count

    @property
    def desired_concurrency(self) -> int:
        with self._concurrency_lock:
            return self._desired_concurrency

    def start(self):
        """Start the BullMQ worker in a dedicated asyncio event loop."""
        logger.info("BullMQVibeWorker starting...")
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            loop.run_until_complete(self._run())
        finally:
            loop.close()
            logger.info("BullMQVibeWorker stopped")

    def _pool_size(self, workers: int) -> int:
        """Connections to hold for `workers` concurrent jobs: two per job, with
        a floor and a ceiling. The ceiling respects the server's own limit
        (max_connections, read once at connect) minus room for the backend's
        pool, so a many-core host can never wedge Postgres itself."""
        headroom = 10
        server_max = self._server_max_connections or 100
        return max(8, min(workers * 2, max(9, server_max - headroom)))

    def _connect_pool(self, workers: int):
        self._server_max_connections = self._read_server_max_connections()
        pool_size = self._pool_size(workers)
        self._db_pool = psycopg2.pool.ThreadedConnectionPool(
            minconn=1,
            maxconn=pool_size,
            dsn=DATABASE_URL,
            options="-c client_encoding=UTF8 -c timezone=UTC",
            application_name="clap-analyzer",
        )
        logger.info(f"Connected to PostgreSQL (pool size: {pool_size})")

    def _read_server_max_connections(self) -> int | None:
        """The server's max_connections, or None when it cannot be read (the
        fallback ceiling then applies)."""
        try:
            conn = psycopg2.connect(
                dsn=DATABASE_URL,
                options="-c client_encoding=UTF8 -c timezone=UTC",
                application_name="clap-analyzer",
            )
            try:
                with conn.cursor() as cursor:
                    cursor.execute("SHOW max_connections")
                    row = cursor.fetchone()
                return int(row[0]) if row else None
            finally:
                conn.close()
        except Exception as e:
            logger.warning(f"Could not read max_connections: {e}")
            return None

    def _resize_pool(self, workers: int):
        """Bring the pool to the size `workers` needs. Called only from the
        worker-replacement path, after close() has drained every running job,
        so no connection is checked out when the old pool closes."""
        with self._db_pool_lock:
            old = self._db_pool
            self._connect_pool(workers)
            if old is not None:
                try:
                    old.closeall()
                except Exception as e:
                    logger.warning(f"Error closing the old DB pool: {e}")
            logger.info(f"DB pool resized for {workers} workers")

    def build_worker(self, concurrency: int):
        # Imported here, not at module top, to match the worker's own lazy
        # load; the import must live in this method's scope, which is entered
        # fresh on every call.
        from bullmq import Worker as BullWorker

        w = BullWorker(
            VIBE_QUEUE_NAME,
            self._process_job,
            {
                "connection": REDIS_URL,
                "concurrency": concurrency,
                "lockDuration": JOB_LOCK_MS,
            },
        )
        w.on("failed", lambda job, err: logger.error(
            f"[BullMQ] Job {job.id if job else '?'} failed: {err}"
        ))
        w.on("error", lambda err: logger.error(f"[BullMQ] Worker error: {err}"))
        return w

    async def _run(self):
        self._redis_client = redis.from_url(REDIS_URL)
        self._active_concurrency = self.desired_concurrency
        self._connect_pool(self._active_concurrency)
        # Announce an empty run before taking jobs: a previous process's count
        # (a crash's stale '1', say) stops holding the backend's analysis back
        # the moment this worker is up, not at its next heartbeat.
        await self._publish_inflight()
        bullmq_worker = self.build_worker(self._active_concurrency)
        logger.info(f"[BullMQ] Worker started with concurrency {self._active_concurrency}")

        last_heartbeat = 0.0
        try:
            while not self.stop_event.is_set():
                # A concurrency change is applied by replacing the worker. close()
                # waits for jobs already running to finish, so nothing is dropped;
                # the queue simply stops being drained for the moment it takes.
                target = self.desired_concurrency
                if target != self._active_concurrency:
                    logger.info(
                        f"[BullMQ] Concurrency {self._active_concurrency} -> {target}, replacing worker"
                    )
                    try:
                        # Beats while the running jobs finish, so the heartbeat and the in-flight
                        # count stay live for as long as CLAP is still working.
                        await self._close(bullmq_worker)
                    except Exception as e:
                        logger.error(f"[BullMQ] Error closing worker for resize: {e}")
                    # With every job drained, no connection is checked out:
                    # rebuild the pool for the new count before the new worker
                    # starts taking jobs, so it never runs against the old size.
                    self._resize_pool(target)
                    bullmq_worker = self.build_worker(target)
                    self._active_concurrency = target
                    logger.info(f"[BullMQ] Worker now running with concurrency {target}")

                now = time.time()
                if now - last_heartbeat >= HEARTBEAT_SECONDS:
                    last_heartbeat = now
                    await self._beat()

                # Short sleep so a concurrency change lands in seconds, not in
                # however long is left of a thirty-second heartbeat tick.
                await asyncio.sleep(2)
        finally:
            await self._close(bullmq_worker)
            if self._db_pool:
                self._db_pool.closeall()

    async def _close(self, worker) -> None:
        """Close the worker, which waits for the running jobs (up to their lock), beating meanwhile: the
        analyzer is still here."""
        closing = asyncio.ensure_future(worker.close())
        while not closing.done():
            await self._beat()
            await asyncio.wait({closing}, timeout=HEARTBEAT_SECONDS)
        await closing

    async def _beat(self) -> None:
        """featureDetection and the settings screen read the heartbeat to decide whether an analyzer is
        running. The effective concurrency rides along so the backend can report what is in force rather
        than what was merely requested. The in-flight job count rides along too: the backend's one-at-a-time
        rule reads it to hold analysis back while CLAP works (see _publish_inflight)."""
        client = self._redis_client
        if client is None:  # not connected yet: the next beat carries the news
            return
        beat = str(int(time.time() * 1000))
        active = self._active_concurrency
        inflight = str(self._jobs_in_flight)
        try:
            await asyncio.get_running_loop().run_in_executor(
                None,
                lambda: (
                    client.set("clap:worker:heartbeat", beat),
                    client.set("clap:worker:concurrency", str(active)),
                    client.set("clap:worker:inflight", inflight, ex=INFLIGHT_TTL_SECONDS),
                ),
            )
        except Exception:  # a missed beat is made up by the next one
            pass

    async def _publish_inflight(self) -> None:
        """Publish how many jobs this worker is computing right now, so the
        backend sees a new batch start within a second of taking it, not at the
        next heartbeat. The write carries the heartbeat expiry (see
        INFLIGHT_TTL_SECONDS), so a crash's leftover count lapses on its own.
        A missed write must not break the job: _beat writes the
        same key, so the next beat makes it up."""
        client = self._redis_client
        if client is None:
            return
        try:
            await asyncio.get_running_loop().run_in_executor(
                None,
                lambda: client.set(
                    "clap:worker:inflight", str(self._jobs_in_flight), ex=INFLIGHT_TTL_SECONDS
                ),
            )
        except Exception:
            pass

    async def _process_job(self, job, _token: str) -> dict:
        """BullMQ job processor — called for each enrichment-vibe job."""
        track_id = job.data.get("trackId")
        file_path = job.data.get("filePath", "")
        job_id = job.id

        if not track_id:
            raise ValueError(f"Invalid job data (no trackId): {job.data}")

        # Counted from the moment the job is taken: the backend's one-at-a-time
        # rule reads the published count, so a re-run that resets the tracks'
        # embedding rows while this batch is computing still holds analysis back.
        self._jobs_in_flight += 1
        await self._publish_inflight()
        try:
            return await self._run_job(job, track_id, file_path, job_id)
        finally:
            self._jobs_in_flight -= 1
            await self._publish_inflight()

    async def _run_job(self, job, track_id: str, file_path: str, job_id) -> dict:
        """One embedding job, running inside the in-flight count _process_job keeps."""
        loop = asyncio.get_running_loop()
        if not await loop.run_in_executor(None, self._claim_is_current, track_id, job_id):
            logger.info(f"[BullMQ] Skipped {track_id}: claim {job_id} was re-issued")
            return {"skipped": True}

        logger.info(f"[BullMQ] Processing vibe for track: {track_id}")

        normalized_path = file_path.replace("\\", "/")
        full_path = os.path.join(MUSIC_PATH, normalized_path)

        try:
            file_size = os.path.getsize(full_path)
            if file_size == 0:
                await loop.run_in_executor(
                    None, self._report_failure, job_id, track_id,
                    "Empty file (0 bytes) - likely incomplete download",
                )
                raise ValueError("Empty file")
        except OSError:
            await loop.run_in_executor(
                None, self._report_failure, job_id, track_id, f"File not found: {normalized_path}"
            )
            raise

        # The file's exact length places the windows; the stored length is whole seconds.
        embedding = await loop.run_in_executor(
            None, self.analyzer.get_audio_embedding, full_path
        )

        await job.updateProgress(50)

        if embedding is None:
            await loop.run_in_executor(
                None, self._report_failure, job_id, track_id, "Failed to generate embedding"
            )
            raise RuntimeError("Embedding generation failed")

        # === CLAP zero-shot feature detection ===
        instrumentalness = await loop.run_in_executor(
            None, self.analyzer.detect_vocals, embedding
        )
        acousticness = await loop.run_in_executor(
            None, self.analyzer.detect_acousticness, embedding
        )
        clap_valence, clap_arousal = await loop.run_in_executor(
            None, self.analyzer.detect_emotion, embedding
        )

        stored = await loop.run_in_executor(
            None, self._store_result, track_id, embedding,
            instrumentalness, acousticness, clap_valence, clap_arousal, job_id,
        )

        if stored == "stale":
            logger.info(f"[BullMQ] Not stored for {track_id}: claim {job_id} was re-issued while it ran")
            return {"trackId": track_id, "skipped": True}
        if stored == "stored":
            await loop.run_in_executor(None, self._report_success, job_id, track_id)
            await job.updateProgress(100)
            logger.info(
                f"[BullMQ] Completed vibe for track: {track_id} "
                f"(instr={instrumentalness}, acoustic={acousticness}, "
                f"valence={clap_valence}, arousal={clap_arousal})"
            )
            return {"trackId": track_id, "status": "complete"}
        await loop.run_in_executor(
            None, self._report_failure, job_id, track_id, "Failed to store embedding"
        )
        raise RuntimeError("Failed to store embedding")

    def _internal_secret(self) -> str:
        """The backend's secret for these reports: made at random once per server and kept in the Redis both
        share (backend `utils/internalSecret.ts`); whichever side needs it first makes it."""
        self._redis_client.set(INTERNAL_SECRET_KEY, secrets.token_hex(32), nx=True)
        value = self._redis_client.get(INTERNAL_SECRET_KEY)
        return value.decode() if isinstance(value, bytes) else (value or "")

    def _report_failure(self, job_id: str, track_id: str, error: str):
        """Report a failed embedding to the backend (runs in executor thread).
        The backend owns every write of a track's state; this writes nothing."""
        track_name = None
        conn = self._db_pool.getconn()
        try:
            with conn.cursor(cursor_factory=RealDictCursor) as cursor:
                cursor.execute('SELECT title FROM "Track" WHERE id = %s', (track_id,))
                row = cursor.fetchone()
                track_name = row['title'] if row else None
            logger.error(f"Track {track_id} failed: {error}")
        finally:
            # Release connection before making the network call below
            self._db_pool.putconn(conn)

        # Report failure to backend enrichment failure service
        try:
            headers = {
                "Content-Type": "application/json",
                "X-Internal-Secret": self._internal_secret()
            }
            requests.post(
                f"{BACKEND_URL}/api/analysis/vibe/failure",
                json={
                    "trackId": track_id,
                    "jobId": job_id,
                    "trackName": track_name,
                    "errorMessage": error[:500],
                    "errorCode": "VIBE_EMBEDDING_FAILED"
                },
                headers=headers,
                timeout=5
            )
        except Exception as report_err:
            logger.warning(f"Failed to report failure to backend: {report_err}")

    def _report_success(self, job_id: str, track_id: str):
        """Tell the backend the job's answer is stored; it settles the stage record."""
        try:
            headers = {
                "Content-Type": "application/json",
                "X-Internal-Secret": self._internal_secret()
            }
            requests.post(
                f"{BACKEND_URL}/api/analysis/vibe/success",
                json={"trackId": track_id, "jobId": job_id},
                headers=headers,
                timeout=5
            )
        except Exception as report_err:
            logger.warning(f"Failed to report success to backend: {report_err}")

    def _claim_is_current(self, track_id: str, job_id: Optional[str]) -> bool:
        """Whether this job's claim is still the record's open one (backend `claimIsCurrent`). A job whose
        claim was re-issued (a lease re-offer, a wipe, a restart) does no work: its report would be
        refused as stale. A job id with no claim in it always runs."""
        match = CLAIM_IN_JOB_ID.search(job_id or "")
        if not match:
            return True
        conn = self._db_pool.getconn()
        try:
            with conn.cursor() as cursor:
                cursor.execute(
                    'SELECT status, attempt, redelivered FROM "TrackStage" WHERE "trackId" = %s AND stage = %s',
                    (track_id, "embedding"),
                )
                row = cursor.fetchone()
            conn.commit()
        finally:
            self._db_pool.putconn(conn)
        return bool(row) and row[0] == "working" and (row[1], row[2]) == (int(match.group(1)), int(match.group(2)))

    def _store_result(self, track_id: str, embedding: np.ndarray,
                      instrumentalness: float, acousticness: float,
                      clap_valence: float, clap_arousal: float,
                      job_id: Optional[str] = None) -> str:
        """Store the vector and CLAP's own raw features in one transaction (runs in executor thread):
        "stored", "stale" when the job's claim is not the record's open one (a wipe or a re-offer
        while it ran; nothing is written), or "failed". The shared valence/arousal pair is the
        backend's to derive from both analyzers' raws."""
        conn = self._db_pool.getconn()
        try:
            # Unit-norm guard: an embedding that is not (approximately) unit
            # length is almost certainly corrupt. Refuse to write it rather than
            # poisoning the vector index, and report the failure for the track.
            norm = float(np.linalg.norm(embedding))
            if abs(norm - 1.0) > 1e-3:
                logger.error(
                    f"REFUSING to store corrupt embedding for {track_id}: "
                    f"unit-norm guard failed (norm={norm:.6f}, expected ~1.0). "
                    f"Track will be marked as failed."
                )
                return "failed"

            # pgvector type must be registered per-connection; idempotent on repeat calls
            register_vector(conn)
            embedding_list = embedding.tolist()
            claim = CLAIM_IN_JOB_ID.search(job_id or "")
            with conn.cursor() as cursor:
                if claim:
                    # Held for the transaction, so the claim cannot move between this check and the write.
                    cursor.execute(
                        'SELECT 1 FROM "TrackStage" WHERE "trackId" = %s AND stage = %s AND status = %s'
                        ' AND attempt = %s AND redelivered = %s FOR SHARE',
                        (track_id, "embedding", "working", int(claim.group(1)), int(claim.group(2))),
                    )
                    if cursor.fetchone() is None:
                        conn.rollback()
                        return "stale"
                cursor.execute(
                    """
                    INSERT INTO track_embeddings (track_id, embedding, model_version, analyzed_at)
                    VALUES (%s, %s::vector, %s, now())
                    ON CONFLICT (track_id)
                    DO UPDATE SET
                        embedding = EXCLUDED.embedding,
                        model_version = EXCLUDED.model_version,
                        analyzed_at = EXCLUDED.analyzed_at
                    """,
                    (track_id, embedding_list, MODEL_VERSION),
                )
                cursor.execute(
                    """UPDATE "Track"
                       SET instrumentalness = %s, acousticness = %s,
                           "clapValenceRaw" = %s, "clapArousalRaw" = %s
                     WHERE id = %s""",
                    (instrumentalness, acousticness, clap_valence, clap_arousal, track_id),
                )
            conn.commit()
            return "stored"
        except Exception as e:
            logger.exception(f"Failed to store embedding for {track_id}: {e}")
            conn.rollback()
            return "failed"
        finally:
            self._db_pool.putconn(conn)


class PubSubHandler:
    """Reads one Redis pub/sub channel until `stop_event` is set and passes each message to
    `_handle_message`."""

    channel: str

    def __init__(self, stop_event: threading.Event):
        self.stop_event = stop_event
        self.redis_client = None
        self.pubsub = None

    def start(self):
        name = type(self).__name__
        logger.info(f"{name} starting...")

        try:
            self.redis_client = redis.from_url(REDIS_URL)
            self.pubsub = self.redis_client.pubsub()
            self.pubsub.subscribe(self.channel)
            logger.info(f"Subscribed to channel: {self.channel}")

            while not self.stop_event.is_set():
                try:
                    message = self.pubsub.get_message(
                        ignore_subscribe_messages=True,
                        timeout=1.0
                    )

                    if message and message['type'] == 'message':
                        self._handle_message(message)

                except Exception as e:
                    logger.exception(f"{name} error: {e}")
                    time.sleep(1)

        finally:
            if self.pubsub:
                self.pubsub.close()
            logger.info(f"{name} stopped")

    def _handle_message(self, message):
        raise NotImplementedError


class TextEmbedHandler(PubSubHandler):
    """Answers natural-language vibe queries: each request on the text channel gets its embedding
    published back on a channel of its own."""

    channel = TEXT_EMBED_CHANNEL

    def __init__(self, analyzer: CLAPAnalyzer, stop_event: threading.Event):
        super().__init__(stop_event)
        self.analyzer = analyzer

    def _handle_message(self, message):
        """Handle a text embedding request"""
        request_id = None
        try:
            data = message['data']
            if isinstance(data, bytes):
                data = data.decode('utf-8')

            request = json.loads(data)
            request_id = request.get('requestId')
            text = request.get('text', '')

            if not request_id:
                logger.warning("Text embed request missing requestId")
                return

            logger.info(f"Processing text embed request: {request_id}")

            # Generate embedding
            embedding = self.analyzer.get_text_embedding(text)

            # Prepare response
            response = {
                'requestId': request_id,
                'success': embedding is not None,
                'embedding': embedding.tolist() if embedding is not None else None,
                'modelVersion': MODEL_VERSION
            }

            # Publish response to request-specific channel
            response_channel = f"{TEXT_EMBED_RESPONSE_PREFIX}{request_id}"
            self.redis_client.publish(response_channel, json.dumps(response))

            logger.info(f"Text embed response sent: {request_id}")

        except Exception as e:
            logger.exception(f"Failed to handle text embed request: {e}")
            # Publish a failure response so the caller fails fast instead of
            # waiting out its full timeout on an internal analyzer error.
            if request_id:
                try:
                    self.redis_client.publish(
                        f"{TEXT_EMBED_RESPONSE_PREFIX}{request_id}",
                        json.dumps({'requestId': request_id, 'success': False, 'embedding': None})
                    )
                except Exception as pub_err:
                    logger.error(f"Failed to publish text embed failure response: {pub_err}")


class ControlHandler(PubSubHandler):
    """Applies control messages from Redis pub/sub, such as a worker count
    change, to the running BullMQ worker within a couple of seconds."""

    channel = CONTROL_CHANNEL

    def __init__(self, stop_event: threading.Event, worker: "BullMQVibeWorker" = None):
        super().__init__(stop_event)
        self.worker = worker

    def _handle_message(self, message):
        """Handle a control message"""
        try:
            data = message['data']
            if isinstance(data, bytes):
                data = data.decode('utf-8')

            control = json.loads(data)
            command = control.get('command')

            if command == 'set_workers':
                requested = control.get('count', NUM_WORKERS)
                if self.worker is None:
                    logger.warning(
                        f"set_workers={requested} received but no worker is attached to the control handler"
                    )
                else:
                    previous = self.worker.desired_concurrency
                    applied = self.worker.set_concurrency(requested)
                    logger.info(f"Worker concurrency {previous} -> {applied} (applied live)")
            elif command in ('install_gpu', 'cancel_gpu_install'):
                import gpu_runtime
                action = 'install' if command == 'install_gpu' else 'cancel'
                result = gpu_runtime.dispatch(action)
                logger.info(f"gpu-runtime {action} dispatched: {result}")
            elif command == 'stop':
                logger.info("Received stop command — signalling worker threads to stop")
                self.stop_event.set()
            else:
                logger.warning(f"Unknown control command: {command}")

        except Exception as e:
            logger.exception(f"Failed to handle control message: {e}")


def probe_gpu_session():
    """Open one audio session and drop it, so the GPU's state is recorded."""
    from onnx_backend import OnnxCLAPBackend
    try:
        OnnxCLAPBackend(CLAP_ONNX_MODEL_PATH).load_model()
    except Exception as e:
        logger.error(f"gpu-onnx: startup session failed: {e}")
        import gpu_runtime
        gpu_runtime.record_provider(False, f'startup session failed: {e}')
    gc.collect()


def gpu_switch_changed() -> bool:
    """The sound-vector switch, or the runtime's install, changed since this process started, and no
    install is running here."""
    import gpu_runtime
    import gpu_switch
    return gpu_switch.restart_needed('soundVectors') and not gpu_runtime.busy()


def main():
    logger.info("=" * 60)
    logger.info("CLAP Audio Analyzer Service")
    logger.info("=" * 60)
    logger.info(f"  Model version: {MODEL_VERSION}")
    logger.info(f"  Music path: {MUSIC_PATH}")
    configured_workers = load_configured_workers()
    logger.info(f"  Num workers: {configured_workers} (SystemSettings.clapWorkers, env NUM_WORKERS={NUM_WORKERS})")
    logger.info(f"  Threads per worker: {THREADS_PER_WORKER}")
    logger.info(f"  Model idle timeout: {MODEL_IDLE_TIMEOUT}s")
    logger.info("=" * 60)

    # Model is shared across all workers but loaded lazily on the first job, so
    # an analyzer with no CLAP work yet does not load it at startup.
    analyzer = CLAPAnalyzer()

    # Everything stops on stop_event; the job worker and control messages on jobs_stop, which a restart
    # sets first so searches are answered until the running jobs are done.
    stop_event = threading.Event()
    jobs_stop = threading.Event()

    def signal_handler(signum, frame):
        logger.info(f"Received signal {signum}, initiating graceful shutdown...")
        jobs_stop.set()
        stop_event.set()

    signal.signal(signal.SIGTERM, signal_handler)
    signal.signal(signal.SIGINT, signal_handler)

    threads = []

    bullmq_worker = BullMQVibeWorker(analyzer, jobs_stop, concurrency=configured_workers)
    bullmq_thread = threading.Thread(target=bullmq_worker.start, name="BullMQVibeWorker")
    bullmq_thread.daemon = True
    bullmq_thread.start()
    threads.append(bullmq_thread)
    logger.info("Started BullMQ vibe worker thread")

    text_handler = TextEmbedHandler(analyzer, stop_event)
    text_thread = threading.Thread(target=text_handler.start, name="TextEmbedHandler")
    text_thread.daemon = True
    text_thread.start()
    threads.append(text_thread)
    logger.info("Started text embed handler thread")

    control_handler = ControlHandler(jobs_stop, worker=bullmq_worker)
    control_thread = threading.Thread(target=control_handler.start, name="ControlHandler")
    control_thread.daemon = True
    control_thread.start()
    threads.append(control_thread)
    logger.info("Started control handler thread")

    # Pick up a GPU install requested while this process was down.
    import gpu_runtime
    if os.path.exists(os.path.join(os.getenv('DATA_DIR', '/data'),
                                   'gpu-onnx', 'enabled.json')):
        logger.info(f"gpu-runtime startup reconcile: {gpu_runtime.reconcile()}")

    # Each start begins unmeasured, so the settings page never reads an earlier start's answer. The model
    # loads on the first job, so an idle analyzer would never say whether the GPU took effect: one session
    # opened now measures it.
    if os.path.isdir(gpu_runtime.ROOT):
        gpu_runtime.record_provider(False, 'not measured since this start', measured=False)
    if gpu_runtime.request_gpu():
        threading.Thread(target=probe_gpu_session, name="GpuProbe", daemon=True).start()

    # Main loop: unload an idle model, and restart when the GPU switch changed: the runtime is put
    # on the path before Python starts, so the process restarts to take it up or let it go.
    restarting = False
    try:
        while not jobs_stop.is_set():
            time.sleep(5)
            if gpu_switch_changed():
                logger.info("GPU switch changed: finishing running jobs, then restarting to apply it")
                restarting = True
                break
            if analyzer._model_loaded:
                idle_seconds = time.time() - analyzer.last_work_time
                if idle_seconds >= MODEL_IDLE_TIMEOUT > 0:
                    analyzer.unload_model()
                    logger.info(f"Model idle for {idle_seconds:.0f}s, unloaded to free memory (will reload when work arrives)")
    except KeyboardInterrupt:
        logger.info("Keyboard interrupt received")
        stop_event.set()

    # A restart gives the running jobs up to their lock to finish (past it BullMQ hands a job out again
    # anyway) while searches are still answered. A control message that arrives meanwhile is carried out
    # by the next start's reconcile, which also resumes an install this exit cut short. A stop gives each
    # thread ten seconds.
    jobs_stop.set()
    if restarting:
        bullmq_thread.join(timeout=JOB_LOCK_MS / 1000)
    stop_event.set()
    logger.info("Waiting for threads to finish...")
    for thread in threads:
        thread.join(timeout=0 if restarting and thread is bullmq_thread else 10)

    logger.info("CLAP Analyzer service stopped")


if __name__ == '__main__':
    main()
