---
type: Frontend
title: 'Office File Viewing and Editing'
description: 'BetterOffice integration, browser runtime boundaries, upload analysis, and source replacement saves.'
tags: [frontend, office, wasm, xlsx, pptx, uploads]
---

# Office files

Evo Notes uses its BetterOffice fork for modern spreadsheet and presentation
files. PDF stays on the PDF viewer, DOCX stays view-only, and CSV keeps a small
read-only table preview. Legacy `.doc`, `.xls`, and `.ppt` files are rejected by
the source upload policy.

| Format | View | Edit | Engine |
| --- | --- | --- | --- |
| XLSX | yes | yes | BetterOffice XLSX viewer/editor WASM |
| PPTX | yes | yes | BetterOffice PPTX viewer/editor WASM |
| CSV | yes | no | lazy SheetJS preview |
| DOCX | yes | no | existing DOCX renderer |
| PDF | yes | no | existing PDF renderer |

## Repository boundary

The fork is a Git submodule at `vendor/betteroffice`, pinned to a reviewed
commit from `https://github.com/samyung0/betteroffice.git`. Evo Notes imports
source entry points from that exact commit through Vite aliases. Do not depend
on a moving branch at build time.

After cloning Evo Notes, initialize the submodule:

```bash
git submodule update --init vendor/betteroffice
```

`predev`, `prebuild`, `pretypecheck`, and `pretest` run
`scripts/prepare-betteroffice.mjs`. It installs the fork's locked Bun workspace
and builds missing XLSX/PPTX viewer and editor WASM artifacts. A cold build
requires Bun, Rust, `wasm-pack` 0.15.0, and `wasm-opt` from Binaryen. Existing,
intact generated artifacts are reused.

## Browser loading model

`office-runtime.html` is a second Vite entry rendered in a same-origin iframe.
The parent fetches the protected file URL and transfers its `ArrayBuffer` to the
runtime through the versioned protocol in `officeProtocol.ts`.

The runtime starts with a format-specific viewer entry point. Viewer WASM omits
editing, collaboration, undo, and save machinery. The React editor and editor
WASM are imported only after the user presses Edit. Viewer analysis reuses the
already-open handle, so sheet/slide metadata does not trigger a second parse.

The iframe is a resource and lifecycle boundary, not a hostile-content security
boundary. `allow-same-origin` and `allow-scripts` are both required by the
current runtime. The engines are single-threaded; an iframe alone does not
enable `SharedArrayBuffer`. If threaded WASM is introduced later, decide the
COOP/COEP and separate-origin model before enabling it.

## Upload analysis

The upload dialog dynamically imports only the XLSX or PPTX viewer engine for a
selected modern Office file. It rejects files the engine cannot open and shows
the actual sheet or slide count before confirmation. The same file still goes
through the server-owned extension, size, quota, and authorization checks.

PDF page counting remains separate. Office upload analysis is advisory and does
not replace ingestion or decide whether the source is searchable.

## Edit and save lifecycle

BetterOffice reports semantic mutations to the host. Selection and navigation
do not mark the file dirty. Dirty editors confirm before Cancel and register a
browser `beforeunload` warning.

Save serializes a complete OOXML file and sends it to the parent. The parent
submits the current file revision with the replacement. A successful save:

1. keeps the logical file id, name, chapter, and parse settings;
2. increments `files.revision` and rejects stale editors with HTTP 409;
3. swaps the source blob and invalidates the file's retrieval alias;
4. queues full re-ingestion when parsing is enabled, or returns ready and
   unindexed for store-only files.

The current integration does not attempt chunk-level dirty tracking. OOXML edits
can change relationships, formulas, layouts, and shared parts, so full source
replacement and re-ingestion is the smaller correct contract. While that job is
pending, the workspace keeps the newly saved viewer visible and adds an ingest
status banner.

## Fixture proof

The local browser proof uses BetterOffice's `sample.xlsx` and
`betteroffice-demo.pptx` fixtures. It covers upload analysis, view-only loading,
lazy editor loading, an XLSX cell save/reopen, a PPTX slide insertion/save, and
the pending-to-ready viewer transition. BetterOffice's own round-trip and split
viewer tests remain in the fork and are intentionally excluded from Evo Notes'
test-file inventory.
