# Audio Analyzer Service - Essentia with TensorFlow (MusiCNN)
# Using Ubuntu 20.04 with Python 3.8 for essentia-tensorflow compatibility
FROM ubuntu:20.04

# Avoid interactive prompts
ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=UTC

# CPU thread limiting for TensorFlow and numerical libraries
# Prevents each worker from using all CPU cores
# Override with docker-compose environment variables
ENV TF_NUM_INTRAOP_THREADS=1 \
    TF_NUM_INTEROP_THREADS=1 \
    OMP_NUM_THREADS=1 \
    OPENBLAS_NUM_THREADS=1 \
    MKL_NUM_THREADS=1 \
    NUMEXPR_MAX_THREADS=1 \
    THREADS_PER_WORKER=1

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-dev \
    python3-pip \
    ffmpeg \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Upgrade pip
RUN pip3 install --upgrade pip setuptools wheel

WORKDIR /app

# Install essentia-tensorflow (includes TensorFlow + MusiCNN support)
RUN pip3 install --no-cache-dir essentia-tensorflow

# Verify TensorflowPredictMusiCNN is available
RUN python3 -c "from essentia.standard import TensorflowPredictMusiCNN, TensorflowPredict2D; print('MusiCNN and TensorflowPredict2D: OK')"

# Create models directory
RUN mkdir -p /app/models

# Download MusiCNN models from essentia.upf.edu/models/
# Base embedding model
RUN curl -L -o /app/models/msd-musicnn-1.pb \
    "https://essentia.upf.edu/models/autotagging/msd/msd-musicnn-1.pb"

# Mood classification heads (using MusiCNN embeddings)
RUN curl -L -o /app/models/mood_happy-msd-musicnn-1.pb \
    "https://essentia.upf.edu/models/classification-heads/mood_happy/mood_happy-msd-musicnn-1.pb" && \
    curl -L -o /app/models/mood_sad-msd-musicnn-1.pb \
    "https://essentia.upf.edu/models/classification-heads/mood_sad/mood_sad-msd-musicnn-1.pb" && \
    curl -L -o /app/models/mood_relaxed-msd-musicnn-1.pb \
    "https://essentia.upf.edu/models/classification-heads/mood_relaxed/mood_relaxed-msd-musicnn-1.pb" && \
    curl -L -o /app/models/mood_aggressive-msd-musicnn-1.pb \
    "https://essentia.upf.edu/models/classification-heads/mood_aggressive/mood_aggressive-msd-musicnn-1.pb" && \
    curl -L -o /app/models/mood_party-msd-musicnn-1.pb \
    "https://essentia.upf.edu/models/classification-heads/mood_party/mood_party-msd-musicnn-1.pb" && \
    curl -L -o /app/models/mood_acoustic-msd-musicnn-1.pb \
    "https://essentia.upf.edu/models/classification-heads/mood_acoustic/mood_acoustic-msd-musicnn-1.pb" && \
    curl -L -o /app/models/mood_electronic-msd-musicnn-1.pb \
    "https://essentia.upf.edu/models/classification-heads/mood_electronic/mood_electronic-msd-musicnn-1.pb"

# Other classification heads
RUN curl -L -o /app/models/danceability-msd-musicnn-1.pb \
    "https://essentia.upf.edu/models/classification-heads/danceability/danceability-msd-musicnn-1.pb" && \
    curl -L -o /app/models/voice_instrumental-msd-musicnn-1.pb \
    "https://essentia.upf.edu/models/classification-heads/voice_instrumental/voice_instrumental-msd-musicnn-1.pb"

# Verify models downloaded
RUN echo "Models downloaded:" && ls -lh /app/models/

# Install other dependencies
RUN pip3 install --no-cache-dir redis psycopg2-binary sqlalchemy python-dotenv 'numpy>=1.19.0,<2.0.0'

# Copy application code
COPY analyzer.py .

# Create non-root user
RUN useradd -m -u 1000 analyzer && \
    chown -R analyzer:analyzer /app

USER analyzer

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD python3 -c "from essentia.standard import TensorflowPredictMusiCNN; print('OK')" || exit 1

CMD ["python3", "analyzer.py"]
