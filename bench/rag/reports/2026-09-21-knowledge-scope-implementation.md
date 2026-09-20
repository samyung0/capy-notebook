# Knowledge retrieval scope and Sol review workflow

This follows the [agent experiment](2026-09-20-knowledge-scope-agent.md).
The developer approved teaching-role corrections, short source-backed excerpt
descriptions and applicability notes, links for split source context, and compact
search results. Prerequisites and cached search continuation remain outside the
production implementation. Workspace retrieval keeps its existing mechanism.

## Changes

Each reviewed excerpt now carries `retrieval.summary`, `retrieval.scope` and
`retrieval.context_excerpt_ids`. These fields supplement its full reviewed notes.
The summary describes actual teaching content. Scope distinguishes necessary
conditions from incidental examples, including software, method, profession,
population, jurisdiction and period. It does not assign a fixed generality score
or inherit every specialization in the book title.

Both lexical and vector indexing include the reviewed summary and scope. Search
still returns five excerpts from the existing 40-candidate retrieval setting.
Search and browse cards show the short annotations; `read_knowledge` includes
the full notes and original passage. Missing annotations explicitly mean scope
has not been reviewed. Source-context links are conditional when only part of
an excerpt needs them. No new model call or search cache was added.
Search does not hard-filter every passage narrower than the request. Scope is
included in matching and exposed for the agent's source-selection judgment;
the annotations do not guarantee that every returned hit is equally general.

`non_teaching` is a successful classification for objectives alone, title pages,
bibliographies and similar passages. Search and coverage counts exclude it and
use the same evidence, confidence and searchable-chunk conditions. Identical
hit text within a book is collapsed conservatively; cross-book semantic
deduplication remains outside this change. Coverage counts use grouped queries;
the live catalog took about 1.7 seconds after replacing an initial correlated
query that took about 38 seconds.

The curate prompt permits direct search and asks the agent to preserve request
constraints, distinguish actual exercises from adaptations, keep an example's
givens and solution together, and state source limits. The ledger shows the
responses remaining before the existing stall guard. Its thresholds are
unchanged.

The short description belongs to the excerpt because applicability can change
within a book: a conceptual passage in an R textbook need not require R. No
separate whole-book summary stage was added. The original passages and full
reviewed notes remain available for deeper reading and topic generation.

## Sol trial and targeted backfill

The initial fresh Sol medium trial reviewed 16 excerpts from four books and
inspected 27 physical PDF pages. Six fresh Sol medium assignments then reviewed
96 excerpts across 13 books, including necessary context found during the trial.
They recorded 156 distinct book/page inspections across those assignments.
Trial and backfill inspections overlap and must not be added as unique pages.

Two further Sol medium assignments reviewed five Chinese contract-law excerpts
and the two excerpts containing an Eswatini Bayesian exercise and its answer.
The final backfill covers **103 excerpts across 14 books**, with 174 distinct
book/page inspections across the backfill assignments. It changes role
assignments on 62 excerpts and topic assignments on 34. Five excerpts are
non-teaching. Of the full synopses, 102 remain byte-for-byte unchanged; one was
corrected against the source's own surrounding explanation. Fifty-nine excerpts
have context links, with 93 links in total. No canonical source text was reparsed
or rewritten for this backfill.

The parent corrected two Sol decisions after checking the rendered pages: a
pure bibliography labeled `reference` and a chapter roadmap labeled
`introduction`. The review contract now distinguishes substantive lookup
material from a bibliography and teaching content from a roadmap. Sol was useful
for this bounded work, but these results do not establish error-free whole-book
classification.

Examples include separate simple- and multiple-regression output, conceptual
statistics without an R dependency, a real umbrella reasoning task versus its
worked Bayesian explanation, U.S. contract-law scope, attributed philosophical
positions, and classical coding passages that do not teach quantum surface codes.
Links on the long probability exercise excerpt apply to its Diet and Health
questions, not to the independent Bayes question on the same excerpt.

The Chinese follow-up found the source's 2009 copyright date and marks its
present-tense legal claims as source-period claims. The Bayesian follow-up
restores the exercise's Eswatini population and source-period context, links the
question and answer, and classifies the answer key as a worked example rather
than a learner exercise. These are source-grounding corrections, not an
independent fact-check of historical, legal or medical claims.

