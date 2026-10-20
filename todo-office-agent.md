# Chat agent: editing and creating Office files

Status 2026-10-20: every open decision is answered (recorded in
`human/agentic-retrieval.md`, 2026-10-15 and 2026-10-20). Building on the PC
in the order XLSX, DOCX, PPTX. Engine survey: the Rust harness session's
report in the private harness (`2026-10-06-rust-round/office-agent-commands/
REPORT.md`, harness commit 0ca23b61, read at Capy c9650685 and fork d5e297bf).

## Today

- The agent edits Office sources with `inspect_document` + `edit_document`
  (`server/internal/agenttools/agenttools.go`). The fork's agent `Command`
  (`crates/office-service/src/types.rs`) has only `ReplaceText` (a substring
  inside one DOCX/PPTX paragraph or shape) and `SetCell` (XLSX). Edits run in
  the collaboration engine's background lane on the live room, each with an
  Undo inverse and `stale_target` refusals carrying `details.block`.
- No Office file is created by the agent except decks (`create_deck` /
  `write_slide`, ppt-master in the retrieval image).
- `capture_page` renders an Office source through the parser's LibreOffice
  from the stored blob, not the live room, so it cannot check an edit just made.
- How others do it (2026-10-15 survey): Claude.ai and Codex rewrite a copy of
  the file in a code sandbox (skills + `docx`/openpyxl + LibreOffice render),
  which cannot edit a shared document live; Microsoft's Excel agent runs
  generated Office.js against the open workbook; Gemini edits inside Docs.
  Ours already edits the live room, the gap is the command vocabulary.

## Decided (Epo 2026-10-15)

- A separate tool `edit_office_document`, typed per format and detailed;
  `edit_document` keeps notes, cards, quizzes and Mermaid, and loses its Office
  variants (`replace_text` on paragraph/shape ids, `set_cell`).
- It is offered only after an `inspect_document` on an Office source or a
  `read_skill("office_building")` in the retained history, and stays for the
  rest of the conversation (the tool list is derived from history). Adding it
  costs one provider cache miss: on GLM/Relace any tool-list change misses the
  whole prefix (3/3 add, 3/3 remove, measured 2026-10-15), so tools are never
  added or removed per call otherwise.
- One tool for all three formats, not one per format (a second format would
  cost a second miss).
- Creation is a `create` command in the same tool (format, title, chapter, then
  the call's other commands applied to the new file); decks keep
  `create_deck`/`write_slide` and are edited through the Office tool once they
  exist.
- `inspect_document`'s description says Office files are edited with
  `edit_office_document`, offered after an inspect.

## Decided (Epo 2026-10-20)

- Reads move out of `inspect_document`: a separate `inspect_office_document`
  (sheet list, capped range, DOCX paragraph window with styles, PPTX slides
  with layouts and shapes) is offered with `edit_office_document` once
  `read_skill("office_building")` is in the retained history. `inspect_document`
  keeps its definition and answers an Office source by pointing to the skill.
  On Z.AI adding a tool misses the whole cached prompt (4/4 on 2026-10-20;
  Z.AI caching is implicit only), accepted once per chat.
- `office_building` is required for every Office read, edit and create;
  `editing` drops its Office lines and says the agent sees most recent
  changes after a read (hints for unindexed edits are being built by the
  effects session; word them as "may").
- `create`: committed starters (DOCX from python-docx's default template,
  one-sheet XLSX from the engine), built in the engine and stored as an
  ordinary upload via `/api/internal/files` (widened to .docx/.xlsx); the
  Create tab's blank tiles use the same starters. Templates later.
- Size: commands ≤256 KB a call (pipeline check), Undo step ≤256 KB like
  materials (`quota_rejected`); office_building states the limits in one line
  and asks the agent to split; refusals carry the engine's sentence; beyond
  that only the collaboration server's rate limit.
- PPTX: `add_slide` with an optional layout (default: the layout of the slide
  it follows), the engine creating the layout's placeholders; `add_text_box`
  for decks whose only layout is blank (ppt-master's).
- Formulas: one validator in office-service for agent commands only
  (rules under "Required" below); people keep Excel parity.

## Later

- Visual check of an edit: `capture_page` renders the last published blob
  (publication: ≥3,000 net changed tokens or 7 days, 60 s idle), so it cannot
  see an edit just made. A live check would export the room through
  office-service and send it to the parser's capture route. Needs testing;
  decks do fine without it so far.
- Office templates and quick starts beside the blank tiles.

## Engine survey per format

| Format | Engine has it, agent path does not | Needs engine work | Never expose |
| --- | --- | --- | --- |
| XLSX | set a range (`Workbook::edit_cells`, recalculates from touched cells, ≤500 cells, about 350 B Undo per cell), format cells (`patch_range_style`, `set_range_number_format`, one `apply_ops` per call, ≤500 cells), add/rename sheet (`Op::AddSheet`/`RenameSheet`, inverse renames back) | style-only formatting without a full recalculation; compact Undo for formats | hyperlinks, images, OLE |
| DOCX | insert a paragraph with a style from the file (≤20 a call, ≤5,000 characters each, no line breaks), delete a plain paragraph (no objects, fields or tracked changes; never the story's last), one bullet and one numbered list, simple tables (`insert_table`/`delete_table`, ≤20×10, not nested) | restarting list numbering | fields, style definitions, equation text |
| PPTX | set a shape's multi-paragraph text (≤50 paragraphs, ≤5,000 characters, an internal "restore story" inverse; equation stories refused) | add a slide from a layout (new slides get no placeholder shapes) | images |
| create | XLSX can be written from nothing (not yet opened in Excel) | DOCX needs a starter file | PPTX (`create_deck` covers it) |

## Required whatever is picked

- Scoped reads: `inspect_document` on a source fails above about 54k non-empty
  cells (the engine returns everything, Go reads at most 8 MiB; the gradebook's
  answer is 35 MB). Needs a sheet list, a capped range read, a DOCX paragraph
  window with its styles, PPTX slides with layouts and shapes.
- Cost: each call reopens the whole document and XLSX recalculates fully (3.3 s,
  315 MiB for one `set_cell` on the 8×2,000-row gradebook, old release build);
  the pipeline gives an edit 10 s and the background lane is one process shared
  with every room's exports. Batch a call's changes into one engine call.
- Refusals: new commands refuse with `invalid_input` or `unavailable_target`
  and a sentence, or `stale_target` with `details.block` (paragraph, cell, range
  as TSV, shape, sheet). The pipeline's `_missed_target` wording speaks of a
  material's blocks; source files need their own.
- Formulas the agent writes (XLSX): only functions the engine implements
  (unknown names are saved verbatim and run in Excel: WEBSERVICE, FILTERXML,
  IMAGE, RTD, CALL, REGISTER.ID, CUBE*, `_xll.*`, PY); refuse `HYPERLINK`;
  every sheet reference names a sheet of this workbook, no `[...]` workbook
  references, URLs or paths; refuse formulas that do not parse (DDE `cmd|…`
  becomes a text cell today); formula ≤2,000 characters, text ≤32,767.
  Uploads keep their macros, external links and OLE byte-identical; agent
  commands never add them.

## Owners

- The "Office agent tool" session on the PC builds all of it (fork branches
  from origin/capy-ci, Capy branch); the Editor session ("Rust harness
  optimizations and security review") approves pushes, merges capy-ci and
  bumps the pin.
