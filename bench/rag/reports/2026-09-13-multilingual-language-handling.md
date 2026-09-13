# Multilingual lexical handling experiment

No experimental method passed the frozen development selection rule in any of
the eight locales. Replacing CJK character bigrams with word segmentation lost
15 natural-source hits on held-out questions. These replacements do not support
a production switch. The existing baseline already uses language-specific
Postgres stemmers and stopwords for English, Spanish and French, with character
bigrams for CJK.

## Plan fixed before scoring

The user authorized language-level retrieval experiments for English, Japanese,
Korean, mainland Chinese, Taiwan/Hong Kong Chinese, Spanish, and French. This
experiment keeps eight reporting strata: `en`, `ja`, `ko`, `zh-CN`, `zh-TW`,
`zh-HK`, `es`, and `fr`. Japanese uses the internal tag `ja`.

Reuse the retained September 5 MIRACL sources and all forty selected questions
for each of en/ja/ko/zh/es/fr, including their judged hard negatives. These are
240 natural-source guardrail questions. They have been inspected in earlier
experiments and are not an unseen public benchmark. Keep upstream labels,
including known incomplete judgments. Retained traditional-Chinese PDF/slide
fixtures were inspected for coverage but have no comparable balanced public
question set; add controlled fixtures for both regional strata instead.

Add eight parallel fictional source families per locale, with nine closely
related records per family and six questions per target: semantic, paraphrase,
identifier, contextual locator, orthographic variation, and cross-language.
The source families cover specimen storage, equipment checks, library loans,
battery charging, seminar enrollment, parcel transport, document scanning, and
data backups. The values are deliberately fictional. Taiwan/Hong Kong wording
is authored separately, including software/data/device terminology. The questions
and labels are model-authored, not native-speaker-certified.

This gives 384 controlled queries and 576 controlled passages. Split by source
family before any retrieval run: the first four families are development, the
last four held out. All paraphrases, translations, regional versions and hard
negatives of a family stay in that split. For the natural-source guardrail,
hash-sort connected groups of queries sharing positive document IDs and assign
whole groups alternately to development/held-out. Preserve source pools in full.

Freeze source files, queries, labels, split assignment, chunker output, method
definitions, dependency versions, provider payloads and hashes before embedding
or scoring. No query-specific vocabulary, phrase matching or custom dictionaries.

Compare these fixed methods:

1. Baseline, the current tokenizer, language-specific Postgres configuration,
   all-term lexical ordering and two-to-three-typed-term exception.
2. Normalized baseline: Unicode NFKC for every language, plus OpenCC `t2s` for
   Chinese document/query lexical text. Dense inputs remain unchanged.
3. Segmented: normalization plus SudachiPy SplitMode A dictionary forms for
   Japanese, Kiwi morphemes for Korean, and Jieba words for Chinese. Latin
   languages retain their Postgres stemmer. Count segmented tokens for the
   existing short-lookup exception; do not add words to any dictionary.
4. Content-token matching: the segmented representation with grammatical tokens
   removed by the segmenter's part-of-speech tags, and Postgres stopwords removed
   for Latin languages. All-term matches receive full lexical weight regardless
   of the old typed-term cutoff. This tests a general query-handling alternative.
5. Dense-only reference.

Use one identical dense index and identical query vectors for every method:
DeepInfra Qwen3-Embedding-4B v1, 2560 dimensions, production query instruction,
raw document inputs, half precision, exact cosine ordering. Keep RRF k=60,
forty candidates, five output passages and per-file cap four. Use the real
Postgres `ts_rank_cd` and language configurations in a disposable lab database,
with separate temporary lexical tables, never UAT. Record full candidate ranks,
returned lists, tokenized queries and all-term classifications.

Select at most one experimental method per locale using development data only.
Compare the mean nDCG@5 across the six controlled query categories and the
natural semantic category when present, weighting categories equally. A candidate
must improve that mean by at least 0.02, preserve development hit@5, and lose no
category by more than 0.03 nDCG. Otherwise retain baseline. Break ties toward
the simpler earlier method. Freeze this selection before opening held-out
results. No threshold or tokenizer tuning after inspecting scores. Report every
method on held-out data, regressions and gains separately; no production method
is selected by this experiment.