The importer validates source and input hashes, exact excerpt IDs, metadata,
topic IDs, verbatim evidence and page-inspection records. It saves an immutable
backup before applying changes, refuses erasing existing full notes, and leaves
untouched annotations intact. It creates or updates `reviewed-notes.json` so
indexing can refuse metadata or full notes lost during final topic assignment.
Publishing refuses an index with stale annotation text and versions the
source-context IDs along with the book.

All 103 final annotations were verified against the published library, including
roles, topics, full-note hashes, scope fields and linked excerpt IDs. Fourteen
books received new versions; every preceding version remains retained. The
library has 92 books and 47,717 current excerpts, of which 46,148 satisfy the
retrieval gate at confidence 0.8. Only the 103 targeted excerpts have reviewed
scope metadata.
This is a targeted backfill selected from the earlier failures and search hits,
not a random sample or a whole-library review.

The initial scheduler revision pointed to the revised
[review contract](../../../lab/knowledge/review.md), with Sol source review,
full reviewed notes passed to GLM for topic proposals, and final Sol topic
assignment retaining retrieval metadata. Its 15-minute schedule and PAUSED
state were preserved. Shared publication and manifest writes remained serialized.

The developer subsequently asked to keep topic reasoning with the same Sol
owner. That handoff has now been removed from the delegated workflow; the
[Sol topic-owner follow-up](2026-09-21-sol-topic-owner.md) records the code,
paused-scheduler update and 58-excerpt trial. The agent evaluations below concern
the application's retrieval/writing loop, which is separate from builder topics.

## Agent validation

The original 17 cases ran through the actual curate loop with GLM 5.3 Flash,
low reasoning and temperature zero, using the cloud model through the local
Ollama endpoint. This was not local-weight inference. The harness used the real
planner, ledger, read/write guards and page captures; materials were saved
locally. Two cases ran concurrently. Each case ran once against the same
92-book version snapshot, verified before and after each turn. Retrieval returned
five excerpts with the existing 40-candidate setting and no continuation cache.

These cases informed the targeted annotations, so this is an in-sample
diagnostic, not a held-out quality estimate. Saved notes were checked against the
passages actually read. A separate Sol medium reviewer checked the first nine
cases; its review is linked below. A completed note is not necessarily a correct
or fully grounded note.

| Measure | Earlier baseline | After the initial 96-excerpt backfill |
| --- | ---: | ---: |
| Cases | 17 | 17 |
| Nonempty notes | 14 | 15 |
| Honest unsupported-topic stop | 1 | 1 |
| Stalled turns | 2 | 1 |
| Median elapsed seconds | 36.56 | 44.52 |
| Median reported model input tokens | 45,559 | 54,580 |
| Median model calls | 6 | 6 |
| Total reported model input tokens | 797,503 | 888,161 |
| Successful page captures | 0 | 5, across 4 turns |
| Turns with a refused write | 9 | 14 |
| Truncated tool results | 1 | 0 |

Median input tokens increased by about 20%, and total input tokens increased by
about 11%. Different reading, write-repair and capture paths, library changes and
service latency prevent a clean causal comparison. Compact cards did not
establish an end-to-end token saving in this run. The extra completed note on
Athens is also not a quality improvement: it contains unsupported details.

| Request | Review of the original post-change run |
| --- | --- |
| General statistics overview | Conceptual content fits; no software workflow substituted. |
| General regression | Appropriate one-predictor example, but adds coefficient formulas absent from its read passages. |
| Regression by hand | Coherent Elmhurst calculation; rounding explanation could be clearer. |
| Regression in R | Correct R workflow. Multiple-model results are labeled, but the simple walkthrough's R-squared is ambiguous and an exact p-value is unsupported. |
| Independent t-test | Correct independent groups and coherent pooled-variance example. |
| Paired t-test | Matched observations and consistent difference-score example. |
| t-test in jamovi | Correct software and test variant; learning-outcomes interpretation is too broad. |
| Mean versus median | General explanation and coherent numerical example. |
| General leadership | School-specific recommendations generalized in the body; school scope disclosed only at the end. |
| School leadership | Requested setting fits; proposed managerial split attributed to its author. |
| General contracts | U.S. scope explicit in the opening and closing; legal correctness not independently audited. |
| Chinese contract history | Relevant chronology, but 2009 source-present claims lack a clear period limit. |
| General democracy | General definition and varieties fit. |
| Athenian democracy | Assembly, juries and citizenship exclusions are absent from the read political-theory passages. |
| Bayesian exercises | Actual exercise plus a reconstruction from an answer key; original population context is lost and additions are not clearly labeled. |
| Quantum surface codes | Honest coverage gap; classical coding is not substituted. |
| Two distinct regression examples | Finds two datasets and captures two pages, then stalls without a note or final explanation. |

