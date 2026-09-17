# ODL shared fix across more sources

Date: 2026-09-16. Local CPU benchmark; no deployment or index rebuild.

## Question and scope

Does the shared heading/furniture fix generalize beyond the original statistics
and mathematics examples, and does it slow ordinary parsing? The earlier new
books, Exo7 and Hefferon, were independently sourced but both mathematical.
This follow-up adds full textbooks from different subject/publisher families
and reruns historical multilingual, multicolumn, table, figure and OCR controls.

The production fix remains unchanged throughout this experiment. Frozen source
checks are in [the new textbook manifest](../fixtures/odl-broad-spectrum-sources.json).
The source reviewer inspected original rendered pages before any candidate
output. [Historical controls](../fixtures/odl-broad-spectrum-controls.json) are
explicitly reused controls, not unseen holdouts. Two scan pages with zero native
text were added before parsing those pages; the other NIST scan has an embedded
OCR text layer and does not exercise the OCR fallback.

## Measurement method

- Baseline: parser `odl-2.5.7-refined-rapidocr-v3`, chunker v9, pipeline archived
  from `b79795b4d4c973f6792405123d7c50d2987c5581`.
- Candidate: parser v4 and chunker v10 from the preceding shared-fix experiment.
  The production-file hashes remain pinned in `final-source-hashes.json`.
- Ryzen 7 3700X, 32 GiB host RAM; Docker has about 15.6 GiB available.
  Four isolated local Docker parser services, each limited to four CPUs and
  7 GiB memory, same Java/OCR dependencies. One full-document run at a time.
  Baseline/current order reverses in pass two. All queue times are zero.
- Separate spools and release identities for each arm/pass prevent parser
  artifact reuse. PDFs are intact and hash-checked. Native output then goes
  through that arm's real production packing and confidence code.
- **Execution seconds** cover fonts, Java ODL, structure, repairs and selective
  OCR. Java-only timing excludes those other phases. HTTP/artifact and local
  postprocessing times are recorded separately. Local postprocessing includes
  confidence, serialization, figures/excerpts, page counting and hashing.
- These runs call no language model, embedding service or database. Qwen Batch
  waits are a separate provider stage.

Only selected raw content/geometry fields are compared as multisets. The body
check looks for a previously visible whole non-heading text block at its own
page and citation box. Neither check proves reading order, complete table
meaning or full-document accuracy. The twelve historical heading controls are
the same narrow checks used in earlier experiments.

## Historical controls

Times are complete server execution in seconds, pass one / pass two.

| Source | Pages | Baseline | Fixed | Fixed OCR pages |
| --- | ---: | ---: | ---: | ---: |
| German education, rotated side tabs | 32 | 10.97 / 10.46 | 10.51 / 10.36 | 1 |
| Attention paper, multiple columns | 15 | 4.14 / 4.01 | 3.99 / 3.94 | 0 |
| Japanese migration tables | 54 | 12.23 / 12.96 | 13.19 / 12.88 | 1 |
| French TALN paper | 13 | 2.65 / 2.78 | 2.77 / 2.72 | 0 |
| Hong Kong statistical figures | 53 | 8.10 / 8.77 | 8.32 / 8.52 | 1 |
| NIST scan with embedded text | 8 | 2.56 / 2.31 | 2.50 / 2.51 | 0 |
| Spanish statistical figures | 60 | 15.10 / 15.56 | 15.12 / 15.89 | 2 |
| Chinese CCL paper | 16 | 6.27 / 5.38 | 5.63 / 5.71 | 0 |
| English newspaper, raster only | 2 | 16.85 / 17.69 | 16.93 / 17.30 | 2 |
| **Total** | **253** | **78.87 / 79.91** | **78.97 / 79.83** | **7** |

The fixed parser preserves all 12 historical heading checks in both passes.
The selected raw-field comparison and previously visible body-block check find
zero differences or losses. Chunk counts change on the Japanese migration,
Hong Kong and Spanish documents because heading/body routing changes; unchanged
text-field counters alone do not certify those structural changes.

