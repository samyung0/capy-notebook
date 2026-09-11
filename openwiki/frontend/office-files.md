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
saved checkpoint is ahead of the indexed one (`indexedState` and
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
layer and transformed image coverage. The OOXML probe reads ZIP/XML parts:
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
The
server-owned 31-credit digital and 52-credit OCR page rates are returned by
`source-upload-policy`; parser receipts remain authoritative for settlement.

The same dialog submits each cloud row with its own chapter, parse mode, and
image-caption setting. Browser analysis is advisory and does not replace ingest
or decide whether a source is searchable.

## Citation geometry and previews

Parser regions use 1-based pages and normalized `[x0,y0,x1,y1]` coordinates in
`page-1000-topleft` space. PDF highlights are a percentage-positioned overlay
over each rendered page. The overlay is read-only and is never shown while an
Office editor is active.

Office coordinates belong to the exact LibreOffice PDF that MinerU parsed, not
to BetterOffice's native layout. Parser bundle v3 therefore includes
`preview.pdf` for Office inputs. Ingest stores it as a reusable
`office_preview` artifact and advertises it as `previewUrl` on the file row once
the file is ready (a presence marker, not a fetchable URL, like `hasBytes`). The viewer fetches `GET /api/files/{id}/links` through the
authenticated API, which returns short-lived presigned B2 URLs for the source
and that preview; B2 cannot check a bearer token and the gateway never proxies
bytes. Each consumer fetches its pair when it mounts and reads it at fetch
time: the client ignores `expiresAt`, never refetches on expiry, focus,
reconnect or file-row change, and drops the pair on unmount so a reopen signs
afresh; a mounted view therefore never sees a changed URL. The citation
preview resolves its own pair when it opens, and the unsupported-file download
signs on click. Only lazily read media can meet an expired URL: audio seeking
shows the retryable file error, whose retry signs a fresh pair. Read links use
`B2_LINK_TTL` (300 s); upload PUTs keep `B2_PRESIGN_TTL` (900 s) because it
doubles as the reservation deadline. An Office citation opens that PDF and highlights its regions; ordinary
file browsing opens the native viewer, and Edit swaps from the citation preview
to BetterOffice. A store-only or legacy Office file with no exact preview stays
on its native viewer without an overlay; the client never invents a preview URL.
Native PDFs use their source blob as the preview.

LibreOffice output is checked against `CAPY_OFFICE_PREVIEW_MAX_BYTES` before the
parser reads it. Bundle creation, ingest caching, and donor reuse enforce the
same limit, so a compressed Office source cannot turn into an unbounded Python
allocation or preview object.

## Edit and save lifecycle

DOCX, XLSX and PPTX edits share an authenticated `source:<fileId>:epoch:<n>`
room. `source_documents` stores the current state, indexed state, exact net
effects and durable checkpoint. The Go API rechecks current source access,
epoch and account state through a small access-only endpoint for each incoming
edit. Full current/indexed state is fetched for bootstrap and persistence;
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
checkpoint prevents the candidate from replacing the base, and the next fresh
idle checkpoint can be processed. Successful publication briefly flushes and
pauses connected writers, then atomically replaces the source, preview, index
and fresh shared seed. All editors clear Undo/Redo only after that publication.

Text, JSON, Markdown, CSV and TSV use a raw UTF-8 Y.Text editor with local undo,
selection tracking and IME composition support. Newlines and BOM are retained;
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

Native PDFs support private text highlights, rectangles, ellipses and erasing.
Annotations belong to the actor and exact source identity. They use normalized
page coordinates and do not alter downloads, retrieval evidence or material
collaboration. The toolbar follows the document cursor, chooses space above
when needed and hides without document focus. Highlight mode applies marks to
text selections. Selecting Eraser clears an existing selection immediately;
otherwise pointer erasing removes touched marks.

## Verification

Focused tests cover source protocol/checkpoint receipts, raw-text selection and
undo, private PDF geometry, pending counts/settings, Go lifecycle and quota
fences, candidate processing and scoped caption reuse. The fork's tests cover
Office CRDT convergence, structural operations, comments, headless restore and
OOXML export. See [the test catalog](../test-catalog.md) for entry points.
