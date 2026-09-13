# Structured locator experiment

The frozen candidate finds the correct passage for all four known JLPT locator
queries. It also promotes every deliberately supplied orphan heading and prose
cross-reference. This supports testing structured document units, but does not
support adopting this label-only candidate. On eight full PDFs, a separately
authorized punctuation control resolves all six table cases and JLPT question 10,
but misses all five section cases, the bare question marker and both page cases.
No application behavior changes. The reranker remains deferred and no active-file
state is used.

## Frozen question and candidate

Can typed printed labels identify a useful retrieval passage more reliably than
the current vector/lexical ranks when a query asks for a particular numbered
unit?

The single candidate recognizes question, section/chapter, table and printed-page
labels using a fixed grammar covering English, Japanese, Korean, simplified and
traditional Chinese, Spanish and French. All grammars are tried together. Numbers
normalize with NFKC, decimal components, ordinary Chinese numerals and canonical
Roman numerals. There is no query-language classifier or phrase-specific rule.

Metadata comes from typed labels at the start of a direct body line, native
heading/table/question/item labels, and explicitly supplied printed-page labels.
A bare native heading number is a section number. A bare list number becomes a
question only when native metadata explicitly identifies a question item.
Inherited `section_path` fields and physical page indices are excluded. Metadata
keeps its evidence text and provenance. The legacy multilingual cache has a
documented exception: its `text` field already embeds inherited heading prefixes.
The prefix audit below shows that none contributed a locator in this run.

A query must contain exactly one locator. Explicit filenames and source
references resolve by normalized exact text with ASCII filename boundaries, so
CJK particles may abut a filename. A filename-like reference causes abstention
when no known filename resolves. The candidate never receives a gold source ID as a query
argument. Multiple sources, multiple locators, missing labels, or more than one
matching chunk cause abstention and preserve the ordinary candidates.

One unique matching chunk is prepended to current hybrid top 40, followed by the
ordinary candidates in their original order. The existing per-file cap of four
and fill-to-five behavior still apply. This is one candidate, with no tuning or
post-outcome selection. A valid section spanning several chunks can therefore
cause abstention. A unique orphan heading or prose cross-reference can cause an
incorrect promotion; both are explicit controls.

## Frozen inputs and evaluation

- 216 hand-authored synthetic cases, 27 per locale across eight locales, over 144
  chunks. Each case has fixed useful-content labels and a promotion/abstention
  expectation. They include repeated numbers across and within files, direct
  source references, duplicate filenames, content numbers, native Roman headings,
  fullwidth and Chinese numerals, printed versus physical pages, unsupported and
  missing units, multi-unit requests, stale headings, cross-references, and
  orphan headings. Synthetic baseline order is a SHA256 permutation independent
  of labels. It tests decision logic and precision, not model retrieval quality.
- The known 624-query multilingual corpus plus five JLPT diagnostics use cached
  full cosine and PostgreSQL lexical scores from the BM25 experiment. Current
  RRF is reconstructed with the same lexical all-term ordering, short-query
  weight, top 40 bounds and diversity cap. Every baseline top 5 must exactly match
  its frozen historical list before results are exported. The 624 queries and
  their dev/held-out partition have already been inspected in earlier rounds.
- Root's 28 full-document controls cover eight complete PDFs, with 15 visible
  locator units and 13 expected abstentions. Root froze source/page anchors
  before candidate outcomes. Seven sources have prior exposure; the Korean paper
  is newly downloaded. These are authored diagnostics, not natural user traffic
  or untouched external validation. Exact filenames are in query text. Gold
  source IDs are used only for scoring.

The primary outcomes are promotions, useful-content promotion precision, false
promotions, abstention reasons, and before/after top 5 retrieval for the cached
queries. The full-document controls separately report correct source/page and
anchor presence, since locating a unit does not prove that the whole answer is
contained in the promoted chunk. Any full-document retrieval measurement needs
actual frozen ranks supplied with its input; otherwise it is extraction-only.

No embedding, reranker, database, or other provider calls are made by this runner.
No production ranking change is selected by this experiment.

## Reproduction

