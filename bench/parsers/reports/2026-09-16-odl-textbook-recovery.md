# ODL textbook recovery experiments

Two bounded changes improve the **shared production packer** on the saved
textbooks: preserve repeated text at body occurrences, and correct headings
whose source role is a running banner, caption or separated diagram label.
The selected combination restores all five pinned math fragments and removes
four of five pinned false parent labels. All 12 historical heading checks remain
correct. No production code, active pilot artifacts, database or Batch jobs changed.

**Stage limit:** these are saved **post-table** content lists, replayed through
current production `pack_blocks` and `retain_headings`. The original parser's
frozen furniture keys are retained; recurrence is never recomputed on these
lists. This verifies downstream effects, not the ordering of a fresh parser's
pre-table furniture freeze, table replacement and heading refinement. Fresh
integration validation is required before treating this as a production fix.

## Inputs, controls and frozen scope

The runner is [experiment_odl_textbook_recovery.py](../scripts/experiment_odl_textbook_recovery.py).
[textbook-recovery.json](../fixtures/textbook-recovery.json) froze source PDFs,
saved blocks, refinement bundles and saved chunks by SHA-256 before the first
candidate run. Textbook PDFs were checked against the pilot manifest; historical
PDFs were checked against each saved parser result's parsed-source hash.

The three development books contain 1,474 pages: OS4 465, AHSS4 514 and LSJ 495.
Their **3,861 saved chunks reproduce exactly in text, section path and page span**
(1,341 / 1,419 / 1,101). Confidence and saved IDs are not part of this equality.
Figures, embeddings and generation are outside this experiment.

Six historical controls add 175 pages: German education, Attention, Japanese
migration, French complexity, Hong Kong figures and NIST shot noise. The original
12 source-reviewed heading checks cover German, English, Japanese and French.
Hong Kong and NIST add output-preservation controls without a new accuracy gold.
Current packing differs from five of the six historical saved chunk files, so
candidate comparisons use a fresh **current-code replay baseline** on each frozen
bundle. NIST reproduces its saved text/path/page output.

These controls were frozen before the initial candidate run. They are familiar
historical material, not an unseen source family. This experiment establishes
known-case gains and historical retention; it does **not** establish independently
frozen positive transfer to a new family. A second replay of the selected old
heading-context bundles also preserves 12/12 checks, but was added after the main
run and is only supplementary retention evidence.

## Candidate arms

Every arm uses the same block order, original text, native metadata, table HTML,
page indices and boxes. Only selected `text_level` fields and deletion decisions
change. Assertions verify all other fields of surviving blocks remain exact.

### 1. Occurrence-specific furniture

The initial `furniture` arm deleted only repeated top/bottom occurrences whose
literal text, position and source style were confirmed. It restored every old
furniture-key occurrence in these nine documents, including unwanted German
rotated sidebar tabs. **Reject this broad version.** Keeping only positively
confirmed margins weakened existing decisions elsewhere.

The selected `interior_furniture` arm is smaller: apply the old frozen-key
decision everywhere, except when that particular block lies wholly inside
**x = 50–950, y = 100–900** on the parser's 0–1000 page grid. Preserve those body
occurrences. Missing, malformed, edge-crossing and side-margin boxes keep their
baseline handling. This leaves explicit parser furniture types unchanged and
does not require inspecting the PDF. The revised rule was frozen in `r2` after
the `r1` sidebar regression; it is development tuning, not an untouched holdout.

### 2. Source-role heading correction

- **Running banner:** native heading wholly inside the thin top/bottom band
  (0–65 or 935–1000), exact text match against the PDF spans in its own box,
  isolated decimal folio at one edge, and at least three pages sharing the
  remaining title, printed-folio offset, position, font and size. The occurrence
  loses heading status and is removed from packing.
- **Caption:** a source-matched body heading beginning with numbered English
  `Figure`, `Fig.` or `Table` loses heading status and stays as literal body text.
- **Separated labels:** a source-matched body heading made of unbold spans on
  one baseline, separated by a gap of at least four font sizes, loses heading
  status and stays as body text. Numbered section-like starts abstain.
- A heading matching the PDF outline's page and title is protected. Rotated pages
  and unmatched source regions abstain. The English caption rule intentionally
  makes no multilingual caption claim.

`headers` applies banners only; `roles` adds captions and separated labels while
keeping old furniture; `interior_combined` adds the selected furniture guard.
The rules contain no book IDs, expected answer text or witness labels.

## Measured textbook effects

Counts below include front matter and all packed chunks. They therefore differ
from the searchable-only counts in the [structure baseline](2026-09-16-odl-structure-baseline.md).

