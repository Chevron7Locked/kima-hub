#!/usr/bin/env python3
"""
CLAP Audio Analyzer Service - LAION CLAP embeddings for vibe similarity

This service processes audio files and generates 512-dimensional embeddings
using LAION CLAP (Contrastive Language-Audio Pretraining). These embeddings
enable semantic similarity search - finding tracks that "sound similar" based
on learned audio representations.

Features:
- Audio embedding generation from music files
- Text embedding generation for natural language queries
- Redis queue processing for batch embedding generation
- Direct database storage in PostgreSQL with pgvector

Architecture:
- CLAPAnalyzer: Model loading and embedding generation
- BullMQVibeWorker: Queue consumer that processes tracks and stores embeddings
- TextEmbedHandler: Real-time text embedding via Redis pub/sub
"""

import os
import sys
import signal
import json
import time
import logging
import gc
import asyncio
import threading
from datetime import datetime
from typing import Optional, Tuple
import traceback
import numpy as np
import librosa
import requests

# CPU thread limiting must be set before importing torch
THREADS_PER_WORKER = int(os.getenv('THREADS_PER_WORKER', '1'))
os.environ['OMP_NUM_THREADS'] = str(THREADS_PER_WORKER)
os.environ['OPENBLAS_NUM_THREADS'] = str(THREADS_PER_WORKER)
os.environ['MKL_NUM_THREADS'] = str(THREADS_PER_WORKER)
os.environ['NUMEXPR_MAX_THREADS'] = str(THREADS_PER_WORKER)

import torch
torch.set_num_threads(THREADS_PER_WORKER)

DEVICE = torch.device('cpu')

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
SLEEP_INTERVAL = int(os.getenv('SLEEP_INTERVAL', '5'))
NUM_WORKERS = int(os.getenv('NUM_WORKERS', '2'))
BACKEND_URL = os.getenv('BACKEND_URL', 'http://backend:3006')
MODEL_IDLE_TIMEOUT = int(os.getenv('MODEL_IDLE_TIMEOUT', '300'))

# Queue and channel names
VIBE_QUEUE_NAME = 'enrichment-vibe'  # BullMQ queue consumed by BullMQVibeWorker
TEXT_EMBED_CHANNEL = 'audio:text:embed'
TEXT_EMBED_RESPONSE_PREFIX = 'audio:text:embed:response:'
CONTROL_CHANNEL = 'audio:clap:control'

# Model version identifier
MODEL_VERSION = 'laion-clap-music-v1'

# Audio processing: extract middle segment for consistent, efficient embedding
# 60 seconds captures the "vibe" without intros/outros and reduces memory usage
MAX_AUDIO_DURATION = 60  # seconds
CLAP_SAMPLE_RATE = 48000  # 48kHz for CLAP model