```sh
python3 bench/rag/scripts/structured_locator_eval.py check
python3 bench/rag/scripts/structured_locator_eval.py freeze \
  bench/rag/reports/local/2026-09-13-structured-locators \
  bench/rag/fixtures/structured-locators.json \
  bench/rag/reports/local/2026-09-13-bm25-fusion
python3 bench/rag/scripts/structured_locator_eval.py run \
  bench/rag/reports/local/2026-09-13-structured-locators
```

The optional `external OUTPUT CHUNKS_JSON` command freezes later native
full-document metadata against the same immutable candidate and root control
hash before scoring it. Raw evidence is retained in the ignored run directory.

## Cached retrieval results

All 629 current baseline lists reproduced exactly, in order. The candidate used
the original JLPT chunk bodies, excluding the stale inherited heading prefix.
The same direct `問題 10` body label uniquely identified chunk 30 across the
three-file scope for all four locator queries. No filename was resolved from
the partial `N1` mention, and no active-file ID was supplied.

| Known JLPT query | Current target position in top 5 | Locator position |
| --- | ---: | ---: |
| `question 10 reading comprehension passage N1` | Absent, fused rank 12 | 1 |
| `問題10 次の文章を読んで 読解` | Absent, fused rank 8 | 1 |
| `問題 10 次の文章を読んで` | 1 | 1 |
| `問題 10` | 2 | 1 |
| Japanese cyanobacteria/environment subject question | 1 | 1 |

Hit@5 and Recall@5 improve from 3/5 to 5/5. Mean nDCG@5 improves from 0.526186 to
1.0. All relevant chunks were already in current top 40, so this is a final
ordering improvement, not a candidate-recall improvement. It does not repair
the target's preceding-question contamination or stale inherited heading.

The 624 multilingual rankings are unchanged, including held-out Hit@5 304/312
and nDCG@5 0.826704. No chunk is promoted in that cohort. This is a narrow guardrail
result: its documents are mostly one chunk and it has few real printed-locator
requests.

Root's lineage review found that the original multilingual builder stores
`chunk.indexed_text()`, including heading prefixes, rather than a separate body.
Only JLPT had an independently preserved body that this runner substituted.
The follow-up read-only audit finds zero extracted locator records anywhere in
all 3,277 multilingual chunks, including their prefixes. Thus no inherited
prefix affected this run's matches or rankings. The original results remain
unchanged. This cached comparison nevertheless cannot substantiate a general
claim of body-only metadata extraction; the real-source input must carry direct
bodies and native provenance. See `legacy-prefix-audit.json`.

Zero promotions does not mean perfect query classification. The frozen grammar
misreads French `les parties d’un mémorandum` as Roman-numbered section D, or 500.
It also reads Korean `작업표 MX-489` as table MX, or 1010, before abstaining on the
trailing numeric expression. Neither has matching metadata, so neither changes
the result. These are latent false-promotion risks in a different corpus.

## Synthetic decision controls

These 216 cases measure the fixed decision rules against constructed failures.
Their shuffled baseline is not a current-model benchmark and its Hit/nDCG deltas
must not be interpreted as retrieval-quality gains.

| Measure | Result |
| --- | ---: |
| Cases expected to promote useful content | 88 |
| Correct useful-content promotions | 88 |
| Cases expected to abstain | 128 |
| Correct abstentions | 112 |
| Incorrect promotions | 16 |
| Useful-content precision among promotions | 88/104, 84.6% |
| Abstention specificity on these controls | 112/128, 87.5% |

Each locale contributes 11 correct promotions, 14 correct abstentions and two
incorrect promotions. Translation templates share the same structure, so these
are not eight independent demonstrations of regional-language performance.

The incorrect promotions are exactly the eight body cross-references and eight
orphan headings. For example, a chunk starting `Question 13` but merely pointing
elsewhere wins the unique-label gate. A chunk containing only `Question 15`
also wins over the separately packed answer passage. In the fixed shuffled
English orphan-heading control, this promotion displaces the useful passage
from top 5. The other false promotions still harm the top result even when the
useful passage survives elsewhere in top 5.

