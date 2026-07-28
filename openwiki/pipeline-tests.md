---
type: Backend
title: 'Pipeline: Disposable Integration Test Infrastructure'
description: 'How pipeline cassette tests provision their Postgres and Redis dependencies.'
tags: [backend, pipeline, testing, docker, postgres, redis]
---

Run the suite from the repository root:

```bash
uv run --extra test pytest pipeline/tests/ -q
```

Tests marked `cassette` lazily build `deploy/postgres/Dockerfile`, which adds
Apache AGE to the pgvector Postgres image, then start fresh Postgres and Redis
containers on dynamically mapped ports. The fixture updates both the process
environment and the already-imported `pipeline.config.cfg`, and removes the
containers and temporary image when the pytest session ends. No compose service,
native database, or persistent test volume is required.

LightRAG downloads the public `o200k_base` tokenizer data on first use. The
cassette fixture primes that cache before enabling VCR; otherwise VCR treats the
tokenizer download as an unrecorded HTTP interaction.

The root `pyproject.toml` uses `where = ["pipeline"]` so the nested
`pipeline/pipeline` source directory installs as the top-level `pipeline`
package. Changing that back to the repository root produces
`pipeline.pipeline` imports and breaks test collection.
