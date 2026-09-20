# Knowledge-library scope, agent behaviour and cached search pages

Experiment started 2026-09-20 and completed 2026-09-21 JST. This follows the
[retrieval-only audit](2026-09-20-knowledge-search-fit.md).

The existing library can support useful general lessons, including lessons
drawn from software-specific or profession-specific books. Missing book
summaries are not the main demonstrated problem. The failures involve
selecting the right passage, preserving its limits while writing, inaccurate
teaching-role tags, and the agent's exploration budget.

Caching a wider result pool is inexpensive and works. It did not improve
these requests through continuation: the agent used **zero continuations in
17 ordinary paged-arm turns**. An explicit continuation probe successfully
read all four pages, then hit the existing stall guard before writing.

The full-text GLM reranker is not ready to become the default. It found some
better passages but added tokens, missed jurisdiction framing, and did not
prevent unsupported content. Its extra completed note was the weakly
supported Athens case; a write receipt is not a quality score.

## Method

- **51 comparison turns:** 17 requests, each run with baseline search,
  cached pages, and scope-aware reranking. One completed comparison per
  request and arm; this is a diagnostic, not a statistically stable ranking.
- **Model:** `glm-5.3-flash:cloud`, requested through local Ollama's
  OpenAI-compatible endpoint with `reasoning_effort: low` and temperature 0.
  The `:cloud` model is served through Ollama; this was not a local-weight
  inference or GPU benchmark.
- **Agent:** the real curate prompt, planner, ledger, tool contracts,
  read-before-write checks, source capture and provenance helpers. The
  existing playground saved materials locally; no production material writes
  or library changes were made. Each turn had a fresh empty workspace.
- **Data:** all 51 starting snapshots had the same 92 books and versions,
  including the newly published *Learning Statistics with R*. Every available
  ending snapshot matched. One post-run trace save failed, leaving that
  run's starting snapshot and complete agent trace but no ending snapshot.
- **No supplied oracle filters:** the agent chose its searches, topics and
  roles. Fixture review criteria were not sent to it. At most two model
  turns ran concurrently. Requests were self-contained English requests for
  one note, so multi-turn context and other material kinds remain untested.
- **Review:** inspected saved notes, tool calls and their source text for
  request scope and support. This was not a full mathematical, historical or
  legal accuracy review. No prerequisite modelling was added.

| Arm | Retrieval behaviour |
| --- | --- |
| Baseline | Production search: `candidates=40`, five distinct excerpts returned. |
| Paged | `candidates=160`, up to 20 distinct excerpts; return five and retain ordered excerpt ID, hit-chunk ID and score. Same tool accepts `search_id` and `start`. Turn-local cache, 15-minute experimental TTL. |
| Reranked | Same 20-excerpt pool; an additional GLM low call selects up to five using the original request, query, book title, section path, roles, topics, full synopsis and hit text. May select zero. |

The candidate parameter controls the underlying hybrid search; 20 is the
number of distinct excerpts cached, not 20 arbitrary chunks. Increasing the
candidate budget can change the first five results. The paged arm therefore
tests both a wider pool and a continuation capability; any first-page gain
cannot be attributed to continuation.

## Agent outcomes and cost

| Measure, 17 turns per arm | Baseline | Paged | Reranked |
| --- | ---: | ---: | ---: |
| Nonempty notes saved | 14 | 14 | 15 |
| Honest surface-code coverage gaps | 1 | 1 | 1 |
| Stopped by curate stall guard | 2 | 2 | 1 |
| Median turn seconds | 36.56 | 43.78 | 43.23 |
| Median total model input tokens per turn | 45,559 | 51,801 | 63,431 |
| Median model calls, including reranking | 6 | 6 | 7 |
| Search continuation calls | — | 0 | — |
| Successful source-page captures | 0 | 3 | 0 |
| Turns with a refused material write | 9 | 13 | 13 |
| Truncated tool results | 1 | 2 | 0 |

Token figures include repeated context across calls and include the extra
reranker's usage. They are reported tokens, not a price estimate; cached-read
tokens are recorded separately in the raw metrics. Reranking added a median
13,686 input tokens per turn. Its median combined input was 39% above the
baseline. Latencies are descriptive: different agent paths, source downloads,
network conditions and simultaneous runs prevent a clean speed comparison.

The 51 comparison turns consumed 2,890,361 reported model input tokens and
96,408 output tokens, excluding embeddings and the superseded attempts and
capability probe. No dollar cost was inferred.

## Scope and usefulness review

“Fits” below means the note addresses the requested scope. It does not
certify every statement or calculation. An honest gap is appropriate when
the required evidence was not found; a silent stall is not.