| Measurement | OS4 | AHSS4 | LSJ |
| --- | ---: | ---: | ---: |
| Baseline chunks | 1,341 | 1,419 | 1,101 |
| Selected combined chunks | 1,255 | 1,334 | 1,090 |
| Original frozen-key deletions | 898 | 840 | 92 |
| Body occurrences restored | 856 | 787 | 79 |
| Original deletions retained outside body | 42 | 53 | 13 |
| Source-supported banners removed | 411 | 466 | 0 |
| Baseline chunks with those banners in their path | 607 | 694 | 0 |
| Selected combined chunks with those banner labels | 0 | 0 | 0 |
| Caption / separated-label headings demoted | 25 / 3 | 19 / 2 | 10 / 0 |
| Matched PDF-outline headings still visible, baseline and candidate | 12 | 165 | 351 |
| Excerpt groups, baseline → selected combined | 890 → 695 | 990 → 775 | 435 → 424 |

All **1,722 restored body occurrences** have their cleaned literal text in a
resulting chunk carrying that occurrence's own original page and bounding box.
This is stronger than finding the same value somewhere on the page. It is a
presence/conservation check, **not a claim that all 1,722 fragments are correct
math or useful teaching content**. Extra repeated interior labels, chart values
and possible interior boilerplate were not exhaustively source-reviewed.

| Frozen witness | Baseline | Selected combined |
| --- | --- | --- |
| OS4 p54 `√` | Absent from body | Present with its source region |
| OS4 p193 `SEpˆ =` | Absent | Present with its source region |
| OS4 p193 `p(1 − p) n` | Absent | Present with its source region |
| OS4 p193 `= 0.010` | Absent | Present with its source region |
| LSJ p243 `𝑡 =` | Absent | Present with its source region |
| OS4 p198 chart labels | Parent of 86 chunks | 0 parent paths; literal body retained |
| AHSS4 p214 chart labels | Parent of 301 chunks | 0 parent paths; literal body retained |
| AHSS4 p134 `Event Garage full` | Parent of 161 chunks | 0 parent paths; literal body retained |
| LSJ p412 Figure 15.13 caption | Parent of 5 chunks | 0 parent paths; literal body retained |
| LSJ p369 table body | Parent of 4 chunks | Still parent of 4 chunks; abstention |

The LSJ table box includes additional source text, so its literal source-region
match fails. This candidate does not infer table cells or repair that heading.
Two additional separated-label matches, OS4 p115 `Inoculated Result` and p116
`Midterm Final`, were visually confirmed as tree-diagram columns **after** the
candidate run. They support the role interpretation but are not independent gold.
The 54 caption candidates were text-inspected; their detection count is not a
source-reviewed precision score for every affected page.

**The math remains structurally wrong.** Restoring a root or formula fragment
does not reconstruct fractions, attach radicals to the right expression or fix
reading order. OS4 p431's `27/212 → 21227` is already damaged in native output.
No missing-ToUnicode CMEX rewrite, fraction reconstruction, OCR or transcription
was run in this lane. The source coefficient typo in AHSS4 remains a source typo.

## Regression and downstream checks

- **12/12 historical section checks pass in baseline and every candidate**, using
  the original historical judge, including all matching overlap copies. The six
  non-German checks are historical transfer/retention controls, not new gains.
- The source-role arms make no changes to the six main historical control
  outputs. The body guard restores 27 / 71 / 1,001 / 0 / 76 / 16 occurrences in
  German / Attention / Japanese / French / Hong Kong / NIST respectively. All
  survive with their exact original region. Their semantic value was not fully
  reviewed. Japanese chunks increase 152→171 and estimated body tokens about
  14.2%; this cost needs retrieval measurement before claiming an overall gain.
- All 528 matched textbook outline headings and all 40 matched historical
  outline headings remain visible. This checks the subset that matches the PDF
  outline, not every genuine heading in a book.
- No previously visible non-heading body block disappears under the diagnostic
  (whole-block literal text that was present at baseline). This does not score
  every already-split fragment or prove semantic completeness.
- Every output region equals an original input block's page/box. All 45 main
  arm/document outputs pass actual `build_excerpts` checks for exact membership,
  concatenated text and region conservation. No figure records were supplied, so
  figure associations and generated excerpt material are untested.
- Actual `Passage.as_citation` and `citation_regions.resolve` were exercised on
  witness-bearing and historical probe chunks. The selected arm's 22 passages
  preserve snippet/chunk identity and valid page/box contracts; four resolve to
  tighter boxes. Most textbook math chunks retain their original boxes because
  their full text does not match native source order. This is citation integrity,
  not proof of mathematical accuracy or tighter citations for repaired math.

