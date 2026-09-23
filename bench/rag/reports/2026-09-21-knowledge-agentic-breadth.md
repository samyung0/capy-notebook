# Knowledge retrieval through the curate loop

This compares five versus ten returned knowledge excerpts through the actual
curate loop, using Ollama GLM 5.3 Flash. It tests whether broader first results
improve finished study notes after the agent can search again, read complete
excerpts and view source pages. It does not test rerankers or global deduplication.

All 16 turns are complete: six main pairs and two prespecified repeated pairs.
Ten results improve material completion, but neither arm completes the required
source-page verification. Keep the current five-result default while testing
the loop's finish and verification behavior. The observed completion gain is
worth following up; it does not establish that broader retrieval improves
grounded output.

## Follow-up: trust reviewed sources and preview more results

The developer questioned the blanket capture requirement after these runs:
Sol already inspects source pages during knowledge building, and repeating that
work for every generated note is costly. This changes the recommended next
experiment below, not the recorded run outcomes.

The zero-complete-verification score measures compliance with the existing
curate prompt. It does not establish that the notes are factually wrong or that
Sol's corrected text is unreliable. These runs did not compare mandatory capture
with trusting reviewed content, so they cannot establish that mandatory capture
is necessary. The two observed repeat errors concern how the agent used text
it had already read; both can be detected against that text without reopening
the PDF.

Prefer trusting published, source-reviewed library content and using capture
for unresolved extraction, conflicting evidence, or a visual detail not preserved
in the reviewed text. Keep generated-claim fidelity as the quality measure.
Sol's contract already records inspected pages and unresolved regions, but those
records are not exposed in the retrieval response. The stored
`evidence_verified` tag flag means a tag's quoted evidence occurs in the source;
it is not a whole-excerpt visual-review certificate. Reuse the existing review
records and source-version binding if runtime needs to distinguish old or
partially reviewed content. Missing scope metadata is a separate issue from
missing visual review.

The present tools provide:

| Step | Information sent to the agent |
| --- | --- |
| Search | Excerpt ID, book, section, pages, roles, topics, figure IDs, short reviewed summary, scope, necessary context IDs, and the complete matched chunk text. |
| Browse topic | Counts and up to 20 excerpt headers with short reviewed summary/scope, without chunk bodies. |
| Read excerpt | The same source metadata, full reviewed synopsis on the initial page, and up to 12 source chunks with continuation. |

Test up to **20 distinct excerpt previews**, letting the agent read only the
ones it chooses. This uses the existing two-tool division: `search_knowledge`
returns compact discovery information and `read_knowledge` returns full notes
and source chunks. Search still matches the indexed source text and metadata;
returning a metadata preview does not require restricting retrieval to metadata
alone. The saving is in model context and selection, not a demonstrated reduction
in query-embedding or database time. Reuse the existing short summary and scope rather than the
potentially long full synopsis. Include the example/dataset and material limits
already present in scope. Keep the existing read-before-write guard and tool
text ceiling. Fold chunk hits into excerpts before counting previews; a raw
40-chunk pool does not guarantee 20 distinct excerpts. Missing compact metadata
needs an explicit bounded preview choice, not an invented summary or a claim
that the passage is general. No new reranker, summary-generation call or cached
search continuation is needed.

An offline size probe over the six saved primary k=10 first searches retained
the same metadata for the 40 entries with reviewed compact descriptions. Removing
their hit text reduced the repository's estimated token count from 19,109 to
7,506, about 60.7%. This excludes 20 entries lacking compact metadata, counts
repeated entries across queries, and measures neither actual GLM billing nor
20-result agent behavior. Raw measurements are in `compact-preview-sizing.json`
beside the original run receipts.

The next loop comparison should use a common policy of trusting reviewed library
text, then compare current five-result search against 20 compact previews and
selective full reads. Judge finished notes, source fidelity, distinct requested
examples and full-turn cost. Keep capture available for genuine visual gaps.
Test the bounded finish opportunity afterward if useful research still stalls.
The earlier strict-capture runs remain a reference, not a causal control for a
new policy and a changing corpus. No runtime policy has been changed here.

## First-pass outcomes