Ambiguous numbers across files or within a file, duplicate filenames, unavailable
sources, multiple requested sources/units, missing labels, ordinary content
numbers and stale inherited headings preserve the ordinary results. Explicitly
supplied printed page 12 resolves independently of physical page 12; a request
for page 20 finds no printed-page metadata despite one chunk's physical page
being 20. This tests a typed metadata distinction, not PDF footer extraction.

## Full-document extraction and resolution

The input is the chunk worker's complete current and adjacent-boundary exports,
filtered to exactly the root fixture's eight source IDs before any matching.
The current pool has 391 chunks; the boundary candidate has 399. The other five
exported sources are excluded. Both inputs contain direct bodies and native block
provenance, and neither supplies printed-page metadata. Source IDs do not enter
the query matcher; it resolves names from the original user text.

All 28 cases are retained, including all 15 positive units even when extraction
cannot represent them. Results are identical between the two chunking arms at
this resolution stage. This section measures unit location and metadata coverage;
it has no embedding/ranking quality denominator.

| Full-document outcome | Original frozen candidate | Post-hoc punctuation control |
| --- | ---: | ---: |
| Correct source/page promotions among 15 positive units | 4/15 | 7/15 |
| False promotions among 13 expected abstentions | 1/13 | 0/13 |
| Expected abstentions preserved | 12/13 | 13/13 |
| Correct source/page precision among promotions | 4/5 | 7/7 |
| Positive units left unresolved | 11/15 | 8/15 |

The original matcher rejects a sentence-ending period after a filename. Six
English, Spanish and French positive requests therefore fail source resolution.
In the two-source control it recognizes the first filename but misses the second
filename before the final period, wrongly promoting only BERT's table. It also
fails to parse `Find Table 1.` because of the final period. These implementation
failures remain in the original artifacts.

After observing this, the user authorized one separately frozen mechanical
control. `structured_locator_control.py` trims outer whitespace and a final run
of `. ! ? 。 ！ ？` from the query only. Internal filename dots and decimal
components remain, and the original query still defines the cached embedding and
baseline ranks. No metadata, labels, source resolution rules, or semantic
candidate behavior change. The wrapper was frozen before replaying the same
cases; no second correction was selected.

This control leaves every decision and ranking in the 216 synthetic and 629
cached cases unchanged. It repairs the three table requests blocked by filename
punctuation and the two-source abstention. The correct positive units are now all
six table cases, across English, Korean, simplified Chinese, Hong Kong Chinese,
Spanish and French, plus Japanese question 10. The body cross-reference and
orphan-heading failures in the synthetic set remain.

The eight remaining real-source misses are structural:

- The five section requests lack directly typed section metadata. For example,
  Korean Roman section III appears in inherited paths of its descendant chunks,
  while their associated native blocks are paragraphs. Chinese subsection
  `2.1.1` exists in a direct body but has native kind `list`, which the frozen
  candidate does not equate to a section.
- Japanese `57.` appears in an ordinary list, without a typed question item.
  Treating all list numbers as question numbers would create new ambiguity.
- No printed-page labels are supplied. The Hong Kong printed-page request is
  therefore uncovered. The explicit Taiwan PDF-page request is also uncovered;
  the candidate has no physical-page locator type. Both remain in the positive
  denominator.

The Hong Kong table resolves to the correct source and physical page 7. Its
literal raw caption `語⾔言功能規劃表` is present; the canonical visible caption
`語言功能規劃表` is absent. NFKC does not remove the duplicated glyph. This is a
source/page success with a text-extraction mismatch, not a repaired-text success.

Question 10 also illustrates the distinction between ranking and useful content.
The current chunk starts with the previous question's options; the boundary
candidate starts at the printed question-10 instruction. Both uniquely resolve
the locator. Metadata resolution alone does not measure that content improvement
or whether the entire passage fits.

## Full-document hybrid protocol

The subsequent ranking pass keeps the same 28 original queries and the exact
eight-source pool in each chunking arm. It uses the shared, validated
Qwen3-Embedding-4B vectors, formats their values to six significant digits, and
computes actual `halfvec(2560)` cosine distances in PostgreSQL 16.15 with
pgvector 0.8.6. Document language detection, reference-list lexical exclusion,
per-language PostgreSQL analyzers, `ts_rank_cd`, all-term priority, short-query
weight, RRF and the four-per-file/fill-five rule match current retrieval. Every
query/document lexical score is available. Exact scans and deterministic ID ties
are used for this small lab pool; this is not ANN or production latency testing.

