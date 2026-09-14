# File fixtures for E2E and UAT

Commit test input files here so a checkout contains the exact inputs used by the
run. Local failure tests and the implemented UAT journeys share this directory.
The initial runner uses `basic/`; see [its setup and coverage guide](../../uat/journeys/README.md). Existing `../actors.ts`, `../seed.ts`, and `../seed.sql` provide account
and database fixtures and stay where they are.

Group files by scenario set. For example:

```text
e2e/fixtures/files/
  basic/
    README.md
    lesson.docx
    grades.xlsx
    lesson.pptx
    digital.pdf
    scanned.pdf
    notes.txt
    notes.md
    facts.json
    grades.csv
    grades.tsv
    example.ts
    diagram.png
    narration.mp3
    archive.zip
  rich-content/
    README.md
    lesson.docx
    grades.xlsx
    lesson.pptx
  unicode/
    README.md
    ...
  native-citations/
    README.md
    passages.docx
    passages.xlsx
    passages.pptx
  invalid/
    README.md
    truncated.pdf
    corrupt.docx
    invalid-utf8.txt
    delimiter-limit.csv
    corrupt.wav
```

These filenames are examples, not existing fixtures. Add other image/audio
formats and legacy Office files as the sets grow. Use small, synthetic files
with known contents. Large stress inputs and parser-quality corpora belong in
the existing `bench/` families. Do not put real account data, access tokens, or
private documents in these fixtures.

## Describe what each file proves

Add a short README in each set with one row per file:

Record whether the file is a workspace source or a material editor asset, its
parse mode, and its actual codec/container or text encoding where relevant.

| File | Input facts | Action | Expected persisted result |
| --- | --- | --- | --- |
| `lesson.docx` | A paragraph says `The launch code is LARCH-17`; includes a table and image. | Actor A changes the code to `CEDAR-42`; actor B adds a separate sentence. Reopen and process changes. | Export and current index contain the new code and both edits; unrelated table values and embedded image survive. |
| `grades.xlsx` | `Grades!B2` is `42`; `C2` contains a known formula. | Change `B2` to `43`, then reopen and process changes. | Export contains `43` at `B2` and preserves the formula at `C2`; indexed evidence reflects the new value. |
| `grades.csv` | Known headers, quoted delimiter/newline, blank field, literal formula. | Change a score in the raw text editor. | Export preserves delimiters, quoting and formula text; normalized index contains the changed field/value. No formula evaluation. |
| `truncated.pdf` | Deliberately truncated input. | Attempt upload and processing. | Record whether this fixture is rejected before upload or fails a processing job; assert that exact stage, released reservations, and no new published index. |

Include known paragraphs, cell addresses, slide text, transcript facts, or
caption subjects that we can check. For rich documents, describe content that
must survive editing, such as formulas, links, tables, and embedded media.
These are document-content checks, not browser layout or DOM checks. Avoid
exact generated summaries, chunk counts, pixel positions, and selector recipes.

For invalid files, explain how they were damaged and the intended failure stage.
Some malformed files are rejected by browser preflight and never reach the
parser. They cannot stand in for a worker-failure test. We will confirm each
fixture's behavior when wiring its test.

## Actions depend on the format

| Formats | Action and authoritative checks |
| --- | --- |
| DOCX | Two actors edit separate body paragraphs; reopen/export/process. Preserve known table cells, hyperlink target, inline image hash, and rich fixture header/footer text. |
| XLSX | Two actors edit separate known cells; reopen/export/process. Preserve formula expressions, sheet names, merge ranges and drawing/media relationships. |
| PPTX | Two actors edit simple text on separate slides; reopen/export/process. Preserve unrelated text boxes, tables, links and media. |
| Text/code, Markdown, JSON | Valid UTF-8 raw shared text; assert merged Y.Text, exported bytes, and changed indexed facts. HTML/RTF/code remain raw source. Malformed JSON does not imply rejection. |
| CSV, TSV | Valid UTF-8 shared raw text; assert delimiters/quotes/formulas in source bytes and normalized field/value facts in the index. Confirm each fixture's header detection. |
| PDF | Digital, genuinely scanned, and mixed-page extraction/OCR cases. Two readers, including a viewer, create private annotations; assert actor isolation and unchanged PDF/index. With parsing disabled, expect store-only behavior and personal annotations. |
| Images | Caption/ingest, retained original bytes, download, and deletion. No source editor. Validate actual codecs using the matrix below. |
| Audio and audio-bearing containers | Transcription/ingest, retained original bytes, download, and deletion. No source editor or visual video extraction. |
| Legacy DOC/XLS/PPT and unknown formats | Store-only upload, download byte equality, access control, and deletion. No source editing or ingestion. |

