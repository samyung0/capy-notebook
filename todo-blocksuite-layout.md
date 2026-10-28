# BlockSuite note layout spec

Status: draft, 2026-10-28. This is step 1's first deliverable (piece 1 of
`todo-blocksuite-spike.md`). It is the contract for the Rust crate, the TS
converter, MSW's `value()` and the structural check. Source:
AFFiNE canary `5f1925499760f6954c1e656711d9fb6ed3168179`, `blocksuite/affine/model`
and `blocksuite/framework/store`.

Scope: the blocks layout of a **note** room while both editors exist. `value()`
projects it to today's Plate-shaped material JSON (boundary 2), so Go, the
pipeline and share pages are unchanged. Quizzes and flashcards stay
`Model::Item` and are out of scope until the cut.

## Room doc

- The room's Y.Doc holds one root map, `blocks`, beside the generic roots it
  already has (`CONTRIBUTORS_ROOT`). There is no `content` XmlText, no
  `meta`/`spaces` map and no subdoc. Our own Workspace/Doc adapter hands
  BlockSuite the room doc as its space doc.
- `blocks` maps a block id to a `Y.Map` (a "yBlock").

### yBlock keys

| Key | Value |
| --- | --- |
| `sys:id` | string, equal to the map key |
| `sys:flavour` | string, one of the flavours below |
| `sys:version` | number, the flavour schema's `version` |
| `sys:children` | `Y.Array<string>` of child ids, in order |
| `prop:<name>` | the prop value, encoded by `native2Y` (below) |

`meta:*` props (`createdAt`, `createdBy` …) are never written.

