# RAG handoff

Updated 6 September 2026 with the embedding comparison. The latest lab service
state was verified at 16:01 UTC on 6 September: all retained lab containers are
stopped; their existing data and volumes remain.

## Current position

Concept extraction remains removed. Retrieval combines vector and lexical search
through reciprocal rank fusion, or RRF. The chat agent follows references across
documents by searching and reading again.

The curated experiment found real failures in that loop. Two changes now exist
in the repository:

- The agent prompt tells the model to follow relevant identifiers and source
  references before deciding the workspace cannot answer.
- Tool results expose each passage's `file_id` and starting chunk index, so the
  model can call `read_document` with valid arguments.

Those changes improved the fictional reference-chain cases. The public-data
experiment confirmed the document-read benefit, but its positive chat questions
were too easy to establish a broader core-answer improvement. Its strongest
finding was a loss of relevant passages during hybrid ranking, especially on
argument retrieval.

No production ranking or embedding-model change, graph implementation, or
deployment resulted from these experiments. The frozen baseline is revision
`a903b8e917144701186b9c6cd2a6bbeea1bd15f9`. It does not describe today's HEAD or
establish what is deployed. The selected candidate is `follow_links_ids` in the
experiment artifacts.

Read the [decision log](human/agentic-retrieval.md) before changing behavior and
[OpenWiki](openwiki/agentic-retrieval.md) for the current pipeline.

## Embedding comparison, 6 September

[Full report](pipeline/scripts/rag_eval/embedding/REPORT.md),
[metrics](pipeline/scripts/rag_eval/embedding/summary.json),
[192 source reviews](pipeline/scripts/rag_eval/embedding/answer-reviews.json), and
[cleanup verification](pipeline/scripts/rag_eval/embedding/cleanup.json).

Five embedding conditions reused the frozen 19,821 chunks and 360 broad questions:
Qwen3 4B at 2,560 dimensions, Qwen3 8B at 2,560 and 4,000, Perplexity embed-v1-4b
at 2,560, and Voyage 4 large at 2,048. Every paired nDCG interval included zero.
The 4,000-dimension HNSW index doubled in size without a relevance gain. The tested
8B route had much longer query latency than 4B. The recommendation is to retain
4B; it is not a production configuration change.

Voyage had the highest hybrid nDCG and was selected for the agent comparison.
On the 80 answerable attempts per condition, 4B gave 75 correct answers and Voyage
65; 67 and 52 respectively also passed claim and citation support checks. Both
still failed reference-following and missing-information cases. These are Codex
source checks on reused questions with dependent repeats, not independent human
or fresh held-out evaluation.

New raw artifacts and the separate vector cache are saved under
`/Users/sam/Downloads/capy-embedding-eval-20260906/`. Both archives and every member
were verified before cleanup. The scratch schema, temporary credentials and
container, new VM files, and 195 experiment conversations were removed. The older
lab artifacts, data and volumes remain; all retained lab containers were restored
to their initially stopped state. The report distinguishes current cleanup from
the earlier service state recorded below.

## Earlier concept-removal evidence

The 4 September comparison used 13 two-document questions in Spanish, French,
Japanese and Chinese, repeated twice per condition, for 52 completed chat turns.

| Measure | With concept footer | Without footer |
| --- | ---: | ---: |
| Expected passage retrieved | 24/26 | 23/26 |
| Expected passage cited | 24/26 | 23/26 |
| Mean searches per turn | 1.50 | 1.65 |

All 52 answers supplied the cross-document answer. Strict passage misses used
adjacent or duplicate evidence. The corpus had only two to four documents per
workspace; the English files duplicated each other's text.

The footer never affected ranking. Of 1,663 extracted concepts, 910 appeared in
only one chunk. No inspected trace showed the agent following a footer name into
another document. The developer removed the extraction calls, concept tables,
copy/clone machinery, counter and footer. This justified removing that design,
but did not establish reliable bridging on harder data.

## Curated reference-chain experiment

[Full report](pipeline/scripts/rag_eval/curated/REPORT.md),
[results](pipeline/scripts/rag_eval/curated/results.json),
[78 held-out reviews](pipeline/scripts/rag_eval/curated/heldout-review.json), and
[reproduction instructions](pipeline/scripts/rag_eval/curated/README.md).

The corpus contains 23 fictional course documents with 32 specimen-to-accession-
to-assay chains, invented measurements, a retired manual, distractors, bilingual
aliases and two PDF tables. The complete workspace has 283 chunks. A control
workspace removes both accession registers and has 249 chunks across 21 files.
All files went through normal upload and ingestion. Required evidence spans and
parsed table values were checked before querying.

