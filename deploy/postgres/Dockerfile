# Postgres 16 with BOTH pgvector and Apache AGE — neither official image ships
# the other, so we build AGE from source on top of the pgvector image (same PG
# build => matching paths/ABI for the copied extension files).
#
# pgvector/pgvector:pg16 bundles pgvector >= 0.8 (>= 0.7.0 is required for the
# halfvec HNSW indexes LightRAG uses for 2560-dim embeddings).
#
# AGE must be preloaded; do that at runtime via compose:
#   command: ["postgres", "-c", "shared_preload_libraries=age"]

ARG AGE_REF=PG16

FROM pgvector/pgvector:pg16 AS build
ARG AGE_REF
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential git ca-certificates flex bison postgresql-server-dev-16 \
    && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch "${AGE_REF}" https://github.com/apache/age.git /age
WORKDIR /age
RUN make PG_CONFIG=/usr/lib/postgresql/16/bin/pg_config \
    && make install PG_CONFIG=/usr/lib/postgresql/16/bin/pg_config

FROM pgvector/pgvector:pg16
# Apache AGE extension artifacts built above.
COPY --from=build /usr/lib/postgresql/16/lib/age.so /usr/lib/postgresql/16/lib/age.so
COPY --from=build /usr/share/postgresql/16/extension/age.control /usr/share/postgresql/16/extension/
COPY --from=build /usr/share/postgresql/16/extension/age--*.sql /usr/share/postgresql/16/extension/
COPY initdb/ /docker-entrypoint-initdb.d/
