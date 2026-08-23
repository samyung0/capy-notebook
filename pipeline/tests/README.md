# Pipeline tests

Three tiers:

| tier | files | needs | cost |
| --- | --- | --- | --- |
| **offline unit** | `test_chunking.py`, `test_retrieval_helpers.py`, `test_modal_parser.py`, `test_figures.py`, `test_ingest_worker.py`, `test_parse_slots.py`, `test_marker_worker_ocr.py`, `test_ai_adapter.py` | nothing | free, ~2s |
| **SQL integration** (`@pytest.mark.integration`) | `test_store_sql.py`, `test_model_configs_lock.py` | Docker | free, ~10s |
| **cassette integration** (`@pytest.mark.cassette`) | `test_ingest_query.py`, `test_generate.py` | Docker + recorded cassettes | free on replay |

The retrieval index is owned by `server/migrations/0001_init.sql`, so both
Docker tiers start a stock `pgvector/pgvector:pg16` container and apply that
file — the same one the gateway applies at boot. Nothing in the pipeline
creates tables, and a column rename in the migration surfaces here rather than
in production.

The SQL tier writes synthetic one-hot embeddings, so it exercises every
statement in `retrieval/store.py` (hybrid search, scoping, the concept
self-join, two-tier content summaries, cascade deletes) without a single model
call. The cassette tier drives the real chunk → embed → summarize → extract →
search → answer path with model traffic replayed from
[VCR](https://vcrpy.readthedocs.io) cassettes in `cassettes/`. Postgres and
Redis are raw TCP, so VCR never touches them.

## Running (replay — the default)

```bash
uv run --extra test pytest pipeline/tests/ -q
```

Docker Desktop (or another daemon) is required for the two integration tiers.
Cassette tests **skip** when their recording is missing, so a fresh checkout
without cassettes still gives a meaningful green run. Each test gets a
throwaway workspace and deletes it afterwards; every `rag_*` row cascades from
it, so isolation needs no table-by-table cleanup.

## Re-recording cassettes

Re-record when a request-shaping change alters an outbound body: prompt edits,
model or embedding-dimension changes, or chunking changes. Recording hits the
real services and costs tokens.

```bash
export EMBEDDING_API_KEY="..."    # embeddings (OPENROUTER_API_KEY still works)
export DEEPSEEK_API_KEY="..."     # summaries, concepts, answers

export EVO_TEST_RECORD=once       # record only interactions not already saved
# delete the cassette(s) you want to refresh first, then:
uv run --extra test pytest pipeline/tests/test_ingest_query.py -q
unset EVO_TEST_RECORD
```

## How determinism is kept (why replay matches)

Model responses are non-deterministic, but VCR matches on **requests**, and
those are made deterministic so a recording keeps matching:

- **Matching** (`conftest.py`) ignores host/port and matches on `method` + URL
  `path` + a normalized JSON body. Each provider owns a distinct path
  (`/api/v1/embeddings`, `/chat/completions`), so path + body is unambiguous.
  Secrets are stripped via `filter_headers` / `filter_query_parameters`.
- **Request-shaping config is pinned in `conftest.py`**, not read from
  `deploy/.env`, so model names and base-URL paths are byte-identical between
  record and replay.
- **One embedding batch per file** (`EVO_EMBEDDING_BATCH=1000`) gives the
  `input` list a stable composition.
- **Fresh workspace per test** means the prompts are a pure function of the
  fixture content.

## Platform notes

- psycopg's async driver refuses to run on Windows' default Proactor event
  loop. `pipeline.use_compatible_event_loop()` selects a selector loop and is
  called by `conftest.py` and by both service entrypoints.
- testcontainers' reaper races its own port publication on Docker Desktop for
  Windows, so it is disabled; both containers are context-managed instead.

## Fixtures

- `workspace` — a throwaway workspace with `add_chapter` / `add_file` / `scalar`.
- `sample.txt` — photosynthesis, the primary ingest input.
- `sample_cells.txt` — a second document sharing the concept "ATP", for the
  cross-document co-mention test.
- `sample.pdf` — small real PDF (unused by the current suite; the Modal client
  is covered offline).
