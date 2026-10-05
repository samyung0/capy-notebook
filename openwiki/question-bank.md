# Question bank

The bank is a separate syllabus and question database. Signed-in learners read
question content; granted bank editors can edit, mark reviewed, upload figures
and send a comment. The bank page is unlisted at `/bank`, inside the app shell:
the main panel shows the chosen topic's questions, and a dashboard-style right column holds exams and topics, swapping
to the topic's question list; on phones that column becomes a floating bar and
bottom sheet. Editors switch between View mode and Edit mode; edit mode adds
the answer key and a review bar (review status, Mark reviewed/Undo review,
Comment, Edit) under each question. In View mode signed-in learners answer and
check each question (Learner answering, below); mistake review screens and
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
part has a stable ID, blocks, one of eight answer types, whole `marks` (1–20)
and worked-solution blocks. Only open parts carry a marking scheme: items of
text and whole marks that add up to the part's marks, because Jev grades against
them. A closed part's answer is its own key and its solution explains it, so it
has none; the editor sets a closed part's marks from a dropdown and an open
part's from its items. Authored parts are told from learner parts by their
worked solution (`isAuthoredPart`). A matching
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
JSXGraph recipe and a static rendering. Recipe elements are function graphs,
points, lines, segments, circles, labels, angles (three points with the vertex
in the middle, drawn under 180° with a square mark at 90°), arcs and sectors
(counterclockwise from the first point around a centre) and polygons (3–12
points); sectors and polygons can be shaded. A segment's `ticks` (1–3) draws
JSXGraph hatch marks, so equal sides carry the same count. Question charts sit
at about a graph's width with a centred title and never show a values table. User quizzes and notes keep validated
SVG, at most 256 KiB, in their document. Bank graphs store the recipe in the
database and the SVG in the public bucket. Image and graph blocks both keep
their source under `image`: bank images use `{ url }`, a public content-hashed
URL, and quiz images use `{ assetId }`, a private workspace editor asset
(see [backend-storage-quota.md](backend-storage-quota.md)). Quiz images are
resolved to signed URLs at render and export time and follow editor-asset
cloning: a clone copies the asset rows, rewrites the ids, drops images whose
asset was not copied, and drops a question whose part loses all content. Uploads
go through the quiz's material route: a workspace quiz's images belong to its
workspace (workspace owner pays), a standalone quiz's to the quiz (its owner
pays). A question the chat copied from the bank (`copy_questions`) keeps its
bank `{ url }` figures in the quiz: they are immutable, so the quiz links to
them rather than copying them, and the Go validator accepts a quiz image or
graph URL only under `BANK_ASSETS_URL` (`questions.QuizBankAssetsURL`). Each
copied question's sources become a credit in the quiz's provenance under the
question id, shown under that question rather than in a footer (see
[agentic-retrieval.md](agentic-retrieval.md), Question bank). Answer
options stay plain strings; no images or rich content go inside them.

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

Quiz open parts are graded by Jev, one request per part, with the contract
benchmarked in
[2026-10-02-jev-production-contract.md](../bench/grading/reports/2026-10-02-jev-production-contract.md):
each marking item earns none, half or all of its marks from a zero/partial/full
`choice` (the server scales Jev's 0, 0.5 or 1 by the item's marks), and an
answer that is only a list of subject vocabulary earns 0 on every item. The
part's award is the sum and the snapshot keeps `itemAwards`. The grading text
is built in Go (`questions.GradingText`) from the stem, earlier parts and the
part, with figures as their descriptions, tables and chart data. The browser
sends part ids and answers for one attempt; the server loads the scheme, so the
endpoints cannot grade arbitrary text. Saving an open part in the quiz editor
asks Jev whether grading it needs a calculation checked and warns the author
at a probability of 0.3 or more; the save is never blocked. Usage and the
anonymous caps are in [observability-metering.md](observability-metering.md).

User quizzes (not the bank) are bounded so one attempt fits one grading
request: at most 100 parts per quiz, 7 per question, 5 marking items per part
and 20 open parts per quiz, and sample answers of at most 5,000 characters;
learners' open answers have the same 5,000-character cap. The Go, browser and
collaboration validators share these bounds (`fieldlimits.Quiz*`), and the
generation prompt and agent tool descriptions state them.

