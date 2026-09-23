---
type: Frontend
title: 'Office File Viewing and Editing'
description: 'BetterOffice collaboration, durable source checkpoints, private PDF annotations and published source refreshes.'
tags: [frontend, office, wasm, xlsx, pptx, uploads]
---

# Office files

Capy Notebook uses its BetterOffice fork for modern Word, spreadsheet, and
presentation files. PDF stays on the PDF viewer, while CSV and TSV keep a small table preview alongside raw-source editing. Legacy `.doc`, `.xls`, and `.ppt` files and unknown
formats may be uploaded within the plan byte limit, but remain store-only.

| Format | View | Edit | Engine |
| --- | --- | --- | --- |
| XLSX | yes | yes | BetterOffice XLSX viewer/editor WASM |
| PPTX | yes | yes | BetterOffice PPTX viewer/editor WASM |
| CSV / TSV | yes | yes | bounded table preview and shared raw Y.Text editor |
| DOCX | yes | yes | BetterOffice DOCX viewer/editor WASM |
| PDF | yes | private annotations | React PDF over PDF.js |

Create cards open `/materials/:id` and Files cards open `/files/:id` in View.
Both routes use the workspace's `CenterContent` header and renderers, with
the app sidebar and a back icon. They omit workspace navigation and Move to
chapter. `FileModeControl` portals file View/Edit and Save controls into that
shared header while each runtime retains its save and collaboration lifecycle.
New standalone notes request Edit explicitly; workspace material defaults and
the dedicated quiz/study actions retain their existing behavior.

## Repository boundary

The fork is a Git submodule at `vendor/betteroffice`, pinned to a reviewed
commit from `https://github.com/samyung0/betteroffice.git`. Capy Notebook imports
source entry points from that exact commit through Vite aliases. Do not depend
on a moving branch at build time. The fork does not need to be published to
npm for this application: the submodule commit is the package/version boundary
and the generated WASM is built during a cold install.

After cloning Capy Notebook, initialize the submodule:

```bash
git submodule update --init vendor/betteroffice
```

`predev`, `prebuild`, `pretypecheck`, and `pretest` run
`scripts/prepare-betteroffice.mjs`. It installs the fork's locked Bun workspace
and builds the scoped DOCX stylesheet plus DOCX/XLSX/PPTX viewer/editor WASM artifacts and the headless checkpoint bundle. The fork builder verifies source/output fingerprints before reusing WASM. A cold build
requires Bun, Rust, `wasm-pack` 0.15.0, and `wasm-opt` from Binaryen. Existing,
intact generated artifacts are reused.

Frontend CI, browser E2E CI, and SPA deployment restore
`vendor/betteroffice/target/wasm-pack` through
`.github/actions/cache-betteroffice`. The cache key uses the fork's
`scripts/wasm-cache-key.ts` fingerprint plus runner OS and architecture. It
covers Rust sources, Cargo configuration, compiler/optimizer versions, build
flags, and WASM build scripts, so a compiler change can invalidate the cache
even with an unchanged submodule pin. Preparation still validates cached output
hashes and copies intact builds into the generated package directories; a miss
rebuilds normally. CSS, the checkpoint bundle, and the environment-specific Vite
output are rebuilt on each run.

## Browser loading model

`office-runtime.html` is a second Vite entry rendered from the separate origin
configured by `VITE_OFFICE_RUNTIME_ORIGIN` in production. The app origin
fetches the protected file URL and transfers its `ArrayBuffer` to the runtime
through the versioned protocol in `officeProtocol.ts`; the runtime origin never
receives a file URL, Clerk token, or app cookie. Local development may use the
same origin.

The runtime starts with a format-specific viewer entry point. XLSX/PPTX viewer
WASM omits editing, collaboration, undo, and save machinery; the DOCX viewer
does not expose those operations but still shares its one-time OOXML lowering
bridge with the editor. The React editor and editor WASM are imported only after
the user presses Edit. DOCX lowering runs in a disposable worker that terminates
as soon as it transfers the immutable display list, so its parser, transient
Yrs projection, and viewer linear memory are absent during ordinary reading.
Viewer analysis reuses the already-open handle, so sheet/slide metadata does not
trigger a second parse.

