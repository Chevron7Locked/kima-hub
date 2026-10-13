#!/usr/bin/env python3
"""
Essentia audio analyzer: BPM, key, loudness and energy from Essentia; moods,
valence/arousal and danceability from the MusiCNN models (ONNX Runtime, CPU or
GPU). Without the models no track is analysed. Jobs arrive over Redis; results go
to PostgreSQL.
"""

# Thread limits are read by the numeric libraries when they load, so they are set
# before anything imports them.
import os
import sys

THREADS_PER_WORKER = int(os.getenv('THREADS_PER_WORKER', '1'))
os.environ['OMP_NUM_THREADS'] = str(THREADS_PER_WORKER)
os.environ['OPENBLAS_NUM_THREADS'] = str(THREADS_PER_WORKER)
os.environ['MKL_NUM_THREADS'] = str(THREADS_PER_WORKER)
os.environ['NUMEXPR_MAX_THREADS'] = str(THREADS_PER_WORKER)

import json
import re
import time
import logging
import gc
from typing import Dict, Any, Optional, List, Tuple
import subprocess
import threading
import numpy as np
from concurrent.futures import FIRST_COMPLETED, ProcessPoolExecutor, wait
import multiprocessing

from concurrent.futures.process import BrokenProcessPool

# Workers start fresh (spawn): a CUDA context does not survive fork.
try:
    multiprocessing.set_start_method('spawn', force=True)
except RuntimeError:
    pass  # Already set

import redis
import psycopg2
from psycopg2.extras import RealDictCursor

# Failure classes live in classifier.py (pure stdlib), which the backend
# mirrors. Decode errors are tagged with their class here so the message the
# analyzer reports carries the signature the backend's classifier reads.
from classifier import (
    classify_failure,
    tag_error,
    Disposition,
)
from musicnn_onnx import PATCH_SECONDS
import gpu_switch

# True when the wrapper started this process with the GPU runtime ("GPU for audio analysis" on and the
# runtime installed).
GPU_ANALYSIS = gpu_switch.started_with_runtime()

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger('audio-analyzer')

# Essentia imports (will fail gracefully if not installed for testing)
ESSENTIA_AVAILABLE = False
try:
    import essentia
    # Suppress Essentia's internal "No network created" warnings that spam logs
    essentia.log.warningActive = False
    essentia.log.infoActive = False
    import essentia.standard as es
    ESSENTIA_AVAILABLE = True
except ImportError as e:
    logger.warning(f"Essentia not available: {e}")


# Configuration from environment
REDIS_URL = os.getenv('REDIS_URL', 'redis://localhost:6379')
DATABASE_URL = os.getenv('DATABASE_URL', '')
MUSIC_PATH = os.getenv('MUSIC_PATH', '/music')
# A track still running after this long has a stuck worker; the pool restarts.
JOB_TIMEOUT_S = 900
# Below this much audio, or below this peak (-80 dBFS), nothing here measures anything real: silence
# still reads as a tempo, a key and a mood. 3 s, and never less than the one patch MusiCNN needs.
MIN_ANALYZE_SECONDS = max(3.0, PATCH_SECONDS)
# A stage job id ends in its claim: <key>-<attempt>-r<redelivered> (backend `claimOf`).
CLAIM_IN_JOB_ID = re.compile(r'-(\d+)-r(\d+)$')
SILENCE_PEAK = 10 ** (-80 / 20)

# How long to block waiting for work, in seconds (at least 5).
BRPOP_TIMEOUT = max(5, int(os.getenv('BRPOP_TIMEOUT', '5')))

# Idle timeout before unloading ML models from memory (seconds)
# Models are reloaded automatically when new work arrives
MODEL_IDLE_TIMEOUT = int(os.getenv('MODEL_IDLE_TIMEOUT', '300'))

# Debounce delay for worker resize (seconds) -- prevents pool churn when user drags a slider
RESIZE_DEBOUNCE_SECONDS = 5


class DatabaseConnection:
    """PostgreSQL connection manager"""

    def __init__(self, url: str):
        self.url = url
        self.conn = None

    def connect(self):
        """Establish database connection with explicit UTF-8 encoding"""
        if not self.url:
            raise ValueError("DATABASE_URL not set")

        self.conn = psycopg2.connect(
            self.url,
            options="-c client_encoding=UTF8 -c timezone=UTC",
            application_name="audio-analyzer",
        )
        self.conn.set_client_encoding('UTF8')
        self.conn.autocommit = False
        logger.info("Connected to PostgreSQL with UTF-8 encoding")

    def get_cursor(self):
        """Get a database cursor"""
        if not self.conn:
            self.connect()
        return self.conn.cursor(cursor_factory=RealDictCursor)

    def commit(self):
        """Commit transaction"""
        if self.conn:
            self.conn.commit()

    def rollback(self):
        """Rollback transaction"""
        if self.conn:
            self.conn.rollback()

    def close(self):
        """Close connection"""
        if self.conn:
            self.conn.close()
            self.conn = None


def _clamp_workers(count: int) -> int:
    """A worker count between one and the machine's cores."""
    return max(1, min(os.cpu_count() or 8, count))


DEFAULT_WORKERS = 2


def _get_workers_from_db() -> int:
    """
    Fetch worker count from SystemSettings table.
    Falls back to env var or default if database query fails.
    """
    try:
        db = DatabaseConnection(DATABASE_URL)
        db.connect()
        cursor = db.get_cursor()

        cursor.execute("""
            SELECT "audioAnalyzerWorkers"
            FROM "SystemSettings"
            WHERE id = 'default'
            LIMIT 1
        """)

        result = cursor.fetchone()
        cursor.close()
        db.close()

        if result and result['audioAnalyzerWorkers'] is not None:
            workers = _clamp_workers(int(result['audioAnalyzerWorkers']))
            logger.info(f"Loaded worker count from database: {workers}")
            return workers
        logger.info("No worker count found in database, using env var or default")
        return int(os.getenv('NUM_WORKERS', str(DEFAULT_WORKERS)))

    except Exception as e:
        logger.warning(f"Failed to fetch worker count from database: {e}")
        logger.info("Falling back to env var or default")
        return int(os.getenv('NUM_WORKERS', str(DEFAULT_WORKERS)))


# The settings page's count first, then the NUM_WORKERS environment variable, then the default.
NUM_WORKERS = _get_workers_from_db()
# Bump when stored features change meaning, with a migration that asks every older answer again.
ESSENTIA_VERSION = '2.1b6-enhanced-v4'

# Seconds to allow the single ffmpeg decode before giving up on the track; the decode is also
# the integrity check.
DECODE_TIMEOUT = int(os.getenv('DECODE_TIMEOUT', '120'))

