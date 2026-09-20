# Knowledge search and request scope

Follow-up: [actual agent-loop and cached-continuation comparison](2026-09-20-knowledge-scope-agent.md)
tests 17 requests against three retrieval variants. The findings below concern
the earlier retrieval-only snapshot.

Read-only assessment on 2026-09-20. The live library contained 90 books and
45,838 current excerpts; 45,429 passed the retrieval tag gate. Ten queries
ran through production `library.search`, using its current embedding pin,
40 candidates and five returned excerpts. Topic and role arguments were
supplied manually. This checks retrieval results, not the curate agent's
planning, final source selection or generated materials.

Raw evidence: [search results](2026-09-20-knowledge-search-fit/search-probe.json)
and [metadata counts](2026-09-20-knowledge-search-fit/metadata-probe.json).
The search receipt records queries, facets, book versions, complete returned
synopses, hit chunks and ranks. The completed run used one embedding request
with 343 embedding tokens. An earlier attempt embedded the same ten queries
but failed before searching because Windows' default event loop cannot run
Psycopg async connections; the completed run used WindowsSelectorEventLoopPolicy.
Database connections enforced read-only transactions. No library rows or
application behavior changed.

## Finding

The library contains useful material and useful excerpt descriptions, but
search does not reliably match the scope of a learning request. Matching a
topic and a teaching role does not distinguish a generally applicable
explanation from a particular implementation, audience, method or setting.

| Request | Observed result |
| --- | --- |
| I want to learn statistics, introduction role, no topic filter | First result was an epilogue about material the book did not cover. Fifth was Getting started with jamovi. |
| Explain simple linear regression, linear-regression topic, introduction role | A suitable general explanation from the jamovi book ranked first. Multiple linear regression ranked third. |
| A worked example of simple linear regression, matching topic and role | Linear regression in jamovi ranked first; an R command walkthrough from Advanced High School Statistics ranked fifth. |
| Same worked-example request, adding without programming or statistical software | The jamovi walkthrough remained, now second. The first result explained calculation from summary statistics. |
| A worked example of an independent samples t-test, t-tests topic, worked_example role | A paired-samples jamovi example ranked second; a Bayesian example third; another paired-data example fifth. |
| How do I fit a linear regression in R with lm?, linear-regression topic, worked_example role | An R command walkthrough ranked first, but jamovi examples occupied second and third. |
| Explain the mean and median to a beginner, center topic, introduction role | Useful general explanations from the jamovi book ranked first and second. A learning-objectives list also appeared. |
| Explain quantum error correction with surface codes, introduction role, no topic filter | Five results were returned, including classical error correction, human mistakes and Java exceptions. The returned passages did not answer the specific request. |

This is a small diagnostic, not a measured corpus-wide error rate. The
unfiltered calls are permitted tool calls; the normal curate prompt first
asks the agent to browse subjects and topics. The filtered regression and
t-test cases show that following topic/role filters still leaves scope errors.

## What retrieval currently knows

- `browse_knowledge(subject=...)` returns topics and coverage counts;
  `search_knowledge(query, topics, roles)` searches within verified tags.
- Ranking uses chunk embeddings and lexical matches. A best-matching chunk
  ranks each excerpt. The result contains the book title, section path,
  roles, topics, synopsis and hit text.
- Synopses are fetched after the candidate ranking. They are not another
  search index or a relevance judgement.
- The stored book `summary` is the first-level section titles joined and
  clipped at 1,000 characters. The descriptor is attribution. The knowledge
  tools do not use either for selection. The prose book-summary stage was
  deliberately removed on September 19 because retrieval did not read it.
- The curate prompt tells the agent to adapt material for the learner, but
  the search implementation has no query-relative scope check or reranker.

References: [search and folding](../../../pipeline/pipeline/retrieval/library.py),
[tool rendering](../../../pipeline/pipeline/retrieval/tools.py),
[ranking SQL](../../../pipeline/pipeline/retrieval/store.py),
[book summary assembly](../scripts/knowledge_base_library.py),
[curate prompt](../../../pipeline/pipeline/prompts/curate.py).

The metadata audit also found 11,736 synopses exactly equal to the complete
excerpt text, 3,207 longer than 2,000 characters, and 126 empty. These are
overlapping counts, not independent error categories. Full source notes are
an intentional part of the delegated workflow; they should not be silently
replaced or compressed. Their existence does not guarantee a clear statement
of an excerpt's scope.

## Recommended next experiment

The developer clarified that knowledge-library retrieval may use its own
mechanism independently of workspace retrieval. Reusing workspace chunk
search is optional. The reranking experiment below is a starting comparison,
not a requirement to preserve that architecture. Excerpt-level candidate
retrieval, its ranking and its suitability checks can be designed for the
library while workspace retrieval follows its own needs.

Match excerpts to the requested scope, using the original request and any
relevant conversation context. A broad request should prefer generally
applicable explanations; a specific request should honor the specification.
Concrete examples remain useful. A possum example explaining regression is
general statistics illustrated with data; a jamovi interface walkthrough
depends on a particular implementation. Generality also differs from
difficulty and detail: a detailed explanation can be generally applicable.
Prerequisite modelling is explicitly outside this recommendation.

First compare current ranking with query-aware reranking of a wider set of
distinct excerpts using their existing titles, paths, synopses and matching
text. Several observed failures are already identifiable from those fields.
The judgement should consider whether the passage teaches the requested idea,
whether its narrower context changes the lesson, and whether that context
was requested. It must allow fewer results when candidates do not fit. Test
this before adding a new metadata schema or regenerating the corpus.

Where those inputs omit necessary context, add a source-grounded description
of the excerpt's scope during the existing review. Book descriptions can
supply context stated only in a preface, such as audience, jurisdiction,
historical period or the book's chosen framework. They cannot establish that
every excerpt shares a book's specialization. Keep the full source notes.
Generating book summaries without connecting them to selection would not
change today's results.

Use paired requests for the comparison: general statistics versus a named
software workflow; general subject versus a named profession; a broad method
versus its specific variant; general subject versus a named jurisdiction or
historical period. Include incidental examples that should survive filtering,
specialized books containing general explanations, and requests for which
none of the candidates is suitable. Preserve actual source locators and
judge the returned teaching content, not merely whether its tag equals the
filter. The earlier 22-question experiment used expected tags as filters and
explicitly did not evaluate ranking quality within a filter.

## Other issues worth covering in that experiment

- Related-but-different concepts can pass a shared topic tag, as the paired
  and independent t-test examples demonstrate.
- Top-k always means nearest candidates, not necessarily a usable answer.
  The no-topic quantum query illustrates the need to reject poor matches.
- Teaching-role labels can include epilogues and learning-objective lists.
  A quoted source span and tag confidence do not prove pedagogical usefulness.
- Related books can contribute near-duplicate examples. In the worked
  regression query, AHSS and OpenIntro both returned the same financial-aid
  regression-output example, using two of five positions.
- Subject/topic coverage counts use tagged excerpts, while search also
  requires verified evidence and confidence of at least 0.8. This snapshot
  had 407 tagged excerpts failing that additional gate, so browsing counts
  can overstate retrievable coverage.

No missing topic references or cross-subject assignments were found when
comparing current excerpt tags with the manifest's subject assignments.
