# Retrieval improvement directions: workspace and knowledge library

Later same-day follow-ups supersede the proposed priorities below: the
[workspace loop](2026-09-21-workspace-agentic-retrieval.md),
[workspace opening experiment](2026-09-21-workspace-opening-agentic.md), and
[compact curate experiment](2026-09-21-knowledge-compact-finish.md) test the
actual agent loops. Keep workspace k=5, prioritize terminal-answer behavior and
source fidelity, and carry compact knowledge discovery forward as an experiment.
Rerankers and global deduplication remain deferred. The counts and proposals
below record the earlier snapshot, not the later library state.

Assessment on 2026-09-21, requested by the developer before choosing the next
retrieval work. Two prompts: community suggestions (dynamic chunk sizes, dynamic
top-k, small rerankers or NER filters) and the deferred
[curate and dedup todo](../../../todo-knowledge-curate-and-dedup.md). Nothing in
the runtime, index, prompts or library changed. Two read-only probes ran: the
live library database (SELECT only, `default_transaction_read_only`, 150 s
statement timeout, through the ingest host) and the UAT `rag_search_events`
table. The reddit thread was unreachable from this machine (403 on the JSON
endpoints, blocked in the sandboxed browser), so the ideas are assessed as the
developer described them.

## Where workspace retrieval stands

The frozen experiments agree on one shape: candidate generation is not the
problem, final ordering is. Every relevant passage was inside the 40-candidate
pool for all 629 frozen queries ([rerank report](2026-09-13-qwen3-reranking.md)).
The loss happens choosing the five passages shown.

| Held-out, 312 questions | Hit@5 | nDCG@5 | Fixes JLPT locators |
| --- | ---: | ---: | --- |
| Current hybrid RRF | 304 | .827 | 2 of 5 |
| Dense only | 309 | .860 | 1 of 5 |
| BM25 with current rules | 308 | .844 | 2 of 5 |
| Qwen3 rerank over the union | 307 | .871 | 5 of 5 |

The fixture is saturated. Recomputed over the frozen union lists with file-level
labels, the first relevant candidate sits at rank 1-5 for 309 of 312 held-out
questions, at 11-20 for two and at 21-40 for one; none sits at 6-10. So the
fixture cannot show what a wider window would do. The one real long-document
case, the JLPT lookup (56 chunks in one file of a 223-chunk workspace), had its
target at rank 8 and 12 for the two failed queries. That is the failure class
that matters, same-document competition, and only reranking recovered it.

Real usage gives no signal yet. UAT holds five search events from three turns
on 2026-09-13 (all Japanese) and zero chunks today. Two facts from those five
rows are still worth keeping: embedding a query took 1,757 ms at the median
while the fused SQL took 14 ms, and the `cited` array (which shown passage the
answer referenced) is populated. That column is the label for judging any
ranking change once there is traffic; the query in the reproduction section is
the dashboard.

## Where knowledge-library retrieval stands

Live library on 2026-09-21:

| Measure | Value |
| --- | ---: |
| Books | 92 |
| Excerpts on current versions | 47,717 |
| Excerpts passing the retrieval gate | 47,206 |
| Excerpts with reviewed scope (`retrieval` set) | 540 |
| Searchable chunks | 79,867 |
| Chunk length, chars, p05 / p50 / p95 | 85 / 1,000 / 1,590 |
| Chunks under 200 chars | 9,702 |
| Chunks per excerpt, p50 / p75 / p95 / max | 1 / 2 / 4 / 546 |

Roles on eligible excerpts: formal 25,368, worked example 10,172, exercise
7,119, introduction 6,671, reference 5,736, summary 2,067.

Exact duplicate text across books, after whitespace and case normalization, on
the 70,165 searchable chunks of at least 200 characters:

| Group kind | Groups | Chunks |
| --- | ---: | ---: |
| Same text in two or more books | 592 | 1,187 |
| Same text repeated inside one book | 55 | 139 |