| Requested note | k=5 | k=10 | Review |
| --- | --- | --- | --- |
| Two distinct regression datasets | Stalled, no note | Note saved | Saved note uses exam scores and Elmhurst aid, genuinely different datasets. Only the exam source page was captured. |
| Regression by hand | Stalled, no note | Note saved | Correct hand-followable Elmhurst calculation; the saved run made no capture. |
| Paired-samples t-test | Note saved | Note saved | Both use paired differences and the Chico data, not independent groups. Neither captured the numerical source. |
| Regression in R with `lm()` | Note saved | Note saved | Both use the requested R workflow and one-predictor fitted coefficients. Neither captured the numerical source. |
| Mean versus median | Note saved | Note saved | Both correctly compute the source's income-outlier example. Neither captured its source page. |
| Quantum surface codes | Coverage gap, no note | Coverage gap, no note | Both distinguish classical coding examples from quantum error correction and decline to invent a lesson. |

Completion is 3/5 versus 5/5 on the five supported requests. This is not a
verified-quality score. The current prompt requires page checks before using
source-specific numerical results, formulas and table cells. All eight saved
notes miss at least part of that requirement. Seven make no page capture; the
two-example k=10 note captures the exam formula but not the Elmhurst example.
The captured exam page was visually checked during this review and supports
the reported line, its domain and slope interpretation.

All eight notes use the requested core concept and method. This manual review
does not certify every incidental claim or numerical detail against the PDF.
Book/excerpt provenance alone also does not certify them. The quantum replies
correctly avoid a fabricated note, but their claim of a thorough corpus-wide
search is stronger than the few searches they actually performed.

| Full-turn measurement, six requests per arm | k=5 | k=10 |
| --- | ---: | ---: |
| Saved notes / supported requests | 3/5 | 5/5 |
| Saved notes with complete required page verification | 0/3 | 0/5 |
| Correct coverage-gap response | 1/1 | 1/1 |
| Stalls with no note and empty final prose | 2 | 0 |
| Input tokens, total / median | 262,798 / 46,436.5 | 385,409 / 65,884 |
| Output tokens, total | 9,686 | 12,390 |
| Query embedding tokens | 284 | 288 |
| Model calls | 31 | 34 |
| Search / full-excerpt read calls | 8 / 16 | 9 / 23 |
| Page captures | 4 | 1 |
| Rejected material writes | 3 | 6 |
| Tool outputs truncated | 0 | 0 |
| Wall time, total / median | 304.50 s / 54.41 s | 380.32 s / 64.25 s |

Ten results cost 46.7% more input tokens and 24.9% more measured wall time in
this pass. Some of that buys two additional notes, so it is not all wasted
context. The capture work and failure paths differ too. This small sample and
shared cloud transport do not support a production latency or cost estimate.

## Prespecified repeats

| Repeated request and arm | Result | Searches / reads / captures | Input + output tokens | Wall time |
| --- | --- | --- | ---: | ---: |
| Two datasets, k=10 | Note saved; extra aside misidentifies a dataset | 1 / 4 / 1 | 82,404 | 64.51 s |
| Two datasets, k=5 | Stalled, no note or final explanation | 3 / 1 / 3 | 74,596 | 58.75 s |
| Paired t-test, k=5 | Note saved; correct method and source table | 1 / 4 / 0 | 45,181 | 49.32 s |
| Paired t-test, k=10 | Note saved; correct method but two table cells swapped | 1 / 4 / 0 | 52,983 | 48.89 s |

The k=10 two-dataset note still uses two distinct datasets for its main examples.
An unrequested jamovi aside changes `dani.grump`/`dani.sleep` into baby grumpiness
and hours of sleep. The passage it read does not support that population claim.
The k=10 paired-test note assigns standard deviations 6.406 to test 1 and 6.616
to test 2; the source read explicitly gives test 2 = 6.406 and test 1 = 6.616.
The main paired-difference test remains correct. These errors show why core
method fit and source provenance are insufficient quality measures. They do
not establish that larger k caused the errors.

Across the main run and repeats, k=5 saves 4/7 requested notes and k=10 saves
7/7. Neither arm produces a note with complete required page verification:
0/4 versus 0/7. Nine of the eleven notes make no capture; the two k=10
two-dataset notes capture only the exam source. Both arms correctly decline
the separate quantum request. The three k=5 failures are stalls after useful
research, not a demonstrated absence of relevant material.

For all eight request instances per arm, k=5 uses 379,930 input and 12,331 output
tokens in 412.57 seconds; k=10 uses 516,920 input and 16,266 output tokens in
493.72 seconds. Repeats deliberately overweight the two selected cases, so the
first-pass table remains the main cost comparison.

## What actually limits these runs