**Every default is written at seed.** When a browser opens a block that lacks a
prop its schema defaults to a value other than `undefined`, BlockSuite writes
the default into the room (`sync-controller.ts:309-317`), readers and tabs
without a client id included, and the room refuses those writes. So
`state_from_value` writes every non-`undefined` schema default for every
block (the hubs' `xywh`, `index`, `edgeless` …, an image's `xywh`, `rotate`,
`size` …, a latex block's `scale` …), and the structural check refuses a block
missing one. `capy:*` schemas keep their defaults `undefined` where they can.

### How props are encoded (`native2Y`, `reactive/native-y.ts`)

- A `Text` prop is a `Y.Text`. Text attributes are the inline formats below.
- A plain array is a `Y.Array`, deep: each item encoded the same way.
- A plain object is a `Y.Map`, deep.
- A `Boxed` value is a `Y.Map` `{type: "$blocksuite:internal:native$", value}`,
  whose `value` is kept as raw JSON. We use it for nothing in step 1.
- Primitives (string, number, boolean, null) are stored as is. `undefined`
  props are not written.
- **Flat data** (`isFlatData`, the table only): the props object is flattened
  to dotted keys, one `prop:<path>` per leaf, for example
  `prop:rows.<rowId>.order` and `prop:cells.<rowId>:<colId>.text` (a `Y.Text`).

A chart's, plot's or graph's `block` is a plain object, so `native2Y` stores it
as a `Y.Map`, and every array in it (`labels`, `values`, `series`, `elements`)
as a `Y.Array`. BlockSuite's prop proxy edits arrays in place, so two writers
interleave. Our figure editors replace a whole `series`/`elements` entry (or
the whole field) per change, as the Plate room does today (`sharedMap`,
`sharedLists`).

## Tree

```
root   affine:page   prop:title  (empty Y.Text, unused)
└─ note  affine:note   prop:displayMode "doc"  (NoteDisplayMode.DocOnly)
   └─ content blocks, nested as below
```

- The two hub blocks have fixed ids, `root` and `note`. They have no Plate
  counterpart, so `value()` skips them. `state_from_value` writes them, and
  for an empty value one empty `affine:paragraph` under `note`, because the
  browser makes no edits at init.
- No `affine:surface` in step 1. If the page root refuses to render without
  one, the vendoring spike says so and it gets a fixed id `surface`.
- New block ids come from the workspace `idGenerator`, set to
  `crypto.randomUUID()` (what `stableElementIds.ts` uses today).
- A Plate block with a missing, empty or repeated id is seeded as
  `<parentId>-b<index>` (`note-b3` at the top level, `note-b2-b0` inside a
  container), so both languages seed the same room. Stored content always has
  ids; older corpus values don't.

### Nesting and indent

Plate lists are flat (`indent` + `listStyleType` on top-level blocks).
BlockSuite nests: a list item's sub-items and continuation paragraphs are its
children, and Tab moves a block into its previous sibling.

- `value()` walks the note's subtree depth first and emits every block at the
  top level. A block at depth `d` (direct children of `note` are depth 0)
  gets `indent = d + 1` if it is a list, `indent = d` otherwise (omitted when
  0). So a nested list item is `indent 2`, and a paragraph continuing a
  top-level list item is `indent 1` with no `listStyleType`, which is what
  Plate writes today.
- `state_from_value` inverts it with a stack: the target depth is
  `indent - 1` for a list and `indent` otherwise, and the parent is the nearest
  preceding block one level up that may hold children (a paragraph or list).
  A block whose indent skips a level is clamped to one below the deepest
  open parent (normalization N1).

## Block flavours

Plate element → flavour, with the props each writes. "Ours" marks a prop we add
to the vendored schema (each one is listed in `vendor/blocksuite/README.md`).

### Text blocks

| Plate | Flavour | Props |
| --- | --- | --- |
| `p` | `affine:paragraph` | `type: "text"`, `text`, `textAlign` |
| `h1`–`h6` | `affine:paragraph` | `type: "h1"`…`"h6"`, `text`, `textAlign` |
| `blockquote` | `affine:paragraph` | `type: "quote"`, `text`, `textAlign` (N3) |
| `p` with `listStyleType` | `affine:list` | `type`, `text`, `checked`, `order`, `textAlign`, `listStyleType` (ours) |
| `code_block` + `code_line` | `affine:code` | `text` (lines joined with `\n`), `language` (`lang` as is; absent → `null`), `wrap: false`, `caption: ""` |
| `hr` | `affine:divider` | none |
| `callout` | `affine:callout` | `variant` (ours: `info\|tip\|warning\|success\|danger`), children are its paragraphs; `prop:text` stays empty |
| `equation` | `affine:latex` | `latex` (= `texExpression`) |

- `align` → `textAlign`: `left`, `center`, `right`; `start` → `left`,
  `end` → `right`; `justify` is kept as an extra enum value (ours).
- List `type`: `disc` → `bulleted`, `decimal` → `numbered`, `todo` → `todo`.
  Any other `listStyleType` (`lower-alpha`, `upper-roman`, a pasted CSS value)
  → `numbered` for the `*-alpha`/`*-roman`/`decimal-*` family, `bulleted`
  otherwise, with the original string kept in `listStyleType` (ours) and
  given back by `value()`.
- `listStart`, `listRestart` and `listRestartPolite` → `order` on that item;
  `order: null` on the rest. Piece 2 checks this against BlockSuite's
  `correctNumberedListsOrder` before it is final.
- `checked` → `checked`. A todo item always comes back with `checked`
  (`false` when it was missing). `listStyleType` (ours) is written on every
  list item.

### Media and embeds

| Plate | Flavour | Props |
| --- | --- | --- |
| `img` | `affine:image` | `sourceId` (= `assetId`, figure ids `figure:<id>` included), `size` (= `sizeBytes`), `caption` (plain text of the Plate caption), `textAlign` (= `align`), `width`/`height` in pixels (D21, N8), `name`, `contentType` (ours) |
| `material_ref` | `capy:material-ref` | `materialId`, `refKind` (`quiz\|flashcards`); void, top level only (piece 4) |
| `audio` | `capy:audio` | `assetId`, `name`, `contentType`, `sizeBytes`, `caption` |
| `video` | `capy:video` | `provider`, `videoId`, `width`, `caption` |
| `toc` | `capy:toc` | none |
| `chart`, `plot`, `graph` | `capy:chart`, `capy:plot`, `capy:graph` | `block` (deep Y.Map), `width` |
| `html_embed` | `capy:html-embed` | `html`, `caption` |
| `mermaid` + `mermaid_caption` | `capy:mermaid` | `source` (Y.Text), `caption` (Y.Text, from `mermaid_caption`), `width`, `theme` |
| `column_group` / `column` | `capy:columns` / `capy:column` | `capy:column`: `width`; children are content blocks |

- `capy:*` flavours are our own schemas in `src/features/notes/blocksuite/`.
  In step 1 only `capy:material-ref` gets a real view; the rest render through
  the existing read-only React renderer as an island (enough for the bench's
  full load-test note).
- Image widths are pixels (D21). The seed turns a stored `"<n>%"` into
  `round(n × 768 / 100)` px and leaves `height` at 0 (drawn from the image's
  aspect ratio); `value()` turns pixels back into `"<n>%"` against 768 px,
  clamped to 20–100 (N8).

### Tables (`affine:table`, flat data)

| Plate | Blocks |
| --- | --- |
| `table` (id) | block id; `marginLeft` dropped (N4) |
| `tr` (id) | `rows.<rowId> = {rowId, order}`, `rowId` = the `tr` id, `order` a fractional index (`a0`, `a1`, …). A `tr` id that is missing, empty, repeated or holds a `.` becomes `<tableId>-r<i>` |
| column *i* | `columns.<colId> = {columnId, order, width}`, `colId` = `<tableId>-c<i>` with any `.` in the table id turned into `_`, `width` from `colSizes[i]` |
| `td`/`th` | `cells.<rowId>:<colId>.text`, one `Y.Text`; its paragraphs joined with `\n` |
| `th` | `header: true` on its row (ours) |

Flat-data keys are split on `.` (`flat-native-y/initialize.ts:25`), so no row
or column id may hold one. A row is a header row only when every cell in it is
a `th`. Merged cells are split into a full grid and short rows are padded
(D15: merging is dropped). `colSizes` comes back only when some column has a
width, with `null` for the rest (every validator accepts `null` entries).

`value()` gives back `tr` with id `rowId`, cells as `td`/`th` with one `p`
holding the text, and `colSizes` from the column widths.

## Inline formats (`Y.Text` attributes)

| Plate mark or inline | Attribute |
| --- | --- |
| `bold`, `italic`, `underline`, `code` | same name, `true` |
| `strikethrough` | `strike` |
| `color` | `color` (our value as is) |
| `backgroundColor` | `background` |
| `subscript`, `superscript`, `highlight`, `kbd`, `fontSize`, `fontFamily` | same name (ours: an inline spec each) |
| `a` (`url`) | `link` on its text; `target` dropped (never written) |
| `inline_equation` (`texExpression`) | one `" "` with `latex` |
| `mention` (`key`, `value`) | one `" "` with `mention: {member: key, name: value}` (`name` ours) |

- Transient elements are never written to the blocks layout:
  `mention_input`, `slash_input` and `placeholder` (BlockSuite's own menus
  and upload state live outside the doc), and the `ai` mark.
- `comment`/`comment_*` marks are never stored today, and stay that way.
  BlockSuite's `comment-<id>` attributes are not used (D5).

## Ids

- **Top-level blocks keep their Plate id** as the block id, both ways. These are
  the ids `MaterialIndexText`, `indexed_blocks` and `NotePendingChanges` align
  by (`index_text.go:56-80`, `note_effects.go:112-171`), and the
  `block_id` of a comment. Nested blocks (list children, callout paragraphs,
  column contents) keep theirs too; `value()` puts them at the top level or
  inside their container as Plate expects.
- **Derived ids**: elements with no block of their own get ids derived from
  their block in `value()`. They are never stored, and nothing aligns by them
  (only top-level ids are used for effects):
  - `code_line`: `<blockId>.l<n>`;
  - `td`/`th`: `<rowId>:<colId>`;
  - the single `p` inside a `blockquote` or a cell: `<ownerId>.p`; a
    `mermaid_caption` holds its text directly and is itself `<mermaidId>.p`;
  - inline `a`, `mention` and `inline_equation`: `<ownerId>.i<n>`, one counter
    from 0 per block (a code block counts across its lines, a cell's owner is
    its cell id).
- So the round-trip test compares values after rewriting derived ids in the
  input the same way (`canonical()`), and compares top-level and nested block
  ids exactly.

## Normalizations (bridge only)

`state_from_value` changes these Plate values. While both editors exist they
only happen on dev stacks that seed blocks rooms. After the cut, paste and
import write blocks directly, so they stop mattering.

- **N1** an indent that skips a level is clamped.
- **N2** every block other than `p` (headings, quotes, images …) loses its
  list keys; an image is still nested by its indent. Note-only flavours
  (table, material-ref, chart, plot, graph, html-embed, columns) ignore
  `indent` and sit at depth 0.
- **N3** a `blockquote` with several paragraphs, or nested quotes at any
  depth, becomes one quote paragraph whose text joins them with `\n`.
- **N4** table `marginLeft`, `tr.size`, cell `colSpan`/`rowSpan`/`attributes`,
  `background`, `borders` and `size` are dropped; a merged cell is split.
- **N5** `textIndent` (DOCX paste only) is dropped.
- **N6** a cell or caption's marks inside multi-paragraph text are kept, its
  paragraph breaks become `\n`.
- **N8** a media width in percent becomes pixels against a 768 px reference and back (D21).
- **N7** a paragraph ending on an inline void (an inline equation) gets the
  trailing empty text leaf Slate's normalization adds.

Refused rather than normalized: unknown element types, keys and marks, and a
`material_ref` with a non-null `pending`. Only the `ai` mark, `comment*` marks
and the transient elements are dropped. An empty note projects as
`[{"text":""}]`, as `plate::value` does.

## Comment anchors (D5)

- They stay relational (`material_discussions`). `block_id` is the id of the
  block whose `Y.Text` holds the anchor, nested or not. For a table cell it is
  the table's id.
- `anchor_start`/`anchor_end` are `Y.encodeRelativePosition` on that `Y.Text`,
  with `anchor_version = 2`. Version 1 anchors (slate-yjs tree) are not
  carried over; there is no data to keep.

## Awareness

One field set, so BlockSuite and ours don't overwrite each other:
- BlockSuite's awareness store writes `selectionV2` (text, block and cursor
  selections per selection manager) and a top-level `color`
  (`yjs/awareness.ts:12-64`). We keep `selectionV2` and drop its random
  `color`: cursor labels come from verified room presence and colours from the
  server's hash, as decided for Plate (see `todo-blocksuite-decisions.md`), so
  the remote-selection widget is ported to read those.
- Our cursor field (`NoteEditorCore.tsx:1469-1473`) is not written by the blocks
  editor; `selectionV2` replaces it.
- `uploadPresence` keeps its `UPLOADS` field.

## Structural check (server, piece 5)

A blocks room is valid when:
- `root` and `note` exist with their flavours, `root` has no parent and `note`
  is its only `affine:note` child;
- every block is reachable from `root` and listed in exactly one
  `sys:children`, with no dangling child ids;
- each flavour sits under a parent its schema allows (`metadata.parent`), and
  `capy:material-ref`, `capy:chart`/`plot`/`graph`/`html-embed` sit directly under
  `note`;
- every `prop:*` key is in the flavour's prop list, with the value types above,
  and every non-`undefined` default is present;
- no block is nested more than 8 levels below `note` (D18);
- an `affine:image` may hold an empty `sourceId` while it uploads (D13);
  `value()` leaves such an image out, so nothing about an upload is stored
  (PE:168).

Concurrent moves and deletes break the reachability rules in normal use; they
are repaired on entry (D3).

## Open for Epo

- **T1, tables:** settled 2026-10-28 (D15), merging is dropped.
- **T2, image width:** settled 2026-10-28 (D21), pixels.