That is 1.7% of chunks, and it is concentrated in forks. Core Concepts of
Marketing and Introducing Marketing share 462 identical chunks; Business Ethics
and Business, Government, and Society share 61; the two education
administration books share 21. The statistics pair behind the Elmhurst
repetition, Advanced High School Statistics and OpenIntro Statistics, shares
only 10 identical chunks, and Learning Statistics with R and its jamovi edition
share 8. Exact-text grouping therefore settles the fork problem and does not
touch the Elmhurst case, which is a near duplicate.

The [September 20 search probe](2026-09-20-knowledge-search-fit/search-probe.json)
also shows crowding. `library.search` folds chunks into excerpts and collapses
identical text within a book, but applies no per-book cap; workspace search caps
one file at 4 of 5. Two of the ten probe queries returned all five excerpts from
Learning Statistics with jamovi and a third returned four of five. The
off-topic query returned two chunks of 66 and 105 characters.

The agent-loop trials ([scope agent](2026-09-20-knowledge-scope-agent.md),
[scope implementation](2026-09-21-knowledge-scope-implementation.md)) add the
non-retrieval limits: role tags are noisy, the stall guard ends useful reading,
and a full-text GLM reranker cost a median 13,686 extra input tokens per turn
without preventing unsupported content.

## The three community ideas against this evidence

**Dynamic chunk sizes.** Already the design. Chunks follow the heading
hierarchy, pack to a 400-token budget without splitting blocks, native tables
become their own chunks, and retained headings become small chunks so a section
is findable by name. The 12% of library chunks under 200 characters are that
design, not drift. The other meaning of the idea, retrieve small and return the
parent, is a recorded decision against: the hit chunk is the context and
`read_document` covers a cut. Nothing to change. One cheap check once traffic
exists: cited rate by chunk length, to see whether tiny chunks win positions
they should not.

**Dynamic top-k.** The cost model is asymmetric. Fetching more candidates costs
nothing (14 ms of SQL against 1.8 s of embedding); showing more costs about 250
tokens per passage of model context. A score-gap rule cannot be evaluated: the
frozen fixture has no first-relevant hits at ranks 6-10, and RRF scores are not
calibrated across queries. On the one real case, k=8 would have recovered one
of the two JLPT misses and k=12 both, at 2.4x the passage tokens on every
search. The lazy form that needs no heuristic is a `top_k` argument on
`search_workspace`, default 5, maximum 10, so the model widens on its next
search instead of rewording. Untested, cheap, and it needs a decision because
`CAPY_SEARCH_TOP_K` 5 is a recorded default.

**DistilBERT, ColBERT, NER filters.** A cross-encoder reranker is the one tested
lever that fixed the observed failure class. The Qwen3 experiment recovered all
five JLPT lookups, gained three net held-out hits, added 0.91 s median HTTP
latency, and regressed a few controlled wrong-task questions. It is not "not
that beneficial"; the aggregate fixture is at ceiling, so the aggregate cannot
move much. Vendor options today: DeepInfra, already the embedding vendor,
lists Qwen3-Reranker-0.6B, 4B and 8B at $0.010, $0.025 and $0.050 per million
tokens; Alibaba Model Studio Singapore offers `qwen3-rerank` with the same
500-document, 120,000-token limits as the Beijing run. At roughly 13,000 tokens
per 40-candidate request (the query is counted per document) that is under
$0.001 a search. ColBERT needs a multi-vector index and more storage and
serving for a candidate-recall problem the data says we do not have. A
DistilBERT NER or filtering model has nothing to filter on: entities and
relations are a recorded non-goal, chunk language is a heuristic that works,
and the one brittle classifier, the two-to-three-term lookup rule, has no
training labels. Skip both.

## Recommended sequence

### Workspace