class CLAPAnalyzer:
    """
    LAION CLAP model wrapper for generating audio and text embeddings.

    Uses HTSAT-base architecture with the music_audioset checkpoint,
    optimized for music similarity tasks. Supports idle model unloading
    to free memory when no work is pending.
    """

    def __init__(self):
        self.model = None
        self._lock = threading.Lock()
        self.last_work_time: float = time.time()
        self._model_loaded = False

    def load_model(self):
        """Load the CLAP model (thread-safe, idempotent)"""
        with self._lock:
            if self.model is not None:
                return

            logger.info("Loading LAION CLAP model...")
            try:
                import laion_clap

                self.model = laion_clap.CLAP_Module(
                    enable_fusion=False,
                    amodel='HTSAT-base'
                )
                self.model.load_ckpt('/app/models/music_audioset_epoch_15_esc_90.14.pt')

                # Move to detected device (GPU if available, else CPU)
                self.model = self.model.to(DEVICE).eval()
                self._model_loaded = True
                self.last_work_time = time.time()

                logger.info("CLAP model loaded successfully on CPU")
            except Exception as e:
                logger.error(f"Failed to load CLAP model: {e}")
                traceback.print_exc()
                raise

    def unload_model(self):
        """Unload the CLAP model to free memory"""
        with self._lock:
            if self.model is None:
                return
            logger.info("Unloading CLAP model to free memory...")
            self.model = None
            self._model_loaded = False
            gc.collect()
            # Force glibc to return freed pages to OS (Python/PyTorch hold RSS otherwise)
            try:
                import ctypes
                ctypes.CDLL("libc.so.6").malloc_trim(0)
            except Exception:
                pass
            logger.info("CLAP model unloaded")

    def ensure_model(self):
        """Ensure model is loaded, reloading if it was unloaded for idle"""
        if self.model is None:
            logger.info("Reloading CLAP model (new work arrived)...")
            self.load_model()

    def _load_audio_chunk(self, audio_path: str, duration_hint: Optional[float] = None) -> Tuple[Optional[np.ndarray], int]:
        """
        Load audio from the middle of a file for efficient embedding.

        Always extracts MAX_AUDIO_DURATION seconds from the middle of the track.
        This captures the "vibe" while avoiding intros/outros and reducing memory.

        Args:
            audio_path: Path to the audio file
            duration_hint: Pre-computed duration in seconds (avoids file read)

        Returns:
            Tuple of (audio_array, sample_rate) or (None, 0) on error
        """
        try:
            # Use provided duration or fall back to computing it
            duration = duration_hint if duration_hint else librosa.get_duration(path=audio_path)

            if duration > MAX_AUDIO_DURATION:
                # Extract middle segment
                offset = (duration - MAX_AUDIO_DURATION) / 2
                audio, sr = librosa.load(
                    audio_path,
                    sr=CLAP_SAMPLE_RATE,
                    offset=offset,
                    duration=MAX_AUDIO_DURATION,
                    mono=True
                )
            else:
                # Short track, load entirely
                audio, sr = librosa.load(audio_path, sr=CLAP_SAMPLE_RATE, mono=True)

            return audio, sr

        except Exception as e:
            logger.error(f"Failed to load audio from {audio_path}: {e}")
            traceback.print_exc()
            return None, 0

    def get_audio_embedding(self, audio_path: str, duration: Optional[float] = None) -> Optional[np.ndarray]:
        """
        Generate a 512-dimensional embedding from an audio file.

        Extracts the middle 60 seconds of the track for embedding, which
        captures the vibe while avoiding intros/outros and reducing memory.

        Args:
            audio_path: Path to the audio file
            duration: Pre-computed duration in seconds (avoids file read)

        Returns:
            numpy array of shape (512,) or None on error
        """
        self.ensure_model()
        self.last_work_time = time.time()

        if not os.path.exists(audio_path):
            logger.error(f"Audio file not found: {audio_path}")
            return None

        try:
            # Load audio (with chunking), use provided duration to skip file probe
            audio, sr = self._load_audio_chunk(audio_path, duration)

            if audio is None:
                return None

            logger.debug(f"Loaded audio: {len(audio)/sr:.1f}s at {sr}Hz")

            with self._lock:
                # Use get_audio_embedding_from_data for pre-loaded audio
                # This gives us control over memory usage
                embeddings = self.model.get_audio_embedding_from_data(
                    [audio],
                    use_tensor=False
                )

                # Result is shape (1, 512) for HTSAT-base model, normalized
                embedding = embeddings[0]

                if embedding.shape[0] != 512:
                    logger.warning(f"Unexpected embedding dimension: {embedding.shape}")

                return embedding.astype(np.float32)

        except Exception as e:
            logger.error(f"Failed to generate audio embedding for {audio_path}: {e}")
            traceback.print_exc()
            return None

    def get_text_embedding(self, text: str) -> Optional[np.ndarray]:
        """
        Generate a 512-dimensional embedding from a text query.

        Args:
            text: Natural language description (e.g., "upbeat electronic dance music")

        Returns:
            numpy array of shape (512,) or None on error
        """
        self.ensure_model()
        self.last_work_time = time.time()

        if not text or not text.strip():
            logger.error("Empty text provided for embedding")
            return None

        try:
            with self._lock:
                # CLAP expects a list of text prompts
                embeddings = self.model.get_text_embedding(
                    [text],
                    use_tensor=False
                )

                embedding = embeddings[0]

                if embedding.shape[0] != 512:
                    logger.warning(f"Unexpected text embedding dimension: {embedding.shape}")

                return embedding.astype(np.float32)

        except Exception as e:
            logger.error(f"Failed to generate text embedding: {e}")
            traceback.print_exc()
            return None


