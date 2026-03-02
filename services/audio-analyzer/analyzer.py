#!/usr/bin/env python3
"""Audio analyzer service - Essentia-based analysis with TensorFlow ML models"""

# CRITICAL: TensorFlow threading MUST be configured before any imports.
# Environment variables are read by TensorFlow C++ runtime before initialization.
import os
import sys

# Get thread configuration from environment (default to 1 for safety)
THREADS_PER_WORKER = int(os.getenv('THREADS_PER_WORKER', '1'))

# Configure TensorFlow threading via environment variables
# These are read by TensorFlow C++ runtime before thread pool initialization
# Must be set BEFORE any TensorFlow/Essentia imports load TensorFlow
os.environ['TF_CPP_MIN_LOG_LEVEL'] = '2'  # Reduce TF logging noise
os.environ['TF_NUM_INTRAOP_THREADS'] = str(THREADS_PER_WORKER)  # Threads within ops
os.environ['TF_NUM_INTEROP_THREADS'] = '1'  # Serialize op scheduling

# Also set NumPy/BLAS/OpenMP limits for non-TensorFlow operations
os.environ['OMP_NUM_THREADS'] = str(THREADS_PER_WORKER)
os.environ['OPENBLAS_NUM_THREADS'] = str(THREADS_PER_WORKER)
os.environ['MKL_NUM_THREADS'] = str(THREADS_PER_WORKER)
os.environ['NUMEXPR_MAX_THREADS'] = str(THREADS_PER_WORKER)

# Log thread configuration on startup
print("=" * 80, file=sys.stderr)
print("AUDIO ANALYZER THREAD CONFIGURATION", file=sys.stderr)
print("=" * 80, file=sys.stderr)
print(f"TF_NUM_INTRAOP_THREADS: {THREADS_PER_WORKER}", file=sys.stderr)
print(f"TF_NUM_INTEROP_THREADS: 1", file=sys.stderr)
print(f"OpenMP/BLAS threads: {THREADS_PER_WORKER}", file=sys.stderr)
print(f"Expected CPU usage: ~{THREADS_PER_WORKER * 100 + 100}% per worker", file=sys.stderr)
print("=" * 80, file=sys.stderr)

"""
Essentia Audio Analyzer Service - Enhanced Vibe Matching

This service processes audio files and extracts audio features including:
- BPM/Tempo
- Key/Scale
- Energy/Loudness
- Danceability
- ML-based Mood classification (happy, sad, relaxed, aggressive)
- ML-based Valence and Arousal (real predictions, not estimates)
- Voice/Instrumental detection

Two analysis modes:
- ENHANCED (default): Uses TensorFlow models for accurate mood detection
- STANDARD (fallback): Uses heuristics when models aren't available

It connects to Redis for job queue and PostgreSQL for storing results.
"""

# NOW safe to import other dependencies
import json
import time
import logging
import gc
from datetime import datetime, timezone
from typing import Dict, Any, Optional, List, Tuple
import traceback
import numpy as np
from concurrent.futures import ProcessPoolExecutor, as_completed
import multiprocessing

# BrokenProcessPool was added in Python 3.9, provide compatibility for Python 3.8
try:
    from concurrent.futures import BrokenProcessPool
except ImportError:
    # Python 3.8 fallback: use the internal class or create a compatible exception
    try:
        from concurrent.futures.process import BrokenProcessPool
    except ImportError:
        # If still not available, create a compatible exception class
        class BrokenProcessPool(Exception):
            """Compatibility shim for Python < 3.9"""
            pass

# Force spawn mode for TensorFlow compatibility (must be called before any multiprocessing)
try:
    multiprocessing.set_start_method('spawn', force=True)
except RuntimeError:
    pass  # Already set

import redis
import psycopg2
from psycopg2.extras import RealDictCursor

# Configure logging
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

# TensorFlow models via Essentia
# NOTE: TF is NOT imported in the main process to save ~300MB RAM.
# Worker processes import TF independently via spawn mode.
# TF_MODELS_AVAILABLE is set after MODELS dict is defined below.
TF_MODELS_AVAILABLE = False
TensorflowPredictMusiCNN = None  # Loaded in worker processes

# Configuration from environment
REDIS_URL = os.getenv('REDIS_URL', 'redis://localhost:6379')
DATABASE_URL = os.getenv('DATABASE_URL', '')
MUSIC_PATH = os.getenv('MUSIC_PATH', '/music')
BATCH_SIZE = int(os.getenv('BATCH_SIZE', '10'))
SLEEP_INTERVAL = int(os.getenv('SLEEP_INTERVAL', '5'))

# BRPOP timeout: how long to block waiting for work (seconds)
# Also serves as the DB reconciliation interval
# Uses SLEEP_INTERVAL for backward compatibility, minimum 5s
BRPOP_TIMEOUT = max(5, int(os.getenv('BRPOP_TIMEOUT', str(SLEEP_INTERVAL))))

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
            options="-c client_encoding=UTF8"
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
            workers = int(result['audioAnalyzerWorkers'])
            # Validate range (1-8)
            workers = max(1, min(8, workers))
            logger.info(f"Loaded worker count from database: {workers}")
            return workers
        else:
            logger.info("No worker count found in database, using env var or default")
            return int(os.getenv('NUM_WORKERS', str(DEFAULT_WORKERS)))
            
    except Exception as e:
        logger.warning(f"Failed to fetch worker count from database: {e}")
        logger.info("Falling back to env var or default")
        return int(os.getenv('NUM_WORKERS', str(DEFAULT_WORKERS)))
# Conservative default: 2 workers (stable on any system)
# Previous default used auto-scaling which could cause OOM on memory-constrained systems
DEFAULT_WORKERS = 2
# Try to load from database first, fall back to env var or default
NUM_WORKERS = _get_workers_from_db()
ESSENTIA_VERSION = '2.1b6-enhanced-v2'

# Retry configuration
MAX_RETRIES = int(os.getenv('MAX_RETRIES', '3'))  # Max retry attempts per track
STALE_PROCESSING_MINUTES = int(os.getenv('STALE_PROCESSING_MINUTES', '15'))  # Reset tracks stuck in 'processing' (synchronized with backend)

# Queue names
ANALYSIS_QUEUE = 'audio:analysis:queue'

# Control channel for enrichment coordination
CONTROL_CHANNEL = 'audio:analysis:control'

# Model paths (pre-packaged in Docker image)
MODEL_DIR = '/app/models'

# MusiCNN model file paths (official Essentia models from essentia.upf.edu/models/)
# Note: Valence and arousal are derived from mood models (no direct models exist)
MODELS = {
    # Base MusiCNN embedding model (for auto-tagging)
    'musicnn': os.path.join(MODEL_DIR, 'msd-musicnn-1.pb'),
    'musicnn_metadata': os.path.join(MODEL_DIR, 'msd-musicnn-1.json'),
    # Mood classification heads (MusiCNN architecture)
    # Correct filenames: {task}-msd-musicnn-1.pb
    'mood_happy': os.path.join(MODEL_DIR, 'mood_happy-msd-musicnn-1.pb'),
    'mood_sad': os.path.join(MODEL_DIR, 'mood_sad-msd-musicnn-1.pb'),
    'mood_relaxed': os.path.join(MODEL_DIR, 'mood_relaxed-msd-musicnn-1.pb'),
    'mood_aggressive': os.path.join(MODEL_DIR, 'mood_aggressive-msd-musicnn-1.pb'),
    'mood_party': os.path.join(MODEL_DIR, 'mood_party-msd-musicnn-1.pb'),
    'mood_acoustic': os.path.join(MODEL_DIR, 'mood_acoustic-msd-musicnn-1.pb'),
    'mood_electronic': os.path.join(MODEL_DIR, 'mood_electronic-msd-musicnn-1.pb'),
    'danceability': os.path.join(MODEL_DIR, 'danceability-msd-musicnn-1.pb'),
    'voice_instrumental': os.path.join(MODEL_DIR, 'voice_instrumental-msd-musicnn-1.pb'),
}