Office files remain native editable sources. The parser uses a temporary
LibreOffice PDF for OpenDataLoader, then retains a v4 structured bundle containing
blocks, images, furniture and page-text/heading evidence. Office bundles contain
no PDF and there is no published Office preview PDF. Use labelled visible facts
for index assertions; formula expressions, hidden content, comments, speaker
notes and embedded media still need separate export-preservation checks.
Browser page/OCR estimates are advisory; assert actual parser/usage receipts.
Include one modern Office upload with parsing disabled. It remains editable,
but automatic processing requires a prior successful parse.

The XLSX name box is read-only. Use sheet selection, keyboard navigation and the
formula input for cell edits. Row/column insertion and sheet add/delete/rename
exist in the engine but lack current browser controls; keep their conflict tests
in the fork's integration suite. Browser action helpers for Office still need
validation when the journeys are implemented.

Reuse the pinned fork's
[`exportOffice` and `inspectOffice`](../../../vendor/betteroffice/shared/office-checkpoint.ts)
with each saved state's matching base. Inspect selected OOXML parts and media
with existing ZIP tools when the semantic projection is insufficient. Compare
content after edits, not whole ZIP byte equality.

### Native Office citations

Citation matching finds the quoted text in the current native file and uses
BetterOffice's current geometry. It does not scale LibreOffice PDF coordinates
into the editor. Parser page references remain evidence metadata; they are not
sheet, paragraph or shape identities. Protocol v4 carries the quote and optional
page, without PDF boxes.

Prepare these cases for DOCX, XLSX and PPTX:

| Fixture case | Expected native matching result |
| --- | --- |
| Unique complete sentence in one paragraph, displayed cell, or slide text box | Resolve the intended current target. Use at least 12 non-whitespace characters and a quote that survives extraction. For XLSX, a long text cell is a better positive case than a short number or formula expression. |
| Duplicate sentence in two targets, or repeated within one target | No highlight. A parser page number must not select an otherwise ambiguous target. |
| Short number, missing/changed quote, or a quote split across cells/text boxes | No highlight. The file still opens and can be edited. |
| Wrapped/Unicode text | Match only the complete unique quote after supported normalization. |
| Target moved by other edits, export, or rebase | Resolve again from current saved bytes and renderer data. Never reuse an old native ID, address or rectangle as authority. |
| Hidden, clipped, rotated, overflowing or off-page evidence | Exercise format-specific geometry guards and accept deliberate abstention. Do not require exact highlights for every supported document feature. |

Check these with the production matching functions and current renderer data,
using independently known fixture text/target and valid geometry bounds. These
are document semantics and renderer-data checks, not DOM, overlay-count or pixel
snapshot assertions. Reuse
[`citations.ts`](../../../src/office-runtime/citations.ts) and
[`xlsxCitation.ts`](../../../src/office-runtime/xlsxCitation.ts).

UAT should verify real persisted citation snippets/regions and source identity.
Validate a simple positive fixture's actual snippet before requiring native
resolution; reconstructed table prose need not exist in a single displayed cell.
Old citation records keep their old snippet and parser regions. Reopening the
current file rematches that snippet or abstains if it changed or became ambiguous.
Backend evidence and matching results do not prove an overlay was painted;
existing browser painting probes remain separate diagnostics.

For the server-side `capture_page` tool, Office requests use the exact published
source hash/size, temporary conversion and a JPEG response. Test valid page/crop,
source mismatch and conversion failure without requiring a stored preview, a new
parse receipt, or byte-identical regenerated PDFs. Native PDF capture remains a
separate path. The existing
[`native citation cases`](../../../bench/parsers/fixtures/native-citations/cases.json)
provide useful scenario text; benchmark outputs are not committed UAT input files.

### Media compatibility cases

| Accepted source extensions | What to prepare and verify |
| --- | --- |
| PNG, JPG/JPEG, BMP, WebP, GIF, AVIF, JP2, TIF/TIFF, ICO | Real files for each codec. Include EXIF orientation, transparency, animation and multipage TIFF. The caption path samples up to nine representative frames; it does not promise every frame's content. Verify deployed decoding/provider acceptance. |
| SVG | Small self-contained SVG. Current code sends raw SVG to the vision provider; acceptance needs validation. |
| HEIC/HEIF | Genuine encoded files. No HEIF decoder plugin is configured in the repository; decoding failures fall through to original provider payloads. Successful captioning is unverified. |
| MP3/MPGA, WAV, M4A, OGG, FLAC, AAC, OPUS | Short known narration in each actual codec/container. Check transcript facts, measured duration, metering and released capacity. Renaming an MP3 does not test another codec. |
| MP4, WebM, MPEG | Spoken audio track plus a separate silent/video-only failure candidate. The app treats these as audio transcription; visual frames are not indexed. |
| Unlisted formats such as MOV, MKV, AVI, M4V, AIFF | Store-only source cases unless the format registry changes. |

Acceptance, worker decoding, provider compatibility and browser playback are
different properties. The original bytes go to the browser's image/audio
elements. Backend assertions cannot certify visual rendering or audible playback.
Fixture expectations must record which properties were actually exercised.

