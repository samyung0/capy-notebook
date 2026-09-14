# Native Office citations without retained preview PDFs

Date: 2026-09-14. Feasibility experiments completed; the approved implementation
is now in the working tree, not deployed. Epo accepts best-effort native
highlights and prioritizes removing persistent preview PDFs. The experiment
results below describe the original baseline; the implementation update at the
end records the selected design and application checks.

## Finding

The storage-saving design is feasible. Keep the editable source, use a temporary
PDF for ODL ingestion, and resolve citation text to native paragraphs, cells or
slide objects. Draw rectangles supplied by the current native renderer. There
is no general conversion from a PDF rectangle into an Office rectangle.

Google imports currently become PDF **sources**. Office uploads retain the
Office source plus a PDF **preview**. Current Office citation clicks switch to
that PDF; they do not project its coordinates into BetterOffice. Supporting
native Google imports therefore also means exporting Docs as DOCX, Sheets as
XLSX and Slides as PPTX. These would be editable imported copies, not overlays
inside Google's own editors or a new Google synchronization feature.

## Test environment and inputs

- Capy checkout: `2b366ee3acfbaf0faf72666249f2ca45c5b1838f`, with unrelated local
  work preserved. BetterOffice submodule: `70259d6fa643b6177360020c185e07f78beaa172`.
- Actual deployed parser image `b523bfa4e253`, invoked in disposable containers
  with no network, 2 CPUs, 4 GiB memory and a 2 GiB Java heap. No application
  queues, databases, blob stores or live service mutations were used.
- VM: LibreOffice 7.4.7.2, Python 3.12.14, OpenDataLoader PDF 2.5.7,
  PyMuPDF 1.28.2; image-provided fonts and local OCR models.
- Local bookmark experiment: LibreOfficeDev 26.8.0.0.alpha0. It is reported
  separately from the deployed-version runs.
- Three existing `feature-rich` Office fixtures; three synthetic `wetland`
  fixtures containing duplicate text, wrapping, Unicode, a table, repeated print
  titles, multiple sheets, rotated text and a grouped slide shape.
- Three user-provided Google-native files: **Brochure**, **Monthly budget**,
  **Your big idea**, exported both as Office and PDF. Drive metadata confirmed
  their types. The connector returned file references without a local
  materializer, so authenticated browser exports supplied the local test bytes.
  The originals were not edited. All downloaded content stays under ignored
  `reports/local/`.

Native and ODL measurements are joined by exact source SHA-256, not filenames
alone. An earlier synthetic parse used different ZIP bytes and was superseded;
only `odl/output-final/wetland-*` is scored. Current baseline files use
`odl/output/feature-rich-*`; Google runs use `odl/output-google/`.

All nine Office inputs parsed successfully. The three Google PDF exports also
parsed successfully. The Google XLSX conversion triggered local OCR on one
page; its empty detection result is retained in the run evidence.

## Google export differences

| File | Google PDF pages | Office → LibreOffice PDF pages | BetterOffice surface |
| --- | ---: | ---: | --- |
| Brochure | 2 | 2 | 1 DOCX page in the current viewer |
| Monthly budget | 2 | 6 | 2 worksheets |
| Your big idea | 21 | 21 | 21 slides |

The spreadsheet is a direct counterexample to page-coordinate mapping: six
print pages do not correspond to two native worksheet canvases. Docs also
reflow between engines. Slides retain a fixed canvas, but font metrics and line
layout still differ.

For unique native text of at least 20 normalized characters found in both PDF
exports, page-normalized rectangle IoU was 0.372 median for the Doc (only 2
pairs), 0 for the Sheet (only 1 pair), and 0.804 for the Slides (67 pairs). These
are small conditional geometry diagnostics, not document-wide accuracy scores.

Removing a preview saves its additional bytes. Switching an existing Google
PDF import to an editable export can separately increase the source size:

| File | Current Google PDF source | Editable source | Additional LibreOffice preview |
| --- | ---: | ---: | ---: |
| Brochure | 82,457 B | 351,149 B | 64,277 B |
| Monthly budget | 46,234 B | 12,650 B | 36,268 B |
| Your big idea | 1,997,255 B | 8,870,360 B | 2,153,846 B |

These byte counts are the frozen browser exports, which can differ from a
separate export request. Across all nine Office files the standalone previews
totaled 2,435,999 B, before considering any compressed copies in parse bundles.

## Can a source anchor survive LibreOffice?