ANALYSIS_QUEUE = 'audio:analysis:queue'

# Control channel for enrichment coordination
CONTROL_CHANNEL = 'audio:analysis:control'

# Model paths (pre-packaged in Docker image)
MODEL_DIR = '/app/models'

# MusiCNN and its heads, converted to ONNX at image build (convert_musicnn.py) from
# Essentia's published models (essentia.upf.edu/models/). voice_instrumental is not
# used: a broken head; CLAP zero-shot answers instrumentalness.
MUSICNN_GRAPH = os.path.join(MODEL_DIR, 'msd-musicnn-1.onnx')

# Output column order of each head, from the "classes" field of Essentia's model
# metadata (essentia.upf.edu/models/classification-heads/<head>/). The positive
# class is first for some heads and second for others.
HEAD_CLASSES = {
    'mood_happy': ['happy', 'non_happy'],
    'mood_sad': ['non_sad', 'sad'],
    'mood_relaxed': ['non_relaxed', 'relaxed'],
    'mood_aggressive': ['aggressive', 'not_aggressive'],
    'mood_party': ['non_party', 'party'],
    'mood_acoustic': ['acoustic', 'non_acoustic'],
    'mood_electronic': ['electronic', 'non_electronic'],
    'danceability': ['danceable', 'not_danceable'],
}
HEAD_POSITIVE_CLASS = {
    'mood_happy': 'happy',
    'mood_sad': 'sad',
    'mood_relaxed': 'relaxed',
    'mood_aggressive': 'aggressive',
    'mood_party': 'party',
    'mood_acoustic': 'acoustic',
    'mood_electronic': 'electronic',
    'danceability': 'danceable',
}


def positive_class_index(head: str) -> int:
    """Column of the head's softmax output that holds P(positive class)."""
    return HEAD_CLASSES[head].index(HEAD_POSITIVE_CLASS[head])


ML_MODELS_AVAILABLE = os.path.exists(MUSICNN_GRAPH)
if not ML_MODELS_AVAILABLE:
    logger.error(f"MusiCNN graph not found at {MUSICNN_GRAPH}: tracks cannot be analysed")


def _record_gpu_provider(active: bool) -> None:
    """Tell the settings page whether analysis sessions actually got the GPU, on every start.
    An earlier start's answer is removed first, so a failed write leaves no answer rather than
    a stale one. Without the GPU runtime's folder there is nothing to report."""
    folder = os.path.join(os.getenv('DATA_DIR', '/data'), 'gpu-onnx')
    if not os.path.isdir(folder):
        return
    path = os.path.join(folder, 'analysis-provider.json')
    try:
        if os.path.exists(path):
            os.remove(path)
        tmp = f"{path}.{os.getpid()}.tmp"
        with open(tmp, 'w') as f:
            json.dump({'active': bool(active), 'measured': GPU_ANALYSIS}, f)
        os.replace(tmp, path)
    except OSError as e:
        logger.warning(f"Could not record the analysis GPU provider: {e}")


def _source_stream(file_path: str) -> Tuple[int, Optional[float]]:
    """Channels of the first audio stream (2 when the probe cannot tell) and the
    file's length in seconds (None when it cannot tell)."""
    try:
        out = subprocess.run(
            ['ffprobe', '-v', 'error', '-select_streams', 'a:0',
             '-show_entries', 'stream=channels:format=duration', '-of', 'json', file_path],
            stdin=subprocess.DEVNULL, capture_output=True, timeout=DECODE_TIMEOUT,
        )
        if out.returncode != 0:
            raise RuntimeError(out.stderr.decode('utf-8', 'replace').strip() or f"exit {out.returncode}")
        probe = json.loads(out.stdout or b'{}')
    except Exception as e:
        logger.warning(f"Could not probe {file_path} ({e}); decoding it as stereo, whole")
        return 2, None
    streams = probe.get('streams') or [{}]
    channels = 1 if streams[0].get('channels') == 1 else 2
    try:
        length = float(probe.get('format', {}).get('duration'))
    except (TypeError, ValueError):
        length = None
    return channels, length


def _ffmpeg_command(file_path: str, channels: int, start: Optional[float]) -> List[str]:
    """ffmpeg reading the first audio stream from `start` (the beginning when None) to its end, as
    interleaved 16-bit PCM at 44.1 kHz."""
    seek = [] if start is None else ['-ss', f'{start:.3f}']
    return [
        'ffmpeg', '-nostdin', '-v', 'error',
        '-err_detect', 'ignore_err',
        *seek,
        '-i', file_path,
        '-map', '0:a:0', '-vn', '-sn', '-dn',
        '-ac', str(channels), '-ar', '44100',
        '-c:a', 'pcm_s16le',
        '-f', 's16le', '-',
    ]


def _run_decode(command: List[str], keep_last_bytes: int) -> Tuple[bytes, int, str, Optional[str]]:
    """Run one ffmpeg decode within DECODE_TIMEOUT: ``(pcm, rc, stderr, failure)``. The output
    is read as it comes and only its last `keep_last_bytes` kept, so a whole file is never held
    in memory."""
    try:
        proc = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except Exception as e:  # missing ffmpeg, spawn failure
        return b'', -1, '', f"decode command failed: {e}"
    timer = threading.Timer(DECODE_TIMEOUT, proc.kill)
    stderr_chunks: List[bytes] = []
    drain = threading.Thread(target=lambda: stderr_chunks.append(proc.stderr.read()), daemon=True)
    timer.start()
    drain.start()
    try:
        tail = bytearray()
        for chunk in iter(lambda: proc.stdout.read(1 << 20), b''):
            tail += chunk
            if len(tail) > 2 * keep_last_bytes:
                del tail[:len(tail) - keep_last_bytes]
        raw = bytes(tail[-keep_last_bytes:])
        rc = proc.wait()
        drain.join()
    finally:
        timed_out = not timer.is_alive() and proc.returncode is not None and proc.returncode < 0
        timer.cancel()
    stderr_text = b''.join(stderr_chunks).decode('utf-8', 'replace').strip()
    if timed_out:
        return b'', rc, stderr_text, f"decode command failed: timed out after {DECODE_TIMEOUT} s"
    return raw, rc, stderr_text, None


