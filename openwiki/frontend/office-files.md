---
type: Frontend
title: 'Office File Viewing and Editing'
description: 'BetterOffice integration, browser runtime boundaries, upload analysis, and source replacement saves.'
tags: [frontend, office, wasm, xlsx, pptx, uploads]
---

# Office files

Evo Notes uses its BetterOffice fork for modern Word, spreadsheet, and
presentation files. PDF stays on the PDF viewer, while CSV and TSV keep a small
read-only table preview. Legacy `.doc`, `.xls`, and `.ppt` files and unknown
formats may be uploaded within the plan byte limit, but remain store-only.

| Format | View | Edit | Engine |
| --- | --- | --- | --- |
| XLSX | yes | yes | BetterOffice XLSX viewer/editor WASM |
| PPTX | yes | yes | BetterOffice PPTX viewer/editor WASM |
| CSV / TSV | yes | no | bounded SheetJS worker preview |
| DOCX | yes | yes | BetterOffice DOCX viewer/editor WASM |
| PDF | yes | no | React PDF over PDF.js |

## Repository boundary

The fork is a Git submodule at `vendor/betteroffice`, pinned to a reviewed
commit from `https://github.com/samyung0/betteroffice.git`. Evo Notes imports
source entry points from that exact commit through Vite aliases. Do not depend
on a moving branch at build time. The fork does not need to be published to
npm for this application: the submodule commit is the package/version boundary
and the generated WASM is built during a cold install.

After cloning Evo Notes, initialize the submodule:

```bash
git submodule update --init vendor/betteroffice
```

`predev`, `prebuild`, `pretypecheck`, and `pretest` run
`scripts/prepare-betteroffice.mjs`. It installs the fork's locked Bun workspace
and builds missing DOCX/XLSX/PPTX viewer and editor WASM artifacts. A cold build
requires Bun, Rust, `wasm-pack` 0.15.0, and `wasm-opt` from Binaryen. Existing,
intact generated artifacts are reused.

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

View and edit are separate iframe lifetimes rather than modes inside one
long-lived JavaScript realm. Entering edit replaces the viewer iframe; Cancel
replaces the editor with a new viewer; Save replaces it with a viewer seeded
from the committed bytes. This is important for XLSX/PPTX because disposing a
WASM object cannot shrink its module's linear memory. Destroying the iframe lets
the browser reclaim the whole viewer or editor realm. Starting Edit from a PDF
citation creates the editor iframe directly and does not warm the native Office
viewer first.

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
`office_preview` artifact and exposes `/api/files/{id}/preview` after the file
is ready. An Office citation opens that PDF and highlights its regions; ordinary
file browsing opens the native viewer, and Edit swaps from the citation preview
to BetterOffice. A store-only or legacy Office file with no exact preview stays
on its native viewer without an overlay; the client never invents a preview URL.
Native PDFs use their source blob as the same preview route.

LibreOffice output is checked against `EVO_OFFICE_PREVIEW_MAX_BYTES` before the
parser reads it. Bundle creation, ingest caching, and donor reuse enforce the
same limit, so a compressed Office source cannot turn into an unbounded Python
allocation or preview object.

## Edit and save lifecycle

BetterOffice reports semantic mutations to the host. Selection and navigation
do not mark the file dirty. Dirty editors confirm before Cancel and register a
browser `beforeunload` warning. The parent also receives dirty-state changes.
It blocks workspace item navigation, route changes, active-file deletion, and
closing or replacing the Files dialog viewer until the user confirms discard.
The confirmation runs before citation state changes, so a same-file citation
cannot replace a dirty native editor before the router blocker runs.

Save serializes a complete OOXML file and sends it to the parent. The parent
submits the current file revision with the replacement. A successful save:

1. keeps the logical file id, name, chapter, and parse settings;
2. increments `files.revision` and rejects stale editors with HTTP 409;
3. swaps the source blob and invalidates the file's retrieval alias;
4. queues full re-ingestion when parsing is enabled, or returns ready and
   unindexed for store-only files.

The replacement response updates the individual-file, workspace-file, and
global all-files query caches with the new revision. The global Files dialog
stores only the selected file id and resolves the current object from that
cache, so closing and reopening an edited file cannot reuse the pre-save
revision for the next replacement.

For a citation-initiated edit, the native viewer remains mounted while the
replacement is re-ingested. The PDF citation preview returns only after the
same or newer file revision is ready, so stale geometry is never drawn over new
content.

The current integration does not attempt chunk-level dirty tracking. OOXML edits
can change relationships, formulas, layouts, and shared parts, so full source
replacement and re-ingestion is the smaller correct contract. While that job is
pending, the workspace keeps the newly saved viewer visible and adds an ingest
status banner.

Every ingest payload pins both the source revision and source ETag. Each worker
mutation that can publish source-derived status, hashes, artifacts, retrieval
associations, or notifications locks the file row and verifies that identity in
the same transaction. Replacement cancels older ingest jobs and releases their
credit reservations. Losing a job lease is handled separately: the stale
attempt stops without closing the reservation that its successor still uses.

## Fixture proof

The local proof uses BetterOffice's `sample.xlsx`, `betteroffice-demo.pptx`, and
`feature-rich.docx` fixtures. It covers the unified details dialog,
analysis cancellation/cache reuse, view-only loading, lazy editor loading, an
XLSX cell save/reopen, a PPTX slide insertion/save, DOCX viewer isolation and
editing-export separation, citation-preview switching, and the pending-to-ready
viewer transition. BetterOffice's own round-trip and split-viewer tests remain
in the fork and are intentionally excluded from Evo Notes' test-file inventory.
