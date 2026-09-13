# Decisions needed during implementation

The implementer appends a question here and returns when the plan and `human/`
do not settle a choice. The orchestrator gets the answer from the developer,
records it in `human/`, and resumes the implementer. Answered items stay for
the record.

## 1. Migration placement: forward files only, `0001_init.sql` left frozen

The plan (§2, §7) says the new rag_chunks columns, the page rates and the
default chat pin go into `server/migrations/0001_init.sql` "for fresh
databases" plus a new numbered file for existing ones. UAT's database has
`0001` through `0005` applied, and the migrator refuses an applied file whose
checksum changed (`server/internal/store/migration_plan.go`; runbook: "Once a
database is kept, freeze its applied migration files"). Editing `0001` would
stop UAT's next deploy at migration time.

Implemented: `0006_rag_chunk_confidence.sql`, `0007_drop_caption_images.sql`,
`0008_parse_page_rates.sql` and `0009_default_chat_model.sql` carry every
schema and seed change; `0001` is untouched. A fresh database runs `0001`
through `0009` and ends in the same state, so nothing is lost for fresh
installs.

Recommended answer: keep it this way. If the developer prefers the folded
`0001` (as decided for `0002_model_capacities.sql` on 2026-09-09), UAT's
database has to be dropped and re-seeded first; say so and the fold is a
ten-minute change.

## 2. Re-record the zai/glm-5.3-flash certification cassette (needs TENCENT_API_KEY)

The route moved to Tencent TokenHub, but `TENCENT_API_KEY` is not set in the
implementer's shell and is not in `deploy/.env.uat`, so the live two-turn
recording could not run. The stale DeepInfra cassette is kept so the Go
`agentic_loop_certs.json` embed still certifies GLM for the chat slot (the
default chat pin depends on it), and two tests fail on purpose until the
re-recording lands:

- `pipeline/tests/test_model_replay.py::test_certified_manifest_has_two_turn_cassette[zai/glm-5.3-flash]`
  (new guard: a cassette must be recorded against the live route's host)
- `pipeline/tests/test_model_replay.py::test_certified_two_turn_replay[zai/glm-5.3-flash]`
  (VCR cannot match `/v1/chat/completions` against the recorded DeepInfra path)

Command, with the key exported in the shell and never written to disk:

    TENCENT_API_KEY=... pnpm model:certify -- --provider zai --model glm-5.3-flash

It records two live turns through TokenHub, replays them, rewrites
`pipeline/tests/cassettes/replay/zai__glm_5_3_flash.yaml` and regenerates
`server/internal/models/agentic_loop_certs.json`. No decision needed, only the
key; after it runs `pnpm test:pipeline:offline` and `pnpm test:pipeline:replay`
are green. Also add `TENCENT_API_KEY` to `deploy/.env.uat` (and push it with
`pnpm env:push`) as the manifest now requires it.

## 3. Standalone image uploads now bill their tokens only

`human/observability-metering.md` (2026-09-12) retires `figure_caption_call`.
That rate was the per-call surcharge on *both* embedded figure captions and the
standalone image-upload caption (`purpose == "image_caption"` in
`pipeline/retrieval/accounting.py` added it on top of the model's token
credits). With no active row, the old code would have failed every image
upload at settlement ("ingest caption settlement has no rate snapshot").

Implemented: the surcharge is gone; a standalone image caption bills the
vision model's input/cached/output tokens through the ordinary LLM path, like
a file summary. Go no longer pins the caption rate onto ingest jobs
(`store/pricing.go` `ingestResourceKeys`).

Recommended answer: accept. If a per-image floor is wanted, it is a new
`image_caption_call` resource rate (one migration row plus the one `if` in
`_settle_ingest_call_sync`), not a revival of `figure_caption_call`.

## 4. Migration `0009_default_chat_model.sql` changes only the users column defaults

The plan (§4) and `human/agentic-retrieval.md` say GLM "becomes the default
chat pin for new users" and that the migration "alters the column defaults;
existing rows keep their pin". A first draft also moved the catalog's chat
slot default (`model_configs.is_default_for`) to GLM; that broke the Go tests
that pin DeepSeek Flash as the slot default and would have changed where a
BYOK-key removal lands existing users, which nobody decided. The shipped
migration alters `users.chat_model_provider_slug` / `chat_model_slug` defaults
only. New accounts therefore start on GLM, while the chat *slot* default (used
for pin resets and as the catalog fallback) stays DeepSeek Flash.

Recommended answer: accept. Moving the slot default too is a one-statement Ops
action (or an extra migration), should the developer want both to agree.

Decided (fixes-1.md, 2026-09-12): the slot default moves too. `0009` now clears
`chat` from every other row, marks the newest enabled GLM row and bumps
`model_registry_state.version` in the same transaction; the Go tests that
pinned DeepSeek Flash as the chat slot default were updated.
