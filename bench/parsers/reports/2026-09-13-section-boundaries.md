# Narrow section-boundary experiment

## Decision

Do not adopt the adjacent-atomic boundary rule. It fixes the observed JLPT
contamination with only `+1.27%` overall chunk growth, but it also separates
related native table fragments. In the clearest regression, the ResNet Table 3
answer-bearing chunk falls from dense rank 1 to 19. The candidate also makes
three of four JLPT label-style dense queries materially worse.

The useful result is narrower: the Question 10 opening can exclude Question 57's
choices while retaining the first continuation line. That behavior needs a rule
which understands list-role transitions and keeps table fragments together. An
unconditional boundary between adjacent lists/tables is still too broad.

No parser, retrieval service, database, worker, or application behavior changed.

## Frozen candidate and sources

The sole candidate inserts a packing boundary between two consecutive refined
native list/table blocks unless ODL records a reciprocal same-type continuation
at the same level within one page. It contains no language-specific phrases and
uses no active-file hint. Missing or equal adjacent native IDs are rejected; the
13-source corpus contained no such pair. The ODL relationships pass mechanical
rules and were not individually validated by a person.

Both arms run identical frozen blocks through the complete current chunking
stages: `pack_blocks`, `retain_headings`, and `score_chunks`. The baseline is a
current replay over frozen refined artifacts. It does not rerun conversion and
refinement for every preserved source. Spanish, Korean, Hong Kong Chinese, and
Taiwan Chinese were freshly converted and refined for this round; nine other
real PDFs use preserved complete refined artifacts. The corpus covers English,
German, Spanish, French, Japanese, Korean, Simplified Chinese, Hong Kong Chinese,
and Taiwan Chinese.

The candidate, protocol, source hashes, 21 legacy questions, five original JLPT
queries, and the independent 28-case locator fixture were frozen before scoring.
Most sources were already used in parser development; the Korean paper is new
in this round. The control labels are agent-authored, and no unseen held-out
claim is made. Seven preserved baseline chunk files drift from the current
replay because chunking code changed after those files were saved. This is
recorded as lineage drift. Both measured arms use the same current code and
source preparation.

## Structural results

| Measure | Current | Candidate |
| --- | ---: | ---: |
| Chunks | 946 | 958 (`+1.27%`) |
| Mean estimated tokens | 221.9 | 217.5 |
| Median estimated tokens | 239 | 235 |
| 95th percentile | 398 | 398 |
| Cross-page chunks | 76 | 73 |
| Mean source regions per chunk | 4.107 | 3.989 |
| Mean confidence | 0.97994 | 0.98022 |
| Confidence below 0.7 | 6 | 6 |
| Frozen body-text probes complete | 13/19 | 13/19 |
| Frozen body-text probes clean | 12/19 | 13/19 |

The rule makes 34 cuts across six sources. Growth is uneven: JLPT grows from 56
to 63 chunks (`+12.5%`), ResNet from 63 to 66, CamemBERT from 44 to 45, and Hong
Kong in Figures from 195 to 196. Spanish and Korean each have candidate cuts but
no chunk-count increase. The other seven sources are unchanged.

Heading inheritance uses the same code in both arms. Eight section paths have
more chunks because of the new boundaries; no section path is introduced or
lost. The 19 structural probes test exact anchors in chunk body text. Some frozen
section anchors live only in indexed heading context, so `13/19` is not a parser
extraction rate. In the stricter locator cohort, 14 of 15 positive cases have a
source/page/canonical-anchor qrel in indexed text in both arms. The remaining
Hong Kong table has the visually correct text but a duplicated compatibility
glyph in extraction.

## JLPT incident and passage continuation

| Measure | Current | Candidate |
| --- | ---: | ---: |
| Body characters | 439 | 342 |
| Frozen Question 10 opening anchors | complete | complete |
| Question 57 answer-choice contamination | present | absent |
| First continuation line `①…` | next chunk | included |
| Source regions | 2 | 2 |

The current regions are the previous choices at page 10
`[151.220, 291.509, 786.165, 361.385]` and the Question 10 opening at
`[151.220, 365.661, 848.861, 528.146]`. The candidate drops the previous-choice
region and adds the direct continuation at
`[151.220, 532.446, 695.458, 546.699]`.

Neither arm contains the full Question 10 passage in one chunk. The remaining
paragraphs continue in subsequent chunks on pages 10 and 11. “Complete” here
means only that all three pre-frozen opening anchors occur in one chunk. The two
candidate boxes are block-level ODL regions, not glyph-accurate cited-text boxes.
A citation locator still has to resolve the cited substring inside those regions.

## Dense retrieval

All changed passages were freshly embedded with pinned
`Qwen/Qwen3-Embedding-4B` vectors at 2,560 dimensions. Exact matching vectors
from the prior controlled run and the five original JLPT query vectors were
reused. The provider embedded 419 new inputs in seven successful one-shot
requests and reported 108,194 tokens; no request was retried.

The offline scorer formats values to six significant digits, quantizes them to
IEEE binary16 storage precision, and uses a float32 exhaustive cosine scan. It
takes 40 dense candidates, applies the production soft cap of four chunks per
source, and retains five. This is a deterministic stored-precision diagnostic.
It does not reproduce PostgreSQL's halfvec operator arithmetic or HNSW
approximation exactly.

### Original JLPT queries over all 13 sources

Relevance requires all three frozen Question 10 opening anchors in one indexed
chunk. Cleanliness separately excludes the frozen Question 57 choice.

| Query | Current rank | Candidate rank | Returned current/candidate |
| --- | ---: | ---: | ---: |
| `question 10 reading comprehension passage N1` | 24 | 42 | — / — |
| `問題10 次の文章を読んで 読解` | 16 | 32 | — / — |
| `問題 10 次の文章を読んで` | 13 | 28 | — / — |
| `問題 10` | 25 | 24 | — / — |
| Subject question about cyanobacteria and humans | 1 | 1 | 1 / 1 |