Attempts retain graded snapshots. Mistakes strip the attempt-only awards.
Taking, reviewing and every read-only view (quiz preview, quiz editor, bank,
question dialog preview) use `QuestionRunner`; a quiz shows all its questions on
one page (`QuizQuestionList`) with one Submit. Completion and saved attempt pages
share the part review renderer: "You scored" with one green/red square per
question (blank answers are wrong; grey is reserved for a future Skip), marks in
tint-fg colours, the submitted answer, then one collapsed disclosure holding the
worked solution, and for open parts the marking scheme with Jev's marks beside
each item. Matching pairs and `gaps` score item by item: each right item earns its
share of the part's marks, rounded down to a half mark; other closed parts are
all or nothing. A `gaps` part writes numbered blanks, (1) ______, in its text, 1 to n in order
(all three validators check this), and keeps one accepted list per blank, which
may be several words. A blank is right only when it equals an accepted answer,
ignoring case and spacing; unlike short answers there is no typo tolerance. `QuestionRunner` renders each blank as a small field inside
the sentence, green or red on review with the accepted answers after a wrong one. It is authored only, so in-app generation does not offer it. A question with one part shows its
marks once, in the header. Multiple-choice options sit two by two (A B / C D)
when a paper-layout answer area is at least 36rem wide (a container query);
split-layout questions keep one column beside their passage.

Workspace quiz previews center the question column in the viewer; other quiz
entry points retain left alignment.

Answer areas span the text and marks columns of a part row; phones use 16px
pane padding and a 1.5rem number column. Every answer item is a fully rounded
bordered row keyed by a dotted letter or number (A., 1.); matching items stay
borderless because their shared `Select` carries the border. Selected and result
rows reuse the editor callout variants (tip, success, danger, warning). True /
false and text inputs span the row. After checking, choices tag "Your answer"
and "Correct answer", true/false shows two result rows, a short answer marks its
field and lists every accepted answer with its unit, matching rows show the chosen
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
stop unrelated app features. The app database only stores `bank_editors` grants
and learners' progress (below); the bank has its own migrations and roles. See
[deployment-runbook.md](deployment-runbook.md) for provisioning, environment
values, public/private buckets, local tunnel, comment recipient and backups.

Each source has a `kind`. A `library` source names an excerpt, book and
historical version, resolved through the library database. A `web` source
records an openly licensed page as it read on its retrieval date: URL, title,
authors, publisher, licence and licence URL. Its licence must allow adapted
commercial reuse, so ND and NC are refused. Both publisher and reader apply the
same provenance bounds and copyleft-family computation, and the attribution
footer credits web pages beside books. Publication refuses incompatible
sources before inserting a question. Web credits come only from the bank:
internal material tools reject provenance that names web pages.

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
It also stores each question's task types in `questions.question_types`, ids
from the subject's `question_types` vocabulary in its syllabus file (IELTS
Academic Reading's eleven official types; empty for subjects without one). The
chat agent's `list_question_bank` can keep a topic's questions of one type
(`question_type`, see [agentic-retrieval.md](agentic-retrieval.md), Question
bank).

## Learner progress and retraction

