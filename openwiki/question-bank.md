# Question bank

The bank is a separate syllabus and question database. Signed-in learners read
question content; granted bank editors can edit, mark reviewed, upload figures
and send a comment. The bank page is unlisted at `/bank`, inside the app shell:
the main panel shows the chosen topic's questions, and a dashboard-style right column holds exams and topics, swapping
to the topic's question list; on phones that column becomes a floating bar and
bottom sheet. Editors switch between View mode and Edit mode; edit mode adds
the answer key and a review bar (review status, Mark reviewed/Undo review,
Comment, Edit) under each question. Studying directly from the bank and
production Jev grading remain in `todo-question-bank.md`.

The topic list (`GET /api/bank/topics/{id}/questions`) returns light rows for
the navigation panel. Full questions come from `GET /api/bank/questions?ids=`,
up to 50 per request in the requested order; an unknown id fails the whole
batch with 404, so the page refetches the list. The page renders a window of
the list that grows 10 questions at a time when its end comes within 800px of
the view. A list click on a question outside the window restarts the window at
that question's page plus the next (one request) and scrolls the panel so the
question sits at the top; a page next to the window extends it instead.
Earlier pages come back through a "Show questions x–y" button that fetches
first, then inserts them and moves the scroll position by the added height.
Content never loads above the viewport on its own because Safari has no CSS
scroll anchoring. Each loaded question lives in its own query-cache entry,
which edits and reviews update in place.

## Shared question format

`src/features/questions/types.ts` defines stem blocks and ordered parts. Each
part has a stable ID, blocks, one of seven answer types, plain marking items and
worked-solution blocks. Its marks equal the number of marking items. A matching
answer stores the full choice pool independently from its correct pairings, so
unused and reused options survive generation, editing and rendering.

The Go validator is `server/internal/questions`; the browser and collaboration
service share its JSON fixtures. Bounds originate in
`server/internal/fieldlimits` and are generated for TypeScript and Python by
`pnpm gen:openapi`. Bank parts require worked solutions; user quiz solutions
are optional. Levels are optional metadata and the unenforced timer was removed.

Quiz materials remain Plate/Yjs documents. A void `quiz_question` node stores
the question as an attribute, with the same ID and one empty text leaf. Part
IDs are unique within the material. Note chart/graph voids store their validated
block under `block`; their Markdown fences round-trip that JSON. Old question
nodes and old question JSON are rejected, without a compatibility converter.

## Editing and assets

The quiz edit page uses Settings' tabs, header padding and content padding.
Questions holds the question editor; General holds the quiz name. Both share
the draft and Save action, styled as the Account tab's right-aligned accent
button; an invalid name returns to General so its error is visible.
The tab body contains positioned descendants within its scroll area so the
outer page and header stay in place while scrolling through long quizzes.

`QuestionDialog` is shared by the bank and quiz edit page. It reuses
`ToolbarGroup`, `ToolbarButton` and `SimpleDialog`; block editors replace the
dialog body and keep Remove beside Save. English and Chinese labels use
Paraglide. MathLive renders formulas in both viewing and editing, including
question-editing previews. Read-only previews use the shared `MathPreview`
component with matching fonts/layout and no keyboard or menu controls. `BlockToolbar`
is shared by question blocks, note embeds, tables and columns.

Charts reuse the SVG renderer extracted from ChatChart. Graphs store a bounded
JSXGraph recipe and a static rendering. User quizzes and notes keep validated
SVG, at most 256 KiB, in their document. Bank graphs store the recipe in the
database and the SVG in the public bucket; bank images likewise use public
content-hashed URLs. Image blocks are currently bank-only.

`POST /api/bank/assets` checks the editor grant, validates the bytes and uses
server environment credentials. The local publisher has the same validation.
`BANK_ASSETS_URL` is the allowed public base URL for stored bank asset references;
it does not restrict uploads to one developer machine. Credentials stay on the
server or publisher. Existing private workspace editor assets are separate.

## Revisions and grading

Every authored quiz/flashcard form write carries `expectedRevision` from the
loaded draft. The collaboration service compares it under the material lock,
including pending projection state and the current live block. A rejected write
keeps the draft. Opening an embedded material to view or edit fetches fresh
content; merely opening its parent note does not fetch every embedded body.

Bank saves use the exact `updatedAt` string as their optimistic token. A 409
keeps the draft and offers an explicit discard-and-reload action. Content edits
retain the separate reviewed marker. The API's reviewed toggle does not lock
the question or add an approval workflow.

Quantity answers prescribe a unit. The runner shows that unit separately and
accepts values only. Decimal, scientific and rational values compare exactly;
neither fuzzy matching nor the grading model converts units. Numeric signs and
operators are preserved. Generation instructions reserve open answers for
non-computational questions.

The existing backend grading slot still gives an open part one 0/0.5/1 decision,
scaled by its marking-item count. Its text request preserves stem, earlier-part,
current-part, figure-description, table and chart context. Jev integration,
per-item decisions and the review computation classifier are deferred.

