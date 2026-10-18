# Chat agent: editing and creating Office files

Status 2026-10-18: the tool shape is decided (recorded in
`human/agentic-retrieval.md`, 2026-10-15). The command set waits on the open
decisions below. Nothing built. Engine survey: the Rust harness session's
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

## Open decisions (recommendation in brackets)

1. Starter files for `create`: a committed starter DOCX/XLSX with our styles,
   or a minimal engine-written blank [starter files; the Create tab's blank
   Office tiles need the same answer].
2. How `create` stores the file [built in the engine, stored as an upload].
3. First format and commands [XLSX: set range, format cells, add/rename sheet,
   create; DOCX next, then PPTX].
4. Skill for edits [only `editing`; `office_building` only for `create`].
5. Undo for big ranges [per-cell expected values, at most 500 cells a call].
6. Cap source Undo steps at 256 KB [yes].
7. PPTX add slide from a layout [after the engine places layout placeholders;
   check it against the deck structure decision of 2026-10-05].
8. The `HYPERLINK` formula [refuse].
9. Visual check of an edit [later; needs a render of the live room].

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

- Engine work after Epo's answers (style-only formatting, PPTX placeholders,
  list restart, scoped reads) and the existing path's refusal mapping: the
  Rust harness session.
- Tool, schema, history-derived tool list, skill, pipeline refusal wording,
  docs and tests: the agent-tools side (Mac).