Material editor assets need a separate journey using the same suitable inputs.
They have different allowlists and purpose limits, and inserting an asset does
not run source ingestion. See
[`editor_assets.go`](../../../server/internal/httpapi/editor_assets.go) and
[`media.ts`](../../../src/features/notes/media.ts).
Source normalization and transcription are implemented in
[`source_text.py`](../../../pipeline/pipeline/ingest/source_text.py).

### Failure candidates

| Input or injected failure | Expected boundary to validate locally |
| --- | --- |
| Truncated PDF, bad Office ZIP, missing document/sheet/slide parts | Browser analysis may reject or repair them. Record observed behavior before choosing a worker-failure fixture. |
| Nonempty invalid UTF-8 TXT | Ingestion replaces invalid bytes, but collaboration bootstrap uses a fatal UTF-8 decoder. Test failed edit bootstrap with preserved original bytes. Ordinary text has no document preflight. |
| CSV with 100,000 commas on one line | About 100 KB exceeds the real 100,000-cell estimate. Candidate for terminal direct-ingest failure before model calls; it does not exercise the document parser. |
| Nonempty whitespace-only TXT | No indexable content follows the retry path before final failure. This differs from a valid empty text refresh, which clears prior indexed content. |
| Malformed WAV | Candidate for terminal ffprobe failure before transcription. Confirm upload acceptance and the resulting event before using it as the UAT/Sentry probe. |
| Valid Office bytes with local conversion timeout, invalid/missing bundle evidence, source B2 read or ingest-model failure | Exercise the actual worker boundary; preserve the last published source/index and saved edits while checking job state and accounting. A retained preview is no longer required. |
| Office bundle contains a PDF, wrong version/hash or invalid page/heading evidence | Parser-client validation rejects the handoff. Optional durable cache-write failure is a separate case that may still ingest from the validated local bundle. |

Invalid JSON and loosely quoted CSV are not reliable failure fixtures. Corrupt
image decoding can fall through to the provider. Keep arbitrary upstream failures
in isolated tests and retain only validated bounded failure inputs in UAT.

The extension and processing-route inventory lives in
[`server/internal/sourceupload/rules.go`](../../../server/internal/sourceupload/rules.go).
Edit capabilities live in
[`server/internal/store/source_documents.go`](../../../server/internal/store/source_documents.go).
Each actual supported format needs a fixture. Keep extension-alias routing
coverage in fast tests; the heavy suite should exercise each format's real
contents and decoder. The example set above is only a starting list.

## How the runner should use these files

Upload from a temporary working copy. Keep committed originals unchanged across
runs. Store sanitized evidence and resource manifests under the ignored
`e2e/uat/journey-runs/<run-id>/` directory, outside Playwright's cleared output
directory. The workflow uploads this persistent directory for cleanup resumption.

Fresh processing tests need unique source bytes to avoid exact-source cache reuse.
For editable fixtures, include a dedicated `UAT_RUN_MARKER` paragraph, cell, or
slide text, or a text line, JSON string, or CSV field for a format-aware helper
to replace in the temporary copy. Keep successful text fixtures valid UTF-8.
A changed filename alone does not defeat reuse. Formats without an implemented safe
mutation need an explicit fresh-input strategy before counting as fresh processing
coverage. Keep a separate unchanged duplicate-upload case to test reuse.

For PDF/media, valid metadata edits or a supported remux may change source bytes
without changing content. Decode the temporary result again and verify preserved
pages/frames/streams. Never add text to a scanned PDF merely for uniqueness, which
can change its OCR route. Metadata changes may still reuse canonical indexed
text; tests proving fresh embedding/index content also need a changed semantic
fact. Use fresh browser file selection identity to avoid local analysis reuse.

Use these same bytes for mocked Google/OneDrive downloads. Existing Go tests
replace `providerHTTP` with an in-process fake transport; Python import tests
replace `pinned_http.open_download` with a fake response stream. Cover both the
gateway analysis fetch and queued worker transfer as needed. A Playwright browser
route cannot replace either server-side download. Component tests with fake blob
writes do not establish real B2 persistence or database reservation cleanup.

Google-native Docs export DOCX, Sheets export XLSX, and Slides export PPTX.
Return genuine native package bytes from their mocks, with matching exported
filename and MIME. They now follow native editing, collaboration, refresh and
citation cases above. Google Drawings still exports PDF and uses PDF expectations.
Uploaded binary Office and ordinary OneDrive Office imports retain their format.
Mock export-size uncertainty, actual-byte quota settlement, and an export MIME
change between inspection/reservation and acquire, which must be refused.
Live provider grants, URLs and credentials do not belong in committed fixtures.

Mocked imports do not verify OAuth, consent, Picker behavior, or live provider
access. Those checks are excluded from the initial unattended UAT gate.