Signed-in learners' checked answers on `/bank` are rated with workspace
review's FSRS code and score mapping
([study-progress.md](study-progress.md#fsrs)): the browser sends the answer's
awarded marks over the question's marks, below 0.5 is Again, below 0.7 Hard,
otherwise Good. The page records answers (Learner answering, below); the
mistake review screen waits for its mock.

App migration `0055_bank_review_states.sql` keeps one row per user and bank
question: `question_id` and a copied `topic_id` are plain ids into the bank
database (no foreign key), `item_hash` is `review.QuestionHash` of the question
when it was answered, then `review_states`' FSRS columns and `last_score`.
There is no review log. Rows are never copied or charged to storage.

| Endpoint | Effect |
| --- | --- |
| `POST /api/bank/questions/{id}/reveal` | `{answers}`, the learner's answers by part id. Returns `{question}`, that one question in full (answer key, marking schemes, worked solutions); 404 when unknown or retracted. The answers are not stored or graded on the server. |
| `POST /api/bank/questions/{id}/answers` | `{score}`, 0 to 1. Reads the question from the bank (404 when unknown or retracted), then rates it under a per-user, per-question advisory lock and stores its topic, hash and score; 204. A stored hash that no longer matches is rated as a new question. |
| `GET /api/bank/topics/{topicId}/marks` | `{marks: {questionId: boolean}}` for the topic list: each answered current question, true when the last answer earned full marks (the quiz page's green). |
| `GET /api/bank/topics/{topicId}/review` | `{questionIds}`: the topic's mistake review batch, up to 20 current questions missed at least once (`lapses > 0`), lowest retrievability first. The page reads them through `GET /api/bank/questions?ids=`; asking again after the answers land gives the next batch. |

A current question is one that is not retracted and whose stored hash equals
its hash now; `bank.TopicHashes` reads the topic's questions once per request.
Editing a stem or part prompt therefore hides the question's mark and takes it
out of review until it is answered again; edits to answers, schemes, solutions
and figures keep both. The routes need the page's read access (signed in, bank
configured), so signed-out visitors get 401 and record nothing; frozen accounts
record (`requireAccountMutate`). Account purge deletes the rows. The MSW bank
mock (`src/mocks/questionBank.ts`) serves all of them, ordering review by the
oldest answer.

Published questions are retracted, never deleted, so progress ids stay valid.
Bank migration `0003_retracted.sql` adds `questions.retracted_at`, which only
the owner sets (see [deployment-runbook.md](deployment-runbook.md)); the editor
role has no grant on it. Syllabus counts, the topic list, single and batch
reads (a retracted id fails a batch with 404 like an unknown one), comments,
answers, reveal, marks, review and the chat's list, read and `copy_questions` routes
all skip retracted questions. Editors' save and review routes do not check the
flag; the page never lists those questions. UAT and production share the bank:
run `go run ./cmd/bank migrate` before deploying code that reads the column,
and code older than this change still shows retracted questions.

### Learner answering

View mode renders every question as `QuestionRunner` with the learner's answers
and a Check answer button under it, right-aligned on a divider like the editors'
review bar (`CheckableQuestion` in `src/routes/QuestionBank.tsx`). Reads stay
answer-free (`questions.LearnerView`); Check answer posts the answers to the
reveal route and gets that question's key only. The learner view shuffles
matching options and ordering items, so `alignReveal` (`src/features/questions/bank.ts`)
reorders the revealed matching options to the letters the learner saw (its
pairs follow) and maps ordering answers to stored positions. The question then
shows the quiz review (`QuestionReview`: part score in the marks column with no
question total, the answer rows tagged Your answer and Correct answer, accepted
answers, the worked solution collapsed). `bankScore` sums `scorePart` over the
parts and divides by their marks; the browser posts that 0–1 score to the
answers route and refreshes the topic's marks. A question with open parts
(none in the bank today) shows its key but records no score, because only Jev
grades open answers. Try again clears the answers and the key; the next check
records a new attempt, and the list shows the latest. Edit mode keeps the
answer key, review bar and disabled runner. Both requests fail through the
global mutation toast: a failed reveal keeps the answers for another check, and
a failed record still shows the review but leaves the list unchanged.

The topic list uses the shared `QuestionListRow`
(`src/features/questions/QuestionListRow.tsx`): bold number, two-line stem,
then a muted line with the marks, figure and table icons. In View mode a result
mark leads each row (a filled check when the last answer earned full marks, a
filled cross otherwise, an empty circle when unanswered), and one line under
the topic heading reads "N correct · M to retry", both from the marks route.
Edit mode shows no marks; its rows keep the reviewed label on the muted line.

## Delivery and checks

The Biology 101 MSW quiz and both note-embedded quizzes share
`src/mocks/biologyQuiz.ts`: 11 questions, 13 parts and 26 marks covering all eight
answer types, fixed-unit quantities, multipart questions, both layouts, formulas,
tables, an editable graph and all six chart styles. Every part has a worked
solution. The graph SVG is rendered from its stored JSXGraph recipe. The seeded
`at_1` attempt includes correct, incorrect, blank and partially credited answers
for inspecting review states. Image examples are deferred.

The separate bank database and B2 buckets are provisioned; the public asset
hostname is configured in Cloudflare, which serves a published graph with HTTP
200, immutable cache headers and a cache hit. The live bank holds the round-2
batch: 32 questions across three HKDSE units and two IELTS subject areas. Every
published question passed blind solving from its learner render with exact
comparison, full review-render inspection (passage fidelity and readability for
IELTS), Go validation and the 12-word copy check; repairs were re-rendered,
re-solved and rechecked. Current state, local run data and next steps are in
[todo-question-bank.md](../todo-question-bank.md).

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
delivery and the CI editor performance gate remain to verify. The final responsive recheck covers the approved desktop and phone
layouts, dedicated quiz edit routing and MathLive touch/physical entry; a focused
browser regression test verifies formula input survives commit and reopening.
