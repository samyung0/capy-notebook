# Embedding comparison

See [PLAN.md](PLAN.md) for the conditions and selection rule fixed before the
run. The experiment reuses the corpora described in
[HANDOFF-rag.md](../../../../HANDOFF-rag.md). It changes only the embeddings and
their scratch vector tables. Production application code, model registrations,
workspace pins, chunking and hybrid weights are unchanged.

The runner requires the preserved curated lab image and its database, not a
production deployment. Its guards require gateway `127.0.0.1:8082` and database
`127.0.0.1:55434`. `/lab` is the retained fixture mount and `/lab/embedding` is
the experiment directory. The only added schema is `embedding_eval_20260906`.

## Reproduction

Mount these scripts at `/lab/embedding` in the frozen pipeline image. Supply a
temporary mode-0600 `/lab/embedding-secrets.json` containing the `deepinfra` and
`openrouter` keys. This file is outside the result directory and must never be
included in archives. Public route metadata is in `api-metadata.json`.

Run inside that disposable container:

```sh
python /lab/embedding/embed.py
python /lab/embedding/run.py freeze
for condition in qwen4 qwen8_2560 qwen8_4000 pplx4 voyage4; do
  python /lab/embedding/run.py index "$condition"
  python /lab/embedding/run.py retrieval "$condition"
done
python /lab/embedding/analyze.py /lab/embedding
for condition in qwen4 qwen8_2560 qwen8_4000 pplx4 voyage4; do
  python /lab/embedding/run.py ann "$condition"
done
python /lab/embedding/run.py latency
```

The immutable freeze includes source and runtime hashes and per-workspace chunk
fingerprints. A source/code change fails the guard. Successful corpus batches
are cached; failures are recorded and require inspection before a resumed run.
Latency requests bypass the cache and are never retried. Model/role shaping and
response validation have a self-check in `embed.py`. The existing broad metric
self-check runs with each freeze, and the existing curated grading check covers
evidence chains and numeric boundaries.

The quality comparison forces exact vector ordering with the existing SQL,
including the original file-scope exclusion for BEIR queries. It uses the real
per-file cap and passage-position relevance metrics. ANN is a separate
diagnostic over the same vectors and exclusions. Its direct vector query tests
workspace filtering against a shared index; it is not the full hybrid SQL path.
Saved plans prove use of HNSW. The natural direct-vector plan and forced HNSW
plans are retained separately.

After all models finish, `selection.json` identifies the challenger with the
highest hybrid nDCG@5. Stop the original lab retrieval process and start
`python /lab/embedding/chat.py serve` in a separate disposable container using
the same frozen image and environment. It binds the same loopback retrieval port
so the existing lab gateway can reach it. Run
`python /lab/embedding/chat.py run CONDITION` in that container, replacing
`CONDITION` with the saved selection.

Both chat conditions use the prior `follow_links_ids` prompt and file-location
rendering. Test hooks replace query embedding and the vector-table lookup in
that process only. Database pins still identify the original 4B fixture, while
the condition and provider receipts identify the embeddings actually used.
Embedding calls bypass application billing/admission and are recorded separately;
these are isolated-lab timings, not production capacity measurements. No ingest
workers run during the comparison. Chat first-attempt failures remain in the
denominator. The account locale is restored after the run.

## Artifacts and interpretation

- `freeze.json`, `chat-freeze.json`, and `chunks.json.gz` preserve the evaluated
  inputs and runtime identities.
- `requests.jsonl` records routes, usage, request counts, latency and errors.
  It excludes credentials and input text. `vectors.sqlite3` caches accepted
  float32 vectors; Postgres tests store them as `halfvec`.
- `retrieval-*.jsonl` retains every query's metrics and returned chunk/file IDs.
  `plans-*.json` verifies exact search for the quality comparison.
- `ann-*.jsonl` and `ann-plans-*.json` contain approximate-neighbor recall,
  timings and plans. `index-*.json` records build time and physical storage.
- `latency.jsonl` retains every planned uncached request, including failures.
- `chat.jsonl`, `tool-evidence.jsonl`, and `chat-sources.json` retain answers,
  streams, searches, reads and source text for review.
- `summary.json` separates retrieval, paired changes, latency, index cost and
  automated chat diagnostics. Diagnostic answer-value matching is not a
  semantic or citation-support review.

MIRACL pools are reduced, public benchmark labels are incomplete, and previously
inspected questions are development/comparison data. Cohort-stratified paired
bootstrap intervals summarize variation within these questions; they do not
establish performance on new domains. Raw vector-neighbor overlap is distinct
from relevance. Two chat repeats of one question are dependent observations.

Archive results and their hashes locally before removing the scratch schema,
temporary VM directory, credential file and new container. Restore reused lab
containers to their initially stopped state. The older retained labs remain
separate from this experiment's cleanup.