Provider budget ceiling: two million input tokens, batches of at most 64,
one request at a time, no automatic retries. Retain successful batches and any
failed attempt. Sources and vectors are local to the isolated scratch directory;
no application jobs, summaries, parsing, accounts, or registry changes. Dependencies
are installed only into the experiment container. Record actual versions, calls,
input tokens, elapsed time and storage rather than assuming a spend or latency.

Report source-family uncertainty rather than treating paraphrases/translations
as independent evidence. Traditional-Chinese conclusions are controlled-fixture
diagnostics, not a general regional-language evaluation. Corpus pools are reduced,
cross-language queries are authored translations, and retrieval success does not
establish answer correctness. The earlier JLPT result remains separate evidence.

## Frozen run

The input freeze was written at 06:59:17 UTC on September 13. The development
selection was written at 07:03:38 UTC, before held-out scoring started. Both
splits contain 312 questions. Every requested locale has 24 controlled questions
per split, with another 20 MIRACL questions for en/es/fr/ja/ko/zh-CN. There are
3,149 source records, 3,277 v9 chunks and 3,778 unique embedding inputs.

The original retained MIRACL pools were reused from
`/opt/capy-rag-curated-20260905/broad/miracl.json`. Queries search all chunks of
their assigned document locale, including both development and held-out source
records. English questions over Japanese, Korean, Chinese, Spanish and French
sources, plus Chinese questions over English sources, exercise cross-language
retrieval. This does not evaluate a mixed-language scope or automatic locale
routing. Each chunk still uses the production language detector, including its
occasional misclassification, in every condition.

The embedding instruction was the current notes/materials retrieval instruction
from `pipeline/prompts/retrieval.py`. Document inputs remain raw indexed text.
Vectors use Qwen/Qwen3-Embedding-4B v1, 2560 dimensions, six-significant-digit
serialization followed by float16 precision. Exact cosine ordering removes ANN
variation from this comparison. Every method uses the same vectors, scope,
chunker output and stable chunk-ID tie ordering.

A read-only source hash check confirmed that the runtime's chunking/tokenizer,
language detection and query-instruction modules match the investigated
repository revision `9b046f09e53de1a6fb2cda29eeb70822bc131f64`.

The scorer uses real PostgreSQL `ts_rank_cd`, lexical candidate limit 40,
RRF k=60, vector weight 1 and default lexical weight 0.5. Qualified all-term
matches receive lexical weight 1. Fused candidates are trimmed to 40 before
the per-file cap of four and final five-passage selection. Metrics occupy actual
passage positions; a repeated source record contributes relevance only once.
MIRACL passage IDs remain separate source records, including passages from the
same original article. These scores should not be compared numerically with
earlier benchmarks that used different alias or source grouping.

Temporary lexical tables lived only in the disposable
`capy-multilingual-db-20260913` PostgreSQL 16 container at loopback port 55436.
The runtime was `capy-multilingual-20260913`, using image
`capy-ingest-nonprod-pipeline:711e3fe6007f0ae44b129e868f7f486699694fcc`.
The runtime had a 3 GiB memory limit and two CPUs; the database had 1 GiB and
two CPUs. Packages were added only to that experiment container.

| Dependency | Version |
| --- | --- |
| SudachiPy / SudachiDict-core | 0.6.11 / 20260723 |
| kiwipiepy / kiwipiepy-model | 0.23.2 / 0.23.0 |
| Jieba | 0.42.1 |
| OpenCC | 1.4.2 |
| NumPy / psycopg | 2.4.6 / 3.3.4 |

