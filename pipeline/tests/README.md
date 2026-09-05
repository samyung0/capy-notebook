# Pipeline tests

Three tiers:

| tier | files | needs | cost |
| --- | --- | --- | --- |
| **offline unit** | `test_chunking.py`, `test_retrieval_helpers.py`, `test_parser_client.py`, `test_parser_app.py`, `test_mineru_worker.py`, `test_figures.py`, `test_ingest_capacity.py`, `test_ingest_worker.py`, `test_parse_slots.py`, `test_ai_adapter.py` | nothing | free, ~2s |
| **SQL integration** (`@pytest.mark.integration`) | `test_store_sql.py`, `test_model_configs_lock.py` | Docker | free, ~10s |
| **cassette integration** (`@pytest.mark.cassette`) | `test_ingest_query.py`, `test_generate.py` | Docker + recorded cassettes | free on replay |

The retrieval index is owned by the numbered Go migrations
(`server/migrations/0001_init.sql` today), so both Docker tiers start a stock
`pgvector/pgvector:pg16` container and apply those files — the same ones
`Store.Migrate` ledgers. Nothing in the pipeline creates tables, and a column
rename in a migration surfaces here rather than in production.

The SQL tier writes synthetic one-hot embeddings, so it exercises every
statement in `retrieval/store.py` (hybrid search, scoping, two-tier
content summaries, cascade deletes) without a single model
call. The cassette tier drives the real chunk → embed → summarize →
search → answer path with model traffic replayed from
[VCR](https://vcrpy.readthedocs.io) cassettes in `cassettes/`. Postgres and
Redis are raw TCP, so VCR never touches them.

## Running (replay — the default)

```bash
uv run --extra test pytest pipeline/tests/ -q
```

To replay only the certified two-turn agentic-loop cassettes, run:

```bash
pnpm test:pipeline:replay
```

That command removes `EVO_TEST_RECORD` before it starts pytest. It cannot make
live model calls or rewrite a cassette, even if record mode is exported in the
calling shell.

Docker Desktop (or another daemon) is required for the two integration tiers.
Cassette tests **skip** when their recording is missing, so a fresh checkout
without optional ingest/generate cassettes still gives a meaningful green run.
Entries in `model_replay_certifications.json` are exact provider/model pairs
that passed certification. A missing or incomplete tape is not certified. A
tape that exists must contain two interactions and must match the manifest.
Each ingest/generate test gets a throwaway workspace and deletes it
afterwards; every `rag_*` row cascades from it, so isolation needs no
table-by-table cleanup.

## Re-recording cassettes

Re-record when a request-shaping change alters an outbound body: prompt edits,
model or embedding-dimension changes, or chunking changes. Recording hits the
real services and costs tokens.

```bash
export DEEPINFRA_API_KEY="..." # seeded Qwen embedding and routed ZAI GLM
export DEEPSEEK_API_KEY="..."   # summaries, answers
export ANTHROPIC_API_KEY="..."  # first-party Anthropic if you certify a Claude slug

export EVO_TEST_RECORD=once       # record only interactions not already saved
# delete the cassette(s) you want to refresh first, then:
uv run --extra test pytest pipeline/tests/test_ingest_query.py -q
unset EVO_TEST_RECORD
```

## Certifying or re-recording an agentic-loop model

Certification is a source-changing operator workflow, not a test command. It
accepts any exact model slug from a conversational provider in
`elitellm/providers.json`. The model does not need to exist in the certification
manifest. After provider selection, the command prints that provider's currently
certified model slugs. Selecting an existing provider/model pair re-records it.
For interactive runs, it then reads the provider API key and fetches the model
slugs available to that key. The model prompt supports free typing, substring
filtering, and Up/Down selection. Certified slugs remain in the choices even if
the provider no longer returns them.

```bash
pnpm model:certify

# Non-interactive model selection; the API key still comes from the provider env.
pnpm model:certify --provider openai --model gpt-5.6-sol

# ZAI catalog identity; the command uses DEEPINFRA_API_KEY and the private wire slug.
pnpm model:certify --provider zai --model glm-5.3-flash
```

The command reads the provider API key from its environment variable or asks
for it without echoing. If the provider rejects that key, the command exits.
If the model-list request fails for another reason, the command warns and
falls back to an exact free-text model prompt. The interactive catalog is
left-aligned, with a check on the selected slug. It then records two
live streaming calls. The first must return a tool call and one of the adapter's
recognized continuity fields. The test appends a tool result, and the second
request must preserve that state. The command then disables record mode and
replays the new tape. The two
recording calls use the live provider and incur its normal cost.

Only a successful replay keeps the cassette and manifest entry. The test
discovers the provider's continuity fields from the first response and verifies
that the adapter returns them on the second request. Those fields are not stored
in the manifest. Success regenerates
`server/internal/models/agentic_loop_certs.json`. A recording failure restores
an existing tape. A mistyped or unavailable new slug should be rejected by the
live provider, and the failed recording leaves no manifest entry or cassette behind.
Ctrl+C, Ctrl+D, terminal hangup, and normal termination exit without a traceback.
An interruption during recording or replay restores the exact pre-command
manifest, cassette, and generated Go certificate file.
If recording succeeds but replay fails, the provider/model pair is not
certified. The command does not write `model_configs`; commit and deploy the
generated source artifacts before adding the model to the Ops dashboard.

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
- `sample.pdf` — small real PDF (unused by the current suite; the parser client
  is covered offline).