Before scoring, root's source/page/anchor labels are mapped onto both chunk sets.
A labeled chunk must belong to the named source, overlap the frozen physical page
and contain every canonical anchor in its indexed text under NFKC and whitespace
normalization. Canonical and explicit raw-glyph labels are scored separately.
Direct-body matches and matches available only in inherited heading prefixes are
also recorded separately. All 15 positives remain in the denominator, including
the Hong Kong canonical table anchor's zero-qrel case. The 13 expected abstentions
are retained for promotion/unchanged-output checks.

The quality measures are unit Hit@5, unit candidate coverage in fused top 40, MRR@5
and discounted first-hit rank, `1/log2(rank+1)`. Multiple matching chunks are
alternative ways to reach one labeled unit. The discounted metric is not
multi-qrel nDCG and these labels do not establish complete-answer coverage.
The three conditions are current hybrid, the frozen original locator and the
separately frozen punctuation control. Only the locator matcher receives the
normalized query; all three share the original query embedding and lexical
scores.

## Full-document hybrid results

The deterministic current-formula replay scores 22,120 query/document pairs and
168 result rows: 28 queries, two chunking arms and three methods. The two chunking
arms have identical top 5 headline values below. Counts use all 15 positive units.
The 13 abstention controls retain the previously reported decisions: one false
promotion in the original candidate, zero in the punctuation control.

| Positive-unit measure | Current hybrid | Original locator | Punctuation control |
| --- | ---: | ---: | ---: |
| Canonical unit Hit@5 | 8/15 | 10/15 | 11/15 |
| Explicit raw-glyph variant Hit@5 | 8/15 | 11/15 | 12/15 |
| Canonical direct-body Hit@5 | 4/15 | 6/15 | 7/15 |
| Raw-glyph direct-body Hit@5 | 4/15 | 7/15 | 8/15 |
| Canonical MRR@5 | 0.355556 | 0.488889 | 0.622222 |
| Raw-glyph MRR@5 | 0.355556 | 0.555556 | 0.688889 |
| Canonical discounted first-hit rank | 0.401581 | 0.534915 | 0.650791 |
| Raw-glyph discounted first-hit rank | 0.401581 | 0.601581 | 0.717457 |

The ordinary current-chunk fused top 40 contains 11 canonical units and 12 under the
raw-glyph alternative. Original locator promotion raises these to 12 and 13;
the punctuation control raises them to 13 and 14. With boundary-candidate chunks,
baseline fused top 40 coverage is already 12 and 13, then remains 12 and 13 with the
original locator and reaches 13 and 14 with the punctuation control. This is
coverage of the final fused top 40 list, not the earlier dense/lexical union.

The source review covers every changed positive unit. Japanese question 10 moves
from outside top 5 to first. Korean table 1 does the same, entering from outside
current-chunk fused top 40, or rank 35 with the boundary candidate. Hong Kong table 1
moves from rank 34 or 35 to first under its raw-glyph label; its canonical caption
still has zero qrels and receives no canonical credit. The punctuation control
also brings French table 2 from outside fused top 40 to first. English table 1 and
Spanish table 3 were already at position 2 and move to first. Their promoted
chunks contain the frozen table captions and data, though this metric does not
judge full answer completeness.

No positive-unit Hit@5 is lost in either chunking arm. Three units remain missing
from top 5 even with the raw-glyph control: English section 3.1 at fused rank 6,
Japanese bare question 57 at rank 21, and Hong Kong printed page 6 outside fused top 40.
The candidate abstains on each because the required metadata is absent.

The boundary candidate alone leaves top 5 Hit unchanged at 8/15. It moves the
Korean table into fused top 40 but worsens the new named-file Japanese question 10
query's fused rank from 10 to 18. This is a different query from the five original
JLPT diagnostics. Cleaner passage boundaries therefore do not guarantee better
hybrid rank; their content benefits need their own measurement.

