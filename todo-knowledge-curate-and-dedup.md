# Deferred knowledge retrieval and curate work

Application promotion completed on 2026-09-22: material-backed excerpt retention,
ledger ID/body updates, the consolidated curate prompt and a real 160-call cap.
The [promotion report](bench/rag/reports/2026-09-22-curate-application-promotion.md)
records live follow-up reuse, ledger correction and clarification checks. The
separate compact twenty-preview experiment and broader output-quality work
remain deferred.

Next knowledge experiment: compare five current search hits with 20 compact
previews on unseen requests, holding the promoted prompt, ledger, retention and
conditional capture policy fixed. Use the actual Tencent agent loop and assess
source support, completion and full-turn cost before changing the application.

The [workspace terminal-response test](bench/rag/reports/2026-09-22-workspace-terminal-agentic.md)
also completed: explicit final-answer steering recovered all three author-lookup
attempts that reached the tools-off response. Before promotion, force both
supported and unsupported/scoped-missing cases to that boundary on Tencent and
Ollama. Existing negative controls finished before the instruction was used.
Keep workspace ranking, five-hit search and catalog unchanged meanwhile.

Status: initial agent-loop diagnostics are complete; the remaining changes below
are deferred while source building continues. These items are not publication
gates and do not expand Qwen's current assignment.

Retrieval follow-up on 2026-09-21: compare workspace and knowledge retrieval
separately through the actual Ollama GLM 5.3 Flash loops. Judge completed,
source-supported answers/materials and the cost of extra searches and reads.
Retrieval-only scores diagnose failures; improving those scores is not a gate
before testing the loop. Reranker tests and global deduplication stay deferred.

The [workspace experiment](bench/rag/reports/2026-09-21-workspace-agentic-retrieval.md)
and [library experiment](bench/rag/reports/2026-09-21-knowledge-agentic-breadth.md)
are complete: 34 chat turns and 16 curate turns. Keep current retrieval defaults.
Workspace's identifier lookup/document-opening follow-ups are now complete. Library's
initial recommendation targeted bounded finishing and claim verification;
the follow-up below revises that priority. Increasing library k improves
completion here, but all saved notes miss the current source-page checks; the
larger-k repeats also expose a dataset-label error and swapped table cells.

Follow-up from the developer: reconsider mandatory runtime page capture because
Sol already checks sources during building. The
[revised experiment proposal](bench/rag/reports/2026-09-21-knowledge-agentic-breadth.md#follow-up-trust-reviewed-sources-and-preview-more-results)
prioritizes trusting reviewed library text and comparing five current results
against 20 compact summary/scope previews with selective full reads. Evaluate
generated claims against the text actually read; reserve page capture for
unresolved visual evidence. The promoted curate prompt now uses conditional
capture for apparent corruption; the compact twenty-preview search remains
experimental. The earlier zero-complete-capture score
is prompt compliance, not a finding that every saved note is incorrect.

The developer's combined first test is now complete:
[compact search, no capture and prompt-steered finishing](bench/rag/reports/2026-09-21-knowledge-compact-finish.md).
Twenty turns saved eight notes versus seven, reduced input tokens by 11.1%, and
reduced refused writes from seven to one. All 20 previews fit without a larger
tool limit. Athens still gains unsupported details in both arms. The separate
[workspace opening test](bench/rag/reports/2026-09-21-workspace-opening-agentic.md)
also completed 20 turns without a final-answer improvement. Both expose a
terminal-call issue: Ollama returns a tool call after tools have been removed.
Current application retrieval defaults remain unchanged.

## Curate mode agent loop

- [x] Test the combined compact search/no-capture/bounded-finish prompt package
  in actual loops, preserving the existing ledger and stall mechanics. Record
  source fidelity and full-turn cost separately from saved-note counts.
- [ ] Validate 20 compact previews against five current hits on unseen requests,
  holding the other promoted curate mechanisms fixed. Keep discovery summaries
  separate from full evidence reads; missing reviewed scope remains unknown.
- [ ] Exercise longer follow-ups and material edits through real in-turn
  compaction. Offline checks cover evidence invalidation and the 160-call cap;
  the live promotion cases reused retained text but did not reach either bound.
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
- [ ] Test trusting Sol-reviewed library text while checking generated
  numerical/formula/table claims against the evidence read. Use existing review
  records and source versions to distinguish completed review from unresolved
  content. Keep capture for missing visual details, unresolved extraction or
  contradictions. If capture is needed, an unrelated image or one page covering
  only part of a note does not verify the whole output. Realtime generation uses
  the user's chosen model; Qwen does no page review.
- [ ] Address useful research ending without a material or a clear explanation.
  Deliverable-only todos and early writing were tested in the compact prompt;
  one of two two-dataset attempts now finishes. A terminal call already exists,
  and all three remaining empty attempts return an unexecutable material call
  during that tools-off phase. Test explicit final-answer steering and provider
  contract handling on Ollama and Tencent, including insufficient-evidence
  controls. Keep gaps visible instead of forcing a fabricated note. Recheck the
  current published versions before repairing context links whose target lacks the promised facts,
  such as business-statistics excerpt 261 pointing to 262 for a missing equation.

Use separate unseen questions after tuning. Record material completion,
evidence support, retrieval fit and latency/token cost. See
[scope implementation results](bench/rag/reports/2026-09-21-knowledge-scope-implementation.md)
and the [retrieval workflow](openwiki/agentic-retrieval.md).

## Duplicate examples in knowledge search

Lower priority until crowded results cause a demonstrated final-material
failure that the loop does not recover from. Similar topic or difficulty does
not make two passages equivalent. Keep the grouping proposals below conditional
on an end-to-end benefit; do not start a broad Qwen deduplication pass.

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
contains source links and the proposed sequence; live counts (exact cross-book
text is 1.7% of chunks, mostly forks; vector nearest-neighbour bands for the
statistics pairs) and a staged workflow proposal are in
[retrieval improvement directions](bench/rag/reports/2026-09-21-retrieval-improvement-directions.md).
This is separate from Qwen's
book-artifact review. Incomplete extraction still needs Sol source recovery
or an excerpt-level limitation; deduplication cannot repair it.
