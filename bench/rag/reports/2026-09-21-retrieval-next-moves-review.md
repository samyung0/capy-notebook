# Retrieval review and next experiments

Review of [the preliminary directions](2026-09-21-retrieval-improvement-directions.md),
their saved rows and agent traces, current retrieval code, and
[the deferred work](../../../todo-knowledge-curate-and-dedup.md).

The initial review proposed a knowledge-result crowding experiment and a repaired
workspace baseline followed by abstention testing. Subsequent actual loop tests
favor keeping current workspace retrieval and testing terminal-answer behavior.
The requested compact knowledge-search package is promising on cost and saved
notes, but still needs scope/fidelity work. A permanent deduplication pipeline
remains premature.
Keep the two tracks independently tunable. Reranker testing is deferred at the
developer's request.

The initial review made no application, index, library, builder or deployment
changes. It replayed local results and sent two authorized text-only Qwen requests.
There were no live database reads, embedding requests or new agent-loop runs.
Any subsequent agent-loop test should use the configured Ollama GLM 5.3 Flash.

Subsequent direction from the developer: test changes in the real agent loops
from the start, since extra searches and reads can compensate for poor first
results. An Astra max agent completed the workspace follow-up; the primary agent
completed the library follow-up. See the [workspace loop report](2026-09-21-workspace-agentic-retrieval.md)
(34 turns) and [library breadth report](2026-09-21-knowledge-agentic-breadth.md)
(16 turns). Workspace abstention lost an answer the current loop recovered.
Library k=10 completed more notes, but all saved notes missed required page
verification and useful k=5 research stalled. The remainder records the earlier
review; its proposed sequence is superseded by those completed experiments.

The next requested comparisons are also complete:

- [Workspace catalog/opening recovery](2026-09-21-workspace-opening-agentic.md),
  20 fresh turns: no improvement in supported answers; the author lookup still
  succeeds in zero of three final answers per arm. A correct source can be found
  and read before the finalization step fails. Keep the existing catalog and k=5.
- [Compact discovery, no capture, prompt-steered finishing](2026-09-21-knowledge-compact-finish.md),
  20 turns: eight saved notes versus seven, 11.1% fewer reported input tokens,
  and one refused write versus seven. All compact searches expose 20 previews
  within the current tool limit. Both arms still add unsupported Athens details;
  neither completion counts nor missing page captures establish factual quality.

Both experiments find the same Ollama behavior at termination: the reserved
final request offers no tools, but the model returns another tool call. Test
explicit terminal-answer steering/provider contract handling before adding more
retrieval machinery. For knowledge, preserve compact discovery and full reads as
an experimental configuration and assess new questions against the passages
actually read. Rechecking every source PDF is not the conclusion of these runs.
The interactive current-curate preset now runs on port 18765 using Tencent,
with read-only database connections and local materials; its setup run is
separate from the Ollama benchmarks.

## What the knowledge problem actually is

Five individually relevant hits can form a poor set when they repeat the same
example. Topic and difficulty are useful relevance criteria. Matching those
criteria does not make passages duplicates. Different datasets, methods,
assumptions, explanations, exercises and solutions can all contribute something
useful to the same lesson.

The reported exact cross-book overlap was 1,187 of 70,165 searchable chunks of
at least 200 characters, about 1.7%, concentrated in textbook forks. That is a
historical chunk count, not the frequency with which learners see repeated
results. It does not explain the near-duplicate statistics examples.

The Elmhurst example makes the distinction concrete. The saved OpenIntro read
uses dollars, gives a worked intercept calculation and includes software output.
The AHSS read uses thousands of dollars and provides formulas and software
output. They share an underlying example, but neither is an interchangeable copy
of the other. Their useful grouping depends on the request:

| Request | Appropriate selection |
| --- | --- |
| Two examples using different datasets | Prefer one Elmhurst variant and another dataset. |
| Derive the Elmhurst line from summary statistics | Preserve the givens and the calculation, even when they occupy separate excerpts. |
| Compare hand calculation with software output | Related passages may be complementary evidence. |
| Learn regression in R | Preserve the R-specific instructions. |

