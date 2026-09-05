# Handoff — concept extraction removal, and how to revisit it

Written 2026-09-04. Read this before re-adding any entity/concept layer to retrieval.

## Status

Concept extraction is **removed**. The ingest LLM call, the `rag_concepts` /
`rag_concept_mentions` tables, the donor-copy and workspace-clone SQL, the
`concepts_created` attempt counter, and the concept footer on every
`search_workspace` result are all gone. Search is vector + lexical RRF only.
Multi-hop is the agent loop: read the hits, search again for a name found in
them.

Decision entry: `human/agentic-retrieval.md` (search for "overriding the two
earlier concept decisions"). Pipeline description: step 5 of the ingest section
in `openwiki/agentic-retrieval.md`.

## Why it went

The footer was navigational only — it never entered ranking. Two things killed it:

- On the lab corpus, **910 of 1,663** concepts were named in exactly one chunk,
  so they could only point back at the passage the model was already holding.
- No chat trace showed the model following a footer name into another document.
  Follow-up searches were rephrasings of the user's question, or reused terms
  the model had just read in the hit text — which it does with or without a footer.

## What was measured

13 two-document questions (es/fr/ja/zh lab workspaces), each phrased in one
document's vocabulary with the answer in the other. Run twice through the full
chat agent on the deployed image, twice on an identical image with only the
footer removed. 52 completed turns.

| Measure | Footer | No footer |
| --- | --- | --- |
| Turns where a search returned an expected chunk | 24 / 26 | 23 / 26 |
| Turns citing an expected chunk | 24 / 26 | 23 / 26 |
| True-bridge questions reached (no target entity in the question) | 17 / 18 | 16 / 18 |
| Searches per turn | 1.50 | 1.65 |
| Follow-ups reusing a term from earlier hit text | 7 / 13 | 13 / 17 |

Single-shot hybrid search (no agent loop) reached the target in 10 of 13.
The five strict misses were all read-throughs or citations of duplicate /
adjacent passages carrying the same answer — **every one of the 52 turns
produced the correct cross-document answer.**

## Why this is worth revisiting (the reason for this file)

The lab corpus is too small to stress bridging:

- Each lab workspace holds 2–4 documents.
- Only **27** concept names spanned two files across the whole non-English lab
  corpus (es 5, fr 4, ja 17, zh 1; de had none).
- The English workspace is unusable for bridge tests — its four files duplicate
  each other's text, so "cross-document" is trivially satisfied.

That matches a small student workspace. It says nothing about a workspace with a
full textbook plus lecture notes plus past papers, where the answer passage may
share no vocabulary with the question and the agent may not find a name to hop on.

## How to re-run with a bigger workspace

1. **Build the corpus.** 8+ documents in one workspace, genuinely different
   sources on one subject (not editions of the same file). Upload through the
   lab's `reset.sh` flow or the normal upload path.
2. **Write the questions.** 30–50 is enough. The rule that matters: the question
   must be answerable only from document B while using document A's wording, and
   must **not** name the bridging entity. Existing examples are in
   `pipeline/scripts/rag_eval/questions-{es,fr,ja,zh}-bridge.json` — same
   `{"q", "expect": [[file_name, chunk_idx], ...]}` format as every other set.
   Pick `expect` chunks by dumping chunk text first; do not guess indices.
3. **Baseline it as-is** (no concept layer). Run the agent, not just search:
   `bridge_run.py` on the VM records tool calls, the chunks each search returned
   from `rag_search_events`, which were cited, and the answer.
4. **Only if the baseline fails** — a real bridging miss is a turn where the
   expected passage never appears in any search AND the answer is wrong or
   absent, not merely a different-but-correct passage. Count those.

## What would justify rebuilding a concept layer

All three, roughly in this order:

1. **Bridging failure rate** above a few percent on a graded two-document set
   like the one above. This is the only number that can justify restructuring,
   and it needs ground truth, so telemetry alone cannot produce it.
2. **Wasted-hop rate** in production: turns with 3+ searches whose hits overlap
   and whose answer cites nothing. Computable from `rag_search_events` today
   (grouped by `message_id`) — no schema change needed. This is a ceiling on the
   benefit, not proof: it also fires when the corpus simply lacks the answer.
3. **Second-search vocabulary**: do follow-up queries carry names taken from the
   hit text, or only rephrasings? Not computable from telemetry (query text is
   deliberately not stored) — measure it on the lab, where the harness keeps the
   queries.

**If it reopens, build the LinearRAG shape, not the old one:** cheap NER /
keyphrase extraction (no LLM call per chunk group) plus a bounded one-hop
co-mention expansion as a **third RRF leg**, so it affects ranking. The removed
design paid LLM extraction cost for a text footer that never touched ranking —
LightRAG's bill with LinearRAG's structure and neither one's benefit.

## Where things are

**Repo**

| Path | What |
| --- | --- |
| `pipeline/pipeline/retrieval/store.py` | `hybrid_search` — the RRF SQL, `_LEX_WEIGHT`, exact tier |
| `pipeline/pipeline/retrieval/tools.py` | `_search_workspace`, overlap footer |
| `pipeline/pipeline/retrieval/indexing.py` | `index_file` — chunk, embed, summarize (extraction removed here) |
| `pipeline/scripts/rag_eval.py` | single-shot search diagnostics |
| `pipeline/scripts/rag_eval/questions-*-bridge.json` | the 13 bridge questions |

**Lab VM** — `root@159.195.61.195`, key `~/.ssh/id_ed25519_evo_ingest`,
stack at `/opt/evo-rag-lab` (compose project `evo-rag-lab`).
Note: 159.195.250.206 was quoted once in conversation and does **not** accept
this key.

| Path | What |
| --- | --- |
| `bridge/bridge_run.py` | agent-level runner: `python3 bridge_run.py <questions.json> <out.jsonl> <label>` |
| `bridge/agent-footer.jsonl`, `bridge/agent-nofooter.jsonl` | raw run records (per-turn tools, hits, citations, answers) |
| `bridge/search-footer-*.txt` | single-shot search reports per workspace |
| `bridge/tools.py.footer` | the pre-removal `tools.py`, if you need to diff |
| `workspaces.env` | `WS_de` … `WS_zh` workspace ids |
| `secrets.env` | provider keys (`secrets.env.bak-2026-09-04` is the pre-rotation copy) |

Docker image `evo-rag-lab-pipeline:nofooter` is the footer-less build used for
the comparison.

## Gotchas

- **Postgres in the lab** is compose service `db`, role `evo`, database `evo`:
  `docker compose exec -T db psql -U evo -d evo`. Not `postgres`.
- **Keys**: the lab's DeepSeek key was rotated out from under it once already
  (401s look like `agent_failed` in the stream, the real error is in
  `docker compose logs retrieval`). Current keys came from `deploy/.env.uat`.
  Compose reads them from the shell: `set -a; . ./secrets.env; set +a` before
  `docker compose up`, and pass `RELEASE_SHA`.
- **Rate limit**: `/chat/stream` is in the gateway's AI class — **200/hour with
  burst 15, keyed by user id** (`ratelimit.DefaultConfig`). GCRA, so it is one
  request per 18s sustained after the 15-token burst drains. A 13-question pass
  is fine; back-to-back passes trip it (observed `retry_after_s` 6–9, which only
  the hourly rule can produce — the 15/min burst rule caps retry at 4s). Pace the
  runner at one turn per ~20s, or set `RATE_LIMIT_AI_PER_HOUR` higher on the lab.
  **These are the production limits too** — only `APP_ENV=e2e` or
  `RATE_LIMIT_DISABLED` turns the limiter off, and prod pins the latter to false.
- **Chunk indices move** with `CHUNKER_VERSION`. Every `expect` in every question
  set is keyed to chunk indices, so a chunker change invalidates them all —
  see `remap_v4.py` on the VM for how the last remap was done.
- **`human/` and `pipeline/scripts/rag_eval/` are untracked in git** (not
  ignored, just never added). The decision log and the bridge question sets live
  there, so `git add` them before committing.