class DatabaseConnection:
    """PostgreSQL connection manager with pgvector support and auto-reconnect"""

    def __init__(self, url: str):
        self.url = url
        self.conn = None

    def connect(self):
        """Establish database connection with pgvector extension"""
        if not self.url:
            raise ValueError("DATABASE_URL not set")

        self.conn = psycopg2.connect(
            self.url,
            options="-c client_encoding=UTF8"
        )
        self.conn.set_client_encoding('UTF8')
        self.conn.autocommit = False

        # Register pgvector type
        register_vector(self.conn)

        logger.info("Connected to PostgreSQL with pgvector support")

    def is_connected(self) -> bool:
        """Check if the database connection is alive"""
        if not self.conn:
            return False
        try:
            cursor = self.conn.cursor()
            cursor.execute("SELECT 1")
            cursor.close()
            return True
        except Exception:
            return False

    def reconnect(self):
        """Close existing connection and establish a new one"""
        logger.info("Reconnecting to database...")
        self.close()
        self.connect()

    def get_cursor(self):
        """Get a database cursor, reconnecting if necessary"""
        if not self.is_connected():
            self.reconnect()
        return self.conn.cursor(cursor_factory=RealDictCursor)

    def commit(self):
        if self.conn:
            self.conn.commit()

    def rollback(self):
        if self.conn:
            self.conn.rollback()

    def close(self):
        if self.conn:
            try:
                self.conn.close()
            except Exception:
                pass
            self.conn = None