Viewing shows the last saved state, not only the last published blob. View
mode reads `GET /api/files/{id}/source-session?view=true`, a lock-free read
(read authorization only, no `source_documents` row is created, no account
lock, so a suspended owner's shared files keep rendering) that returns the
presigned base URL and checkpoint numbers and carries `state` only when the
saved checkpoint is ahead of the indexed one (`indexedBaseline` and
`pendingEffects` are omitted). The host passes that state as `checkpoint` on
the `load` message; the runtime applies it over the base with the editor
engines in a disposable `exportCheckpoint` worker (the same composition as the
collaboration service's headless export), terminates it, and opens the viewer
on the exported bytes. With no unpublished edits the base opens directly and
no editor engine loads. The view is not live: it reflects the state at open,
and a reopen or revision change reads again.

View and edit use separate iframe lifetimes so the browser can reclaim each
WASM realm. Entering Edit replaces the viewer iframe. Leaving Edit keeps durable
shared changes and previews the exported current replica. Saving requests a database
checkpoint receipt and keeps the editor mounted. Ordinary metadata refetches do
not recreate an active editor. A successful Office base handoff deliberately
loads a fresh editing epoch and clears Undo/Redo. Starting Edit from a PDF
citation creates the editor directly without warming the native Office viewer.

The parent owns the Hocuspocus provider and Y.Doc. The isolated iframe exchanges
raw Yrs updates with that parent through a versioned message protocol, and waits
for provider sync before restoring its replica. The iframe receives base bytes
and shared state, never an authentication token or protected source URL.

PowerPoint deck schema v3 stores embedded media as native Yrs byte buffers in
`pptx:meta.media`; parsed non-media metadata remains in `packageJson`. Opening
v1/v2 states migrates the decimal-array JSON bytes and Yrs garbage collection
removes the replaced payload from subsequent checkpoints. Late edits still
merge, including a concurrent legacy schema migration. Source fingerprints,
edited roots and exact media bytes are preserved; exporting still requires the
matching source file. Older editor engines reject v3, so an engine rollout
requires those editors to reload before receiving migrated updates.

The iframe sandbox allows scripts and its own origin, but the runtime origin is
cross-origin from the app, cookie-less, and restricted to the app by CSP
`frame-ancestors`. Host and runtime validate exact origins and the message
source; production refuses to create an Office runtime on the app origin. This
contains a compromised document engine without relying on the sandbox's
same-origin escape-prone combination on the application origin. The engines
are single-threaded; an iframe alone does not enable `SharedArrayBuffer`. If
threaded WASM is introduced later, configure isolation headers on this runtime
origin without isolating the SPA.

PDF is not loaded into the Office iframe. `react-pdf` is the only PDF viewer
surface and `pdfjs-dist` is its engine. Both the viewer and upload-analysis
worker use the bundled same-origin PDF.js worker, so neither depends on a CDN.
The viewer preserves every page wrapper for stable scroll geometry but mounts
PDF.js canvas and text layers only near the viewport, plus the first and cited
pages. This bounds renderer memory on long documents without weakening exact
citation scrolling.

## Upload and import analysis

Local selection and Google Drive/OneDrive selection both lead to the same
details dialog. Files above the workspace owner's 10 MiB/30 MiB cap are
rejected before they enter the list; unknown and legacy formats remain eligible
for store-only upload. Cloud metadata comes
from `sources/import-inspect`; the analysis worker reads provider bytes through
a bounded, authenticated same-origin proxy, so provider tokens never enter the
browser. The proxy accepts only editor access, bounds response bytes, validates
redirect destinations against public IPs, strips cross-origin credentials, and
serves opaque attachment bytes with `nosniff` and `no-store` headers.

One dedicated worker analyzes one parse-enabled file at a time. Removing a row
or switching it to no parsing cancels queued work and terminates the active
worker for that row. A completed result stays cached when parsing is toggled off
and back on. Each row owns its progress bar; there is no separate queue panel.

PDF.js reports an exact PDF page count and estimates OCR routing from the text
layer with the parser's own rule: a page with fewer than 40 text-layer
characters goes to OCR (`TEXTLESS_CHARS` in `sourceAnalysisCore.ts`); image
coverage is recorded but no longer decides routing. The OOXML probe reads ZIP/XML parts:
PPTX slide count is exact, while DOCX pagination, XLSX rendered pages, and every
Office OCR classification are explicitly estimates. XLSX estimates printed
pages from each worksheet's used row/column extent because its eventual
LibreOffice print layout is not
available in the browser. PDF analysis rejects excessive page, text, operator,
decoded-image, estimated-memory, and wall-clock work; it also limits individual
PDF.js operations and cleans each page before advancing. DOCX saved page
metadata is accepted only inside the same bounded page model and otherwise
falls back to explicit/rendered page-break evidence. OOXML extraction is
limited to 4,096 archive entries and 128 MiB of selected expanded XML; media
payloads and unrelated package parts are never inflated by the probe. These
estimates drive only the dialog summary. Images and audio do not enter the
browser page/OCR analysis queue: the ingest worker captions or transcribes them,
and those provider costs are deliberately absent from the page-based estimate.
The server-owned page rates (1.0 credit per digital page and per OCR page) are
returned by `source-upload-policy`; parser receipts remain authoritative for
settlement.

The same dialog submits each cloud row with its own chapter and parse mode;
there is no caption toggle, because embedded figure captioning was retired.
Browser analysis is advisory and does not replace ingest or decide whether a
source is searchable.

## Citation geometry

PDF regions use 1-based pages and normalized `[x0,y0,x1,y1]` coordinates in
`page-1000-topleft` space. PDF sources retain their normal read-only overlay.
Office PDF coordinates do not map directly to the native editor layout.

Office citation clicks pass the quoted passage through protocol v4 to the existing
native viewer. DOCX searches current paragraph text and overlays its current run
geometry. PPTX searches native text boxes and draws their current line rectangles.
XLSX enumerates defined cell addresses in the current OOXML package, matches the
viewer's displayed cell text, and uses its current viewport geometry. Matching
requires a complete unique quote of at least 12 non-whitespace characters; short,
ambiguous, unsupported and off-page matches open without a highlight. Workbooks
are bounded to 20 MiB of relevant XML and 20,000 cells; decks to 200 slides.
No editing engine is loaded just for citation matching. Highlights are transient,
read-only, and absent in edit mode. Reopening resolves against the saved state.

Google Docs, Sheets and Slides imports export DOCX, XLSX and PPTX respectively;
Drawings still export PDF. Acquire rejects a source whose current export format
differs from the reserved content type. Source bytes count
toward the owner's quota, so switching export formats can increase or decrease
storage. Export-size checks still enforce the provider and owner upload limits.

The parser converts Office sources to a temporary PDF for OpenDataLoader. Bundle
v4 retains structured blocks, images, furniture and compact page-text/heading
evidence, with no Office PDF. `CAPY_OFFICE_PREVIEW_MAX_BYTES` still bounds the
temporary LibreOffice output. Native PDFs alone may include a repaired `parsed.pdf`.
Migration 0016 removes the obsolete preview schema. No legacy data migration is
needed: production has no data and UAT data was cleared.

`GET /api/files/{id}/links` signs source downloads and PDF preview links. Each
consumer reads its link on mount; links are dropped on unmount. Unsupported-file
download signs on click, and audio retry signs a fresh link. Read links use
`B2_LINK_TTL` and upload PUTs use `B2_PRESIGN_TTL`.

## Edit and save lifecycle

DOCX, XLSX and PPTX edits share an authenticated `source:<fileId>:epoch:<n>`
room. `source_documents` stores the current state, compact indexed semantic baseline, exact net
effects and durable checkpoint. The Go API rechecks current source access,
epoch and account state through a small access-only endpoint for each incoming
edit. Current state and semantic baseline are fetched for bootstrap and persistence;
checkpoint writes also check storage growth. Saved means the server has
acknowledged the requested checkpoint; Ctrl/Cmd+S flushes that same path.
Credits gate parsing and AI work, independently of durable saving.

The browser retains unacknowledged edits in an IndexedDB draft for each actor,
file and editing session. Reopening merges compatible drafts; a receipt removes
only the exact draft versions it covers. Another tab's newer draft remains
available. Save, export and handoff first commit open spreadsheet inputs and
wait for active composition or gestures. Pending input counts as unsaved even
before it reaches the shared document.
Network and recoverable save failures leave drafts available. Before sending
buffered updates after reconnect, the parent verifies the current epoch. An old
epoch with unsaved changes enters recovery and permits draft download instead
of merging incompatible updates. Recovery merges drafts from the same old
epoch/base. An explicit Discard this draft action removes only those exact
versions and advances to the next retained group, then the current file.
Downloading alone leaves the drafts intact. A fully acknowledged client reloads the new
base when it learns about a completed handoff.

Office automatic refresh starts only after a prior successful parse, at least
5,000 estimated net-change tokens, and 60 seconds without a server-observed
edit. Every edit resets that idle interval; there is no maximum wait. Manual
processing bypasses the threshold. Editing continues during processing. A newer
saved checkpoint is rebound to the candidate's exported source. Successful
publication briefly flushes connected writers, then atomically publishes the
source, index, rebased current state and matching indexed baseline.
The current checkpoint can remain ahead of the indexed checkpoint, with later
edits retained as pending effects. A concurrent save retries only the local
rebase against the same parsed candidate. All editors remount in the new epoch
and clear Undo/Redo after publication.

Export finalization compares the B2 object's size and unquoted ETag with the
gateway's HEAD result. Rejected exports send a complete failure receipt so the
job closes without waiting for its lease to expire.

Text, JSON, Markdown, CSV and TSV use a raw UTF-8 Y.Text editor with local undo,
selection tracking and IME composition support. The editable document is exposed
only after its first collaboration sync supplies the authoritative seed. It stays
available across ordinary disconnects so mounted offline edits retain their drafts.
Newlines and BOM are retained;
invalid UTF-8 fails explicitly. Text refresh batches every 15 seconds even
while typing continues. Its published checkpoint may lag the current document,
with exact residual edits retained in the same Y.Text lineage and Undo history.
The text preview follows that current shared text after Done, including remote
edits; publication metadata does not replace a mounted editor's newer state.

The published file remains readable and cloneable while a candidate is being
exported or processed. Clones copy its published source/index and caption
associations, without pending edits or jobs. Deleting a source fences its old
room and cancels dependent work. Candidate sources live
in B2; job-local downloads are temporary. Source base bytes are cached in the
collaboration process by SHA within a bounded 128 MiB cache. Headless export,
comparison and asset extraction run in a worker thread.

## Private PDF annotations

Native PDFs support private text highlights, pen strokes, text, rectangles,
ellipses and erasing.
Annotations belong to the actor and exact source identity. They use normalized
page coordinates and do not alter downloads, retrieval evidence or material
collaboration. View/Edit lives in the shared document header. A fixed single-row
PDF toolbar shows plain Page x of x, centered drawing tools and Undo/Redo, and
zoom buttons at the right. Below lg, zoom is hidden and the center tools scroll
horizontally with `scroll-fade-x` and no scrollbar. Menus render in portals so
the scrolling mask does not clip them.

Draw chooses Pen or Highlight; Text collects a label before placement; Shape
chooses Rectangle or Ellipse. Highlight applies to text selections, and choosing
it for a fully highlighted selection removes just that selected portion.
The eraser cursor is a 48px-radius circle and removes marks it crosses. Session
undo/redo records inverse API operations, remaps restored annotation IDs and
resets when the viewer unmounts or the source identity changes. The marks remain
durable and private. Failed or partly completed batches clear unreliable history
and refetch the saved marks. Pen geometry is bounded to 4096 points and text to
2000 characters by the store and generated contract.

## Verification

Focused tests cover source protocol/checkpoint receipts, raw-text selection and
undo, private PDF geometry, pending counts/settings, Go lifecycle and quota
fences, candidate processing and scoped caption reuse. The fork's tests cover
Office CRDT convergence, structural operations, comments, headless restore and
OOXML export. See [the test catalog](../test-catalog.md) for entry points.

The source comparison baseline is separate from the editable Yjs state. It stores
text and stable positions, image hashes/references, and hashes of visual metadata;
media bytes remain in the current editor state. Office handoff publishes the rebased
saved state and a baseline mapped into its identities, then remounts the editor.
PPTX rebase states use schema 4 and binary changed package parts; ordinary binary
media states remain schema 3. XLSX rebase states require the `xlsx:rebase` root,
which older strict schema-7 readers reject. XLSX permits the server-owned
`__capy_pending_contributors` map alongside strict workbook roots and preserves
its deletion history during sync. Both reconstruct the current source
from the published base plus changed parts; no full old source remains in state.
Schema migration
`0015_source_semantic_baseline.sql` targets the cleared first-UAT dataset and refuses
existing saved source states/candidates instead of discarding or reinterpreting them.