# Now that MODELS is defined, check if model files exist on disk
TF_MODELS_AVAILABLE = os.path.exists(MODELS['musicnn'])
if TF_MODELS_AVAILABLE:
    logger.info(f"MusiCNN model files found at {MODEL_DIR}")
else:
    logger.info(f"MusiCNN model files not found at {MODEL_DIR} - Standard mode only")

class AudioAnalyzer:
    """
    Enhanced audio analysis using Essentia with TensorFlow models.
    
    Supports two modes:
    - Enhanced: Uses ML models for accurate mood/valence/arousal (default)
    - Standard: Uses heuristics when models aren't available (fallback)
    """
    
    def __init__(self):
        self.enhanced_mode = False
        self.musicnn_model = None  # Base MusiCNN model
        self.prediction_models = {}  # Classification head models
        
        if ESSENTIA_AVAILABLE:
            self._init_essentia()
            self._load_ml_models()
    
    def _init_essentia(self):
        """Initialize Essentia algorithms for basic feature extraction"""
        # Basic feature extractors (always available)
        self.rhythm_extractor = es.RhythmExtractor2013(method="multifeature")
        self.key_extractor = es.KeyExtractor()
        self.loudness = es.Loudness()
        self.dynamic_complexity = es.DynamicComplexity()
        self.danceability_extractor = es.Danceability()
        
        # Additional extractors for better Standard mode
        self.spectral_centroid = es.Centroid(range=22050)  # For brightness
        self.spectral_flatness = es.FlatnessDB()  # For instrumentalness
        self.zcr = es.ZeroCrossingRate()  # For speechiness
        self.rms = es.RMS()  # For proper energy calculation
        self.spectrum = es.Spectrum()
        self.windowing = es.Windowing(type='hann')
        self.resampler = es.Resample(inputSampleRate=44100, outputSampleRate=16000)

        logger.info("Essentia basic algorithms initialized")
    
    def _load_ml_models(self):
        """
        Load MusiCNN TensorFlow models for Enhanced mode.

        Architecture:
        1. Base MusiCNN model generates embeddings from audio
        2. Classification head models take embeddings and output predictions

        If models are missing, gracefully fall back to Standard mode.
        """
        if not TF_MODELS_AVAILABLE:
            logger.info("Model files not available - using Standard mode")
            return

        try:
            logger.info("TensorFlow running on CPU")

            from essentia.standard import TensorflowPredict2D, TensorflowPredictMusiCNN
            logger.info("Loading MusiCNN models...")

            # First, load the base MusiCNN embedding model
            if os.path.exists(MODELS['musicnn']):
                try:
                    self.musicnn_model = TensorflowPredictMusiCNN(
                        graphFilename=MODELS['musicnn'],
                        output="model/dense/BiasAdd"  # Embedding layer output
                    )
                    logger.info("Loaded base MusiCNN model for embeddings")
                except Exception as e:
                    logger.warning(f"Failed to load MusiCNN model: {e}")
                    logger.info("Falling back to Standard mode (heuristic-based analysis)")
                    self.enhanced_mode = False
                    return
            else:
                logger.warning(f"Base MusiCNN model not found at: {MODELS['musicnn']}")
                logger.info("This is normal if models haven't been downloaded yet.")
                logger.info("Falling back to Standard mode (heuristic-based analysis)")
                logger.info("Standard mode still provides BPM, key, energy, and mood detection,")
                logger.info("but uses audio features instead of ML predictions.")
                self.enhanced_mode = False
                return
            
            # Load classification head models
            heads_to_load = {
                'mood_happy': MODELS['mood_happy'],
                'mood_sad': MODELS['mood_sad'],
                'mood_relaxed': MODELS['mood_relaxed'],
                'mood_aggressive': MODELS['mood_aggressive'],
                'mood_party': MODELS['mood_party'],
                'mood_acoustic': MODELS['mood_acoustic'],
                'mood_electronic': MODELS['mood_electronic'],
                'danceability': MODELS['danceability'],
                'voice_instrumental': MODELS['voice_instrumental'],
            }
            
            for model_name, model_path in heads_to_load.items():
                if os.path.exists(model_path):
                    try:
                        self.prediction_models[model_name] = TensorflowPredict2D(
                            graphFilename=model_path,
                            output="model/Softmax"
                        )
                        logger.info(f"Loaded classification head: {model_name}")
                    except Exception as e:
                        logger.warning(f"Failed to load {model_name}: {e}")
                else:
                    logger.warning(f"Model not found: {model_path}")
            
            # Enable enhanced mode if we have the key mood models
            # (valence and arousal are derived from mood predictions)
            required = ['mood_happy', 'mood_sad', 'mood_relaxed', 'mood_aggressive']
            if all(m in self.prediction_models for m in required):
                self.enhanced_mode = True
                logger.info(f"ENHANCED MODE ENABLED - {len(self.prediction_models)} MusiCNN classification heads loaded")
            else:
                missing = [m for m in required if m not in self.prediction_models]
                logger.warning(f"Missing required models: {missing} - using Standard mode")
                
        except ImportError as e:
            logger.warning(f"TensorflowPredict2D not available: {e}")
            self.enhanced_mode = False
        except Exception as e:
            logger.error(f"Failed to load ML models: {e}")
            traceback.print_exc()
            self.enhanced_mode = False
    
    def load_audio(self, file_path: str, max_duration: int = 90) -> Optional[Any]:
        """Load up to max_duration seconds of audio at 44.1kHz as mono signal"""
        if not ESSENTIA_AVAILABLE:
            return None

        try:
            loader = es.MonoLoader(filename=file_path, sampleRate=44100)
            audio = loader()
            max_samples = int(44100 * max_duration)
            if len(audio) > max_samples:
                audio = audio[:max_samples]
            return audio
        except Exception as e:
            logger.error(f"Failed to load audio {file_path}: {e}")
            return None

    def validate_audio(self, audio, file_path: str) -> Tuple[bool, Optional[str]]:
        """
        Validate audio before analysis to detect edge cases that cause crashes.

        Returns:
            (is_valid, error_message) - error_message is None if valid
        """
        try:
            duration = len(audio) / 44100

            if duration < 5.0:
                return (False, f"Audio too short: {duration:.1f}s (minimum 5s)")

            if len(audio) == 0:
                return (False, "Audio is empty")

            if np.any(np.isnan(audio)) or np.any(np.isinf(audio)):
                return (False, "Audio contains NaN or Inf values (corrupted)")

            # Silence detection using vectorized RMS over chunks
            try:
                frame_size = 2048
                hop_size = 1024
                n_frames = max(1, (len(audio) - frame_size) // hop_size)
                # Vectorized: compute RMS per frame using stride tricks
                silent_count = 0
                for i in range(0, min(n_frames * hop_size, len(audio) - frame_size), hop_size):
                    rms_val = self.rms(audio[i:i + frame_size])
                    if rms_val < 0.001:
                        silent_count += 1

                if n_frames > 0 and silent_count / n_frames > 0.8:
                    ratio = silent_count / n_frames * 100
                    return (False, f"Audio is {ratio:.0f}% silence (likely corrupted or blank)")
            except Exception as silence_error:
                logger.warning(f"Silence detection failed for {file_path}: {silence_error}")

            return (True, None)

        except Exception as e:
            logger.warning(f"Audio validation error for {file_path}: {e}")
            return (True, None)
    
    def analyze(self, file_path: str) -> Dict[str, Any]:
        """
        Analyze audio file and extract all features.

        Loads audio once at 44.1kHz, resamples in-memory to 16kHz for ML inference.
        Uses Enhanced mode (ML models) if available, otherwise Standard mode (heuristics).
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
            'instrumentalness': None,
            'acousticness': None,
            'speechiness': None,
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
            'analysisMode': 'standard',
        }

        if not ESSENTIA_AVAILABLE:
            logger.error("Essentia not available - cannot analyze audio files")
            result['_error'] = 'Essentia library not installed'
            return result

        MAX_ANALYZE_SECONDS = int(os.getenv('MAX_ANALYZE_SECONDS', '90'))
        audio_44k = None
        try:
            audio_44k = self.load_audio(file_path, max_duration=MAX_ANALYZE_SECONDS)
        except MemoryError:
            logger.error(f"MemoryError: Could not load audio for {file_path}")
            result['_error'] = 'MemoryError: audio file too large'
            return result
        if audio_44k is None:
            return result

        # Validate audio before analysis
        is_valid, validation_error = self.validate_audio(audio_44k, file_path)
        if not is_valid:
            logger.warning(f"Audio validation failed for {file_path}: {validation_error}")
            result['_error'] = validation_error
            return result

        try:
            # === BASIC FEATURES (always extracted) ===

            # Rhythm Analysis with fallback chain
            try:
                bpm, beats, beats_confidence, _, beats_intervals = self.rhythm_extractor(audio_44k)
                result['bpm'] = round(float(bpm), 1)
                result['beatsCount'] = len(beats)
            except Exception as rhythm_error:
                logger.warning(f"RhythmExtractor2013 failed, using fallback: {rhythm_error}")
                try:
                    onset_detector = es.OnsetRate()
                    onset_rate, _ = onset_detector(audio_44k)
                    bpm = max(60, min(180, onset_rate * 60))
                    result['bpm'] = round(float(bpm), 1)
                    result['beatsCount'] = 0
                    logger.info(f"Fallback BPM estimate: {result['bpm']}")
                except Exception as fallback_error:
                    logger.warning(f"Onset-based fallback also failed: {fallback_error}")
                    bpm = 120.0
                    result['bpm'] = 120.0
                    result['beatsCount'] = 0

            # Key Detection
            try:
                key, scale, strength = self.key_extractor(audio_44k)
                result['key'] = key
                result['keyScale'] = scale
                result['keyStrength'] = round(float(strength), 3)
            except Exception as key_error:
                logger.warning(f"Key extraction failed: {key_error}")
                key = 'C'
                scale = 'major'
                result['key'] = key
                result['keyScale'] = scale
                result['keyStrength'] = 0.0

            # Energy & Spectral features - frame-based extraction
            frame_size = 2048
            hop_size = 1024
            n_frames = max(0, (len(audio_44k) - frame_size) // hop_size)

            rms_values = np.empty(n_frames, dtype=np.float32)
            zcr_values = np.empty(n_frames, dtype=np.float32)
            sc_values = np.empty(n_frames, dtype=np.float32)
            sf_values = np.empty(n_frames, dtype=np.float32)

            for idx in range(n_frames):
                offset = idx * hop_size
                frame = audio_44k[offset:offset + frame_size]
                windowed = self.windowing(frame)
                spectrum = self.spectrum(windowed)

                rms_values[idx] = self.rms(frame)
                zcr_values[idx] = self.zcr(frame)
                sc_values[idx] = self.spectral_centroid(spectrum)
                sf_values[idx] = self.spectral_flatness(spectrum)

            if n_frames > 0:
                avg_rms = float(np.mean(rms_values))
                result['energy'] = round(min(1.0, avg_rms * 3), 3)
                avg_sc = float(np.mean(sc_values))
                avg_sf = float(np.mean(sf_values))
                avg_zcr = float(np.mean(zcr_values))
            else:
                result['energy'] = 0.5
                avg_sc = 0.5
                avg_sf = -20.0
                avg_zcr = 0.1

            loudness = self.loudness(audio_44k)
            result['loudness'] = round(float(loudness), 2)

            dynamic_range, _ = self.dynamic_complexity(audio_44k)
            result['dynamicRange'] = round(float(dynamic_range), 2)

            # Store spectral features for Standard mode estimates
            result['_spectral_centroid'] = avg_sc
            result['_spectral_flatness'] = avg_sf
            result['_zcr'] = avg_zcr

            # Basic Danceability (non-ML)
            danceability, _ = self.danceability_extractor(audio_44k)
            result['danceability'] = round(max(0.0, min(1.0, float(danceability))), 3)

            # === ENHANCED MODE: Use ML models ===
            if self.enhanced_mode:
                try:
                    # Resample in-memory instead of re-reading from disk
                    audio_16k = self.resampler(audio_44k)
                    ml_features = self._extract_ml_features(audio_16k)
                    result.update(ml_features)
                    result['analysisMode'] = 'enhanced'
                    logger.info(f"Enhanced analysis: valence={result['valence']}, arousal={result['arousal']}")
                except Exception as e:
                    logger.warning(f"ML analysis failed, falling back to Standard: {e}")
                    traceback.print_exc()
                    self._apply_standard_estimates(result, scale, bpm)
            else:
                self._apply_standard_estimates(result, scale, bpm)

            # Generate mood tags based on all features
            result['moodTags'] = self._generate_mood_tags(result)

            logger.info(f"Analysis complete [{result['analysisMode']}]: BPM={result['bpm']}, Key={result['key']} {result['keyScale']}, Valence={result['valence']}, Arousal={result['arousal']}")
        except MemoryError:
            logger.error(f"MemoryError during analysis of {file_path}")
            result['_error'] = 'MemoryError: analysis exceeded memory limits'
        except Exception as e:
            logger.error(f"Analysis error: {e}")
            traceback.print_exc()
        finally:
            for k in ['_spectral_centroid', '_spectral_flatness', '_zcr']:
                result.pop(k, None)
        return result
    
    def _extract_ml_features(self, audio_16k) -> Dict[str, Any]:
        """
        Extract features using Essentia MusiCNN + classification heads.
        
        Architecture:
        1. TensorflowPredictMusiCNN extracts embeddings from audio
        2. TensorflowPredict2D classification heads take embeddings and output predictions
        
        This is the heart of Enhanced mode - real ML predictions for mood.
        
        Note: MusiCNN was trained on pop/rock music (Million Song Dataset).
        For genres outside this distribution (classical, piano, ambient),
        predictions may be unreliable (all moods show high values).
        We detect and normalize these cases.
        """
        result = {}
        
        if not self.musicnn_model:
            raise ValueError("MusiCNN model not loaded")
        
        def safe_predict(model, embeddings, model_name: str) -> Tuple[float, float]:
            """
            Safely extract prediction and return (value, confidence).
            
            Returns:
                (value, variance) - value is the mean prediction, variance indicates confidence
                High variance = model is uncertain across frames
            """
            try:
                preds = model(embeddings)
                # preds shape: [frames, 2] for binary classification
                # [:, 1] = probability of positive class
                positive_probs = preds[:, 1]
                raw_value = float(np.mean(positive_probs))
                variance = float(np.var(positive_probs))
                # Clamp to valid probability range
                clamped = max(0.0, min(1.0, raw_value))
                return (round(clamped, 3), round(variance, 4))
            except Exception as e:
                logger.warning(f"Prediction failed for {model_name}: {e}")
                return (0.5, 0.0)
        
        # Step 1: Get embeddings from base MusiCNN model
        # Output shape: [frames, 200] - 200-dimensional embedding per frame
        embeddings = self.musicnn_model(audio_16k)
        logger.debug(f"MusiCNN embeddings shape: {embeddings.shape}")
        
        # Step 2: Pass embeddings through classification heads
        # Each head outputs [frames, 2] where [:, 1] is probability of positive class
        
        # === MOOD PREDICTIONS ===
        # Collect raw predictions with their variances
        raw_moods = {}
        
        if 'mood_happy' in self.prediction_models:
            val, var = safe_predict(self.prediction_models['mood_happy'], embeddings, 'mood_happy')
            raw_moods['moodHappy'] = (val, var)
        
        if 'mood_sad' in self.prediction_models:
            val, var = safe_predict(self.prediction_models['mood_sad'], embeddings, 'mood_sad')
            raw_moods['moodSad'] = (val, var)
        
        if 'mood_relaxed' in self.prediction_models:
            val, var = safe_predict(self.prediction_models['mood_relaxed'], embeddings, 'mood_relaxed')
            raw_moods['moodRelaxed'] = (val, var)
        
        if 'mood_aggressive' in self.prediction_models:
            val, var = safe_predict(self.prediction_models['mood_aggressive'], embeddings, 'mood_aggressive')
            raw_moods['moodAggressive'] = (val, var)
        
        if 'mood_party' in self.prediction_models:
            val, var = safe_predict(self.prediction_models['mood_party'], embeddings, 'mood_party')
            raw_moods['moodParty'] = (val, var)
        
        if 'mood_acoustic' in self.prediction_models:
            val, var = safe_predict(self.prediction_models['mood_acoustic'], embeddings, 'mood_acoustic')
            raw_moods['moodAcoustic'] = (val, var)
        
        if 'mood_electronic' in self.prediction_models:
            val, var = safe_predict(self.prediction_models['mood_electronic'], embeddings, 'mood_electronic')
            raw_moods['moodElectronic'] = (val, var)
        
        # Log raw mood predictions for debugging
        raw_values = {k: v[0] for k, v in raw_moods.items()}
        logger.info(f"ML Raw Moods: H={raw_values.get('moodHappy')}, S={raw_values.get('moodSad')}, R={raw_values.get('moodRelaxed')}, A={raw_values.get('moodAggressive')}")
        
        # === DETECT UNRELIABLE PREDICTIONS ===
        # MusiCNN was trained on pop/rock (MSD). For classical/piano/ambient music,
        # the model often outputs high values for ALL contradictory moods.
        # Detect this and normalize ALL moods to preserve relative ordering.
        all_mood_keys = list(raw_moods.keys())
        all_mood_values = [raw_moods[m][0] for m in all_mood_keys]

        if len(all_mood_values) >= 4:
            min_mood = min(all_mood_values)
            max_mood = max(all_mood_values)

            if min_mood > 0.7 and (max_mood - min_mood) < 0.3:
                logger.warning(f"Detected out-of-distribution audio: all moods high ({min_mood:.2f}-{max_mood:.2f}). Normalizing...")

                for mood_key in all_mood_keys:
                    old_val = raw_moods[mood_key][0]
                    if max_mood > min_mood:
                        normalized = 0.2 + (old_val - min_mood) / (max_mood - min_mood) * 0.6
                    else:
                        normalized = 0.5
                    raw_moods[mood_key] = (round(normalized, 3), raw_moods[mood_key][1])

                logger.info(f"Normalized moods: H={raw_moods.get('moodHappy', (0,0))[0]}, S={raw_moods.get('moodSad', (0,0))[0]}, R={raw_moods.get('moodRelaxed', (0,0))[0]}, A={raw_moods.get('moodAggressive', (0,0))[0]}")
        
        # Store final mood values in result
        for mood_key, (val, var) in raw_moods.items():
            result[mood_key] = val
        
        # === VALENCE (derived from mood models) ===
        # Valence = emotional positivity: happy/party vs sad
        happy = result.get('moodHappy', 0.5)
        sad = result.get('moodSad', 0.5)
        party = result.get('moodParty', 0.5)
        result['valence'] = round(max(0.0, min(1.0, happy * 0.5 + party * 0.3 + (1 - sad) * 0.2)), 3)
        
        # === AROUSAL (derived from mood models) ===
        # Arousal = energy level: aggressive/party/electronic vs relaxed/acoustic
        aggressive = result.get('moodAggressive', 0.5)
        relaxed = result.get('moodRelaxed', 0.5)
        acoustic = result.get('moodAcoustic', 0.5)
        electronic = result.get('moodElectronic', 0.5)
        result['arousal'] = round(max(0.0, min(1.0, aggressive * 0.35 + party * 0.25 + electronic * 0.2 + (1 - relaxed) * 0.1 + (1 - acoustic) * 0.1)), 3)
        
        # === INSTRUMENTALNESS & SPEECHINESS (voice/instrumental) ===
        if 'voice_instrumental' in self.prediction_models:
            val, var = safe_predict(self.prediction_models['voice_instrumental'], embeddings, 'voice_instrumental')
            result['instrumentalness'] = val
            # Derive speechiness: inverse of instrumentalness, scaled down
            result['speechiness'] = round(max(0.0, min(1.0, (1.0 - val) * 0.6)), 3)

        # === ACOUSTICNESS (from mood_acoustic model) ===
        if 'moodAcoustic' in result:
            result['acousticness'] = result['moodAcoustic']

        # === ML DANCEABILITY ===
        if 'danceability' in self.prediction_models:
            val, var = safe_predict(self.prediction_models['danceability'], embeddings, 'danceability')
            result['danceabilityMl'] = val

        return result
    
    def _apply_standard_estimates(self, result: Dict[str, Any], scale: str, bpm: float):
        """
        Apply heuristic estimates for Standard mode.
        
        Uses multiple audio features for more accurate mood estimation:
        - Key (major/minor) correlates with valence
        - BPM correlates with arousal  
        - Energy (RMS) correlates with both
        - Dynamic range indicates acoustic vs electronic
        - Spectral centroid indicates brightness (higher = more energetic)
        - Spectral flatness indicates noise vs tonal (instrumental estimation)
        - Zero-crossing rate indicates speech presence
        """
        result['analysisMode'] = 'standard'
        
        # Get all available features
        energy = result.get('energy', 0.5) or 0.5
        dynamic_range = result.get('dynamicRange', 8) or 8
        danceability = result.get('danceability', 0.5) or 0.5
        spectral_centroid = result.get('_spectral_centroid', 0.5) or 0.5
        spectral_flatness = result.get('_spectral_flatness', -20) or -20
        zcr = result.get('_zcr', 0.1) or 0.1
        
        # === VALENCE (happiness/positivity) ===
        # Major key = happier, minor = sadder
        key_valence = 0.65 if scale == 'major' else 0.35
        
        # Higher tempo tends to be happier
        bpm_valence = 0.5
        if bpm:
            if bpm >= 120:
                bpm_valence = min(0.8, 0.5 + (bpm - 120) / 200)  # Fast = happy
            elif bpm <= 80:
                bpm_valence = max(0.2, 0.5 - (80 - bpm) / 100)   # Slow = melancholic
        
        # Brighter sounds (high spectral centroid) tend to be happier
        # Spectral centroid is 0-1 (fraction of nyquist)
        brightness_valence = min(1.0, spectral_centroid * 1.5)
        
        # Combine factors (key is most important for valence)
        result['valence'] = round(
            key_valence * 0.4 +      # Key is strong indicator
            bpm_valence * 0.25 +     # Tempo matters
            brightness_valence * 0.2 + # Brightness adds positivity
            energy * 0.15,           # Energy adds slight positivity
            3
        )
        
        # === AROUSAL (energy/intensity) ===
        # BPM is the strongest arousal indicator
        bpm_arousal = 0.5
        if bpm:
            # Map 60-180 BPM to 0.1-0.9 arousal
            bpm_arousal = min(0.9, max(0.1, (bpm - 60) / 140))
        
        # Energy directly indicates intensity
        energy_arousal = energy
        
        # Low dynamic range = compressed = more intense
        compression_arousal = max(0, min(1.0, 1 - (dynamic_range / 20)))
        
        # Brightness adds to perceived energy
        brightness_arousal = min(1.0, spectral_centroid * 1.2)
        
        # Combine factors (BPM and energy are most important)
        result['arousal'] = round(
            bpm_arousal * 0.35 +       # Tempo is key
            energy_arousal * 0.35 +    # Energy/loudness
            brightness_arousal * 0.15 + # Brightness adds energy
            compression_arousal * 0.15, # Compression = intensity
            3
        )
        
        # === INSTRUMENTALNESS ===
        # High spectral flatness (closer to 0 dB) = more noise-like = more instrumental
        # Low spectral flatness (closer to -60 dB) = more tonal = likely vocals
        # ZCR also helps - vocals have moderate ZCR
        flatness_normalized = min(1.0, max(0, (spectral_flatness + 40) / 40))  # -40 to 0 dB -> 0 to 1
        
        # High ZCR often indicates percussion/hi-hats OR speech
        # Very low ZCR indicates sustained tones (likely instrumental)
        if zcr < 0.05:
            zcr_instrumental = 0.7  # Very low = likely sustained instrumental
        elif zcr > 0.15:
            zcr_instrumental = 0.4  # High = could be speech or percussion
        else:
            zcr_instrumental = 0.5  # Moderate = uncertain
        
        result['instrumentalness'] = round(
            flatness_normalized * 0.6 + zcr_instrumental * 0.4,
            3
        )
        
        # === ACOUSTICNESS ===
        # High dynamic range = acoustic (natural dynamics)
        # Low dynamic range = compressed/electronic
        result['acousticness'] = round(min(1.0, dynamic_range / 12), 3)
        
        # === SPEECHINESS ===
        # Speech has characteristic ZCR pattern and moderate spectral centroid
        if zcr > 0.08 and zcr < 0.2 and spectral_centroid > 0.1 and spectral_centroid < 0.4:
            result['speechiness'] = round(min(0.5, zcr * 3), 3)
        else:
            result['speechiness'] = 0.1
    
    def _generate_mood_tags(self, features: Dict[str, Any]) -> List[str]:
        """
        Generate mood tags based on extracted features.
        
        In Enhanced mode, uses ML predictions for more accurate tagging.
        In Standard mode, uses heuristic rules.
        """
        tags = []
        
        bpm = features.get('bpm', 0) or 0
        energy = features.get('energy', 0.5) or 0.5
        valence = features.get('valence', 0.5) or 0.5
        arousal = features.get('arousal', 0.5) or 0.5
        danceability = features.get('danceability', 0.5) or 0.5
        key_scale = features.get('keyScale', '')
        
        # Enhanced mode: use ML mood predictions
        mood_happy = features.get('moodHappy')
        mood_sad = features.get('moodSad')
        mood_relaxed = features.get('moodRelaxed')
        mood_aggressive = features.get('moodAggressive')
        
        # ML-based tags (higher confidence)
        if mood_happy is not None and mood_happy >= 0.6:
            tags.append('happy')
            tags.append('uplifting')
        if mood_sad is not None and mood_sad >= 0.6:
            tags.append('sad')
            tags.append('melancholic')
        if mood_relaxed is not None and mood_relaxed >= 0.6:
            tags.append('relaxed')
            tags.append('chill')
        if mood_aggressive is not None and mood_aggressive >= 0.6:
            tags.append('aggressive')
            tags.append('intense')
        
        # Arousal-based tags (prefer ML arousal)
        if arousal >= 0.7:
            tags.append('energetic')
            tags.append('upbeat')
        elif arousal <= 0.3:
            tags.append('calm')
            tags.append('peaceful')
        
        # Valence-based tags (if not already added by ML)
        if 'happy' not in tags and 'sad' not in tags:
            if valence >= 0.7:
                tags.append('happy')
                tags.append('uplifting')
            elif valence <= 0.3:
                tags.append('sad')
                tags.append('melancholic')
        
        # Danceability-based tags
        if danceability >= 0.7:
            tags.append('dance')
            tags.append('groovy')
        
        # BPM-based tags
        if bpm >= 140:
            tags.append('fast')
        elif bpm <= 80:
            tags.append('slow')
        
        # Key-based tags
        if key_scale == 'minor':
            if 'happy' not in tags:
                tags.append('moody')
        
        # Combination tags
        if arousal >= 0.7 and bpm >= 120:
            tags.append('workout')
        if arousal <= 0.4 and valence <= 0.4:
            tags.append('atmospheric')
        if arousal <= 0.3 and bpm <= 90:
            tags.append('chill')
        if mood_aggressive is not None and mood_aggressive >= 0.5 and bpm >= 120:
            tags.append('intense')
        
        return list(set(tags))[:12]  # Dedupe and limit


# Global analyzer instance for worker processes (initialized per-process)
_process_analyzer = None

def _pool_health_check():
    """No-op function for pool health checks (lambdas can't be pickled with spawn mode)."""
    return True

def _init_worker_process():
    """
    Initialize the analyzer for a worker process.
    
    If model loading fails, the analyzer will fall back to Standard mode.
    This prevents worker crashes from breaking the entire process pool.
    """
    global _process_analyzer
    try:
        _process_analyzer = AudioAnalyzer()
        mode = "Enhanced" if _process_analyzer.enhanced_mode else "Standard"
        logger.info(f"Worker process {os.getpid()} initialized with analyzer ({mode} mode)")
    except Exception as e:
        logger.error(f"Worker initialization error: {e}")
        logger.error("This worker will not be able to process tracks.")
        logger.error(f"Traceback: {traceback.format_exc()}")
        # Re-raise to kill this worker - better than silent failures
        raise

def _analyze_track_in_process(args: Tuple[str, str]) -> Tuple[str, str, Dict[str, Any]]:
    """
    Analyze a single track in a worker process.
    Returns (track_id, file_path, features_dict or error_dict)
    """
    global _process_analyzer
    track_id, file_path = args
    
    try:
        # Ensure path is properly decoded (Issue #6 fix)
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

        # Run analysis
        features = _process_analyzer.analyze(full_path)
        return (track_id, file_path, features)
        
    except UnicodeDecodeError as e:
        logger.error(f"UTF-8 decoding error for track {track_id}: {e}")
        return (track_id, file_path, {'_error': f'UTF-8 encoding error: {e}'})
    except Exception as e:
        logger.error(f"Analysis error for {file_path}: {e}")
        return (track_id, file_path, {'_error': str(e)})


class AnalysisWorker:
    """Worker that processes audio analysis jobs from Redis queue using parallel processing"""
    
    IDLE_SHUTDOWN_CYCLES = 10  # Shut down pool after this many empty cycles (~50s at 5s interval)

    def __init__(self):
        self.redis = redis.from_url(REDIS_URL)
        self.db = DatabaseConnection(DATABASE_URL)
        self.running = False
        self.executor = None
        self.pool_active = False
        self.consecutive_empty = 0
        self.is_paused = False  # Enrichment control: pause state
        self.pubsub = None  # Redis pub/sub for control signals
        self._last_work_time = time.time()
        self._pending_resize: int | None = None
        self._pending_resize_time: float = 0.0
        self._setup_control_channel()
    
    def _setup_control_channel(self):
        """Subscribe to control channel for pause/resume/stop signals"""
        try:
            self.pubsub = self.redis.pubsub()
            self.pubsub.subscribe(CONTROL_CHANNEL)
            logger.info(f"Subscribed to control channel: {CONTROL_CHANNEL}")
        except Exception as e:
            logger.warning(f"Failed to subscribe to control channel: {e}")
            self.pubsub = None
    
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
                        new_count = int(cmd.get('count', NUM_WORKERS))
                        new_count = max(1, min(8, new_count))
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
        
        old_executor = self.executor
        NUM_WORKERS = new_count
        
        # Create new pool first
        self.executor = ProcessPoolExecutor(
            max_workers=NUM_WORKERS,
            initializer=_init_worker_process
        )
        
        # Gracefully shutdown old pool (wait for in-flight work)
        if old_executor:
            try:
                old_executor.shutdown(wait=True)
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
        
        # Check if pool is explicitly marked as broken
        if hasattr(self.executor, '_broken') and self.executor._broken:
            return False
        
        # Try a no-op submission to verify pool works
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
        logger.info(f"Starting worker pool with {NUM_WORKERS} processes...")
        self.executor = ProcessPoolExecutor(
            max_workers=NUM_WORKERS,
            initializer=_init_worker_process
        )
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
        gc.collect()
        # Force glibc to return freed pages to OS (Python/PyTorch hold RSS otherwise)
        try:
            import ctypes
            ctypes.CDLL("libc.so.6").malloc_trim(0)
        except Exception:
            pass
        logger.info("Worker pool shut down (will restart when work arrives)")

    def _recreate_pool(self):
        """
        Safely terminate the broken pool and create a new one.
        This is the critical recovery mechanism for Issue #21.
        """
        logger.warning("Recreating process pool due to broken workers...")

        # Attempt graceful shutdown first
        if self.executor:
            try:
                self.executor.shutdown(wait=False)
            except Exception as e:
                logger.warning(f"Error during executor shutdown: {e}")
            self.executor = None
            self.pool_active = False

        # Small delay to allow cleanup
        time.sleep(2)

        # Create fresh pool
        self._ensure_pool()
        logger.info(f"Process pool recreated with {NUM_WORKERS} workers")
    
    def _cleanup_stale_processing(self):
        """Reset tracks stuck in 'processing' status (from crashed workers).
        Checks for existing embeddings first to avoid resetting completed work.
        """
        cursor = self.db.get_cursor()
        try:
            # First: recover tracks that have embeddings but are stuck in processing
            cursor.execute("""
                UPDATE "Track" t
                SET
                    "analysisStatus" = 'completed',
                    "analysisError" = NULL,
                    "analysisStartedAt" = NULL
                FROM track_embeddings te
                WHERE t.id = te.track_id
                AND t."analysisStatus" = 'processing'
                AND (
                    (t."analysisStartedAt" IS NOT NULL AND t."analysisStartedAt" < NOW() - INTERVAL '%s minutes')
                    OR
                    (t."analysisStartedAt" IS NULL AND t."updatedAt" < NOW() - INTERVAL '%s minutes')
                )
                RETURNING t.id
            """, (STALE_PROCESSING_MINUTES, STALE_PROCESSING_MINUTES))

            recovered_ids = cursor.fetchall()
            recovered_count = len(recovered_ids)

            if recovered_count > 0:
                logger.info(f"Recovered {recovered_count} stale tracks that already had embeddings")

            # Then: reset truly stale tracks (no embedding) back to pending
            cursor.execute("""
                UPDATE "Track" t
                SET
                    "analysisStatus" = 'pending',
                    "analysisStartedAt" = NULL,
                    "analysisRetryCount" = COALESCE(t."analysisRetryCount", 0) + 1
                WHERE t."analysisStatus" = 'processing'
                AND (
                    (t."analysisStartedAt" IS NOT NULL AND t."analysisStartedAt" < NOW() - INTERVAL '%s minutes')
                    OR
                    (t."analysisStartedAt" IS NULL AND t."updatedAt" < NOW() - INTERVAL '%s minutes')
                )
                AND COALESCE(t."analysisRetryCount", 0) < %s
                AND NOT EXISTS (SELECT 1 FROM track_embeddings te WHERE te.track_id = t.id)
                RETURNING t.id
            """, (STALE_PROCESSING_MINUTES, STALE_PROCESSING_MINUTES, MAX_RETRIES))

            reset_ids = cursor.fetchall()
            reset_count = len(reset_ids)

            if reset_count > 0:
                logger.info(f"Reset {reset_count} stale 'processing' tracks back to 'pending'")

            self.db.commit()
        except Exception as e:
            logger.error(f"Failed to cleanup stale tracks: {e}")
            self.db.rollback()
        finally:
            cursor.close()
    
    def _retry_failed_tracks(self):
        """Retry failed tracks that haven't exceeded max retries.
        Recovers tracks that have embeddings but are incorrectly marked failed.
        """
        cursor = self.db.get_cursor()
        try:
            # First: recover tracks marked failed that actually have embeddings
            cursor.execute("""
                UPDATE "Track" t
                SET
                    "analysisStatus" = 'completed',
                    "analysisError" = NULL,
                    "analysisStartedAt" = NULL
                FROM track_embeddings te
                WHERE t.id = te.track_id
                AND t."analysisStatus" = 'failed'
                RETURNING t.id
            """)

            recovered_ids = cursor.fetchall()
            if len(recovered_ids) > 0:
                logger.info(f"Recovered {len(recovered_ids)} 'failed' tracks that already had embeddings")

            # Then: retry truly failed tracks (no embedding)
            cursor.execute("""
                UPDATE "Track" t
                SET
                    "analysisStatus" = 'pending',
                    "analysisError" = NULL,
                    "analysisRetryCount" = COALESCE(t."analysisRetryCount", 0)
                WHERE t."analysisStatus" = 'failed'
                AND COALESCE(t."analysisRetryCount", 0) < %s
                AND NOT EXISTS (SELECT 1 FROM track_embeddings te WHERE te.track_id = t.id)
                RETURNING t.id
            """, (MAX_RETRIES,))
            
            retry_ids = cursor.fetchall()
            retry_count = len(retry_ids)
            
            if retry_count > 0:
                logger.info(f"Re-queued {retry_count} failed tracks for retry (max retries: {MAX_RETRIES})")
            
            # Also log tracks that have permanently failed
            cursor.execute("""
                SELECT COUNT(*) as count
                FROM "Track"
                WHERE "analysisStatus" = 'failed'
                AND COALESCE("analysisRetryCount", 0) >= %s
            """, (MAX_RETRIES,))
            
            perm_failed = cursor.fetchone()
            if perm_failed and perm_failed['count'] > 0:
                logger.warning(f"{perm_failed['count']} tracks have permanently failed (exceeded {MAX_RETRIES} retries)")
            
            self.db.commit()
        except Exception as e:
            logger.error(f"Failed to retry failed tracks: {e}")
            self.db.rollback()
        finally:
            cursor.close()
    
    def _run_db_reconciliation(self) -> bool:
        """
        Check database for pending tracks that may have been missed by Redis queue.
        Handles edge cases: manual DB edits, crash recovery, queue loss.
        Marks tracks as 'processing' in DB first (prevents backend double-queuing),
        then pushes them into the Redis queue so BRPOP picks them up.

        Returns True if pending work was found, False if nothing to do.
        """
        cursor = self.db.get_cursor()
        try:
            cursor.execute("""
                SELECT id, "filePath"
                FROM "Track"
                WHERE "analysisStatus" = 'pending'
                AND COALESCE("analysisRetryCount", 0) < %s
                ORDER BY "fileModified" DESC
                LIMIT %s
            """, (MAX_RETRIES, BATCH_SIZE))

            tracks = cursor.fetchall()
            if tracks:
                logger.info(f"DB reconciliation found {len(tracks)} pending tracks, queuing...")
                track_ids = [t['id'] for t in tracks]
                cursor.execute("""
                    UPDATE "Track"
                    SET "analysisStatus" = 'processing',
                        "analysisStartedAt" = NOW()
                    WHERE id = ANY(%s)
                """, (track_ids,))
                self.db.commit()
                pipe = self.redis.pipeline()
                for t in tracks:
                    pipe.rpush(ANALYSIS_QUEUE, json.dumps({
                        'trackId': t['id'],
                        'filePath': t['filePath']
                    }))
                pipe.execute()
                return True
            return False
        except Exception as e:
            logger.error(f"DB reconciliation failed: {e}")
            self.db.rollback()
            return False
        finally:
            cursor.close()

    def start(self):
        """Start processing jobs with BRPOP-driven event loop"""
        cpu_count = os.cpu_count() or 4

        logger.info("=" * 60)
        logger.info("Starting Audio Analysis Worker (BRPOP MODE)")
        logger.info("=" * 60)
        logger.info(f"  Music path: {MUSIC_PATH}")
        logger.info(f"  Batch size: {BATCH_SIZE}")
        logger.info(f"  CPU cores: {cpu_count}")
        logger.info(f"  Worker processes: {NUM_WORKERS}")
        logger.info(f"  BRPOP timeout: {BRPOP_TIMEOUT}s")
        logger.info(f"  Model idle timeout: {MODEL_IDLE_TIMEOUT}s")
        logger.info(f"  Max retries per track: {MAX_RETRIES}")
        logger.info(f"  Stale processing timeout: {STALE_PROCESSING_MINUTES} minutes")
        logger.info(f"  Essentia available: {ESSENTIA_AVAILABLE}")
        logger.info(f"  ML models on disk: {TF_MODELS_AVAILABLE}")
        logger.info(f"  Worker pool: LAZY (starts on first job)")

        self.db.connect()
        self.running = True

        logger.info("Cleaning up stale processing tracks...")
        self._cleanup_stale_processing()
        logger.info("Checking for failed tracks to retry...")
        self._retry_failed_tracks()

        # Check for any already-queued work before entering BRPOP loop
        self._run_db_reconciliation()

        try:
            while self.running:
                try:
                    # Publish heartbeat
                    try:
                        self.redis.set("audio:worker:heartbeat", str(int(time.time() * 1000)))
                    except Exception:
                        pass

                    # Check for control signals (pause/resume/stop/set_workers)
                    self._check_control_signals()
                    self._apply_pending_resize()

                    if self.is_paused:
                        logger.debug("Audio analysis paused, waiting for resume signal...")
                        time.sleep(1)
                        continue

                    # BRPOP-driven: blocks until work arrives or timeout
                    has_work = self.process_batch_parallel()

                    if has_work:
                        self.consecutive_empty = 0
                        self._last_work_time = time.time()
                    else:
                        # BRPOP timed out -- run periodic maintenance
                        self.consecutive_empty += 1
                        found_work = self._run_db_reconciliation()

                        # Unload models when idle: immediately if DB has no pending
                        # work, or after MODEL_IDLE_TIMEOUT as a fallback
                        if self.pool_active and not found_work:
                            idle_seconds = time.time() - self._last_work_time
                            if idle_seconds >= MODEL_IDLE_TIMEOUT:
                                self._shutdown_pool()
                                logger.info(f"Models idle for {idle_seconds:.0f}s, pool shut down")
                            elif idle_seconds >= BRPOP_TIMEOUT:
                                # No pending work in DB and queue empty -- unload now
                                self._shutdown_pool()
                                logger.info("All work complete, pool shut down (will restart when work arrives)")

                        # Periodic cleanup every IDLE_SHUTDOWN_CYCLES timeouts
                        if self.consecutive_empty >= self.IDLE_SHUTDOWN_CYCLES:
                            self._cleanup_stale_processing()
                            self._retry_failed_tracks()
                            self.consecutive_empty = 0

                except KeyboardInterrupt:
                    logger.info("Shutdown requested")
                    self.running = False
                except BrokenProcessPool:
                    logger.error("BrokenProcessPool detected, recreating pool...")
                    self._recreate_pool()
                    self._cleanup_stale_processing()
                    continue
                except Exception as e:
                    logger.error(f"Worker error: {e}")
                    traceback.print_exc()
                    self.consecutive_empty += 1

                    if self.consecutive_empty >= 5:
                        logger.info("Multiple consecutive errors, attempting recovery...")
                        try:
                            self.db.close()
                            time.sleep(2)
                            self.db.connect()
                            self._cleanup_stale_processing()
                            self._retry_failed_tracks()
                            if self.pool_active and not self._check_pool_health():
                                self._recreate_pool()
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
    
    def process_batch_parallel(self) -> bool:
        """Process a batch of pending tracks in parallel.

        Uses BRPOP to wait for the first job (blocking, zero CPU),
        then drains remaining queued jobs up to BATCH_SIZE.

        Returns:
            True if there was work to process, False if BRPOP timed out
        """
        result = self.redis.brpop(ANALYSIS_QUEUE, timeout=BRPOP_TIMEOUT)

        if result is None:
            return False

        _, first_job_data = result
        first_job = json.loads(first_job_data)
        queued_jobs = [(first_job['trackId'], first_job.get('filePath', ''))]

        while len(queued_jobs) < BATCH_SIZE:
            job_data = self.redis.lpop(ANALYSIS_QUEUE)
            if not job_data:
                break
            job = json.loads(job_data)
            queued_jobs.append((job['trackId'], job.get('filePath', '')))

        self._process_tracks_parallel(queued_jobs)
        return True
    
    def _process_tracks_parallel(self, tracks: List[Tuple[str, str]]):
        """Process multiple tracks in parallel using the process pool"""
        if not tracks:
            return

        self._ensure_pool()
        logger.info(f"Processing batch of {len(tracks)} tracks with {NUM_WORKERS} workers...")
        
        # Mark all as processing
        cursor = self.db.get_cursor()
        try:
            track_ids = [t[0] for t in tracks]
            cursor.execute("""
                UPDATE "Track"
                SET "analysisStatus" = 'processing',
                    "analysisStartedAt" = NOW()
                WHERE id = ANY(%s)
            """, (track_ids,))
            self.db.commit()
        except Exception as e:
            logger.error(f"Failed to mark tracks as processing: {e}")
            self.db.rollback()
        finally:
            cursor.close()
        
        # Submit all tracks to the process pool
        start_time = time.time()
        completed = 0
        failed = 0
        
        futures = {self.executor.submit(_analyze_track_in_process, t): t for t in tracks}
        
        for future in as_completed(futures, timeout=900):  # 15 min timeout per batch (increased from 5 min to handle hi-res files)
            try:
                track_id, file_path, features = future.result(timeout=180)  # 3 min per track (increased from 1 min for hi-res FLAC)
                
                if features.get('_error'):
                    self._save_failed(track_id, features['_error'])
                    failed += 1
                    logger.error(f"✗ Failed: {file_path} - {features['_error']}")
                else:
                    self._save_results(track_id, file_path, features)
                    completed += 1
                    logger.info(f"✓ Completed: {file_path}")
            except Exception as e:
                # Handle timeout or other errors
                track_info = futures[future]
                self._save_failed(track_info[0], f"Timeout or error: {e}")
                failed += 1
                logger.error(f"✗ Failed: {track_info[1]} - {e}")
        
        elapsed = time.time() - start_time
        rate = len(tracks) / elapsed if elapsed > 0 else 0
        logger.info(f"Batch complete: {completed} succeeded, {failed} failed in {elapsed:.1f}s ({rate:.1f} tracks/sec)")
    
    def _save_results(self, track_id: str, file_path: str, features: Dict[str, Any]):
        """Save analysis results to database and resolve any stale EnrichmentFailure record."""
        cursor = self.db.get_cursor()
        try:
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
                    valence = %s,
                    arousal = %s,
                    instrumentalness = %s,
                    acousticness = %s,
                    speechiness = %s,
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
                    "analysisStatus" = 'completed',
                    "analysisStartedAt" = NULL,
                    "analysisVersion" = %s,
                    "analyzedAt" = %s,
                    "analysisError" = NULL
                WHERE id = %s AND "analysisStatus" = 'processing'
            """, (
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
                features['instrumentalness'],
                features['acousticness'],
                features['speechiness'],
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
                features.get('analysisMode', 'standard'),
                ESSENTIA_VERSION,
                datetime.now(timezone.utc),
                track_id
            ))
            if cursor.rowcount == 0:
                logger.warning(f"Track {track_id} was reset by cleanup before save completed, skipping")
                self.db.rollback()
                return
            # Resolve any stale EnrichmentFailure record from a previous attempt
            cursor.execute("""
                UPDATE "EnrichmentFailure"
                SET resolved = true, "resolvedAt" = NOW()
                WHERE "entityType" = 'audio' AND "entityId" = %s AND resolved = false
            """, (track_id,))

            self.db.commit()

            # Publish completion event for Node audio completion subscriber
            # Node subscribes and queues a BullMQ vibe embedding job (enrichment:vibe)
            try:
                completion_event = json.dumps({
                    "trackId": track_id,
                    "filePath": file_path,
                    "status": "complete",
                })
                self.redis.publish("audio:analysis:complete", completion_event)
                logger.debug(f"[Essentia] Published completion for track {track_id}")
            except Exception as pub_err:
                logger.warning(f"[Essentia] Failed to publish completion event for {track_id}: {pub_err}")

        except Exception as e:
            logger.error(f"Failed to save results for {track_id}: {e}")
            self.db.rollback()
        finally:
            cursor.close()
    
    def _save_failed(self, track_id: str, error: str):
        """Mark track as failed and increment retry count.

        EnrichmentFailure records are created by the Node.js audioAnalysisCleanup
        service only after max retries are exhausted, avoiding premature failure
        visibility and competing writers.
        """
        cursor = self.db.get_cursor()
        try:
            # Update track status
            cursor.execute("""
                UPDATE "Track"
                SET
                    "analysisStatus" = 'failed',
                    "analysisError" = %s,
                    "analysisRetryCount" = COALESCE("analysisRetryCount", 0) + 1
                WHERE id = %s AND "analysisStatus" = 'processing'
                RETURNING "analysisRetryCount"
            """, (error[:500], track_id))

            if cursor.rowcount == 0:
                logger.warning(f"Track {track_id} was reset by cleanup before failure marked, skipping")
                self.db.rollback()
                return

            result = cursor.fetchone()
            retry_count = result['analysisRetryCount'] if result else 0

            if retry_count >= MAX_RETRIES:
                logger.warning(f"Track {track_id} has permanently failed after {retry_count} attempts")
            else:
                logger.info(f"Track {track_id} failed (attempt {retry_count}/{MAX_RETRIES}, will retry)")
            
            self.db.commit()
        except Exception as e:
            logger.error(f"Failed to mark track as failed: {e}")
            logger.error(f"Traceback: {traceback.format_exc()}")
            self.db.rollback()
        finally:
            cursor.close()


def main():
    """Main entry point"""
    if len(sys.argv) > 1 and sys.argv[1] == '--test':
        # Test mode: analyze a single file
        if len(sys.argv) < 3:
            print("Usage: analyzer.py --test <audio_file>")
            sys.exit(1)
        
        analyzer = AudioAnalyzer()
        result = analyzer.analyze(sys.argv[2])
        print(json.dumps(result, indent=2))
        return
    
    # Normal worker mode
    worker = AnalysisWorker()
    worker.start()


if __name__ == '__main__':
    main()