1. Put a hosted reranker behind the existing `_rerank` seam, gated by a config
   flag, reranking the fused top 40 to the shown 5 and keeping the per-file
   cap. Record reranked rank next to `vec_rank` and `lex_rank` in
   `rag_search_events` so `cited` can compare the two orderings. Measure with
   `rag_eval.py` on the lab database (the `capy-odl-agentic-db` container on
   the ingest host is stopped and restartable) and the five JLPT queries.
2. If accepted, the `top_k` argument above, bounded at 10.
3. The product-shaped fixture from the
   [directions report](2026-09-13-retrieval-directions.md) is still missing and
   every frozen set is at ceiling. Any further ranking work is unmeasurable
   without a few real long documents with labeled sections.
4. Check the 1.8 s query-embedding latency once traffic exists (cold start or
   the Netcup to DeepInfra path). A reranker's 0.9 s is judged against it.

### Knowledge library

1. Soft per-book cap in `library.search`, 3 of 5 with overflow, the same rule
   workspace search already uses. Measure on the 10 probe queries, the 22 pilot
   questions and the 17 scope cases: books per result, topic and role hits, and
   the scope review.
2. Exact-text grouping across books (the todo's first step). A normalized text
   hash per chunk, written at publish, lets the search fold collapse identical
   text across books the way it already does within a book, keeping every
   source for provenance. False merges are zero by construction. It affects
   1.7% of chunks, mostly the marketing fork. Marking fork books at admission
   (462 shared chunks is a fork signal) is the even cheaper version.
3. Near-duplicate nomination offline, statistics first (the todo's second
   step): cosine over the existing vectors between chunks of different books
   that share a topic, a threshold to nominate, then review. This is the only
   route to the Elmhurst case.
4. Scope matching after 1 and 2 change the candidate set. The full-text LLM
   reranker is measured too expensive. The bounded variant is a selection step
   over compact cards only (section path, summary, scope; about 100 tokens
   each) for 15-20 candidates, roughly 2,000-3,000 tokens, returning ids and a
   gap. It depends on scope coverage, which is 540 of 47,717 excerpts today, so
   the cards are mostly synopses until the backfill reaches the passages
   searches actually return.
5. Raise the library candidate pool from 40 chunks only if the cap and
   grouping leave fewer than five excerpts on the regression sets.

## Tests run on 2026-09-21

The developer asked for top-k to be tested before deciding, with the emphasis
on returning nothing when a search finds nothing useful, and declined another
reranker run. Runner: [`topk_abstention_eval.py`](../scripts/topk_abstention_eval.py)
(`run`, `lexcheck`, `analyze`); agent harness:
[`topk_abstention_agent.py`](../scripts/topk_abstention_agent.py). Raw rows and
answers sit under the ignored `reports/local/2026-09-21-topk-abstention/`.

Setup: the frozen September 9 lab database (`capy-odl-agentic-db` on the ingest
host, restarted for this run) with the caption-free workspace
`odl_eval_odl_nocaption` (27 files, 2,217 chunks); two nullable columns
(`rag_chunks.confidence`, `confidence_reasons`) were added to that frozen copy
so the current statement runs, no rows changed. The live library was read with
the read-only role. Query embeddings went to DeepInfra on the UAT key.

### Workspace: wider k does nothing, abstention needs two signals

All 32 `questions*.json` sets ran through the production statement with the
full 40-candidate pool: 274 answerable and 36 labeled no-answer questions. The
locale "irrelevant" sets turned out to be irrelevant to their own locale's files
only; in this mixed workspace 23 of the 36 are answerable (best vector distance
0.20 to 0.40, lexical rank 1), so the true no-answer set is the 10 English
questions plus three locale questions no file answers. Chunk-level labels are
stale for this index (107 of 274 match), so hits are counted at file level.

| Rule | Answerable file hit | Mean passages shown | True no-answer returning 0 |
| --- | ---: | ---: | ---: |
| Baseline, top 5 | 250/274 | 5.00 | 0/13 |
| Top 8 | 250/274 | 8.00 | 0/13 |
| Top 10 | 251/274 | 10.00 | 0/13 |
| Abstain when best vector distance > 0.6 | 242/274 | 4.49 | 12/13 |
| Abstain when best distance > 0.6 and no chunk holds every query term | 249/274 | 4.67 | 12/13 |
| Drop hits farther than best + 0.05 | 242/274 | 2.85 | 0/13 |

Wider windows recover nothing: the first relevant file sits at rank 1 to 5 for
247 questions, at 6 to 10 for two, at 11 to 40 for three, and outside the pool
for 22. Vector distance alone cannot abstain: 24 answerable identifier lookups
(`DFKI`, `刘国兴`, `BoolQ`, `River Namsen 1200 eggs`) have a best distance above
0.55 because a one-word query embeds far from any passage, and they are found
by the lexical leg. Adding the second signal, whether any chunk in scope
contains every query term in its own language configuration, keeps all but one
of them (`fire`, whose answer chunk does not contain the word) and still
returns nothing for 12 of the 13 true no-answer questions. The exception is
"What does the mitochondria do?", which the biology chapter does answer; the
label is wrong, not the rule. The rule also abstains on 18 questions the
baseline already missed (a cluster of Chinese questions about the Cantonese
article at distance 0.60 to 0.75), which turns five wrong passages into
nothing. Gap rules trim passages but can never abstain, since the best hit
always survives. The all-term signal is one boolean the SQL already computes
for ordering and does not return.

### Agent arms: same answers, fewer tokens, one more search

The production chat loop ran in-process with GLM-5.3-Flash on local Ollama
(low reasoning, temperature 0) over the 10 English no-answer questions and six
answerable statistics questions, once with the baseline search and once with
the two-signal abstention (ceiling 0.6). Answers are equivalent on every
question: the baseline model already tells the learner the sources do not cover
sourdough, Mongolia or the French Revolution, and answers from general knowledge
with a disclaimer; four of the ten it never searched. The mitochondria question
was answered from the sources in both arms.

| Measure over the 10 no-answer questions | Baseline | Abstaining |
| --- | ---: | ---: |
| Searches | 10 | 10 |
| Searches that returned nothing | 0 | 7 |
| Reported input tokens | 67,618 | 35,600 |
| Questions where the model searched a second time after an empty result | 0 | 2 |

Half the token difference is one outlier (the mitochondria turn: five searches
against three). Per abstained search the saving is the five passages, about
1,200 to 3,000 input tokens. Twice the model reworded and searched again after
the empty result although the tool text told it not to, so an empty result
does not end exploration by itself; the existing overlap footer is the stop
signal for repeats. Answerable questions were unchanged in both arms.

### Library: a distance ceiling separates cleanly, a book cap changes little

The same runner ran the library statement (verified-tag predicate, excerpt
fold) for the 24 pilot questions, the 10 probe queries and the 35 workspace
no-answer questions, plain and, where the fixture gives them, with the
expected topics and roles as filters: 31 answerable and 38 labeled no-answer
queries, 40 and 80 chunk candidates.

| Plain search, 40 candidates | Topic hits in top 5 | Role hits | Books per result | No-answer returning 0 |
| --- | ---: | ---: | ---: | ---: |
| Baseline | 141/155 | 73/155 | 3.03 | 0/38 |
| Per-book cap 3 | 140/155 | 76/155 | 3.23 | 0/38 |
| Per-book cap 2 | 137/155 | 76/155 | 3.45 | 0/38 |
| Cap 3 plus cross-book exact grouping | 140/155 | 76/155 | 3.23 | 0/38 |
| Abstain when best distance > 0.5 | 141/155 | 73/155 | 3.03 | 31/38 |
| Abstain when best distance > 0.55 | 141/155 | 73/155 | 3.03 | 27/38 |

Best vector distance is a clean signal here, unlike the workspace: every
answerable plain query has a best distance under 0.40 and the filtered ones
under 0.52 (one, the `data-types` exercise request, sits at 0.51). The seven
no-answer queries that survive a 0.5 ceiling are questions the 92-book
library does cover (Hardy-Weinberg in Concepts of Biology at 0.30, the
derivative of sin(x) in Brief Calculus at 0.34, mitochondria at 0.40, fission
in Physics at 0.41); the labels came from the workspace fixtures. The two
pilot unanswerable requests (0.57 and 0.62) and the quantum surface-code probe
(0.50) all abstain. Sourdough, Mongolia and FIFA sit at 0.59 to 0.67. A ceiling
of 0.5 for unfiltered and 0.55 for filtered searches loses nothing on this set.

The per-book cap is a smaller effect than the probe suggested: only 2 of 31
filtered and 3 of 31 plain results came from one book, and a cap of 3 moves
books per result from 2.9 to 3.0 (filtered) and 3.0 to 3.2 (plain) with topic
and role hits unchanged. Cross-book exact grouping changed no result: the
statistics forks are near duplicates, not identical text. The 80-candidate
pool changed nothing either.

### Near-duplicate probe on the statistics books

Nearest cross-book neighbour by cosine distance over the existing vectors, for
every searchable chunk of at least 200 characters, read-only on the live
library:

| Pair | Chunks | Under 0.02 | 0.02 to 0.10 | 0.10 to 0.20 | 0.20 and above |
| --- | ---: | ---: | ---: | ---: | ---: |
| Advanced High School Statistics against OpenIntro Statistics | 1,175 | 40 | 156 | 291 | 688 |
| Learning Statistics with R against its jamovi edition | 1,767 | 111 | 419 | 379 | 858 |

Exact text found 10 shared chunks in the first pair; the vectors find 40 within
0.02 and 196 within 0.10. Inspection of the 0.02 to 0.10 band shows the same
exercises, the same possum and Elmhurst examples with renumbered figures, and
the same definitions with light edits. The R and jamovi editions share 530
chunks within 0.10; those pairs were not inspected, and by the books' nature
many will be the same lesson with the software swapped, which the todo classes
as a variant to keep, not a duplicate. Elmhurst appears in 13 OpenIntro
chunks and 9 AHSS chunks. A distance under 0.10 nominates a pair; it does not
decide it.

## Deduplication as a separate refinement workflow

The developer's framing: dedup is a one-off workflow that refines the library,
not query-time logic. Retrieval then reads one label. Proposed shape, following
the todo's order:

1. **Scope.** Pairs of books under the same subject, plus any pair the exact
   stage flags as a fork (462 identical chunks between the two marketing books
   is a fork signal). Unit is the excerpt; comparison runs on its chunks.
2. **Exact stage, no review.** A normalized text hash per chunk (whitespace and
   case only; numbers, signs, units and variable names untouched), computed at
   publish. Two excerpts are equivalent when every chunk of the smaller one
   hash-matches a chunk of the other. This settles the forks: 592 groups,
   1,187 chunks, zero false-merge risk.
3. **Nomination stage, no review.** For each book pair in scope, nearest
   cross-book neighbour per chunk over the vectors already in
   `rag_chunk_vectors_2560` (about a minute per thousand-by-thousand pair on
   the live database, better run on a copy), plus a token-overlap ratio on
   normalized text. Distance under 0.10 or overlap over 0.6 nominates an
   excerpt pair; 0.10 to 0.20 goes to a review queue only when the same topic
   is tagged on both sides.
4. **Review stage, bounded.** Nominated pairs that the exact stage did not
   settle go to the existing Qwen batch path (`lab/knowledge/qwen_batch.py`)
   or a Sol assignment, eight pairs per request, with both excerpts' full
   text, roles, scope and context links. The answer is one of equivalent,
   complementary, different variant, insufficient evidence, with the
   supporting spans and the named differences (dataset, variables, units,
   method, software, jurisdiction). Anything short of equivalent stays
   separate. From the probe, the statistics subject nominates roughly 120
   AHSS and OpenIntro excerpt pairs and 300 R and jamovi pairs, and the latter
   are mostly variants a software-scope rule can settle without a model.
5. **Persist.** A `library_duplicates` table of pair decisions keyed by
   `(content_id, excerpt_id, text_hash)` on both sides, with class, evidence,
   reviewer and run id, plus a `canonical_excerpt_id` on `library_excerpts`
   derived by union-find over equivalent pairs. A republish keeps decisions
   whose text hashes are unchanged and re-nominates the rest.
6. **Consume.** `library.search` folds by canonical id instead of excerpt id,
   a change of a few lines in the loop that already collapses identical text
   within a book; the card lists the other books in the group; provenance
   records the copy actually shown, so the best-ranked member for the query is
   the representative. The zero-change alternative is `searchable = false` on
   non-canonical copies, which loses that per-query choice.
7. **Measure**, in the todo's order: false merges on held-out reviewed pairs,
   then repeated positions on the 22 pilot and 10 probe queries, then answer
   coverage in the curate loop.

This stays out of the ingest path: it is a builder stage after publish,
re-runnable library-wide, with receipts in the builder's SQLite like the other
stages.

## Decisions needed

1. Workspace reranker: which vendor (DeepInfra Qwen3-Reranker-4B on the
   existing account, or Alibaba Singapore `qwen3-rerank`), always on or
   flagged, and the latency budget. No further experiment; the September 13
   run stands.
2. Abstention in `search_workspace`: the two-signal rule (best vector distance
   above 0.6 and no chunk holding every query term, exact tier excepted),
   returning an empty result with a "the workspace has nothing close" line.
   Yes or no, and the ceiling. A `top_k` argument is not supported by the data.
3. Abstention in `search_knowledge`: best vector distance above 0.5 unfiltered
   and 0.55 filtered, returning the existing empty-result text with its role
   counts. Yes or no.
4. Library per-book cap of 3: yes or no. The measured effect is small, and
   cross-book exact grouping in search can wait for the dedup workflow.
5. The dedup workflow above as a builder stage, statistics subject first: yes
   or no, and whether review goes to Qwen batch or Sol.

## Reproduction

Library statistics, run on the ingest host inside the library container with a
read-only session:

```sql
SET default_transaction_read_only = on;
SET statement_timeout = '150s';
WITH cur AS (SELECT content_id FROM rag_file_contents WHERE workspace_id='library'),
c AS (SELECT md5(regexp_replace(lower(c.text),'\s+',' ','g')) AS h, e.book_id
        FROM library_chunks c JOIN cur USING(content_id)
        JOIN library_excerpts e ON e.content_id=c.content_id AND e.id=c.excerpt_id
       WHERE c.searchable AND length(c.text) >= 200),
g AS (SELECT h, count(*) AS n, count(DISTINCT book_id) AS nb FROM c GROUP BY h HAVING count(*)>1)
SELECT count(*) FILTER (WHERE nb>1) AS cross_book_groups, sum(n) FILTER (WHERE nb>1) AS cross_book_chunks,
       count(*) FILTER (WHERE nb=1) AS within_book_groups, sum(n) FILTER (WHERE nb=1) AS within_book_chunks FROM g;
```

Cited rate by shown position, the label for any ranking change:

```sql
SELECT pos, count(*) AS shown, sum(c::int) AS cited
FROM rag_search_events, unnest(cited) WITH ORDINALITY u(c, pos)
GROUP BY pos ORDER BY pos;
```

First-relevant rank bands over the frozen union lists come from
`bench/rag/reports/local/2026-09-13-qwen3-reranking/prepared.json` (ignored),
matching each query's ranked `candidates` against its `qrels` by file id.
