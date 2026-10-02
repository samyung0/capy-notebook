# Todo: deferred learning outputs and review

Date: 2026-10-01. Owner: Epo. Not scheduled. These came out of the study progress
and Library-mode discussion and were deferred from `study-progress-plan.md` and
`library-agent-plan.md`. Decisions are in `human/agentic-retrieval.md` and
`human/miscellaneous.md` (2026-10-01 entries). Each item lists what to decide
before it starts, so the pieces are not rediscovered.

## Decks (PPTX main explainer)

The agent writes a deck as the main explainer when the learner wants something
brief or lecture-like. Builds on `artifacts/2026-09-17-curate-files-todo.md`
(the `create_file` tool, attribution inside file bytes), which lands first.

Decide:

- **A main-format study preference.** Notes are the only main explainer until
  decks ship, so the field is added with decks: note, deck, or let the agent
  choose from the explainer style (brief leans deck, detailed leans note).
- **Layout set and theme.** A small fixed set (title, section, two-column,
  figure + caption, table, quote, summary), each with named slots and limits
  (bullets per slot, characters per bullet, one figure per slide). Who designs
  it, and which fonts the PPTX runtime already ships (`src/office-runtime/pptxFonts.ts`).
- **Structural Office commands in the BetterOffice fork.** `OfficeCommand` only
  has `replace_text` and `set_cell` (`vendor/betteroffice/shared/office-checkpoint.ts`).
  A deck needs `add_slide(layout, after)`, `set_slot(slide, slot, content)`,
  `insert_table`, `place_image`, each with an inverse and target locators so
  chat Undo and guards keep working. Lands on `capy-ci` per the BetterOffice workflow.
- **Create from a spec, fill by edits.** `create_file` takes the outline
  (titles, layout per slide, theme); slides are filled with `edit_document`,
  a few per ledger todo, each grounded in what was just read.
- **Overflow as a tool error.** BetterOffice lays the slide out, so `set_slot`
  can refuse with "body overflows by N lines" instead of the model screenshotting
  its own deck.
- **Diagrams in slides.** Mermaid renders in a browser. Decide where a slide's
  diagram is rasterised (collaboration service, a headless renderer, or the
  client on first open) and the cost of each.
- **Library figures.** Placing a book figure through the `capture_knowledge_page`
  guard (withheld pages, figure pages only), and whether putting publisher
  figures into a downloadable PPTX is acceptable under each book's licence.
- **Attribution.** A deck leaves the app, so the "adapted from" lines travel in
  the bytes (a closing credits slide or footer), per the curate-files todo.
- **Playground.** Deck tools and a local PPTX writer in `lab/playground` before the app.
- **WASM cost.** The PPTX editor and viewer grew 34% and 50% at the last upstream
  merge (`todo-office-bench-and-uat-hardening.md`); decks make first view of
  PPTX common.

Reference only: ppt-master (MIT) for design rules and prompts; its SVG to
DrawingML converter is an option if the layout set proves too rigid. Skip
banana-slides (AGPL, slides are images, editable export through OCR).

## Question-bank search for the agent

With Library on, the agent reuses existing questions before generating.

Decide:

- **Access.** The bank is a separate database shared by UAT and production
  (`human/agentic-retrieval.md`, 2026-09-27). The retrieval service needs the
  reader role, and the bank needs a search index: keyword first, or embed bank
  questions with the library's embedding model.
- **Tool shape.** `search_questions(query, topics?, exam?, type?)` returning
  compact cards, and a read for one question with its marking scheme.
- **Copying into a workspace quiz.** The shared question format makes the copy
  direct. Decide the provenance record for a bank question (question id,
  version, author or licence) so it carries the same unremovable attribution as
  library content, and whether bank figures are referenced from the public
  bucket or copied (copying is charged to the workspace owner).
- **Retracted questions.** Copies are workspace content and stay.

## Open questions in review (Jev)

Review includes open-ended questions, graded by Jev ($0.042 per million input
tokens, no output cost).

Decide:

- **Scoring contract.** Per marking item 0 / 0.5 / 1 (`human/frontend/plate-editor.md`,
  2026-09-25) summed and normalised to 0-1, then the review thresholds (below 0.5
  Again, below 0.7 Hard, otherwise Good). Pending the scoring-contract item in
  `todo-question-bank.md` → Grading.
- **Metering.** Each graded answer goes through `usage_events` and credits
  reserve/settle like quiz grading.
- **Failure.** A failed grade shows an error and the learner resubmits; no
  automatic retry (AGENTS.md).

## Offline review

Decide:

- **Source of truth.** The append-only review log; server state is derived by
  replaying it in time order, so two devices merge.
- **Scheduling while offline.** FSRS runs in Go on the server. Offline needs a
  client copy (`ts-fsrs`) with the same parameters and version, or the client
  only records grades and orders its queue locally until sync.
- **What to download.** Question and card content plus images for the sets in
  progress, and how much storage that takes on a phone.
- **Clock skew** between devices when ordering the log.

## Question-bank progress

Separate from workspaces: grouped by topic and exam, same FSRS code, per-topic
mistake review, nothing more. Supersedes the "learning plan" idea in
`todo-question-bank.md` → Studying from the bank.

Decide:

- **Storage.** `bank_review_states` in the app database keyed by user and bank
  question id (plain id, no foreign key across databases), with the topic id
  copied in for grouping and a content hash that resets state on edit.
- **Retraction.** Published bank questions are retracted with a flag and never
  hard-deleted, so progress ids stay valid. This supersedes "operators delete as
  owner" (2026-09-27) when it lands; review skips retracted questions.
- **Where it lives.** The `/bank` page: check answer records the attempt and
  the topic list shows correct and incorrect marks.

## Later: study suggestions

A small, optional suggestion (for example a dashboard banner) once progress has
data. No due dates, deadlines or "study this today" pressure anywhere.