class BullMQVibeWorker:
    """
    BullMQ-based vibe embedding worker.

    Replaces the legacy BLPOP-based Worker class. Consumes jobs from
    'enrichment-vibe' (BullMQ queue) instead of polling 'audio:clap:queue'
    (raw Redis list). Runs asyncio event loop in a background thread so
    it does not block TextEmbedHandler or ControlHandler.

    Concurrency: controlled by NUM_WORKERS env var (default 2). Each job
    gets its own connection from a ThreadedConnectionPool, and all DB calls
    run via run_in_executor so they never block the asyncio event loop.
    CLAPAnalyzer._lock still serialises model inference; concurrency > 1
    allows pipeline parallelism (one job waiting on DB I/O while another
    runs inference).
    """

    def __init__(self, analyzer: CLAPAnalyzer, stop_event: threading.Event):
        self.analyzer = analyzer
        self.stop_event = stop_event
        self._redis_client = None
        self._db_pool = None  # psycopg2.pool.ThreadedConnectionPool

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

    async def _run(self):
        from bullmq import Worker as BullWorker

        self._redis_client = redis.from_url(REDIS_URL)

        # Thread-safe connection pool — each executor thread gets its own
        # connection so concurrent jobs never share a psycopg2 connection.
        pool_size = max(NUM_WORKERS * 2, 4)
        self._db_pool = psycopg2.pool.ThreadedConnectionPool(
            minconn=1,
            maxconn=pool_size,
            dsn=DATABASE_URL,
            options="-c client_encoding=UTF8",
        )
        logger.info(f"Connected to PostgreSQL (pool size: {pool_size})")

        bullmq_worker = BullWorker(
            VIBE_QUEUE_NAME,
            self._process_job,
            {
                "connection": REDIS_URL,
                "concurrency": NUM_WORKERS,
                "lockDuration": 300000,  # 5 min — CLAP inference can take 30–60s
            },
        )
        bullmq_worker.on("failed", lambda job, err: logger.error(
            f"[BullMQ] Job {job.id if job else '?'} failed: {err}"
        ))
        bullmq_worker.on("error", lambda err: logger.error(f"[BullMQ] Worker error: {err}"))

        try:
            while not self.stop_event.is_set():
                # Publish heartbeat — featureDetection checks this to enable vibe search.
                # Run in executor to avoid blocking the async event loop.
                try:
                    hb_loop = asyncio.get_running_loop()
                    hb_val = str(int(time.time() * 1000))
                    await hb_loop.run_in_executor(
                        None, lambda: self._redis_client.set("clap:worker:heartbeat", hb_val)
                    )
                except Exception:
                    pass
                await asyncio.sleep(30)
        finally:
            await bullmq_worker.close()
            if self._db_pool:
                self._db_pool.closeall()

    async def _process_job(self, job, job_token: str) -> dict:
        """BullMQ job processor — called for each enrichment-vibe job."""
        track_id = job.data.get("trackId")
        file_path = job.data.get("filePath", "")
        duration = job.data.get("duration")

        if not track_id:
            raise ValueError(f"Invalid job data (no trackId): {job.data}")

        logger.info(f"[BullMQ] Processing vibe for track: {track_id}")

        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, self._update_track_status, track_id, "processing")

        normalized_path = file_path.replace("\\", "/")
        full_path = os.path.join(MUSIC_PATH, normalized_path)

        try:
            file_size = os.path.getsize(full_path)
            if file_size == 0:
                await loop.run_in_executor(
                    None, self._mark_failed, track_id,
                    "Empty file (0 bytes) - likely incomplete download",
                )
                raise ValueError("Empty file")
        except OSError:
            await loop.run_in_executor(
                None, self._mark_failed, track_id, f"File not found: {normalized_path}"
            )
            raise

        embedding = await loop.run_in_executor(
            None, self.analyzer.get_audio_embedding, full_path, duration
        )

        await job.updateProgress(50)

        if embedding is None:
            await loop.run_in_executor(
                None, self._mark_failed, track_id, "Failed to generate embedding"
            )
            raise RuntimeError("Embedding generation failed")

        success = await loop.run_in_executor(None, self._store_embedding, track_id, embedding)

        if success:
            await loop.run_in_executor(None, self._update_track_status, track_id, "completed")
            await job.updateProgress(100)
            logger.info(f"[BullMQ] Completed vibe for track: {track_id}")
            return {"trackId": track_id, "status": "complete"}
        else:
            await loop.run_in_executor(
                None, self._mark_failed, track_id, "Failed to store embedding"
            )
            raise RuntimeError("Failed to store embedding")

    def _update_track_status(self, track_id: str, status: str):
        """Update the track's vibe analysis status (runs in executor thread)."""
        conn = self._db_pool.getconn()
        try:
            with conn.cursor() as cursor:
                cursor.execute(
                    'UPDATE "Track" SET "vibeAnalysisStatus" = %s WHERE id = %s',
                    (status, track_id),
                )
            conn.commit()
        except Exception as e:
            logger.error(f"Failed to update track vibe status: {e}")
            conn.rollback()
        finally:
            self._db_pool.putconn(conn)

    def _mark_failed(self, track_id: str, error: str):
        """Mark track as failed and record in enrichment failures (runs in executor thread)."""
        track_name = None
        conn = self._db_pool.getconn()
        try:
            with conn.cursor(cursor_factory=RealDictCursor) as cursor:
                cursor.execute('SELECT title FROM "Track" WHERE id = %s', (track_id,))
                row = cursor.fetchone()
                track_name = row['title'] if row else None
                cursor.execute(
                    """
                    UPDATE "Track"
                    SET
                        "vibeAnalysisStatus" = 'failed',
                        "vibeAnalysisError" = %s,
                        "vibeAnalysisRetryCount" = COALESCE("vibeAnalysisRetryCount", 0) + 1
                    WHERE id = %s
                    """,
                    (error[:500], track_id),
                )
            conn.commit()
            logger.error(f"Track {track_id} failed: {error}")
        except Exception as e:
            logger.error(f"Failed to mark track as failed: {e}")
            conn.rollback()
        finally:
            # Release connection before making the network call below
            self._db_pool.putconn(conn)

        # Report failure to backend enrichment failure service
        try:
            headers = {
                "Content-Type": "application/json",
                "X-Internal-Secret": os.getenv("INTERNAL_API_SECRET", "")
            }
            requests.post(
                f"{BACKEND_URL}/api/analysis/vibe/failure",
                json={
                    "trackId": track_id,
                    "trackName": track_name,
                    "errorMessage": error[:500],
                    "errorCode": "VIBE_EMBEDDING_FAILED"
                },
                headers=headers,
                timeout=5
            )
        except Exception as report_err:
            logger.warning(f"Failed to report failure to backend: {report_err}")

    def _store_embedding(self, track_id: str, embedding: np.ndarray) -> bool:
        """Store the embedding in track_embeddings (runs in executor thread)."""
        conn = self._db_pool.getconn()
        try:
            # pgvector type must be registered per-connection; idempotent on repeat calls
            register_vector(conn)
            embedding_list = embedding.tolist()
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    INSERT INTO track_embeddings (track_id, embedding, model_version, analyzed_at)
                    VALUES (%s, %s::vector, %s, %s)
                    ON CONFLICT (track_id)
                    DO UPDATE SET
                        embedding = EXCLUDED.embedding,
                        model_version = EXCLUDED.model_version,
                        analyzed_at = EXCLUDED.analyzed_at
                    """,
                    (track_id, embedding_list, MODEL_VERSION, datetime.utcnow()),
                )
            conn.commit()
            return True
        except Exception as e:
            logger.error(f"Failed to store embedding for {track_id}: {e}")
            traceback.print_exc()
            conn.rollback()
            return False
        finally:
            self._db_pool.putconn(conn)


class TextEmbedHandler:
    """
    Real-time text embedding handler via Redis pub/sub.

    Subscribes to text embedding requests and responds with embeddings
    for natural language vibe queries.
    """

    def __init__(self, analyzer: CLAPAnalyzer, stop_event: threading.Event):
        self.analyzer = analyzer
        self.stop_event = stop_event
        self.redis_client = None
        self.pubsub = None

    def start(self):
        """Start the text embed handler"""
        logger.info("TextEmbedHandler starting...")

        try:
            self.redis_client = redis.from_url(REDIS_URL)
            self.pubsub = self.redis_client.pubsub()
            self.pubsub.subscribe(TEXT_EMBED_CHANNEL)

            logger.info(f"Subscribed to channel: {TEXT_EMBED_CHANNEL}")

            while not self.stop_event.is_set():
                try:
                    message = self.pubsub.get_message(
                        ignore_subscribe_messages=True,
                        timeout=1.0
                    )

                    if message and message['type'] == 'message':
                        self._handle_message(message)

                except Exception as e:
                    logger.error(f"TextEmbedHandler error: {e}")
                    traceback.print_exc()
                    time.sleep(1)

        finally:
            if self.pubsub:
                self.pubsub.close()
            logger.info("TextEmbedHandler stopped")

    def _handle_message(self, message):
        """Handle a text embedding request"""
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
            logger.error(f"Failed to handle text embed request: {e}")
            traceback.print_exc()


class ControlHandler:
    """
    Handles control messages from Redis pub/sub.

    Listens for worker count changes and other control commands.
    Note: Worker count changes require a container restart to take effect.
    """

    def __init__(self, stop_event: threading.Event):
        self.stop_event = stop_event
        self.redis_client = None
        self.pubsub = None

    def start(self):
        """Start listening for control messages"""
        logger.info("ControlHandler starting...")

        try:
            self.redis_client = redis.from_url(REDIS_URL)
            self.pubsub = self.redis_client.pubsub()
            self.pubsub.subscribe(CONTROL_CHANNEL)
            logger.info(f"Subscribed to control channel: {CONTROL_CHANNEL}")

            while not self.stop_event.is_set():
                try:
                    message = self.pubsub.get_message(
                        ignore_subscribe_messages=True,
                        timeout=1.0
                    )

                    if message and message['type'] == 'message':
                        self._handle_message(message)

                except Exception as e:
                    logger.error(f"ControlHandler error: {e}")
                    traceback.print_exc()
                    time.sleep(1)

        finally:
            if self.pubsub:
                self.pubsub.close()
            logger.info("ControlHandler stopped")

    def _handle_message(self, message):
        """Handle a control message"""
        try:
            data = message['data']
            if isinstance(data, bytes):
                data = data.decode('utf-8')

            control = json.loads(data)
            command = control.get('command')

            if command == 'set_workers':
                new_count = control.get('count', NUM_WORKERS)
                logger.info(f"Received worker count change request: {NUM_WORKERS} -> {new_count}")
                logger.info("Note: Restart the CLAP analyzer container to apply the new worker count")
            elif command == 'stop':
                logger.info("Received stop command — signalling worker threads to stop")
                self.stop_event.set()
            else:
                logger.warning(f"Unknown control command: {command}")

        except Exception as e:
            logger.error(f"Failed to handle control message: {e}")
            traceback.print_exc()


def main():
    """Main entry point"""
    logger.info("=" * 60)
    logger.info("CLAP Audio Analyzer Service")
    logger.info("=" * 60)
    logger.info(f"  Model version: {MODEL_VERSION}")
    logger.info(f"  Music path: {MUSIC_PATH}")
    logger.info(f"  Num workers: {NUM_WORKERS}")
    logger.info(f"  Threads per worker: {THREADS_PER_WORKER}")
    logger.info(f"  Sleep interval: {SLEEP_INTERVAL}s")
    logger.info(f"  Model idle timeout: {MODEL_IDLE_TIMEOUT}s")
    logger.info("=" * 60)

    # Model is shared across all workers but loaded lazily on first job
    # (ensure_model() is called automatically when work arrives).
    # This avoids ~20s of CPU-heavy model loading at startup when audio
    # analysis hasn't finished yet and there's no CLAP work to do.
    analyzer = CLAPAnalyzer()

    # Stop event for graceful shutdown
    stop_event = threading.Event()

    def signal_handler(signum, frame):
        logger.info(f"Received signal {signum}, initiating graceful shutdown...")
        stop_event.set()

    signal.signal(signal.SIGTERM, signal_handler)
    signal.signal(signal.SIGINT, signal_handler)

    threads = []

    # Start BullMQ vibe worker (runs asyncio event loop in its own thread)
    bullmq_worker = BullMQVibeWorker(analyzer, stop_event)
    bullmq_thread = threading.Thread(target=bullmq_worker.start, name="BullMQVibeWorker")
    bullmq_thread.daemon = True
    bullmq_thread.start()
    threads.append(bullmq_thread)
    logger.info("Started BullMQ vibe worker thread")

    # Start text embed handler thread
    text_handler = TextEmbedHandler(analyzer, stop_event)
    text_thread = threading.Thread(target=text_handler.start, name="TextEmbedHandler")
    text_thread.daemon = True
    text_thread.start()
    threads.append(text_thread)
    logger.info("Started text embed handler thread")

    # Start control handler thread (listens for worker count changes)
    control_handler = ControlHandler(stop_event)
    control_thread = threading.Thread(target=control_handler.start, name="ControlHandler")
    control_thread.daemon = True
    control_thread.start()
    threads.append(control_thread)
    logger.info("Started control handler thread")

    # Main loop: monitor idle state and unload model when not needed
    idle_db = DatabaseConnection(DATABASE_URL)
    idle_db.connect()
    try:
        while not stop_event.is_set():
            time.sleep(5)
            if analyzer._model_loaded:
                idle_seconds = time.time() - analyzer.last_work_time
                if idle_seconds >= MODEL_IDLE_TIMEOUT > 0:
                    analyzer.unload_model()
                    logger.info(f"Model idle for {idle_seconds:.0f}s, unloaded to free memory (will reload when work arrives)")
                elif idle_seconds >= SLEEP_INTERVAL * 2:
                    # Check if all work is truly done -- unload immediately
                    try:
                        cursor = idle_db.get_cursor()
                        cursor.execute("""
                            SELECT COUNT(*) as cnt FROM "Track" t
                            LEFT JOIN track_embeddings te ON t.id = te.track_id
                            WHERE te.track_id IS NULL AND t."filePath" IS NOT NULL
                        """)
                        remaining = cursor.fetchone()['cnt']
                        cursor.close()
                        if remaining == 0:
                            analyzer.unload_model()
                            logger.info("All tracks have embeddings, model unloaded (will reload when work arrives)")
                    except Exception as e:
                        logger.debug(f"Idle check failed: {e}")
                        idle_db.reconnect()
    except KeyboardInterrupt:
        logger.info("Keyboard interrupt received")
        stop_event.set()

    # Cleanup
    idle_db.close()

    # Wait for threads to finish
    logger.info("Waiting for threads to finish...")
    for thread in threads:
        thread.join(timeout=10)

    logger.info("CLAP Analyzer service stopped")


if __name__ == '__main__':
    main()
