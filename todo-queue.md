# What's next

Epo's order across every plan, so nothing queued gets lost. Each item points at the
plan that holds its detail. Change this file whenever something starts, lands or moves.

## Landing now

Windows lands and deploys these, one landing per deploy.

| Item | Where it is | Waiting on |
|---|---|---|
| Room pair | On `main` and UAT at 57a62f208 | Done; `membership.spec.ts` passed its first real run |
| Make a quiz on UAT: crash screen on both papers (`makeQuiz.spec.ts:211`, run 42067521199) | Extraction, not fixed | Finding the throw; a render error on real data, not the frame position |
| Grading off Jev | `claude/grading-off-jev` abb0ae70a | The deploy above reporting; then the first real 1017 marks on UAT |
| Layout service on the ingest host | Built, not running; runbook §7.6 | Epo answering Windows' Q646; Windows wants the Make a quiz fix first |
| Shared pages lose AI marking (Q640 B) | Windows | After grading |
| New assignment's quiz picker | `claude/assignment-quiz-picker` eeb6035fc | Windows' review round |
| Vendored BlockSuite, dev route only | `claude/drawing-answers` 9fbaf3afa | CI, comparing its build with `main`'s, Windows' review round |

## Next, in order (Epo, 2026-11-06)

### 1. Drawing answers: the canvas for submitting an answer

Started 2026-11-06. Plan: `todo-study-tracking.md`, "Drawing answers" (agreed 2026-11-03),
boards K6, K7 and K8 on the study Design canvas. Scanned submissions build on its marking path.

- [x] Try the real BlockSuite edgeless editor as the board (2026-11-06; `src/features/blocksuite/drawingBoard.ts`, dev route `/dev/drawing`, branch `blocksuite-notes`). It works, on a production build:
  - **Download:** 1.16 MB gzipped, loaded only when the board opens (1.81 MB with every editor part, 1.03 MB without note cards).
  - **Open:** about 0.25 s, or 0.8 s at 4x CPU slowdown, not counting the download.
  - **Answer size:** about 2 KB for a sketch with a label, 30 KB for 42 long strokes. Image for marking: about 115 KB.
  - **Worked:** pen, typed labels and note cards in the image, a saved answer reopening, the axes sheet that no tool can erase, touch drawing at 360 px.
  - **Only tried on mocks:** Chromium on this Mac with simulated touch, no real phone or pen.
- [ ] Fix what the try found: a typed label throws a `ZodError` from `recordLastProps` (probably zod 4 on the vendored schema); the zoom bar covers the toolbar at 360 px; the sheet opens small on phones; the note image and attachment items need removing; undo, redo and the formula and graph presets aren't in AFFiNE's toolbar and need adding; note cards need drawing onto the sheet in the image
- [ ] Bring `vendor/blocksuite` to `main` in a lazy chunk (Epo, 2026-11-06: "sure"): on `claude/drawing-answers`, dev route only until the answer flow opens it
- [ ] `drawing` answer type with its background (blank, squared grid, axes, figure) in the shared question format: Go, Rust, TypeScript, pipeline
- [ ] The board: full screen, question pinned at top left, Done returning to a preview and "Edit drawing", phones
- [ ] Saving: strokes kept, an image rendered for marking, and who pays for its storage
- [ ] Marking by a vision model against the marking points, with the same approval and credits rules. Needs grading landed, and the prompt shown to Epo first
- [ ] Results, the approve tab and the report show the drawing
- [ ] Specs, wiki, test catalog
- [ ] Tune the board once it works (Epo, 2026-11-06): more common shapes, graphs and coordinate planes, for easier answering

### 2. Note look: copy Notion's styles

Epo's words: "note themeing/styling, e.g. copy notion styles so i think we dont have those
floating toolbars on e.g. tables and stuff, and affine has a table view as well."

- [ ] Compare how Notion and AFFiNE handle tables, with mocks first
- [ ] Decide which editor it goes on. Plate is nearly frozen and goes at the cut, and new note features were to go on BlockSuite only (`todo-blocksuite-spike.md`)
- [ ] Table View: AFFiNE's `database` and `table` blocks are vendored; the blocks layout refuses `database` today
- [ ] Revisit D12 (BlockSuite's own widgets, restyled) and the shared floating toolbar decision (PE:24)

## Queued, no order yet

- **Workspace canvas** (`todo-canvas-workspace.md`): on hold since 2026-11-02. Was next after the study rework; ask Epo where it goes once drawing answers are in, since it reuses the same edgeless editor.
- **The Plate cut to BlockSuite** (`todo-blocksuite-spike.md`): step 1 done on `blocksuite-notes`, which is 124 commits behind `main`. Comes with 2 or the canvas, not decided.
- **Scanned submissions** (`todo-study-tracking.md`, "Later"): needs its own design round.
- **Study leftovers** (`todo-study-tracking.md` §11 "Can wait"): AI insights, the app-wide Learning page redesign, "Copy to my workspace", sharing practice with the class, gamification.
- **Handed over by Windows, not started** (`todo-study-tracking.md`, "Where it stands"): a question with no answers through `insert_child`; dotted question ids in `quiz.rs`; locks in `source_imports.go`; the `StartAssignment` expired-attempt lock; `DeleteAssignment` returning 404; a whole run's figure cap; sweep starvation.
- **Results page and answers:** results hide answers after an assignment closes while Practice shows them. Optional, Epo hasn't decided.

## Older plan files

`todo-standalone-files.md`, `todo-clone-download.md`, `todo-account-chat.md`, `todo-ghost-text.md`,
`todo-presence.md` and `todo-note-media.md` have landed on `main`, or look that way from its commits.
Their status lines are from October and weren't updated, so don't read them as open work.
