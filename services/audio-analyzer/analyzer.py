#!/usr/bin/env python3
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

import os
import sys
import json
import time
import logging
from datetime import datetime
from typing import Dict, Any, Optional, List, Tuple
import traceback
import numpy as np
from concurrent.futures import ProcessPoolExecutor, as_completed
import multiprocessing

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
TF_MODELS_AVAILABLE = False
TensorflowPredictMusiCNN = None
try:
    import tensorflow as tf
    # Limit TensorFlow memory usage (CPU & GPU)
    try:
        gpus = tf.config.experimental.list_physical_devices('GPU')
        for gpu in gpus:
            tf.config.experimental.set_memory_growth(gpu, True)
    except Exception:
        pass
    from essentia.standard import TensorflowPredictMusiCNN
    TF_MODELS_AVAILABLE = True
    logger.info("TensorflowPredictMusiCNN available - Enhanced mode enabled")
except ImportError as e:
    logger.warning(f"TensorflowPredictMusiCNN not available: {e}")
    logger.info("Falling back to Standard mode")

# Configuration from environment
REDIS_URL = os.getenv('REDIS_URL', 'redis://localhost:6379')
DATABASE_URL = os.getenv('DATABASE_URL', '')
MUSIC_PATH = os.getenv('MUSIC_PATH', '/music')
BATCH_SIZE = int(os.getenv('BATCH_SIZE', '10'))
SLEEP_INTERVAL = int(os.getenv('SLEEP_INTERVAL', '5'))

