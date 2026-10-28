# Note media for the chat agent

Decided by Epo 2026-10-28 (options A and B). A note's images, audio, YouTube
videos and HTML embeds become visible to the agent and tracked as edits;
the agent can view a note image as it views an Office picture. Search text
is unchanged: media and their captions stay out of the index (embeds
catalog decision 2026-10-17, `openwiki/embeds.md` "Index text").

The Rust session splits this into sessions. Part A2 (Go) and part B (Go
routes, contract, pipeline) can run apart from the Rust work once A1's
output shape is fixed.

## Today

| Element | `inspect_document` | Search text and note edits (`note_effects.go`) |
|---|---|---|
| quiz, flashcards, material_ref | questions, cards, embedded item id | yes |
| chart, plot, graph, mermaid | figure data, source | yes |
| equation, inline_equation | `$tex$` | no |
| html_embed | caption only | no |
| img, audio, video | `[media]` on an empty block line, no caption | no |

Adding, swapping or removing an image changes nothing the agent sees.

## A. Placeholders and tracked edits

**A1. Rust inspect** (`collaboration-rs/crates/notes/src/edit.rs`,
`inspect_material`). For every img, audio, video and html_embed element in a
top-level block, nested ones (columns, callouts) included, list it on the
block in document order: element id, type, caption text, and its identity
(`assetId` for img and audio; `provider` and `videoId` for video; nothing
for html_embed). Today `properties.media` is only `"true"`; replace it with
the list (a JSON string, as `block` is for figures). Keep html_embed's
existing `caption` property or fold it into the list, one or the other.

**A1 pipeline render** (`pipeline/pipeline/retrieval/tools.py`,
`_render_inspection`). One line under the block for each media element:

- `    [id] image "caption"`
- `    [id] audio "caption"`
- `    [id] YouTube video <videoId> "caption"`
- `    [id] HTML embed "caption"`

No caption: leave the quotes out. Drop the bare `[media]` flag.

**A2. Go note edits** (`server/internal/materialdoc/note_effects.go`).
`NoteBlock` gains the same media list, extracted in `ExtractNoteBlocks`
(Go reads the stored content; Rust's `index_text.rs` mirror is unaffected
because the index text does not change). `NoteChanges` adds one effect per
media element, matched by element id:

- kind `image`, `audio`, `video` or `html_embed`;
- operation add, remove, replace (identity changed: another asset, another
  video, other HTML) or move;
- a caption change as before/after text, like a block's text change;
- for an image that is there now, the element id the agent passes to
  resolve (B2).

The baseline is `materials.indexed_blocks` (jsonb), which the ingest worker
writes from the blocks Go hands it, so a new field needs no migration.
Check that the worker stores the blocks as given and does not rebuild them
with known fields only. A note indexed before this lands has no media in
its baseline: its first edits list every media element as added, once.
There is no production data, so that is acceptable (no backfill).

## B. Viewing note images

**B1. By id in inspect.** `inspect_document` takes optional `ids`: up to 4
image element ids from an earlier inspect. Each is attached to the next
model request as its own image, counted in the per-message image limit and
the image budget like a page capture, and usable as a deck figure by its
capture number. This is the Office flow (`_office_items` and
`_office_picture` in `tools.py`); reuse it rather than copy it. Audio, video
and HTML ids answer why they cannot be attached.

- Contract: add `ids` to `inspect_document` in
  `server/internal/agenttools/agenttools.go`, bump `ContractVersion`
  (44 now) and the pipeline's `SUPPORTED_VERSION`, run `pnpm gen:openapi`.
- Go: an internal route returns one note image's bytes, checked with the
  turn's access rules: workspace chat by the turn's workspace, account chat
  per item (`AccountDocumentAccess`). The image must be in that note: the
  asset's `material_id` is the note, or the element is in its current
  content. Reads the editor asset's object (`EditorAssetObjectPath`);
  only `ready`, untrashed assets.
- Pipeline: decode with `capture.image_jpeg`, cap the long edge at
  `cfg.capture_max_edge`.

**B2. Through `resolve_source_change`.** Its note form
(`material_id`, `block_id`) today returns a data block's text before and
after. For an image change (A2) it attaches the image as it is now, like a
file's picture change; `block_id` is the image's element id. A removed
image cannot be shown (same limit as Office). Go: the note branch of
`/api/internal/changes/resolve` (`internal_changes.go`) and the workspace
chat route both reach the B1 byte read.

## Prompts

The note editing and reading skills (`pipeline/pipeline/prompts/skills.py`)
and the tool descriptions say how to view a note image: inspect, then
`inspect_document` with its id. Workspace chat and account chat both get it.

## Tests

- Rust: inspect lists nested and top-level media with captions and ids.
- Go: `NoteChanges` reports add, remove, replace and a caption change for
  an image, and nothing for an untouched one; the byte route refuses a user
  without access and an asset of another note.
- Pipeline: render lines; an inspect with image ids attaches them within
  the limit; resolve of an image change attaches it.
- Update `openwiki/test-catalog.md`, `openwiki/embeds.md` (inspect and
  effects columns) and `openwiki/agentic-retrieval.md`.

## Later, not decided

- Searchable captions (would change the 2026-10-17 decision).
- Tracking equation edits (inspect shows them; edits are not tracked).