### Scorer correction

The original `r1`/`r2` receipts falsely report five German failures because a new
root comparator preserved the printed trailing `●`; the historical judge strips
punctuation. `historical-rescore.json` calls the original judge on the **unchanged
saved chunks** and is authoritative for historical pass counts. Neither candidate
rules nor math/body-role scores changed. The corrected runner now reuses that
judge directly. Punctuation remains significant in all math-fragment checks.

## Cost and proposal for shared integration

One local warm-process run measured source-role classification at **6.650s OS4,
6.532s AHSS4 and 1.852s LSJ**. The six historical documents total 2.295s. This is
PDF opening/span inspection/classification, not a production parser or VM latency
measurement. Candidate copying, packing, heading retention and diagnostics take
another 6.037s / 6.051s / 4.612s for the books; these are mixed experiment phases,
not an isolated packing comparison. Restored content and changed boundaries can
increase overlap and token totals even when chunk count falls.

The evidence supports this order of work, subject to the user's production decision:

1. **Shared occurrence guard first.** Narrow
   `pipeline/pipeline/retrieval/packing.py::_is_furniture` so a frozen repeated-text
   key cannot erase an occurrence in a supported body box. Preserve the original
   freeze and edge handling. Ensure the parser's own refined text/chunk outputs
   use the same occurrence decision; fixing only the pilot exporter would leave
   the shared parser and other ingest paths inconsistent.
2. **Persist source-role corrections while the PDF is available.** Extend
   `parser/odl/headings.py::source_headings/rewrite` with the tested banner evidence
   and bounded body-role demotions. An existing furniture block type can represent
   confirmed running banners; captions/diagram labels remain ordinary text with
   their original box. Validate ordering relative to the pre-table freeze and
   source-table reconstruction before selecting that representation.
3. **Fresh integration acceptance before rollout.** Freeze a few additional
   source families and source-reviewed real headings, interior repeated prose,
   marginal equations and irregular folios before tuning. Require the five math
   fragments, four repaired parent witnesses, 12 historical headings, body
   conservation and citation contracts to pass after fresh shared parsing. Review
   restored interior boilerplate and measure retrieval/token cost. Keep the LSJ
   table case and native formula structure as explicit remaining failures.

The narrow furniture guard has the clearest benefit and smallest integration
surface. The source-role rules have convincing known-case gains but no newly
independent heading precision measurement. Neither result justifies a broad
rewrite of headings or a claim that deterministic parsing now transcribes exact
tables and formulas.

## Reproduction and receipts

No Docker, parser service, provider or database call is used by this runner.
Output paths must be new; source hashes must match the frozen fixture.

```powershell
.venv/Scripts/python.exe -X utf8 bench/parsers/scripts/experiment_odl_textbook_recovery.py check
.venv/Scripts/python.exe -X utf8 bench/parsers/scripts/experiment_odl_textbook_recovery.py run --output bench/parsers/reports/local/2026-09-16-odl-textbook-recovery/reproduction --arms baseline headers roles interior_furniture interior_combined
.venv/Scripts/python.exe -X utf8 bench/parsers/scripts/experiment_odl_textbook_recovery.py validate --output bench/parsers/reports/local/2026-09-16-odl-textbook-recovery/reproduction
.venv/Scripts/python.exe -X utf8 bench/parsers/scripts/experiment_odl_textbook_recovery.py occurrences --output bench/parsers/reports/local/2026-09-16-odl-textbook-recovery/reproduction
```

Eleven focused controls and isolated Ruff formatting/lint pass. The repository's
Python formatter excludes `bench`, so this one file was checked with `--isolated`.

Raw receipts under `reports/local/2026-09-16-odl-textbook-recovery/`:

- `r1/`: rejected broad furniture arm, frozen fixture and runner snapshot.
- `r2/`: selected rules, every arm's complete chunks and decisions, timing and
  conservation results, `validation.json`, `restoration-occurrence-check.json`,
  the additional path-count diagnostic `restoration-occurrences.json`, and
  authoritative `historical-rescore.json`.
- `heading-controls/`: supplementary replay of the old selected heading bundles,
  source hashes and corrected historical scores; candidate rules unchanged.
- `os4-115.png` and `os4-116.png`: additional source-role visual checks.

Related evidence: [quality review](2026-09-16-odl-textbook-quality-review.md),
[structure baseline](2026-09-16-odl-structure-baseline.md), and
[historical heading experiment](2026-09-09-odl-heading-context-experiment.md).