There are 48 fixed questions, split into 35 development and 13 held-out cases.
Development screens and held-out comparisons total 169 formal agent turns. Two
pilot turns and 12 diagnostic searches using known intermediate identifiers are
excluded from agent scores.

The development baseline failed six chains after retrieving the first identifier.
Focused diagnostic queries found both remaining links at rank one in all six
cases. The agent stopped early or searched too broadly. It also supplied filenames
where `read_document` required opaque IDs. These findings motivated the prompt
and file-location changes, without a graph or ranking change.

The frozen held-out comparison repeated each question twice under three
conditions. Each column contains 20 positive attempts from ten questions and six
negative attempts from three questions.

| Measure | Baseline | Follow references | Follow references + file locations |
| --- | ---: | ---: | ---: |
| Correct answer and every required source link retrieved | 14/20 | 19/20 | 19/20 |
| Reference-chain subset | 2/8 | 7/8 | 7/8 |
| Every required evidence group cited | 11/20 | 17/20 | 16/20 |
| Supported negative-control answers | 3/6 | 4/6 | 4/6 |
| Rejected document reads / all reads | 4/4 | 2/5 | 0/2 |
| Median turn time | 6.52 s | 8.79 s | 8.23 s |
| Mean reported tokens per turn | 11,883 | 16,365 | 14,755 |

The combined change repaired five positive attempts without losing a baseline
success. It still failed one chain and sometimes claimed that no settings applied
when the documents merely lacked enough evidence. Median time rose about 26%
and reported tokens about 24% against baseline. File locations were selected for
usable reads; this sample does not show higher answer accuracy than the
instruction alone.

The instruction-only condition also returned literal DSML tool markup instead
of an answer on one negative control near the tool limit. Although its SSE status
was `complete`, the review counted it as an answer failure.

This is a template-heavy synthetic corpus with an English index. Translated
questions exercise aliases into English sources. Held-out questions share the
corpus and sometimes reuse records, so they are not an independent domain test.

## Broad language and domain evaluation

[Full report](pipeline/scripts/rag_eval/broad/REPORT.md),
[results and frozen metadata](pipeline/scripts/rag_eval/broad/results.json),
[144 reviews](pipeline/scripts/rag_eval/broad/chat-review.json), and
[reproduction and source attribution](pipeline/scripts/rag_eval/broad/README.md).

This evaluation froze the existing settings before querying fresh public sources.
It used our actual Qwen embeddings, not precomputed vectors from another model.
No new candidate settings were selected from these scores.

### Retrieval

There were 360 queries across nine cohorts, 16,844 source records and 19,289
canonical chunks. Each query ran through real hybrid search, dense search and
forced-exact dense search, for 1,080 lookups. Comparisons shared query embeddings,
workspace/file scope and the per-file result cap.

Hit@5 means a labeled relevant document appears within the first five returned
passages. Multiple chunks from one document still consume result positions.

| Cohort | Documents | Hybrid hit@5 | Dense hit@5 |
| --- | ---: | ---: | ---: |
| MIRACL English | 416 | 38/40 | 38/40 |
| MIRACL German | 414 | 38/40 | 37/40 |
| MIRACL Spanish | 400 | 39/40 | 39/40 |
| MIRACL French | 400 | 36/40 | 40/40 |
| MIRACL Japanese | 382 | 40/40 | 40/40 |
| MIRACL Korean | 576 | 36/40 | 39/40 |
| MIRACL Chinese | 399 | 36/40 | 37/40 |
| SciFact scientific claims | 5,183 | 34/40 | 35/40 |
| ArguAna arguments | 8,674 | 21/40 | 37/40 |
| Total | 16,844 | 318/360, 88.3% | 342/360, 95.0% |

Dense had higher nDCG@5 in every cohort, with an overall mean of 0.764 against
0.658. Hybrid alone succeeded on five queries; dense alone succeeded on 29.
German hit@5 slightly favored hybrid. Keep those tradeoffs visible when tuning.

In inspected ArguAna case `test-law-lghbacpsba-pro02a`, the labeled rebuttal was
dense rank one. Hybrid displaced it with passages whose vector ranks were
12, 22, 17, 18 and 20. This is a fusion-ranking failure. ArguAna asks for
counterarguments, however, so its gap cannot decide ordinary notebook settings
by itself.

MIRACL uses reduced pools of all judged positives and negatives for the selected
questions. SciFact and ArguAna use their full BEIR corpora and exclude a query's
own corpus item through the file-scope filter. These are application diagnostics,
not official MIRACL scores. Some labels are inconsistent, and
unjudged passages receive zero relevance. Component fixtures bypassed upload,
parsing and generated summaries while using the real chunker, language detector,
embeddings and index writer.