All three earlier two-dataset agent arms already selected distinct datasets.
Crowding therefore has evidence as wasted candidate positions, but its measured
effect on final answer quality is still limited. Measure that effect before
building durable group identities.

## Corrections to the preliminary interpretation

1. **File hits do not establish passage quality.** The recent workspace replay
   reproduces 250/274 file hits at k=5, 250 at k=8 and 251 at k=10. It cannot
   establish how many answers were actually shown. Only 107 legacy chunk-label
   matches survive under the baseline. Finding any chunk from a long PDF can
   score a hit while missing its requested section completely. Wider k is not
   justified by these results, but it has not been ruled out for passage recall.

2. **Some apparent candidate failures need a corpus-membership check.** Fifteen
   of the 22 questions with no expected file in the top 40 target `zh_HK.pdf` or
   `newspaper_scan.pdf`. Neither filename occurs anywhere in the saved 310-query
   candidate inventory, which contains 27 filenames. The original ODL source
   manifest has 29 documents and lists those two sources separately from
   `hongkong-figures.pdf`. This strongly suggests a corpus mismatch; returned
   results alone cannot prove absence from the database. Verify current content
   pointers, ready state, names and source hashes before counting these as
   ranking failures or valid abstentions.

3. **The proposed abstention thresholds are development results.** At distance
   0.6 with the lexical exception, 18 of the 274 labeled positives return
   nothing. Fifteen are the questions above; the other three are `Mayor-Rocher`,
   the Spanish question about Mayor-Rocher and Reviriego, and `fire`. Only one
   previously successful file hit is lost. That does not establish a low
   false-abstention rate over genuinely indexed, answerable questions. The
   negative sets also contain acknowledged answerable questions. There is no
   independent held-out calibration of 0.6, 0.5 or 0.55.

4. **The saved agent counts differ from the report's table.** On its ten nominal
   no-answer questions, the baseline made 10 searches; the abstention arm made
   9, of which 6 returned nothing. The table reports 10 and 7 for that arm.
   No-search questions number four versus five. The token totals do reproduce:
   67,618 versus 35,600. The answerable mitochondria case accounts for 19,466 of
   the 32,018-token difference, about 61%. Removing that case leaves 32,865
   versus 20,313 tokens. Prompts and saved configurations match for all 16 paired
   turns. This is a useful cost diagnostic, with stochastic exploration and no
   demonstrated answer-quality gain, not a stable production saving estimate.

5. **Topic/role matches are weak knowledge relevance labels.** In filtered
   experiments the expected topics and roles were also supplied as SQL
   predicates. Their match rates are largely true by construction. A role tag
   with a verified quotation does not prove a useful exercise exists. Evaluate
   teaching content, requested applicability and distinct example coverage
   against source text, using the agent's actual filter choices separately.

6. **The proposed exact-dedup rule is unsafe.** Containment of every chunk of
   a shorter excerpt in a longer one is not equivalence. It merges an exercise
   with its solution, or a setup with its worked continuation. Lowercasing also
   collapses case-sensitive units such as MPa and mPa; flattening all whitespace
   can erase table structure. Do not describe this as zero false-merge risk.
   A noisy pair judgment also should not automatically become transitive global
   equivalence through union-find. Any future reusable judgment must bind the
   reviewed source, roles, scope and linked context, not just the body-text hash.

The offline audit is retained as
`local/2026-09-21-retrieval-review-dedup/offline-audit.json`, with hashes of the
four input result files. The historical report remains unchanged.

## Workspace retrieval

The current path embeds in the workspace's pinned vector space, runs multilingual
lexical/vector fusion, selects from 40 candidates and returns five passages with
a soft four-per-file cap. The cap refills from overflow. Search already uses
structural chunks; larger context is available through `read_document`.

The first work should be a repaired evaluation over the existing local/lab
corpus. Reuse the 64 [ODL questions](../fixtures/odl-agentic-questions.json), with
58 answerable cases, six unanswerable cases, source identities, page anchors and
required claims. Add the five existing stress questions and 28 full-document
locator controls where applicable. These already provide a better starting point
than inventing a new benchmark framework. They remain previously inspected
diagnostics; reserve additional unseen source families for final validation.

