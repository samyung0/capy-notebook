# The Rust collaboration server (collaboration-rs). Context: the repository
# root, for the fork's patched yrs (vendor/betteroffice/third_party/yrs).
FROM rust:1.98-bookworm AS build
WORKDIR /workspace
COPY vendor/betteroffice/third_party/yrs vendor/betteroffice/third_party/yrs
COPY collaboration-rs collaboration-rs
WORKDIR /workspace/collaboration-rs
# Cache mounts keep compiled output across deploys even when the layer cache
# misses (Coolify ARG injection must stay off, see the deployment runbook).
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/workspace/collaboration-rs/target,sharing=locked \
    cargo build --release --locked -p server \
    && cp target/release/capy-collaboration /usr/local/bin/capy-collaboration

FROM debian:bookworm-slim
# ca-certificates for Sentry over TLS; wget for the compose healthcheck.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates wget \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /usr/local/bin/capy-collaboration /usr/local/bin/capy-collaboration
USER nobody
EXPOSE 1234
CMD ["capy-collaboration"]