The labels also explain the gap between unit and body counts. English, Korean,
Spanish and French section anchors and the Taiwan page 14 anchor have no direct
body matches; they are available only through inherited heading prefixes. A
source/page match alone never receives canonical-anchor credit. This experiment
does not measure an agent resolving the filename through `list_sources` and
setting the existing `file_ids` filter. Its baseline searches all eight sources
with the frozen original query, and its locator leg resolves names independently.

## Tie sensitivity

Production SQL does not specify every tie order, so the new 28-case baseline is a
deterministic replay of the current formula, not a claim of exact production
ordering. Every feature set has some exact dense and lexical ties. The audit
finds 72 dense/lexical tie occurrences crossing rank 5 or 40, including 13 involving
a labeled chunk, and no fused-score ties crossing either cutoff.

Three alternative legal tie resolutions were checked: reverse ID order, labeled
chunks first, and labeled chunks last, applied only within equal per-leg or fused
scores. The latter two are adversarial verification, not retrieval methods or
tuning choices. Many complete top 5 lists change, but all canonical and raw-glyph
Hit@5 headline counts remain identical for all three methods in both chunking
arms. This is a sensitivity check, not an exhaustive proof over every possible
permutation. `scores-tie-audit.json` preserves the changed lists and boundary
groups.

## Interpretation

The experiment supports representing printed labels separately from semantic
text. It does not establish that a unique matching chunk is a safe final answer
passage. A useful next implementation candidate would need source-grounded unit
membership connecting headings, tables, question items and their content, with
distinct printed and physical page labels. That would also expose genuine
multi-chunk sections instead of treating repeated membership as ambiguity.

Neither the original candidate nor the punctuation control is selected for
runtime adoption. The known JLPT improvement is useful diagnostic evidence, while
the false promotions, missing section metadata and Roman-letter false detections
set concrete limits on the current design. Full-document controls remain
root-authored and small, and the cached regional-Chinese questions remain
synthetic. No result here establishes general production precision.

The source matcher also has an unmeasured edge: a query naming both one known
file and one unavailable file can resolve only the known file and proceed. The
unknown-source guard runs only when no known name resolves. This round tests
unknown-only and two-known-source requests, not that mixed case. Neither the
fixture nor the candidate was changed after this limitation was identified.

## Artifacts and verification

The candidate SHA-256 is
`a1215cd16abe771eb14a2849f61af6650d5d1aabb0df97c42052f04782053c18`.
The root control fixture SHA-256 is
`5138e7255ea97c4d19c818b52437481773326fcafa94a86465a95aceee8312ff`.
Both were recorded before outcomes. The ignored run directory contains
`freeze.json`, the executed runner snapshot, complete extracted metadata and
evidence, all 845 query records, grouped summaries and `integrity.json`.
The audit confirms unique records, exact reproduction of all 629 historical
lists, and unchanged outputs for every abstention. Explicit Ruff formatting and
checks, compilation and the focused parser self-check passed before freezing.

The punctuation wrapper SHA is
`3b71c137b0231c22c7c0af795b19b2d73931ad5adc623b6526d7d3dab8d637a8`.
The full-document scorer SHA is
`dc228d2fbc813c1f5cc83636c01f845f5cfa99e0f91128e657d6399ac0c5c290`.
`punctuation-freeze.json` and `scores-freeze.json` record their separate protocols
and input lineage before each run. The latter freezes the parent export,
structural results, source set, source/anchor labels, shared vector cache,
PostgreSQL version, analyzers and distance/ranking settings. Full scores, all
result lists, label mappings and receipts are retained. A setup-only collation
metadata query failed before the scorer freeze and was corrected; no quality
outcome was exported by that attempt. See `scores-preflight.json`.

The original and punctuation runners created no containers, copied no
credentials and made no network, database or model calls. The subsequent scorer
used one disposable PostgreSQL database on the authorized ingest host through
an SSH tunnel. It made no model calls. The database, its anonymous volume and
the tunnel were removed, with a cleanup receipt retained. Existing cached
experiment inputs remain unchanged. Remote round trips made the local scoring
pass slow; this is not a measured production retrieval latency.