Dense and forced-exact dense returned identical top-five chunk IDs on all 360
queries. None of the 18 saved execution plans used HNSW. This does not measure
approximate-index recall or large-scale ANN behavior.

Median SQL-path time was 1,039 ms for hybrid versus 114 ms for dense on ArguAna,
and 243 ms versus 72 ms on SciFact. Queries ran sequentially in a fixed condition
order, excluded embedding time and included large file-scope filters. These are
lab diagnostics, not production latency estimates or load tests.

### Full chat agent

The 36 cases comprise 14 native-language questions, eight cross-language MLQA
questions, eight two-source HotpotQA questions and six missing-source controls.
Two repeats under baseline and the prior selected change produced 144 first
attempts. Each condition has only 30 distinct positive questions and six controls.

| Measure | Baseline | Follow references + file locations |
| --- | ---: | ---: |
| Expected core answer | 60/60 | 60/60 |
| Core answer and all material claims supported | 54/60 | 57/60 |
| All material claims have supporting attached citations | 54/60 | 55/60 |
| Every labeled source group retrieved | 59/60 | 59/60 |
| Every labeled source group cited | 59/60 | 58/60 |
| Accurate missing-source response | 10/12 | 10/12 |
| Missing-source response with supported added claims | 8/12 | 8/12 |
| Rejected document reads / all reads | 22/32 | 0/54 |
| Completed attempts | 72/72 | 71/72 |
| Median completed-turn time | 5.02 s | 5.25 s |
| Mean reported tokens per completed turn | 6,847 | 7,772 |

One candidate attempt failed during provider streaming. It remains in the quality
denominator and was not retried. A recorded resume amendment continued only the
remaining cases. Timing and token summaries include completed turns.

One missing-source control has ambiguous wording in a retained song passage.
Excluding it gives accurate insufficiency responses of 10/10 for baseline and
9/10 for the candidate, whose only remaining failure is the stream error.
There is no robust abstention improvement here.

Every native-language cohort matched the core answer on 4/4 attempts per
condition. Cross-language and HotpotQA cases each scored 16/16 per condition.
The report separates claim support by language and task. Seven input/source
languages do not mean seven tested UI locales. The runner used Chinese account
locale for Chinese questions and English otherwise.

MLQA and HotpotQA used 113 unique Markdown sources and 143 logical uploads through
normal ingestion. Native MIRACL chat reused component fixtures with raw-text
summaries. All chat sources are Wikipedia-derived and many questions are easy
lookups. Public-data familiarity is possible.

Core-answer matching must not be presented as overall factual accuracy. Some
answers added unsupported details; others repeated malformed facts already in
the source, including an electron count missing its exponent. Source fidelity,
correct core answers and reliable full responses are separate measurements.
Codex reviewed every answer against actual tool evidence. These were not
independent or blinded human judgments.

## Next investigation

1. Inspect hybrid's losses and successes before changing fusion. Preserve
   language/task breakdowns, identifier lookups and the five queries where hybrid
   alone succeeded. Dense search is a comparison, not a selected replacement.
2. Keep fictional reference chains alongside public-data tests. Add varied student
   material, long documents, difficult tables and scans to cover the gaps left by
   Wikipedia text and two simple PDFs.
3. Separate failure to retrieve evidence from failure to follow a retrieved
   reference, unsupported absence claims, citation gaps and tool-budget failures.
   Inspect both searches and document reads by assistant message ID.
4. Freeze fresh evaluation sources and labels before tuning. Once these reported
   cases guide a change, treat them as development data. Preserve first-attempt
   failures and evaluate the final change on untouched cases.

The developer's standing decision permits revisiting a concept layer after
measured bridging failures. Most curated failures were addressable with the
existing loop, and no graph comparison has been run. If that decision is
reopened, the recorded candidate is cheap NER/keyphrase extraction with bounded
one-hop co-mention expansion as a third RRF leg. Rebuilding the removed
LLM-generated navigation footer is not the proposal.

Production `rag_search_events` can identify repeated searches with no citations,
but that pattern also occurs when the answer is absent. It stores IDs and
features, not queries or complete document-read evidence. Use full lab traces
and reviewed answers to establish a bridging failure.

## Code, configuration and verification

