# Audio Analyzer Service - Essentia signal analysis with MusiCNN on ONNX Runtime.
# Built from the repository root (docker-compose.yml), so it can carry the shared
# GPU wrapper from the CLAP service.

# MusiCNN and its three heads ship as vendored ONNX (models/); the build gate below fails unless they answer within 1e-4
# of the vendored reference answers on this image's ONNX Runtime.

FROM python:3.11-slim

ENV TZ=UTC \
    OMP_NUM_THREADS=1 \
    OPENBLAS_NUM_THREADS=1 \
    MKL_NUM_THREADS=1 \
    NUMEXPR_MAX_THREADS=1 \
    THREADS_PER_WORKER=1

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg procps \
        build-essential pkg-config curl ca-certificates \
        libfftw3-single3 libsamplerate0 libyaml-0-2 \
        libeigen3-dev libfftw3-dev libyaml-dev libsamplerate0-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# The main image's versions. Essentia is built from the pinned source on every architecture (no Linux arm64 wheel
# exists), so amd64 and arm64 run the same build; numpy 1.24.4 is the sound-vector parity pin.
RUN pip3 install --no-cache-dir 'numpy==1.24.4' 'onnxruntime==1.30.0' pyyaml six redis psycopg2-binary \
    && curl -fsSL --retry 5 -o /tmp/essentia.tar.gz \
        'https://github.com/MTG/essentia/archive/36ec3d929402d491cbbb1120c54631e8c205b0ff.tar.gz' \
    && mkdir /tmp/essentia-src && tar xzf /tmp/essentia.tar.gz -C /tmp/essentia-src --strip-components=1 \
    && cd /tmp/essentia-src \
    && python3 waf configure --mode=release --with-python \
    && python3 waf -j"$(nproc)" \
    && python3 waf install \
    && ldconfig \
    && cd / && rm -rf /tmp/essentia-src /tmp/essentia.tar.gz \
    && apt-get purge -y --auto-remove build-essential pkg-config curl ca-certificates \
        libeigen3-dev libfftw3-dev libyaml-dev libsamplerate0-dev \
    && rm -rf /var/lib/apt/lists/*

# MusiCNN and its heads as vendored ONNX, checked on this image's own ONNX
# Runtime against the vendored reference answers. The answers stay in the image:
# the analyzer checks its GPU session against them at every start.
COPY services/audio-analyzer/models/ /app/models/
COPY services/audio-analyzer/convert_musicnn.py services/audio-analyzer/musicnn_onnx.py /tmp/musicnn-gate/
RUN cd /tmp/musicnn-gate && python3 convert_musicnn.py gate /app/models /app/models/musicnn-answers.npz \
    && rm -rf /tmp/musicnn-gate

# analyzer.py imports classifier and musicnn_onnx at load. The wrapper puts the shared
# GPU runtime on the path when "GPU for audio analysis" is on.
COPY services/audio-analyzer/analyzer.py services/audio-analyzer/classifier.py services/audio-analyzer/musicnn_onnx.py \
     services/audio-analyzer-clap/gpu_switch.py ./
COPY services/audio-analyzer-clap/gpu_env.sh /app/gpu_env.sh

# /gpu-onnx is where compose mounts the shared GPU runtime volume; a new or empty volume takes this folder's owner.
RUN useradd -m -u 1000 analyzer && \
    mkdir -p /gpu-onnx && \
    chown -R analyzer:analyzer /app /gpu-onnx

USER analyzer

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD pgrep -f "python.*analyzer" || exit 1

ENV KIMA_GPU_FOR=analysis
ENTRYPOINT ["/app/gpu_env.sh"]
CMD ["python3", "analyzer.py"]