Attempts retain graded snapshots. Mistakes strip the attempt-only awards.
Taking, reviewing and every read-only view (quiz preview, quiz editor, bank,
question dialog preview) use `QuestionRunner`; a quiz shows all its questions on
one page (`QuizQuestionList`) with one Submit. Completion and saved attempt pages
share the part review renderer: "You scored" with one green/red square per
question (blank answers are wrong; grey is reserved for a future Skip), marks in
tint-fg colours, the submitted answer, then one collapsed disclosure holding the
marking scheme and worked solution. Closed parts show item awards from their
deterministic result; open parts keep their part award without inventing
per-item scores.

Workspace quiz previews center the question column in the viewer; other quiz
entry points retain left alignment.

Answer areas span the text and marks columns of a part row; phones use 16px
pane padding and a 1.5rem number column. Every answer item is a fully rounded
bordered row keyed by a dotted letter or number (A., 1.); matching items stay
borderless because their shared `Select` carries the border. Selected and result
rows reuse the editor callout variants (tip, success, danger, warning). True /
false and text inputs span the row. After checking, choices tag "Your answer"
and "Correct answer", true/false shows two result rows, a short answer marks its
field and lists every accepted answer with its unit, an open answer shows the
judge's reason after a full/half/no marks lead, matching rows show the chosen
letter and the correct one beside the option list, and wrong ordering rows show
their right position.
Matching dropdowns list letters in stored option order. Ordering starts
shuffled and the shown order is committed as the answer as soon as it renders.
The static view numbers matching items above the lettered options on phones and
beside them from md.
Review batches respect the existing 200-question and 2 MiB bounds, namespace
their part IDs without changing stored source IDs, and remove only questions
answered correctly in that batch. Unattempted mistakes remain.

## Bank and publication

`server/internal/bank` owns lazy reader, editor and library pools, each with two
connections and bounded statement time. Missing bank configuration does not
stop unrelated app features. The app database only stores `bank_editors` grants;
the bank has its own migrations and roles. See
[deployment-runbook.md](deployment-runbook.md) for provisioning, environment
values, public/private buckets, local tunnel, comment recipient and backups.

Sources identify an excerpt, book and historical version. Both publisher and
reader resolve those references and apply the same provenance bounds and
copyleft-family computation. Publication refuses incompatible sources before
inserting a question.

`lab/questions` is a local staged builder. References stay private; a clean-room
writer, blind solver, judge/fix pass, actual component renderer and copy check
produce frozen publication evidence. Every stage runs as a fresh Claude Code Opus
5.5 medium subagent that owns one topic. IELTS Academic Reading questions are
written on lightly adapted library excerpts (`run.py passage`), one excerpt per
question, and record that excerpt as the question's source; HKDSE questions are
original with empty sources. The renderer serves MathLive's fonts, waits for
every formula, and re-renders only named question ids after a fix. See its
[README](../lab/questions/README.md).
`server/cmd/bank` migrates, publishes and reports status. Publication uploads
immutable assets and inserts new IDs; it does not overwrite later reviewer edits.

## Delivery and checks

The Biology 101 MSW quiz and both note-embedded quizzes share
`src/mocks/biologyQuiz.ts`: 10 questions, 12 parts and 21 marks covering all seven
answer types, fixed-unit quantities, multipart questions, both layouts, formulas,
tables, an editable graph and all six chart styles. Every part has a worked
solution. The graph SVG is rendered from its stored JSXGraph recipe. The seeded
`at_1` attempt includes correct, incorrect, blank and partially credited answers
for inspecting review states. Image examples are deferred.

The separate bank database and B2 buckets are provisioned; the public asset
hostname is configured in Cloudflare. The pilot covers all 18 HKDSE Mathematics
Compulsory units (50 questions each) and all 11 IELTS Academic Reading task types
(18 passage-based questions each, 4-7 items per passage). Every published
question passed blind solving from its learner render with exact comparison,
open-answer judging, full review-render inspection (passage fidelity for IELTS),
Go validation and the 12-word copy check; repairs were re-rendered, re-solved
and rechecked. The 50 short generated-passage IELTS multiple-choice questions of
the first round were deleted and replaced by the library-passage set. See the
[handoff](../question-bank-handoff.md) for exact state. Cloudflare serves a
published graph with HTTP 200, immutable cache headers and a cache hit.
Coordinate the old-quiz data cutover before application rollout.
Do not deploy the new readers over old question records without that cutover.

The [test catalog](test-catalog.md#question-bank-and-shared-question-format)
lists contract parity, revision rejection, bank grants/assets/review, exact
quantity grading, rich grading context, publication and offline builder checks.
The local browser check covers phone-width navigation, MathLive, the shared
dialog footer, saving and retaining review, standalone quiz creation, embedded
quiz editing and explicit note-chart saves. The frontend suite, collaboration
suite, focused Go checks, typecheck and production build passed locally.
An empty-bank backup was uploaded, downloaded, hash-checked and restored on
2026-09-27. Content backups restored the first 50 questions and the final handoff
checkpoint of 200 questions, with matching table counts and complete-row
fingerprints. The real reader role passed syllabus,
list and detail SQL checks with no write privileges. A local actual-handler check
also read the live bank successfully and verified that learner responses hide
answers, marking schemes and solutions. These do not replace deployed API
verification. Email
delivery, the CI editor performance gate and the remaining pilot admission remain
to verify. The final responsive recheck covers the approved desktop and phone
layouts, dedicated quiz edit routing and MathLive touch/physical entry; a focused
browser regression test verifies formula input survives commit and reopening.
