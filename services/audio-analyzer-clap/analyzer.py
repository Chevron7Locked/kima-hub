#!/usr/bin/env python3
"""
CLAP Audio Analyzer Service - LAION CLAP embeddings for vibe similarity

This service processes audio files and generates 1024-dimensional embeddings
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
- Worker: Queue consumer that processes tracks and stores embeddings
- TextEmbedHandler: Real-time text embedding via Redis pub/sub
"""

import os
import sys
import signal
import json
import time
import logging
import threading
from datetime import datetime
from typing import Optional, Tuple
import traceback
import numpy as np
import librosa

# CPU thread limiting must be set before importing torch
THREADS_PER_WORKER = int(os.getenv('THREADS_PER_WORKER', '1'))
os.environ['OMP_NUM_THREADS'] = str(THREADS_PER_WORKER)
os.environ['OPENBLAS_NUM_THREADS'] = str(THREADS_PER_WORKER)
os.environ['MKL_NUM_THREADS'] = str(THREADS_PER_WORKER)
os.environ['NUMEXPR_MAX_THREADS'] = str(THREADS_PER_WORKER)

import torch
torch.set_num_threads(THREADS_PER_WORKER)

import redis
import psycopg2
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

# Queue and channel names
ANALYSIS_QUEUE = 'audio:analysis:queue'
TEXT_EMBED_CHANNEL = 'audio:text:embed'
TEXT_EMBED_RESPONSE_PREFIX = 'audio:text:embed:response:'
CONTROL_CHANNEL = 'audio:clap:control'

# Model version identifier
MODEL_VERSION = 'laion-clap-music-v1'

# Large file handling: files above this size (bytes) will be chunked
LARGE_FILE_THRESHOLD = 50 * 1024 * 1024  # 50MB
# Duration to extract from large files (seconds)
CHUNK_DURATION = 60  # 60 seconds from the middle
# Sample rate for CLAP model (48kHz)
CLAP_SAMPLE_RATE = 48000


