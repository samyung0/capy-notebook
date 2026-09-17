# Shared ODL recovery fix

Date: 2026-09-16. Local implementation and verification; no deployment.

## Change

The ordinary parser and the knowledge-base pilot now share two corrections:

- Repeated-text furniture candidates stay frozen before table recovery. Each
  occurrence wholly inside x=50–950, y=100–900 survives packing, preserving body
  formulas and table labels. Margin copies retain the existing deletion rule.
- Before table recovery, literal source matches can remove heading status from
  numbered captions and separated unbold labels. Repeated folio banners become
  discarded blocks. Text and source boxes survive in the bundle. PDF outline
  matches and recognizable section-number prefixes are protected; ambiguous
  source matches abstain.

Parser identity is `odl-2.5.7-refined-rapidocr-v4`; chunker identity is `v10`.
Existing artifacts and indexed content therefore cannot silently claim the new
behavior. There is no automatic MinerU/Qwen routing in this change.

## Fresh full-book verification

Five entire PDFs, 2,206 pages, passed through the local HTTP parser, bundle
validation, production packing, heading retention and extraction confidence.
No embedding, database, B2 or existing pilot-job writes were performed.

| Book | Pages | Previous chunks | Fixed chunks | Frozen checks before → after |
| --- | ---: | ---: | ---: | --- |
| OpenIntro Statistics 4e | 465 | 1,341 | 1,255 | 0/5 → 5/5 |
| Advanced High School Statistics 4e | 514 | 1,419 | 1,334 | 0/2 → 2/2 |
| Learning Statistics with jamovi | 495 | 1,101 | 1,090 | 0/3 → 2/3 |
| Exo7 Analyse | 207 | 491 | 426 | 12/14 → 13/14 |
| Hefferon Linear Algebra 4e | 525 | 1,022 | 1,012 | 4/13 → 12/13 |

These are selected, source-reviewed checks, not document accuracy percentages.
A body-text pass requires the matching raw block’s own page and box in the chunk.
Table-header words found only in prose or in overlap from another page do not
count. Tightening this binding corrected the preliminary new-family baseline
from 19/27 to 16/27; candidate remains 25/27. The source gold did not change.
The first three books developed the rules. Exo7 and Hefferon are independent
families: hashes and source checks were frozen before inspecting candidate
outputs. Their previous baseline was freshly parsed using the old image and a
git-archived copy of the old pipeline. The original three baseline corpora remain
the immutable pilot outputs.

All five previously deleted formula fragments survive. Four of five false-parent
witnesses are corrected. On the original three books, the fresh output's text,
section paths, page bounds and every citation region exactly match the selected
pre-implementation saved-block experiment. The comparison normalizes the pilot's
extra `space` field in region serialization. Moving role correction before table
recovery did not change those expected results.

The new families improve from 16/27 to 25/27 checks. Exo7 loses 152 recurring
banner headings; Hefferon's repeated interior table labels survive. Chunk counts
can fall while body text increases because false headings previously caused
unnecessary splits.

## Remaining failures and limits

- LSJ PDF page 369 still has a table body acting as a parent for four chunks.
  The native box mixes source spans, so the role correction abstains.
- Exo7 PDF page 84 still merges the main section heading with the top banner
  into a table-like block. The heading remains in body text but does not become
  the correct parent. This failure also exists in the old baseline.
- Hefferon PDF page 180 retains `Chapter Two. Vector Spaces` as a page-banner
  parent. Other widely separated banners are demoted by the separated-label
  heuristic and remain body text. Its `_source_role: diagram-label` records the
  heuristic taken; it is not a calibrated semantic label.
- Native fractions, symbol binding and table cell associations are unchanged.
  Keeping `√` or `t =` does not reconstruct a correct equation.
- Interior repetition can also be boilerplate. Retrieval cost and relevance need
  separate measurement; this change does not establish their improvement.
- Existing extraction confidence is unchanged and can be high on these failures.
  A low-score-only review queue will miss them. Selection needs structural checks
  and sampling of high-scoring passages as well as source-image verification.

The [matched selective recovery experiment](2026-09-16-selective-recovery-comparison.md)
tests MinerU against asynchronous Qwen on identical visual crops, including six
formula tables. Manual crop selection does not measure automatic region recall
or prove safe replacement of a whole exercise.

## Checks and reproducibility

- 133 parser-client, packing, chunking, source-grid, layout and refinement tests
  pass, including the expanded 9-case source-role suite.
- All 26 parser-service tests passed in the Linux parser container. The Windows
  persistent-child test stalled, so it was interrupted. The first Linux harness
  attempt lacked pipeline dependencies; installing them resolved the failures.
- The 204-chunk Hong Kong golden is copied byte-for-byte from the earlier
  recovery experiment, with its original 200-chunk lab artifact retained.
- Independent review found a numbered-prefix demotion case. Roman, letter,
  Arabic closing-parenthesis and fully parenthesized prefixes now retain their
  source-backed section ancestry; the original reviewer confirmed the fix.
- A fresh closing review found no further actionable defect. Its subsequent
  check of the scorer's own-page/box binding confirmed the corrected 16/27
  baseline and 25/27 candidate totals.

Runners: [verify_odl_textbook_fix.py](../scripts/verify_odl_textbook_fix.py) and
[score_odl_textbook_fix.py](../scripts/score_odl_textbook_fix.py).
Sources: [selective-recovery-sources.json](../fixtures/selective-recovery-sources.json).
Ignored receipts: `bench/parsers/reports/local/2026-09-16-odl-shared-fix/`.

Use the verifier's required `--manifest`, `--config`, `--run` arguments. The
baseline additionally supplies `--pipeline-root` pointing at `git archive HEAD
pipeline` extracted before these changes. The scorer takes `--run` and
`--output`; `--legacy-run data/knowledge-base-pilot/run` supplies the original
three immutable corpora when scoring the two newly parsed baseline books.

Initial records are `candidate-score.json`, `baseline-score.json` and
`prototype-comparison.json`. The final run uses a frozen source snapshot,
identified as `local-odl-fix-b3fa048946997fb5`; its full hashes and code are in
`final-source-hashes.json` and `final-code/`. This is a local uncommitted-code
identity, not a deployed Git release. Hashes still match the working tree.

The final five-book run returned identical content-list bytes and complete chunk
records, including confidence and citation geometry, to the initial candidate.
It took 294.30 seconds of parser execution, or 296.45 seconds including service
overhead, on four CPU cores with a 7 GiB container limit and no queue wait.
Per-book execution was 59.55, 42.67, 136.06, 23.24 and 32.78 seconds in table order.
These are local run observations, not a controlled throughput estimate.
`final-score.json`, `final-comparison.json` and `verification-status.json` contain
the final receipts. Disposable verification containers are stopped; the separate
pilot remains intact.
