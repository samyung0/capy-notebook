# What's next

Epo's order across every plan, so nothing queued gets lost. Each item points at the
plan that holds its detail. Change this file whenever something starts, lands or moves.

## Landing now

Windows lands and deploys these, one landing per deploy; Mac sessions review and push feature
branches (Epo, 2026-11-06, after the account switch). Main is 6159c0f25: ribbon (protocol 27), the
quiz Undo fix 779c114fa, canvas-enrich to 2b1fc744f. On the PC's opening train: `claude/quiz-image-back` 43b17c1ea and `claude/board-connector-load` 236859139. Main 33ae38a79 (2026-11-07) holds drawing answers (f63bef786 with the PC's review fixes Q693–Q695, canvas-enrich to 83150e8f0) and the pen fixes; UAT green at 33ae38a79, including a live vision-marking call (1017 read a sample and a student drawing: shares [1.0, 0.0]). Main a33c204f6 adds board-chunk-trim; UAT green there (deploy-uat 42357590925, uat-quality 42358510007), so UAT has everything for UI testing. The board train landed 2026-11-09: main 0a7234dee (land-board-subs merges b44b28777 and 0a7234dee, Study → Members 5428c0799, Windows' fix rounds Q714–Q730), UAT deployed green at 7d09ff117 (run 42610697411's Deploy UAT); the UAT quality run at 7d09ff117 failed only in `critical_paths (app)` cleanup ("Verify no Sentry event for the run": an event was reported during the journeys) and Audit failed. Windows (2026-11-09): the quality lane's 14/14 journeys passed; the cleanup check saw a Clerk user-lookup timeout on GET /api/integrations and three "Source download failed" from the collaboration server fetching the test DOCX, neither path changed in the train, no rerun; the push-triggered Audit passed and only the scheduled image scan failed on new OS advisories (alpine musl and zlib in server/ops, debian apt in parser/layout, zlib1g in pipeline), base-image refresh on the PC. New work branches from main 7d09ff117.

