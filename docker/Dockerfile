# The sandbox images (spec 4.6, 9.4; brief task 17). CI's Images job builds every stage below from the repo
# root, reports each size, and pushes nothing. No secret is baked in; the image has no Docker socket and no
# supervisor. The tenant image (Pulsar, the engine and the init) is a follow-up: it needs the built engine and
# Pulsar at a pinned commit, which this build context does not have.

# The same base digest as upstream's infra/sandboxes/computer/Dockerfile, so both images share one base.
FROM debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251 AS base
ARG DEBIAN_FRONTEND=noninteractive
# Shell tools, Python, git, curl, and the PDF and office libraries (spec 4.6 "The image").
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    file \
    fonts-dejavu-core \
    fonts-liberation \
    git \
    jq \
    locales \
    openssh-client \
    pandoc \
    poppler-utils \
    procps \
    python3 \
    python3-openpyxl \
    ripgrep \
    fd-find \
    sqlite3 \
    unzip \
  && rm -rf /var/lib/apt/lists/* \
  && ln -s /usr/bin/fdfind /usr/local/bin/fd \
  && groupadd --gid 1000 sticks \
  && useradd --uid 1000 --gid sticks --create-home --shell /bin/bash sticks
ENV LANG=C.UTF-8
# Run as the sandbox user. Each Stick's folder lives under /data/home/sticks on the volume (spec 4.6).
RUN mkdir -p /data/home/sticks && chown 1000:1000 /data/home/sticks
USER 1000:1000
WORKDIR /data/home/sticks
ENV HOME=/data/home/sticks

# The sandbox image (v1): headless Chromium for runs that allow the browser, and no display stack.
FROM base AS sandbox
USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
  && rm -rf /var/lib/apt/lists/*
USER 1000:1000
CMD ["/bin/bash"]

# The desktop image: the sandbox plus the display stack. Built, but nothing uses it yet (spec 4.6, v1 has no
# computer and no desktop).
FROM sandbox AS desktop
USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
    fluxbox \
    novnc \
    websockify \
    x11-utils \
    x11vnc \
    xdotool \
    xvfb \
    xterm \
  && rm -rf /var/lib/apt/lists/*
USER 1000:1000
ENV DISPLAY=:1
CMD ["/bin/bash"]

# The engine for the tenant image (brief task 17; one Rakazo per tenant docker, only Postgres outside). Builds
# the pinned upstream with our patches and overlay, runs its typecheck and overlay tests, and bundles the entry.
# The tenant image (PlatformStack's Pulsar image) copies /opt/sticks from this stage and runs:
#   node /opt/sticks/build/up/apps/sticks-engine/dist/sticks-engine.mjs
# Listens on API_PORT (default 3100). Secrets come from /run/secrets (db_password, content_key, gateway_key,
# pulsar_public_key, engine secret); nothing is baked in.
FROM node:24-bookworm-slim AS engine
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git python3 \
  && rm -rf /var/lib/apt/lists/* && corepack enable
WORKDIR /src
COPY . /src
RUN python3 scripts/package_engine.py --workdir /opt/sticks && rm -rf /src
WORKDIR /opt/sticks
ENV NODE_ENV=production API_PORT=3100
EXPOSE 3100
CMD ["node", "/opt/sticks/build/up/apps/sticks-engine/dist/sticks-engine.mjs"]