| Path | Purpose |
| --- | --- |
| [agent.py](pipeline/pipeline/retrieval/agent.py) | Agent loop and reference-following instruction |
| [tools.py](pipeline/pipeline/retrieval/tools.py) | Scoped tools, repeated-hit hint and file/chunk locations |
| [store.py](pipeline/pipeline/retrieval/store.py) | Hybrid SQL, lexical weight, short-query rule and scope |
| [chunking.py](pipeline/pipeline/retrieval/chunking.py) | Chunk packing and lexical preprocessing |
| [test_agent.py](pipeline/tests/test_agent.py) | Search-location-to-document-read test |
| [curated suite](pipeline/scripts/rag_eval/curated/README.md) | Corpus, ingestion checks, variants, traces and grading |
| [broad suite](pipeline/scripts/rag_eval/broad/README.md) | Public sources, retrieval comparisons, chat and review |

The tested runtime used chunker v5, top five passages, per-file cap four,
40 candidates and lexical weight 0.5 with the existing short-query exception.
Both suites pinned chat to `deepseek/deepseek-v4-flash-vision-exp` version 1 and
embeddings to `deepinfra/Qwen/Qwen3-Embedding-4B` version 1 at 2,560 dimensions.
Current source and configuration may advance beyond those frozen experiments.

The curated change passed 69 focused agent/retrieval-helper tests; its prompt and
rendered results matched the lab candidate. Grading checks covered full evidence
chains and numeric/decimal boundaries. The broad metric self-check, Python
compilation, cached Ruff formatting/lint and diff checks passed. The root
`pnpm run fmt:py` wrapper hit an `UnknownIssuer` package download error, so the
existing cached Ruff supplied formatting and lint checks. Broad evaluation made
no further production-code change; the 69 tests belong to the earlier patch.

## VM access and retained state

The ingest host also serves production, UAT and local development. These
experiments used a separate Compose project and volumes. Keep actions scoped
to that project.

The SSH key used successfully for these runs was:

```sh
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes \
  -i ~/.ssh/id_ed25519_evo_ingest root@159.195.61.195
```

The earlier handoff named `id_ed25519_capy_ingest`; that was not the key used.

| VM path | Contents |
| --- | --- |
| `/opt/evo-rag-lab` | Original concept-removal lab, preserved separately |
| `/opt/evo-rag-lab/bridge` | Earlier footer comparison streams and runner |
| `/opt/capy-rag-curated-20260905` | Isolated lab, Compose project `capy-rag-curated` |
| `/opt/capy-rag-curated-20260905/corpus` | Fictional sources, questions, manifest and workspace IDs |
| `/opt/capy-rag-curated-20260905/tool-evidence.jsonl` | Curated tool results keyed by assistant message ID |
| `/opt/capy-rag-curated-20260905/broad` | Public sources, embeddings, index snapshots, query plans, streams and reviews |

Each suite's `results.json` records model/source pins, freezes and raw artifact
hashes. The broad completion audit checked all 144 unique attempts, model and
workspace attribution, source/index stability and unchanged hashes of the four
earlier curated runs.

At the end of the 5 September broad run, gateway, retrieval, PostgreSQL, Redis
and MinIO remained available on loopback. All are now stopped after the
6 September embedding cleanup. Gateway `8082/healthz` and retrieval `8002/healthz` returned
HTTP 200. PostgreSQL uses port 55434, Redis 6381 and MinIO 9002 with console 9003.
The parser's configured port is 8092.

The parser, parse coordinator and ingest worker were stopped. Only the worker
was needed for broad Markdown ingestion, and it stopped after all uploads
finished. Data and volumes remain. The original retrieval command
`["python", "/lab/lab_server.py"]` and both experiment variant files were restored
to baseline. This records the end of the run; check current state before reuse.

For read-only inspection after connecting:

```sh
cd /opt/capy-rag-curated-20260905
docker compose -p capy-rag-curated -f compose.json ps -a
curl --fail http://127.0.0.1:8082/healthz
curl --fail http://127.0.0.1:8002/healthz
```

Use each suite's README for execution commands. In particular:

- Hooks expect the retained baseline image. Applying them to updated application
  source would duplicate the reference-following instruction.
- Broad chat needs the temporary `/lab/broad/serve.py` command and its separate
  variant/evidence files. The lab is no longer running that command.
- Run evaluations sequentially because each suite reads shared variant state.
  Use fresh output paths and preserve frozen inputs, traces and reviews.
- Start only required ingest services, wait for every file and expected span to
  be indexed, then freeze the index before querying. Chunker changes invalidate
  old chunk-position labels.
- Credentials stay in the existing lab environment. The lab disabled development
  auth/admission limits and used loopback object storage. Its timings do not
  measure production limits, cost or capacity.
