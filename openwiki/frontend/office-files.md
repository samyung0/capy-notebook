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
chapter. `FileModeControl` portals file View/Edit (and, for text files, Save)
controls into that shared header while each runtime retains its save and
collaboration lifecycle. DOCX, XLSX and PPTX use the two-row Office header
described under [Browser loading model](#browser-loading-model).
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
same origin. The runtime's first message, `initialized`, carries its
`OFFICE_PROTOCOL_VERSION`. A different version means a deploy replaced the
runtime or the app while the tab stayed open, so the host shows "An update is
ready" with a Reload button (`FileUnavailable` kind `outdated`) instead of
waiting for a runtime that ignores its messages. A host from before this check
still waits on its first mismatch.

The runtime starts with a format-specific viewer entry point. XLSX/PPTX viewer
WASM omits editing, collaboration, undo, and save machinery; the DOCX viewer
does not expose those operations but still shares its one-time OOXML lowering
bridge with the editor. The React editor and editor WASM are imported only after
the user presses Edit. DOCX lowering runs in a disposable worker that terminates
as soon as it transfers the immutable display list, so its parser, transient
Yrs projection, and viewer linear memory are absent during ordinary reading.
Viewer analysis reuses the already-open handle, so sheet/slide metadata does not
trigger a second parse. Every viewer and editor sends `ready` once its first
pages, grid or slide (pictures included) are painted, with the runtime's own
`timings` (frame start to `load`, `load` to first paint) for
`pnpm bench:office`; the host's loading skeleton stays until then. The DOCX
editor's signal is `docx-pages-presented`, the XLSX and PPTX editors'
`onFirstPaint`, once per opened file. An edit frame's `ready` leaves the host's
error state alone.

The DOCX editor lays pages out in a resident engine worker. A request's timeout
starts when the worker begins it; a request the worker never starts gives up
after 60 s. Either way the main thread then takes over, and editing continues on
the main thread's frames rather than failing the editor. Range and caret queries
read only the pages a range touches, and a query object superseded by a newer
layout answers from its current shifted pages. In documents over 12 pages the
screen-reader mirror under the canvas is positioned only for pages within two of
the viewport; the others get a plain-text copy (roles, links and language kept),
swapped in at idle, so screen readers reach the whole document while scrolling
stays cheap. The positioned mirror follows the viewport only once the scroll
has held still for 300 ms, so pages that scroll past keep their plain text.

DOCX view mode (`DocxDisplayListViewer`) makes that mirror its text layer, as a
PDF viewer's: there is no second copy of the text. The positioned mirror's text
is transparent and hit-testable (a text cursor over text) and is painted only
while a selection exists, so reading and scrolling paint nothing new; the
selection is the editor's blue, `rgba(66, 133, 244, 0.3)`, on the white page in
both themes. Far pages keep the invisible, pointer-inert plain-text mirror.
Headers, footers, chart labels, repeated table header rows and runs clipped out
of their row (a row split across pages repeats its cut line, which is not
painted, and an exact row height can hide text) are not selectable; the mirror
hides those clipped runs from screen readers too. Body, footnotes and endnotes
are separate stories, as in Word: a selection keeps to the story it starts in
(its anchor), so a body selection neither highlights nor copies note text and
one started in a footnote copies footnote text only. Cmd/Ctrl+A selects the
body (the document's pages, not the frame), or every footnote (endnote) when
the selection is in one. A press on empty page area clears the selection.

Each glyph cluster is its own positioned run, so
`packages/docx-react/src/components/textLayer.ts` rebuilds what the browser
would get wrong. Copy (Cmd/Ctrl+C and the context menu's Copy, through the
`copy` event) writes plain text as the editor copies it: paragraphs and line
breaks as newlines, tabs as tabs, fields as their shown text, list numbers and
bullets as shown followed by a tab (Symbol and Wingdings markers as the Unicode
character the fonts' tables map them to, such as ✓ or ➢, otherwise •), table
cells tab-separated and rows on their own lines. Tabs and line breaks come from
the display list (`tabsBefore`, `breaksBefore`, `tabsAfter` and `breaksAfter`
on runs, so a tab ending a line or paragraph is kept), not from gaps in the
runs' document positions, which hidden text and content-control edges also
leave; a tab leader's dots copy as the tab. Double and triple click select the
word (`Intl.Segmenter`) and the paragraph's part on that page. Far pages are
copied from a positioned mirror built off-DOM at the same text offsets. A page
holding a selection end (or the caret a drag starts from) keeps its positioned
mirror when it leaves the viewport until the selection lets go of it, and while
a mouse or pen drag is held the page window moves at once (no 300 ms settle),
so an auto-scrolling drag keeps extending the selection; a touch press pans, so
touch scrolling keeps the settle. A left click on a mirror link does nothing;
hovering shows its URL and right-click offers the browser's link menu (new tabs
are blocked by the frame's sandbox). Copied text is what the pages show: a
table row split across pages copies as two rows, rows set to an exact height
that hides their text copy nothing, and a vertically merged cell's continuation
adds no empty cell.

Viewing shows the last saved state, not only the last published blob. View
mode reads `GET /api/files/{id}/source-session?view=true`, a lock-free read
(read authorization only, no `source_documents` row is created, no account
lock, so a suspended owner's shared files keep rendering) that returns the
presigned base URL and checkpoint numbers and carries `state` only when the
saved checkpoint is ahead of the indexed one (`pendingEffects` is omitted),
with its `stateSeedSHA256`. The host passes that state as `checkpoint` and the
hash as `checkpointSeedSHA256` on the `load` message (protocol version 7); the
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
checkpoint receipt and keeps the editor mounted. The workspace keeps the viewer
under one parent at every breakpoint, since moving an iframe reloads it, so
resizing never reopens the document. Ordinary metadata refetches do
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
other content than in the latest state (a range typing reversed covers what lies
between its ends), when a comment would lose both its range and its reference,
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
as the saved file does. A paragraph whose text ends in a page break (Enter
right after a mid-paragraph break, or deleting the text after one) keeps its
mark on the break's page, as Word does when the file does not set
`splitPgBreakAndParaMark`: the last text part runs to the mark
(`flush_paragraph_parts`), the next paragraph opens the next page, and a
caret at the mark sits after the text (`caret_rect` in
`docx-layout/src/hit.rs` places a position nothing paints after the text
before it). The parser does not read `splitPgBreakAndParaMark`, so a file
setting it still lays out Word's default way. Copy follows the units: after
Enter right after a mid-paragraph break, edit-mode copy writes the break's
newline and the paragraph mark's, an empty line the reopened file (break on
the next paragraph) does not copy (accepted, 2026-10-08). The seed moves a file's page
break after a paragraph's last text onto the next paragraph's slot, which
lays out the same, so the editor and the reopened file look alike while
their units differ (the toolbar's break opens the next slot and saves as the
previous paragraph's trailing break, so the seed keeps reading such breaks
that way). Other breaks that open a paragraph slot are written as trailing
breaks of the paragraph before it. A break with no paragraph
before it and no text to lead (a story's start, right before a table) saves
as a break-only paragraph of its own, and an insertion there after a capture
refuses the rebase; a text-less paragraph whose breaks end in a column break
keeps them, and once text follows they lead it, so the editor shows its
space-before at once. A column break that a comment boundary precedes stays in
its own paragraph instead of closing the one before it. Mid-paragraph breaks stay between their surrounding text after
typing, Enter, Accept/Reject all and publication, including breaks inside
links, inline content controls and tracked changes. The render bridge splits
an inline break into paragraph fragments while keeping one editable paragraph
and one list number. Each fragment after the first gets its own layout block id
(the paragraph's id plus `#n`; `n` steps from the part before by the page and
column breaks between them, at least one, so a gap holding only shapes or
charts steps by one), since layout, painting and the resident
display look measured blocks up by id; the text after the break starts at the
top of the next page or column at the paragraph's left indent, without
first-line or hanging indent, space-before or number, as Word continues the
paragraph there. The paragraph's space-after and a tracked paragraph mark's
pilcrow stay on its last part. A paragraph an in-flow chart splits gets the
same per-part ids. Copy puts a newline at each break in view and edit mode,
as at a soft line break, so two breaks in a row copy two and a soft break then
a page break copies as two soft breaks: the editor's `yrsSelectionText` writes
one at each break that text comes before in its paragraph (a break opening the
paragraph follows the previous mark's newline), view mode one for each step in
the part number (`textLayer.ts`), and the editor's copy stays not plain text,
so ⌘X over a break only copies. An inline chart paints on a line of its own:
a gap between two parts holding only charts copies one newline in both modes
(`yrsSelectionText` writes it before the text after the chart), and beside a
break it adds none; a chart opening a paragraph counts as no text before a
break. Other inline shapes copy nothing in edit mode, while view mode copies
one newline for a gap holding only them. Enter at the
start of a heading after a trailing column break puts the empty line after
that break, even if the preceding text changed.
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
`[patch.crates-io]`) carrying two fixes until a fixed yrs release exists. Its
`clean_format_gap` counts a map embed (a field, paragraph mark or break) as
content, as JS Yjs does, so a delete before a field no longer spreads the
deleted text's link and field marker onto the field. Without it, one Backspace
at the end of a table of contents' first entry removed the whole TOC field from
the saved file. Its `follow_redone` keeps the offset into an item Undo or Redo
restored, as Yjs's `followRedone` does, so a position inside restored text
stays on its unit and an Undo after delete, Undo, Redo removes only its own
step. The native viewer,
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
  Delete or Backspace restores the document. Deleting the text after a
  break that has text before it leaves the break ending its paragraph, the
  mark on the break's page; after a break that opens its paragraph it leaves
  the break before an empty paragraph;
- before a table or block content control it removes the paragraph when that
  is empty (nothing but its mark and comment reference fields, which show
  nothing; the table's paragraph keeps its own properties), and otherwise
  changes nothing. The paragraph between two tables belongs to the first
  table's slot, so it is never removed and two tables are never joined.
- an empty paragraph whose mark ends a section is not empty for either rule,
  so the section break stays.

Delete or Backspace right next to a table or block content control never
deletes it: the user selects it to delete it. A break next to the caret goes
like any character. Backspace and Delete beside a field that shows nothing (a
table of contents' own marker, a REF over links only, the first half of a
split field, a comment reference) step over it and delete the visible
character past it, or join at the paragraph mark there; Delete before one that
ends a story does nothing. Only a selection covering such a field removes it.
A field that shows text (DATE, a TOC entry's page number) deletes as one unit,
Undo restoring it. One engine edit (`delete_at`, `deleteAt` in the session)
makes every Backspace and Delete, resident or not, so suggesting mode,
headers, footers and notes delete and place the caret as the resident path
does. Suggesting mode marks what it removes deleted; only the author's own
pending paragraph mark goes (Backspacing over one's own Enter, or removing an
own empty paragraph before a break). Enter at the start of a slot that opens
with a block inserts an
empty paragraph before the block, with the block paragraph's properties,
and leaves the block's paragraph (id and properties) as it was, so Delete in
the new paragraph restores the document; the editor's Enter then gives the
next style to neither paragraph. Every split keeps the paragraph's borders on
both halves, as Word copies the paragraph mark (mid-paragraph, at its start or
end and before a block), and leaves a section with the mark that ends it (the
new mark never takes `sectPr` or `sectionBreakType`). Enter at a paragraph's
end inserts the new mark after the existing one (`split_paragraph` in
`ops/paragraph.rs`): the text keeps its mark and id, so a peer's concurrent
paragraph change stays on the text and two peers' Enters at one end give each
new paragraph its own id. A section's last paragraph, and suggesting mode
(whose Backspace retracts the mark it deletes), keep inserting before the
existing mark. Mid-paragraph the new mark ends the first half with the
paragraph's id, so two peers splitting one paragraph mid-text both give their
first half that id. After applying a peer's update, every peer renames the
duplicates the same way (`applying_peer_update` and
`rename_duplicate_para_ids` in `ops/paragraph.rs`, run by the session's
`applyUpdate`): it looks only at the ids of paragraph marks the update
inserted or re-identified (a merge's survivor), in their stories, so typing
and other updates cost nothing extra; the mark whose yrs item has the lowest
`(client, clock)` keeps the id and every other takes `{client}.{clock}` of
its own item, as a system edit outside Undo, so typing, clicks and AI edits
reach both halves. A client loading a stored state renames once after the
load (`seedYrsSession`), so a state stored before both splitting peers
exchanged does not keep the duplicate for a later session. If the peer whose
split kept the id undoes it after the rename, the survivor keeps the other
half's renamed id and no paragraph carries the source id any more. Exports
from a stored state that still holds the duplicate (office-checkpoint loads
without renaming) take the save's backstop: a source `w14:paraId` stays on
the first paragraph and each repeat gets a hex id, as for editor ids, in
both engines (`savedParaId` in `yrsToDocument.ts`, `saved_para_id` in
`office-service/src/docx/project.rs`).

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
A positional tab (`w:ptab`) round-trips with its alignment, `relativeTo`,
leader and run formatting. View and edit mode lay it out as ECMA-376
§17.3.3.23 and Word's alignment tab do: ignoring tab stops, the text up to the
next tab or line break is aligned left, centred or right at the margin
(`relativeTo="margin"`: the text area's edges or its middle) or between the
paragraph's indents (`indent`), the gap filled with the tab's own leader; a
position the line has already passed is taken on the next line. The text
never runs past the line's right edge (a margin tab in a paragraph with a
right indent stops at the indent), and a tab missing either attribute stays
an ordinary tab, painted with the leader of the stop it reaches. Text boxes
lay it out within the box; they have no indents, so `indent` acts as
`margin` there.

Enter inside a projected link or TOC entry, or after a projected simple
field's own result text, splits the field across the two paragraphs: its begin
stays in the first, the result after the split point moves into the second as
plain result runs, and the field ends after them. Undo restores the original
field. Backspace, Delete or a range delete back rejoins it when only the moved
runs sit there, in order (struck text only where Enter moved a tracked
deletion, so a deletion suggested on moved text survives the join); otherwise
the split stays, keeping every run and
typed character. A nested field after the split point that projects nothing
of its own moves into the second paragraph as its own field, inside the split
field's result, and goes back with the join; a tracked deletion of plain
text (text and tabs) there moves with it, keeping its text position (struck
text in the second paragraph), so Reject All while split restores it in
place. Accept or Reject All while a field is split resolves the field without
the content Enter moved out, which resolves where it now is (the moved runs
were duplicated before 2026-10-05), and once that content is resolved the
field reports no change left for Accept or Reject All. Enter racing a peer's
delete of the whole field may bring the field back (accepted with the
concurrent-join class); both peers pressing Enter in one link may duplicate
the field and the moved content (accepted 2026-10-06 with the concurrent-join
class, recorded in the matrix). A
field whose result holds a kept insertion, a tracked deletion holding more
than text (a simple field, a note reference, a bookmark, a break, a control
or a symbol), a content control, foreign markup or a nested field holding a
link after the split point keeps the old Enter: the link text before the
split leaves the field in the save, while the editor shows it in the field
until the join or a publication. Text typed at the end of a paragraph whose field
code continues into the next lands ahead of the field. Two peers joining a
just-split field at once can duplicate or revive text, and the join drops
formatting applied to the moved text (both accepted).

A split or joined field shows what the seed of its save shows: its own result
runs while a link or simple field stays projected (a nested field before the
link shows nothing), and its whole result, nested fields included, once
Backspace, a range delete, Accept All of a suggested deletion or a type-over
removes its last projected link. Only the shown text changes, so peers doing
so at once agree. A moved run that shows nothing (an empty or formatting-only
run) or holds a single line break or positional tab goes back with the join in
its place. Text left ending a continued result after its last link is deleted
stays in the field, which shows it, until the next publication reads it as
text after the field (no tail move, so concurrent deletes converge without
duplicates); until then Backspace at that paragraph's end deletes the whole
field. After a peer's delete that ends at a field projecting links or simple
fields, each receiving editor re-reads that field's shown text and writes it
into the room as a system edit (outside Undo; all peers compute the same
value), so two peers each deleting half of the last link both show what one
peer deleting all of it shows. The lookup steps right from the delete's last
item (a read-only `Store::next_live_item` added to the vendored yrs), so other
deletes cost no story walk. Undo by one of them then restores its half
without the link and child marks, before the field (accepted 2026-10-05, also
for a plain hyperlink); after deletes made one after the other, that Undo can
leave the editor's shown text stale (`REF=` where the save shows `REF=7`)
until publication.

The plain runs (text, plain line breaks, comment references, and tabs or
positional tabs without their own formatting) that end the first paragraph's
part of a continued field's result seed as editable text after the field
marker, as the result in later paragraphs does: text typed at that
paragraph's end stays where it was typed in the editor and the save, and
Backspace there deletes one character. An untouched save may regroup those
runs and write a line break's `w:type="textWrapping"`, and a comment
reference's run loses its `CommentReference` style, as references elsewhere
do. A run holding a page or column break, a line break with its own
formatting or `w:clear`, or a formatted tab stays in the field with the runs
before it, so those save as before. After Enter in such a field's link, the
join stops at that text (or at a comment reference) while the field continues
past the joined paragraph. The same holds for moved runs a join leaves ending
the paragraph while the field continues past it (Enter, Enter again in the
moved text, then Backspace): they stay text after the field, unless the field
keeps content after them, when they go back in order. Text typed right after a comment reference ending
the tail is counted inside the comment once reopened, because the parser
hoists the comment's end out of the field (unstable, as before).

Bookmarks use zero-width positions in the shared `bookmarks` root, covered by
Undo and publication rebasing. Typing moves their boundaries, Enter leaves one
copy, and joins or accepted paragraph-mark deletions retain them. Markers in
links and inline controls survive export. Empty ranges remain together before
new text. Coincident bookmark and field markers keep their source order, every
bookmark start saves before its end (also when a join collapses several to one
point), and after Undo or Redo a bookmark, comment range or continued field
end whose own text the step restored is re-anchored onto it (one beside
restored text keeps its anchor until the Undo that restores its own), so the
editor, peers and the save agree. Generated comment paragraph ids reserve the ids already used by the
document, headers, footers and notes.

Seeds changed with the break and field-container rules, bookmark anchors,
formatting revisions, multi-paragraph fields, Word comment references
before leading breaks, result runs after projected simple fields, source
order for bookmarks in paragraphs holding continued field characters, the
plain tails of continued field results (line breaks and comment references
included) and positional tabs, so these pins ship in a
[maintenance window](#maintenance-window). UAT rooms of files holding a
continued result with a plain tail, or a `w:ptab`, are refused until
republished. No golden fixture holds either, so the golden seed hashes are
unchanged.

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
the current formatting and Reject restores the previous formatting. A tracked
deletion keeps what it holds through edits to its paragraph: deleted text inside
a simple field or a link reads as text (the field keeps its result, the link
its text), and a deleted note reference saves inside its `w:del`; every saved
note reference keeps its run formatting (its FootnoteReference style). Both also
resolve revisions in nested fields and controls and remove resolved move
wrappers and range markers. Deleting a break in a field result removes it from
the saved field too.

DOCX, XLSX and PPTX files have a two-row header in both modes, inside the
usual 56px (`CenterContentHeader` picks it by extension, `officeFormatOf`):
a 4px gap under the panel's top edge, two 24px rows 2px apart, then the
divider. The top row holds back, the sidebar toggle, the workspace picker (a
24px pill with 6px padding, slimmer than elsewhere) and the file name; the row
under it holds Google-style menus from the left edge (File, Edit, View,
Insert, Format…, 24px triggers) with the save status as icon and word after
them. The mode toggle, header actions (PPTX Present) and ⋮ sit right, centred
on both rows, or on the top row below sm at the row's 24px, where the menus
take the full width and scroll sideways with edge fades. There is no Save button: autosave, Ctrl/Cmd+S,
File › Save and leaving Edit save. Rename, Move, Properties and Delete stay in
⋮. The Office views render `OfficeHeader` (`OfficeMenuBar.tsx`), which portals
the runtime's menus and actions into the header and draws the menus as a Radix
menu bar (`Menubar.tsx`, in DropdownMenu's look): Arrow Left and Right move
between the menus, assistive technology announces a menu bar, shortcuts are in
`aria-keyshortcuts`, and the triggers keep their width so a narrow row scrolls.
A closing menu stays mounted for its exit animation, so it ignores focus and
clicks outside while closed, and a click reopening a menu does not dismiss it.
After a picked item focus goes to the runtime frame (Escape returns it to the
trigger). The editor inside the frame takes focus on load only when its
document already has it, so a menu opened during load stays open. Without a
file header (no portal target) a row of its own carries the label and the
toggle. Notes, PDFs and other files keep the one-row header.

The menus come from the runtime as data (protocol v8, `officeMenus.ts`): a
`menus` message carries the whole bar (items with labels already in Capy's
locale, shortcuts, ticks, Capy icon names, submenus, Capy's table-size grid)
and the header actions, and is re-sent when either changes; in edit mode it
waits for the editor's replica, as the old Save button did. A click sends
`menu-command` {id, value?}; an item's parameter rides in its id after a colon
("zoom:125"), `value` carries only the grid's "<rows>x<cols>". Items marked
`pick: 'image'` open Capy's own file picker, because a click in the host gives
the frame no user activation, and the file goes over as `menu-file`. For the
same reason items marked `fullscreen` (and a header action marked so) go over
with the click's full-screen permission, and items marked `popup: 'presenter'`
have Capy open the PPTX presenter window first (`officeCommandNeeds`, see PPTX
Present below). A header action with `items` is a split button: its main part
runs the action, its arrow lists the items. Capy
performs its own commands without a round trip to the runtime's code:
`capy.save` takes the checkpoint, `capy.download` saves the bytes `export`
returns (in view mode the saved state the viewer opened), `capy.print` prints
the pages `render` {kind: 'print'} returns from a hidden frame on the app's own
document, and `capy.png` saves the image `render` {kind: 'png'} returns; the
runtime's sandbox stays without downloads, popups or modals. View mode offers
only what works, never disabled items: DOCX has File › Download and Print and
View › Zoom, XLSX File › Download, PNG and Print and View › Zoom (PPTX's are
under PPTX below). A print the
runtime cannot draw answers `render-failed`, not
`error`: the host shows a short toast instead of the "couldn't open" banner and
pending flushes are untouched. Edit-mode rendering flushes pending input first,
as export does. Pages are drawn, encoded and released one at a time (DOCX
`renderPages`/`rasterizeDisplayPage`, as PPTX), and a page whose canvas has no
2D context fails the print. The host drops a submenu longer than 80 entries
rather than the whole bar; DOCX Format › Paragraph styles lists the first 40
styles (the toolbar's style picker keeps all).

While editing is paused (handoff, replaced, recovery, connecting before the
first sync, discarding: the host's narrowed `canEdit` in `set-capabilities`;
the room's first save receipt is not waited for), the editor turns read-only
in every state alike: once the runtime has flushed what was being typed, it
passes `readOnly` to the editor and lets pointer and keys through (Tab and
Escape included), so the content can be selected and copied (Select all, ⌘A,
⌘C, the right-click menu's Copy) while nothing edits; text typed into a field
of the frame, such as Find's, still reaches it, as the editor refuses text
itself. Until then its gates hold keys, pointer and text input, a composition
begun after the pause never counts, and Ctrl/Cmd+S saves nothing. When the
pause ends nothing moves the focus: it stays in Capy's field, Find, the
document input (read-only never blurs it) or wherever it was. A newly opened
DOCX editor focuses the document only through its frame: when the replica is
ready (`collaboration-ready`) Capy focuses the frame unless its own focus is
in a field taking typing (the chat box, say, also one behind a shadow root such
as MathLive's) or anywhere in an open dialog, alert dialog or menu
(`keepsFocus`), and the editor takes the focus
once the frame has it. Closing or removing a header or footer from its Options
menu, or Escape out of it, gives the document input the focus back. Each menu
item says whether it edits (`edits`), declared where it is defined: DOCX's in
docx-react's `hostMenus.tsx`, XLSX's and PPTX's from xlsx-react's
`xlsxCommandEdits` and pptx-react's `PPTX_COMMAND_EDITS` (XLSX freezing panes
edits; Capy's own Save edits, Download, PNG and Print do not). The runtime
re-sends its menus with every editing item disabled and a submenu with nothing
left to run disabled too, the table grid counting as an edit (`pausedMenus`),
keeps the read-only items (Select all, Find and replace, View, Download,
Print) and the header actions usable, and drops any other `menu-command` or
`menu-file` (`runsWhilePaused`). The read-only editors refuse edits themselves
too: DOCX keeps its toolbar row, disabled, because its menus come from it,
opens Find and replace with Find working and Replace and Replace all disabled,
offers only Copy and Select all on right-click, ignores Ctrl/Cmd+K, Delete on
a selected table, a header or footer double-click, Tab out of a table's last
cell and every structural command, and its comment and tracked-change cards
show the thread without reply, resolve, accept or reject (a reply being typed
is hidden, not dropped, and comes back with its draft when editing resumes,
and so is a new comment being written; neither takes the focus back); XLSX's
`run` refuses editing commands and its Select all hands the grid the keys, so
Ctrl/Cmd+C copies the sheet (in the grid Tab moves between cells, as when
editing). All three keep their toolbar row visible and disabled, and XLSX its
formula bar visible and read-only (its text still selects and copies), so
nothing moves when a pause starts or ends. The toolbar's zoom control is the
exception and stays usable, as View › Zoom does: zoom edits nothing. Only an editor pauses: in view mode
a `canEdit` of false (a view-only user's) changes nothing, and the viewer
still selects and copies. The DOCX menu model refuses a disabled item's id
too.

Zoom is kept while a file stays open and carried across View and Edit in all
three formats, with nothing stored (as decided 2026-10-06). Every viewer and
editor reports its zoom as it opens and when it changes (protocol `zoom`
{zoom}: 1 = 100%, or PPTX's `'fit'`; the protocol takes 25–400%, the widest
any editor takes), from the toolbar's control or View ›
Zoom; the host keeps the last one in memory (`useOfficeRuntime`'s `zoomRef`)
and the next frame's `load` carries it (`zoom`), whether that frame is the
other mode or the same one after a runtime reload. The runtime hands it to the
viewer or editor as its starting level: `DocxViewer`, `XlsxViewer` and
`PptxViewer`, and the fork editors' `initialZoom`; the DOCX editor reports its
zoom in its menu model (`DocxMenuModel.zoom`), XLSX and PPTX in their command
state. Closing the file, opening another one or reloading the page starts at
the format's default (100%, PPTX fitted to the window); the scroll position is
not carried.

In edit mode the DOCX editor shows one toolbar row under the header, in Google
Docs' order (`singleRowToolbar` with the menus in the host, `DocxEditor`'s
`onMenus`): undo/redo, zoom, style, font, size box (no −/+ steps), bold,
italic, underline, text colour and highlight (each picker ticks the
selection's colour when the whole selection shares one and it is one of the
palette's colours; the highlight is read from the editor as the text colour
is, however the document stores it, so a highlight picked in Capy ticks while
a file's Word highlight such as yellow, which the palette lacks, does not),
then link, comment and image,
alignment with line spacing, lists and indent, and clear formatting, with the
comments toggle pinned right; image or table controls follow the lists when an
image or a cell is selected. Strikethrough, superscript and subscript live in
Format › Text. Below lg (the viewport, as the PDF toolbar) the zoom dropdown,
the font picker and the size box are hidden. The row scrolls sideways: a
vertical mouse wheel scrolls it, and an edge with more to scroll fades
(`data-scroll-start`/`-end`, so it needs no scroll-driven animations). The DOCX
menus (`hostMenus.tsx` in the fork, Capy's icons and File › Download and Print
added in `docxMenus.ts`) are File (Save, Download ▸ Word document, Page setup,
Print), Edit (Undo, Redo, Select all, Delete, Find and replace), View (Show
ruler ✓, Show document outline ✓, Show comments ✓, Zoom ▸), Insert (Image, Table ▸, Link,
Comment, Watermark, Break ▸, Table of contents, and Update table of contents
while the document has one) and Format (Text ▸, Paragraph styles ▸, Align &
indent ▸, Line spacing ▸, Bullets & numbering ▸, Text direction ▸, Table ▸
and Image options in context, Clear formatting). Placeholders that do nothing
stay hidden: Line spacing's empty Paragraph spacing heading. Cut, Copy and
Paste are left out of the menus (a host click cannot reach the frame's
clipboard). Find and replace works in edit mode only (Ctrl/Cmd+F and H too).

Format › Table ▸ (Google Docs' place) has Vertical alignment ▸
Top/Middle/Bottom and Table alignment ▸ Left/Center/Right (radio items ticked
for the caret's cell and table), then Pin header row ✓, Wrap text ✓,
Distribute columns, Auto-fit to contents and Table properties. The toolbar's
table ⋮ menu follows Google Docs' table menu: insert, delete, merge and split,
Distribute columns, Auto-fit to contents, Pin header row, Wrap text, Select
table and Table properties (the alignments stay in Format › Table, as Google
keeps them in Table properties). Each item is one engine op
(`crates/docx-edit/src/ops/table.rs`), one transaction and one Undo step, and
edits (paused or read-only editors refuse it). Defaults come from Word and
Google Docs
(`capy-docx-review-harnesses/2026-10-05-office-batch/docx-table-menu/GAP.md`):
vertical alignment and Wrap text apply to the selected cells (`w:vAlign`,
`w:noWrap`); table alignment writes only `w:jc` (`w:tblInd` applies again on
Left); Pin header row makes every row down to the selection's last a
`w:tblHeader` row, repeated on each page the table spans, and unticking
unpins them all; Distribute columns evens the selected columns (every column
when one is selected), keeping their total, and writes `w:gridCol` and dxa
`w:tcW`; Auto-fit to contents is Word's AutoFit Contents: the table and every
cell get `w:w="0" w:type="auto"` widths and lose a fixed layout. A table of
that shape (no table width, every `w:tcW` explicitly auto, no fixed layout,
cells holding only paragraphs) is sized from content as Word does: each
column takes its widest unwrapped line plus the cell margins, so it shrinks to
content (an empty column to its margins) and grows as text is typed; a table
with a nested table or another block in a cell keeps its grid. The saved
`w:gridCol` keeps the old widths (Word recomputes them); a column drag starts
from the drawn widths (`columnWidths` on the layout's table fragment) and
writes every column, so none snaps back. A no-wrap cell without a dxa width
keeps its text on one line by widening its column into the other columns'
empty room and the page's (ECMA-376 §17.4.30); with a dxa width, in a fixed
table (`w:tblLayout`, which the bridge passes to the layout) or holding other
blocks it changes nothing. A new table gets Word's Normal Table cell margins
(108 twips left and right, saved as `w:tblCellMar`) and the document's
compatibility mode (`compatibilityModeFromDocument`, stamped as the seed
stamps every table), so it draws where it will after a reopen: in a Word
2013+ document (mode 15) its border sits at the margin, in older modes it
hangs into the margin by its cell margin, as Word draws them. A floating
picture in a cell keeps an auto-fitted table on its grid, as a nested table
does. Table ops write `tblPr` only when it changed and `grid` with `rows`
together, so table alignment survives a peer's row insert, while a row change
(alignment in cells, header rows, widths, wrap, shading, borders) racing a
peer's row or column insert or delete keeps one of the two (Auto-fit's
table-width part can survive on its own); tables stay consistent and both
peers converge.

Insert › Table of contents writes Word's field (`TOC \o "1-3" \h \z \u`,
`ops/toc.rs` in docx-edit) at the caret in the body: one paragraph per body
heading of outline level 1–3 (its own level, else its style's, as the saved
file has them; an empty heading is skipped), each a link to a `_Toc` bookmark
the command puts around the heading's text (one the heading already has is
reused), then a dot-leader right tab at the text width less 10 twips and a
`PAGEREF \h` field with the page the heading starts on, as that page shows its
number. Entries take the document's `toc 1`–`toc 3` styles; a document without
them gets `TOC1`–`TOC3` with Word's built-in spacing (after 5pt) and indents
(0, 11pt, 22pt) written directly, since the save cannot add a style. The field
begins with the first entry and ends after the last; text before the caret is
split off into its own paragraph above, and the caret's paragraph follows the
table. With no heading the result is Word's "No table of contents entries
found." The entries are written as markup, read by docx-parse and seeded with
the document's styles (`seed::fragment_ops`), so the editor holds exactly what
the saved file seeds to. Page
numbers come from the editor's layout: after inserting, the editor lays the
document out again and, when a heading moved page, rebuilds the table once
more, all in one Undo step (manual undo capture), so the numbers count the
table's own pages. Insert with the caret inside a table of contents updates
that table instead (Word asks to replace it; Yes is its default). Update table
of contents rebuilds the table holding the caret, else the body's first, from
the current headings and layout, keeping its field code (`\o` levels, quoted or
not, `\h` links, `\n` without page numbers): Word's "Update entire table", so text typed
inside the table is replaced. It writes the new entries in front of the old
table, then removes the old one; a paragraph the old field's end opens (Word's
shape, often the one breaking a roman-numbered section) stays, with its
section. Only a table built from headings is updated or counted for the menu:
a field code with switches beyond `\o \h \z \u \n \w \x \p` (a Table of
Figures' `\c`, or `\t`, `\f`, `\l`, `\b`) is left as it is, Update does
nothing with the caret in one, and Insert there puts the new table in front of
it. Two peers updating at once each leave a whole table, so the document then
holds two (the concurrent-join class); a further Update rebuilds the one at the
caret, or the first, and leaves the other for the user to delete (Undo of one
peer's Update brings the old table back beside the other peer's). Text a peer
types in the old entries during an Update ends up after the new table (the
concurrent-join class). A peer's heading change made during an update shows at
the next update. A paragraph inside a table of contents is never listed as a
heading, as in Word (Update reads the headings before it removes the old
table). Neither
command runs in suggesting mode, and heading list numbers are not copied into
the entries. Not yet seen: a table inside a block content control (Word's
References › Table of Contents gallery wraps the field in one), so Update is
not offered for it and Insert adds a second table; and headings inside table
cells and content controls are not listed (a follow-up in `todo-office.md`).

View › Show ruler (`show-ruler`, a checkbox item that does not edit, so it
stays usable while paused) shows docx-react's rulers as Google Docs does: the
horizontal one sticky under the toolbar row, drawing the document's last
section (page width and margins, `finalSectionProperties`) centred like the
pages and never shrunk, so it lines up with pages of that size at every width;
and the vertical one at the editor's left edge from the first page's top,
drawing the first section (`initialSectionProperties`; it covers the first
page only and scrolls with it; where the editor leaves less than its 20px
beside the page, about 1280px wide with the side panel open, it overlaps the
page's left edge). A document whose sections differ in page size or margins
(portrait pages and a final landscape section) shows the last section's
horizontal ruler over every page; following the section at the cursor is a
fork follow-up in `todo-office.md`. A read-only editor keeps them, not draggable, as it keeps
the toolbar. Margin drags and the indent markers work as before; the margin
zones take `--doc-ruler-margin` (Capy's divider tint) with the ticks drawn
over them. Rulers start hidden; the choice is one per person for every DOCX
file, kept in the runtime origin's `localStorage` under `capy.docx.ruler`
(`viewToggles.ts`, as the PPTX speaker notes; `DocxEditor`'s `showRuler` with
`onShowRulerChange`). View mode draws no ruler and offers no toggle, as its
View menu holds only what the viewer does (Zoom); the next edit opens with the
remembered choice.

The XLSX editor's toolbar row follows Google Sheets (xlsx-react's
`singleRowToolbar`, no menu button): undo, redo and paint format, zoom (a
boxless combobox), number formats, the font picker, the size box (no −/+
steps), bold, italic, strikethrough and text colour, fill, borders and merge,
then alignment and wrapping, scrolling sideways like the DOCX row; below lg the
font picker, size box and zoom are hidden. Capy hides the fork's Search menus
button (it does nothing), its agent proposals button (Capy stages no proposals)
and the custom number format item (it only reapplies the current pattern)
through `showSearchMenus`, `showProposals` and `showCustomNumberFormat`. Its
dropdowns and pickers are drawn as the note toolbar's popovers: xlsx-react
reads the shared `--office-menu-*` variables (the panel, rows, popover buttons,
section labels and swatches; see the shared menu style below), the alignment
popovers stack one icon button per alignment, and the text, fill and border
colours open the same palette as the note editor's (Default clears the colour,
Custom color takes any). The formula bar is its own 40px row under the
toolbar and the sheet tabs sit under the grid. The viewer draws the same formula
bar, read-only, in the same place: a click selects a cell (widened to its merged
range, outlined in the editor's Excel green) and shows its address and full
text, so the two modes differ only by the toolbar row. xlsx-react reads its
other chrome colours, font and control sizes from `--xlsx-*` variables too; the
grid stays white in dark themes, as pages do. Its icons come through
`XlsxEditor`'s `icons` prop: `src/office-runtime/xlsxIcons.tsx` maps every
toolbar icon and the border and alignment glyphs the fork otherwise draws
(`TOOLBAR_ICON_NAMES`, `DRAWN_ICON_NAMES`) to Capy's Hugeicons.

XLSX keyboard moves (arrows, Home/End, Page Up/Down, Enter and Tab commits
from the cell, Enter from the formula bar) and opening the in-cell editor
(typing, F2, double click) scroll the active cell fully into view, moving as
little as possible and clear of frozen panes; Ctrl/Cmd+A keeps the view, as
the menu's Select all does. A cell the keyboard reaches past the used range
grows the scroll area to it. An open cell edit keeps its input mounted and
focused while its cell scrolls away, so the next key that types, composition
included, is typed into the edit and scrolls the cell back whole, as in Excel
and Sheets; modifier keys and Ctrl/Cmd shortcuts leave the view alone. An edit
ends on blur without taking focus back, so a click on the formula bar commits
it and leaves the formula bar focused; a press on nothing focusable commits it
and gives the grid the keys, and a window or tab switch keeps it open for the
next key on return. Focus moving from the runtime to another part of Capy
(chat, sidebar, header) commits it too: Capy's window gets a `focus` event when
focus comes back to its document from the frame, and `useOfficeRuntime` then
sends the runtime `focus-left` once the frame has loaded, which flushes pending
input (an app or tab switch, and the return from one, leave focus in the frame
and send nothing). A failure of that flush stays the editor's own message: no
file error and no failed Save, since nobody asked to save. A formula-bar draft
stays open over an app or tab switch too. A draft whose sheet a peer removes,
or whose sheet stops being the active one in a peer's update, is dropped, not
committed; otherwise a draft commits to its own sheet even when a peer's update
shifted that sheet's index. Once a draft is dropped neither the grid nor the
formula bar keeps the focus, so the keys still being typed do nothing until a
click. Clicking a sheet
tab gives the grid the keys. A cell wider
or taller than the view stays put while it spans it. The editor only asks the engine where
the cell is (`cellPosition`, from the geometry `sheet_info` memoized) when the
painted frame, if it is the live view, does not show it whole, and a key that
scrolls paints once. Firefox caps an element's height near 17.9M px, so its
scroll area stops short of the last ~150k rows; keys there still land in the
edit.

The XLSX menus come from `src/office-runtime/xlsxMenus.ts`, labelled from
xlsx-i18n (zh-CN for zh): File (Save, Download ▸ Microsoft Excel and PNG image,
Print), Edit (Undo, Redo, Select all, Delete ▸ values, rows, columns), View
(Freeze ▸ rows and columns, Zoom ▸), Insert (rows above and below, columns left
and right, Sheet) and Format (Number, Text, Alignment, Wrapping, Merge cells,
Clear formatting), with counts in the labels ("3 rows above") and items enabled
and ticked from the editor's `onCommandStateChange` state. A runtime item's id
is an `XLSX_COMMANDS` id that `XlsxEditorApi.run` performs, the engine-only ones
included (insert and delete rows and columns, delete values, freeze, add sheet,
clear formatting). For PNG and Print `src/office-runtime/xlsxRender.ts` paints
the sheet's display list: the part on screen for PNG, and for Print the active
sheet on A4 portrait pages fit to width as Google Sheets prints (the columns up
to the rightmost text scale to the page width; rows run down the pages, each
ending at a row edge, frozen rows repeat as titles, trailing pages without text
are left out). Print stops at 50 pages: the width scan covers the rows those
pages print, and when text goes on past them `rendered` says `truncated` and
the host shows "Printed the first 50 pages". View mode offers File with
Download, PNG and Print, and View › Zoom.

XLSX zoom follows Google Sheets: 50, 75, 90, 100, 125, 150 and 200% from the
toolbar's zoom box and View › Zoom in edit mode, and from View › Zoom in view
mode, which has no toolbar. The box also takes a typed zoom as Sheets does: a
whole percent from 50 to 200 (120.6 is 121%), anything above as 200% and
below as 50% (300 is 200%, 20 is 50%); text that is no number changes
nothing. The grid, its
frozen panes, the selection and the in-cell editor scale; the chrome does not.
Both modes build the display list for the sheet area the scroll box shows at the
zoom (`zoomedViewport` in `@betteroffice/xlsx`), paint it at
`devicePixelRatio × zoom` and divide pointer positions by the zoom, and a change
keeps the sheet point at the grid's top-left corner where it was, as Sheets
does (`XlsxEditor`'s `changeZoom`, `XlsxViewer`). The level lasts while the
file stays open, across View and Edit, as in DOCX and PPTX (see Zoom below).
Both modes open a sheet at its saved scroll
(its frozen pane's top-left cell) once the scroll area has that sheet's size.
Ctrl/Cmd with the wheel and a trackpad pinch
are left to the browser, as in Sheets. Zoom edits nothing, so View › Zoom runs
while editing is paused; PNG saves the part on screen drawn at the same scale at
every zoom.

Below lg, while a DOCX, XLSX or PPTX file is open, the workspace's floating
Files/Chat/Create/Settings bar folds into one button at the bottom right, above
the sheet tabs and the slide pager, that morphs into a menu of the same items
(`Menu`'s morph variant, as the Files panel's plus); other files keep the bar
(`WorkspaceOpen`).

The runtime is its own document, so `office-runtime.css` brings Capy's look
itself. It imports Tailwind's preflight (in a lower layer) and Capy's theme
token files, and maps the tokens onto docx-react's `--doc-*` variables, its
toolbar variables and its shadcn variables. The shadcn ones are HSL triplets
and take relative colour syntax (`from var(--token) h s l`); on Chrome and Edge
111–118, which lack it, an `@supports` fallback gives every docx-react rule
that reads them (menus, dropdowns, buttons, tooltips, focus rings) Capy's
tokens directly, repeating the compiled selectors so the `dark:` ones keep
their weight. The host sends `set-appearance` (`style`, `theme`,
`narrow` below lg, `locale`) before `load`, on every change and again after
every runtime boot; the runtime sets `data-style`/`data-theme` and `lang` on
its root, sets its own locale, passes `colorMode` and the editor's zh-CN
strings for `zh` to `DocxEditor`, and hides the narrow controls. The host
sends `set-capabilities` after every boot and whenever editing pauses or
resumes, but a boot's `load` (which carries the raw `canEdit`) waits for the
source, so a runtime that boots before the source loads gets
`set-capabilities` first: the runtime keeps the last `canEdit` it was sent and
applies it on `load`. A runtime that reloads during a handoff, a replacement,
recovery, a discard or while connecting therefore opens paused (read-only and
selectable) whichever message comes first. Pages stay white in
dark themes, as PDF pages do. The chrome uses Capy's Fustat (latin 400, 500
and 600 from `@fontsource/fustat` 5.3.0, self-hosted in
`src/office-runtime/fonts/` because the runtime's CSP allows no font host; the
files carry their copyright and licence link, and the OFL text stays in the
repo beside them). Fustat has no CJK glyphs, so Chinese labels fall back to
the system's face, which the browser picks by the page's `lang`: the runtime
sets it from `set-appearance` and Capy's own page from its locale at startup
(`src/main.tsx`), so a Chinese UI gets one Chinese face (PingFang SC on macOS,
Microsoft YaHei on Windows) at the chrome's weights instead of a mix of a
Japanese face and Hiragino Sans GB's W3/W6 under `lang="en"`.

Every Office menu, dropdown and picker looks like the note toolbar's popovers
(`ToolbarPopover.tsx`). The header menus (`OfficeMenuBar.tsx`) restyle Capy's
dropdown menu with the same classes: a rounded-lg panel with px-1 py-1.5,
28px rows with px-2 and gap-2, hover in surface-hover-bg/80, the ✓ for a
checked item at the end of the row, shortcuts in muted text-xs, inset
separators. Inside the frame, `office-runtime.css` defines the shared
`--office-menu-*` variables (panel, rows, toolbar buttons, section labels,
swatches) for the DOCX, XLSX and PPTX runtimes, and `office-runtime.html` sets
`data-office-menus="host"` on its root. docx-react then draws its style, font,
size, zoom, line spacing, colour, alignment, table and image dropdowns and its
right-click menus from those variables (the rules in the fork's shared
`editor.css`, keyed on `docx-popover*` classes, with `!important` because the
pickers style themselves inline); without the attribute it keeps its own
look. The style list shows plain names at row height instead of previews,
Word's built-in styles under Word's names (`heading 4` shows as Heading 4; the
document keeps its names), the size list is the note toolbar's narrow centred
list, alignment stacks its buttons, and a dropdown near the window edge moves
back inside it. Capy's sentence case replaces the editor's title case in these
popovers (`docxMenus.ts` passes it over the built-in English, and under zh-CN
for any string it lacks): Text color, Highlight color, Custom color, No
color, Paste as plain text, Select all; Word's Automatic colour and table
style names keep theirs. The text, highlight and table colour
pickers take Capy's 40 document colours (`DocxEditor`'s `colorPalette`, from
`DOCUMENT_COLORS`) in place of Word's theme and standard colours, with the
clear button beside the label and a custom colour from the browser's picker
(the row shows only Custom color and its swatch, no hex code), as the note
toolbar and PPTX pick colours; a picked colour is a plain RGB
value, not a theme colour.

The editor draws Capy's icons through one hook: `DocxEditor`'s `icons` prop
takes an `IconSet` that names every Material icon the editor uses and the icons
it otherwise draws inline (`DRAWN_ICON_NAMES`: the right-click menu, the link
popup, the table insert overlay, the find and link dialogs, the error toasts
and the empty-document and error placeholders; without a set the fork's own
drawings stay). `src/office-runtime/docxIcons.tsx` maps every name to Capy's
Hugeicons through `HugeIcon`, and its `Record<keyof IconSet, …>` type fails
the build if a name is missing; icons draw at 16px at most, except the
placeholders, which keep the size the editor asks for. The fork's print
button and keyboard shortcut dialog keep their own SVGs: the editor never
mounts them (Capy prints itself).

PPTX view and edit share one layout: the slide strip at the left (thumbnails
at their slide's aspect ratio), the slide fitted with 20px around it, and the
speaker notes below when shown (read-only in view). The viewer (`PptxViewer.tsx`) copies
the editor's strip and notes geometry in `pptx-runtime.css`, which also maps
Capy's tokens onto pptx-react's `--pptx-*` variables (their fallbacks are the
fork's own colours); slides keep their own colours. The viewer's strip ends in
a pager (previous, "Slide x of y", next). View mode has no count row, so the
strip and the notes start right under the file header; edit mode adds the
editor's flat 40px toolbar row (`singleRowToolbar`) above the same layout. In
a frame under 640px (phones) the strip is a row of 96px thumbnails under the
slide in both modes, the viewer's pager under it.

The PPTX toolbar row follows Google Slides and Capy's DOCX row: new slide
with a layout dropdown, undo and redo, a zoom dropdown, then select, text box,
image and shape. A selected text box or text adds font, size box (no steps),
bold, italic, underline, text colour and highlight colour; an alignment
dropdown (left, centre, right, justify, then the box's top, middle and bottom)
and a line and paragraph spacing dropdown (single, 1.15, 1.5, double, add or
remove 10 pt before or after the paragraph); bulleted and numbered list
buttons, each with a style menu, then decrease and increase indent; and clear
formatting. A selected shape then adds fill, border colour, border weight and
its adjustment. Strikethrough, superscript, subscript and the font size steps
are in Format › Text, as in DOCX. Below lg zoom, font and size are hidden. The
row scrolls sideways under a vertical wheel, with edge fades.
`src/office-runtime/pptxIcons.tsx` maps every toolbar icon name and the
show's and presenter window's controls (exit, previous, next, Full screen, ⋮,
pause, resume, reset, notes size) to Capy's Hugeicons
(`PptxEditor`'s `icons`; the viewer provides the same set to
`PresentationOverlay` through pptx-react's `IconSetContext`), the presenter's
arrows matching the viewer pager's. Capy hides the editor's agent
proposals (`showProposals`) and its Present button (`showPresentButton`);
save, PNG export, arrange and the slide operations without other UI (delete
slide, move slide, delete object) are host menu commands that
`PptxEditorApi.runCommand` runs by id (`PPTX_COMMAND_IDS`), with
`onCommandState` reporting what each can do and `PPTX_COMMAND_EDITS` saying
which edit. Delete or Backspace deletes a selected object unless its text is
being edited.

PPTX lists, levels and paragraph spacing are written as PowerPoint writes them
(`crates/pptx-edit/src/story.rs`): a bulleted item gets `a:buChar` with
`a:buFont` Arial, a numbered one `a:buAutoNum` with `a:buFontTx`. A plain
paragraph becoming a list item takes the `marL`/`indent` the selection's first
list item at its level lays out with: an edit's value, else the file's, else
what it inherits, resolved by the rules the renderer uses
(`crates/pptx-parse/src/cascade.rs`). Nothing is written where the paragraph
already inherits the same value. Otherwise the value is written explicitly:
over PowerPoint's `marL="0" indent="0"` on a plain paragraph, since saving
cannot drop a file attribute, or where the layout's paragraphs, looked up by
position, give the two different values. A written value is clamped to the
schema's range and no longer follows a later layout or master change. With no
item at its level the default is a hanging indent of 0.375 in plus 0.5 in per
level. An item already in a list (its own marker, or one it inherits, which
the editor passes by paragraph id) only changes its marker and `a:buFont`,
keeping its indents, so a new style or a switch between numbers and bullets
never moves its text. Removing a list writes `a:buNone` and no hanging indent.
A list style (`BULLET_PRESETS`, `NUMBER_PRESETS` in
`pptx-react/src/paragraphFormatting.ts`: five bullet and four number styles,
three markers each, repeating by level) gives each level its marker, and
indenting moves `lvl` one step, shifting an explicit `marL` (the paragraph's
own or its file paragraph's) by 0.5 in and switching a style's marker to the
new level's. Line spacing and space before/after are
`a:lnSpc`/`a:spcBef`/`a:spcAft`, a text box's vertical alignment
`a:bodyPr@anchor`, strikethrough `a:rPr@strike` (`dblStrike` drawn as two
lines) and highlight `a:highlight` (painted at the text's height, so wide line
spacing leaves gaps); clear formatting removes every run attribute an edit
sets. The paragraph and shape keys are written only by edits, but strike and
highlight runs are seeded from the file, so a deck with highlight or any
strike attribute reseeds (LibreOffice writes `noStrike` on every run); strike
and underline values outside the schema's lists are not modelled. Every client
refuses a peer's update carrying an out-of-range paragraph value or an invalid
strike, underline, colour or highlight value (the collaboration service checks
which containers an update touches, not their values). An empty list item
shows its marker only while the caret is in it (`layoutSlide(index, caret)`),
as PowerPoint and Google Slides draw it while typing.

Keys follow Google Slides: Enter in an empty list item leaves the list (a
nested one steps out a level first), Backspace at the start of a list item
removes its marker before it joins anything, Tab at a list item's start or over
several paragraphs indents (Shift+Tab outdents) and types a tab elsewhere
(except in a table cell, where Tab still leaves the editor until cells get
their own navigation), and Esc while typing selects the text box, so Tab
leaves the editor again. Letter shortcuts match the typed key on a Latin
layout (so AZERTY's A selects all) and the physical key otherwise (so a Russian
Ctrl+A does too).
Shortcuts: ⌘⇧8/⌘⇧7 lists, ⌘]/⌘[ indent, ⌘⇧X or Alt+Shift+5 strikethrough, ⌘./⌘,
superscript and subscript, ⌘⇧./⌘⇧, font size, ⌘\ clear formatting, ⌘A Select
all. Select all takes the text box's whole text while typing, else every object
on the slide: outlined together, dragged, deleted (one undo step) and copied
(their text, one shape per line) together, and aligned, distributed and
centred by Arrange.

Both modes hide the speaker notes until View › Show speaker notes (the
`view.speakerNotes` id, a checkbox item) or the Notes button at the bottom
right of the slide area shows them; the two flip one state. In edit mode that
is pptx-react's (`pptx-notes-toggle`, icon only in the narrow layout); the
viewer draws the same button in `pptx-runtime.css`. The choice is one per
person for every PPTX file and both modes, kept in the runtime origin's
`localStorage` under `capy.pptx.speakerNotes` (`viewToggles.ts`; the
editor takes it as `defaultSpeakerNotes` and reports changes through
`onSpeakerNotesChange`); when storage is blocked the notes start hidden. In
production the runtime is a separate origin inside Capy's page, so browsers
keep that storage partitioned under Capy's site, and Safari may clear it after
some days without a visit, after which the notes start hidden again.

Below lg the workspace's floating tools button covers the frame's bottom
right. The runtime marks its root `data-narrow` then, and
`--pptx-notes-toggle-right` moves the Notes button left of that column. While
the notes are open the host lifts the button above the notes box: `PptxView`
sets `data-office-notes-open` when the runtime's menus tick
`view.speakerNotes`, and `WorkspaceOpen` moves the button up for it.

PPTX's header menus follow Google Slides: File (Save, which Capy performs as
`capy.save`, Download ▸ PowerPoint or PNG of the current slide, Print), Edit
(Undo, Redo, Select all, Delete), View (Present ▸, Zoom, Show speaker notes),
Insert, Format (Text ▸ bold to subscript and Size ▸; Align & indent ▸ with the
vertical alignment and indent; Line & paragraph spacing ▸; Bullets & numbering
▸ Numbered list ▸ and Bulleted list ▸ styles, ticked for the selection's;
Borders & lines ▸; Clear formatting), Slide (new, delete, move) and Arrange
(Order ▸, Align ▸ left to bottom, Distribute ▸ and Center on page ▸, one
object to the slide and several to the box around them, distributing three or
more) (`pptxEditorMenus.ts`, labels from `pptx-i18n` for the locale and Capy
messages for the rest). A menu id carries
its command's value after a colon (`view.zoom:1.5`, `insert.shape:ellipse`,
`slide.newWithLayout:<layout part>`). Insert › Image is a `pick` item: Capy's
picker hands the file to `PptxEditorApi.insertImage`. View mode offers File ›
Download and Print and View › Present ▸, Zoom ▸ (the same Fit and levels as
edit mode, `zoomMenu`) and Show speaker notes (`pptxMenus.ts`); a level above
the fit scrolls the slide from its edges in an inner scroller
(`.pptx-viewer-scroll`, as the editor's canvas host), so the Notes button
keeps its corner; a new citation highlight is centred in that scroller once
it is painted, unless it is already in view. Present is a header
split button in both modes; the viewer presents through pptx-react's
`PresentationOverlay`, exported alone (with the notes window store and
`PRESENT_ITEMS`) as `@betteroffice/pptx-react/presentation` so the viewer loads
no editor code. Print and PNG pages are the slides painted
at twice their size from the open deck (`pptxRender.ts`).

Present in the header is a split button in both modes, as Google Slides'
Slideshow ▾ (`presentAction`, `presentItems` in `pptxMenus.ts`; below 640px
its main part shows only the icon, the arrow stays). The main part presents
from the current slide in full screen in the Capy tab, with no second window;
the arrow lists From this slide, From the start and Presenter view, which
View › Present repeats. None of them edits (`PRESENT_ITEMS` in pptx-react,
`edits: false`), so they run while editing is paused. A show draws the slides
over the page with previous, the slide counter, next, ⋮ and an exit button;
clicking the slide goes next.

Full screen: the click lands in Capy's header, and a frame on another origin
gets no user activation from it, so its own `requestFullscreen()` is refused.
Capy sends those `menu-command`s with `postMessage(…, { delegate: 'fullscreen' })`
(Chromium's Capability Delegation, Chrome and Edge 104+), which lets the frame
go full screen from that click. Firefox and Safari have no delegation: there
the show starts windowed, Capy lets the frame cover the page while the runtime
reports `presenting` (`PptxView`), and the show offers a Full screen button (a
click in the frame works in every browser). Esc, or leaving full screen any
other way, ends the show, and the file returns at the slide it ended on.

Presenter view follows Google Slides: the tab shows the slides (the audience
view) and a pop-up shows the speaker notes and controls, which the presenter
keeps on the laptop while the tab goes to the projector. One click buys either
full screen or a pop-up (each consumes the click's activation), and Chrome
drops a tab's full screen when it opens a window on the same screen, so
Presenter view spends the click on the pop-up: the tab shows the slides
windowed over the page, and Full screen there is the second click, after the
tab is on the projector (on one screen, full screen hides the notes window, as
Google Slides warns). Capy sends the command with a fresh token, then opens
`office-runtime.html#presenter=<token>` on the runtime origin in a new 860×640
pop-up every time (`openPresenterWindow`; a named window would be reused with
only its hash changed and never hand itself over); that page only finds the
runtime frame among its opener's frames, hands itself over and drops its
`opener` (`handOverPresenterWindow` in `presenterWindow.ts`, which every
runtime loads without pptx-react), and the PPTX viewer or editor, which owns
the window's store (`notesWindow.ts`), renders pptx-react's presenter window
into it through a React portal, painting the slides with the same
`paintSlide`, so the deck is loaded once. A
window nobody expects (reloaded, or the show ended first) closes itself; the
runtime closes it with a message, since it did not open it, also when the
frame goes away (its `pagehide`: Back, another file, a runtime reload, a new
revision), and the window closes itself if its frame is gone without one. The frame's sandbox stays `allow-same-origin allow-scripts`, without
`allow-popups`: Capy opens every window.

The presenter window is always dark (Capy's mocha colours), in Capy's font
(the runtime gives it its `data-style` and language), and lays out notes
first, as Google Slides' presenter window: a top bar with the elapsed time
(from the start of the show, ticking in the notes window, which stays
visible while the slides' window may be throttled, with pause and reset and
no keys), whether the
slides are in full screen, the notes text size (16, 20, 24, 32 or 40 px, 24 at
first, remembered under `capy.pptx.presenterNotesSize` in `viewToggles.ts`)
and End (in edit mode the next show starts at the size last picked); the
current and next slide small below it ("End of slides" after the
last), with previous, "Slide n of m" and next under the current one (clicking
it goes next); and the notes across the full width ("No speaker notes" when
the slide has none). Icons beside its text sit 1px up to meet Fustat's cap band.

Both windows drive one slide and take the same keys: → ↓ Space PageDown next,
← ↑ PageUp previous, Home and End the first and last slide, Esc ends the show (a
focused size dropdown keeps its own arrows). End in either window ends the
show: the notes window closes and the file returns at the current slide.
Closing the notes window keeps the show running; ⋮ › Open speaker notes in the
tab opens it again (in a plain Present show too, as Google Slides' slideshow
menu does). That click is in the frame, and its activation reaches Capy, so
the runtime asks Capy (`open-presenter`) and Capy opens the window as above;
from full screen the show leaves full screen first (Chrome would drop it) and
keeps running windowed. When the browser blocks the pop-up Capy sends the
command again with an empty token: the show keeps running and shows a notice
with Open speaker notes, which tries again from that click.

Not built yet: placing the windows on screens (Window Management API), a
one-screen notes mode, audience tools, pen, laser pointer, black screen and
typing a slide number. iPhone pages cannot go full screen (the show stays
windowed), and on iPad and phones the notes window opens as a tab.

PPTX's dropdowns inside the runtime take the note toolbar's popover look
through the shared `--office-menu-*` variables in `office-runtime.css`, which
pptx-react reads directly (its fallbacks are its own look). Colour buttons
open Capy's 40-colour palette under Document colors, with the clear item and
a Custom color row; the shape picker is a labelled grid of popover buttons
and alignment a column of them.
Strip thumbnails paint off screen and show only their latest paint.

The collaboration service refuses a client update that writes outside the
engine's document roots (the bundle's `OFFICE_DOCUMENT_ROOTS`, the contributor
map included) or, in PPTX, writes or deletes anything in `pptx:meta` other
than `commentFlavor`. The refusal is the unrecoverable
`source-checkpoint-failed` message, like an oversized update. An update the
room cannot integrate yet is dropped instead, and that connection gets the
room's sync step 1: its step 2 reply carries everything the room lacks, the
dropped update included, with no disconnect (`collaboration/src/officeRoots.ts`).
That covers an update that refers to content the room does not hold (the room
reloaded without a client's last unsaved typing, and the client typed before
its sync step 2), and one that starts past the clocks the room holds of its
client, skips a range, or deletes a range neither side holds (a reconnecting
client typing anywhere before its sync step 2). Yjs would keep such an update
pending, and a pending Office room cannot be saved. Text rooms resync such
updates the same way (they have no root rule), and so do note rooms
(see [Plate editor](plate-editor.md#document-limits-and-rejection)). A sync step 2 the room cannot
place means the client itself holds content out of order; after two in a row
the connection closes (it reconnects with backoff, its edits unsent; logged
once as `source_step2_unplaced`, `note_step2_unplaced` in a note room, with
room, user_id and socket_id) instead of resyncing forever. A save that still finds pending content is reported once
per room load: an Office room fails it as transient (the clients hear a
recoverable `source-checkpoint-failed` for its ids, the room counts as unsaved
for handoff, pause and eviction, and the next change saves it), and a text
room saves its whole state with it, as before. Pending content is never
refused by itself, but it counts toward the slow-save cap like any failed
save: no successful save for `SLOW_SAVE_LIMIT_MS` (5 minutes) sends the room
to recovery whatever the cause (see
[error handling](error-handling.md#collaborative-source-failures)).

DOCX and PPTX measure and paint with the fork's bundled metric-compatible
fonts (`@betteroffice/fonts`: Carlito for Calibri, Caladea for Cambria,
Liberation for Arial, Times New Roman and Courier New). `DocxEditorHost`
configures them at module scope and the DOCX viewer worker configures them
before layout. Each face the engine loads is also registered as a `FontFace`
under the Office family it stands in for, in the runtime iframe, so the page
paints what was measured (the viewer worker reports its faces with the display
list). The runtime's own interface names only Fustat and generic families
(`office-runtime.css`), so a document's family never repaints it. PPTX loads
the Liberation Sans faces as `Arial`. The CJK add-on (`@betteroffice/fonts-cjk`:
Noto Sans TC, SC, JP, KR and Noto Serif SC, 4.5 to 11.6 MB each) ships as
same-origin, content-hashed assets that load only when a document's text or
fonts need that script, so the engine measures CJK text with the face the page
paints; without them CJK text overlapped in view and vanished in edit. Han text
without kana or Hangul uses the Simplified bucket, so a Traditional Chinese
file can load both Chinese faces. The editor's
Google Fonts lookup is off (`setGoogleFontsEnabled(false)`), so a document
font with no bundled face paints with its CSS fallback stack. A face that fails to load
shows an explicit error instead of the fallback layout
(`src/office-runtime/officeFonts.ts`, `pptxFonts.ts`).

A PPTX deck's own fonts (`p:embeddedFontLst`, parts in `ppt/fonts/`, as
Google Slides and PowerPoint save them) are measured and painted too. Google
Slides writes each face as Embedded OpenType with MicroType Express
compression; the fork's `ooxml_text::decode_embedded_font` turns that, a plain
sfnt, an XOR-encrypted EOT or a GUID-obfuscated `.odttf` into TrueType (the
`hdmx` and `VDMX` device tables are dropped). The deck's renderer decodes the
faces once, at its first layout (every slide shares them; the export worker,
which lays nothing out, never decodes them), and registers each under its
typeface and style, ahead of a bundled face of
the same name (a deck embedding Arial measures with it, not Liberation Sans);
a family with some styles embedded draws the others in its nearest embedded
face, as the browser does. The viewer and editor hand the decoded bytes to the
page as `FontFace`s before the first paint (`installEmbeddedFonts`) and delete
them when the deck closes, so the canvas, print and PNG paint the measured
glyphs; the native rasterizer uses the same faces. A part that is missing,
cannot be decoded, is over 32 MiB decoded, or would take the deck past 64 MiB
of embedded faces is skipped, and one the browser refuses is left out with a
console warning; that text keeps the bundled face or the CSS fallback as
before, with no error. Saving and export copy `ppt/fonts/` and the list
untouched (`src/office-runtime/PptxViewer.tsx`,
`vendor/betteroffice/crates/ooxml-text/src/embedded_font/`,
`vendor/betteroffice/crates/pptx-render/src/layout.rs`).

The iframe sandbox allows scripts and its own origin, but the runtime origin is
cross-origin from the app, cookie-less, and restricted to the app by CSP
`frame-ancestors`. Host and runtime validate exact origins and the message
source; production refuses to create an Office runtime on the app origin. This
contains a compromised document engine without relying on the sandbox's
same-origin escape-prone combination on the application origin. The engines
are single-threaded; an iframe alone does not enable `SharedArrayBuffer`. If
threaded WASM is introduced later, configure isolation headers on this runtime
origin without isolating the SPA. The iframes also get
`allow="clipboard-read; clipboard-write; fullscreen"` (`officeRuntimeConfig.ts`,
next to `sandbox`) so the editors' right-click Cut, Copy and Paste reach the
clipboard (Paste shows the browser's permission prompt once) and PPTX Present
can go full screen from the separate runtime origin with the full-screen
permission Capy hands over (without `fullscreen` in `allow` the request is
refused); the sandbox flags are unchanged: the PPTX presenter window is one
Capy opens, and Capy opens it only for a command its menus mark
`popup: 'presenter'` (an `open-presenter` naming anything else is ignored).
While the runtime reports a PPTX show (`presenting`) its frame covers the
whole page at the top z-index, so a compromised runtime could draw over Capy
for as long as it claims a show; the frame stays sandboxed and cross-origin.

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
native viewer. DOCX searches current paragraph text (grouped by `w14:paraId`, so a
quote can span a page or column break inside its paragraph; the layout block
key when the file has none) and overlays its current run geometry. PPTX searches native text boxes and draws their current line rectangles.
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
exact state. A save takes the change from the merged document it already holds
and compares the rebuild with that document's encoding; only when the two
differ (a layout a fresh document merges) does it re-encode a fresh copy, so
the stored bytes are the same either way. Every read re-seeds the base, refuses a change whose seed hash
differs (the engine now seeds that base differently: publish it on the
previous engine) and requires that nothing stays pending. Text states are
stored whole; every Office state names its seed (a CHECK since migration
0043). No row stores a baseline: the indexed baseline always derives from the
base, as the decoded text or the engine baseline of seed(base), and the service
caches seeds (with their hashes) and derived baselines by base SHA next to the
bases. A publication without later edits returns the state to NULL. The Go API
rechecks current source access, epoch and account state through a small
access-only endpoint for incoming edits, at most every 5 s per connection. That
check is a lock-free read (no file advisory lock, workspace or account row
lock) on one snapshot; the checkpoint that saves the edits rechecks every
contributor's role and locked account under `sourceLockTx`, while frozen and the
storage limit stay admission-only (the 5 s recheck window). Checkpoint writes do not
check storage: a save only updates the ledger (see [storage quota](../backend-storage-quota.md)). The checkpoint answers with the new
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
of the room while the row still names its checkpoint and base, reading only those
two columns; a conflict reads
the session and state again. Shutdown flushes every room's pending store, and
the collaboration container has a 60 s stop grace period for it. File › Save in the Office header is Capy's own command
(`capy.save`) and takes the checkpoint directly, as Ctrl/Cmd+S in the runtime does through its `checkpoint` message, with
nothing serialized. The XLSX save
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
Run language metadata survives the native seed, Yjs projection and OOXML export,
and so does a run's font hint (`w:rFonts w:hint`), held in its own `fontHint`
mark so typing in the run and picking a font keep it. Picking a font sets each
run's Latin and complex-script fonts (`w:ascii`, `w:hAnsi`, `w:cs`, dropping
those slots' theme fonts, which would win over it) and keeps its East Asian
font, as Word's font box does (`picked_font`, one pass over the range with one
retain per stretch of equal fonts); an East Asian face (SimSun, Microsoft
YaHei, MS Mincho, Noto Sans CJK, the faces Word's metrics table lists and
their weights and variants, the ST, FZ and Nanum faces, or a name in CJK, kana
or Hangul script; `is_east_asian_family` in ooxml-text) also sets the East
Asian font. A select-all pick in a file whose runs alternate East
Asian fonts takes about 24 ms against 7 ms before and stores about 1.4 MB of
room update against 0.5 MB, since each stretch keeps its own font. The save
writes the fonts the editor holds and adds none (no `w:cs` copied from
`w:ascii`, no name the seed resolved for a slot that has a theme font).
A DOCX save writes each paragraph's source properties back as they were and
writes over them every paragraph property the editor holds differently from
what the seed gave it (direct formatting, else the list level, else the style,
with a table style's paragraph formatting in cells; `seededParagraphProperties`,
shared by the projector and the save). Style, list and table values are never
copied into a paragraph, so an untouched paragraph saves with the paragraph
properties its source had. The pPr children the model has no field for
(`w:kinsoku`, `w:wordWrap`, `w:overflowPunct`, `w:topLinePunct`,
`w:adjustRightInd`, `w:mirrorIndents`, `w:suppressOverlap`, `w:textDirection`,
`w:textAlignment`, `w:textboxTightWrap`, `w:divId`, `w:cnfStyle`) ride the
source formatting (`extraChildren`), so they stay on a paragraph the editor
changed and on both halves of a split, and `w:framePr` keeps its drop-cap,
lines, spacing, height-rule and anchor-lock attributes; the writer puts pPr
children in schema order. A vertically merged continuation cell, which the
seed folds into its restart cell, saves with its source paragraphs' properties
and no text (`continuationContent`: the source row is the one a seeded cell of
the same row names, within the restart cell's own merge, and a cell counts as
seeded only while its story holds one of its source paragraphs, so a new table
in a deleted table's slot takes nothing); a continuation in a row with no
seeded cell, as in a row the session added, saves an empty paragraph. A row's
skipped grid columns (`w:gridBefore`, `w:gridAfter`, `w:wBefore`, `w:wAfter`)
save while the row's cells and skipped columns fill the grid; the editor lays
every row out from the first column, so a row it adds next to such a row, or
one a column deletion leaves too wide, drops them. A cell paragraph made by
inserting a row, column or table or splitting a cell holds no alignment of its
own, and the editor gives it its style's values in its cell (`styleNewCells`,
one style read per cell), so a new header-row cell shows centred as the file
and Word do; the insert and that styling undo in one step (`inOneUndoStep`). A property the
editor holds nothing for is removed. Line
spacing and its rule, and the first-line indent and its hanging flag, save
together; a changed indent drops its character-unit twin (`w:leftChars` and the
like), which Word would otherwise prefer.

Editor operations store explicit values so Word shows what the editor does: an
indent the ruler or Decrease indent clears that the paragraph's style or list
level sets is stored as 0 (`explicitParagraphAttrs`), so the drag sticks, and a
style tab stop the ruler removes as a `clear` stop. A first-line or hanging
indent set on a numbered paragraph, zero included, wins over its list level's
in both seeders, as in Word. Applying a style (the
picker, Enter's next style, the toolbar, the ref API; `applyStyleValues`) keeps
direct paragraph formatting as Word does: each key a style controls
(`STYLE_CONTROLLED_PARA_ATTRS`: alignment, spacing before and after with their
line units and auto spacing, line spacing and its rule, contextual spacing, the
indents and hanging flag, keep with next, keep lines, widow control, page break
before, outline level, borders, shading, tabs, right-to-left, snap to grid, East
Asian auto spacing) that the paragraph holds nothing for, or holds as its old
style gives it, takes the new style's value (`styleParagraphValues`, what a
fresh paragraph with that style seeds as), and every other value stays. A value
equal to the old style's counts as the style's, unless the paragraph's own
source pPr set it and it still holds that value. The paragraph mark's run
defaults become the new style's with the mark's own run properties over them,
so its size stays; a character style on the mark (`w:rStyle` in the mark's
run properties) is not resolved into those defaults. Where the paragraph's
numbering came from its old style (or
it has none), the style's numbering and list rendering replace it
(`STYLE_NUMBERING_ATTRS`; the editor reads the package's numbering from the
materialized source, as the held host document carries none); numbering set on
the paragraph itself stays, with its level's indents. The save reads where a
paragraph's numbering came from off the paragraph (`numPrFromStyle`, recorded
by the op) and renders a list no source paragraph had with that style from the
style's numbering or else the paragraph's own level, so a style's list applied
in the session saves no indents, taking the style away leaves none, and a
directly numbered paragraph given another style writes no `w:ind` for its
level. A key the new style
leaves out is written as an explicit null, so two peers applying different
styles converge on one style's values (about twice the Yjs growth of removing
it, accepted). Run formatting stays the host's to apply. In a table cell the
values, and the save's comparison, take the table-style paragraph formatting of
the cell (`cellParagraphFormatting` in the editor, `cellContext` in
`yrsToDocument.ts`, one helper behind both). A cell the table had at open (its
story still holds one of its source paragraphs, by paraId from the materialized
source: the editor keeps its first materialize as `sourceDocument` and passes it
to every export as `yrsToDocument`'s `source`, since each later export's base is
the previous projection; a failed materialize fails the export) keeps
the look the seed gave it, also after its row or column moves; the editor shows
that look until the file reopens. Any other cell, a row or table made in the
session (by a peer too) and a reused cell id included, takes its current table
and position. So an untouched moved cell writes no stale header, last-row or
last-column look as direct formatting, a style picked in it writes only the
style, and Word shows its new place's look. Paragraphs a merge brings into a
cell compare against that cell's seeded look, so when the merge changes it (it
reaches the last column with that look on) they save their old cell's look as
direct formatting. Current positions read only the parent story's table
payloads (`storyTables`), once per style per toolbar or ruler command, and
Enter's next style passes the current paragraph's style values without listing
the story. Ops store tab stops in the seed's shape (`position`, `alignment`,
reading the older `pos`/`val` too) and the hanging first-line flag as a boolean.
Enter at the end of a paragraph (comment references after the caret aside,
so the reference stays with the text; a field ending the paragraph counts, as
the engine's split receipt reports it with `atEnd`, which the editor's Enter
reads) gives the new paragraph a copy of all its properties, as Word copies
the paragraph mark (`split_paragraph`): style and
list (so a list goes on whether the paragraph or its style gives it),
alignment, indents, spacing, borders, shading, tabs, keep with next, keep
lines, widow control, page break before, the mark's run properties and the
source formatting, so the save writes the source pPr, unmodeled children
included, for both paragraphs. The tracked mark insertion or deletion and the
source runs stay with the text's paragraph, the copy's `w:pPrChange` takes new
revision ids, and a section the paragraph ends stays with the mark that ends
it, the new paragraph's. Where the paragraph's style names another next style,
the new paragraph takes that style clean (`applyNextStyle` first clears what
the split copied, tracked in suggesting mode so Reject all keeps the heading),
so body text after a numbered heading has neither its list nor its direct
formatting. A peer's paragraph property change made while another peer presses
Enter at that paragraph's end lands on the new paragraph, which ends with the
source's mark (a fork item moves the new mark after it).
Enter in a list item that was empty before it (one holding a field, picture or
break is not) works as in Word (`endEmptyListItem`): a nested item moves up one
level, and a first-level item leaves the list, numbering set on the paragraph
going and a style's list turned off with `numId` 0 whenever the style gives
one, the indents becoming the style's without its list.
A split in the middle of a paragraph or before a block
leaves the source mark's tracked insertion or deletion (`pPrIns`, `pPrDel`) on
the source mark, and the new mark's copy of a tracked property change
(`w:pPrChange`) takes a new revision id. A revision id the editor makes saves as
2^30 + a 30-bit hash of the editor id, so it keeps its number in every save,
incremental ones too, on every peer and across publications, and stays within
int32 above the small ids Word writes; two editor ids, or one and an id from an
earlier publication, colliding is possible but unlikely. The engine's suggesting-mode
paragraph property changes (unused in Capy) save, but with the editor's
resolved values as the previous pPr rather than the paragraph's own.
PPTX uses a native textarea for typing, clipboard copy and paste, and IME composition. Copy puts the selected text on the clipboard as plain text and HTML (bold, italic and underline set on the run); a selected shape copies its whole text, one story per line. Read-only allows selecting and copying text, with typing, paste and cut refused; there is no cut. Edits over a selection that crosses paragraphs (typing, paste, IME, Enter, Backspace, Delete) replace it in one transaction and one undo step, joining the paragraphs under the first one's id and properties; a split (Enter or a newline) keeps the original paragraph's id on the first half and its properties on both halves, as PowerPoint continues a list, so Enter then Backspace restores the paragraph exactly (in a list item Backspace first removes the new item's marker, then joins); a refused edit changes nothing and no longer blocks later saves. Read-only speaker notes are `readOnly`, so they can be selected and copied.
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

The browser retains unacknowledged edits in IndexedDB, in the draft store notes
share (`src/lib/editDrafts.ts`, database `capy-edit-drafts`; the old
`capy-source-drafts` rows are copied over once, with a `migrated` marker in
the same transaction so a database an old tab recreates is never copied
again, and that database is deleted best effort).
A session (one editor mount) writes each local update as one row as it
happens, through the same drafts worker as notes (see
[plate-editor.md](plate-editor.md#offline-editing-and-drafts)), and its whole
state only once per offline episode, at unmount and `pagehide`, on entering
newer-version recovery, and after a failed write (retried at most every 5 s
while storage keeps failing; text sources follow the same rule): the host
page holds the room's Y.Doc on the runtime frame's
renderer thread, where a whole-state write took 48–65 ms of encoding at 62–248
DOCX pages plus a copy of the 1.2–5 MiB state every 250 ms of typing. A
receipt deletes the rows it covers, so a saved draft never returns as a
recovery prompt. A group of update rows with no whole state (a tab killed or
crashed online before the file moved on; a closed tab writes its state at
`pagehide`) cannot be drawn in another lineage and is dropped with "Some
unsaved edits from your last session couldn't be restored." (accepted
2026-10-07) Each row names its lineage, the room and base it
grew from (`source:<id>:epoch:<n>@<baseSHA>`; text drafts stay compatible
across the base hashes of one epoch). The source base is stored once per file
and SHA beside the rows and removed with the last row that uses it. Reopening
merges the rows of the current lineage; a receipt removes only the exact rows
it covers, and another tab's newer row remains. Save, export and handoff first
commit open spreadsheet inputs and wait for active composition or gestures.
Pending input counts as unsaved even before it reaches the shared document.
Draft storage that fails (private mode, a full disk, a draft whose base is
gone) is skipped, never an editing error; a reopened draft whose base is gone
is dropped with "Some unsaved edits from your last session couldn't be
restored." A save refused for good keeps the session's state as one refused
row (never merged back) and enters recovery; one refused for lost access or a
missing file (403/404) deletes every row of the file, other tabs' included
(not for a 403 about the account itself, which keeps them); a refusal with
nothing unsaved deletes only this session's rows, and a 401 (the gateway
rejecting the collaboration service's own secret) is a slow failure that
keeps the room editable and the drafts (see
[error handling](error-handling.md#collaborative-source-failures)).
Network and recoverable save failures leave drafts available. Before sending
buffered updates after reconnect, the token request verifies the current
epoch. An old epoch with unsaved changes enters recovery instead of merging
incompatible updates, under "This file changed while your edits were waiting
to sync."; rows of another lineage on reopen do the same. Each such draft
entering recovery is recorded as an `other_epoch_draft` editing incident, as
are the service's refusals, discards and epoch moves (see
[observability](../observability-metering.md#editing-incidents)). Recovery shows the
group read-only for copying (see
[error handling](error-handling.md#collaborative-source-failures)); its Reload
removes only those exact rows and advances to the next retained group, then
the current file. A client whose changes were all saved when it learns about a
completed handoff (from the room or on reconnect) shows the newer-version
banner instead; a client with unsaved changes enters recovery.

A text source edits its `source` Y.Text through a plain textarea
(`bindSourceTextarea` in `src/features/files/sourceTextBinding.ts`). Typing,
paste, Enter and deletions go in as one edit placed from the selection at
`beforeinput` and the caret after `input`, so the JavaScript per key does not
rebuild or rescan the text: the median key's handlers take 0.5 ms at 1 MiB,
7–8 ms at 10 MiB and 24 ms at 30 MiB, where they took 15, 160 and 554 ms.
Most of what is left is the browser computing the selection offsets (handlers
that only read `selectionStart` and `selectionEnd` take 0.3–0.4, 4–8 and 14 ms
on the same textarea), and the textarea itself takes about 0.45 s per key at
10 MiB and 1.9 s at 30 MiB, which decides how large an editable text can be. Offsets are mapped only when the source holds a `\r`;
anything the binding cannot place (undo from a menu, a drop, autocorrect) is
diffed against the whole text. An input-method composition is applied at its
end: without a co-editor's edit meanwhile it replaces the range it started on;
after one it is made on the document as the composition began and merged, so
it replaces only the characters that existed then and keeps what the co-editor
typed inside the range (2026-10-07), and the caret lands after the composed
text.

A source editor keeps editing while its room cannot be reached, as a note
does (see [plate-editor.md](plate-editor.md#offline-editing-and-drafts)): the
`offline` banner, the header's Offline, and its rows written as it edits. Past
the source state cap (`SOURCE_STATE_MAX_BYTES`, 100 MB, the service's
`MAX_SOURCE_STATE_BYTES`) of unsaved state while offline (the last whole state
written plus the update rows after it that no receipt covered, so saved edits
never count) the editor stops
taking edits (`offlineLimit`: Office `canEdit: false`, a paused textarea)
until it reconnects. When the collaboration service discards a source room
that held unsaved state (a save refused for good, the 5-minute slow-save
limit, a read-only or access refusal, an outbox access discard), it asks the
gateway to move the file to its next editing epoch before the room opens
again (`POST /internal/collaboration/files/{id}/epoch-reset`, an epoch that
already moved on is left alone). A client that missed the discard then sees
a new epoch and opens recovery instead of resyncing the thrown-away state;
a fully saved one sees the newer-version banner. A refresh captured under the
old epoch is superseded, as after any epoch change.

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

**Deferred publication.** An Office publication of the owner's, automatic or
drain work (every one but a system publication while editing is paused) never
touches open editors: it
swaps the file's bytes and index, and editing stays on the old base and epoch
(`rebuild_pending`, `published_state`: the published capture as its change over
seed(base), migration 0046). Edits saved after the capture stay pending,
measured against that capture on the old base (the engine's `compare`, XLSX
included), which gives the same text effects the rebuild later reports. A
save carries the base revision its effects were measured under, so one
measured before a publication is refused and retried. The
viewer reads the old base plus the state while the rebuild waits. Nothing is
charged for the kept capture or the old base, and the state is charged only
beyond the capture, which the published file already holds (migration 0054).

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
old epoch; a late step gives up and a later attempt retries. For the same
reason the rebuild keeps Huma's 5 s body read deadline, while the other large
source bodies (checkpoint, publish, refresh candidate; up to 150 MiB) may
take 60 s to arrive, the service's own timeout for those calls
(`sourceBodyDeadline` in `huma_source_documents.go`): at 5 s an 11 MB text
checkpoint was answered 408 on a loaded host. A room in
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

The immediate handoff remains for a system publication while the pause is on
(the window), where editing is paused anyway; the drain's system publications
before the window are deferred. A started handoff always completes. Each connected writer goes
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
them in place of the trap. A save the engine refuses (or traps on) is not
retried: the room is discarded and reopens at the last good save, while
clients with unsaved edits enter recovery with them. An engine timeout or a
lost worker is a slow failure, retried with backoff while the room stays
editable, until five minutes pass without a successful save (see
[error handling](error-handling.md#collaborative-source-failures)).

The worker keeps a replica per XLSX room: the room's source opened only to
read pending effects (`XlsxEffectsReader`, `configureOfficeReplicas` in
`vendor/betteroffice/shared/office-checkpoint.ts`), without the dependency
graph or the recalculation an editor needs. A save's pending effects pass
the room; the engine checks the saved state exactly as an apply would and
reads the effects off it beside the source, without applying it or
recalculating the workbook (only a state whose projection holds array
formulas is recalculated, since spilled values reach the effects). The
replica therefore never holds a state and serves any state of its base, an
older one included; another base replaces it. A state that is not a whole
workbook document is applied to a fresh session as before. Only
`xlsxPendingEffects` takes a room: agent edits, inspection, exports and
rebases open their own session. A call on the replica that fails drops it;
a fresh fallback session that fails leaves it, since the replica took no
part. The room's unload drops it too, and a replaced worker loses them all.
Replicas stay within `OFFICE_REPLICA_BUDGET_BYTES`
(`collaboration/src/officeRuntime.ts`) of estimated WASM heap, least
recently used first, and a new replica pushes out only replicas idle for 2
minutes; the estimate is 16 times the unzipped package (the heap measured
per unzipped byte), and a workbook whose estimate exceeds the whole budget
is never kept. DOCX and PPTX keep none: a DOCX open is a small part of its
baseline, and a PPTX replica saves little (about 0.3 s per save of a 24 MB
deck on the production box) for its memory (about 90 MB).
`collab_health`'s `office` object reports them
([observability](../observability-metering.md)).

Agent inspection and edits read XLSX cells through `checkpointCellsJson`
(ids, addresses, values and formulas, streamed without formats); the full
`checkpointProjectionJson` (formats, layout, images) serves baselines and is
streamed too. Building it as one JSON value per cell grew the XLSX engine's
linear memory to about 1.9 GiB on the 16,000-row gradebook, which WASM never
returns; it now stays near the opened workbook (338 MiB). Measurements:
[2026-10-05 replica report](../bench/collaboration/reports/2026-10-05-office-engine-replicas.md),
[2026-10-05 effects reader report](../bench/collaboration/reports/2026-10-05-office-engine-effects.md).

## Maintenance window

An engine upgrade that changes seed output runs in a maintenance window; the
steps and the `office-maintenance` commands are in the
[deployment runbook](../deployment-runbook.md#office-maintenance-window).

**Announcement and drain.** Every active account hears about the window seven
days ahead (in-app notification and a service email sent whatever the email
preferences) and again one day ahead (notification only), from `announce`.
After the reminder, `drain` republishes pending edits at platform cost while
editing is still live, oldest first and `--limit` at a time, so the window only
publishes the last day's edits; export-only files wait for the window.

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

The run font hint mark (`fontHint`) changes the seed of every DOCX holding a
run-level `w:rFonts w:hint` (most CJK text Word wrote). Capy's DOCX test
fixtures hold none, so their hashes stay; the golden fixture
`wordprocessingml-comprehensive.docx` holds some and pins the new seed. An
explicit zero first-line or hanging indent on a numbered paragraph also seeds
differently now. PPTX decks with a run highlight or any strike attribute
reseed too (`lecture.pptx` pins it). Migration
`0058_docx_pptx_seed_reset.sql` applies the guarded reset to `'docx','pptx'`,
so that pin deploys inside the maintenance window.
Keeping paragraph properties the model doesn't hold (`w:kinsoku`,
`w:cnfStyle` and the like), more `w:framePr` attributes and deleted text inside
fields and links changes the seed of every DOCX holding them (the e2e sample
`bo-corpus-1`; a golden test pins a file with unmodeled pPr children), so
migration `0059_docx_kept_properties_seed_reset.sql` resets `'docx'` again.

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
