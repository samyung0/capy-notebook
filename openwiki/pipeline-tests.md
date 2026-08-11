---
type: Backend
title: 'Pipeline: Disposable Integration Test Infrastructure'
description: 'How pipeline integration and cassette tests provision their Postgres and Redis dependencies.'
tags: [backend, pipeline, testing, docker, postgres, redis]
---

Run the suite from the repository root:

```bash
uv run --extra test pytest pipeline/tests/ -q
```

Tests marked `integration` or `cassette` start fresh `pgvector/pgvector:pg16`
and `redis:7-alpine` containers on dynamically mapped ports, then apply
`server/migrations/0001_init.sql` to the database. That file is the gateway's
own baseline schema and it owns the retrieval index (`rag_chunks`,
`rag_*_summaries`, `rag_concepts`, `rag_concept_mentions`) — the pipeline
creates no tables of its own, so a schema change surfaces in these tests rather
than at runtime. There is no custom image to build; Apache AGE went with
LightRAG.

The fixture updates both the process environment and the already-imported
`pipeline.config.cfg`, and removes the containers when the pytest session ends.
No compose service, native database, or persistent test volume is required.

## Ordering and platform hazards

Three sharp edges are handled in `pipeline/tests/conftest.py`, all of which
present as unrelated-looking failures if removed:

- **Postgres readiness.** The container's log line `database system is ready to
  accept connections` is printed twice — once by initdb while the server is
  listening on the unix socket only. The fixture polls a real TCP connection
  after the log wait, or roughly half of all runs fail on a closed connection.
- **Event loop.** psycopg's async driver refuses to run on Windows' default
  Proactor loop, and the symptom is a 30-second pool timeout rather than an
  error naming the cause. `pipeline.use_compatible_event_loop()` selects a
  selector loop; `conftest.py` and both service entrypoints call it.
- **Skip before setup.** A missing cassette is skipped in
  `pytest_runtest_setup`, not in a fixture: the container fixture is
  session-scoped, so pytest would start Docker before any function-scoped
  fixture could skip.

The async connection pool is closed after every test by an autouse fixture,
because pytest-asyncio gives each test its own loop and a psycopg pool is bound
to the loop that opened it.

## Packaging

The root `pyproject.toml` uses `where = ["pipeline"]` so the nested
`pipeline/pipeline` source directory installs as the top-level `pipeline`
package. Changing that back to the repository root produces
`pipeline.pipeline` imports and breaks test collection.
