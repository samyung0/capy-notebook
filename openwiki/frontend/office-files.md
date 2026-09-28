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

Create cards open `/materials/:id` and Files cards open `/files/:id` through SPA router Links, as do dashboard recent rows and workspace file/material rows. Each item remembers its own View/Edit mode in localStorage (`capy.document.mode.<kind>.<id>`); an explicit URL mode wins, followed by the saved mode, then View.
Both routes use the workspace's `CenterContent` header and renderers, with
the app sidebar and a back icon. They omit workspace navigation and Move to
chapter. `FileModeControl` portals file View/Edit and Save controls into that
shared header while each runtime retains its save and collaboration lifecycle.
New standalone notes request Edit explicitly; dedicated quiz/study actions retain their existing behavior.

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

`prebuild`, `pretypecheck`, and `pretest` run
`scripts/prepare-betteroffice.mjs`; `pnpm dev` and Playwright's Vite servers do
not, so run `pnpm office:prepare` first (browser E2E CI does). It installs the fork's locked Bun workspace
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

**Pin bump checklist.** The fork's `bun run test:golden` (the DOCX/PPTX golden
seeds and `shared/office-checkpoint.test.ts`, then the XLSX golden seeds in
`crates/betteroffice-xlsx/tests/storage.rs`) must pass on the new pin; frontend
CI runs it inside `vendor/betteroffice` after the office build. A golden seed
hash that differs between the old and the new pin means the seed output
changed, so the bump ships in a [maintenance window](#maintenance-window).
Golden seeds cover a few fixtures; stored Office changes depend on every stored
base seeding the same bytes. Before deploying a pin to an environment, run the
seed check there: `office-maintenance seed-manifest` in the gateway container
lists every base a stored change names (format, base SHA, seed SHA-256, file
count, a signed base link), and `pnpm office:seed-check <manifest>` re-seeds each
with the new pin's engine (`collaboration/src/seedCheck.ts`). It exits 1 when
any seed hash differs; the pin then ships in a maintenance window whose reset
covers the formats it lists.
Until parser-tolerant XLSX binding lands, any change under `crates/xlsx-parse`,
`crates/xlsx-model` or `crates/betteroffice-xlsx` counts as seed-changing for
XLSX: a room binds to a fingerprint of the whole parse, which four golden
workbooks cannot vouch for.

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
saved checkpoint is ahead of the indexed one (`pendingEffects` is omitted),
with its `stateSeedSHA256`. The host passes that state as `checkpoint` and the
hash as `checkpointSeedSHA256` on the `load` message (protocol version 5); the
runtime applies it over the base with the editor engines in a disposable
`exportCheckpoint` worker, which for a change seeds the base first and refuses
a seed whose hash differs (the same composition as the
collaboration service's headless export), terminates it, and opens the viewer
on the exported bytes. With no unpublished edits the base opens directly and
no editor engine loads. The view is not live: it reflects the state at open,
and a reopen or revision change reads again.

Workspace and standalone file pages read `?mode=view|edit` on entry and update it after accepted toggles. Leaving Edit updates the URL only after checkpoint/export succeeds; failed saves keep Edit, its URL and the saved mode. PDFs and text/CSV sources use the same URL contract.

View and edit use separate iframe lifetimes so the browser can reclaim each
WASM realm. Entering Edit replaces the viewer iframe. Leaving Edit keeps durable
shared changes and previews the exported current replica. Saving requests a database
checkpoint receipt and keeps the editor mounted. Ordinary metadata refetches do
not recreate an active editor, and neither does a completed Office base
handoff: a saved editor keeps its current view read-only under a persistent
banner that says a newer version is available and its changes were saved; the
banner's Reload button reloads the page, which opens the new epoch with empty
Undo/Redo. Starting Edit from a PDF citation creates the editor directly
without warming the native Office viewer.

The parent owns the Hocuspocus provider and Y.Doc. The isolated iframe exchanges
raw Yrs updates with that parent through a versioned message protocol, and waits
for provider sync before restoring its replica. The iframe receives base bytes
and shared state, never an authentication token or protected source URL.

Each format accepts exactly one fork-owned state schema and rejects every
other; there are no migrations. Office editing state stores only what users
changed, over the fingerprinted source that every open requires:

- DOCX seeds under a fixed client id, so seeds and baselines are
  byte-identical. Source images are `media:<part>` references into the source
  package, resolved at lowering; an inserted image keeps its data URL until the
  next publication rebases it into a reference. Charts and drawings the model
  cannot draw (`w:pict`, `w:object`, `mc:AlternateContent`) travel as raw XML
  and export unchanged until edited.
- XLSX (schema 8) keeps the sheet topology plus per-cell overrides keyed by
  stable identity; unedited cells come from the source. Pending effects are
  read off the overrides (`xlsxPendingEffects`: one per changed cell, per row
  or column insert or delete, per formatting range), so XLSX keeps no stored
  baseline. A publication rebases later edits as overrides over the export and
  fails explicitly when the result does not reproduce the latest workbook. An
  array formula keeps its `t="array"` range only while its anchor cell still
  holds its original content; otherwise it saves as a single-cell formula.
- PPTX keeps no parsed package or media in Yjs: both come from the source
  package. Inserted pictures stay binary on their shape until a publication
  writes them into the package. Comments live in `pptx:comments`.

A publication rebases the edits saved after its capture onto seed(export) in
every format (`rebaseOffice` in `vendor/betteroffice/shared/office-checkpoint.ts`),
so the rebased state is stored as its change over that seed and its effects
come from the export's derived baseline. XLSX replays them as overrides. DOCX
and PPTX (`vendor/betteroffice/shared/office-rebase.ts`) apply the later edits
to the captured state, record the resulting Yjs changes and replay each at the
same place in the export's seed: texts are aligned unit by unit (UTF-16 code
units and embeds), entities are paired by place (DOCX stories, tables, rows,
cells and paragraph ids; PPTX slides, shapes, stories, paragraphs, and
comments by slide, author, text and time), DOCX comments by the numeric id the
export writes for them (`commentOoxmlIds`), and an entity created later whose
id the seed already uses is renamed. A DOCX comment anchor the later edits
wrote lands through the alignment of the latest story with the rebased one,
made once per story in a rebase. The reference field the export writes at the
end of a comment made in the editor is a seed unit the later edits never
held, so the alignment treats it as transparent: text typed or deleted beside
it lands beside it, a later delete that spans it deletes it too, and an
anchor may span it. A comment the later edits removed takes its reference
field with it, as removing it in the editor does (removeComment deletes the
comment's reference fields), since an export drops a field that names no
comment. Undo covers the comments root with the stories, so Ctrl+Z after
removing a comment restores it with its field. Such field units are also left
out of the DOCX effects baseline,
where the comment's own entry carries the change.
The rebase fails explicitly when a later edit or such an anchor touches
content the export wrote differently, when a restored slide, shape or
paragraph needs source XML the export dropped (Undo of a deletion made before
the capture), when the rebased text and image effects differ from the
saved ones (DOCX comments compared by author and visible text, since the
export adds the body's reference run), or when the editor's render bridge
refuses a rebased DOCX story (text or a field ahead of a table or content
control in one paragraph slot): the rebase runs the bridge over every story
of the result (`assertDocxRenders`). A refusal (an error the engine raises
with the `Office rebase:` prefix, including XLSX's) is terminal: the
collaboration service answers the publication with 422, the ingest worker
ends the source refresh job without retrying it and records the refusal in
`refresh_error`, and the saved edits stay on the old base for the next
publication. Any other engine error (a trap, a timeout) answers 500 and the
job retries. The check does not verify formatting, which is accepted: DOCX
visual effects are left out because an export writes some formatting its own
way, and PPTX visual effects (shape geometry, layout, text formatting) are
compared only by their count and operation, since they carry no values.

The DOCX export writes page and column breaks from the story's break units, the
way the seed reads them back: the units that open a paragraph slot become
trailing breaks of the paragraph before it (or leading breaks of the slot's
paragraph when none precedes it), a paragraph keeps recorded breaks that still
match its units, and a paragraph whose leading page break is the
`pageBreakBeforeRun` attribute keeps that break. So inserted breaks are saved,
deleted ones stay deleted and an edited paragraph keeps its breaks, in the body
and its block content controls (cells, headers, footers and notes hold no
break units).

The DOCX editor never puts paragraph text ahead of a table, block content
control or page or column break in one paragraph slot, as in Word (the render
bridge refuses that state). Delete at the end of a paragraph just before such
a block, or Backspace at the start of the block's paragraph, does not merge
the two (`merge_paragraphs` in `crates/docx-edit`):

- before a page or column break it removes the break;
- before a table or block content control it removes the paragraph when that
  is empty (nothing but its mark and comment reference fields, which show
  nothing; the table's paragraph keeps its own properties), and otherwise
  changes nothing. The paragraph between two tables belongs to the first
  table's slot, so it is never removed and two tables are never joined.

Delete or Backspace right next to a table or block content control never
deletes it: the user selects it to delete it. A break next to the caret goes
like any character. One engine edit (`delete_at`, `deleteAt` in the session)
makes every Backspace and Delete, resident or not, so suggesting mode,
headers, footers and notes delete and place the caret as the resident path
does. Suggesting mode marks what it removes deleted; only the author's own
pending paragraph mark goes (Backspacing over one's own Enter), so an own
inserted paragraph before an original break still suggests the break's
deletion. Enter at the start of a slot that opens with a block inserts an
empty paragraph before the block and leaves the block's paragraph (id and
properties, borders included) as it was, so Delete in the new paragraph
restores the document; the editor's Enter then gives the next style to
neither paragraph. Any split leaves a section with the mark that ends it (the
new mark never takes `sectPr` or `sectionBreakType`), and a paragraph that
loses its borders in a split loses them from `_originalFormatting` too, so a
save does not write them back.

A range delete (a selection delete or a cut) ending at the start of such a
slot keeps the paragraph mark before it (`kept_mark`), so the text left stays
in its own paragraph, unless the range starts at that paragraph's start: then
the whole paragraph goes. A replacement (type-over, paste) keeps the mark in
both cases, since its text needs the paragraph. Accepting a suggested deletion
of such a mark, or rejecting a suggested insertion of one (an Enter before a
table), keeps the mark while its paragraph still holds content, clearing only
its markers, so text typed into that paragraph stays out of the block's slot
(`ops/resolve.rs`). Text, tabs, breaks and inline objects,
images included, inserted at a location ahead of a slot's leading blocks land
after them, with the caret following (`inline_landing`). The editor ref
API's page break opens the next paragraph slot. The state still arises from
concurrent edits (one editor merges a paragraph while another opens the next
slot with a table), and it does not round trip: the export writes the text
after the table (a page break is kept in place), so the rebase lands edits to
the text but refuses an edit to that table or break, and refuses outright a
result the render bridge refuses.

The collaboration service refuses a client update that writes outside the
engine's document roots (the bundle's `OFFICE_DOCUMENT_ROOTS`, the contributor
map included) or, in PPTX, writes or deletes anything in `pptx:meta` other
than `commentFlavor`. The refusal is the unrecoverable
`source-checkpoint-failed` message, like an oversized update. An update that
only refers to content the room does not hold (the room reloaded without a
client's last unsaved typing, and the client typed before its sync step 2) is
dropped instead, and that connection gets the room's sync step 1: its step 2
reply carries everything the room lacks, the dropped update included, with no
disconnect (`collaboration/src/officeRoots.ts`).

DOCX and PPTX measure and paint with the fork's bundled metric-compatible
fonts (`@betteroffice/fonts`: Carlito for Calibri, Caladea for Cambria,
Liberation for Arial, Times New Roman and Courier New). `DocxEditorHost`
configures them at module scope and the DOCX viewer worker configures them
before layout. Each face the engine loads is also registered as a `FontFace`
under the Office family it stands in for, in the runtime iframe, so the page
paints what was measured (the viewer worker reports its faces with the display
list). The runtime's own interface names only generic families
(`office-runtime.css`), so a document's family never repaints it. PPTX loads
the Liberation Sans faces as `Arial`. The CJK add-on
is not shipped, so CJK text keeps the browser's fonts. A face that fails to load
shows an explicit error instead of the fallback layout
(`src/office-runtime/officeFonts.ts`, `pptxFonts.ts`).

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
characters goes to OCR (`TEXTLESS_CHARS` in `sourceAnalysisCore.ts`). It reads
text only (no operator list) and loads the packed pdf.js CMaps, which Vite
emits as same-origin assets fetched on demand, so non-embedded CJK fonts read
as text rather than scans. The OOXML probe reads ZIP/XML parts:
PPTX slide count is exact, while DOCX pagination (the larger of Word's saved
page count and the body's page breaks), XLSX rendered pages, and every Office
OCR classification are explicitly estimates. XLSX estimates printed
pages from each worksheet's used row/column extent because its eventual
LibreOffice print layout is not available in the browser. Every format stops
at the upload policy's fast-parse `maxPages`. Each PDF.js open, page load and
text read has 5 seconds, since a malformed stream can leave a PDF.js promise
unsettled; there is no whole-document time or memory budget. OOXML extraction
is limited to 4,096 archive entries and 128 MiB of selected expanded XML;
media payloads and unrelated package parts are never inflated by the probe.

The estimate feeds the dialog summary and the page limits, both from
`source-upload-policy` (`parseModes[fast].maxPages` 1,400 and `maxOcrPages`
1,000, the parser's own env values). Every reserved fast-parse source carries
an estimate, so a failed analysis keeps Add disabled until the row is removed
or switched to no parsing. The row names the failure: a user-password PDF (an
owner-password-only PDF opens and passes), a damaged file, more pages than
`maxPages` (fast parsing is also disabled in the row's mode menu), or the
generic message for a transport error or a browser safety limit. A PDF whose
text-less count is above 105% of `maxOcrPages` is refused; from 95% up to that
it warns and uploads, since the count can be off by a few pages and the parser
refuses the file at admission if it really is over. Office OCR estimates miss
slide-master text, so they warn from 95% and never block. The upload sends the
page count, and the gateway refuses a fast-parse reservation above `maxPages`. Images and audio do not enter the
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
room. `source_documents` stores the current state, trimmed net effects and
durable checkpoint. A NULL state means seed(base) until the first edit:
opening, viewing and agent inspect persist nothing, and every instance loads
the same deterministic seed (text seeds under a fixed client too). A writer's
sync writes its contributor marker even when it brings nothing new, so a save
whose room adds nothing to the durable state but markers stores nothing and
answers with the current checkpoint: Saved shows, and a NULL state stays NULL.
The first save with an edit binds the source SHA of a never-parsed upload and,
for text, records its seed's size (`seed_bytes`). An Office state that grew
from seed(base) is stored as its Yjs change over that seed (the update past the
seed's state vector, plus the whole delete set), with the seed's SHA-256 in
`state_seed_sha256`: a one-edit DOCX or PPTX row is under 1 KB instead of the
whole document model. Every write checks that seed plus the change rebuilds the
exact state; every read re-seeds the base, refuses a change whose seed hash
differs (the engine now seeds that base differently: publish it on the
previous engine) and requires that nothing stays pending. Text states are
stored whole; every Office state names its seed (a CHECK since migration
0043). No row stores a baseline: the indexed baseline always derives from the
base, as the decoded text or the engine baseline of seed(base), and the service
caches seeds (with their hashes) and derived baselines by base SHA next to the
bases. A publication without later edits returns the state to NULL. The Go API
rechecks current source access, epoch and account state through a small
access-only endpoint for incoming edits, at most every 5 s per connection. Checkpoint writes check storage
growth (see [storage quota](../backend-storage-quota.md)). The checkpoint answers with the new
checkpoint and an agent edit's receipt only. The browser's editing session read
carries neither the baseline nor pending effects, and a text state only: an
Office editor takes its document from the room's sync. The view read carries
the saved state with its seed hash, and the runtime's export worker seeds the
base, checks the hash and applies the change before exporting. Saved means the
server has acknowledged the requested checkpoint; Ctrl/Cmd+S flushes that same
path. The browser asks for a checkpoint 1 s after typing pauses. Like a
material room, that request only registers its receipt for the room's next
debounced store (source rooms: 5 s idle, 30 s at most,
`COLLABORATION_SOURCE_DEBOUNCE_MS` and `COLLABORATION_SOURCE_MAX_DEBOUNCE_MS`;
material rooms keep 2 s and 10 s), unless no store is waiting to carry it. An
explicit save (Ctrl/Cmd+S, the editors' save buttons, leaving Edit, and the
first sync) sends `flush` and persists at once, as do the publication handoff
and the maintenance pause. A save starts from the instance's last durable copy
of the room while the row still names its checkpoint and base, reading only the row's
pending effects (captions land there without a checkpoint); a conflict reads
the session and state again. Shutdown flushes every room's pending store, and
the collaboration container has a 60 s stop grace period for it. The DOCX File > Save and the PPTX save button request the same
checkpoint through `onSaveRequest`, with nothing serialized. The XLSX save
button has no such hook: it serializes the workbook, and the runtime discards
the bytes and requests the checkpoint. Flushing pending input awaits each editor's own
flush (`flushPendingInput` in DOCX and PPTX; XLSX `flush`, which settles or
throws), and exports use the editors' save APIs, which flush first. Each room
runs one save at a time with at most one queued behind it;
callers arriving while one is queued for the same document share it and
receive its outcome, and a reloaded room's new document queues its own save.
Credits gate parsing and AI work, independently of durable saving.

DOCX blocks text input after a canvas click whose caret cannot yet be placed.
Previously accepted input finishes at its old caret. A fresh click after that
input drains and with available geometry must set a valid selection before typing
resumes; the input exposes placement state and selection for browser checks.
Run language metadata survives the native seed, Yjs projection and OOXML export.
PPTX uses a native textarea for typing, clipboard paste and IME composition.
Save waits for composition to commit, and refuses an unmounted presentation or
an interrupted composition instead of claiming it was saved.
DOCX's accepted input queue and PPTX image decoding report pending work to the
host immediately. That pending state keeps Saving and the close warning active
until native updates reach the shared document, whose durable receipt then
controls Saved. A failed DOCX input queue stays pending until the session ends.

Each incoming source update is checked without copying the room: contributor
markers against the decoded update, and size against an estimate kept from the
room's applied update bytes. The writer's access is revalidated at most every
5 s per connection. Membership, role and share changes, and a user's own
account change, close that user's connections through the collaboration
eviction outbox; anything else (such as the owner's account state for a
collaborator) takes effect within those 5 s, and every checkpoint rechecks each
writer. Only when the estimate passes the 100 MB cap is the
exact size computed; an update over the cap gets an unrecoverable
`source-checkpoint-failed` message, so the client goes to recovery instead of
reconnecting and resending. The exact limit at save still applies.

The browser retains unacknowledged edits in an IndexedDB draft for each actor,
file and editing session. The draft is encoded and written at most every 250 ms,
latest state only, and not at all once a receipt covers it, so a saved draft
never returns as a recovery prompt. The source base is stored once per file and
SHA beside the drafts (database version 3; older draft layouts are dropped) and
removed with the last draft that uses it. Reopening merges compatible drafts; a
receipt removes only the exact draft versions it covers. Another tab's newer
draft remains available. Save, export and handoff first commit open spreadsheet
inputs and wait for active composition or gestures. Pending input counts as
unsaved even before it reaches the shared document.
Network and recoverable save failures leave drafts available. Before sending
buffered updates after reconnect, the parent verifies the current epoch. An old
epoch with unsaved changes enters recovery and permits draft download instead
of merging incompatible updates. Recovery merges drafts from the same old
epoch/base. An explicit Discard this draft action removes only those exact
versions and advances to the next retained group, then the current file.
Downloading alone leaves the drafts intact. A client whose changes were all
saved when it learns about a completed handoff (from the room or on reconnect)
shows the newer-version banner instead; a client with unsaved changes enters
recovery.

Office automatic refresh starts only after a prior successful parse, at least
3,000 trimmed net-change tokens or saved changes left unedited for 7 days, and
60 seconds without a server-observed edit. Every edit resets that idle
interval. A text effect keeps the changed span plus 40 characters on each
side; a move (text that only changed position, as every later paragraph does
when one is inserted) carries no text and counts 0 tokens, so a pure reorder
publishes through the 7-day rule. Manual processing bypasses the threshold. A
store-only Office file (never processed) publishes export-only under the same
trigger, whatever the workspace's auto-reparse setting, through the same
handoff: the saved state becomes the file's bytes with no parser or provider
call and no charge (see Maintenance window below). The owner's Process stays
the opt-in first parse; pressed while such an export runs, it turns that job
into the owner-paid parse of the same capture. Editing continues during
processing. A newer
saved checkpoint is rebound to the candidate's exported source. A started
handoff always completes. Each connected writer goes read-only, flushes pending
input into the document, waits until its provider has nothing unsent, and
reports ready; it does not wait for its own checkpoint receipt. After 10
seconds the service disconnects writers that have not answered (they reconnect
into the new epoch, where unsaved changes go to recovery); a writer that
disconnects is no longer waited for. The service then persists the room once.
The publishing coordinator waits up to 60 seconds for every instance's
acknowledgement, since that persist can queue behind a running save, and then
publishes the source, index and rebased current state (its change over
seed(export)) atomically. The room lock covers that wait plus one Office engine
call (3 minutes), and each instance's recovery watchdog outlasts the lock.
While the room is locked, a reconnecting editor's authentication is refused
with the distinct reason `source-publishing`; the editor reconnects once after
3 seconds without showing an error, and only a second refusal before it
authenticates shows one. Other authentication failures show at once. The
current checkpoint can remain ahead of the indexed checkpoint, with later edits
retained as pending effects. A concurrent save
retries only the local rebase against the same parsed candidate. A connected
editor that answered ready counts as saved and keeps its view under the
newer-version banner; a disconnect clears that, so an editor that loses its
connection before the completion goes to recovery. The new epoch starts with
empty Undo/Redo.

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
collaboration process by SHA within a bounded 128 MiB cache, their seeds and
derived baselines within 64 MiB each. A refresh candidate is copy-on-write:
admission stores no state, the save that first replaces the captured state
copies it into the candidate, and readers take the row's state while no save
has landed since the capture. Headless export,
comparison and asset extraction run in one worker thread. Calls queue on the
main thread with one in flight and time out about 2 minutes after sending; a
WebAssembly trap or a timeout fails that call and replaces the worker, while
engine refusals such as `stale_target` are ordinary results. wasm-bindgen's
broken-object errors (for example "attempted to take ownership of Rust value
while it was borrowed") count as traps, because the engine's cleanup throws
them in place of the trap. A save that fails
inside the engine reports the failure to its clients, who keep their drafts,
and is not queued for the failed-store retry.

## Maintenance window

An engine upgrade that changes seed output runs in a maintenance window; the
steps and the `office-maintenance` commands are in the
[deployment runbook](../deployment-runbook.md#office-maintenance-window).

**Pause.** While the `office_editing_pause` row exists, the gateway refuses
Office edit sessions (`source-session` for editing and `collaboration-token`
answer `423 office_editing_paused` after authorization), and agent edits and
their Undo (tool error `office_editing_paused`, also at the checkpoint that
commits them). Agent inspect reads a NULL state's seed in memory, as always.
The collaboration service refuses writable
connections to Office rooms at authentication with the reason
`office-editing-paused`. Within 5 seconds of the row appearing, each instance
runs the handoff flush on every loaded Office room (up to 10 seconds more),
persists it once, sends `source-editing-paused` and closes the writers; a room
that loads later is flushed on a later tick, a room mid-publication after its
handoff, and a flushed room refuses updates from any writer that slipped
through. Saves of rooms that were already open still land, so the flush and
failed-store retries persist. After `resume`, the next writer's authentication
clears a room's refusal at once. A client whose changes were all saved keeps its
view read-only under the same banner as a completed handoff, saying editing is
paused and its changes were saved; one with unsaved changes goes to recovery.
A client refused on reconnect (a token request answered 423, or the
authentication reason) takes the same path; opening Edit during the pause shows
the paused error. Viewing (`source-session?view=true`) and text sources are
unaffected.

**Publish all.** It refuses to run unless the pause is on. Every Office source
with unpublished edits publishes before the deploy: a system-paid republish (`paid_by='system'`, no credit, storage or
owner-state check) for files of active or blocked owners, export-only for files
never parsed successfully (store-only uploads and failed first parses, so
maintenance never runs a first parse), trashed files, files of suspended or
deletion-pending owners and files whose system republish of the same checkpoint
failed.

**Export-only publication.** The candidate exports and uploads like any
refresh, and the same saved state always exports the same bytes. A maintenance
export-only publication (system payer) publishes in finalize
(`publishExportTx` in `server/internal/store/office_maintenance.go`), since
editing is paused: it makes the export the file's bytes, bumps the epoch,
returns the state to NULL (seed(export), whose baseline derives from the
export), empties pending effects, drops the file's index and caption
associations and evicts the old room. A save after the capture supersedes the
job and a later run exports again. The automatic export of a store-only file
instead keeps the finalized candidate and publishes it through the handoff,
like a refresh after its parse: editors flush, saves made after the capture
are rebased onto the export and stay pending, and open editors get the
newer-version banner. Its storage is gated on the net change at publication,
and finalize renews its job lease for the handoff. A publication refused for
any reason but a superseded candidate (409) parks the file until its next
save.
Unless the file never parsed successfully (then its owner's Process, charged as
the first parse, stays the way to index it) it is marked (`reprocess_at`): the refresh
scheduler then parses and indexes the file's bytes as a plain system-paid parse
job (no page fee), whatever auto-reparse says, once the owner is active and the
file is out of the trash, never while another parse or ingest job is queued for
it. A failed attempt waits a day; a refused one (owner over quota) an hour. The
first reprocess regenerates the descriptor, since none is published.

**Readiness.** `office-maintenance status` fails until the pause is on and no
Office source is unpublished and no Office publication or reprocess work
(source refresh jobs, the parse and ingest jobs they became, system-paid
reprocess jobs) is in flight.

**Reset.** The deploy's reset migration, from
`server/migrations/templates/office_window_reset.sql`, refuses to run unless the
pause is on and nothing of those formats is unpublished or in flight, under a
lock on `source_documents`; that guard is the only protection, since no dropped
state is kept. It then bumps the epoch, drops the state (with its seed hash),
empties pending effects and deletes refresh candidates, so rooms reseed on the
new engine. A file that cannot publish keeps the pause on until an operator
fixes it on the old engine, so no engine ever holds another engine's state.

Migration `0036_docx_language_seed_reset.sql` applies this guarded reset to DOCX
for language-preserving seeds. The four DOCX golden hashes change; XLSX and PPTX
seeds remain unchanged. Run the maintenance window before deploying to an
environment with existing DOCX editing state. An empty environment needs no
backfill.

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

The toolbar uses the shared `useHorizontalWheelScroll` hook for ordinary
mouse-wheel scrolling, with the same input and boundary handling as Tabs and Plate.

Draw chooses Pen or Highlight; Text collects a label before placement; Shape
chooses Rectangle or Ellipse. Highlight applies to text selections, and choosing
it for a fully highlighted selection removes just that selected portion.
The eraser cursor is a 48px-radius circle and removes marks it crosses. Session
undo/redo records inverse API operations, remaps restored annotation IDs and
resets when the viewer unmounts or the source identity changes. The marks remain
durable and private. Failed or partly completed batches clear unreliable history
and refetch the saved marks. Pen geometry is bounded to 4096 points and text to
2000 characters by the store and generated contract.

The marks load beside the document rather than after it: `FileViewer` starts the
annotation read as soon as it knows the file is a PDF, alongside the presigned
link, while the overlay itself still mounts only once pages exist. The document
never waits on its marks. pdf.js loads with its defaults, which stream the whole
file into its worker; reading only the needed byte ranges is not on, because
read links live five minutes and a range read after expiry would fail. The
source-file limit (10 MiB Free, 30 MiB Pro) bounds the bytes held, and pages
mount only near the viewport, so rendered canvases stay bounded too.

## Verification

Focused tests cover source protocol/checkpoint receipts, raw-text selection and
undo, private PDF geometry, pending counts/settings, Go lifecycle and quota
fences, candidate processing and scoped caption reuse. The fork's tests cover
Office CRDT convergence, structural operations, comments, headless restore and
OOXML export. See [the test catalog](../test-catalog.md) for entry points.

The source comparison baseline is separate from the editable Yjs state. It holds
text and stable positions, image hashes and references, and hashes of visual
metadata and is derived from the base, never stored. Office handoff publishes
the rebased saved state as its change over seed(export); open editors show the
newer-version banner. The maintenance window's reset migration
(`0034_office_window_reset.sql`, from the template) drops every Office state
of the old engine so rooms reseed on the new one.