The raster-only control is much slower per page than the digital documents:
about 8.5 seconds per page including OCR, versus about 0.25 seconds per page
across the other 251 pages. This is a two-page OCR sample, not a scanned-book
throughput guarantee. The totals show no material slowdown from this fix on
these controls; two passes are not a statistical confidence interval.

Raw content-list bytes and complete chunk records repeat exactly within each
arm on all nine controls. Receipt: `controls-repeat-equality.json`.

## New textbook quality

The [source review](2026-09-16-odl-broad-spectrum-source-review.md) records
editions, acquisition paths, licence evidence and frozen original-page checks.
The [output review](2026-09-16-odl-broad-spectrum-output-review.md) adjudicates
those checks against source locations, parser blocks and final chunks.

Generic string checks are only diagnostics. An inherited genuine heading can
share its wording with a running banner, and a correctly retained table label
may sit inside a merged text block. Those cases require source-bound review.
We do not convert the generic scorer's ambiguous pass/fail count into a parser
accuracy percentage.

| Source | Manually correct roles, baseline → fixed | Retained searchable body anchors, baseline → fixed |
| --- | ---: | ---: |
| Fundamentals of Cell Biology | 8/11 → 11/11 | 5/5 → 5/5 |
| Principles of Microeconomics | 9/10 → 9/10 | 3/7 → 7/7 |
| Simple Nature | 9/11 → 11/11 | 7/7 → 7/7 |

Physics's equation is a separate exact-math case, excluded from these two
columns. Its native text anchors do not establish a correct equation. All
seven frozen genuine-heading occurrences across the three books survive.

The matched first-pass review found these concrete effects:

- Biology: 339 running banners are discarded, removing footer text from 651
  chunk paths. All three frozen genuine-heading occurrences survive. Both
  membrane-protein column labels, the original caption and all three repeated
  `Included in coat` cells remain searchable.
- Economics: all four `Fish` / `Vegetable` diagram-label occurrences regain
  searchable text with their own citation regions. Both genuine headings,
  table row labels and the original caption survive.
- Physics: both genuine headings survive and both inspected running footers
  are discarded. The six table-header occurrences and apparatus caption remain
  searchable. The missing `K =` is restored at its own source box.
- Remaining defects: the biology membrane-protein table retains its strings
  but misorders row labels/values. Economics page 33 still promotes a running
  banner to a heading in both versions. The fix therefore transfers beyond the
  original books, but does not solve table structure or every banner format.
- Physics's kinetic-energy equation remains broken in both versions: the
  pieces appear as `1`, `2`, `mv2 [kinetic energy]`, then `K =`. Restoring a piece
  does not repair that fraction, exponent or reading order. All six frozen
  powers of ten also remain flattened, for example `103` and `10−2` instead
  of powers. Exact equation checks remain 0/1 and exact table-power checks 0/6.

The biology table-ordering error scores 1.0 with no confidence reasons. The
economics banner error scores 0.985 and 0.997, also with no reasons. Low-score
review alone would miss both. No production review selector was added here.
Physics's malformed power chunks score 1.0 and 0.992; equation chunks score
0.993 and 0.996, again without reasons.

Selected raw content/geometry fields are unchanged for all three new books, and no
previously visible non-heading text-block loss is found. These checks and the
manual witnesses remain narrower than complete textbook correctness.

## New textbook speed

Seconds are pass one / pass two on four CPU cores.

| Book | Pages | Baseline execution | Fixed execution | Fixed Java only | Fixed client parse + local postprocess |
| --- | ---: | ---: | ---: | ---: | ---: |
| Fundamentals of Cell Biology | 347 | 56.02 / 51.90 | 55.70 / 54.20 | 30.89 / 29.37 | 73.25 / 65.17 |
| Principles of Microeconomics | 478 | 43.29 / 45.96 | 49.82 / 47.28 | 10.34 / 9.96 | 53.73 / 51.31 |
| Simple Nature | 1,106 | 111.44 / 115.75 | 122.63 / 126.49 | 36.87 / 38.62 | 154.30 / 149.61 |
| **Total** | **1,931** | **210.74 / 213.62** | **228.15 / 227.97** | **78.10 / 77.95** | **281.28 / 266.10** |

