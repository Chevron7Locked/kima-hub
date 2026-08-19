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
    procps \
    && rm -rf /var/lib/apt/lists/*

# Upgrade pip
RUN pip3 install --upgrade pip setuptools wheel

WORKDIR /app

# Install essentia-tensorflow (includes TensorFlow + MusiCNN support)
RUN pip3 install --no-cache-dir essentia-tensorflow

# Verify TensorflowPredictMusiCNN is available
RUN python3 -c "from essentia.standard import TensorflowPredictMusiCNN, TensorflowPredict2D; print('MusiCNN and TensorflowPredict2D: OK')"

# Create models directory
# Create models directory and fetch the MusiCNN model plus its classification
# heads.
#
# essentia.upf.edu is intermittently unreachable. Observed from the build host
# minutes apart: the same URL returning HTTP 200 on one attempt, a connection
# failure on the next, and an SSL handshake error (curl exit 35) on a third.
# Nine bare `curl -L` calls with no retry meant a single blip anywhere in the
# chain failed the whole image, and which file it landed on was luck.
#
# The retry is a shell loop rather than curl's own flags, deliberately:
# --retry-all-errors would cover this but only exists from curl 7.71, and the
# curl in ubuntu:20.04 is 7.68 -- passing it fails the build instantly with
# "option is unknown". --retry-connrefused is understood by 7.68 but does not
# retry the SSL error actually seen here. A loop covers every failure mode
# regardless of curl version.
#
# -f so an HTTP error page is never written to disk as if it were a model, and
# each file is size-checked afterwards for the same reason.
RUN mkdir -p /app/models && \
    fetch() { \
        name="$1"; url="$2"; \
        for attempt in 1 2 3 4 5; do \
            if curl -fL --connect-timeout 20 --max-time 300 -o "/app/models/$name" "$url"; then \
                if [ -s "/app/models/$name" ]; then return 0; fi; \
                echo "  $name downloaded empty, retrying"; \
            fi; \
            echo "  $name attempt $attempt failed, retrying in 5s"; \
            rm -f "/app/models/$name"; \
            sleep 5; \
        done; \
        echo "FATAL: could not download $name from $url"; \
        return 1; \
    }; \
    base="https://essentia.upf.edu/models"; \
    fetch msd-musicnn-1.pb              "$base/autotagging/msd/msd-musicnn-1.pb" && \
    for m in happy sad relaxed aggressive party acoustic electronic; do \
        fetch "mood_$m-msd-musicnn-1.pb" "$base/classification-heads/mood_$m/mood_$m-msd-musicnn-1.pb" || exit 1; \
    done && \
    fetch danceability-msd-musicnn-1.pb "$base/classification-heads/danceability/danceability-msd-musicnn-1.pb"


# Verify models downloaded
RUN echo "Models downloaded:" && ls -lh /app/models/

# Install other dependencies
RUN pip3 install --no-cache-dir redis psycopg2-binary 'numpy>=1.19.0,<2.0.0'

# Copy application code
COPY analyzer.py .

# Create non-root user
RUN useradd -m -u 1000 analyzer && \
    chown -R analyzer:analyzer /app

USER analyzer

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD pgrep -f "python.*analyzer" || exit 1

CMD ["python3", "analyzer.py"]