The candidate improves the subject-question cosine from `0.57579` to `0.74760`
and makes that returned chunk clean. Three label-style queries regress sharply;
one improves by one rank. Required-anchor Hit@5 remains `1/5`. Clean
required-anchor Hit@5 changes from `0/5` to `1/5`, solely on the semantic query.
This supports structured locator handling for labels rather than relying on a
chunk boundary to improve every query form.

### Independent locator controls

The locator cohort has 15 positive and 13 abstention cases over an exact
eight-source workspace. Strict relevance requires the frozen source, physical
page, and every canonical anchor. Four initial qrel sets included repeated
inherited headings on wrong pages; a preserved post-hoc label audit applies the
missing page constraint. It narrows those sets without changing either arm's
headline result: 14/15 positives are measurable and 3/15 are returned in the top
five. All 13 abstention cases remain in the raw record and are not treated as
dense-retrieval successes or failures.

The meaningful rank changes are mixed. The Japanese Question 10 locator moves
from 14 to 28, the bare Question 57 locator from 22 to 21, the Korean Table 1
locator from 47 to 34, and the Hong Kong printed-page locator from 83 to 86. The
candidate does not improve overall locator retrieval.

### Legacy questions over all 13 sources

| Gold-page proxy | Current | Candidate |
| --- | ---: | ---: |
| Hit@5, all 21 | 18 | 18 |
| Hit@5, 19 answerable | 17 | 17 |
| Hit@5, 2 unanswerable/counterevidence | 1 | 1 |
| Mean reciprocal output rank | 0.7302 | 0.6921 |
| Mean first dense qrel rank | 2.57 | 2.76 |

These labels count any chunk that overlaps a frozen evidence page. They do not
measure answer accuracy or literal answer-span retrieval. The two unanswerable
cases retain counterevidence labels and are reported separately.

The main regression is stronger than the page proxy shows. For the pre-frozen
ResNet Table 3 question, the current answer-bearing chunk includes the model
rows, error values, caption, split, and crop setting at dense rank 1
(`0.63439`). The candidate separates native table fragments: the values remain
in a chunk at rank 19 (`0.49228`), while a caption/context fragment reaches
output position 5. The page proxy records a hit at 5 even though that returned
fragment lacks the requested values. This is direct evidence that the candidate
boundary is unsafe for tables.

## Recommendation

Keep the current runtime chunking for now. The next structural experiment, if
needed, should preserve a complete table and its caption as one relationship
group and limit list boundaries to generic role or numbering transitions with
stronger evidence than adjacency. It should be judged on frozen answer-bearing
spans, not page overlap alone.

For the incident itself, the candidate demonstrates cleaner block regions
without changing ODL. A separate citation locator can keep the indexed chunk,
map each cited substring to its contributing native region, and then narrow
within that region. This experiment does not establish glyph-level locator
accuracy.

## Reproduction and artifacts

```bash
PYTHONPATH=pipeline uv run --with pymupdf \
  python bench/parsers/scripts/section_boundary_eval.py evaluate
PYTHONPATH=pipeline uv run --with numpy --with httpx --with pymupdf \
  python bench/parsers/scripts/section_boundary_eval.py check-embeddings
PYTHONPATH=pipeline uv run --with numpy --with httpx --with pymupdf \
  python bench/parsers/scripts/section_boundary_eval.py score-dense
```

These are stage examples for a new isolated run: the default commands refuse to
overwrite the completed artifacts, and the final linted runner intentionally
differs from the frozen scoring hash. `freeze`, `freeze-embeddings-v2`, and
`freeze-dense-score` must precede their corresponding stages in that new run.
The exact historical provider and dense runners are retained as immutable
as-run snapshots. Provider access is required only for missing vectors. Raw
inputs, chunks, vectors, full ranks/cosines, uncapped and capped top-five text,
provider receipts, amendments, and cleanup evidence remain under the ignored
`bench/parsers/reports/local/2026-09-13-section-boundaries/` directory.

| Artifact | SHA-256 |
| --- | --- |
| Fixture | `7e277e4d95f65e016b2e2a00e4166f879e56dfd35af70f1cdeda003c0405d992` |
| Structural result | `411d23983199420dc5fe8e455dece1e6116694593d9ded742604c21a285cc680` |
| Ranking export | `f0610ac06fd27c3afd85a758b84a2657538b72de0da5e737d9ab9f34c2a6d86d` |
| Frozen embedding inputs | `03d776238d14890ac72337bb41b524a537155523a908b907ca5644d83fe89ba5` |
| Vector database | `b5bdb8ff343f3a5519d3b8bc40f529291ba749f0c820f7b3cb76032fdd6a9e47` |
| Provider receipts | `507ffcc7ad0993da3653b6ca50595d20e69f67b315c283f179f179452a6eefd3` |
| Dense results | `99ffb985d0e9bc14355a87dc12dd3482617133471cefd22f3fc08f0b6e774ad5` |
| Strict locator-page audit | `7e80ad71521be8cd69aa60e6f5b8a74ee7a749ea95b2302078d3c2d2ef300ede` |
| Closing lineage | `772c6503753dc9d6f375644cc9740fb426ed47dba84072371b02b6d31f49bde3` |
| Resource cleanup | `b319f7f115a3b776939a95c0a32c8c1585ae9cf2c19021110d8b5d6c826116ce` |

The closing lineage records the exact prior primary embedding freeze and
completion receipts used for cache reuse. The cleanup receipt confirms no live
benchmark/provider process and no application or remote service mutation.
