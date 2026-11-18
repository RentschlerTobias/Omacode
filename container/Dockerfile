# The Omacode image (docs/roadmap/container-plan.md, P1): OpenCode with the Omacode plugins, the decider and the memory's
# embedding service behind a supervisor, and the render stack (Chromium, HyperFrames, ffmpeg, Manim with TeX).
#
#   podman build -f container/Dockerfile -t omacode .        (from the repository root)
#
# Two stages: the builder fetches and compiles, the runtime gets /opt from it plus Debian's runtime packages. Every
# third-party version is pinned here; container/third-party.json names their licences and where the texts are.

ARG DEBIAN=docker.io/library/debian:trixie-slim

FROM ${DEBIAN} AS base
ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl xz-utils \
 && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------------------------------------------------
# The memory's embedding weights (P1-T9): Qwen3-Embedding-0.6B, Q8, Apache-2.0, checked against the SHA-256 Hugging
# Face publishes for it. Its own stage and, below, its own layer before everything that changes, so an image update
# does not download it again. The decider's GLiNER checkpoint is not baked in: P6 replaces it.
FROM base AS models
ARG EMBEDDING_SHA256=06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439
RUN set -eux; d=/opt/models/qwen3-embedding-0.6b; mkdir -p "$d"; \
    curl -fsSL -o "$d/Qwen3-Embedding-0.6B-Q8_0.gguf" "https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF/resolve/main/Qwen3-Embedding-0.6B-Q8_0.gguf"; \
    echo "${EMBEDDING_SHA256}  $d/Qwen3-Embedding-0.6B-Q8_0.gguf" | sha256sum -c -; \
    # The model repository declares Apache-2.0 in its card and carries no licence file: the card and the licence's
    # own text go along.
    mkdir -p /opt/licenses/qwen3-embedding; \
    curl -fsSL -o /opt/licenses/qwen3-embedding/README.md "https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF/resolve/main/README.md"; \
    curl -fsSL -o /opt/licenses/qwen3-embedding/LICENSE "https://www.apache.org/licenses/LICENSE-2.0.txt"

# ---------------------------------------------------------------------------------------------------------------------
FROM base AS builder
ARG TARGETARCH
ARG NODE_VERSION=24.22.3
ARG UV_VERSION=0.13.9
ARG PYTHON_VERSION=3.12
ARG OPENCODE_VERSION=2.2.5
ARG HYPERFRAMES_VERSION=0.9.54
ARG MANIM_VERSION=0.22.1
ARG LLAMA_CPP_TAG=v1.0.0

RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential cmake git pkg-config libcairo2-dev libpango1.0-dev \
 && rm -rf /var/lib/apt/lists/*

# Node, checked against the release's SHASUMS256.txt.
RUN set -eux; arch="$([ "$TARGETARCH" = arm64 ] && echo arm64 || echo x64)"; f="node-v${NODE_VERSION}-linux-${arch}.tar.xz"; \
    curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/${f}"; \
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" | grep " ${f}\$" | sha256sum -c -; \
    mkdir -p /opt/node && tar -xJf "$f" -C /opt/node --strip-components=1 && rm "$f"
ENV PATH=/opt/node/bin:$PATH

# uv, checked against its published .sha256; its licence texts come from the tag.
RUN set -eux; arch="$([ "$TARGETARCH" = arm64 ] && echo aarch64 || echo x86_64)"; f="uv-${arch}-unknown-linux-gnu.tar.gz"; \
    curl -fsSLO "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${f}"; \
    curl -fsSL "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${f}.sha256" | sha256sum -c -; \
    mkdir -p /opt/uv/bin /opt/licenses/uv && tar -xzf "$f" -C /opt/uv/bin --strip-components=1 && rm "$f"; \
    for l in LICENSE-MIT LICENSE-APACHE; do curl -fsSL -o "/opt/licenses/uv/$l" "https://raw.githubusercontent.com/astral-sh/uv/${UV_VERSION}/$l"; done
ENV PATH=/opt/uv/bin:$PATH UV_PYTHON_INSTALL_DIR=/opt/python UV_LINK_MODE=copy UV_CACHE_DIR=/tmp/uv-cache UV_PYTHON_PREFERENCE=only-managed

# OpenCode, pinned; it updates itself only when the image does (OPENCODE_DISABLE_AUTOUPDATE below).
RUN set -eux; arch="$([ "$TARGETARCH" = arm64 ] && echo arm64 || echo x64)"; \
    mkdir -p /opt/opencode/bin /opt/licenses/opencode; \
    curl -fsSL "https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}/opencode-linux-${arch}.tar.gz" | tar -xz -C /opt/opencode/bin; \
    test -x /opt/opencode/bin/opencode; \
    curl -fsSL -o /opt/licenses/opencode/LICENSE "https://raw.githubusercontent.com/anomalyco/opencode/v${OPENCODE_VERSION}/LICENSE"

# llama.cpp's server for the embeddings, CPU only. The CPU backends are built for every variant and picked at run time,
# so one image runs fast on a new CPU and still runs on an old one. The server links its web UI; v1.0.0's prebuilt UI
# bundle on Hugging Face fails the build's own asset check (no workbox*.js), so the UI is built here with npm instead.
RUN set -eux; git clone --depth 1 --branch "${LLAMA_CPP_TAG}" https://github.com/ggml-org/llama.cpp /src/llama.cpp; \
    cmake -S /src/llama.cpp -B /src/llama.cpp/build -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/opt/llama \
      -DGGML_NATIVE=OFF -DGGML_BACKEND_DL=ON -DGGML_CPU_ALL_VARIANTS=ON -DBUILD_SHARED_LIBS=ON \
      -DLLAMA_CURL=OFF -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF -DLLAMA_BUILD_SERVER=ON \
      -DLLAMA_BUILD_UI=ON -DLLAMA_USE_PREBUILT_UI=OFF; \
    cmake --build /src/llama.cpp/build --target llama-server -j"$(nproc)"; \
    mkdir -p /opt/llama/bin /opt/licenses/llama.cpp; \
    cp /src/llama.cpp/build/bin/llama-server /opt/llama/bin/; \
    # With GGML_BACKEND_DL the CPU backends are loaded from the executable's own directory, so the libraries live
    # beside it, not in a lib directory.
    cp -a /src/llama.cpp/build/bin/lib*.so* /opt/llama/bin/; \
    cp /src/llama.cpp/LICENSE /opt/licenses/llama.cpp/; rm -rf /src

# Python for the decider, the evolver and Manim: one managed interpreter, three environments.
RUN uv python install "${PYTHON_VERSION}"

# Manim with its LaTeX path (the TeX itself is Debian's, in the runtime stage). pycairo builds against Cairo here.
RUN uv venv /opt/manim --python "${PYTHON_VERSION}" && uv pip install --python /opt/manim "manim==${MANIM_VERSION}"

# HyperFrames and the headless Chrome it renders with. Chrome for Testing has no Linux arm64 build, so there the CLI
# uses Debian's Chromium instead and the download is allowed to fail. The npm package declares Apache-2.0 but ships no
# licence text, so the text comes from the release tag (the repository has no NOTICE).
RUN npm install -g --prefix /opt/hyperframes-cli "hyperframes@${HYPERFRAMES_VERSION}" \
 && mkdir -p /opt/licenses/hyperframes \
 && curl -fsSL -o /opt/licenses/hyperframes/LICENSE "https://raw.githubusercontent.com/heygen-com/hyperframes/v${HYPERFRAMES_VERSION}/LICENSE" \
 && (HYPERFRAMES_CACHE_DIR=/opt/hyperframes /opt/hyperframes-cli/bin/hyperframes browser ensure || echo "no managed Chrome on ${TARGETARCH}")

# The repository: the plugins (run from source by OpenCode), the decider, the evolver and this directory.
COPY . /opt/omacode
WORKDIR /opt/omacode
RUN npm ci --omit=dev --ignore-scripts \
 && (cd decider && uv sync --frozen --no-dev --python "${PYTHON_VERSION}") \
 && (cd packages/micromanager/evolver && uv sync --frozen --no-dev --python "${PYTHON_VERSION}") \
 && rm -rf /tmp/uv-cache

# ---------------------------------------------------------------------------------------------------------------------
FROM base AS runtime
ARG TARGETARCH

# Runtime packages. Debian's slim image drops /usr/share/doc but keeps every package's copyright file, which is where
# their licences live (P1-T6); container/licenses.sh checks that none is missing.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git openssh-client bubblewrap socat ripgrep tini procps less \
      ffmpeg chromium fonts-dejavu-core fonts-liberation2 fonts-noto-color-emoji \
      libcairo2 libpango-1.0-0 libpangocairo-1.0-0 libgomp1 \
      texlive-latex-base texlive-latex-recommended texlive-latex-extra texlive-fonts-recommended texlive-science \
      texlive-lang-german dvisvgm \
 && rm -rf /var/lib/apt/lists/*

COPY --from=models /opt /opt
COPY --from=builder /opt /opt

RUN set -eux; \
    for b in node npm npx; do ln -s /opt/node/bin/$b /usr/local/bin/$b; done; \
    ln -s /opt/opencode/bin/opencode /usr/local/bin/opencode; \
    ln -s /opt/uv/bin/uv /usr/local/bin/uv; ln -s /opt/uv/bin/uvx /usr/local/bin/uvx; \
    ln -s /opt/llama/bin/llama-server /usr/local/bin/llama-server; \
    ln -s /opt/manim/bin/manim /usr/local/bin/manim; \
    ln -s /opt/hyperframes-cli/bin/hyperframes /usr/local/bin/hyperframes; \
    echo /opt/llama/bin > /etc/ld.so.conf.d/llama.conf && ldconfig; \
    useradd --uid 1000 --create-home --shell /bin/bash omacode; \
    mkdir -p /work && chown omacode:omacode /work; \
    /opt/omacode/container/licenses.sh

ENV OPENCODE_DISABLE_AUTOUPDATE=1 \
    HYPERFRAMES_CACHE_DIR=/opt/hyperframes \
    UV_PYTHON_INSTALL_DIR=/opt/python \
    UV_PYTHON_PREFERENCE=only-managed \
    OMACODE_IMAGE=1 \
    OMACODE_IMAGE_MODELS=/opt/models \
    OMACODE_EVOLVER_PREBUILT=1

USER omacode
WORKDIR /work
ENTRYPOINT ["/usr/bin/tini", "-s", "--", "/opt/omacode/container/omacode-init"]