Page-capture compliance remains weak. Five successful captures do not mean that
every source-specific formula or numerical claim was visually verified. Many
notes used such content without any capture; even turns that captured a page
could use other unverified passages. The read-before-write guard worked, but
frequently required a refused write before the agent read all claimed sources.

### Six targeted follow-ups

After publishing the Chinese and Bayesian follow-ups, one prompt instruction was
added: treat missing requested details as a coverage gap even when related
concepts are covered, state the supported scope in the body, and never fill gaps
from general knowledge. Six cases then ran once against the final 103-annotation
snapshot. Their metrics and outcomes are reported separately; they do not
replace failures or improve the counts in the original 17-case run.

| Request | Follow-up result |
| --- | --- |
| Regression in R | Clearly separates the two-predictor source summary from the simple model. Still makes overbroad R-squared claims and asserts simple-model significance without reading its summary; no capture. |
| General leadership | Opening and body now bound the note to school leadership and its source period. Still turns sustained effort into an unsupported guarantee of effectiveness; numerical association not captured. |
| Chinese contract history | Explicit 2009 perspective and linked Chinese context. This fixes the observed period-scope problem, without independently certifying legal or historical accuracy. |
| Athenian democracy | Still unsupported. A scope caveat acknowledges missing institutional history while the body supplies Athenian details absent from the reads. |
| Bayesian exercises | Uses two actual source exercises and labels added hints. Chooses a different book, so this does not demonstrate use of the new AHSS links. Supplies a formula despite its corrupted extraction and no capture; leaves a research todo open. |
| Two distinct regression examples | Still stalls after three reads and one capture, leaving no note or final explanation. Also creates a research todo instead of only material todos. |

Five of these six runs saved notes; one stalled. Median elapsed time was 41.48
seconds and median reported input was 71,888 tokens. There was one successful
capture, in the stalled run. The Chinese result and clearer leadership scope show
that the new information can help; the remaining cases show that annotations and
prompt instructions alone do not ensure grounded output.

### High versus low reasoning