The first two-example search already puts Elmhurst passages, a jamovi example
and an exam-score example in the first five. The completed k=10 note uses the
exam-score and Elmhurst examples that k=5 had exposed. Its success is not proof
that unique answer-bearing evidence existed only at positions six through ten.
The shorter search already offered variety; the subsequent reading and writing
choices determined whether a material appeared.

The strongest repeated pattern in the first pass is the ledger budget. Both
stalled k=5 turns perform legitimate reading and two captures without an early
write. They then reach the four-response no-completion guard. In contrast,
every saved note first attempts a write that the read-before-write guard rejects.
Those errors earn additional responses under the existing policy, and the
agent recovers by reading the missing excerpts and writing again.

This is an observed association, not an isolated causal test of the stall
policy. It explains why a returned-hit score or a raw material count would give
an incomplete verdict. An arm can appear to improve completion while spending
more time on invalid writes and skipping required verification.

The repeats preserve that pattern: all eleven saved notes follow a rejected
write, and none of the three stalled turns attempts one. The repeated k=5
two-dataset turn searches three times and captures three regions before
stalling. Its extra research is not converted into a usable outcome.

## Initial next-experiment proposal

The follow-up above revises this ordering after accounting for Sol's source
review. The finish and claim-fidelity cases below remain useful controls;
mandatory recapture is not established as a prerequisite for a good note.

1. **Test a bounded finish opportunity with k=5 held constant.** Compare the
   current loop with one final chance to write from gathered evidence before
   the stall shutdown, with additional searching disabled. Count a note only
   if its claims and required page checks pass; otherwise require an explicit
   partial result or coverage limitation. Include the stalled regression cases
   and controls where evidence really is insufficient. Do not reward an invalid
   early write with a better effective budget than legitimate reading.
2. **Test claim-specific verification separately.** Check generated numbers,
   formulas and table labels against the passages and relevant page regions
   actually read. Include the swapped standard deviations, the unsupported
   baby-grumpiness aside, missing captures, an unrelated screenshot and a
   screenshot covering only one of two examples. A generic “has capture” flag
   would incorrectly certify both two-example notes. Measure supported claims
   wrongly rejected as well as errors missed.
3. **Then test selective expansion from five to ten results.** Apply it only
   when the request still lacks evidence after a normal targeted follow-up.
   Compare verified completed notes and full-turn cost against the repaired
   five-result loop, using new questions. The present ten-result arm is a useful
   candidate, not a justified global default.

Do not start global deduplication, reranking or a chunk-size rebuild from these
results. Repeated Elmhurst excerpts occupy search positions, but both completed
two-example notes find another dataset already exposed by the initial top five.
Source grouping becomes a priority only when repetition demonstrably prevents
a supported result despite normal loop recovery. Similar topic, difficulty or
an underlying dataset is not enough to declare passages interchangeable.

These are proposed runtime experiments. This work changes benchmark scripts
and documentation only; no application defaults or loop policies were changed.

## What is held constant

The [runner](../scripts/knowledge_agentic_breadth.py) reuses the baseline branch
of [the existing curate experiment](../scripts/knowledge_scope_agent_eval.py)
and the playground's local material writer. Both arms use production library
search, metadata rendering, source reads, page capture and material provenance
guards. The model receives the current curate prompt and tool schemas, never
the fixture's scoring criteria.

| Setting | Both arms |
| --- | --- |
| Agent | `glm-5.3-flash:cloud` at the local Ollama compatible endpoint |
| Reasoning / temperature | Low / zero |
| Query embeddings | Existing pinned Qwen3-Embedding-4B through DeepInfra |
| Candidates | 40, before excerpt folding |
| Search policy | Current lexical/vector fusion and within-book exact-hit handling |
| Tool text ceiling | 8,192 estimated tokens, unchanged |
| Loop | Current curate ledger and stall guard, with normal recovery after rejected writes |
| Materials | Saved locally; the application gateway is disabled |

Only the returned excerpt count changes from 5 to 10. This is a diagnostic
for retrieval breadth, not a dynamic-k policy. There is no new ranking model,
diversity algorithm, chunking policy, prompt hint or continuation cache. It does
not change the application's shared search configuration.

The library contains 92 current books and 47,717 current excerpts. Of these,
1,826 have reviewed retrieval metadata. Missing scope stays explicitly unknown.
These are all current excerpt rows, not a count of eligible search results.
The earlier report's 540 reviewed excerpts is no longer a current baseline.

