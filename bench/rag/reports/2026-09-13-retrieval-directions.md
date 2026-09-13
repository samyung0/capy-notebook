# Retrieval directions after the JLPT lookup failure

Follow-up decision, 2026-09-13: the user rejected an active-file hint because it
may not reflect the requested source. That recommendation below is withdrawn;
further experiments use conversation context and explicit source references.
The completed diagnostic and its frozen results remain unchanged.

## Fixed offline analysis

This analysis is intentionally narrower than another ranker comparison. The
BM25/fusion and document-aware chunking experiments are reported separately.
Here the questions are whether the agent had a usable document scope, whether
that scope would have fixed the five frozen JLPT lookups, and whether the current
multilingual fixture can evaluate conversational and long-document retrieval.

The inputs and calculations were fixed before this runner was scored:

- reuse the five queries, 223 frozen workspace chunks, fresh query embeddings,
  complete lexical match lists and current results from the JLPT lookup run;
- compare the existing whole-workspace result with the same unchanged ranker
  restricted to the known `N1 7-2019.pdf` file before dense and lexical ranks
  are assigned;
- retain Qwen3-Embedding-4B v1 vectors, exact cosine ordering, PostgreSQL
  lexical ordering, RRF `k=60`, dense weight 1, lexical weight 0.5, the existing
  exact-match weight, forty candidates and five returned passages;
- do not rewrite queries, call a provider, alter chunks, add language rules, or
  tune on the five known outcomes;
- inventory the frozen 624-query multilingual experiment for multi-turn
  context, candidate-pool language mixing, document length, natural versus
  controlled questions and cross-language coverage. Do not rescore its methods.

This is a replay over an already inspected incident and an already inspected
multilingual fixture. It is diagnostic, not new validation. Earlier exploratory
inspection had already shown that the top JLPT candidates came from the N1 file;
the fixed run measures the complete restricted ranking rather than treating that
observation as a result.

## Results

Restricting the existing search to the known N1 file did not change whether the
target passage was returned for any of the five queries.

| Frozen query | Whole workspace target rank | Known-file target rank | Returned? |
| --- | ---: | ---: | --- |
| `question 10 reading comprehension passage N1` | 12 | 12 | No |
| `問題10 次の文章を読んで 読解` | 8 | 8 | No |
| `問題 10 次の文章を読んで` | 1 | 1 | Yes, position 1 |
| `問題 10` | 2 | 2 | Yes, position 2 |
| Japanese subject question | 1 | 1 | Yes, position 1 |

For the first two failed queries, every one of the whole-workspace fused top 40
candidates was already from `N1 7-2019.pdf`. Their top five were also all from
that file. The failure is competition among similar chunks in the same long
document, not interference from the two other workspace files.

The English query's lexical target rank improves from 22 to 12 when the lexical
list is recomputed within the file, but its dense rank stays 24 and its fused
rank stays 12. The second Japanese query remains lexical rank 1, dense rank 16
and fused rank 8. It therefore was not present in the five passages returned by
the second search. Under the current agent contract, a third search was a
reasonable recovery step.

The successful third query differs from the second by removing `読解` and adding
a space after `問題`. Both target the same file and give the target lexical rank
1. The current query classifier counts the second as four terms, so it does not
qualify for the two-to-three-term exact-match weight. It counts the third as
three terms and promotes the same target to fused rank 1. This is the same
brittle cutoff diagnosed in the strategy report, not evidence for a Japanese
phrase exception.

The 624-query multilingual fixture cannot measure the missing behavior:

- all 624 records are independent single-turn questions and contain no history;
- none of the 624 baseline candidate lists mixes source locales;
- 3,038 of 3,149 documents have one chunk, and only one document has more than
  four chunks;
- the 64 cross-language questions search a source pool assigned to one locale;
- all 96 Taiwan and Hong Kong Chinese questions are controlled fixtures rather
  than natural-source questions.

The fixture is useful for same-locale ranking guardrails. It is weak evidence
for conversational references, active-file scope, long-PDF competition,
mixed-language workspaces and regional Chinese retrieval in real documents.

## Contract findings

The browser sends chat with only `conversationId` and `text`. The Go gateway
forwards the workspace, conversation history and user locale, but no active-file
ID or source hint. Python therefore starts an ordinary chat turn with unrestricted
workspace scope. The UI records `hasScope: false` for every chat turn.

`search_workspace` does support optional `file_ids`, and the runtime filters
before dense and lexical ranking. The model needs to know an internal file ID to
use it. It can get that ID from retained `list_sources` output or a prior tool
result. Opening a PDF in the center pane does not provide it. This makes the
tool description's phrase “current scope” misleading in ordinary chat because
the effective current scope is the whole workspace.

Conversation history was available in the reported UAT turn, and the system
prompt already says to use named files and the document language. The first
English query therefore reflects weak model compliance or insufficiently
explicit query guidance rather than missing conversation storage. Supplying the
active file would make scoping actionable in the first tool call, but this replay
shows that scope alone would not have fixed this incident.

The chunk rows already carry `file_id`, `file_name`, `section_path`,
`page_start` and `page_end`. Only file IDs are an explicit search filter. Section
text currently competes through the same lexical and embedding representations
as passage content. Page and section locators are not separately addressable in
the search tool.

## Ranked next directions

### 1. Evaluate a trusted active-source hint and standalone query formulation