| Request | Baseline | Paged | Reranked |
| --- | --- | --- | --- |
| Beginner statistics overview | Fits | Fits | Fits |
| General simple regression with example | Fits | Fits | Fits; small five-point example |
| Regression without software | Fits | Fits | Fits |
| Simple regression in R with `lm()` | Fits | Mixed simple/multiple-regression output | Fits the requested R workflow |
| Independent-samples t-test | Fits | Fits; captured source page | Fits |
| Paired-samples t-test | Fits | Fits | Fits |
| Independent t-test in jamovi | Fits | Fits | Fits |
| Mean versus median | Fits | Fits | Fits |
| General leadership | General principles from education book | Same | Same |
| School leadership | Fits school context | Fits school context | Fits school context |
| General contract formation | U.S. framing explicitly labelled in a heading | Jurisdiction only indirectly signalled | U.S. material without an explicit jurisdiction label |
| Chinese contract-law history | Historical, source-period caveat | Historical; source-period limit less explicit | Historical, source-period caveat |
| General democracy | Stalled after finding useful material | Fits | Stalled after finding useful material |
| Democracy in ancient Athens | Stalled | Stalled | Wrote institutional details not established by the excerpts read |
| Two library-grounded Bayesian exercises | Invented new flu-test exercises | Stalled | One actual library exercise plus an adapted worked example |
| Quantum surface codes | Honest gap | Honest gap | Honest gap |
| Two distinct regression datasets | Two datasets; one requires a jamovi step | Two datasets, including software output | Two distinct hand-followable examples |

### Findings that matter now

1. **A specialized book is not automatically a specialized passage.** Mean
   and median explanations from statistics-with-software books and general
   leadership principles from education books remained useful. Rejecting an
   entire R, jamovi or education book for a general request would remove good
   evidence. Generality is also separate from difficulty and detail.

2. **Method identity must survive both retrieval and writing.** The paged
   R note showed a one-predictor `lm(y ~ x)` call but copied a summary with an
   F-test on two numerator degrees of freedom and 97 residual degrees of
   freedom from the multiple-regression discussion. It removed the second
   coefficient while retaining the multiple-model statistics. A book summary
   would not distinguish these adjacent methods; their excerpt context can.

3. **Jurisdiction and time are applicability conditions.** Reranking still
   produced a general contract-formation note that treated the source's
   common-law/UCC framing as the subject without explicitly naming its U.S.
   scope. The historical China requests were better framed. These observations
   concern source scope, not validation of the legal propositions generated.

4. **A role tag and a verified quotation do not prove the requested role is
   present.** The Bayesian search returned explanatory umbrella passages
   tagged `exercise`; text such as “repeat the exercise” occurs inside a
   worked explanation. The baseline then invented flu-test values and
   described the result as grounded in library exercises. The reranker found
   a real disease-testing exercise in *Online Statistics Education*, showing
   that a useful exercise can sit under probability tags rather than the
   exact Bayesian topic. Hard topic and role filters can exclude useful
   evidence as well as include weakly tagged evidence.

5. **The loop can recognize a clear gap but mishandle partial coverage.**
   All three surface-code turns declined to use classical coding or unrelated
   programming material. Athens was harder: the reranker recorded that core
   institutions were missing, then the writing agent filled gaps. The
   prototype returned selected excerpts but did not forward the reranker's
   `gap` field, so this is also a limitation of that prototype. Selecting
   plausible passages alone does not communicate what remains unsupported.

6. **The stall guard competes with evidence gathering.** Democracy baseline
   and reranked turns read useful excerpts but stopped without a note or
   final explanation. The explicit pagination probe also stalled after valid
   retrieval and reads. The present four-response guard counts completed
   todos, not retrieval progress; rejected writes grant extra responses.
   More results cannot by themselves resolve that behaviour.

7. **Source verification is inconsistently followed.** Only two comparison
   turns made successful page captures, three captures total, despite many
   notes using source-specific formulas, tables or values. Read-before-write
   is enforced and caught numerous attempted writes; the image-verification
   instruction does not provide an equivalent guarantee. This is separate
   from whether search selected the right scope.

8. **Duplicates consume retrieval space even when the final note avoids
   them.** All three two-dataset turns avoided presenting the same Elmhurst
   example twice. Reranking found a useful small second dataset. The earlier
   search audit still shows related textbooks occupying separate top-five
   positions with the same underlying example.

The earlier count discrepancy also remains relevant: in its 90-book
snapshot, subject browsing counted 407 tagged excerpts that failed the
additional evidence/confidence gate used by retrieval. That is a prior
snapshot count, not a new count of the 92-book corpus.

## Is cached continuation worth it?

A separate fixed-query probe embedded each of three queries once, then
alternated candidate budgets using the identical vector. Each budget ran
three times per query. It also hydrated pages 2–4 from cached IDs.

| Probe measure | Result |
| --- | ---: |
| Median search at 40 candidates, excluding embedding | 6.088 s |
| Median search at 160 candidates, excluding embedding | 6.349 s |
| Median initial embedding | 1.259 s |
| Median cached next-page hydration | 1.969 s |
| Serialized 20-result ID cache | 2,272–2,279 bytes |
| New embeddings for nine continuation reads | 0 |

