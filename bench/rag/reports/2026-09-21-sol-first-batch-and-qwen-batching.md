# First Sol backfill and optional Qwen batching

The first small live backfill completed 98 excerpts in two previously processed
books. Both replacements are published as version 2 and their version 1 data
remains retained. This is evidence for the bounded metadata workflow, not a
claim that all source extraction is complete across these books or the library.

## Sol work and publication

Two fresh `gpt-5.6-sol` agents used medium reasoning and the fixed assignment
prompt, frozen review contract, failure examples and example packet. Each owned
one complete book. The ordinary ingest worker stayed paused; the parent
serialized canonical import, indexing and publication for this first batch.
The broader `kb` automation was not resumed.

| Book | Reviewed excerpts | Recorded physical-page inspections | Reused topics | Non-teaching excerpts | Published version |
| --- | ---: | ---: | ---: | ---: | ---: |
| Basic Political Concepts | 52 | 42 | 6 | 5 | 2 |
| Music Fundamentals 2: Rhythm and Meter | 46 | 50 | 3 | 4 | 2 |

Every assigned excerpt now has a source-backed retrieval summary and scope,
with necessary context links where supplied by the review. All 98 full synopses
were preserved. The political-concepts owner reassigned three excerpts to the
existing government/rule-of-law topic. Neither book required new topics.

The parent checked exact coverage, canonical source/corpus and base-tag hashes,
the immutable original-note baseline, current definitions of used topics,
inspection-image existence and byte-for-byte packet reproduction. The existing
enrichment validator checked roles, topic IDs, evidence and metadata. After
indexing and publication, every live excerpt's source text, synopsis, roles,
topics, evidence and retrieval metadata matched the validated candidate,
including versioned context links. Previous versions remained retained.

Local receipts and reusable packets are in
`data/knowledge-base/sol-first-batch-2026-09-21/`. Each book has `assignment.json`,
`review.json`, `packet-exported.json`, `result.md`, `parent-audit.json` and
`publication-verification.json`; the root inventory records completed scopes.
The source-page observations are Sol's review records, not an independent
second visual audit. Subagent usage was unavailable and is recorded as unknown.

## Remaining source limitations

These were enrichment assignments against the existing corrected corpus.
They did not reparse or rewrite source text. The scopes and packets expose:

- Political concepts: 25 excerpts with repeated parser paragraphs, 14 with
  missing displayed formulas or diagrams, five with flattened/duplicated table
  layout, one section-path spillover and one inconsistency printed in the source.
  These categories overlap; they are not a count of distinct bad excerpts.
- Music: two missing notation payloads, a listening task/answer pair whose
  recordings are external, and further omitted audio/animation references.

Retrieval can now show these limits. That does not recover the missing content;
future assigned source repair or source-page inspection is still needed for
those exact tasks. Neither Qwen's advisory role nor duplicate-result grouping
is a substitute for source recovery.

## Optional Qwen batch commands

`lab/knowledge/qwen_batch.py` provides separate `prepare`, `submit` and `poll`
commands. `poll --watch` checks immediately, then every 600 seconds until a
terminal state and collects output/error files. The implementation reuses the
existing durable Alibaba batch client and tested book-review request builder.

Preparation freezes packets and prompt/schema/settings, records hashes and
requires `--thinking` or `--no-thinking`. Both modes request strict JSON Schema
with no caller output-token or thinking-budget cap. Submission records the file
and batch IDs, binds the endpoint and reconciles uncertain writes without blind
resubmission. Temporary GET network/429/5xx failures wait for the next poll;
permanent rejections remain explicit. Raw responses, reasoning/usage when
provided, parsed reviews and contract warnings are retained by custom ID.

Qwen suggestions and contract warnings do not alter Sol artifacts, fail
publication or trigger a Sol repair loop. Failed/missing provider output is
recorded separately. A later assessor can read the packets and responses.
The two newly emitted Sol packets have not been submitted to Qwen.

A live thinking-mode transport test submitted two already saved inputs: the
clean synthetic book control and the 79-target mathematics packet from the
earlier trial. Alibaba accepted batch
`batch_d35fbcb8-6459-4c8e-a729-5b1c69b56ca0`; its observed state is `in_progress`.
This establishes successful upload/create/status calls, not completed live
result collection. A background watcher is active in
`data/knowledge-base/qwen-reviews/2026-09-21-batch-transport/`; it will store
responses when available. A code update restarted only the local read-only
watcher, preserving the original remote batch ID.

## Verification and follow-up

- `pnpm test:pipeline lab/knowledge/tests/test_qwen_batch.py lab/knowledge/tests/test_packet.py lab/knowledge/tests/test_enrich.py bench/rag/scripts/test_knowledge_base_pilot.py bench/rag/scripts/test_knowledge_review_samples.py -q`: 47 passed.
- `pnpm run fmt:py`: passed.
- The independent code review identified a transient-HTTP polling gap. The fix
  was rechecked, including a terminal job's output-download 503, with no remaining
  finding in that pass.
- A fresh static closing review found no remaining actionable issues in the
  scoped batch implementation. It did not claim live batch completion.

The [operator guide](../../../lab/knowledge/qwen-batch.md) includes commands,
saved file meanings, resume behavior and the provider documentation. Deferred
curate-loop and deduplication work is listed in
[`todo-knowledge-curate-and-dedup.md`](../../../todo-knowledge-curate-and-dedup.md).
