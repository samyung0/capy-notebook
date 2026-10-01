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

Text and CSV/TSV sources follow the same rule. With no open session (a fresh
open in view mode, or the drop to view after a storage or frozen refusal)
`SourceTextView` reads the same `source-session?view=true` and renders its
text state when one is present, else the published bytes; leaving Edit keeps
rendering the open session's shared text, whose edits the leave just saved.
Every other editable type already views its latest state: materials render
their projected content, and nothing else in a workspace is edited in place.

Workspace and standalone file pages read `?mode=view|edit` on entry and update it after accepted toggles. Leaving Edit updates the URL only after checkpoint/export succeeds; failed saves keep Edit, its URL and the saved mode. PDFs and text/CSV sources use the same URL contract.

View and edit use separate iframe lifetimes so the browser can reclaim each
WASM realm. Entering Edit replaces the viewer iframe. Leaving Edit keeps durable
shared changes and previews the exported current replica. Saving requests a database
checkpoint receipt and keeps the editor mounted. Ordinary metadata refetches do
not recreate an active editor, and a publication leaves it alone (Deferred
publication below). Only a maintenance handoff replaces its base: a saved
editor keeps its current view read-only under a persistent banner that says a
newer version is available and its changes were saved; the banner's Reload
button reloads the page, which opens the new epoch with empty Undo/Redo. Starting Edit from a PDF citation creates the editor directly
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
  and export unchanged until edited. A comment range covers the same content
  from one publication to the next within the story it opened in: the seed
  gives each unit inside a range to every comment open there (another
  comment's reference mark only when the range goes on past it), and the
  export writes range and bookmark boundaries at those story units. Page and
  column breaks are units in every story, so boundaries beside them land
  exactly; a comment opening before a paragraph's leading break covers the
  break, and an editor comment starting exactly at a page break saves starting
  after it, as at a table. Where a range cannot be written exactly it settles
  after one publication:
  - Markers Word nests in a hyperlink, tracked insertion or deletion, inline
    content control, simple field or complex field result move to that
    container's edges at seed (start before, end after). Inside a field
    result they move to the field's edges. An editor boundary inside a
    hyperlink or field moves to its edge the same way, so the comment widens
    to hold it whole.
  - A range crossing into or out of a table or block content control covers
    only the story it opened in and closes at that story's end. It keeps a
    single reference mark: the export generates one only for a comment with
    none anywhere in the document.
  - An editor range starting or ending exactly at a table saves at the start
    of the next paragraph.

  Comments spanning several stories are unsupported, since the editor cannot
  create them. An editor save (download, view bytes) adds reply markers only
  to replies that have none of their own.
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
of the result (`assertDocxRenders`). A DOCX rebase never re-pairs the projected
links and fields of a field result (a table of contents' entries, a REF field's
link): each child in the latest state must land in the rebased state in the
same field and result slot, one to one, or the rebase refuses. So text typed in
such a child after the capture lands only when the export's seed numbers its
field as the capture does (a bookmark hand-off renumbers the surviving
paragraph's fields as the seed does); text typed at a link's end stays in that
link, so a captured slot holding two links lands exactly. A DOCX rebase also
refuses when an edit after the capture touches a comment that would cover
other content than in the latest state (a range typing reversed counts the
units beside it), when a comment would lose both its range and its reference,
when a restored field would lose its separate or end in a later paragraph, and
when the capture's save wrote a new comment's reference ahead of breaks that
open the latest paragraph or a bookmark sits right before such a reference.
Comment boundaries meeting at one point save ends, then empty ranges, then
starts, so direct and rebased saves order them alike. A DOCX rebase also refuses when text
follows breaks that open a paragraph after another paragraph and the rebased
state reads those breaks as leading it while the latest state does not
(`assertBreaksLead`, aligning the two afresh; bookmarks at the breaks count
as the render bridge and the save count them): the capture's save can write a
comment's reference after such breaks, so landing there would differ from a
direct save (`bun run test:matrix` in BetterOffice classifies these
rebase outcomes across breaks, comments next to breaks, fields and Accept/Reject
all against a committed baseline; run it before landing Office changes). Any
failure while landing the later
edits is a refusal (`RebaseError`). A refusal (an error the engine raises
with the `Office rebase:` prefix, including XLSX's) is terminal and leaves the
file due again. A deferred publication rebases only in its rebuild, which
records the refusal and stops (see Rebuild below). A publication that rebases
at once (maintenance) is answered with 422, and the ingest worker
fails the job with the refusal (attempt error code `office_rebase_refused`)
without retrying it or sending the workspace a failed progress event. The saved edits stay on the old base and the file stays
due without a `refresh_error` (its desired checkpoint moves to the latest), so
a fresh publication captures them after the usual quiet period; the capture
holds every saved edit, so only edits saved during that publication can be
refused again. An export-only publication's refusal returns the file to the
scheduler the same way. Any other engine error (a trap, a timeout) answers 500
and the job retries. The check does not verify formatting, which is accepted: DOCX
visual effects are left out because an export writes some formatting its own
way, and PPTX visual effects (shape geometry, layout, text formatting) are
compared only by their count and operation, since they carry no values. UAT reproduces a refusal deterministically: with
`COLLABORATION_UAT_PUBLICATION_HOLD=true`, a publication waits after its
capture, before the handoff, while its file's name contains `[hold-publication]`
(at most 60 s, then it fails with 503), so the refusal journey can save an edit
in between; the deferred publication then completes and its rebuild refuses
that edit ([deployment runbook](../deployment-runbook.md) §12.2).

Every DOCX page and column break is a story unit in every story (body, block
content controls, table cells, headers, footers and notes), seeded and
exported in its place, so inserted breaks are saved, deleted ones stay deleted
and edits after a capture land beside them exactly. A break that opens its
paragraph's text is flagged `leading` (this replaced the `pageBreakBeforeRun`
paragraph attribute): the save writes it as the paragraph's first run, and the
editor keeps the paragraph's space-before after it only while text follows,
as the saved file does. Other breaks that open a paragraph slot are written
as trailing breaks of the paragraph before it. A break with no paragraph
before it and no text to lead (a story's start, right before a table) saves
as a break-only paragraph of its own, and an insertion there after a capture
refuses the rebase; a text-less paragraph whose breaks end in a column break
keeps them, and once text follows they lead it, so the editor shows its
space-before at once. A column break that a comment boundary precedes stays in
its own paragraph instead of closing the one before it. Mid-paragraph breaks stay between their surrounding text after
typing, Enter, Accept/Reject all and publication, including breaks inside
links, inline content controls and tracked changes. The render bridge splits
an inline break into paragraph fragments while keeping one editable paragraph
and one list number. Enter at the start of a heading after a trailing column
break puts the empty line after that break, even if the preceding text changed.
A bookmark opening before a paragraph's leading breaks stays before them, and an empty
list item before a leading break keeps its number. Tracked breaks keep
`w:ins`/`w:del`. The toolbar offers a page break only outside table cells,
headers, footers and notes, as in Word; breaks the file has there are kept.
An AI `replace_text` treats the breaks a paragraph opens with as outside its
replaceable text: inspect lists the paragraph with the text after them, and
the replacement lands after them. A comment over a heading its break opens
keeps covering that break after the heading's text is deleted, in the direct,
rebased and publish-then-edit saves alike, and a comment ending before or at
a leading break keeps every break in place: when such a comment has no
reference mark yet, the save writes its reference after the breaks, so Word
anchors its note on the heading's page.

Word-authored reference marks before leading breaks leave those breaks at the
paragraph start. Draft exports place reply references after the leading breaks
too. Comments starting at the heading's text keep that start across captures,
and a source reference in the next paragraph does not move its range. Comments
added after a capture and ending before a trailing break keep excluding it in
both direct and rebased saves. Empty-comment behavior is the same in body text,
table cells, header cells and endnotes when tested with the same session ids.

BetterOffice builds with a patched yrs 0.27.3 (`third_party/yrs`, through
`[patch.crates-io]`): its `clean_format_gap` counts a map embed (a field,
paragraph mark or break) as content, as JS Yjs does, so a delete before a
field no longer spreads the deleted text's link and field marker onto the
field. Without it, one Backspace at the end of a table of contents' first
entry removed the whole TOC field from the saved file. The native viewer,
Python bindings and fuzz workspaces use that same copy, including the native
viewer's UTF-8 validation in both update decoders. WASM fingerprints include
the vendored source so changes rebuild the engines.

The DOCX render bridge refuses paragraph text ahead of a table or block content
control in one paragraph slot. Page and column breaks can follow text within a
paragraph. Delete at the end of a paragraph just before a block-led slot,
or Backspace at the start of that slot's paragraph, does not merge
the two (`merge_paragraphs` in `crates/docx-edit`):

- before a page or column break it removes the break, unless the paragraph
  is empty: then Delete at its end, or Backspace at the start of the break's
  paragraph, removes the empty paragraph and hands its bookmarks to the
  paragraph that stays, so Enter at the start of a break's paragraph then
  Delete or Backspace restores the document. Deleting the text after a break,
  or Enter right after it, leaves the break before an empty paragraph;
- before a table or block content control it removes the paragraph when that
  is empty (nothing but its mark and comment reference fields, which show
  nothing; the table's paragraph keeps its own properties), and otherwise
  changes nothing. The paragraph between two tables belongs to the first
  table's slot, so it is never removed and two tables are never joined.
- an empty paragraph whose mark ends a section is not empty for either rule,
  so the section break stays.

Delete or Backspace right next to a table or block content control never
deletes it: the user selects it to delete it. A break next to the caret goes
like any character. One engine edit (`delete_at`, `deleteAt` in the session)
makes every Backspace and Delete, resident or not, so suggesting mode,
headers, footers and notes delete and place the caret as the resident path
does. Suggesting mode marks what it removes deleted; only the author's own
pending paragraph mark goes (Backspacing over one's own Enter, or removing an
own empty paragraph before a break). Enter at the start of a slot that opens
with a block inserts an
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

DOCX field containers stay where Word wrote them across publications:
bookmarks inside `w:fldSimple`, a simple field inside a hyperlink or `w:ins`,
tracked changes and content controls inside `w:fldSimple` or a complex field's
result (one spanning paragraphs included), tracked changes and foreign markup
inside field code, and a complex field nested in field code (mail-merge
`IF { MERGEFIELD }`). Text beside a field character in its run is kept.
Single-paragraph fields stay balanced when a revision wraps only one of their
field characters. The editor shows a field's result with inserted and
content-control text and without deleted text. Projected children of a field
result (TOC entry links, a REF field's link) keep their field marker through
Clear formatting, and text typed over a range that removes their field takes
no field number, so the export never moves them into another field. Complex
fields inside links, links inside tracked changes, tracked changes and content
controls inside links, whole fields inside `w:ins` or `w:del`, and nested
`w:ins`/`w:del` pairs retain their content and wrappers. Block content controls
inside table cells retain their blocks on export. A table of contents keeps
its entry links' nested `PAGEREF` fields, its `fldChar w:dirty` flags, and
separate/end characters in their authored paragraphs, including characters
inside links, revisions and inline controls. Their anchors move with edits and
translate across publication, including paragraphs without source ids.
Nested fields keep distinct anchors when both cross a paragraph boundary.
Typing at a link's end keeps its history, frame and document-location
attributes; unbolding a field's first child does not restore its old bold.
Plain result runs after a projected simple field seed as that field's text.

Enter inside a projected link or TOC entry, or after a projected simple
field's own result text, splits the field across the two paragraphs: its begin
stays in the first, the result after the split point moves into the second as
plain result runs, and the field ends after them. Undo restores the original
field. Backspace, Delete or a range delete back rejoins it when only the moved
runs sit there, in order; otherwise the split stays, keeping every run and
typed character. A field whose result holds a kept insertion, a content
control or foreign markup after the split point keeps the old Enter (the text
after it leaves the field). Text typed at the end of a paragraph whose field
code continues into the next lands ahead of the field. Follow-up fork task:
two peers joining a just-split field at once can duplicate or revive text, the
join drops formatting applied to the moved text, and text typed at the end of
a paragraph whose field result continues saves inside the result while the
editor shows it after the field.

Bookmarks use zero-width positions in the shared `bookmarks` root, covered by
Undo and publication rebasing. Typing moves their boundaries, Enter leaves one
copy, and joins or accepted paragraph-mark deletions retain them. Markers in
links and inline controls survive export. Empty ranges remain together before
new text. Coincident bookmark and field markers keep their source order, every
bookmark start saves before its end (also when a join collapses several to one
point), and Undo and Redo re-anchor bookmarks where they stand, so the editor
and the save agree. Generated comment paragraph ids reserve the ids already used by the
document, headers, footers and notes.

Seeds changed with the break and field-container rules, bookmark anchors,
formatting revisions, multi-paragraph fields, Word comment references
before leading breaks, result runs after projected simple fields and source
order for bookmarks in paragraphs holding continued field characters, so these pins ship in a
[maintenance window](#maintenance-window).

The DOCX toolbar has no Editing/Suggesting/Viewing dropdown: the editor always
edits directly, and Capy's View/Edit control is the only mode (the engine's
suggesting support stays unused). Tracked changes that come with a Word file
stay visible in the sidebar, which pins **Accept all** and **Reject all** above
its change list whenever the document holds changes, including those kept
inside fields, which stay out of the per-change list; when only those exist,
one line above the buttons says the changes are inside fields, such as a table
of contents. Each is one undo step and keeps the editor focused. They resolve
changes only: a field whose kept changes resolve becomes what the seed makes of
its export, a projected child the user edited keeps its edit and one the user
deleted stays deleted, and a child resolves only for the field that records it.
Run-formatting revisions (`w:rPrChange`) appear in the change list; Accept keeps
the current formatting and Reject restores the previous formatting. Both also
resolve revisions in nested fields and controls and remove resolved move
wrappers and range markers. Deleting a break in a field result removes it from
the saved field too.

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
the Liberation Sans faces as `Arial`. The CJK add-on (`@betteroffice/fonts-cjk`:
Noto Sans TC, SC, JP, KR and Noto Serif SC, 4.5 to 11.6 MB each) ships as
same-origin, content-hashed assets that load only when a document's text or
fonts need that script, so the engine measures CJK text with the face the page
paints; without them CJK text overlapped in view and vanished in edit. Han text
without kana or Hangul uses the Simplified bucket, so a Traditional Chinese
file can load both Chinese faces. A face that fails to load
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
`source-checkpoint-failed` message, so the client resets to the last saved
version instead of reconnecting and resending. The exact limit at save still
applies and is final too (a 413 `SourceRequestError`, never retried).

The browser retains unacknowledged edits in an IndexedDB draft for each actor,
file and editing session. The draft is encoded and written at most every 250 ms,
latest state only, and not at all once a receipt covers it, so a saved draft
never returns as a recovery prompt. The source base is stored once per file and
SHA beside the drafts (database version 3; older draft layouts are dropped) and
removed with the last draft that uses it. Reopening merges compatible drafts; a
receipt removes only the exact draft versions it covers. Another tab's newer
draft remains available. Save, export and handoff first commit open spreadsheet
inputs and wait for active composition or gestures. Pending input counts as
unsaved even before it reaches the shared document. Draft storage that fails
(private mode, a full disk, a draft whose base is gone) is skipped, never an
editing error. A save refused for good clears the session's drafts before it
resets the editor.
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
trigger, whatever the workspace's auto-process setting: the saved state
becomes the file's bytes with no parser or provider call and no charge (see
Maintenance window below). The owner's Process stays the opt-in first parse;
pressed while such an export runs, it turns that job into the owner-paid parse
of the same capture. Editing continues during processing.

**Deferred publication.** An Office publication of the owner's or automatic
work (every one but a maintenance publication) never touches open editors: it
swaps the file's bytes and index, and editing stays on the old base and epoch
(`rebuild_pending`, `published_state`: the published capture as its change over
seed(base), migration 0046). Edits saved after the capture stay pending,
measured against that capture on the old base (the engine's `compare`, XLSX
included), which gives the same text effects the rebuild later reports. A
save carries the base revision its effects were measured under, so one
measured before a publication is refused and retried. The
viewer reads the old base plus the state while the rebuild waits. Nothing is
charged for the kept capture or the old base.

**Rebuild.** Once nobody has the room open, the collaboration service moves
editing onto the published file (`SourceHandoff.rebuild`): it rebases the edits
saved after the capture onto seed(published) first (nothing saved since: the
state is seed(published)), then locks the room, asks every instance whether
the room is in use (the document still loaded, so a connection or a store
before it unloads; a store running or waiting for its retry; a document
loading; a socket still authenticating from before the lock check; during the
maintenance pause only writers count, since the pause saved the room), and on
all idle sends the gateway
a compare-and-swap (`POST /internal/collaboration/files/{id}/rebuild`: epoch,
latest checkpoint and published bytes unchanged, no refresh in flight) that
opens a new epoch on the published base and releases the old one. The lock
(30 s) covers only the probe (2 s) and the swap, so a connect in that moment
waits one silent 3-second retry. Every locked step runs against the lock's
expiry: a probe answer read after the 2 s window counts for nothing, the swap
is sent only while its 15 s request plus a 3 s margin still fit, the service
abandons it after 15 s and the gateway ends its transaction after 10 s. So a
swap never commits after the lock lapses, when a writer could have joined the
old epoch; a late step gives up and a later attempt retries. A room in
use, a save or a publication in between leaves it for later. It runs when a
room unloads on an instance and from a sweep every minute (a room found in use
waits five minutes, an error ten). A room that never empties keeps the old
base, and the kept capture, until it does. A rebase the engine refuses
(`RebaseError`; any other error retries as above) is reported once and
recorded through the gateway (`POST
/internal/collaboration/files/{id}/rebuild-refusal`, the row's
`rebuild_refusal`, migration 0047), and no instance tries that rebuild again.
The file is due again whatever its edits weigh, as after a refused
publication: the next automatic publication (paid as usual, after the usual
quiet period; with auto-process off, the owner's Process) captures the room's
latest state on the old base, every edit since the refused capture included.
Its job payload carries the refusal (`rebuildRefusal`), its publication clears
the refusal, and its own rebuild lands, since nothing follows its capture, once
the room is empty on every instance. The service never rebuilds a
trashed file; a restore returns it to the sweep, and maintenance `publish-all`
performs the swap for a trashed file with nothing saved since its publication
(nobody can open or save it, and the rebuilt state is the published file), so
readiness does not wait on it until the trash purge.

The immediate handoff remains for a maintenance publication, where editing is
paused anyway. A started handoff always completes. Each connected writer goes
read-only, flushes pending input into the document, waits until its provider
has nothing unsent, and reports ready; it does not wait for its own checkpoint
receipt. After 10 seconds the service disconnects writers that have not
answered (they reconnect into the new epoch, where unsaved changes go to
recovery); a writer that disconnects is no longer waited for. The service then
persists the room once. The publishing coordinator waits up to 60 seconds for
every instance's acknowledgement, since that persist can queue behind a running
save, and then publishes the source, index and rebased current state (its
change over seed(export)) atomically. The room lock covers that wait plus one
Office engine call (3 minutes), and each instance's recovery watchdog outlasts
the lock. While the room is locked, a reconnecting editor's authentication is
refused with the distinct reason `source-publishing`; the editor reconnects
once after 3 seconds without showing an error, and only a second refusal before
it authenticates shows one. Other authentication failures show at once. The
current checkpoint can remain ahead of the indexed checkpoint, with later edits
retained as pending effects. A concurrent save retries only the local rebase
against the same parsed candidate. A connected editor that answered ready
counts as saved and keeps its view under the newer-version banner; a disconnect
clears that, so an editor that loses its connection before the completion goes
to recovery. The new epoch starts with empty Undo/Redo, as it does after a
rebuild.

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
Opened in view mode without a session, the preview reads the saved state from
the viewer's session (see "Viewing shows the last saved state" above).

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
inside the engine is not queued for the failed-store retry: the room is
discarded and its clients reset to the last saved version (see
[error handling](error-handling.md#collaborative-source-failures)).

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
instead keeps the finalized candidate and publishes it deferred, like a
refresh after its parse: open editors keep their document, saves made after
the capture stay pending against it, and the rebuild moves editing onto the
export once the room is empty. Its storage is gated on the net change at
publication, and finalize renews its job lease for the publication. A publication refused for
any reason but a superseded candidate (409) or a refused rebase (422
`Office rebase:`) parks the file until its next save.
Unless the file never parsed successfully (then its owner's Process, charged as
the first parse, stays the way to index it) it is marked (`reprocess_at`): the refresh
scheduler then parses and indexes the file's bytes as a plain system-paid parse
job (no page fee), whatever auto-process says, once the owner is active and the
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
metadata and is derived from the base, never stored (while a rebuild is
pending, from the published capture on the old base). A rebuild, or a
maintenance handoff, stores the rebased saved state as its change over
seed(export); only the handoff shows open editors the newer-version banner. The maintenance window's reset migration
(`0034_office_window_reset.sql`, from the template) drops every Office state
of the old engine so rooms reseed on the new one.
