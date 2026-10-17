# CLAP Audio Analyzer Service - LAION CLAP embeddings for vibe similarity
#
# ONNX only, and buildable from a fresh clone. This mirrors the published
# all-in-one image (the repo-root Dockerfile) step for step: both towers of
# LAION-CLAP's music checkpoint are exported in a builder stage from the PUBLIC
# lukewys/laion_clap file, the Hugging Face tokenizer files the runtime needs
# are baked into a cache, and every file is sha-gated. Nothing is COPY'd from
# models/ -- that directory is gitignored, so an image that needed it could only
# be built on a machine that already had the weights.
# If the root Dockerfile's CLAP pins change, change them here too.

# ============================================================
# CLAP ONNX BUILDER STAGE
# Exports music_audio.onnx (sha256 ab1bf5eba067b246198c630f153f774e8f1c3169b3924d4d6a4dc247bd73de97)
# and music_text.onnx (sha256 6dbba074b27f8973d84c5c7ae9acd0b9139a6cd9dd82bea6e87954dc3b835956)
# from the public checkpoint with the pinned toolchain in requirements-export.txt. The same pins
# gave these bytes on linux/arm64, linux/amd64 and macOS arm64; the sha gate fails the build on
# any drift (the checkpoint, the toolchain, the export script, or the roberta-base config that
# laion_clap fetches by name). The checkpoint (2.4 GB) stays in this stage.
FROM python:3.11-slim AS clap-onnx-builder
WORKDIR /build
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates

COPY requirements-export.txt .
RUN pip3 install --no-cache-dir --no-deps \
    --index-url https://download.pytorch.org/whl/cpu \
    --extra-index-url https://pypi.org/simple \
    -r requirements-export.txt
COPY export_music_onnx.py .
RUN mkdir -p ckpt \
    && curl -fL --retry 5 --retry-delay 5 --retry-all-errors -o ckpt/music_audioset_epoch_15_esc_90.14.pt \
        'https://huggingface.co/lukewys/laion_clap/resolve/b3708341862f581175dba5c356a4ebf74a9b6651/music_audioset_epoch_15_esc_90.14.pt' \
    && echo 'fae3e9c087f2909c28a09dc31c8dfcdacbc42ba44c70e972b58c1bd1caf6dedd  ckpt/music_audioset_epoch_15_esc_90.14.pt' | sha256sum -c -
RUN python3 export_music_onnx.py --ckpt ckpt/music_audioset_epoch_15_esc_90.14.pt --out-dir . \
    && echo 'ab1bf5eba067b246198c630f153f774e8f1c3169b3924d4d6a4dc247bd73de97  music_audio.onnx' | sha256sum -c - \
    && echo '6dbba074b27f8973d84c5c7ae9acd0b9139a6cd9dd82bea6e87954dc3b835956  music_text.onnx' | sha256sum -c - \
    && echo '[builder] music_audio.onnx and music_text.onnx exported and sha-verified'

# ============================================================
# RUNTIME
FROM python:3.11-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=UTC

# One thread per numerical library, so workers do not each take every core.
ENV OMP_NUM_THREADS=1 \
    OPENBLAS_NUM_THREADS=1 \
    MKL_NUM_THREADS=1 \
    NUMEXPR_MAX_THREADS=1

# The baked Hugging Face cache lives here rather than in a home directory, so
# the non-root runtime user reads the same cache the build wrote.
ENV HF_HOME=/app/hf-cache

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libsndfile1 \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Torch-free: requirements.txt carries the ONNX stack only, pinned.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Application code -- ALL of the runtime modules. analyzer.py imports
# onnx_backend at module load, which loads music_clap_mel and music_clap_onnx.
# verify_runtime.py and the fixtures ride along for the build-time parity gate below.
COPY analyzer.py onnx_backend.py music_clap_mel.py music_clap_onnx.py verify_runtime.py gpu_runtime.py gpu_switch.py ./
COPY gpu_env.sh /app/gpu_env.sh
RUN chmod +x /app/gpu_env.sh
COPY test_fixtures/ ./test_fixtures/

# ============================================================
# CLAP ONNX WEIGHTS -- PUBLIC SOURCES ONLY, SHA-GATED IN THE BUILDER
# onnx_backend resolves both from /app/models by default.
RUN mkdir -p /app/models
COPY --from=clap-onnx-builder /build/music_audio.onnx /build/music_text.onnx /app/models/

# ============================================================
# OFFLINE HUGGINGFACE CACHE (boot without network)
# The text model's tokenizer is roberta-base, loaded lazily by name. Pin the
# exact revision; sha-gate every file.
RUN ROB='https://huggingface.co/roberta-base/resolve/e2da8e2f811d1448a5b465c236feacd80ffbac7b' \
    && RDIR="$HF_HOME/hub/models--roberta-base" \
    && RS="$RDIR/snapshots/e2da8e2f811d1448a5b465c236feacd80ffbac7b" \
    && mkdir -p "$RS" "$RDIR/refs" \
    && printf '%s' 'e2da8e2f811d1448a5b465c236feacd80ffbac7b' > "$RDIR/refs/main" \
    && curl -fsSL --retry 5 --retry-all-errors -o "$RS/vocab.json" "$ROB/vocab.json" \
    && echo '9e7f63c2d15d666b52e21d250d2e513b87c9b713cfa6987a82ed89e5e6e50655  '"$RS"'/vocab.json' | sha256sum -c - \
    && curl -fsSL --retry 5 --retry-all-errors -o "$RS/merges.txt" "$ROB/merges.txt" \
    && echo '1ce1664773c50f3e0cc8842619a93edc4624525b728b188a9e0be33b7726adc5  '"$RS"'/merges.txt' | sha256sum -c - \
    && curl -fsSL --retry 5 --retry-all-errors -o "$RS/tokenizer.json" "$ROB/tokenizer.json" \
    && echo '847bbeab6174d66a88898f729d52fa8d355fafe1bea101cf960dd404581df70e  '"$RS"'/tokenizer.json' | sha256sum -c - \
    && curl -fsSL --retry 5 --retry-all-errors -o "$RS/tokenizer_config.json" "$ROB/tokenizer_config.json" \
    && echo '994f46754c5bf4014f1aa92d34b1374319c3a6b3f702105cd5b742beaecd18ce  '"$RS"'/tokenizer_config.json' | sha256sum -c -

# ============================================================
# BUILD-TIME PARITY GATE
# Embed the tracked fixtures through this image's own runtime stack, offline,
# and require cosine >= 0.999 against laion_clap's own embeddings of them
# (expected_music_embeddings.npy); also runs the text encoder end to end. Any
# preprocessing/toolchain drift fails the build here instead of shipping an
# image that embeds into a different space.
RUN HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 python verify_runtime.py

# /gpu-onnx is where compose mounts the shared GPU runtime volume; a new or empty volume takes this folder's owner.
RUN useradd -m -u 1000 analyzer && \
    mkdir -p /gpu-onnx && \
    chown -R analyzer:analyzer /app /gpu-onnx

USER analyzer

# Health check: the ONNX backend imports (the torch stack is not in this image).
HEALTHCHECK --interval=30s --timeout=30s --start-period=60s --retries=3 \
    CMD python -c "import onnx_backend; print('OK')" || exit 1

# The tokenizer is baked into the cache above at a pinned revision, and the build proved it
# suffices offline: at runtime nothing is asked of huggingface.co.
ENV HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1

ENTRYPOINT ["/app/gpu_env.sh"]
CMD ["python", "analyzer.py"]