| Item | Where it is | Waiting on |
|---|---|---|
| Grading off Jev | On `main`, UAT at 8f184f0bb | Done: a real 1017 call in the study journey, through OpenRouter on Wafer, 0.34 credits, one award per marking item |
| Make a quiz's crash | On `main`, UAT at 8f184f0bb | PowerPoint paper passed the whole journey; Word drew and ran, then failed on a race in the test. Test fixed in 0b45af688, run pending |
| Layout service on the ingest host | Up, on UAT only; production has no GitHub environment yet | 0b45af688 is the first run with figures going through it |
| `membership.spec.ts`: a real CLOSED frame on a bystander channel | Cause unknown; passed on an earlier run | The journey now records each close's code and reason |
| Shared pages lose AI marking (Q640 B) | Windows | Next on its side |
| New assignment's quiz picker, shared pages | On `main` 24cffdd73 | CI, UAT quality run |
| Page counts and Reading pages off Make a quiz's rows, popovers scrolling inside dialogs, Add dialog retry fix | On `main` c69c01992 (86491c6b4, holds Extraction's 34675e04d) | Windows' UAT run |
| One page gutter, no weekly count on Learning, note Preview over the mounted editor (Q669 A) with one room per embed (Q676 A), Hide file button, whole-row hover on study tables | On `main` c69c01992 | Windows' UAT run, one production measure of a near-limit Preview |
| Quiz's one layout in view, edit, study and assignments (A, S1, Epo 2026-11-06), add button aligned, image links shared in memory (Q678 A), number strip and no header when taking an assignment on a phone (Q679 B) | On `main` (369d457f6) | Done |
| Quiz Undo reverting the answer key too (empty steps of the other document) | On `main` 6159c0f25 (779c114fa) | Done |
| UAT note journey's `quizImageOnPick` (note.spec.ts:167): Back from a block's editor lost its toolbar to the dialog's focus trap, near-constant after the quiz layout | `claude/quiz-image-back` 43b17c1ea, 8 of 8 mock repro runs pass | Windows' merge, UAT run |
| Pen strokes keep their first points and leave no dot when they close near the start (Epo 2026-11-07; BlockSuite local change 25 in `framework/std` pointer.ts, so every drag handler sees the replayed early moves) | On `main` 33ae38a79 (7d3d4d627); drawing-board and drawing-answer specs 25/25 on the PC | Done: UAT green |
| A saved board with a connector or group couldn't reopen (`checkSavedBoard` wanted a stored place, which BlockSuite never stores for either) | `claude/board-connector-load` 236859139, from main e37508bb8; drawing-board spec 17 passed | Windows' merge |
| bench:canvas (Q686 A): gated blank open at 1x, typical board's open, typing, pen, pan and zoom at 4x; warm opens, large board and bytes report-only | On `main` b4a2307d2, calibrated (runs 42252998330, 42253016137, 42253034659): budgets blank 1050, typical open 3800, pan 60, pen 45, typing 30, zoom 100 ms | Done |
| To do page: To do and Done tabs, Sort and Filter, nav dot, paged GET /api/todo/done, `todo` and `assignment_updated` events, No late countdown; account chat keeps the app sidebar; Back floats on narrow boards, `pnpm typecheck:board`, plane/chart selection box, Shift-click, group moves, middle-button pan, BlockSuite toasts in the app toast, dark-theme board, N2 tight note cards, slash menu in board notes, Graphs/Charts/Formulas slots and a polar plane card | On `main` 0a7234dee via the board train (`claude/board-ui-refinements` 5fd14d426 inside `claude/file-submissions`) | Done: UAT deployed at 7d09ff117. Not seen on screen since: BlockSuite toasts in the app toast |
| File submissions (Epo 2026-11-08/09): Allow submission with uploads on Marked and Unmarked assignments, page answers marked by AI, Unmarked hand-ins (C2, S3, T2), Files › Submissions; Study → Members (`claude/study-members` 8288239df). Plan `todo-file-submissions.md`; Windows' fix rounds: marking under Show grades Manual, papers left reading, compressed and capped uploads (Q714, Q716), Study → Members Q718–Q723, Hide study progress removed (Q727 A), Read papers again (Q725), Hand in waits for uploads, hand-in storage (Q728 A), damaged PDFs at pick (Q726 A), marking states (Q729), Can't read file (Q730); migrations 0159–0163 | On `main` 0a7234dee (landing head `claude/board-spec-fixes` edaf8ca67 merged on the PC as `claude/land-board-subs`) | UAT deployed at 7d09ff117; the UAT quality `critical_paths (app)` cleanup saw a Sentry event, Windows looking. Not verified by us: a real `/paper` run on real scans and real hand-in uploads on UAT. The frozen branches (`claude/board-spec-fixes`, `claude/file-submissions`, `claude/board-ui-refinements`, `claude/study-members`) are landed and can be deleted |
| Workspace canvas on the board (canvas-enrich): Misc panel with quiz, flashcards and New tiles, board catalog, card body event handling, snapshot refresh, review-6 fixes; migration 0164_canvas_materials (renumbered past main's 0163) | `claude/board-next` 9de756c75, pushed 2026-11-09, merges main 7d09ff117 cleanly; 9de756c75 is test-only (fillStorageToLimit helper fixes TestPracticeDrawingCheckOverStorageCallsNoModel's package-order failure); store, materialdoc and httpapi Go packages green on the Mac harness | Epo 2026-11-09 "Yes, hand over": Windows lands it once CI is green; CI 42626892204 on 9de756c75 failed in three jobs (notes catalog test: canvas keys missing from `limits::OWN_KEYS`, required-element order, no canvas fixture; `embedCatalog.test.ts` expecting Plate to hold canvas_board; drawing-board.spec.ts:1180 workspace canvas plane on reload), Windows fixing on `claude/land-board` (main + base-image refresh + the merge), branch frozen, no parallel fixes; Windows (back as "Rust harness optimizations and security review") has the SHA and lands it when green: CI → deploy UAT → deploy ingest UAT → quality critical paths (migration 0164 and a collaboration-rs catalog change). Open: images on canvas (`todo-board-images.md`), Files/Trash rows and preview card for the canvas material, KLIPY key on UAT and production, a long flashcard front overruns its tile |
| Vendored BlockSuite, dev routes only | On `main` c69c01992 | Done |
| Bench reports main already links to (copy-first, figure boxes, layout models and capacity, DeepSeek grading, Office room memory), and the layout service's capacity settings (`cpu_shares: 128`, spinning off) | On `main` (9b95291a0); past-paper fixtures and run records stay on the bench branches | The layout project on the ingest host is rebuilt by hand (runbook 7.6) |

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
- [x] Fix what the try found (`claude/drawing-answers`, local): the `ZodError` on every partial edit (a zod 4 port slip), zoom at the bottom right and none on phones, the sheet filling a phone's width, the note menu's image, link and file buttons off, undo and redo in the toolbar, note cards drawn onto the sheet in the image
- [ ] Note card text comes out slightly clipped in the image (html2canvas); readable, revisit with tuning
- [x] Bring `vendor/blocksuite` to `main` in a lazy chunk (Epo, 2026-11-06: "sure"): on `main` c69c01992, dev routes only until the answer flow opens it
- [ ] Answer track (type, board in the attempt, saving, marking, results) in session `drawing-answers`, from 2026-11-06. Pushed 2026-11-07 at b37678ede (CI fixes after 9c8919750) (main c02dff757 and canvas-enrich 83150e8f0 merged in; migrations 0156–0158): M4 (slot requires vision), drawn sample answers, account-scoped device drafts, emptied board deletes its drawing. Not verified: Go DB tests and 0158 on a real DB (CI), a live model call with a drawing or sample image, an e2e spec. W1 built (Done asks Keep drawing / Done anyway past a 2,000-unit span; a time limit never asks). The dashed "Answer area" (W3/W4) shows on answer and sample-answer boards. Open: orphaned drawings
- [ ] `drawing` answer type with its background (blank, squared grid, axes, figure) in the shared question format: Go, Rust, TypeScript, pipeline
- [ ] The board: full screen, question pinned at top left, Done returning to a preview and "Edit drawing", phones
- [ ] Saving: strokes kept, an image rendered for marking, charged to whoever pays for the work: the workspace owner for assignments, the member for their own practice, deleted with the attempt (Epo, 2026-11-06). First trace whether a saved answer's flavours reach minimatch in `schema.ts`
- [ ] Marking by a vision model against the marking points, with the same approval and credits rules. Needs grading landed, and the prompt shown to Epo first
- [ ] Results, the approve tab and the report show the drawing
- [ ] Specs, wiki, test catalog
- [ ] Board open speed: Epo picked 4, 6 and 7 (2026-11-07), not 5. On `main` a33c204f6 (afb52c082, Windows' fix round 6bcad8fb0: opacity-0 plus inert hiding, the hidden mount in idle time, the draft written on Done and teardown, a retry on Draw, fitView on Draw; board chunk 667 KB gzipped); UAT green at a33c204f6. On main, at 4x: Draw to drawable 8 ms blank, 19 ms typical; the hidden mount's longest task 193–358 ms cold, 53–131 ms warm (Mac). No split (Epo 2026-11-07: "just put this into a perf gate or sth, the time delay is pretty small now its fine"): `claude/board-mount-gate` 3249ce018 (from main 805e3c1f1) gates the cold hidden mount's longest frame and Draw at 4x on the typical board, provisional budgets 1500 and 90 ms (Mac 381 and 23 ms ×3); on `main`, calibrated at aa377c470 from runs 42375517156, 42375520111, 42375523741: runner medians 728 and 61 ms, budgets 950 and 80 ms. Done. From the canvas-open report's fixes 4–7 (capy-harness `2026-11-06-office-track/canvas-open/REPORT-SUMMARY.md`; Windows 2026-11-07: Mac work, not started, needs Epo). Gate: bench:canvas. Then: 1,161 KB gzipped lazy, blank 630 ms / 2.4 s at 4x, typical 840 ms / 3.8 s, parse and evaluate 33–40%:
  - 4. Prefetch the board when a drawing question comes near
  - 5. Paint the stored marking image first, then swap in the live board
  - 6. Cut unused vendored BlockSuite packages (data-view about 155 KB gzipped)
  - 7. Ship only the board's icons (about 137 KB gzipped); a stub prototype cut 34% of bytes and 15–20% of cold open, needs vendored changes
- [ ] Enrich the board (Epo, 2026-11-06: "a lot more enrichments" to come), in session `canvas-enrich`, mocks first: remake the shape chooser button (pure yellow is odd), move undo and redo beside the zoom buttons, and find how graphs, formulas, charts and coordinate planes can go on the canvas more easily

### 2. Note look: copy Notion's styles

Started 2026-11-09 in session `notes-look` (Epo: notes follow Notion's style, and the canvas is unified with it, e.g. floating toolbars), mocks first: round 1 at https://claude.ai/artifact/GDgyxY9JYW73KGmdU6bCVP (S1/S2 toolbar surface, T1/T2 tables, H1/H2 block handle, M1/M2 slash menu, N1/N2 where the look lives, E1–E3 editor questions), Epo's picks pending. Base: `blocksuite-notes` from f5bb8f37e (main 7d09ff117 merged in).

Epo's words: "note themeing/styling, e.g. copy notion styles so i think we dont have those
floating toolbars on e.g. tables and stuff, and affine has a table view as well."

- [ ] Compare how Notion and AFFiNE handle tables, with mocks first
- [ ] Decide which editor it goes on. Plate is nearly frozen and goes at the cut, and new note features were to go on BlockSuite only (`todo-blocksuite-spike.md`)
- [ ] Table View: AFFiNE's `database` and `table` blocks are vendored; the blocks layout refuses `database` today
- [ ] Revisit D12 (BlockSuite's own widgets, restyled) and the shared floating toolbar decision (PE:24)

## Queued, no order yet

- **Workspace canvas** (`todo-canvas-workspace.md`): on hold since 2026-11-02. Was next after the study rework; ask Epo where it goes once drawing answers are in, since it reuses the same edgeless editor.
- **The Plate cut to BlockSuite** (`todo-blocksuite-spike.md`): step 1 done on `blocksuite-notes`; `main` 7d09ff117 merged into it 2026-11-09 (f5bb8f37e, Epo "sure merge": one base holding the BlockSuite note editor and the board; vendored tree is main's, our vanilla-extract plugin dropped like main's, `/dev/blocksuite` and a mock note in the blocks layout checked in the browser, Rust test build and e2e left to CI) so notes-look builds on it. Comes with 2 or the canvas, not decided.
- **Scanned submissions** (`todo-study-tracking.md`, "Later"): needs its own design round.
- **Study leftovers** (`todo-study-tracking.md` §11 "Can wait"): AI insights, the app-wide Learning page redesign, "Copy to my workspace", sharing practice with the class, gamification.
- **Handed over by Windows, not started** (`todo-study-tracking.md`, "Where it stands"): a question with no answers through `insert_child`; dotted question ids in `quiz.rs`; locks in `source_imports.go`; the `StartAssignment` expired-attempt lock; `DeleteAssignment` returning 404; a whole run's figure cap; sweep starvation.
- **Drag-and-drop copies** (`auto-scroll` and `hitbox` on 2.0.2 beside the vendored 1.4.0): matters at the notes cut.
- **Remake a quiz from another one** (Epo, 2026-11-08): write a new quiz based on an existing one, in place of Members' "Draft a follow-up quiz", which was removed from the member profile on `claude/study-members` ("its not that useful, teacher can see which topic the user is weaker anyway, and make a quiz on those topics").
- **Results page and answers:** results hide answers after an assignment closes while Practice shows them. Optional, Epo hasn't decided.

## Older plan files

`todo-standalone-files.md`, `todo-clone-download.md`, `todo-account-chat.md`, `todo-ghost-text.md`,
`todo-presence.md` and `todo-note-media.md` have landed on `main`, or look that way from its commits.
Their status lines are from October and weren't updated, so don't read them as open work.

## Left out

- **Landing site** (`landing-site` worktree, uncommitted): Epo isn't using it for now (2026-11-06). Don't push or remove it without asking.