These are end-to-end database/network measurements, not server CPU or memory
profiles. The cache size excludes Python object overhead. The prototype
hydrates all 20 candidates on the initial search before retaining just IDs;
their metadata serialized to about 51–71 KB versus 11–16 KB for five. A
production ID-first implementation can defer that extra metadata fetch until
a page is requested. Reranking, in contrast, needs candidate content up front.

The explicit agent probe asked it to inspect at least ten candidates from
one search. It used `search_id='search_1'` with offsets 5, 10 and 15, all
successfully. Those tool calls took 1.955, 1.730 and 1.527 seconds and caused
no new embedding. It then read three excerpts but hit `curate_stall` before
writing. This establishes the tool's usability, not a benefit for ordinary
requests. It also shows the agent can over-explore even with a modest target.

The cache checks passed for page boundaries, repeat reads, expiry, unknown
IDs and an unavailable source version. The latter was simulated using an
unavailable ID; no live book was republished for the test. Continuations
reject changed query/facets. Cursor information appears before the excerpts
so a long synopsis cannot truncate it away.

**Recommendation:** retain small visible pages and treat cached continuation
as an optional exploration capability. Its ID storage is cheap, and fetching
another page saves a fresh embedding and ranking operation. It is not a fix
for scope mismatch, and this run does not justify prefetching a much larger
pool for every request. A new semantic search is still necessary when the
current query is wrong; paging cannot create missing coverage. Any production
cache should bind its opaque cursor to the request/turn, query, facets and
source versions, remain bounded, and fail clearly after expiry or invalidation.

## What to change first

1. Make the library's selection and writing contract explicitly preserve the
   request's scope and state partial coverage. Carry limitations with selected
   evidence. Check actual teaching content and method identity, including
   jurisdiction, period, profession and implementation where they matter.
   Keep incidental examples and general passages from specialized books.
2. Resolve how continuation and multi-search discovery fit the existing
   exploration budget, including a useful final gap explanation. Do not
   simply add unlimited searching or automatic retries.
3. Review misleading role tags during existing source review, and check that
   numerical claims follow the existing source-capture rule. Make topic
   coverage counts describe the same eligibility as retrieval.
4. Prefer targeted, source-grounded scope notes when important context is
   absent from the excerpt. A compact book profile can supply context stated
   only in a preface, such as jurisdiction or the source's period. Do not
   inherit every book-level specialization onto every excerpt. Preserve the
   current full source notes.

I would **not bulk-generate general book summaries as the first fix**.
Existing titles, paths and passage text already expose several observed
errors. The current tools do not consume the stored book summary, so adding
prose there alone would have no retrieval effect. The full-text reranker also
shows why another unconditional model call is not automatically worthwhile.
Knowledge-library selection can evolve independently of workspace retrieval.

## Reproduction and evidence

- [Driver](../scripts/knowledge_scope_agent_eval.py)
- [Requests and review criteria](../fixtures/knowledge-scope-cases.json)
- [Per-turn metrics and canonical artifact paths](2026-09-20-knowledge-scope-agent/metrics.json)
- [Identical-vector search and cache probe](2026-09-20-knowledge-scope-agent/retrieval-cost-probe.json)
- [Explicit agent continuation probe](2026-09-20-knowledge-scope-agent/corrected/continuation-mechanics/paged/run.json)

Run one agent turn per process; the playground uses process-global patches:

```powershell
.venv/Scripts/python.exe bench/rag/scripts/knowledge_scope_agent_eval.py --case regression-general --arm baseline
.venv/Scripts/python.exe bench/rag/scripts/knowledge_scope_agent_eval.py --case regression-general --arm paged
.venv/Scripts/python.exe bench/rag/scripts/knowledge_scope_agent_eval.py --case regression-general --arm reranked
.venv/Scripts/python.exe bench/rag/scripts/knowledge_scope_agent_eval.py --case continuation-mechanics --arm paged
.venv/Scripts/python.exe bench/rag/scripts/knowledge_scope_agent_eval.py --probe-search
.venv/Scripts/python.exe bench/rag/scripts/knowledge_scope_agent_eval.py --check
```

Use `--output` with a new directory to preserve these results. The driver
requires the existing `.env.local` library and embedding configuration and
local Ollama. Database sessions enforce read-only transactions. Downloaded
PDFs and captures are ignored by Git; JSON traces and local notes are retained.

Five original attempts are superseded by `corrected/` records: two captures
exposed a playground-relative output-path assumption; one empty note exposed
a local writer check missing from the real gateway; two initial paged runs
used a footer cursor before it was moved to the header. The driver corrects
these harness issues locally. The original attempts remain available but
are excluded from comparison metrics. The forced continuation probe is also
excluded. No production retrieval, prompts, tagging or gateway behaviour
was changed by this experiment.