Pass the active source's validated ID, display name and detected language to the
agent as a hint. Do not silently restrict every search to the open file because
users can ask workspace-wide questions while viewing a document. The model can
then put that ID in `search_workspace.file_ids` without spending a call on
`list_sources`.

Add a general tool rule: resolve conversational references into a standalone
search need, keep printed locator tokens in the source language, and avoid
translating identifiers or section labels. This uses the existing planning model
and adds no provider hop. Evaluate it on multi-turn fixtures before changing the
prompt. [QReCC](https://arxiv.org/abs/2010.04898) supplies conversational query
rewrites and retrieval labels, and work on
[multi-stage conversational retrieval](https://arxiv.org/abs/2005.02230)
shows why omitted terms and coreferences need explicit reformulation. Those
results motivate the experiment; they do not establish an effect in Capy.

Cost: a small request/context contract change and a few trusted context tokens.
No new index or durable storage is required. This reduces avoidable source-list
calls but will not repair within-document ranking on its own.

### 2. Add a structured locator leg after document-aware chunking

Treat source selection and printed locators as structured constraints, then use
the passage text for semantic ranking. A first version can support validated
`file_id`, page and parser-derived section labels such as `問題 10`, with generic
Unicode normalization appropriate to each language. Keep these fields separate
from the passage embedding so a wrong or stale heading cannot dominate semantic
similarity. PostgreSQL supports field weights and phrase queries in its
[text-search controls](https://www.postgresql.org/docs/current/textsearch-controls.html),
but the exact schema and scoring need a full-document benchmark.

The document-aware chunking experiment should land first because a locator index
cannot recover a section boundary that chunking did not preserve. Then compare
current hybrid search, document-aware chunking alone, and chunking plus the
locator leg. Measure candidate recall at 40 and final recall/nDCG at 5 separately.

Cost: parser-to-index metadata, normalized locator fields, SQL/tool filters and
reindexing. It is moderate work, but it directly targets the observed failure.

### 3. Build a retrieval fixture shaped like the product

Add real full documents in every supported language, with several nearby
numbered sections, tables and repeated labels in one file. Put several languages
in the same workspace. Include both same-language and cross-language questions,
and multi-turn questions that refer to a previously named or open file with
phrases such as “that passage” and “question 10.” Add distractor documents with
the same exam name, year, section number or translated topic.

Score these stages separately:

1. source resolution accuracy;
2. relevant candidate recall at 40;
3. passage recall and nDCG at 5;
4. answer claim coverage and citation support;
5. complete-section and citation-region accuracy;
6. latency and provider calls.

[MIRACL](https://arxiv.org/abs/2210.09984) is a strong native-annotated
multilingual retrieval source, but its stated task is monolingual retrieval.
[M3-Embedding and MLDR](https://arxiv.org/abs/2402.03216) add cross-lingual and
long-document retrieval coverage, while
[LongEmbed](https://arxiv.org/abs/2404.12096) contains real and synthetic
long-context retrieval tasks. These are useful seed shapes, not replacements for
Capy's section, page and conversation labels. Component-level measures similar
to [RAGChecker](https://arxiv.org/abs/2408.08067) can keep retrieval failures
separate from generation failures without adopting its framework.

Cost: mostly careful data collection and labeling. This should precede more
language-specific tuning because the current regional and locator fixtures are
at or near ceiling.

### 4. Test multi-query retrieval only for decomposable requests

A composite request may contain a source locator, a semantic question, or two
documents to compare. Separate those needs only when each requires a distinct
retrieval leg. Fuse their candidates and record which subquery supplied each
passage. Do not generate several paraphrases for every lookup. The published
[RAG-Fusion](https://arxiv.org/abs/2402.03367) experiment reports broader
coverage but also topic drift when generated queries stray from the original.
[Rewrite-Retrieve-Read](https://arxiv.org/abs/2305.14283) likewise supports
testing query rewriting but adds another learned component.

Cost: extra embedding/search work, more candidates and possibly another model
call. The current one-focused-query contract would need an explicit revision.
This is lower priority than structured locators because the motivating request
had one source and one section.

### 5. Keep instruction and reasoning retrieval as a later benchmark track

Some future requests will include constraints such as edition, date, source type
or exclusions. [FollowIR](https://arxiv.org/abs/2403.15246) directly evaluates
whether retrievers follow detailed instructions, and
[BRIGHT](https://arxiv.org/abs/2407.12883) evaluates retrieval that requires
reasoning. Add these categories when telemetry shows constrained or reasoning
queries failing. They do not explain this direct locator miss.

No evidence here supports reopening graph retrieval or automatic neighbour
expansion. Existing product decisions already use `read_document` for incomplete
passages, and the current incident is a single-section lookup.

## Reproduction

Run from the repository root with a new output directory:

```bash
python3 bench/rag/scripts/retrieval_directions_eval.py \
  --output /tmp/capy-retrieval-directions-repeat
```

The script verifies seven frozen input hashes, refuses an existing output
directory and uses only the Python standard library. It made no database or
provider calls. Ignored outputs are under
`bench/rag/reports/local/2026-09-13-retrieval-directions/`.

| Artifact | SHA-256 |
| --- | --- |
| Runner | `16ea687974f92ff71f964a1145d7f1d2f316a9240ffa644ab2f9866efdc4e980` |
| Five scoped replay records | `fd13302ef57e133e84ce4bb33207061d9612c2be93fabb68016e8227d4b1ba06` |
| Summary and fixture inventory | `c49948de2d3114437f887d9b898d260cdbe86c586fa7eb3b38b0de667245026e` |