Sixty sequential provider requests embedded all 3,778 inputs successfully.
The provider reported 524,523 input tokens. Summed HTTP request duration was
141.5 seconds. There were no failed requests or retries. At the
[listed DeepInfra rate](https://deepinfra.com/Qwen/Qwen3-Embedding-4B) of
$0.020 per million input tokens, estimated embedding spend is $0.01049.
This is a price-based estimate, not a reconciled invoice, and excludes VM costs.
The run was not a retrieval-latency benchmark.

## Development decision and held-out results

Development retained baseline for every locale. Chinese normalization increased
development hits from 41/44 to 44/44, but its category-balanced nDCG gain was
0.0158, below the predefined 0.02 minimum. The best Korean content-token gain
was only 0.0004 on development. No threshold was adjusted after seeing either
split.

The table reports held-out hit@5 and category-balanced nDCG@5 in each cell.
The dense reference was excluded from the development selection candidates.

| Locale | Baseline | Normalized | Segmented | Content-token proxy | Dense |
| --- | --- | --- | --- | --- | --- |
| en | 43/44 · .886 | 43/44 · .886 | 43/44 · .886 | 43/44 · .889 | 43/44 · .881 |
| es | 42/44 · .850 | 42/44 · .850 | 42/44 · .850 | 42/44 · .849 | 43/44 · .884 |
| fr | 40/44 · .809 | 40/44 · .809 | 40/44 · .809 | 41/44 · .816 | 44/44 · .879 |
| ja | 44/44 · .904 | 44/44 · .904 | 36/44 · .863 | 43/44 · .890 | 44/44 · .920 |
| ko | 44/44 · .895 | 44/44 · .895 | 37/44 · .837 | 44/44 · .905 | 44/44 · .894 |
| zh-CN | 43/44 · .904 | 43/44 · .904 | 43/44 · .897 | 43/44 · .892 | 43/44 · .925 |
| zh-TW | 24/24 · .922 | 24/24 · .922 | 24/24 · .922 | 24/24 · .922 | 24/24 · .948 |
| zh-HK | 24/24 · .891 | 24/24 · .891 | 24/24 · .861 | 24/24 · .861 | 24/24 · .861 |

Separate the natural-source questions from the controlled templates to avoid
hiding the largest regressions behind easy identifier queries.

| Held-out pool | Method | Hit@5 | nDCG@5 | MRR@5 | Recall@5 |
| --- | --- | --- | --- | --- | --- |
| Natural, 120 questions | Baseline | 115/120 | .703 | .755 | .771 |
| Natural | Normalized | 115/120 | .702 | .756 | .769 |
| Natural | Segmented | 100/120 | .575 | .633 | .635 |
| Natural | Content-token proxy | 115/120 | .697 | .745 | .767 |
| Natural | Dense | 117/120 | .771 | .844 | .806 |
| Controlled, 192 questions | Baseline | 189/192 | .904 | .877 | .984 |
| Controlled | Normalized | 189/192 | .904 | .877 | .984 |
| Controlled | Segmented | 189/192 | .901 | .872 | .984 |
| Controlled | Content-token proxy | 189/192 | .900 | .872 | .984 |
| Controlled | Dense | 192/192 | .915 | .886 | 1.000 |

All fifteen segmentation hit losses were natural Japanese or Korean questions.
Japanese natural hit@5 fell from 20/20 to 12/20; Korean fell from 20/20 to 13/20.
Filtering grammatical tokens recovered Korean to 20/20 and Japanese to 19/20.
There were no compensating segmentation hit gains. The original content-token
proxy gained one French hit and lost one Japanese hit, leaving the overall count
unchanged. Its Latin implementation re-stemmed extracted lexemes, so the French
gain cannot be attributed solely to removing stopwords. A separate correction
is reported below; these frozen numbers remain unchanged.

Normalization changed lexical representations, but did not change controlled
metrics. All held-out identifier, contextual-locator and orthographic queries
were already top-one successes under baseline. That ceiling limits what this
fixture can tell us about lookup boosts. The three controlled baseline misses
were cross-language questions, two French and one Spanish, all recovered by
the dense reference. A general decision to discard lexical retrieval would
conflict with the separate JLPT locator evidence and needs a broader test.

## Why segmentation regressed

For MIRACL Japanese query `miracl-ja-4278`, asking when Barry Voight was born,
the expected passage had dense rank 1 and baseline lexical rank 3. Sudachi
emitted `バリー`, `ボイト`, `は`, `いつ`, `生まれる`, `た`. The expected passage
fell out of the segmented lexical top 40. It retained dense rank 1 but fell to
fused rank 6 because other passages received both vector and lexical scores.
Baseline returned it first. This is a candidate-coverage and fusion failure,
not an embedding failure.

For Korean query `miracl-ko-1078`, concerning amperes and charge flow, three
expected passages had dense ranks 1, 2 and 4. Baseline lexical ranks were 3, 7
and 4. None remained in the segmented lexical top 40, and their fused ranks
became 8, 10 and 12. The segmented query retained frequent grammatical forms
such as `의`, `는`, `가`, `것`, `을` alongside content words. These examples
are consistent with frequent morphemes competing with discriminating terms
under frequency-based lexical ordering. The recorded loss of lexical coverage
is established; the relative contribution of each morpheme was not ablated.

Removing grammatical tokens introduces a different risk when every all-content
match receives the full lexical weight. For Japanese `miracl-ja-4003`, asking
when Aeon Group was established, the content query was `イオン グループ 設立 する`.
Related passages containing those words received full-weight matches. The two
judged relevant passages remained dense ranks 1 and 3, but their lexical ranks
became 9 and 10 and neither matched all terms. They fell to fused ranks 9 and
10. A broad all-content rule can reward subject overlap without answering the
question. MIRACL judgments are incomplete, so this is a regression against the
retained relevance labels, not an independent answer-quality judgment.

## Post-hoc Latin correction

After inspecting the original results, we identified a confound in the Latin
content-token proxy. `tsvector_to_array` returned already-stemmed lexemes, and
the query builder then passed those lexemes through `websearch_to_tsquery` using
the language stemmer again. Stemming and stopword removal are not necessarily
idempotent. The original condition remains in every artifact and table above.

The user authorized a separate `latin_content_once` control. Its plan and script
hash were recorded before that control ran. It parses the already-stemmed
lexemes with Postgres `simple`, retaining the same normalized lexical index,
all-content weighting, cached vectors and other settings. It covers all 264
original English, Spanish and French questions. There were no provider calls,
threshold changes or updates to the original development selection. Both splits
had already been inspected, so these additional results are exploratory.

| Locale / split | Baseline hit@5 / nDCG | Original content proxy | Corrected content query | Corrected nDCG delta versus baseline |
| --- | --- | --- | --- | --- |
| en / dev | 43/44 · .957 | 41/44 · .941 | 41/44 · .942 | -.0143 |
| es / dev | 42/44 · .898 | 42/44 · .896 | 42/44 · .897 | -.0001 |
| fr / dev | 43/44 · .819 | 43/44 · .827 | 43/44 · .815 | -.0043 |
| en / held-out | 43/44 · .886 | 43/44 · .889 | 42/44 · .880 | -.0051 |
| es / held-out | 42/44 · .850 | 42/44 · .849 | 42/44 · .849 | -.0012 |
| fr / held-out | 40/44 · .809 | 41/44 · .816 | 40/44 · .807 | -.0014 |

French's apparent hit gain disappears after correcting re-stemming. The
corrected query loses one English held-out hit and preserves Spanish and French
hit counts, with slightly lower ordering scores in all three. This control
provides no evidence for adopting the proposed Latin all-content handling.
The CJK and normalization comparisons did not use this Latin re-stemming path
and are unaffected.

## Uncertainty and scope

The paired bootstrap resamples source families within controlled and natural
strata, preserving every query form of a family. It uses 2,000 draws and seed
20260913. With only four held-out controlled families per locale, these are
descriptive intervals, not population guarantees. They do not adjust for the
many comparisons.

| Held-out comparison | Category-balanced nDCG delta | 95% family bootstrap interval |
| --- | --- | --- |
| Japanese segmented versus baseline | -.041 | [-.071, -.008] |
| Korean segmented versus baseline | -.058 | [-.092, -.026] |
| Japanese content proxy versus baseline | -.014 | [-.030, -.002] |
| Korean content proxy versus baseline | +.010 | [.002, .020] |
| Chinese normalized versus baseline | -.001 | [-.004, .003] |
| Hong Kong segmented versus baseline | -.031 | [-.062, .000] |

The Korean content result merits a future test, but its development result did
not qualify and its held-out improvement is small. Chinese normalization's
development hit gain did not recur on held-out questions. Taiwan and Hong Kong
have only the controlled source families; their high scores cannot establish
regional-language coverage. OpenCC character conversion also does not establish
equivalence between regional vocabulary or Cantonese phrasing.

The controlled sources repeat one document template with different topics,
sizes, colours and identifiers. They test defined contrasts, not the diversity
of uploaded materials. Hard negatives share most wording, but the identifiers
were still easy for the current embedding model. Natural pools preserve the
earlier selected questions and judged negatives, not the full Wikipedia corpus.
The development and held-out split prevents shared positive source families,
but does not make this previously inspected public subset a new unseen benchmark.

These results support testing language-level text handling as a component,
while preserving semantic retrieval and measuring lexical candidate coverage.
They do not justify replacing bigrams wholesale, enabling a universal all-term
boost, or choosing per-language fusion weights. No phrase-specific rules were
added and no production ranking setting changed.

## Artifacts and verification

Tracked input and scripts:

- `bench/rag/fixtures/multilingual-language-handling.json`
- `bench/rag/scripts/build_multilingual_handling_fixtures.py`
- `bench/rag/scripts/multilingual_handling_eval.py`
- `bench/rag/scripts/summarize_multilingual_handling.py`
- `bench/rag/scripts/posthoc_latin_query_control.py`

Raw files are preserved in the ignored local directory
`bench/rag/reports/local/2026-09-13-multilingual-language-handling/` and the VM
scratch directory `/tmp/capy-multilingual-20260913`. They include the exact
prepared corpus and queries, input hashes, dependency freeze, provider receipts,
3,778 cached response vectors, both complete result files, the original
selection, per-query gains/losses and bootstrap output. Provider credentials
were neither recorded nor printed. Full HTTP response bodies were not retained;
the vector cache and receipts retain embeddings, usage, model, status and timing.
The original archive occupied about 85 MiB locally.

| Artifact | SHA256 |
| --- | --- |
| Controlled fixture | `5b998327e2acaa19164f5f66997fb15d3f80562c6b1e45fa98a17a7d609c26d4` |
| Prepared snapshot | `34f3b67f83601d33e4a3938efea87d59f2b919a73aa464c6b80540a45408c96a` |
| Frozen scorer | `0f42b4f0c3a1f707cc2b76bac3fc47d2fd05e22d5a15f32c9370b3cb7f69d5bb` |
| Development result | `313ff544b59b81ac988cf88bebefd5ce9728e68221f965224835b4d5590ad2af` |
| Original selection | `f6b818121f43d174ef1f57ca448282b4dc1d90587bf15a566a4d5f29a03ecaf9` |
| Held-out result | `1a6e534a7b1e0c15826654e9a6c8031bbfba5b48bdfd1e4f236ca60ee5bb8e4b` |

The scorer's checks verified passage-position metrics, duplicate-source
discounting, per-file overflow order and source-group split integrity before
the run. The final audit verified all 3,120 unique query/method records, identical
dense ranks and distances across methods, and remote/local hash parity for the
fourteen original artifacts. The post-hoc audit verified 264 additional unique
rows, identical dense values, an unchanged selection hash and parity for all
eighteen source/result artifacts, excluding generated Python bytecode.
Python compilation and explicit Ruff formatting
and checks passed for the new scripts. Root Ruff configuration force-excludes
`bench`, so the explicit checks disabled that exclusion. No application test
suite or runtime was changed by this benchmark.

After the archive checks, both experiment containers were removed and verified
absent. The existing worker, parser services, retained labs, UAT index and UAT
settings were unchanged. The VM scratch directory and local artifacts remain
available. `cleanup.json` records the exact removed resources.

To inspect without provider calls, run the summarizer against the retained local
directory. To repeat retrieval, retain the frozen image and dependencies, mount
the raw snapshot at `/experiment`, start a disposable PostgreSQL at the recorded
loopback DSN, and use a new output directory. The scorer stages are `check`,
`freeze`, `embed`, `dev`, `heldout`, each followed by the experiment directory.
`embed` makes paid calls and is unnecessary when using the retained vector cache.
The correction script uses `run EXPERIMENT_ROOT`; it never calls a provider.

Earlier context remains in the
[JLPT lookup ablation](2026-09-13-jlpt-lookup.md),
[public retrieval report](../broad/reports/2026-09-05-broad.md) and
[embedding comparison](../embedding/reports/2026-09-06-embedding.md).