Yes, in the tested Writer bookmark route. Six named bookmarks wrapped known
DOCX passages, including duplicates on different pages, a wrapped paragraph
and a table cell.

| Export settings | Named anchors recovered |
| --- | ---: |
| Ordinary Writer PDF export | 0/6 |
| `ExportBookmarksToPDFDestination=true` | 6/6 |
| Same, with tagged PDF enabled | 6/6 |

Every recovered destination identified the expected page and a point 1.482
PDF points from the first expected glyph, using Manhattan distance. These are
`/XYZ` **points**, not complete text ranges or glyph rectangles. Tagged PDF
structure alone did not preserve these names. This does not prove equivalent
cell/shape-ID propagation for Sheets or Slides, or a universal LibreOffice UNO
source map.

The local font setup corrupted Japanese extraction in one passage, although
its bookmark still located the paragraph. Full passage fidelity was 5/6 in that
local experiment; bookmark recovery is not text-fidelity certification.

References: LibreOffice's [PDF export parameters](https://help.libreoffice.org/latest/en-US/text/shared/guide/pdf_params.html)
and [named destinations](https://help.libreoffice.org/latest/en-GB/text/shared/01/ref_pdf_export_links.html).

## Native target resolution and rectangles

The conservative prototype takes an exact text excerpt, normalizes Unicode
and whitespace, and selects a native target only when the match is unique.
The synthetic manifest supplies excerpts and independently checks the expected
paragraph/table position, cell address or slide shape identity.

- **8 of 20** synthetic cases selected the expected identity; **12 abstained**;
  **0 selected a wrong identity**. Duplicate text accounts for most abstentions.
  One DOCX table passage was not present as a complete excerpt in an ODL block.
- A separate PPTX diagnostic takes page indices from the **actual ODL blocks**,
  assuming one PDF page per slide. It resolved **8/8** tested slide excerpts,
  including repeated text on different slides. Fixture slide labels are used
  only to score the answer, not to supply the page hint.
- All **18 absent-text controls** abstained. They are simple negative controls,
  not a calibrated false-positive rate for near-duplicates or numeric cells.

This measures exact-text availability and target resolution. It does not run
the chat agent, final citation snippet generation, full retrieval, or a
production native-citation resolver. `native_entries_found_in_odl` in the raw
output is only substring availability anywhere in a block: short cell values
can match unrelated text, and formula expressions differ from formatted values.
It must not be reported as extraction or citation accuracy.

Directly scaling PDF text boxes into the native canvas gave these conditional
IoU results. Only unique complete text groups present in both representations
qualify; transformed PPTX boxes are excluded from this simple comparison.

| Input | Eligible text groups | Median IoU |
| --- | ---: | ---: |
| feature-rich DOCX | 23 | 0.000 |
| wetland DOCX | 6 | 0.013 |
| Google DOCX | 11 | 0.000 |
| feature-rich PPTX | 9 | 0.651 |
| wetland PPTX | 1 | 0.621 |
| Google PPTX | 27 | 0.718 |

No XLSX PDF-to-native IoU is claimed because there is no general page-to-sheet
mapping. These figures include current renderer limitations and should not be
generalized to other Office engines.

Native geometry itself is usable once the target is known:

- PPTX text-line rectangles moved by exactly the tested +96 px / +48 px shape
  translation. Shape/story identity survived export and rebase. Chromium used
  the existing `paintSlide()` path to render a native text-line highlight; the
  screenshot was visually checked and the run had no browser errors.
- XLSX's native cell rectangle followed A2 → A4 after inserting rows within
  a checkpoint. After export/rebase, raw IDs were reassigned: only 24/78 and
  2/104 entries retained both ID and text in the two fixtures, while 31 and 96
  old IDs referred to different text. An ID or address must be revision-scoped
  and verified against the quote; after an edit, re-resolve or abstain.
- DOCX paragraph identity survived earlier text growth, but current native
  layout did not reflow as expected. A browser test loaded the **actual Capy
  DOCX worker**, whose full display list exactly matched the headless probe.
  The title measured 453.5 px in Chromium but 968 px in engine geometry. The
  screenshot shows clipping and displaced runs. The viewer creates an engine
  with empty font chains and no registered fonts. This is a current viewer
  limitation, not evidence of a missing probe initialization step.

The three Google Office exports opened with 16 DOCX entries, 848 XLSX entries
including empty/formula cells, and 118 PPTX entries including empty paragraphs.
No-op export/reopen retained their identities. DOCX text editing and PPTX shape
movement passed; an ordinary XLSX cell edit also passed. Google XLSX row
insertion was explicitly refused at shared-formula follower E26, which the
editable engine projects as an empty formula. This does not invalidate its
successful import or cell-edit test, and was not fixed in this investigation.

## Temporary PDF regeneration

For the six non-Google Office files, regeneration from identical source bytes
under the same deployed image, fonts and settings produced:

- Identical page counts, full text, every character box and direction, and
  72-dpi rendered pixels on **all 15 pages**.
- Conversion-only latency of **0.725–1.184 seconds per file**, measured in one
  sequential pass under the container limits above.
- Different PDF byte hashes despite identical byte lengths and layout.

This supports temporary conversion for explicit `capture_page` requests. It
does not establish stability across source edits, font/converter upgrades,
large documents or concurrent load. Google exports were not part of this
repeat-conversion measurement.

## Smallest production change suggested by the evidence

1. Preserve editable Google exports using explicit MIME types in
   `server/internal/integrations/oauth.go` and the import download path. Keep
   export-size reservation rules; Google native size is not exported byte size.
   Existing imports stored as PDF need reimport to recover editable content;
   changing a filename or MIME type cannot turn them back into Office files.
2. Carry the existing citation quote through `WorkspaceOpen.openCitation`,
   `openItem`, `FileViewer` and the Office iframe protocol. Route Office citation
   clicks through the normal native viewer. Resolve against the current saved
   content; select a unique text/structural match and draw native rectangles.
   Ambiguous or unavailable geometry should open the file without a highlight.
3. Use existing PPTX snapshot/line geometry, XLSX cell/range geometry and DOCX
   display-list ranges. XLSX needs a bounded sparse text lookup or an ingestion
   cell locator; avoid scanning the entire grid or loading edit engines solely
   for a highlight. Verify formatted cell text, not a formula expression.
   Keep the first implementation in view mode, matching current citation use.
4. Remove standalone Office preview publication and its ingest-plan/ready,
   donor, clone and refresh dependencies. **Also remove durable PDF-containing
   parse bundles**: `_bundle_bytes` embeds `preview.pdf` and sometimes
   `parsed.pdf`; `publish_durable_artifact` writes that ZIP to B2. Deleting only
   `preview_blob_path` leaves another durable PDF copy. A minimal option is to
   stop durable Office bundle publication while retaining the temporary bundle
   for parser-to-ingest handoff and ready-source donor reuse.
   Disable legacy Office bundle recovery too, and release existing file,
   refresh-candidate and artifact-cache references through the blob deletion
   outbox. Stopping new writes alone leaves old PDFs stored and restorable.
5. Finish PDF-dependent ingest work before discarding temporary files.
   `_page_chunks` currently uses `parsed.pdf` or `preview.pdf` for heading and
   confidence work. Change Office citation refinement so ordinary answers do
   not regenerate PDFs. `citation_regions.refine` currently calls
   `capture.pdf_path`, which expects the preview and maintains a disk cache.
6. Preserve explicit visual capture through a bounded temporary conversion in
   the existing parser environment. The retrieval image does not contain
   LibreOffice and its fonts. Discard the converted PDF after the capture;
   stable historical PDF coordinates are not guaranteed after source changes.

PDF-source citations can keep their current geometry path. Existing historical
chat snippets remain stored; the user's existing policy accepts best-effort
historical highlights against the current saved Office content. No new
source-changed notice is proposed.

Named bookmarks are an optional way to improve future ingestion anchors. They
are not required for a first text-based native implementation, and carrying
full text/context before the current 400-character citation truncation would
help resolve long or repeated passages.

## Artifacts and reproduction

Raw evidence is local and gitignored:
[evaluation](local/2026-09-14-native-citations/evaluation.json),
[native measurements](local/2026-09-14-native-citations/native/summary.json),
[Google native measurements](local/2026-09-14-native-citations/native/google-summary.json),
[Google parse runs](local/2026-09-14-native-citations/odl/output-google/run.json),
[bookmarks](local/2026-09-14-native-citations/bookmarks/RESULTS.md),
[regeneration](local/2026-09-14-native-citations/regeneration/RESULTS.md),
[browser proof](local/2026-09-14-native-citations/native/browser-verification.json),
[native PPTX highlight](local/2026-09-14-native-citations/native/pptx-native-highlight.png),
[actual DOCX worker render](local/2026-09-14-native-citations/native/docx-actual-worker-page1.png).

Runnable sources are in `bench/parsers/scripts/`:

- `probe_office_bookmarks.py --output NEW_DIR --soffice SOFFICE` builds synthetic
  fixtures from `fixtures/native-citations/cases.json` and measures bookmarks.
  Requires python-docx, python-pptx, openpyxl and pypdf. Do not rebuild frozen
  inputs midway through a joined run; generated ZIP timestamps change hashes.
- `probe_office_pdf.py --parser-root PARSER_DIR --output NEW_DIR --timeout 180
  --input SOURCE ...` runs current normalization and ODL in the parser image.
- `bun bench/parsers/scripts/probe_native_citations.ts SOURCE ...` captures
  native geometry and checkpoint mutations. Built BetterOffice WASM is needed.
  `--browser` runs the actual-worker/render proof; `--cell-edit SOURCE.xlsx`
  runs the alternative spreadsheet cell mutation. Its output location is the
  frozen experiment's `native/` directory.
- `probe_preview_regeneration.py --root PROBE_ROOT --output NEW_DIR
  --parser-root PARSER_DIR` reconverts the six frozen baseline files.
- `python3 bench/parsers/scripts/evaluate_native_citations.py
  bench/parsers/reports/local/2026-09-14-native-citations` checks matching input
  hashes and recomputes results from saved outputs without a VM or model call.

Ruff format/check passed for the four Python scripts with
`--no-force-exclude` (the repository excludes `bench/` by default). Source
hashes, parser success, synthetic target expectations, negative controls,
native mutation assertions and regeneration equality were checked. An
independent methodology review identified fixture-provided slide hints and
unrotated-box comparisons; the final evaluator separates actual ODL page hints
and excludes transformed geometry. Full application tests were not run because
no production code changed.

After copying the evidence locally, all experiment containers had exited and
the experiment's six VM temporary paths were removed. Existing ingest services
remained running and the parser remained healthy. The six local Google export
hashes still matched their frozen manifest after all tests.

## Implementation verification

The selected implementation retains **PDF-free structured parse caches**. This
supersedes the earlier option to disable durable Office caches. Bundle v4 stores
frozen page text and source-confirmed heading indices so downstream confidence
and heading refinement retain their PDF-based evidence without retaining the
PDF bytes. Temporary parsing and explicit visual captures still use LibreOffice.

Google imports export DOCX/XLSX/PPTX. Native highlights resolve a unique complete
quote against current
saved content. Hidden, clipped, off-page and overflowing matched groups abstain.
Editing and collaboration continue through their existing checkpoint flows.
Migration 0016 removes the obsolete preview schema. Epo clarified that production
has no deployment/data and UAT data was cleared, so the queued-PDF compatibility,
old-plan conversion and preview/cache cleanup were removed. Deployment uses the
normal app-first sequence without a maintenance window.

`pnpm exec tsx bench/parsers/scripts/verify_native_viewers.ts` exercises the real
Capy iframe wrappers. For each format it loads a source, sends a citation, checks
that the native overlay paints, clears it and checks removal. The same check
accepts a JSON cases file for the three private Google exports. Results and
screenshots are under ignored
`local/2026-09-14-native-citations/viewers/`. All six cases passed after the final geometry guards, three Office fixtures
and the three supplied Google exports. The DOCX worker uses full-width paint
clips on ordinary text, so those spans are accepted only when they fully
contain the measured run. These small fixtures establish message/paint/clear
behavior, not a general citation accuracy rate.

Focused parser, ingest, cache, capture, database publication and Go package checks
passed. The frozen evidence parity test compares the resulting Office chunks
against the same PDF-backed refinement. The new Astra xhigh implementation review
covered source identity, storage/refcounts, saved editing state, reparse guards,
protocol boundaries, native geometry and rollout compatibility. Its retained
corrections use stored kinds for renamed captures and abstain for unsafe sibling
geometry and text outside slide text-box clips. The legacy-import and maintenance
recommendations were superseded by the empty-deployment clarification. Both real
PPTX cases passed again after the
closing review's text-box containment correction.
No live service or database was changed by the implementation checks.

The fresh closing review independently verified its PPTX reproduction and safe
positive control, ran 100 focused Python tests, and reported no unresolved
actionable findings. Review reports are local at
`/private/tmp/native-office-implementation-review.md` and
`/private/tmp/native-office-closing-review.md`. The final Google Doc and Sheet
browser checks also passed, recorded in `viewers/google-verification.json`.