Biology routes three pages to OCR; economics routes 21; physics routes 15.
Economics spends
26–28 seconds in OCR. Its fixed execution averages about four seconds longer
than baseline, including roughly two additional seconds in structural work.
This is a modest cost in this book, rather than evidence that the change has
zero overhead everywhere. Physics adds about 11 seconds of execution on
average, including roughly eight additional seconds in structural work.
Across these three books, fixed execution averages 7.5% longer, about 16 seconds
extra over 1,931 pages. Native Java remains 78 seconds combined; the complete
fixed parser takes 3 minutes 48 seconds. Client transfer/artifact handling and
local postprocessing bring the two measured passes to 4 minutes 41 seconds and
4 minutes 26 seconds. Baseline physics client time varies substantially between
passes even though its execution differs by only four seconds; the separate
boundaries prevent attributing that transfer/artifact variance to the fix.

All three books repeat exactly within each arm in raw content-list bytes and
final chunk records. Combined with the earlier five-book shared-fix experiment,
coverage now spans eight textbooks and 4,137 unique textbook pages. The nine
historical controls add 253 pages. This follow-up itself runs 2,184 unique pages
through both versions twice, rather than counting repeats as new coverage.

The largest recorded parser-container peak is 4.12 GiB against a 7 GiB limit;
no out-of-memory kill was reported. This establishes local parsing feasibility
for these inputs, not a concurrent production-load limit.

## Conclusion and validation

The unchanged fix transfers to additional source families: it removes genuine
running furniture and restores body fragments while preserving all seven new
genuine-heading controls. The retained failures show its boundary. It neither
reconstructs mathematical notation nor reliably identifies every table or
banner. Correct text retention, correct hierarchy and exact mathematical
transcription must remain separate acceptance criteria. Existing confidence
does not catch the demonstrated structural and mathematical errors.

All twelve inputs pass source-hash/page checks and retain exact outputs across
repeats within each arm. The compared selected raw fields show zero changes;
previously visible non-heading body-block checks find zero new losses. All
twelve historical heading checks pass. `final-audit.json` records version,
queue, repeat and production-file-hash checks. The unchanged production hash
spec contains thirty files. The source and output reviews were independent of
the parser implementation.

The new comparator's offline check, explicit Ruff checks, `pnpm run fmt:py`
and `git diff --check` pass. The formatter left all 128 considered files
unchanged. Temporary benchmark parser services were stopped after collection;
the original pilot and Qwen collector remain separate. No production parser
changes, new inference submissions, database/index writes or deployment were
made during this broader test.

## Reproduction and receipts

Large local outputs live under
`bench/parsers/reports/local/2026-09-16-odl-broad-spectrum/`.
`baseline-p1`, `current-p1`, `current-p2`, `baseline-p2` contain original parser
bundles and final chunks. Explicit `*-config.json` files record the local
ports, source-fingerprint release identities and artifact limits.
`controls-p1.json` and `controls-p2.json` hold per-source phase measurements
and checks. Baseline code is in ignored
`bench/parsers/scripts/local/odl-broad-spectrum-baseline/pipeline`.

Use [verify_odl_textbook_fix.py](../scripts/verify_odl_textbook_fix.py) with
`--manifest`, `--config`, `--run` and the baseline's `--pipeline-root`.
Use [compare_odl_spectrum.py](../scripts/compare_odl_spectrum.py) with explicit
baseline/current directories and one or more `--manifest` values. Its `--check`
mode verifies page/box isolation, duplicate counting and allowed role-only
changes. Production parser behavior is not changed by these helpers.
