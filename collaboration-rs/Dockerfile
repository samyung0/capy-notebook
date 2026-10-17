# The Rust collaboration server (collaboration-rs). Context: the repository
# root, for the BetterOffice fork (vendor/betteroffice: the patched yrs and
# the Office engines the server runs in child processes of itself) and the
# frontend sources the agent markdown bundle is built from.

# The editor's markdown import as one script for the notes crate's V8
# (crates/notes/markdown); its dependencies are that package's own.
FROM node:22-alpine AS markdown
RUN corepack enable
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
COPY collaboration-rs/crates/notes/markdown/package.json ./collaboration-rs/crates/notes/markdown/
RUN pnpm install --frozen-lockfile --filter @capy-notebook/notes-markdown...
COPY src ./src
COPY collaboration-rs/crates/notes/markdown ./collaboration-rs/crates/notes/markdown
RUN pnpm --filter @capy-notebook/notes-markdown build

# The V8 crate downloads its prebuilt static library here (network, or
# RUSTY_V8_ARCHIVE pointing at a local copy).
FROM rust:1.98-bookworm AS build
WORKDIR /workspace
COPY vendor/betteroffice vendor/betteroffice
COPY collaboration-rs collaboration-rs
WORKDIR /workspace/collaboration-rs
# Cache mounts keep compiled output across deploys even when the layer cache
# misses (Coolify ARG injection must stay off, see the deployment runbook).
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/workspace/collaboration-rs/target,sharing=locked \
    cargo build --release --locked -p server \
    && cp target/release/capy-collaboration /usr/local/bin/capy-collaboration

FROM debian:bookworm-slim
# ca-certificates for Sentry and the gateway over TLS; wget for the compose
# healthcheck.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates wget \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /usr/local/bin/capy-collaboration /usr/local/bin/capy-collaboration
COPY --from=markdown /workspace/collaboration-rs/crates/notes/markdown/markdown.bundle.js /usr/local/share/capy/markdown.bundle.js
ENV COLLABORATION_MARKDOWN_BUNDLE=/usr/local/share/capy/markdown.bundle.js
# The source rooms' disk store: a named volume mounted here takes this
# folder's owner (the service user) and mode when Docker creates it.
RUN mkdir -p /var/lib/capy/sources     && chown nobody:nogroup /var/lib/capy/sources     && chmod 0700 /var/lib/capy/sources
ENV COLLABORATION_SOURCE_DISK_DIR=/var/lib/capy/sources
USER nobody
EXPOSE 1234
CMD ["capy-collaboration"]