Verify that each source is actually indexed and rebind source evidence to the
current chunks. Separate source absence, extraction loss, candidate miss,
ranking miss and reading/generation failure. Include notes and file filters,
which the recent direct-connection lab replay omits. An abstention lexical check
must use the same allowed scope and note/file eligibility as the search itself.

Then compare the existing top five with the proposed lexical-protected
abstention rule. Measure false abstentions on supported questions, rejection of
hard negatives, complete evidence coverage, tokens and latency. Include negatives
with overlapping terminology, wrong identifiers, missing parts of a question,
and cross-language positives. Choose any threshold on development cases and
freeze it before held-out evaluation. Distance scales belong to a specific
embedding pin and indexed representation; these values are not universal.

An empty low-confidence result should say that this search found no sufficiently
supported passage. It cannot certify that the entire workspace lacks an answer.
Keep query-level abstention separate from answer-level support: a close passage
can address the topic while omitting the requested claim.

Keep k=5 and current chunking meanwhile. Examine k=8 or k=10 only if repaired
labels show useful evidence just below the cutoff. Test token-bounded output,
including metadata and citation headers. The actual tool-output ceiling is
8,192 estimated tokens. Do not expand whole parents automatically or infer that
every larger candidate pool is free from the five historical telemetry rows.

## Knowledge-library retrieval

`library.search` shares the underlying hybrid SQL but has its own tag eligibility
and excerpt folding. It selects one hit chunk per excerpt, removes identical
hit text within one book, and returns five excerpts. It already accepts explicit
`candidates` and `top_k` overrides. Use those for isolated experiments; changing
the shared configuration would also change workspace retrieval.

The next experiment should compare **sets of useful excerpts**:

1. Freeze a library-version snapshot after the concurrent metadata work reaches
   a useful stopping point. Use the 17 scope requests and saved real agent
   searches. Keep unreviewed metadata explicitly unknown. Scope enrichment
   changes the embedding and lexical inputs, so earlier distance thresholds
   need checking against the new snapshot.
2. Measure the current top five for requested teaching roles, applicability,
   distinct datasets/tasks, complementary context and repeated positions.
   Book count alone is not the objective. Review the strongest relevant options
   in the candidate pool so a pool miss is distinguishable from poor selection.
3. Compare current selection with a small, inexpensive diversity selection
   experiment over the same candidates, and then with a wider pool if needed.
   MMR over existing vectors is one candidate, not a selected policy. It needs
   a relevance guard and controls where two similar passages are both necessary.
   Keep five returned excerpts and the same token budget. This proposal involves
   no new model reranker test. No such diversification test ran in this review.
4. Score source-supported coverage and lost complementary evidence before
   celebrating increased diversity. For a two-example request, count distinct
   datasets and tasks; for a derivation, count the required givens and steps.
   Compare the current policy and a bounded candidate through the configured
   Ollama GLM 5.3 Flash loop immediately. Use retrieval diagnostics to explain
   final-material outcomes and compensating tool calls, rather than optimizing
   first-search scores before running the loop.

The preliminary soft cap of three per book slightly improved book diversity
while losing one plain topic match. It is a useful comparison arm, not the
recommended default. It cannot recognize the same example copied across books.
Conversely, it can demote distinct useful examples within one book.

Keep permanent exact/near-duplicate grouping deferred unless repeated-result
exposure remains material after this test. If example-family labels later prove
necessary, they must preserve variants and support the request's selection
criteria. They must not silently become claims of global content equivalence.
The builder and optional Qwen book-review workflow can continue independently.

Scope matching also remains separate from generation failures. Athens claims
unsupported by passages already read, omitted page verification, and useful
research stopped by the material ledger will not be repaired by search diversity.
The existing todo already separates those tasks appropriately.

## Bounded Qwen test completed during this review