# Auto-scaling workers: use 50% of CPU cores, min 2, max 8
# Can be overridden with NUM_WORKERS environment variable
def _get_auto_workers() -> int:
    """Calculate optimal worker count based on CPU cores"""
    cpu_count = os.cpu_count() or 4
    auto_workers = max(2, min(8, cpu_count // 2))
    return auto_workers

NUM_WORKERS = int(os.getenv('NUM_WORKERS', str(_get_auto_workers())))
ESSENTIA_VERSION = '2.1b6-enhanced-v2'

# Retry configuration
MAX_RETRIES = int(os.getenv('MAX_RETRIES', '3'))  # Max retry attempts per track
STALE_PROCESSING_MINUTES = int(os.getenv('STALE_PROCESSING_MINUTES', '10'))  # Reset tracks stuck in 'processing'

# Queue names
ANALYSIS_QUEUE = 'audio:analysis:queue'
ANALYSIS_PROCESSING = 'audio:analysis:processing'

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

class DatabaseConnection:
    """PostgreSQL connection manager"""
    
    def __init__(self, url: str):
        self.url = url
        self.conn = None
    
    def connect(self):
        """Establish database connection"""
        if not self.url:
            raise ValueError("DATABASE_URL not set")
        self.conn = psycopg2.connect(self.url)
        self.conn.autocommit = False
        logger.info("Connected to PostgreSQL")
    
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


class AudioAnalyzer:
    """
    Enhanced audio analysis using Essentia with TensorFlow models.
    
    Supports two modes:
    - Enhanced: Uses ML models for accurate mood/valence/arousal (default)
    - Standard: Uses heuristics when models aren't available (fallback)
    """
    
    def __init__(self):
        self.loaders = {}
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
        
        logger.info("Essentia basic algorithms initialized")
    
    def _load_ml_models(self):
        """
        Load MusiCNN TensorFlow models for Enhanced mode.
        
        Architecture:
        1. Base MusiCNN model generates embeddings from audio
        2. Classification head models take embeddings and output predictions
        """
        if not TF_MODELS_AVAILABLE:
            logger.info("TensorFlow not available - using Standard mode")
            return
        
        try:
            from essentia.standard import TensorflowPredict2D
            logger.info("Loading MusiCNN models...")
            
            # First, load the base MusiCNN embedding model
            if os.path.exists(MODELS['musicnn']):
                self.musicnn_model = TensorflowPredictMusiCNN(
                    graphFilename=MODELS['musicnn'],
                    output="model/dense/BiasAdd"  # Embedding layer output
                )
                logger.info("Loaded base MusiCNN model for embeddings")
            else:
                logger.error(f"Base MusiCNN model not found: {MODELS['musicnn']}")
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
    
    def load_audio(self, file_path: str, sample_rate: int = 16000) -> Optional[Any]:
        """Load audio file as mono signal"""
        if not ESSENTIA_AVAILABLE:
            return None
        
        try:
            loader = es.MonoLoader(filename=file_path, sampleRate=sample_rate)
            audio = loader()
            return audio
        except Exception as e:
            logger.error(f"Failed to load audio {file_path}: {e}")
            return None
    
    def analyze(self, file_path: str) -> Dict[str, Any]:
        """
        Analyze audio file and extract all features.
        
        Uses Enhanced mode (ML models) if available, otherwise Standard mode (heuristics).
        
        Returns dict with:
        - bpm: float
        - beatsCount: int
        - key: str
        - keyScale: str
        - keyStrength: float
        - energy: float
        - loudness: float
        - dynamicRange: float
        - danceability: float
        - valence: float (ML-predicted in Enhanced mode)
        - arousal: float (ML-predicted in Enhanced mode)
        - instrumentalness: float (ML-predicted in Enhanced mode)
        - acousticness: float
        - speechiness: float
        - moodTags: list[str]
        - essentiaGenres: list[str]
        - moodHappy: float (Enhanced mode only)
        - moodSad: float (Enhanced mode only)
        - moodRelaxed: float (Enhanced mode only)
        - moodAggressive: float (Enhanced mode only)
        - danceabilityMl: float (Enhanced mode only)
        - analysisMode: str ('enhanced' or 'standard')
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
            'essentiaGenres': [],
            # Enhanced mode fields
            'moodHappy': None,
            'moodSad': None,
            'moodRelaxed': None,
            'moodAggressive': None,
            'danceabilityMl': None,
            'analysisMode': 'standard',
        }
        
        if not ESSENTIA_AVAILABLE:
            logger.error("Essentia not available - cannot analyze audio files")
            result['_error'] = 'Essentia library not installed'
            return result
        
        # Load audio at different sample rates for different algorithms
        audio_44k = self.load_audio(file_path, 44100)
        audio_16k = self.load_audio(file_path, 16000)
        
        if audio_44k is None or audio_16k is None:
            return result
        
        try:
            # === BASIC FEATURES (always extracted) ===
            
            # Rhythm Analysis
            bpm, beats, beats_confidence, _, beats_intervals = self.rhythm_extractor(audio_44k)
            result['bpm'] = round(float(bpm), 1)
            result['beatsCount'] = len(beats)
            
            # Key Detection
            key, scale, strength = self.key_extractor(audio_44k)
            result['key'] = key
            result['keyScale'] = scale
            result['keyStrength'] = round(float(strength), 3)
            
            # Energy & Dynamics - using RMS for proper 0-1 energy
            rms_values = []
            zcr_values = []
            spectral_centroid_values = []
            spectral_flatness_values = []
            
            # Process audio in frames for detailed analysis
            frame_size = 2048
            hop_size = 1024
            for i in range(0, len(audio_44k) - frame_size, hop_size):
                frame = audio_44k[i:i + frame_size]
                windowed = self.windowing(frame)
                spectrum = self.spectrum(windowed)
                
                rms_values.append(self.rms(frame))
                zcr_values.append(self.zcr(frame))
                spectral_centroid_values.append(self.spectral_centroid(spectrum))
                spectral_flatness_values.append(self.spectral_flatness(spectrum))
            
            # RMS-based energy (properly normalized to 0-1)
            if rms_values:
                avg_rms = np.mean(rms_values)
                # RMS is typically 0.0-0.5 for normalized audio, scale to 0-1
                result['energy'] = round(min(1.0, float(avg_rms) * 3), 3)
            else:
                result['energy'] = 0.5
            
            loudness = self.loudness(audio_44k)
            result['loudness'] = round(float(loudness), 2)
            
            dynamic_range, _ = self.dynamic_complexity(audio_44k)
            result['dynamicRange'] = round(float(dynamic_range), 2)
            
            # Store spectral features for Standard mode estimates
            result['_spectral_centroid'] = np.mean(spectral_centroid_values) if spectral_centroid_values else 0.5
            result['_spectral_flatness'] = np.mean(spectral_flatness_values) if spectral_flatness_values else -20
            result['_zcr'] = np.mean(zcr_values) if zcr_values else 0.1
            
            # Basic Danceability (non-ML)
            # Note: es.Danceability() can return values > 1.0, so we clamp
            danceability, _ = self.danceability_extractor(audio_44k)
            result['danceability'] = round(max(0.0, min(1.0, float(danceability))), 3)
            
            # === ENHANCED MODE: Use ML models ===
            if self.enhanced_mode:
                try:
                    ml_features = self._extract_ml_features(audio_16k)
                    result.update(ml_features)
                    result['analysisMode'] = 'enhanced'
                    logger.info(f"Enhanced analysis: valence={result['valence']}, arousal={result['arousal']}")
                except Exception as e:
                    logger.warning(f"ML analysis failed, falling back to Standard: {e}")
                    traceback.print_exc()
                    self._apply_standard_estimates(result, scale, bpm)
            else:
                # === STANDARD MODE: Use heuristics ===
                self._apply_standard_estimates(result, scale, bpm)
            
            # Generate mood tags based on all features
            result['moodTags'] = self._generate_mood_tags(result)
            
            logger.info(f"Analysis complete [{result['analysisMode']}]: BPM={result['bpm']}, Key={result['key']} {result['keyScale']}, Valence={result['valence']}, Arousal={result['arousal']}")
            
        except Exception as e:
            logger.error(f"Analysis error: {e}")
            traceback.print_exc()
        
        # Clean up internal fields before returning
        for key in ['_spectral_centroid', '_spectral_flatness', '_zcr']:
            result.pop(key, None)
        
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
        # Detect this and normalize to preserve relative ordering.
        core_moods = ['moodHappy', 'moodSad', 'moodRelaxed', 'moodAggressive']
        core_values = [raw_moods[m][0] for m in core_moods if m in raw_moods]
        
        if len(core_values) >= 4:
            min_mood = min(core_values)
            max_mood = max(core_values)
            
            # If all core moods are > 0.7 AND the range is small,
            # the predictions are likely unreliable (out-of-distribution audio)
            if min_mood > 0.7 and (max_mood - min_mood) < 0.3:
                logger.warning(f"Detected out-of-distribution audio: all moods high ({min_mood:.2f}-{max_mood:.2f}). Normalizing...")
                
                # Normalize: scale so max becomes 0.8 and min becomes 0.2
                # This preserves relative ordering while creating useful differentiation
                for mood_key in core_moods:
                    if mood_key in raw_moods:
                        old_val = raw_moods[mood_key][0]
                        if max_mood > min_mood:
                            # Linear scaling: min->0.2, max->0.8
                            normalized = 0.2 + (old_val - min_mood) / (max_mood - min_mood) * 0.6
                        else:
                            normalized = 0.5  # All values equal, use neutral
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
        
        # === INSTRUMENTALNESS (voice/instrumental) ===
        if 'voice_instrumental' in self.prediction_models:
            val, var = safe_predict(self.prediction_models['voice_instrumental'], embeddings, 'voice_instrumental')
            result['instrumentalness'] = val
        
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
        
        # Clean up internal fields (don't store in DB)
        for key in ['_spectral_centroid', '_spectral_flatness', '_zcr']:
            result.pop(key, None)
    
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

def _init_worker_process():
    """Initialize the analyzer for a worker process"""
    global _process_analyzer
    _process_analyzer = AudioAnalyzer()
    logger.info(f"Worker process {os.getpid()} initialized with analyzer")

def _analyze_track_in_process(args: Tuple[str, str]) -> Tuple[str, str, Dict[str, Any]]:
    """
    Analyze a single track in a worker process.
    Returns (track_id, file_path, features_dict or error_dict)
    """
    global _process_analyzer
    track_id, file_path = args
    
    try:
        # Normalize path separators (Windows paths -> Unix)
        normalized_path = file_path.replace('\\', '/')
        full_path = os.path.join(MUSIC_PATH, normalized_path)
        
        if not os.path.exists(full_path):
            return (track_id, file_path, {'_error': 'File not found'})
        
        # Run analysis
        features = _process_analyzer.analyze(full_path)
        return (track_id, file_path, features)
        
    except Exception as e:
        logger.error(f"Analysis error for {file_path}: {e}")
        return (track_id, file_path, {'_error': str(e)})


class AnalysisWorker:
    """Worker that processes audio analysis jobs from Redis queue using parallel processing"""
    
    def __init__(self):
        self.redis = redis.from_url(REDIS_URL)
        self.db = DatabaseConnection(DATABASE_URL)
        self.running = False
        self.executor = None
        self.consecutive_empty = 0
    
    def _cleanup_stale_processing(self):
        """Reset tracks stuck in 'processing' status (from crashed workers)"""
        cursor = self.db.get_cursor()
        try:
            # Reset tracks that have been "processing" for too long
            cursor.execute("""
                UPDATE "Track"
                SET "analysisStatus" = 'pending'
                WHERE "analysisStatus" = 'processing'
                AND "updatedAt" < NOW() - INTERVAL '%s minutes'
                RETURNING id
            """, (STALE_PROCESSING_MINUTES,))
            
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
        """Retry failed tracks that haven't exceeded max retries"""
        cursor = self.db.get_cursor()
        try:
            cursor.execute("""
                UPDATE "Track"
                SET 
                    "analysisStatus" = 'pending',
                    "analysisError" = NULL
                WHERE "analysisStatus" = 'failed'
                AND COALESCE("analysisRetryCount", 0) < %s
                RETURNING id
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
    
    def start(self):
        """Start processing jobs with parallel workers"""
        cpu_count = os.cpu_count() or 4
        auto_workers = _get_auto_workers()
        
        logger.info("=" * 60)
        logger.info("Starting Audio Analysis Worker (PARALLEL MODE)")
        logger.info("=" * 60)
        logger.info(f"  Music path: {MUSIC_PATH}")
        logger.info(f"  Batch size: {BATCH_SIZE}")
        logger.info(f"  CPU cores detected: {cpu_count}")
        logger.info(f"  Auto-scaled workers: {auto_workers} (50% of cores, min 2, max 8)")
        logger.info(f"  Active workers: {NUM_WORKERS}" + (" (from env)" if os.getenv('NUM_WORKERS') else " (auto)"))
        logger.info(f"  Max retries per track: {MAX_RETRIES}")
        logger.info(f"  Stale processing timeout: {STALE_PROCESSING_MINUTES} minutes")
        logger.info(f"  Essentia available: {ESSENTIA_AVAILABLE}")
        
        self.db.connect()
        self.running = True
        
        # Cleanup stale processing tracks from previous crashes
        logger.info("Cleaning up stale processing tracks...")
        self._cleanup_stale_processing()
        
        # Retry failed tracks that haven't exceeded max retries
        logger.info("Checking for failed tracks to retry...")
        self._retry_failed_tracks()
        
        # Create process pool with initializer
        # Each worker process loads its own TensorFlow models
        self.executor = ProcessPoolExecutor(
            max_workers=NUM_WORKERS,
            initializer=_init_worker_process
        )
        logger.info(f"Started {NUM_WORKERS} worker processes")
        
        try:
            while self.running:
                try:
                    has_work = self.process_batch_parallel()
                    
                    if not has_work:
                        self.consecutive_empty += 1
                        
                        # After 10 consecutive empty batches, do cleanup and retry
                        if self.consecutive_empty >= 10:
                            logger.info("No pending tracks, running cleanup and retry cycle...")
                            self._cleanup_stale_processing()
                            self._retry_failed_tracks()
                            self.consecutive_empty = 0
                    else:
                        self.consecutive_empty = 0
                        
                except KeyboardInterrupt:
                    logger.info("Shutdown requested")
                    self.running = False
                except Exception as e:
                    logger.error(f"Worker error: {e}")
                    traceback.print_exc()
                    self.consecutive_empty += 1
                    
                    # On persistent errors, cleanup and reconnect
                    if self.consecutive_empty >= 5:
                        logger.info("Multiple consecutive errors, attempting recovery...")
                        try:
                            self.db.close()
                            time.sleep(2)
                            self.db.connect()
                            self._cleanup_stale_processing()
                            self._retry_failed_tracks()
                        except Exception as reconnect_err:
                            logger.error(f"Recovery failed: {reconnect_err}")
                        self.consecutive_empty = 0
                    
                    time.sleep(SLEEP_INTERVAL)
        finally:
            if self.executor:
                self.executor.shutdown(wait=True)
                logger.info("Worker processes shut down")
            self.db.close()
            logger.info("Worker stopped")
    
    def process_batch_parallel(self) -> bool:
        """Process a batch of pending tracks in parallel.
        
        Returns:
            True if there was work to process, False if queue was empty
        """
        # Check for queued jobs first
        queued_jobs = []
        while len(queued_jobs) < BATCH_SIZE:
            job_data = self.redis.lpop(ANALYSIS_QUEUE)
            if not job_data:
                break
            job = json.loads(job_data)
            queued_jobs.append((job['trackId'], job.get('filePath', '')))
        
        if queued_jobs:
            self._process_tracks_parallel(queued_jobs)
            return True
        
        # Otherwise, find pending tracks in database
        cursor = self.db.get_cursor()
        try:
            cursor.execute("""
                SELECT id, "filePath"
                FROM "Track"
                WHERE "analysisStatus" = 'pending'
                ORDER BY "fileModified" DESC
                LIMIT %s
            """, (BATCH_SIZE,))
            
            tracks = cursor.fetchall()
            
            if not tracks:
                # No pending tracks, sleep and retry
                time.sleep(SLEEP_INTERVAL)
                return False
            
            # Convert to list of tuples
            track_list = [(t['id'], t['filePath']) for t in tracks]
            self._process_tracks_parallel(track_list)
            return True
            
        except Exception as e:
            logger.error(f"Batch processing error: {e}")
            self.db.rollback()
            return False
        finally:
            cursor.close()
    
    def _process_tracks_parallel(self, tracks: List[Tuple[str, str]]):
        """Process multiple tracks in parallel using the process pool"""
        if not tracks:
            return
        
        logger.info(f"Processing batch of {len(tracks)} tracks with {NUM_WORKERS} workers...")
        
        # Mark all as processing
        cursor = self.db.get_cursor()
        try:
            track_ids = [t[0] for t in tracks]
            cursor.execute("""
                UPDATE "Track"
                SET "analysisStatus" = 'processing'
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
        
        for future in as_completed(futures, timeout=300):  # 5 min timeout per batch
            try:
                track_id, file_path, features = future.result(timeout=60)  # 1 min per track
                
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
        """Save analysis results to database"""
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
                    "analysisVersion" = %s,
                    "analyzedAt" = %s,
                    "analysisError" = NULL
                WHERE id = %s
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
                datetime.utcnow(),
                track_id
            ))
            self.db.commit()
        except Exception as e:
            logger.error(f"Failed to save results for {track_id}: {e}")
            self.db.rollback()
        finally:
            cursor.close()
    
    def _save_failed(self, track_id: str, error: str):
        """Mark track as failed and increment retry count"""
        cursor = self.db.get_cursor()
        try:
            cursor.execute("""
                UPDATE "Track"
                SET
                    "analysisStatus" = 'failed',
                    "analysisError" = %s,
                    "analysisRetryCount" = COALESCE("analysisRetryCount", 0) + 1
                WHERE id = %s
                RETURNING "analysisRetryCount"
            """, (error[:500], track_id))
            
            result = cursor.fetchone()
            retry_count = result['analysisRetryCount'] if result else 0
            
            if retry_count >= MAX_RETRIES:
                logger.warning(f"Track {track_id} has permanently failed after {retry_count} attempts")
            else:
                logger.info(f"Track {track_id} failed (attempt {retry_count}/{MAX_RETRIES}, will retry)")
            
            self.db.commit()
        except Exception as e:
            logger.error(f"Failed to mark track as failed: {e}")
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

