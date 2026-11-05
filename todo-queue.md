# What's next

Epo's order across every plan, so nothing queued gets lost. Each item points at the
plan that holds its detail. Change this file whenever something starts, lands or moves.

## Landing now

Windows lands and deploys these, one landing per deploy.

| Item | Where it is | Waiting on |
|---|---|---|
| Room pair and Office page-draw fix | `main` 57a62f208 | CI, UAT deploy, UAT quality run (`makeQuiz.spec.ts:211`) |
| Grading off Jev | `claude/grading-off-jev` abb0ae70a | The deploy above reporting; then the first real 1017 marks on UAT |
| Layout service on the ingest host | Built, not running; runbook §7.6 | Epo answering Windows' Q646; after grading, as its own landing |
| Shared pages lose AI marking (Q640 B) | Windows | After grading |
| New assignment's quiz picker | `claude/assignment-quiz-picker` eeb6035fc | Windows' review round |

## Next, in order (Epo, 2026-11-06)

### 1. Drawing answers: the canvas for submitting an answer

Started 2026-11-06. Plan: `todo-study-tracking.md`, "Drawing answers" (agreed 2026-11-03),
boards K6, K7 and K8 on the study Design canvas. Scanned submissions build on its marking path.

- [ ] Try the real BlockSuite edgeless editor as the board: chunk size, open time, tools against K6–K8, drawing to an image
- [ ] Bring `vendor/blocksuite` to `main` in a lazy chunk (today it's only on `blocksuite-notes`)
- [ ] `drawing` answer type with its background (blank, squared grid, axes, figure) in the shared question format: Go, Rust, TypeScript, pipeline
- [ ] The board: full screen, question pinned at top left, Done returning to a preview and "Edit drawing", phones
- [ ] Saving: strokes kept, an image rendered for marking, and who pays for its storage
- [ ] Marking by a vision model against the marking points, with the same approval and credits rules. Needs grading landed, and the prompt shown to Epo first
- [ ] Results, the approve tab and the report show the drawing
- [ ] Specs, wiki, test catalog

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
