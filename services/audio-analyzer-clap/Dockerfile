# CLAP Audio Analyzer Service - LAION CLAP embeddings for vibe similarity
#
# ONNX only, and buildable from a fresh clone. This mirrors the published
# all-in-one image (the repo-root Dockerfile) step for step: the audio encoder
# is exported in a builder stage from the PUBLIC laion/clap-htsat-unfused
# checkpoint, the text encoder is downloaded, the Hugging Face files the
# runtime needs are baked into a cache, and every file is sha-gated. Nothing
# is COPY'd from models/ -- that directory is gitignored, so an image that
# needed it could only be built on a machine that already had the weights.
# If the root Dockerfile's CLAP pins change, change them here too.

# ============================================================
# CLAP ONNX BUILDER STAGE
# Exports hf_audio.onnx (sha256 37df17afb9881569c4f50e5b691167aa54586418059701a74a54934514969972)
# from the public checkpoint with a pinned toolchain. Same pins give the same bytes on amd64
# and arm64; the sha gate fails the build on any drift.
FROM python:3.11-slim AS clap-onnx-builder
WORKDIR /build
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates

RUN pip3 install --no-cache-dir \
    --index-url https://download.pytorch.org/whl/cpu \
    --extra-index-url https://pypi.org/simple \
    'torch==2.8.0' 'transformers==4.57.6' 'onnx' 'numpy<2'
COPY export_onnx.py .
# All three files must live INSIDE ckpt/ -- from_pretrained('ckpt') finds
# weights only in the snapshot dir. curl -o does not create parent dirs.
RUN mkdir -p ckpt \
    && curl -fL --retry 5 --retry-delay 5 --retry-all-errors -o ckpt/pytorch_model.bin \
        'https://huggingface.co/laion/clap-htsat-unfused/resolve/8fa0f1c6d0433df6e97c127f64b2a1d6c0dcda8a/pytorch_model.bin' \
    && echo '1cd3c601bc4afe0fa87be3de4c13dd2cfadd249fac1e29acf74a9b296c3219bb  ckpt/pytorch_model.bin' | sha256sum -c - \
    && curl -fL --retry 5 --retry-delay 5 --retry-all-errors -o ckpt/config.json \
        'https://huggingface.co/laion/clap-htsat-unfused/resolve/8fa0f1c6d0433df6e97c127f64b2a1d6c0dcda8a/config.json' \
    && echo '9efb9557bc804f2ca6e394486af2e45dfed0b18554909735a99c6220b84e4288  ckpt/config.json' | sha256sum -c - \
    && curl -fL --retry 5 --retry-delay 5 --retry-all-errors -o ckpt/preprocessor_config.json \
        'https://huggingface.co/laion/clap-htsat-unfused/resolve/8fa0f1c6d0433df6e97c127f64b2a1d6c0dcda8a/preprocessor_config.json' \
    && echo '9739f58296aa6f9ac18008fd0150fb2649bc554985fbde86d0a4041c882ac753  ckpt/preprocessor_config.json' | sha256sum -c -
RUN python3 export_onnx.py --src ckpt --out hf_audio.onnx \
    && echo '37df17afb9881569c4f50e5b691167aa54586418059701a74a54934514969972  hf_audio.onnx' | sha256sum -c - \
    && echo '[builder] hf_audio.onnx exported and sha-verified'

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
# onnx_backend at module load, which imports clap_mel. verify_runtime.py and
# the fixtures ride along for the build-time parity gate below.
COPY analyzer.py onnx_backend.py clap_mel.py verify_runtime.py gpu_runtime.py gpu_switch.py ./
COPY gpu_env.sh /app/gpu_env.sh
RUN chmod +x /app/gpu_env.sh
COPY test_fixtures/ ./test_fixtures/

# ============================================================
# CLAP ONNX WEIGHTS -- PUBLIC SOURCES ONLY, SHA-GATED
# hf_audio.onnx comes from the builder stage. text_model.onnx is byte-identical
# to Xenova/clap-htsat-unfused's public ONNX text export. The graph has no
# attention-mask input, so onnx_backend encodes each prompt unpadded; that matches
# the masked HF text embedding (test_text_parity.py).
# onnx_backend resolves both from /app/models by default.
RUN mkdir -p /app/models \
    && curl -fL --retry 5 --retry-delay 5 --retry-all-errors --connect-timeout 30 --speed-limit 1024 --speed-time 60 \
        -o /app/models/text_model.onnx \
        'https://huggingface.co/Xenova/clap-htsat-unfused/resolve/main/onnx/text_model.onnx' \
    && echo '6df7c51f2d78e236a03f2b816e613d538c815639d13644fe7c2124f439da9648  /app/models/text_model.onnx' | sha256sum -c -
COPY --from=clap-onnx-builder /build/hf_audio.onnx /app/models/hf_audio.onnx

# ============================================================
# OFFLINE HUGGINGFACE CACHE (boot without network)
# The runtime lazily loads the laion preprocessor_config.json and the
# roberta-base tokenizer. Pin the exact revisions; sha-gate every file.
RUN LAION='https://huggingface.co/laion/clap-htsat-unfused/resolve/8fa0f1c6d0433df6e97c127f64b2a1d6c0dcda8a' \
    && ROB='https://huggingface.co/roberta-base/resolve/e2da8e2f811d1448a5b465c236feacd80ffbac7b' \
    && LDIR="$HF_HOME/hub/models--laion--clap-htsat-unfused" \
    && RDIR="$HF_HOME/hub/models--roberta-base" \
    && LS="$LDIR/snapshots/8fa0f1c6d0433df6e97c127f64b2a1d6c0dcda8a" \
    && RS="$RDIR/snapshots/e2da8e2f811d1448a5b465c236feacd80ffbac7b" \
    && mkdir -p "$LS" "$LDIR/refs" "$RS" "$RDIR/refs" \
    && printf '%s' '8fa0f1c6d0433df6e97c127f64b2a1d6c0dcda8a' > "$LDIR/refs/main" \
    && printf '%s' 'e2da8e2f811d1448a5b465c236feacd80ffbac7b' > "$RDIR/refs/main" \
    && curl -fsSL --retry 5 --retry-all-errors -o "$LS/preprocessor_config.json" "$LAION/preprocessor_config.json" \
    && echo '9739f58296aa6f9ac18008fd0150fb2649bc554985fbde86d0a4041c882ac753  '"$LS"'/preprocessor_config.json' | sha256sum -c - \
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
# and require cosine >= 0.999 against the validated embeddings; also runs the
# text encoder end to end. Any preprocessing/toolchain drift fails the build
# here instead of shipping an image that embeds into a different space.
RUN HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 python verify_runtime.py

# /gpu-onnx is where compose mounts the shared GPU runtime volume; a new or empty volume takes this folder's owner.
RUN useradd -m -u 1000 analyzer && \
    mkdir -p /gpu-onnx && \
    chown -R analyzer:analyzer /app /gpu-onnx

USER analyzer

# Health check: the ONNX backend imports (the torch stack is not in this image).
HEALTHCHECK --interval=30s --timeout=30s --start-period=60s --retries=3 \
    CMD python -c "import onnx_backend; print('OK')" || exit 1

# The tokenizer and preprocessor are baked into the cache above at pinned revisions, and the build proved they
# suffice offline: at runtime nothing is asked of huggingface.co.
ENV HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1

ENTRYPOINT ["/app/gpu_env.sh"]
CMD ["python", "analyzer.py"]