def _decode_to_stereo(file_path: str, duration: int = 90):
    """Decode the last ``duration`` seconds of the first audio stream (the whole song when it is
    shorter), skipping bad frames rather than failing. Songs build toward their end, so that is
    the part analysed. The decode seeks ``duration`` seconds before the header's length and runs
    to the real end, so a header that understates the length still yields the true end; one that
    overstates it (a cut-short download) gives a short read and the whole file is read instead.
    A mono source stays one channel (ffmpeg's upmix would lower it 3 dB); wider becomes stereo.

    Returns ``(samples, sample_rate, channels, duration, command, rc, stderr, class)``: samples
    is ``(channels, n)`` float32 or None, class the ``classify_failure`` disposition of what
    ffmpeg reported.
    """
    channels, length = _source_stream(file_path)
    frame_bytes = 2 * channels
    keep = int(duration * 44100) * frame_bytes
    start = None if length is None or length <= duration else length - duration
    command = _ffmpeg_command(file_path, channels, start)
    raw, rc, stderr_text, failure = _run_decode(command, keep_last_bytes=keep)
    if failure is None and start is not None and len(raw) < (duration - 1.0) * 44100 * frame_bytes:
        # The file holds less audio than its header says: the seek overshot.
        command = _ffmpeg_command(file_path, channels, None)
        raw, rc, stderr_text, failure = _run_decode(command, keep_last_bytes=keep)
    if failure is not None:
        return (None, 44100, 0, 0.0, command, -1, failure, classify_failure(failure))

    if raw:
        samples = np.frombuffer(raw, dtype='<i2')
        samples = samples[:samples.size - samples.size % channels]  # truncated final frame
        # s16le is interleaved (left, right, left, right ...).
        decoded = np.ascontiguousarray(samples.reshape(-1, channels).T, dtype=np.float32) / np.float32(32768.0)
        window = decoded.shape[1] / 44100.0
        # Samples arrived: analyse them. A logged decode error with usable
        # output is a bad frame we tolerate, not a failure.
        cls = classify_failure(stderr_text) if stderr_text else Disposition.INCONCLUSIVE
        return (decoded, 44100, channels, window, command, rc, stderr_text, cls)

    # Nothing decoded. The last stderr line is the honest failure reason;
    # classify it so a truly damaged file gets a terminal disposition
    # instead of three identical retries.
    lines = stderr_text.splitlines() if stderr_text else []
    detail = lines[-1] if lines else f"ffmpeg produced no samples (exit {rc})"
    return (None, 44100, 0, 0.0, command, rc, detail,
            classify_failure(detail))


