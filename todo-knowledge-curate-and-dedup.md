# Deferred knowledge retrieval and curate work

Status: deliberately deferred while the Sol initial-processing and optional
Qwen book-review workflow is established. These items are not publication gates
and do not expand Qwen's current assignment.

## Curate mode agent loop

- [ ] Match requested generality across domains. Evaluate general statistics
  against R-dependent instructions, school-specific versus general leadership,
  and method/population/jurisdiction/time/unit restrictions. Use the excerpt's
  reviewed scope, distinguish incidental examples from necessary conditions,
  and treat missing metadata as unknown. Generality and difficulty differ.
  Keep knowledge retrieval independently tunable from workspace retrieval;
  no prerequisite graph or search-continuation cache.
- [ ] Test a bounded draft-check-and-repair pass against passages actually read.
  Start with the Athens note's unsupported institutional claims and leadership
  overgeneralizations, alongside supported controls. Measure missed errors and
  unnecessary rejection of useful supported claims.
- [ ] Tie verification of generated numerical/formula/table examples to their
  supporting source pages. Test missing captures, unrelated pages, unavailable
  images and one screenshot covering only part of a material. A generic page
  check must not certify the whole output. This is realtime material generation
  using the user's chosen model; Qwen does no page review.
- [ ] Address useful research ending without a material or a clear explanation.
  Replay the two-regression-example run that read three excerpts and captured
  a page before stalling. Test one bounded chance to write from gathered evidence
  before final shutdown, with further searching disabled. Also resolve research
  todos the current material-only completion ledger cannot mark done. Keep
  insufficient evidence visible instead of forcing a fabricated note.

Use separate unseen questions after tuning. Record material completion,
evidence support, retrieval fit and latency/token cost. See
[scope implementation results](bench/rag/reports/2026-09-21-knowledge-scope-implementation.md)
and the [retrieval workflow](openwiki/agentic-retrieval.md).

## Duplicate examples in knowledge search

- [ ] Build a contrast set around the repeated Elmhurst example. Preserve
  different datasets, variables, populations, units and simple versus multiple
  regression. Exercise/solution pairs, split continuations, concept versus R
  implementation and different derivations are not automatically duplicates.
- [ ] Start with conservative exact-text grouping. Use existing embeddings and
  text overlap only to nominate near-duplicate candidates. If needed, ask a
  separate offline reviewer to classify ambiguous pairs as equivalent,
  complementary, different variant or insufficient evidence, using actual
  passages and linked context. Similarity alone does not justify merging.
- [ ] Group confirmed equivalents in search results while retaining every source
  and citation. Select a representative appropriate to the request and refill
  the configured result count. Avoid a blanket one-result-per-book rule. Test
  MMR separately only if repetition remains; a larger candidate pool needs no
  user-facing continuation cache.
- [ ] Measure false merges first, repeated result positions second, answer
  coverage third, and reviewer/latency cost. Bind accepted pair decisions to
  source versions and text hashes and evaluate on held-out pairs.

The [deduplication research note](bench/rag/reports/2026-09-21-knowledge-duplicate-strategy.md)
contains source links and the proposed sequence. This is separate from Qwen's
book-artifact review. Incomplete extraction still needs Sol source recovery
or an excerpt-level limitation; deduplication cannot repair it.