Runner: [knowledge_dedup_probe.py](../scripts/knowledge_dedup_probe.py).
Cases: [knowledge-dedup-pairs.json](../fixtures/knowledge-dedup-pairs.json).
Inputs and labels were frozen before two requests to the developer-supplied
Alibaba Beijing live chat endpoint. Model `qwen3.8-flash`, thinking enabled,
temperature zero, strict JSON Schema, no caller output/thinking cap and no
retries. This was a pair-classification test, not an agent or reranker test.

Eight synthetic controls cover copies, paraphrases, containment, case-sensitive
units, rescaled units, software variants, exercise/solution and missing context.
Seven comparisons use complete saved textbook reads; an eighth saved-trace case
repeats the same source as an identity control. Required context absent from the
saved read stays absent, and the prompt tells the reviewer not to invent it.
Expected collapse decisions and example-family labels were not sent to Qwen.

| Request | Input tokens | Output tokens, including thinking | Thinking tokens | HTTP seconds |
| --- | ---: | ---: | ---: | ---: |
| Eight synthetic controls | 1,309 | 8,548 | 6,746 | 139.1 |
| Seven real pairs and one identity control | 16,458 | 11,825 | 9,917 | 181.8 |
| Total | 17,767 | 20,373 | 16,663 | Separate request timings |

All 16 collapse/non-collapse decisions match the frozen expectations: three
equivalent controls and 13 non-equivalent comparisons. The real Elmhurst pair
is a different variant of the same example. The givens/calculation, prior/
likelihood and calculation/interpretation pairs are complementary. The
Elmhurst versus exam-score pair uses different examples.

This does **not** validate automated duplicate acceptance. All eight reviews in
the real-text request fail the required literal-evidence check on at least one
side. Qwen inserted ellipses, joined distant fragments or normalized source
characters despite being asked for exact substrings. Its explanation of the
synthetic rescaling case also overinterprets an unchanged slope; scaling both
axes by the same factor preserves the slope. The binary decisions are useful
diagnostic observations, but the evidence contract is not satisfied.

Example-family judgments match 15 of 16 frozen labels. The mismatch is the
synthetic MPa/mPa pair: the fixture leaves shared-scenario identity unknown and
Qwen says false. These author-reviewed cases are selected controls, not an
independent or representative holdout. No false-merge rate for the library can
be inferred from them.

The test supports distinguishing shared examples from interchangeable excerpts.
It does not support building a permanent deduplication stage now.

Raw requests, responses, receipts, frozen labels, executed source and assessment
are under ignored `local/2026-09-21-retrieval-review-dedup/`. The temporary key
file was removed after the two processes read it. Requests contain no key.

```sh
python3 bench/rag/scripts/knowledge_dedup_probe.py prepare --out /tmp/capy-dedup-new
# Paid send requires explicit --base-url, --key-file and --batch 0 or 1.
python3 bench/rag/scripts/knowledge_dedup_probe.py analyze \
  --out bench/rag/reports/local/2026-09-21-retrieval-review-dedup
```

Preparation and analysis use local files only. The required root `pnpm run
fmt:py` was blocked before Ruff ran by the existing unapproved
`@openuidev/lang-core` build script. Targeted Ruff formatting/checking and offline
probe checks were run separately; no dependency approval was changed.

## Community suggestions in context

The linked [Reddit discussion](https://www.reddit.com/r/Rag/comments/1uvi3bf/whats_one_rag_improvement_that_mattered_far_more/)
is accessible in this review. Its structural-chunking and evaluation suggestions
are already substantially reflected in this repository. Its abstention advice
is a hypothesis to test on Capy's sources, not evidence for a transferable
similarity threshold.

One technical correction to the preliminary comparison:
[ColBERT](https://arxiv.org/abs/2004.12832) can rerank a fixed candidate set as
well as perform end-to-end retrieval, so it is not exclusively a candidate-recall
solution requiring replacement of the current search index.
[DistilBERT](https://arxiv.org/abs/1910.01108) is a smaller pretrained encoder,
not an out-of-the-box deduplicator or NER policy. Neither distinction creates a
reason to test another model now. The existing reranker experiment and its
regressions remain recorded without a new run.
