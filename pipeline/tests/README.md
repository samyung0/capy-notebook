# Pipeline tests

Two tiers:

| tier                     | files                                     | needs                                | cost           |
| ------------------------ | ----------------------------------------- | ------------------------------------ | -------------- |
| **offline unit**         | `test_modal_parser.py`, `test_helpers.py` | nothing                              | free, ~4s      |
| **cassette integration** | `test_ingest_query.py`                    | live Postgres (+ recorded cassettes) | free on replay |

The integration tier drives the real migrated code — the per-workspace factory,
the model adapters (embedding / LLM / VLM), the custom `modal` parser engine and
LightRAG's ingest + query pipelines — while every model/Modal **HTTP** call is
served from a recorded [VCR](https://vcrpy.readthedocs.io) cassette in
`cassettes/`. Postgres and Redis are raw TCP (not HTTP), so VCR never touches
them: they stay live and cost nothing.

## Running (replay — the default)

Cassettes are committed, so replay needs no API keys and makes no model calls.
It does need a Postgres with the LightRAG schema + `age`/`vector` extensions —
the compose DB is fine. That DB is published on host port **5433** (5432 is left
for a machine's native Postgres; see `deploy/docker-compose.yml`).

```powershell
cd pipeline
$env:DATABASE_URL = "postgres://evo:evo@localhost:5433/evo?sslmode=disable"
uv run --extra test pytest tests/ -q
```

Each integration test uses a unique throwaway workspace and purges its LightRAG
rows + AGE graph on teardown, so runs are isolated and repeatable.

## Re-recording cassettes

Re-record when a request-shaping change alters an outbound body: prompt/template
edits, model or embedding-dimension changes, chunking changes, or a new
model/Modal call. Recording hits the real services and costs tokens + a Modal
GPU run.

```powershell
cd pipeline
# real keys for the providers + a deployed Modal endpoint
$env:OPENROUTER_API_KEY = "..."
$env:DEEPSEEK_API_KEY    = "..."
$env:GOOGLE_API_KEY      = "..."
$env:MODAL_PARSE_URL     = "https://<org>--evo-mineru-mineruparser-web.modal.run/file_parse"
$env:MODAL_PARSE_TOKEN   = "..."
$env:DATABASE_URL        = "postgres://evo:evo@localhost:5433/evo?sslmode=disable"

$env:EVO_TEST_RECORD = "once"        # record only interactions not already saved
# delete the specific cassette(s) you want to refresh first, then:
uv run --extra test pytest tests/test_ingest_query.py -q
Remove-Item Env:EVO_TEST_RECORD
```

Record one test at a time (`... ::test_name`) — a cold Modal GPU start can take a
couple of minutes.

## How determinism is kept (why replay matches)

Model responses are non-deterministic, but the **requests** are what VCR matches,
and those are made deterministic so a recording keeps matching:

- **Matching** (`conftest.py`) ignores host/port and matches on `method` + URL
  `path` + a normalized JSON body. Each provider owns a distinct path
  (`/api/v1/embeddings`, `/chat/completions`, `/v1beta/openai/...`,
  `/file_parse`), so path + body is unambiguous. Secrets are stripped from
  cassettes via `filter_headers` / `filter_query_parameters`.
- **Serial execution** (`MAX_ASYNC_LLM=1`, `EMBEDDING_FUNC_MAX_ASYNC=1`,
  `MAX_PARALLEL_INSERT=1`) + a large `EMBEDDING_BATCH_NUM` give calls a stable
  order and a single, stable-composition embedding batch.
- **Ingest LLM cache off** (`EVO_INGEST_LLM_CACHE=false`) so every run issues the
  same extraction calls rather than short-circuiting on a PG cache hit.
- **Body normalization** in the matcher: ingest wall-clock timestamps
  (`YYYY-MM-DD HH:MM:SS`) are blanked, embedding `input` lists are sorted, and
  the newline-delimited KG-context records in a chat prompt are sorted (equal-
  score entities/relations come back from Postgres in arbitrary order).

All of the above are set as defaults in `conftest.py`, so both record and replay
share them automatically.

## Fixtures

- `sample.txt` — plain-text ingest input.
- `sample.pdf` — small real PDF for the Modal parse path.