class CLAPAnalyzer:
    """
    LAION CLAP model wrapper for generating audio and text embeddings.

    Uses HTSAT-base architecture with the music_audioset checkpoint,
    optimized for music similarity tasks.
    """

    def __init__(self):
        self.model = None
        self._lock = threading.Lock()

    def load_model(self):
        """Load the CLAP model (call once, share across workers)"""
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

            # Move to CPU explicitly (we don't use GPU in this service)
            self.model = self.model.eval()

            logger.info("CLAP model loaded successfully")
        except Exception as e:
            logger.error(f"Failed to load CLAP model: {e}")
            traceback.print_exc()
            raise

    def _load_audio_chunk(self, audio_path: str) -> Tuple[Optional[np.ndarray], int]:
        """
        Load audio from a file, handling large files by extracting a middle chunk.

        For files larger than LARGE_FILE_THRESHOLD, only loads CHUNK_DURATION seconds
        from the middle of the file to reduce memory usage.

        Args:
            audio_path: Path to the audio file

        Returns:
            Tuple of (audio_array, sample_rate) or (None, 0) on error
        """
        file_size = os.path.getsize(audio_path)
        is_large = file_size > LARGE_FILE_THRESHOLD

        if is_large:
            logger.info(f"Large file detected ({file_size / (1024*1024):.1f}MB), loading middle {CHUNK_DURATION}s chunk")

        try:
            if is_large:
                # For large files, first get duration without loading audio
                duration = librosa.get_duration(path=audio_path)

                if duration > CHUNK_DURATION:
                    # Calculate middle offset
                    offset = (duration - CHUNK_DURATION) / 2
                    logger.info(f"File duration: {duration:.1f}s, extracting from {offset:.1f}s")

                    # Load only the middle chunk at CLAP's expected sample rate
                    audio, sr = librosa.load(
                        audio_path,
                        sr=CLAP_SAMPLE_RATE,
                        offset=offset,
                        duration=CHUNK_DURATION,
                        mono=True
                    )
                else:
                    # File is long enough in size but short in duration, load all
                    audio, sr = librosa.load(audio_path, sr=CLAP_SAMPLE_RATE, mono=True)
            else:
                # Small file, load normally
                audio, sr = librosa.load(audio_path, sr=CLAP_SAMPLE_RATE, mono=True)

            return audio, sr

        except Exception as e:
            logger.error(f"Failed to load audio from {audio_path}: {e}")
            traceback.print_exc()
            return None, 0

    def get_audio_embedding(self, audio_path: str) -> Optional[np.ndarray]:
        """
        Generate a 1024-dimensional embedding from an audio file.

        For large files (>50MB), only processes the middle 60 seconds to
        reduce memory usage while still capturing the track's vibe.

        Args:
            audio_path: Path to the audio file

        Returns:
            numpy array of shape (1024,) or None on error
        """
        if self.model is None:
            raise RuntimeError("Model not loaded. Call load_model() first.")

        if not os.path.exists(audio_path):
            logger.error(f"Audio file not found: {audio_path}")
            return None

        try:
            # Load audio (with chunking for large files)
            audio, sr = self._load_audio_chunk(audio_path)

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

                # Result is shape (1, 512) for base model, normalized
                embedding = embeddings[0]

                # Verify embedding dimension
                if embedding.shape[0] != 512:
                    logger.warning(f"Unexpected embedding dimension: {embedding.shape}")

                # CLAP base model outputs 512-dim, but we need 1024 for our schema
                # Pad with zeros to match the expected dimension
                if embedding.shape[0] < 1024:
                    padded = np.zeros(1024, dtype=np.float32)
                    padded[:embedding.shape[0]] = embedding
                    embedding = padded

                return embedding.astype(np.float32)

        except Exception as e:
            logger.error(f"Failed to generate audio embedding for {audio_path}: {e}")
            traceback.print_exc()
            return None

    def get_text_embedding(self, text: str) -> Optional[np.ndarray]:
        """
        Generate a 1024-dimensional embedding from a text query.

        Args:
            text: Natural language description (e.g., "upbeat electronic dance music")

        Returns:
            numpy array of shape (1024,) or None on error
        """
        if self.model is None:
            raise RuntimeError("Model not loaded. Call load_model() first.")

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

                # Pad to 1024 dimensions if needed
                if embedding.shape[0] < 1024:
                    padded = np.zeros(1024, dtype=np.float32)
                    padded[:embedding.shape[0]] = embedding
                    embedding = padded

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