At the developer's request, the same six follow-up cases were run with high
reasoning. The harness now accepts `--thinking low|high` (default low) and forwards
that value through the existing `reasoning_effort` request field, which is
[supported by Ollama's OpenAI-compatible endpoint](https://docs.ollama.com/api/openai-compatibility).
Every comparison uses the exact same system prompt, library version snapshot,
limits and search configuration as its low counterpart. Production model
configuration was not changed.

The first Athens and distinct-example requests failed with provider internal
errors before producing a response. Each was retried once and both failures
remain saved. The comparison below uses the first attempt with an actual agent
response for each case, including stalls. No semantic failure was retried.
Initial runs used two concurrent turns; the two retries ran sequentially, with
the first overlapping the last initial case. This is one paired sample per
selected case, not a general model ranking.

| Measure, six matched cases | Low | High |
| --- | ---: | ---: |
| Notes saved | 5 | 5 |
| Stalled turns | 1 | 1 |
| Median elapsed seconds | 41.5 | 70.7 |
| Median reported model input tokens | 71,888 | 84,700 |
| Total reported input tokens | 403,485 | 519,437 |
| Total reported output tokens | 11,286 | 21,255 |
| Median model calls | 7 | 7.5 |
| Successful captures | 1, in the stalled turn | 2, in one completed turn |
| Turns with a refused write | 3 | 5 |
| Provider failures before response | 0 | 2, both retried once |

High's median time increased by about 71%, median input by 18%, and total input
by 29%. Its output tokens increased by 88%. Including the failed first attempts
raises high's median per-case elapsed time to 73.7 seconds. The endpoint reported
zero separate reasoning tokens in both modes; these reported token counts do
not establish complete billed cost. High also reported 13,440 cached-read tokens.

| Request | What high changed |
| --- | --- |
| Regression in R | Clearly labels the simple fit versus the two-predictor summary, but copies the whole numerical summary without capture and calls a nonsignificant coefficient "no effect." Longer, not a clean grounding improvement. |
| General leadership | Adds a sourced definition and five-practice labels. The explanations of those practices are absent from the read passage, and school recommendations are again generalized in the body with the qualification at the end. |
| Chinese contract history | Keeps the 2009 qualification and labels comparative history separately. Longer than low and leaves a research todo open; no observed scope advantage over low. |
| Athenian democracy | Seven searches and eight reads, one unread-source write refusal, then a stall. Saves no note and ends with "Now writing the study note" rather than a clear coverage-gap response. |
| Bayesian exercises | Uses coherent values for a real disease-test exercise and the source-posed umbrella reasoning problem, retaining its Adelaide example context. Still no captures, and leaves a research todo open. |
| Two distinct regression examples | Completes a useful exam-score/Elmhurst note where low stalled. Captures the exam-score pages only; Elmhurst is not visually verified, despite the final reply claiming the fitted numbers were verified. |

High helped the distinct-example case, but did not consistently improve grounding
or scope matching. It moved the stall to Athens and still ignored required page
verification. These results do not justify changing the default reasoning level
as a substitute for the remaining retrieval and generation work. The new CLI
selection passed the existing harness check and Python lint/format checks; saved
run configs verify high effort and exact prompt/snapshot parity with low.

## Verification and remaining gaps

Focused checks passed for library eligibility and hydration, tag validation,
compact tool results, source-review import, full-note retention, topic-context
forwarding and curate-loop behavior. The final importer checks passed after
adding the guards against lost full notes. Python formatting and linting passed,
the library loader's self-check passed, and its SQL fixture matches the schema.

The four approved workflow changes are implemented. The shared library's new
versions and annotations are published; application code is local and has not
been deployed by this task. The scheduler remains paused.

The next work should address these observed gaps:

1. **Existing coverage:** only 103 of 47,717 current excerpts have reviewed scope.
   New Sol work follows the contract; further backfills should target real search
   failures and frequently used passages. Whole-book summaries would not resolve
   differing applicability among a book's passages.
2. **Writing from partial coverage:** the agent can acknowledge a gap and still
   fill it from memory, or turn a qualified source claim into an absolute one.
   No semantic output validator was added. This needs separate generation and
   claim-grounding work, with held-out cases.
3. **Source verification:** page-capture instructions are not reliably followed,
   and damaged formula extraction can be silently reconstructed. Source recovery
   and output verification remain necessary; this patch adds no hard capture gate.
4. **Completion behavior:** the existing stall guard can end legitimate reading
   and capture work with a blank answer. GLM also creates research todos that a
   material-only ledger cannot complete. The remaining-budget display does not
   solve either behavior; no threshold was changed.
5. **Retrieval beyond exact duplicates:** cross-book near-duplicates, split tables
   and source extraction defects are not solved by compact scope metadata.

A closing code review also noted the pre-existing mismatch between the topic
stage's 96-topic limit and the ordinary `prepare-tags` path's 64-topic limit.
That path is outside the delegated Sol assignment workflow and was not changed.
Prerequisites, cached continuation and a new book-summary generation stage remain
outside this implementation.

## Evidence

- [Reviewed metadata and provenance](2026-09-21-knowledge-scope-implementation/enrichment-receipt.json)
- [Original 17-case metrics and verdicts](2026-09-21-knowledge-scope-implementation/metrics.json)
- [Six follow-up metrics and verdicts](2026-09-21-knowledge-scope-implementation/followup/metrics.json)
- [Matched high-reasoning metrics, failures and verdicts](2026-09-21-knowledge-scope-implementation/high/metrics.json)
- [Independent Sol review of the first nine outputs](2026-09-21-knowledge-scope-implementation/sol-output-review.md)
- [Requests and review criteria](../fixtures/knowledge-scope-cases.json)
- [Agent driver](../scripts/knowledge_scope_agent_eval.py)
- [Importer](../../../lab/knowledge/enrich.py)

Full review artifacts, page images, backups and import receipts remain under
the ignored `data/knowledge-base/retrieval-enrichment-2026-09-21/` directory.
The committed receipt includes the reviewed scope fields, changed assignments,
source hashes, inspected pages and full-note hashes. It is not a copy of the
entire source corpus.