Book versions/content IDs and per-book hashes of current excerpt records are
recorded before and after each turn. Runtime/input hashes are recorded too.
Pairwise stability is checked separately from within-turn stability because
the library builder is running on another machine. All 32 before/after receipts
are identical across this suite. Both arms have identical prompts and model/tool
configuration apart from the intended k and per-case question. Every candidate
request uses budget 40; no tool output is truncated and no reranker is called.

## Cases and scoring

Six requests come unchanged from the existing
[scope fixture](../fixtures/knowledge-scope-cases.json): two distinct regression
datasets, regression by hand, paired-samples t-test, regression with R `lm()`,
mean versus median, and quantum surface codes. The last is a coverage-gap
control. Both arms may reformulate queries, choose their own topic/role filters,
read linked context and capture source pages.

Pair order alternates. A second pair for distinct regression examples and
paired t-tests was scheduled before any run. This gives eight request instances
per arm: seven intended material requests and one coverage-gap control. The
sample is a targeted diagnostic, biased toward the statistics crowding concern;
it is not a held-out estimate of quality across the whole library.

Primary review checks whether a note was saved, whether it satisfies the
requested method/software/scope, whether its important claims are supported,
and whether two requested examples use distinct datasets. An honest coverage
gap is a correct outcome for unsupported requests. A stalled run with no note
is a completion failure, even if its retrieved excerpts were relevant.

Searches, reads, page captures, rejected writes, truncation, reported tokens and
elapsed time explain those outcomes. Matching topic tags, increasing book count
or reducing the number of repeated hits is not sufficient evidence of a better
answer. References to excerpts that were actually read and immutable book
provenance are checked separately from semantic source support.

## Source access and earlier preflight

The developer authorized read-only access to the shared library and source
bucket. Database sessions use `capy_library_reader` and explicitly enable
`default_transaction_read_only`; every run checks both. The B2 CLI has an
account authorized for `capy-notebook-knowledge-base`. `--b2-account` reads that
credential into process memory and passes it to the existing source downloader.
The benchmark only reads objects. It never publishes, deletes, updates metadata
or alters access controls.

The first preflight looked only in application environment files and missed
the existing B2 CLI authorization. Its nine completed text-only turns remain
under `local/2026-09-21-knowledge-agentic-breadth/`, with an explicit preflight
receipt. They are excluded from the primary comparison. Both arms restarted
with source capture offered. The OpenIntro source-object size was verified
against the library manifest, and actual source downloads/captures succeeded.

## Reproduction and receipts

```sh
.venv/bin/python bench/rag/scripts/knowledge_agentic_breadth.py --check
.venv/bin/python bench/rag/scripts/knowledge_agentic_breadth.py \
  --suite --b2-account \
  --output bench/rag/reports/local/2026-09-21-knowledge-agentic-breadth-captures
```

Use a fresh output directory for another run. The script refuses to replace
an existing suite protocol or a completed turn. Source-PDF credentials are
required before a live suite begins. The ingest-host SSH key supplies the
read-only library and existing embedding credentials; secrets stay in memory.

The ignored output contains `protocol.json`, the executed runner text and
`k5|k10/repeat-1|repeat-2/<case>/baseline/`. The final `baseline` component comes
from the reused runner and means its production tool path. Actual k is recorded
by the outer directory, run configuration and `comparison.json`.

Each turn keeps exact prompts, provider/tool traces, read text, materials,
captures, all 40-candidate rows, selected excerpts, and before/after receipts.
No source or result is silently relabeled as an irrelevant duplicate. The
retained `rerank_calls` field is empty in both arms.

`summary.json` contains the 16 run hashes, measurements and the final stability
audit; `assessment.json` records the manual judgments and limitations. Every
saved material's excerpt IDs were read successfully and its provenance matches
the frozen book versions. That mechanical check does not certify semantic
support. Review was not blinded or independently double-rated.
A separate Astra max peer review recomputed the totals and run hashes, confirmed
the stable receipts and sampled the traces; it found no material issue with the
reported conclusions or the runner's read-only/local-write boundaries.

The schedule self-check, reader-role refusal check and direct Ruff lint/format
checks passed. The root Python formatting command was blocked by a pre-existing
unapproved `@openuidev/lang-core` build script; its approval state was not changed.

The workspace experiment is separate and documented in
[its own report](2026-09-21-workspace-agentic-retrieval.md). Further work remains
in [the curate and dedup plan](../../../todo-knowledge-curate-and-dedup.md).