class Worker:
    """
    Queue worker that processes audio files and stores embeddings.

    Polls the Redis queue for jobs, generates CLAP embeddings,
    and stores results in PostgreSQL.
    """

    def __init__(self, worker_id: int, analyzer: CLAPAnalyzer, stop_event: threading.Event):
        self.worker_id = worker_id
        self.analyzer = analyzer
        self.stop_event = stop_event
        self.redis_client = None
        self.db = None

    def start(self):
        """Start the worker loop"""
        logger.info(f"Worker {self.worker_id} starting...")

        try:
            self.redis_client = redis.from_url(REDIS_URL)
            self.db = DatabaseConnection(DATABASE_URL)
            self.db.connect()

            while not self.stop_event.is_set():
                try:
                    self._process_job()
                except psycopg2.Error as e:
                    logger.error(f"Worker {self.worker_id} database error: {e}")
                    traceback.print_exc()
                    self.db.reconnect()
                    time.sleep(SLEEP_INTERVAL)
                except Exception as e:
                    logger.error(f"Worker {self.worker_id} error: {e}")
                    traceback.print_exc()
                    time.sleep(SLEEP_INTERVAL)

        finally:
            if self.db:
                self.db.close()
            logger.info(f"Worker {self.worker_id} stopped")

    def _process_job(self):
        """Process a single job from the queue"""
        # Try to get a job from the queue (blocking with timeout)
        job_data = self.redis_client.blpop(ANALYSIS_QUEUE, timeout=SLEEP_INTERVAL)

        if not job_data:
            return

        _, raw_job = job_data
        job = json.loads(raw_job)

        track_id = job.get('trackId')
        file_path = job.get('filePath', '')

        if not track_id:
            logger.warning(f"Invalid job (no trackId): {job}")
            return

        logger.info(f"Worker {self.worker_id} processing track: {track_id}")

        # Update track status to processing
        self._update_track_status(track_id, 'processing')

        # Build full path (normalize Windows-style paths)
        normalized_path = file_path.replace('\\', '/')
        full_path = os.path.join(MUSIC_PATH, normalized_path)

        # Generate embedding
        embedding = self.analyzer.get_audio_embedding(full_path)

        if embedding is None:
            self._mark_failed(track_id, "Failed to generate embedding")
            return

        # Store embedding in database
        success = self._store_embedding(track_id, embedding)

        if success:
            self._update_track_status(track_id, 'completed')
            logger.info(f"Worker {self.worker_id} completed track: {track_id}")
        else:
            self._mark_failed(track_id, "Failed to store embedding")

    def _update_track_status(self, track_id: str, status: str):
        """Update the track's analysis status"""
        cursor = self.db.get_cursor()
        try:
            cursor.execute("""
                UPDATE "Track"
                SET "analysisStatus" = %s
                WHERE id = %s
            """, (status, track_id))
            self.db.commit()
        except Exception as e:
            logger.error(f"Failed to update track status: {e}")
            self.db.rollback()
        finally:
            cursor.close()

    def _mark_failed(self, track_id: str, error: str):
        """Mark track as failed"""
        cursor = self.db.get_cursor()
        try:
            cursor.execute("""
                UPDATE "Track"
                SET
                    "analysisStatus" = 'failed',
                    "analysisError" = %s,
                    "analysisRetryCount" = COALESCE("analysisRetryCount", 0) + 1
                WHERE id = %s
            """, (error[:500], track_id))
            self.db.commit()
            logger.error(f"Track {track_id} failed: {error}")
        except Exception as e:
            logger.error(f"Failed to mark track as failed: {e}")
            self.db.rollback()
        finally:
            cursor.close()

    def _store_embedding(self, track_id: str, embedding: np.ndarray) -> bool:
        """Store the embedding in the track_embeddings table"""
        cursor = self.db.get_cursor()
        try:
            # Convert numpy array to list for pgvector
            embedding_list = embedding.tolist()

            cursor.execute("""
                INSERT INTO track_embeddings (track_id, embedding, model_version, analyzed_at)
                VALUES (%s, %s::vector, %s, %s)
                ON CONFLICT (track_id)
                DO UPDATE SET
                    embedding = EXCLUDED.embedding,
                    model_version = EXCLUDED.model_version,
                    analyzed_at = EXCLUDED.analyzed_at
            """, (track_id, embedding_list, MODEL_VERSION, datetime.utcnow()))

            self.db.commit()
            return True

        except Exception as e:
            logger.error(f"Failed to store embedding for {track_id}: {e}")
            traceback.print_exc()
            self.db.rollback()
            return False
        finally:
            cursor.close()


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
    logger.info("=" * 60)

    # Load model once (shared across all workers)
    analyzer = CLAPAnalyzer()
    analyzer.load_model()

    # Stop event for graceful shutdown
    stop_event = threading.Event()

    def signal_handler(signum, frame):
        logger.info(f"Received signal {signum}, initiating graceful shutdown...")
        stop_event.set()

    signal.signal(signal.SIGTERM, signal_handler)
    signal.signal(signal.SIGINT, signal_handler)

    threads = []

    # Start worker threads
    for i in range(NUM_WORKERS):
        worker = Worker(i, analyzer, stop_event)
        thread = threading.Thread(target=worker.start, name=f"Worker-{i}")
        thread.daemon = True
        thread.start()
        threads.append(thread)
        logger.info(f"Started worker thread {i}")

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

    # Wait for shutdown signal
    try:
        while not stop_event.is_set():
            time.sleep(1)
    except KeyboardInterrupt:
        logger.info("Keyboard interrupt received")
        stop_event.set()

    # Wait for threads to finish
    logger.info("Waiting for threads to finish...")
    for thread in threads:
        thread.join(timeout=10)

    logger.info("CLAP Analyzer service stopped")


if __name__ == '__main__':
    main()