class AudioAnalyzer:
    """
    Audio analysis: Essentia's signal measures and the MusiCNN models' moods,
    valence/arousal and danceability. Without the models a track is not analysed:
    no hand-made estimate stands in for them.

    ``musicnn_server`` is the main process's MusicnnServer address when the GPU runs
    MusiCNN for every worker; without it MusiCNN runs here on the CPU.
    """

    def __init__(self, musicnn_server=None):
        self.enhanced_mode = False  # the models are loaded and every head is there
        self.models_error: Optional[str] = None  # why not, when they are not
        self.musicnn_model = None  # Base MusiCNN model
        self.prediction_models = {}  # Classification head models
        self._last_load_error: Optional[str] = None

        if ESSENTIA_AVAILABLE:
            self._init_essentia()
            self._load_ml_models(musicnn_server)

    def _init_essentia(self):
        """Initialize Essentia algorithms for basic feature extraction"""
        # Basic feature extractors (always available)
        self.rhythm_extractor = es.RhythmExtractor2013(method="multifeature")
        self.key_extractor = es.KeyExtractor()
        # EBU R128: integrated loudness (LUFS) and loudness range (LU).
        self.loudness_ebu = es.LoudnessEBUR128(sampleRate=44100)
        self.rms = es.RMS()
        self.resampler = es.Resample(inputSampleRate=44100, outputSampleRate=16000)

        logger.info("Essentia basic algorithms initialized")

    def _load_ml_models(self, musicnn_server=None):
        """Load MusiCNN and its heads: HEAD_CLASSES' and the two valence/arousal
        regressions. Without all of them, `models_error` says why and no track is
        analysed."""
        if not ML_MODELS_AVAILABLE:
            self.models_error = f'MusiCNN graph not found at {MUSICNN_GRAPH}'
            return
        try:
            from musicnn_onnx import MusicnnOnnx
            models = MusicnnOnnx(MODEL_DIR, use_gpu=False, threads=THREADS_PER_WORKER, server=musicnn_server)
        except Exception as e:
            self.models_error = f'MusiCNN models failed to load: {e}'
            logger.error(self.models_error)
            return
        self.musicnn_model = models.embeddings
        for head in models.heads():
            if head in HEAD_CLASSES or head in ('deam', 'emomusic'):
                self.prediction_models[head] = (lambda name: lambda embeddings: models.predict(name, embeddings))(head)
        logger.info(f"MusiCNN on {'the GPU (main process)' if models.on_gpu else 'CPU'}, {len(self.prediction_models)} heads")
        missing = [m for m in [*HEAD_CLASSES, 'deam', 'emomusic'] if m not in self.prediction_models]
        self.enhanced_mode = not missing
        if missing:
            self.models_error = f'MusiCNN heads missing: {missing}'
            logger.error(self.models_error)

    def load_audio(self, file_path: str, max_duration: int = 90) -> Optional[np.ndarray]:
        """The last max_duration seconds at 44.1 kHz, ``(channels, n)``: the decode from
        _decode_to_stereo. The decode is the only integrity check; a file with a logged
        bad frame is analysed.
        """
        self._last_load_error = None
        if not ESSENTIA_AVAILABLE:
            return None

        (samples, _, channels, window,
         command, rc, stderr, cls) = _decode_to_stereo(
            file_path, duration=max_duration)
        if samples is None:
            logger.error(f"Decode failed for {file_path}: {stderr}")
            self._last_load_error = tag_error(stderr, cls, "unknown")
            return None
        if rc != 0:
            # Tolerant decode: samples arrived despite ffmpeg reporting a
            # bad frame -- analyse them, keep the evidence in the log.
            logger.warning(
                f"Decoded {file_path} with errors (rc={rc}): {stderr[-160:]}"
            )
        return samples

    def analyze(self, file_path: str) -> Dict[str, Any]:
        """
        Analyze audio file and extract all features.

        Loads audio once at 44.1kHz, resamples in-memory to 16kHz for the models.
        """
        result = {
            'bpm': None,
            'beatsCount': None,
            'key': None,
            'keyScale': None,
            'keyStrength': None,
            'energy': None,
            'loudness': None,
            'dynamicRange': None,
            'danceability': None,
            'valence': None,
            'arousal': None,
            'instrumentalness': None,  # instrumentalness and acousticness come from CLAP zero-shot
            'acousticness': None,
            'moodTags': [],
            'moodHappy': None,
            'moodSad': None,
            'moodRelaxed': None,
            'moodAggressive': None,
            'moodParty': None,
            'moodAcoustic': None,
            'moodElectronic': None,
            'danceabilityMl': None,
            'essentiaGenres': [],
            'analysisMode': None,
        }

        if not ESSENTIA_AVAILABLE:
            logger.error("Essentia not available - cannot analyze audio files")
            result['_error'] = 'Essentia library not installed'
            return result
        if not self.enhanced_mode:
            # The track fails and is retried; it is never stored without the models' answers.
            result['_error'] = self.models_error or 'MusiCNN models not loaded'
            return result

        MAX_ANALYZE_SECONDS = int(os.getenv('MAX_ANALYZE_SECONDS', '90'))
        try:
            decoded = self.load_audio(file_path, max_duration=MAX_ANALYZE_SECONDS)
        except MemoryError:
            logger.error(f"MemoryError: Could not load audio for {file_path}")
            result['_error'] = 'MemoryError: audio file too large'
            return result
        if decoded is None:
            result['_error'] = self._last_load_error or 'Audio failed to load (corrupt or unreadable)'
            return result
        audio_44k = decoded.mean(axis=0) if decoded.shape[0] > 1 else decoded[0]
        if len(audio_44k) < MIN_ANALYZE_SECONDS * 44100 or float(np.max(np.abs(audio_44k))) < SILENCE_PEAK:
            # Silence, or too little audio to measure: every algorithm here would
            # still print a number (silence reads 738 BPM, A minor, calm). No
            # features is the answer.
            result['analysisMode'] = 'silent'
            return result

        try:
            # === BASIC FEATURES (always extracted) ===

            # Tempo: none is stored when the extractor fails; an onset count is not a tempo.
            try:
                bpm, beats, _, _, _ = self.rhythm_extractor(audio_44k)
                result['bpm'] = round(float(bpm), 1)
                result['beatsCount'] = len(beats)
            except Exception as rhythm_error:
                logger.warning(f"Tempo extraction failed: {rhythm_error}")
                result['beatsCount'] = 0

            try:
                key, scale, strength = self.key_extractor(audio_44k)
                result['key'] = key
                result['keyScale'] = scale
                result['keyStrength'] = round(float(strength), 3)
            except Exception as key_error:
                logger.warning(f"Key extraction failed: {key_error}")
                # No measured key: report none, never a fabricated C major.
                result['key'] = None
                result['keyScale'] = None
                result['keyStrength'] = None

            # Energy: the mean RMS of 2048-sample frames every 1024.
            frame_size = 2048
            hop_size = 1024
            n_frames = max(0, (len(audio_44k) - frame_size) // hop_size)
            rms_values = np.array(
                [self.rms(audio_44k[i * hop_size:i * hop_size + frame_size]) for i in range(n_frames)],
                dtype=np.float32,
            )
            result['energy'] = round(min(1.0, float(np.mean(rms_values)) * 3), 3) if n_frames > 0 else None

            # A mono source is measured as one channel (BS.1770), not doubled.
            pair = np.stack(
                [decoded[0], decoded[1] if decoded.shape[0] > 1 else np.zeros_like(decoded[0])], axis=1
            ).astype(np.float32)
            _, _, integrated, loudness_range = self.loudness_ebu(pair)
            result['loudness'] = round(float(integrated), 2)
            result['dynamicRange'] = round(float(loudness_range), 2)

            # The models' answers: moods, valence/arousal, danceability. A failure fails the
            # track and it is retried, never stored with anything in their place.
            try:
                audio_16k = self.resampler(audio_44k)
                result.update(self._extract_ml_features(audio_16k))
                result['analysisMode'] = 'enhanced'
                logger.info(f"Analysis: valence={result['valence']}, arousal={result['arousal']}")
            except Exception as e:
                logger.exception(f"ML analysis failed: {e}")
                result['_error'] = f'ML analysis failed: {e}'
                return result

            result['moodTags'] = self._generate_mood_tags(result)

            logger.info(f"Analysis complete [{result['analysisMode']}]: BPM={result['bpm']}, Key={result['key']} {result['keyScale']}, Valence={result['valence']}, Arousal={result['arousal']}")
        except MemoryError:
            logger.error(f"MemoryError during analysis of {file_path}")
            result['_error'] = 'MemoryError: analysis exceeded memory limits'
        except Exception as e:
            logger.exception(f"Analysis error: {e}")
            result['_error'] = f'Analysis error: {e}'
        return result

    def _extract_ml_features(self, audio_16k) -> Dict[str, Any]:
        """MusiCNN embeddings fed through the classification heads. MusiCNN was trained
        on pop and rock, so other genres skew; values are stored raw and the backend
        ranks them within each library. Any head that fails raises: the track fails
        and is retried, with no value made up in its place."""
        embeddings = self.musicnn_model(audio_16k)

        def positive_prob(model_name: str) -> float:
            """Mean per-patch probability of the head's positive class, read from the
            column its metadata names (see HEAD_CLASSES)."""
            preds = self.prediction_models[model_name](embeddings)
            return round(max(0.0, min(1.0, float(np.mean(preds[:, positive_class_index(model_name)])))), 3)

        # Each mood head is an independent binary classifier, stored raw; the backend
        # (moodBucketService) compares moods within the library.
        mood_heads = {
            'moodHappy': 'mood_happy',
            'moodSad': 'mood_sad',
            'moodRelaxed': 'mood_relaxed',
            'moodAggressive': 'mood_aggressive',
            'moodParty': 'mood_party',
            'moodAcoustic': 'mood_acoustic',
            'moodElectronic': 'mood_electronic',
        }
        result: Dict[str, Any] = {field: positive_prob(head) for field, head in mood_heads.items()}

        # Valence and arousal: the mean of the DEAM and emoMusic regressions, each [frames, 2]
        # on a 1-9 scale. Temperature scaling spreads the compressed predictions around the
        # centre (5.0) before mapping to 0-1.
        va = [self.prediction_models[m](embeddings) for m in ('deam', 'emomusic')]
        valence_raw = sum(float(np.mean(p[:, 0])) for p in va) / len(va)
        arousal_raw = sum(float(np.mean(p[:, 1])) for p in va) / len(va)
        center = 5.0
        temperature = 2.5
        valence_scaled = max(1.0, min(9.0, center + (valence_raw - center) * temperature))
        arousal_scaled = max(1.0, min(9.0, center + (arousal_raw - center) * temperature))
        result['valence'] = round(max(0.0, min(1.0, (valence_scaled - 1.0) / 8.0)), 3)
        result['arousal'] = round(max(0.0, min(1.0, (arousal_scaled - 1.0) / 8.0)), 3)

        # Danceability: the head's probability, across the whole 0-1 range.
        result['danceabilityMl'] = positive_prob('danceability')
        result['danceability'] = result['danceabilityMl']

        logger.info(f"ML Moods: H={result['moodHappy']}, S={result['moodSad']}, R={result['moodRelaxed']}, A={result['moodAggressive']}, P={result['moodParty']}")
        return result

    def _generate_mood_tags(self, features: Dict[str, Any]) -> List[str]:
        """Mood tags from the models' moods, valence/arousal and danceability, and the
        measured tempo and key. A value that was not measured gives no tag; 0 is a value."""
        tags = []
        bpm = features.get('bpm')
        valence = features.get('valence')
        arousal = features.get('arousal')
        danceability = features.get('danceability')
        mood_happy = features.get('moodHappy')
        mood_sad = features.get('moodSad')
        mood_relaxed = features.get('moodRelaxed')
        mood_aggressive = features.get('moodAggressive')

        if mood_happy is not None and mood_happy >= 0.6:
            tags += ['happy', 'uplifting']
        if mood_sad is not None and mood_sad >= 0.6:
            tags += ['sad', 'melancholic']
        if mood_relaxed is not None and mood_relaxed >= 0.6:
            tags += ['relaxed', 'chill']
        if mood_aggressive is not None and mood_aggressive >= 0.6:
            tags += ['aggressive', 'intense']

        if arousal is not None and arousal >= 0.7:
            tags += ['energetic', 'upbeat']
        elif arousal is not None and arousal <= 0.3:
            tags += ['calm', 'peaceful']

        if valence is not None and 'happy' not in tags and 'sad' not in tags:
            if valence >= 0.7:
                tags += ['happy', 'uplifting']
            elif valence <= 0.3:
                tags += ['sad', 'melancholic']

        if danceability is not None and danceability >= 0.7:
            tags += ['dance', 'groovy']

        if bpm is not None and bpm >= 140:
            tags.append('fast')
        elif bpm is not None and bpm <= 80:
            tags.append('slow')

        if features.get('keyScale') == 'minor' and 'happy' not in tags:
            tags.append('moody')

        if arousal is not None and bpm is not None and arousal >= 0.7 and bpm >= 120:
            tags.append('workout')
        if arousal is not None and valence is not None and arousal <= 0.4 and valence <= 0.4:
            tags.append('atmospheric')
        if arousal is not None and bpm is not None and arousal <= 0.3 and bpm <= 90:
            tags.append('chill')
        if mood_aggressive is not None and bpm is not None and mood_aggressive >= 0.5 and bpm >= 120:
            tags.append('intense')

        return list(dict.fromkeys(tags))[:12]


# The analyzer of this worker process, built by _init_worker_process.
_process_analyzer = None


def _pool_health_check():
    """No-op function for pool health checks (lambdas can't be pickled with spawn mode)."""
    return True


def _init_worker_process(musicnn_server=None):
    """
    Initialize the analyzer for a worker process. ``musicnn_server`` is the main
    process's MusiCNN GPU session, when it has one.

    If model loading fails, the worker stays up and every track it is given fails with
    the reason (retried), rather than crashing the pool.
    """
    global _process_analyzer
    try:
        _process_analyzer = AudioAnalyzer(musicnn_server)
        state = "models ready" if _process_analyzer.enhanced_mode else f"cannot analyse: {_process_analyzer.models_error}"
        logger.info(f"Worker process {os.getpid()} initialized ({state})")
    except Exception as e:
        logger.exception(f"Worker initialization error, this worker cannot process tracks: {e}")
        raise

def _analyze_track_in_process(args: Tuple[str, str]) -> Tuple[str, str, Dict[str, Any]]:
    """
    Analyze a single track in a worker process.
    Returns (track_id, file_path, features_dict or error_dict)
    """
    track_id, file_path = args

    try:
        if isinstance(file_path, bytes):
            file_path = file_path.decode('utf-8', errors='replace')

        # Normalize path separators (Windows paths -> Unix)
        normalized_path = file_path.replace('\\', '/')
        full_path = os.path.join(MUSIC_PATH, normalized_path)

        # Use os.fsencode/fsdecode for filesystem-safe encoding
        try:
            full_path = os.fsdecode(os.fsencode(full_path))
        except (UnicodeError, AttributeError):
            return (track_id, file_path, {'_error': 'Invalid characters in file path'})

        if not os.path.exists(full_path):
            return (track_id, file_path, {'_error': 'File not found'})

        if os.path.getsize(full_path) == 0:
            return (track_id, file_path, {'_error': 'Empty file (0 bytes) - likely incomplete download'})

        features = _process_analyzer.analyze(full_path)
        return (track_id, file_path, features)

    except UnicodeDecodeError as e:
        logger.error(f"UTF-8 decoding error for track {track_id}: {e}")
        return (track_id, file_path, {'_error': f'UTF-8 encoding error: {e}'})
    except Exception as e:
        logger.error(f"Analysis error for {file_path}: {e}")
        return (track_id, file_path, {'_error': str(e)})


class AnalysisWorker:
    """Takes audio analysis jobs from a Redis queue and runs them on a pool of worker processes."""

    def __init__(self):
        self.redis = redis.from_url(REDIS_URL)
        self.db = DatabaseConnection(DATABASE_URL)
        self.running = False
        self.executor = None
        self.pool_active = False
        self.consecutive_empty = 0
        self._restarting = False
        self.is_paused = False  # Enrichment control: pause state
        self.pubsub = None  # Redis pub/sub for control signals
        self._last_work_time = time.time()
        self._pending_resize: int | None = None
        self._pending_resize_time: float = 0.0
        self._in_flight: Dict[Any, Tuple[Dict[str, Any], float]] = {}
        self._gpu_server = None
        self.musicnn_server = self._start_musicnn_server()
        self._setup_control_channel()

    def _start_musicnn_server(self):
        """With "GPU for audio analysis" on, one GPU session here runs MusiCNN for every
        worker; the settings page is told whether it got the GPU."""
        if not (GPU_ANALYSIS and ML_MODELS_AVAILABLE):
            _record_gpu_provider(False)
            return None
        try:
            from musicnn_onnx import ANSWERS_FILE, MIN_COSINE, MusicnnBody, MusicnnServer, embedding_cosine
            body = MusicnnBody(MODEL_DIR, use_gpu=True)
            if not body.on_gpu:
                logger.warning("GPU for audio analysis is on but ONNX Runtime has no CUDA provider here; running on CPU")
                _record_gpu_provider(False)
                return None
            # The GPU must answer as Essentia does, checked on this card and driver at every start.
            cosine = embedding_cosine(body.run, os.path.join(MODEL_DIR, ANSWERS_FILE))
            if cosine < MIN_COSINE:
                logger.error(f"MusiCNN on the GPU answers off Essentia's (cosine {cosine:.7f} < {MIN_COSINE}); running on CPU")
                _record_gpu_provider(False)
                return None
            logger.info(f"MusiCNN GPU session checked against Essentia's answers: cosine {cosine:.7f}")
            server = MusicnnServer(body)
            self._gpu_server = server
        except Exception as e:
            logger.error(f"MusiCNN GPU session failed, running on CPU: {e}")
            _record_gpu_provider(False)
            return None
        _record_gpu_provider(True)
        logger.info("MusiCNN runs on the GPU in the main process for every worker")
        return server.address

    def _new_pool(self) -> ProcessPoolExecutor:
        return ProcessPoolExecutor(
            max_workers=NUM_WORKERS,
            initializer=_init_worker_process,
            initargs=(self.musicnn_server,),
            max_tasks_per_child=50,
        )

    def _setup_control_channel(self):
        """Subscribe to control channel for pause/resume/stop signals"""
        try:
            self.pubsub = self.redis.pubsub()
            self.pubsub.subscribe(CONTROL_CHANNEL)
            logger.info(f"Subscribed to control channel: {CONTROL_CHANNEL}")
        except Exception as e:
            logger.warning(f"Failed to subscribe to control channel: {e}")
            self.pubsub = None

    def _is_gate_closed(self) -> bool:
        """Check the synchronous Redis gate key set by Node.js.
        Returns True if Python should NOT process work.
        This is the authoritative stop signal -- no pub/sub timing dependency.
        Also syncs local is_paused flag to match gate state."""
        try:
            val = self.redis.get("audio:analysis:gate")
            if val and (val == b"paused" or val == "paused"):
                if not self.is_paused:
                    self.is_paused = True
                    logger.info("Gate closed by Node.js -- pausing")
                return True
            if self.is_paused:
                self.is_paused = False
                logger.info("Gate opened by Node.js -- resuming")
            return False
        except Exception:
            return False

    def _check_control_signals(self):
        """Check for pause/resume/stop/set_workers control signals (non-blocking)"""
        if not self.pubsub:
            return

        try:
            message = self.pubsub.get_message(ignore_subscribe_messages=True, timeout=0.001)
            if message and message['type'] == 'message':
                data = message['data'].decode('utf-8') if isinstance(message['data'], bytes) else message['data']

                # Try to parse as JSON for structured commands
                try:
                    cmd = json.loads(data)
                    if isinstance(cmd, dict) and cmd.get('command') == 'set_workers':
                        new_count = _clamp_workers(int(cmd.get('count', NUM_WORKERS)))
                        if new_count != NUM_WORKERS:
                            self._pending_resize = new_count
                            self._pending_resize_time = time.time()
                            logger.info(f"Worker resize queued: {NUM_WORKERS} -> {new_count} (applying in {RESIZE_DEBOUNCE_SECONDS}s)")
                        return
                except (json.JSONDecodeError, ValueError):
                    pass  # Not JSON, try as plain string

                # Handle plain string signals (pause/resume/stop)
                logger.info(f"Received control signal: {data}")

                if data == 'pause':
                    self.is_paused = True
                    logger.info("Audio analysis PAUSED")
                elif data == 'resume':
                    self.is_paused = False
                    logger.info("Audio analysis RESUMED")
                elif data == 'stop':
                    self.running = False
                    logger.info("Audio analysis STOPPING (graceful shutdown)")
        except Exception as e:
            logger.warning(f"Error checking control signals: {e}")

    def _apply_pending_resize(self):
        """Apply buffered resize if debounce period has elapsed."""
        if self._pending_resize is None:
            return
        elapsed = time.time() - self._pending_resize_time
        if elapsed < RESIZE_DEBOUNCE_SECONDS:
            return
        target = self._pending_resize
        self._pending_resize = None
        self._resize_worker_pool(target)

    def _resize_worker_pool(self, new_count: int):
        """
        Resize the worker pool to a new count.
        Gracefully completes in-flight work before resizing.
        """
        global NUM_WORKERS

        if new_count == NUM_WORKERS:
            logger.info(f"Worker count unchanged at {new_count}")
            return

        logger.info(f"Resizing worker pool: {NUM_WORKERS} -> {new_count} workers")
        NUM_WORKERS = new_count
        if not self.pool_active:
            return

        # Jobs already running finish on the old pool and are collected as usual.
        old_executor = self.executor
        self.executor = self._new_pool()
        try:
            old_executor.shutdown(wait=False)
        except Exception as e:
            logger.warning(f"Error shutting down old pool: {e}")
        logger.info(f"Worker pool resized to {NUM_WORKERS} workers")

    def _check_pool_health(self) -> bool:
        """
        Check if the process pool is still healthy.
        Returns False if pool is broken or workers are dead.
        """
        if self.executor is None:
            return False
        if hasattr(self.executor, '_broken') and self.executor._broken:
            return False
        try:
            future = self.executor.submit(_pool_health_check)
            result = future.result(timeout=5)
            return result is True
        except Exception:
            return False

    def _ensure_pool(self):
        """Lazily start or verify the process pool is running."""
        if self.pool_active and self.executor is not None:
            return
        if self.executor is not None:
            # Stale executor reference, clean it up
            try:
                self.executor.shutdown(wait=False)
            except Exception:
                pass
        if self.musicnn_server is None:
            self.musicnn_server = self._start_musicnn_server()
        logger.info(f"Starting worker pool with {NUM_WORKERS} processes...")
        self.executor = self._new_pool()
        self.pool_active = True
        logger.info(f"Worker pool started ({NUM_WORKERS} workers)")

    def _shutdown_pool(self):
        """Shut down the process pool to free memory during idle periods."""
        if not self.pool_active or self.executor is None:
            return
        logger.info("No pending work -- shutting down worker pool to free memory")
        try:
            self.executor.shutdown(wait=True)
        except Exception as e:
            logger.warning(f"Error during pool shutdown: {e}")
        self.executor = None
        self.pool_active = False
        # The GPU session goes with the workers it serves, so an idle analyzer holds no GPU memory.
        if self._gpu_server is not None:
            self._gpu_server.close()
            self._gpu_server = None
        self.musicnn_server = None
        gc.collect()
        # Force glibc to return freed pages to OS (Python/PyTorch hold RSS otherwise)
        try:
            import ctypes
            ctypes.CDLL("libc.so.6").malloc_trim(0)
        except Exception:
            pass
        logger.info("Worker pool shut down (will restart when work arrives)")

    def _drop_pool(self):
        """Kill a broken or stuck pool. The next job starts a fresh one, so an analyzer that is finishing up
        to restart starts none."""
        logger.warning("Killing the process pool: a worker died or is stuck")

        if self.executor:
            # A stuck worker would run on after shutdown(wait=False); stop it outright. The pool's
            # workers are this process's only multiprocessing children.
            for process in multiprocessing.active_children():
                process.kill()
            try:
                self.executor.shutdown(wait=False)
            except Exception as e:
                logger.warning(f"Error during executor shutdown: {e}")
            self.executor = None
            self.pool_active = False

    def start(self):
        """Start processing jobs with BRPOP-driven event loop"""
        cpu_count = os.cpu_count() or 4

        logger.info("=" * 60)
        logger.info("Starting Audio Analysis Worker (BRPOP MODE)")
        logger.info("=" * 60)
        logger.info(f"  Music path: {MUSIC_PATH}")
        logger.info(f"  CPU cores: {cpu_count}")
        logger.info(f"  Worker processes: {NUM_WORKERS}")
        logger.info(f"  BRPOP timeout: {BRPOP_TIMEOUT}s")
        logger.info(f"  Model idle timeout: {MODEL_IDLE_TIMEOUT}s")
        logger.info(f"  Essentia available: {ESSENTIA_AVAILABLE}")
        logger.info(f"  ML models on disk: {ML_MODELS_AVAILABLE}")
        logger.info("  Worker pool: LAZY (starts on first job)")

        self.db.connect()
        self.running = True

        # A claim from before a crash expires and comes around again; a lost queue entry is
        # re-offered by the next dispatch.
        try:
            while self.running:
                try:
                    try:
                        self.redis.set("audio:worker:heartbeat", str(int(time.time() * 1000)))
                    except Exception:  # the next pass sets it again
                        pass

                    # The GPU runtime is put on the path before Python starts, so a changed switch is
                    # applied by restarting: take nothing new, finish what is running, then exit for the
                    # supervisor (or Docker) to start this process again.
                    if not self._restarting and gpu_switch.restart_needed('analysis'):
                        logger.info("GPU switch changed: finishing running tracks, then restarting to apply it")
                        self._restarting = True
                    if self._restarting:
                        self._collect(timeout=1.0)
                        if not self._in_flight:
                            self.running = False
                        continue

                    # Check for control signals (pause/resume/stop/set_workers)
                    self._check_control_signals()
                    self._apply_pending_resize()
                    # Sync pause state from Redis gate (authoritative, no pub/sub dependency)
                    self._is_gate_closed()

                    if self.is_paused:
                        # Finish what is running; take nothing new.
                        self._collect(timeout=1.0)
                        if not self._in_flight:
                            time.sleep(1)
                        continue

                    took = self._fill()
                    self._collect(timeout=1.0)

                    if took or self._in_flight:
                        self.consecutive_empty = 0
                        self._last_work_time = time.time()
                    else:
                        self.consecutive_empty += 1
                        idle_seconds = time.time() - self._last_work_time
                        if self.pool_active and MODEL_IDLE_TIMEOUT > 0 and idle_seconds >= MODEL_IDLE_TIMEOUT:
                            self._shutdown_pool()
                            logger.info(f"Idle for {idle_seconds:.0f}s, pool shut down (restarts when work arrives)")

                except KeyboardInterrupt:
                    logger.info("Shutdown requested")
                    self.running = False
                except BrokenProcessPool:
                    logger.error("BrokenProcessPool detected, dropping the pool")
                    self._drop_pool()
                    continue
                except Exception as e:
                    logger.exception(f"Worker error: {e}")
                    self.consecutive_empty += 1

                    if self.consecutive_empty >= 5:
                        logger.info("Multiple consecutive errors, attempting recovery...")
                        try:
                            self.db.close()
                            time.sleep(2)
                            self.db.connect()
                            if self.pool_active and not self._check_pool_health():
                                self._drop_pool()
                        except Exception as reconnect_err:
                            logger.error(f"Recovery failed: {reconnect_err}")
                        self.consecutive_empty = 0

                    time.sleep(BRPOP_TIMEOUT)
        finally:
            self._shutdown_pool()
            if self.pubsub:
                self.pubsub.close()
                logger.info("Control channel closed")
            self.db.close()
            logger.info("Worker stopped")

    def _take_jobs(self, room: int, block: bool) -> List[Dict[str, Any]]:
        """Up to `room` jobs, oldest first; waits up to BRPOP_TIMEOUT for the first only when `block`."""
        jobs: List[Dict[str, Any]] = []
        if room <= 0 or self._is_gate_closed():
            return jobs
        if block:
            result = self.redis.blpop(ANALYSIS_QUEUE, timeout=BRPOP_TIMEOUT)
            if result is None:
                return jobs
            jobs.append(json.loads(result[1]))
        while len(jobs) < room:
            data = self.redis.lpop(ANALYSIS_QUEUE)
            if not data:
                break
            jobs.append(json.loads(data))
        return jobs

    def _current_claims(self, jobs: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """The jobs whose claim is still their record's open one. A job whose claim was re-issued (a lease
        re-offer, a wipe, a restart) is dropped unanalysed: its report would be refused as stale."""
        claims = {}
        for job in jobs:
            match = CLAIM_IN_JOB_ID.search(job.get('jobId') or '')
            if match:
                claims[job['trackId']] = (int(match.group(1)), int(match.group(2)))
        if not claims:
            return jobs
        cursor = self.db.get_cursor()
        try:
            cursor.execute(
                'SELECT "trackId", attempt, redelivered FROM "TrackStage" '
                'WHERE stage = %s AND status = %s AND "trackId" = ANY(%s)',
                ('analysis', 'working', list(claims)),
            )
            open_claims = {row['trackId']: (row['attempt'], row['redelivered']) for row in cursor.fetchall()}
        finally:
            cursor.close()
            self.db.commit()
        current = []
        for job in jobs:
            claim = claims.get(job['trackId'])
            if claim is None or open_claims.get(job['trackId']) == claim:
                current.append(job)
            else:
                logger.info(f"Skipped {job['trackId']}: claim {job.get('jobId')} was re-issued")
        return current

    def _fill(self) -> bool:
        """Top the pool up to NUM_WORKERS jobs the moment a slot frees; no batch waits on its slowest track."""
        jobs = self._take_jobs(NUM_WORKERS - len(self._in_flight), block=not self._in_flight)
        if not jobs:
            return False
        try:
            jobs = self._current_claims(jobs)
        except Exception:
            # Back to the head of the list in their order, so a failed lookup loses no job.
            self.redis.lpush(ANALYSIS_QUEUE, *[json.dumps(job) for job in reversed(jobs)])
            raise
        if not jobs:
            return True
        self._ensure_pool()
        for job in jobs:
            future = self.executor.submit(_analyze_track_in_process, (job['trackId'], job.get('filePath', '')))
            self._in_flight[future] = (job, time.time())
        return True

    def _collect(self, timeout: float):
        """Save every finished job. A job past JOB_TIMEOUT_S means a stuck worker: the pool is killed and its
        tracks come back through the server's lease, unreported and unpenalised."""
        if not self._in_flight:
            return
        done, _ = wait(list(self._in_flight), timeout=timeout, return_when=FIRST_COMPLETED)
        broken = False
        for future in done:
            job, _ = self._in_flight.pop(future)
            broken = self._finish(future, job) or broken
        now = time.time()
        stuck = any(now - started > JOB_TIMEOUT_S for _, started in self._in_flight.values())
        if broken or stuck:
            for future, (job, _) in self._in_flight.items():
                future.cancel()
                logger.error(f"✗ {'Pool crash' if broken else 'Stuck worker'} (no penalty): {job.get('filePath', '')}")
            self._in_flight.clear()
            self._drop_pool()

    def _finish(self, future, job: Dict[str, Any]) -> bool:
        """Report one finished job; True when its worker process died."""
        try:
            _, file_path, features = future.result()
        except BrokenProcessPool:
            logger.error(f"✗ Worker death (no penalty): {job.get('filePath', '')}")
            return True
        except Exception as e:
            self._save_failed(job, f"Analysis error: {e}")
            logger.error(f"✗ Failed: {job.get('filePath', '')} - {e}")
            return False
        if features.get('_error'):
            self._save_failed(job, features['_error'])
            logger.error(f"✗ Failed: {file_path} - {features['_error']}")
        elif self._save_results(job, features):
            logger.info(f"✓ Completed: {file_path}")
        return False

    def _save_results(self, job: Dict[str, Any], features: Dict[str, Any]) -> bool:
        """Save analysis results; False when they could not be written, which is
        reported as this track's failure. instrumentalness and acousticness are left
        alone: CLAP is their only writer, and a re-analysis would null them.
        V/A land in their own raw columns; the server derives the shared pair
        from both analyzers' raws when it records the answer."""
        track_id = job['trackId']
        claim = CLAIM_IN_JOB_ID.search(job.get('jobId') or '')
        if claim is None:
            logger.warning(f"Job {job.get('jobId')} for track {track_id} names no claim; not written")
            return False
        cursor = self.db.get_cursor()
        try:
            # Written only while this job's claim is the record's open one, held to the commit: a wipe
            # or a re-offer since the job was taken leaves the track for the job that holds it now.
            cursor.execute(
                'SELECT 1 FROM "TrackStage" WHERE "trackId" = %s AND stage = %s AND status = %s'
                ' AND attempt = %s AND redelivered = %s FOR SHARE',
                (track_id, 'analysis', 'working', int(claim.group(1)), int(claim.group(2))),
            )
            if cursor.fetchone() is None:
                logger.warning(f"Track {track_id}'s claim {job.get('jobId')} was re-issued before the save; not written")
                self.db.rollback()
                return False
            cursor.execute("""
                UPDATE "Track"
                SET
                    bpm = %s,
                    "beatsCount" = %s,
                    key = %s,
                    "keyScale" = %s,
                    "keyStrength" = %s,
                    energy = %s,
                    loudness = %s,
                    "dynamicRange" = %s,
                    danceability = %s,
                    "deamValence" = %s,
                    "deamArousal" = %s,
                    "moodTags" = %s,
                    "essentiaGenres" = %s,
                    "moodHappy" = %s,
                    "moodSad" = %s,
                    "moodRelaxed" = %s,
                    "moodAggressive" = %s,
                    "moodParty" = %s,
                    "moodAcoustic" = %s,
                    "moodElectronic" = %s,
                    "danceabilityMl" = %s,
                    "analysisMode" = %s,
                    "analysisVersion" = %s,
                    "analyzedAt" = now()
                WHERE id = %s""", (
                features['bpm'],
                features['beatsCount'],
                features['key'],
                features['keyScale'],
                features['keyStrength'],
                features['energy'],
                features['loudness'],
                features['dynamicRange'],
                features['danceability'],
                features['valence'],
                features['arousal'],
                features['moodTags'],
                features['essentiaGenres'],
                features.get('moodHappy'),
                features.get('moodSad'),
                features.get('moodRelaxed'),
                features.get('moodAggressive'),
                features.get('moodParty'),
                features.get('moodAcoustic'),
                features.get('moodElectronic'),
                features.get('danceabilityMl'),
                features['analysisMode'],
                ESSENTIA_VERSION,
                track_id,
            ))
            if cursor.rowcount == 0:
                logger.warning(f"Track {track_id} was deleted before the save; not written")
                self.db.rollback()
                return False

            self.db.commit()

            # The backend queues the vibe embedding job on this event.
            try:
                completion_event = json.dumps({
                    "trackId": track_id,
                    "jobId": job.get('jobId'),
                    "status": "complete",
                })
                self.redis.publish("audio:analysis:complete", completion_event)
                logger.debug(f"[Essentia] Published completion for track {track_id}")
            except Exception as pub_err:
                logger.warning(f"[Essentia] Failed to publish completion event for {track_id}: {pub_err}")

        except Exception as e:
            logger.error(f"Failed to save results for {track_id}: {e}")
            self.db.rollback()
            self._save_failed(job, f"Saving the results failed: {e}")
            return False
        finally:
            cursor.close()
        return True

    def _save_failed(self, job: Dict[str, Any], error: str):
        """Report a failure to the backend over the completion channel; the
        backend classifies it, runs the retry ladder, and owns every write."""
        track_id = job['trackId']
        try:
            self.redis.publish("audio:analysis:complete", json.dumps({
                "trackId": track_id,
                "jobId": job.get('jobId'),
                "status": "failed",
                "error": error[:500],
            }))
            logger.error(f"Reported analysis failure for {track_id}: {error[:200]}")
        except Exception as e:
            logger.error(f"Failed to report analysis failure for {track_id}: {e}")


def main():
    if len(sys.argv) > 1 and sys.argv[1] == '--test':
        if len(sys.argv) < 3:
            print("Usage: analyzer.py --test <audio_file>")
            sys.exit(1)

        analyzer = AudioAnalyzer()
        result = analyzer.analyze(sys.argv[2])
        print(json.dumps(result, indent=2))
        return

    worker = AnalysisWorker()
    worker.start()


if __name__ == '__main__':
    main()

