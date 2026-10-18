# Question bank

The bank is a separate syllabus and question database. Signed-in learners read
question content; granted bank editors can edit, mark reviewed, upload figures
and send a comment. The bank page is at `/qb`, under Explore in the
sidebar, inside the app shell: the main panel shows the chosen topic's
questions, and a right column (`PanelHeader`, shared with the theme
drawer) holds exams and topics (Exam switcher and
covers, below), swapping to the topic's question list. Below `lg` that column
becomes a bottom sheet opened from `PageFloatingBar`
(`src/components/ui/PageFloatingBar.tsx`):
Topics on every /qb page, Questions once a topic is open. Its labels stay
visible, small under the icons on phones and beside them from `sm`. Editors switch between View mode and Edit mode; edit mode adds
the answer key and a review bar (review status, Mark reviewed/Undo review,
Comment, Edit) under each question. In View mode signed-in learners answer and
check each question (Learner answering, below) and copy questions into their
quizzes; production Jev grading remains in `todo-question-bank.md`.

## Exam switcher and covers

The topics view (`TopicTree` in `src/routes/QuestionBank.tsx`) opens on
every exam as a cover strip (`ExamStrip` in
`src/features/questions/ExamPicker.tsx`): the name, the exam's description
wrapped to at most two lines and its topic count, over a dark fade from the
bottom-left corner (a darker one on light covers). Picking one sets
`/qb?exam=<id>` and shows that exam: `ExamPicker` draws it as a taller strip
with subject and question counts and opens a list of every exam (the same
strips) with a Find an exam search. A topic URL opens its own exam unless
`exam` names another, and a back arrow returns to the list, also while a topic
is open. Subjects start collapsed except the one holding the current topic; a
collapsed subject shows its question count, and an open one indents its topics
under a guide line. Levels with one entry are hidden (`soleSubject`,
`soleTopic` and `topicPath` in `src/features/questions/bank.ts`): an exam with
one subject lists its topics without a subject header, and an exam with one
subject and one topic (a single paper, like a driving test) has no tree:
picking it opens `/qb/<topicId>` titled with the exam's name, its strip counts
questions instead of topics, search lists only the exam, and its open topic's
panel shows the exam list. Page trails, search hits and the landing's progress
rows drop the hidden labels too. Above a topic's title the trail's segments
link to the bank and to the exam (the subject opens its exam too), and the back
arrow goes to the nearest one. The header search (`searchSyllabus` in
`src/features/questions/bankSearch.ts`) lists hits in three sections, Exams,
Subjects and Topics, each matched by its own name and ranked best first: the
name exactly, at its start, at a later word's start, anywhere (an exam's full
name or description counts from the word-start rank); ties keep syllabus order.
Hidden levels are not hits. With an exam open, that exam is left out of Exams
and its subjects and topics come first in their sections; a subject hit opens
its exam with the subject expanded. Exam hits are plain rows, and so is the
exam switcher's list (name and count, no description). It
filters the syllabus already loaded, so it sends no request.

The syllabus gives each exam `fullLabel`, a 12 to 15 word `description` (bank
migration 0006) and `cover`: a style (`symbols`,
`doodles`, `shelf`, `paper`, `type`, `geo`, `hero`), a `#rrggbb` colour, and the
style's own fields: `kind` (`math`, `latin`, `kana`) for symbols, doodles and
paper, `pattern` for geo (a GeoPattern generator) and hero (one of 18 Hero
Patterns), and an optional handwritten `line` for paper. A paper cover's colour is the paper (`cover.PaperPalette`: cream, white, grey, yellow; lines and ink are fixed), so its catalog colour must be one of those. `bank.Cover.Check`
accepts only those fields. The browser draws the strip from the config, seeded
by the exam id (`src/lib/coverArt.ts`), so nothing is stored in
a bucket; the pattern lists in Go and TypeScript must match. The config is
`server/internal/cover`, shared with workspace card covers
(`workspaces.cover`, app migration 0068: NULL by default, set in Workspace
settings with a `seed` that Shuffle changes, cleared with `clearCover`, copied
by clone). Covers are fixed
art in every theme, so their text colours are fixed too: dark on the light
bookshelf and paper styles, white elsewhere, with a bottom shade on busy art.
Subjects have no covers of their own. Official exam board logos are not used
(trademarks; Epo, 2026-10-08). Hero Patterns (CC BY 4.0) and GeoPattern (MIT)
are credited on the Credits page.

The topic list (`GET /api/bank/topics/{id}/questions`) returns light rows for
the navigation panel a page at a time, like the file and material lists:
`limit` (default 50, at most 100), an opaque `cursor`, `{items, nextCursor}`,
plus `prevCursor` for paging back and `around=<questionId>` for the page
holding a question when no cursor is given. Filters are `type` and `status`
(comma-separated; `status` is correct, wrong, partial or notDone against the
learner's latest results), `q` (preview text) and `unreviewed`; a bad status
or cursor is 400. Each row's `answerTypes` lists its parts' distinct answer
types in part order (`bank.AnswerTypes`) and the page's `answerTypes` lists the
whole topic's, for the Question type filter. `bank.PageRows`
(`server/internal/bank/page.go`) filters the topic in memory after one `List`
query; cursors carry a question position, not an offset, so a question
answered while the Status filter is on shifts nothing on the next page, and
already loaded pages keep it listed until a filter changes. Topic counts in the
heading and the editor's All/Unreviewed buttons come from the syllabus, not
the loaded pages.
One infinite query feeds both panels and loads at either end: the side list
asks for the next page as its end comes into view and the previous page as
its top does; a filter change or a question outside the loaded pages reopens
the list `around` that question. Concurrent page calls from the two panels
join the request in flight (`cancelRefetch: false`).
Full questions come from `GET /api/bank/questions?ids=`, up to 50 per request
in the requested order; an unknown id fails the whole
batch with 404, so the page refetches the list. The page renders a window of
the loaded rows that grows 10 questions at a time when its end comes within
800px of the view, loading the list's next page when it runs out. A list click
on a question outside the window restarts the window at that question's page
plus the next (one request) and scrolls the panel so the question sits at the
top, with the editor TOC's motion
(`src/lib/scrollIntoViewWithMotion.ts`, which sets the position each frame so
content loading above cannot cancel it the way it cancelled a native smooth
scroll); a page next to the window extends it instead.
Earlier questions load the same way as the window's start comes within 800px
(the list's previous page first, when the window starts at the loaded rows),
with a skeleton above while any remain. Each loaded question lives in its own
query-cache entry, which edits and reviews update in place.

Content added above the view goes through `src/lib/scrollAnchor.ts`, in both
panels (the side list holds back rows its query loads above until then).
`holdPosition` turns the scroller's native anchoring off, lets the change in
and moves the scroll position by however far the first shown question moved
within the content (not on screen, so scrolling while React renders the
change is kept):
Chrome does not anchor at scrollTop 0 and Safari before 27 has no
anchoring. `scrollSettled` makes the insert wait until no finger is down and
nothing has scrolled for 150 ms, because iOS Safari cancels a fling, or drops
the write, when script sets scrollTop during a touch scroll, its momentum or
its bounce. Checked on the iOS 18.6 Simulator (2026-10-08): inserting during a
fling showed a frame several screens off, snapped back and stopped the fling;
with the wait, flicks, the top bounce, a held finger and the phone sheet's list
kept their position.

## Shared question format

`src/features/questions/types.ts` defines stem blocks and ordered parts. Each
part has a stable ID, blocks, one of seven answer types, whole `marks` (1–20)
and worked-solution blocks. A multiple-choice part (`mcq`) has one or more
correct options and is answered with checkboxes (multiple answers, `multi`,
merged into it on every layer, Epo 2026-10-15; the learner UI redesign is
Epo's). Only open parts carry a marking scheme: items of
text and whole marks that add up to the part's marks, because Jev grades against
them. An open part takes at most one sample answer (`accepted`, 0 or 1 items),
and it is optional: the editor shows one Sample answer input, and grading never
reads it. A closed part's answer is its own key and its solution explains it, so it
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

The chat agent does not write this format (Epo 2026-10-13). It writes a
multiple-choice question with one correct option, a short answer with an
optional unit, or an open question with marks and a markscheme, and adds a
chart, a plot or a library figure to a question separately; the retrieval
service expands each into one paper-layout question with one part, 1 mark
for a simple one and the explanation as its solution (see
[agentic-retrieval.md](agentic-retrieval.md), Question tools).

Quiz materials remain Plate/Yjs documents. A void `quiz_question` node stores
the question as an attribute, with the same ID and one empty text leaf. Part
IDs are unique within the material. Note chart/plot/graph voids store their validated
block under `block`; their Markdown fences round-trip that JSON. Old question
nodes and old question JSON are rejected, without a compatibility converter.

## Editing and assets

A quiz is edited where it is open, like a flashcard set: the material
page's Edit mode (`CenterContent.tsx`) renders `QuizEditor`, which joins the
quiz's content and keys rooms and edits live (live-items, Epo 2026-10-10; see
[plate-editor.md](frontend/plate-editor.md)): there is no Save or Reset, and
the View switch leaves editing. Files' Edit and New quiz open
`/materials/{id}?mode=edit`; there is no standalone quiz edit page, and
renaming goes through the item's Rename. A note's quiz embed uses the same
editor.

`QuestionDialog` is shared by the bank and the quiz editor. Its outline
column (min 15rem, nudged 4px left to line up with the dialog title) keeps
part rows in a narrow label column, leaves stem rows flush, clamps labels to
two lines and overlays each row's ⋮ on hover over the file panel's faded
backing instead of reserving width. Rows are not highlighted: a click brings
the block or part answer into view in the body with `scrollIntoViewWithMotion`,
the bank and editor TOC's motion, and focuses it. Body blocks and part answers
(`QuestionRunner`'s `frameAnswer`) select on click and show the note editor's
portaled `FloatingBlockToolbar` (Edit, move, duplicate or remove), which never
shifts layout and flips above a block cut off at the bottom; Enter edits. From `md` the dialog is a fixed
88dvh and each column scrolls on its own; phones show sticky Outline and Body
tabs, and a row click switches to Body first.
Each part's worked solution is always listed in the outline (its Worked
solution row is a 36px header, not a toggle) and shown in the body under the
part's answer, both below a `wavy-rule` line; the body's line reads "Hidden
until checked", since learners only get the solution after checking.
Its title names the question ("Edit question 10").
What keeps the question from being marked comes from `questionIssues`
(`src/features/questions/issues.ts`, Epo 2026-10-15): it validates
`withoutBlanks(question)` with the schema and the hand-written rules
(`ruleIssues` in `validation.ts`, which `validateQuestion` throws the first of)
and maps each failure, by its path, to the agreed wording (`question_issue_*`
messages: "MCQ: option B cannot be empty", "Fill in the blanks: a blank is
missing at least one correct answer", "Part B: missing or empty question text"
and so on), with its outline row and the title it belongs to, in reading
order and each once. An answer issue starts "Part B" (the question's own
letters or numbers) only when there are several parts; a chart's or graph's
issue keeps its block ("Graph error: …" with the graph rule's message);
rules the dialog cannot break (agent-only bounds and counts, ids, awarded
marks, image links) read "Finish the question and its answer." The dialog
shows one issue box at the top of the body with the first issue and
"(+n more)" (`IssueSummary` in `IssueViews.tsx`, also the quiz editor's line
under each question in `QuizForm`), a warning icon right of each affected
title (`IssueIcon`, through `QuestionView`'s `titleAside`: the question's for
question-level and generic issues and for a lone part, each part's for its
own) whose tooltip lists that title's issues, and only a warning icon on each
affected outline row. User-facing wording says blanks ("Fill in the blanks",
"Blank 1"); the stored type stays `gaps`. Rows the app names take
an accent of their own (Answer rows `tint-accent-1`, Worked solution
`tint-accent-2`), and the row ⋮ has no tooltip (`ToolbarButton tooltip={false}`),
since its label repeats the row's text. Menus (add block, question
settings, row and graph element actions) are the note toolbar's popovers
(`ToolbarPopoverContent`, `ToolbarPopoverGroup`, `MenuItem` over
`ToolbarPopoverItem`), and block editors use `FieldInput` and `SelectField`,
the compact underline style of the answer options. It reuses
`ToolbarGroup`, `ToolbarButton` and `SimpleDialog`; block editors replace the
dialog body and keep Remove beside Save. English and Chinese labels use
Paraglide. MathLive renders formulas in both viewing and editing, including
question-editing previews. Read-only previews use the shared `MathPreview`
component with matching fonts/layout and no keyboard or menu controls. `BlockToolbar`
is shared by question blocks, note embeds, tables and columns.

Charts reuse the SVG renderer extracted from ChatChart. A chart's category
labels may be empty (every validator and the embed catalog's chart schema,
Epo 2026-10-14); `CategoryChart` draws an empty
label as no tick text. A chart holds at most `QUESTION_CHART_SERIES_MAX` (6,
one per chart colour) series of `QUESTION_CHART_LABELS_MAX` (50) values; its
title and axis titles stop at `QUESTION_CHART_TITLE_MAX` (100), each series
name at `QUESTION_CHART_SERIES_NAME_MAX` (60) and each category label at
`QUESTION_CHART_LABEL_MAX` (60) code points, and a value within
±`QUESTION_CHART_VALUE_MAX` (1e12; the editor's cells stop there) (Epo
2026-10-17). A
note's chart dialog lists what keeps Save off in the question dialog's issue
strip (`blockIssues`). Category labels wrap between letters where a word
does not fit, and the tick column widens to its widest number. A pie or stacked chart holds one series of values 0 or
more with a positive total among its non-empty values: the chart editor
keeps one series and its value inputs stop at 0, and the pipeline cuts an
agent's multi-series pie or stacked chart to its first series and pads an
agent's short series with null, in `add_question_media` and in note chart
fences (`first_series`, `pad_series` in
`pipeline/pipeline/retrieval/questions.py`, each named in the result), while
every validator still refuses several series and a negative value stays an
error everywhere. A chart value may be null, an empty cell: the editor keeps
an emptied cell (and a new row or series) null, every validator and the embed
catalog's chart schema accept it, and it draws no bar, point or slice
(`CategoryChart`; a line breaks there), showing as `–` in values tables, the
export table and the grading text. Blanks are dropped or filled before a question is
validated and stored (`withoutBlanks` in `types.ts` on every save and the
dialog's issues, `blockWithoutBlanks` for a note's chart or graph, Rust
`without_blanks` in the live quiz projection): empty text blocks, a blank
unit, blank hints and blank accepted answers, a blank's included (no accepted
answer left leaves the part or blank incomplete), blank marking items (the
part's marks become the rest's, `schemeMarks`; none left leaves it
incomplete, Epo 2026-10-15), and a blank figure description go; a table's shorter
rows take empty cells up to the longest (a longer row adds a column with an
empty header; a live room's table is a grid, always even); a chart series
short of its labels takes nulls and an empty value (NaN) is null, while a
series longer than its labels stays an error. The validators stay strict (even
table rows, a value per label), so nothing uneven is stored (Epo
2026-10-14). Image and graph descriptions are optional like chart and plot
ones; a figure without one is `[Figure]` in the grading text and has empty
alt text. Only an image carries an `attribution`, the figure's own printed
credit (a library figure's caption); graphs, charts and plots have none
(Epo 2026-10-17), and a question's credit is its bank `sources`. An open part's marks are its marking items' total capped at
`QUESTION_MARKS_MAX` (`schemeMarks`, live and staged alike): items past the
cap stay as entered, so the live room admits the edit and the dialog names
the mismatch. Graphs store a bounded
JSXGraph recipe and a static rendering. Recipe elements are function graphs,
points, lines, segments, circles, labels, angles (three points with the vertex
in the middle, drawn under 180° with a square mark at 90°), arcs and sectors
(counterclockwise from the first point around a centre) and polygons (3–12
points); sectors and polygons can be shaded. A segment's `ticks` (1–3) draws
JSXGraph hatch marks, so equal sides carry the same count. The graph editor
(`GraphEditor.tsx`, the same in quizzes and notes) is Desmos-style: one typeset
MathLive row per element on the left, a live board at the export's pixel size on
the right (stacked on phones). `graphSyntax.ts` turns rows into recipe elements
and back: Desmos input (`y = 0.5x^2 - 3`, `{0 ≤ x ≤ 4}` restrictions,
`A = (1, 2)`, `segment(A, B)`, `polygon(…)`, `circle(A, 3)`, `angle(…)`,
`arc(O, A, B)`, `sector(…)`) with implicit products, stored as JessieCode with
explicit `*`; style (dash, equal-side marks, shading, labels, hide) sits in each
row's style menu. A row's point names are its references; a saved point another
element uses but whose label is not a name gets the row name `P_n`. Issues read
like the question dialog's: the first one (with "+n more") above the editor, a
warning icon on each row that cannot be drawn and beside Advanced when its size
or bounds are invalid; the dialog holds Save until they are fixed. Dragging,
wheel or pinch zoom around the pointer, double-click and Fit move the board, and
the visible area is the saved `bbox`, reported once a gesture settles (wheel
events zoom once per frame); dragged points round to the board's precision (0.1
at the default zoom). Full screen opens the live board in the note figure
preview. The board compiles `pi` and `e` as JessieCode's `PI` and `EULER`.
Numbers follow GeoGebra (Epo 2026-10-17): ticks every 1, 2 or 5 × 10ⁿ from
100px of units rounded down, a minor tick halfway, grid lines on the numbered
ticks, tick numbers plain (`0.25`, `2010`) or scientific (`5E8`) when the step
is under 10⁻⁵ or over 10⁷, an en dash for minus; an axis whose 0 is off the
view sticks to the nearer edge with its numbers inside (JSXGraph's `sticky`
position, inset in board units because JSXGraph converts a pixel inset with
the other axis's scale); zoom spans 10⁻¹⁵ to 10¹⁵ pixels per unit. A graph is
120–1200 px wide and tall (120 keeps the bank's 150 px box plots) (`QUESTION_GRAPH_DIMENSION_MIN/MAX`, every server);
a size outside that is an issue, not clamped, and the row count shows the
x/60 counter beside Add label from 90%.
Rows and label positions write e-notation as `6.02·10²³` (LaTeX `\cdot 10^{23}`).
JSXGraph treats anything under 10⁻⁶ as zero and its grid breaks far from the
origin, so the board draws in a local frame (`origin + unit × board`, one unit
for both axes, origins on a multiple of every tick step) and redraws in a new
frame whenever the view jumps or the tick step changes.
Label text holds at most 60 characters (`QUESTION_GRAPH_LABEL_MAX`) and wraps at
200 board pixels into one SVG `tspan` per line; point names and angle labels hold
at most 20 (`QUESTION_GRAPH_NAME_MAX`), on every server. Implicit curves and inequalities are planned (`todo-graph.md`). Question charts sit
at about a graph's width with a centred title and never show a values table.
A `plot` block holds numeric series over numeric axes: optional `kind` (`line`,
the default, or `scatter`), `title`, `xTitle`, `yTitle`, optional `unit`, 1–4
`series` of `{name, points: [[x, y], …]}` (2–60 finite points drawn as straight
segments in x order, or 1–60 drawn as dots for a scatter, Epo 2026-10-14), and optional `lines`
(`{axis: x|y, value, label?}`, dashed reference lines) and `marks`
(`{x, y, label}`), at most 8 of each (`QUESTION_PLOT_*` in fieldlimits).
`PlotChart` (beside `CategoryChart`, same frame, theme variables and ticks) draws
it in quizzes, notes and chat. It has no editor: the question dialog shows a plot
and can remove it, but the add menu does not offer one. Go and the browser
validate it, and so does the Rust collaboration server (`questions.rs`,
`material.rs`: a live quiz question holding a plot and a note's `plot` embed,
with Go's bounds; Node's validator never knew it, Epo 2026-10-12). A live quiz
room keeps a plot as one value, as it keeps a chart (`items/src/quiz.rs`,
`liveQuiz.ts`; before 2026-10-13 the room's reader dropped it, so an agent's
plot vanished from the projection). A valid plot is in the shared fixtures
(`plot.json`), so the live quiz round trip and the browser/server parity
corpus carry one; refused plot cases are tested in each validator. Grading text lists its curves' points and labels. User quizzes and notes keep validated
SVG, at most 256 KiB, in their document. Bank graphs store the recipe in the
database and the SVG in the public bucket. Image and graph blocks both keep
their source under `image`: bank images use `{ url }`, a public content-hashed
URL, and quiz images use `{ assetId }`, a private editor asset of the quiz
(see [backend-storage-quota.md](backend-storage-quota.md)). Quiz images are
resolved to signed URLs at render and export time and follow editor-asset
cloning: a clone copies the asset rows, rewrites the ids, drops images whose
asset was not copied, and drops a question whose part loses all content. Uploads
go through the quiz's material route and name the quiz, and a library
figure the chat agent places with `add_question_media` is stored the same
way, as an asset of the quiz (see agentic-retrieval.md, Question tools); the workspace owner
pays for a workspace quiz's images, the quiz owner for a standalone quiz's. A question copied from the bank (Copy to quiz) keeps its
bank `{ url }` figures in the quiz: they are immutable, so the quiz links to
them rather than copying them, and the Go validator accepts a quiz image or
graph URL only under `BANK_ASSETS_URL` (`questions.QuizBankAssetsURL`), as do
the collaboration service's store and live quiz room admission. Each
copied question's sources become a credit in the quiz's provenance under the
question id, shown under that question rather than in a footer (see
[agentic-retrieval.md](agentic-retrieval.md), Question bank). Answer
options stay plain strings; no images or rich content go inside them.

`POST /api/bank/assets` checks the editor grant, validates the bytes and uses
server environment credentials. The local publisher has the same validation.
Figures are capped at a flat 4 MiB (SVG 256 KiB), with no plan because the
platform pays; the bank editor shrinks a larger raster image in the browser
first (`uploadBankAsset`, `src/lib/fitImage.ts`).
`BANK_ASSETS_URL` is the allowed public base URL for stored bank asset references;
it does not restrict uploads to one developer machine. Credentials stay on the
server or publisher. Existing private workspace editor assets are separate.

## Revisions and grading

Quiz and flashcard content writes carry no revision (D7, 2026-10-10): editors
edit them live, and the content endpoints rewrite what differs in the live
documents. Opening an embedded material to view or edit fetches fresh
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
part, with figures as their descriptions (`[Figure]` for one without), tables
and chart data. Requests carry
only part ids and answers; the server loads the scheme, so the endpoints cannot
grade arbitrary text (see Answer keys and server grading below). Saving an open part in the quiz editor
asks Jev whether grading it needs a calculation checked and warns the author
at a probability of 0.3 or more; the save is never blocked. Usage and the
anonymous caps are in [observability-metering.md](observability-metering.md).

User quizzes (not the bank) are bounded so one attempt fits one grading
request: at most 100 parts per quiz, 7 per question, 5 marking items per part
and 20 open parts per quiz, and a sample answer of at most 5,000 characters;
learners' open answers have the same 5,000-character cap. The Go, browser and
collaboration validators share these bounds (`fieldlimits.Quiz*`), and the
generation prompt states them.

Attempts retain graded snapshots. Mistakes strip the attempt-only awards.
Taking, reviewing and every read-only view (quiz preview, quiz editor, bank,
question dialog preview) use `QuestionRunner`; a quiz shows all its questions on
one page (`QuizQuestionList`) with one Submit; inside a note Submit is a small
accent button beside the answered count, and a checked quiz there and on the
completion page ends with a small outline Redo quiz on the right. Completion and saved attempt pages
share the part review renderer. The saved attempt page has Redo quiz as an
accent link beside the title; both pages lead with the score (`ResultSummary`,
shared with the /qb topic summary): "awarded / max" large with "marks" and the
percentage small, one numbered square per question (green full marks, amber
partial, red none, blank answers are wrong; grey only for an unanswered bank
question; a square scrolls to its question) with a legend of the colours
present, marks by answer type (a question counts under its first part's type),
then every question with marks in tint-fg colours, the submitted answer, then one collapsed disclosure holding the
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
split-layout questions keep one column beside their passage. Layouts follow
the question's own width (`@container/question` in `QuestionView`), not the
viewport: from 36rem a split question sets its stem beside its parts and a
paper question its first stem text beside the number; below 36rem (phones,
the Study panel) both read alike, number and marks on the top row and the
stem full width under them, and a single part's empty label column closes so
its text and answer line up with the stem (labelled parts keep theirs).

Workspace quiz previews center the question column in the viewer; other quiz
entry points retain left alignment.

## Answer keys and server grading

One rule for quizzes and the bank in every situation (Epo, 2026-10-06):
reading to view or study never sends answer keys, accepted answers, marking
schemes or worked solutions; editing sends them to whoever may edit; checking
an answer or submitting an attempt returns the key for what was just checked.
Grading happens only on the server, and retakes and Try again are unlimited.
Answer-free questions are `questions.LearnerView` (`server/internal/questions/questions.go`):
part ids, blocks and marks, mcq options in stored order, a short answer's
unit, matching `left` items with shuffled `options`, shuffled ordering `items`
and the number of `gaps`. It reads stored content with checked assertions, so a
malformed question loses fields instead of failing the read.

| Read | Who | Keys |
| --- | --- | --- |
| `GET /api/quizzes/{id}` | anyone who can read the quiz, owners and editors included | none |
| `GET /api/quizzes/{id}/edit` | whoever may edit it (`assertMaterialOwner`, the content-edit check); others 404 | full |
| `GET /api/materials/{id}` for a quiz | readers; the workspace view (`materialdoc.LearnerQuiz`) | none |
| `GET /api/explore/quizzes`, `GET /api/public/quizzes/{token}` | anyone; signed-out visitors | none |
| `GET /api/workspaces/{id}/review` | workspace readers; question items | none |
| `GET /api/bank/questions/{id}`, `GET /api/bank/questions?ids=` | bank readers, editors included (View mode); `editor` still reports the grant | none |
| `GET /api/bank/questions/{id}/edit` | bank editors on an editable bank; others 404 | full |
| Create, metadata/sharing PATCH, clone, bank save and review marker (content goes through the live rooms) | editors and a copy's new owner | full |
| Chat `inspect_document` on a quiz | the acting user | full only for a material editor |

Copies keep keys because their owner edits them: clones and Copy to quiz
(`POST /api/bank/copy`). The signed-out image
route (`AnonymousQuizAssetPath`) still checks the full content, so a solution's
images resolve once an answer is checked. Live quizzes keep the rule by room
(Epo 2026-10-10): answer keys live in a keys document only editors who can
write join, readers join the content document, and matching options and
ordering items reach them only as shuffled lists the content room pushes
outside Yjs (D3 as revised 2026-10-10).

| Grading route | Request | Effect |
| --- | --- | --- |
| `POST /api/quizzes/{id}/attempts` | `{answers}` | Grades every part (closed in Go, open with Jev), stores the answers and graded questions, rates review and marks progress for workspace quizzes; 201 with the `AttemptDetail`. Needs read access; frozen accounts submit. |
| `POST /api/public/quizzes/{token}/grade` | `{answers, localId?}` | Signed out: `{correct, total, questions}`, nothing stored. The per-IP and global caps count only the answered open parts; over a cap it is 429 with `errors[0].message` `anonymous_grading_limit`. |
| `POST /api/review/check` | `{materialId, itemId, answers}` | One question of a review session: `{correct, total, question}`, rated from `correct / total`. A card is 422; cards keep `POST /api/review/ratings` with a required `rating`, which no longer takes a `score`. |
| `POST /api/bank/questions/{id}/check` | `{answers}` | One bank question: `{correct, total, question}`, and records the learner's latest score. |

Graded questions carry their keys, and every part `awarded`; open parts also
carry `itemAwards` (Jev's marks per marking item, zeros for a blank answer,
which makes no Jev call) and matching and gaps parts `itemResults`, right or
wrong per pair or gap. `questions.Graded` builds them. `POST /api/quizzes/{id}/grade`,
`POST /api/bank/questions/{id}/reveal` and `/answers` are removed, and the
browser no longer sends scores or graded snapshots. Answers naming a part the
questions lack, or an open answer that is not text or exceeds 5,000 characters,
are 422; an unanswered part is wrong. Attempts and checks are in the
rate limiter's AI class (`server/internal/ratelimit/middleware.go`), as the
grade route was, because they may call Jev.

Answers are keyed by part id, one shape per answer type, the same for a
learner view and a full question:

| Type | Answer |
| --- | --- |
| `mcq` | option indices in stored order (the learner view keeps it); right only as the exact set of correct options |
| `boolean` | `true` or `false` |
| `short`, `open` | the typed text |
| `ordering` | the item texts in the learner's order |
| `matching` | `{"0": "option text", …}`, keyed by the left item's index |
| `gaps` | one string per gap, in gap order |

Matching and ordering answer by text because the learner view shuffles them;
duplicate texts are interchangeable. `questions.ScorePart`
(`server/internal/questions/score.go`) ports `scorePart` from
`src/features/quizzes/grade.ts`, JavaScript string rules included (its trim and
`\s` set, final sigma, UTF-16 lengths and edits), and the fixtures in
`server/internal/questions/testdata/scoring/` (README there) run against both.
Attempts stored before 2026-10-06 keep index-shaped matching and ordering
answers and lack `itemResults`.

In the browser, viewing and studying use the answer-free reads: quiz view mode
(`QuizPreview` in `CenterContent.tsx` renders the material document's learner
questions as they come), taking a quiz, the note embed card, review sessions,
signed-out pages and the bank's View mode. The quiz editor and note export
read `quizEditQuery` (`GET /api/quizzes/{id}/edit`). The bank's Edit mode reads
each question through its `/edit` route, because the batch route is View
mode's, and caches it apart (`bankQuestionQuery(id, mode)`); a save or review
marker replaces the Edit entry and marks View's stale (`storeBankEdit`).
Submit posts `{answers}` (`useSubmitAttempt`) and shows the returned attempt;
signed out, the public grade route's result goes to IndexedDB
(`LocalQuizAttempt`). Check in a review session posts `/api/review/check` and
the bank's Check answer its `/check` route; both show the returned question.
`QuestionRunner`'s review shows the server's grading as it is: each part's
`awarded`, the key's correct options and accepted answers, matching and gap
results from `itemResults`, and an ordering row is right when its text sits at
that stored position. Grading refuses (422) an ordering part sent without an
order: the shown order is always an answer, which clients send as soon as the
part renders, and an untouched order counts as answered. Nothing in the app scores answers: `grade.ts` keeps the
answer types and a scorer only the MSW mocks use (`src/mocks/answerKeys.ts`
also mirrors `LearnerView` and stands in for Jev), and `grade.test.ts` runs it
over the shared scoring fixtures. A pre-2026-10-06 attempt still shows its
score and awards, but its matching letters and ordering rows show as
unanswered and its gaps as wrong.

Answer areas span the text and marks columns of a part row; phones use 16px
pane padding and a 1.5rem number column. Answers use the underline variant: no
boxes, one bottom rule per item (`answerRowClass` in `QuestionView.tsx`), its
key a letter or number in a small square badge (`OptionKey`, 6px corners). A
state thickens and colours the rule: chosen is the accent with a filled badge;
after checking, right is green and wrong red with a ✓/✗ badge and a "Your
answer" tag, and a correct option not chosen sits on a dashed green rule tagged
"Correct answer". Choices take two columns on wide paper answer areas; true /
false sits side by side from a 28rem answer area and stacks below it. Text
answers are underlined `Input`s, written answers sit on ruled lines
(`ruled-lines`), and each gap is a blank in the sentence that grows with what is
typed up to the line (a hidden copy of the value in `data-value` sizes it),
punctuation after it kept on its line. Matching picks with an underlined
`Select` letter in a wide answer area and with a row of letter buttons under
each item below 28rem, the options listed above. After checking, a short answer
lists every accepted answer with its unit; a gaps part with a miss and an
ordering part out of order list the key under the learner's own answer
("Correct answers", "Correct order"), noting what the learner wrote or where
they put each misplaced item; matching shows the chosen letter and the correct
one. A checked open answer opens with a verdict counted over its marking points
("Partially correct: 1 of 3 points answered correctly", "Skipped: Question not
answered").
Matching dropdowns letter the options in the order the read sent them (shuffled
for learners) and store the chosen option's text. Ordering lists the items in
that order and commits their texts as the answer as soon as it renders; editors'
previews show the stored order. Reviews letter the stored options.
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
`server/cmd/bank` migrates, writes exams, publishes and reports status.
`go run ./cmd/bank exams ../lab/questions/syllabi` upserts every catalog's exam
(label, full label, position, cover); a catalog without a cover keeps the stored
one, and a new exam without one gets `bank.DefaultCover`, a GeoPattern in a
palette colour picked from its id. Publication files topics only under an exam
that already exists. Bank migration `0005_exam_covers.sql` adds the two exam
columns and fills the pilot's HKDSE and IELTS. Publication uploads
immutable assets and inserts new IDs; it does not overwrite later reviewer edits.
No task-type labels are stored (Epo, 2026-10-06): the page filters by the
parts' answer types read from each question's content. Bank migration
`0004_drop_question_types.sql` drops the old `questions.question_types`; run it
only after the code that stopped reading the column is deployed.

## Learner progress and retraction

Bank progress keeps each signed-in learner's latest result per question and
nothing else: no FSRS state, review queue or end-of-session screen (Epo,
2026-10-06). App migration `0056_bank_progress.sql` replaces
`bank_review_states` (0055) with `bank_progress`, one row per user and bank
question: `question_id` and a copied `topic_id` are plain ids into the bank
database (no foreign key), `item_hash` is `review.QuestionHash` of the question
when it was answered, then `last_score` (0 to 1) and `answered_at`. The
migration carries existing rows over. Rows are never copied or charged to
storage.

| Endpoint | Effect |
| --- | --- |
| `POST /api/bank/questions/{id}/check` | `{answers}`, the learner's answers by part id. Grades them on the server (open parts with Jev), upserts the question's topic, hash, score (`correct / total`, 0 to 1) and time, and returns `{correct, total, question}`, that one question with its key and awards; 404 when unknown or retracted. |
| `GET /api/bank/topics/{topicId}/marks` | `{marks: {questionId: score}}` for the topic list: the latest score of each answered current question. |
| `GET /api/bank/topics/{topicId}/summary` | `{questions: [{id, position, preview, marks, answerTypes, score}]}`: every current question in topic order, unpaged, with the latest score for its current content (null when not answered); the summary page. |
| `GET /api/bank/progress` | `{topics}`: every topic with at least one answered current question, most recent answer first. Each carries exam, subject and topic ids and labels, `total` (current questions), `answered`, `correct` (score 1), `lastAnsweredAt`, `nextQuestionId`: the first unanswered question after the most recently answered one in topic order, wrapping to the start, or null when every question is answered, `questionIds` (the topic's current questions in order), `answeredPositions` (1-based places of the answered ones) and `lastAnsweredPosition` (the place of the most recent answer), which the landing's progress map draws and links. |
| `POST /api/bank/copy` | `{questionIds (1–20), workspaceId, quizId \| quizName, chapterId? \| chapterName?}` returns `{workspaceId, quizId}`. Below. |

A current question is one that is not retracted and whose stored hash equals
its hash now; `bank.TopicHashes` and `Store.Progress` (`server/internal/bank/progress.go`)
read the topics' questions once per request. Editing a stem or part prompt
therefore makes the question unanswered until it is answered again; edits to
answers, schemes, solutions and figures keep the result. The routes need the
page's read access (signed in, bank configured), so signed-out visitors get 401
and record nothing; frozen accounts record (`requireAccountMutate`). Account
purge deletes the rows.

`POST /api/bank/copy` (`server/internal/httpapi/huma_bank_progress.go`) copies
questions unchanged (`bankCopies`, `bankAppendCommands`): each question's credit is resolved
from its bank sources into the quiz's provenance under the question's id, and
an unknown or retracted id fails the call with 404. Exactly one destination:
`quizName` makes a new quiz in the workspace, filed in `chapterId` or
`chapterName` when given (at most one, and neither with `quizId`; 422
otherwise). `chapterName` reuses the workspace's chapter of that name in any
case or creates it in the quiz's transaction (`Store.CreateMaterialDraft` with
the upload path's `resolveUploadChapterID`, which locks the workspace row);
`quizId` appends after an existing workspace quiz's last question through the
document authority, which writes the merged credits with the content. A quiz a
note embeds is such a quiz: the credits join that quiz's own record and its
embed shows them, never the note's record or another embed's. The
caller needs the bank's read access and edit access to the workspace (viewers
get 404); frozen accounts and storage owners at their limit are refused like
other content writes.

Published questions are retracted, never deleted, so progress ids stay valid.
Bank migration `0003_retracted.sql` adds `questions.retracted_at`, which only
the owner sets (see [deployment-runbook.md](deployment-runbook.md)); the editor
role has no grant on it. Syllabus counts, the topic list, single and batch
reads (a retracted id fails a batch with 404 like an unknown one), comments,
check, marks, progress and copy routes all skip retracted questions. Editors' save and review
routes do not check the flag; the page never lists those questions. UAT and
production share the bank: run `go run ./cmd/bank migrate` before deploying
code that reads the column, and code older than this change still shows
retracted questions.

### Learner answering

View mode renders every question as `QuestionRunner` with the learner's answers
and a Check answer button under it, right-aligned on a divider like the editors'
review bar (`CheckableQuestion` in `src/routes/QuestionBank.tsx`). Reads stay
answer-free (`questions.LearnerView`), editors' View mode included; Check
answer posts the answers to the check route, which grades and records them and
returns that question's key and awards only. The question then shows the quiz
review (`QuestionReview`: part score in the marks column with no question total,
the answer rows tagged Your answer and Correct answer, accepted answers, the
worked solution collapsed), and the topic's marks and the landing refresh. Open
parts (none in the bank today) are graded by Jev like a quiz's. Try again
clears the answers and the key; the next check records a new attempt, and the
list shows the latest. Edit mode reads `GET /api/bank/questions/{id}/edit` and
keeps the answer key, review bar and disabled runner. A failed check keeps the
answers for another check.

The topic list uses the shared `QuestionListRow`
(`src/features/questions/QuestionListRow.tsx`): bold number, two-line stem,
then a muted line with the marks, figure and table icons. In View mode a result
mark leads each row from the latest score (`bankStatus`: a green check at full
marks, an amber minus between, a red cross at zero, an empty circle when
unanswered), and one line under the topic heading reads "N correct · M to
retry" (M counts scores below 1), both from the marks route. Edit mode shows
no marks; its rows keep the reviewed label on the muted line.

With no topic open, View mode's main panel shows the progress route's topics
(`BankLanding`). Continue: the most recently answered started topic (the route
lists newest first) as a hand-drawn progress map (`TrailMap`), with its exam
and subject above, then its name, "answered of total · correct" and an accent
"Continue at question N" link (opens `nextQuestionId`); the other started
topics follow as rows with a small trail (`MiniTrail`) and a Continue link.
The small trail fills its box (150px at least) with more seeded waves rather
than stretching: on phones it runs the row's full width under the name, wider
it takes the space between the name and the count. Learning's Progress rows
and the Study tab use the same trail.
Finished: a divider list with the date of the last answer and a
Summary link to the topic's summary page. The map leads with a finished topic
instead in two cases: the URL's `finished` (set by the finish toast's Go check,
below) names it, or no topic is started (then the most recently answered
finished one). It then heads "Topic finished", draws the finished map and links
Summary, and leaves the Finished list. With none, or in Edit mode, it keeps
Choose a topic (in View mode instead `PlaceholderTrailMap`: 24 stops, nothing
answered, no tag, numbers, tooltips or clicks, a wooden notice board
(`MapBoard`) past the first stop saying how to start, then Suggested topics:
the first topic with questions in each exam, at most four, each with Start); phones list the topics in the page under it. Continue exists
only on the landing (Epo, 2026-10-06); there is no review session.

The summary (`/qb/$topicId/summary`, `TopicSummary`, inside the /qb page) has
the topic page's header, one level down: the trail ends on the topic (Question
bank / exam / subject / topic, the topic linking to its page, where Back also
goes), the title is Summary, and the meta "Finished <date> · n questions" comes
from the landing's progress. Every breadcrumb trail ends on the visible page's
parent; the page's own name is its title with an accent Go
through again (the topic from question 1; new answers replace results, there
is no reset). Below: the score, squares (each opens its question) and marks by
type as on the quiz result page, then Worth another look: up to seven wrong or
partial questions in topic order with their preview, type, marks, score and
Retry, the rest as numbered squares, and Copy to quiz with those questions (up
to 20); last, Next in <subject>: the first topic after this one in its subject,
wrapping, that has questions and is not finished (Start, or Continue at its next
question once started), hidden when none.

The map (`src/features/questions/trailMap/`) is generated in the browser from
the topic id and question count, so a topic looks the same on every visit and
device and adding questions only extends its end: each part (biome order,
each landmark, each question-width of scatter, sky, horizon) has its own
seeded stream. One stop per question, 60 map units apart, then a summit whose
flag stands on a short pole planted a little below the peak, so the map's top
edge does not cut it. The
map is a run of biomes 4 to 7 questions long (forest, meadow, farm, village,
lake, river, hills, camp) whose borders blend over 60 units; each scatters
drawn element templates (placed with `<use>`) by its own mix and has at most
one landmark (windmill with fields, cabins and a well, lake, river with a
bridge, lookout tower, tent with a campfire). Every question-width holds at
most 5 elements (grass, pebbles, flowers and butterflies count half) and a
visual weight of 22 (footprint times ink or fill share; water and fields count
1.6 times). The `DENSITY` labels come from `measure()`, each biome alone over
30 seeds: under 6 sparse, under 11.5 medium, else dense; the order never puts
two dense biomes side by side or three sparse in a row, and has a dense one at
least every fourth. Answered stops are filled; the next question's stop is hollow inside a ring
with a "Q5 next" tag, the trail is solid up to it, and the map is faint from
six questions past the next question or the last attempted one, whichever is
later (going back to an earlier question pulls the full ink back). Answered
stops are filled wherever they are drawn. Hovering a stop shows "Q7" (the app Tooltip) and
clicking opens that question in the page. The map is `aria-hidden` and the
stop buttons are out of the tab order: the line under the map and the
Continue link carry the same information and action for keyboard and screen
reader users, and the topic's question list reaches every question. A finished
topic (`nextQuestionId` null) has no ring or Next tag and no faint part: the
trail is solid to the summit flag and a "Finished" tag sits left of it (above it
would leave the map's top edge).

Answering a topic's last unanswered question raises a success toast, "Topic
finished" with Go check, which opens `/qb?finished=<topic>`. The toast comes
from `useFinishToasts` (`src/features/study/finishToasts.ts`, mounted in
`AppShell` so the progress route stays observed on every signed-in page): each
refetch of the route is compared with the one before, and a topic finished now
but not before toasts (answering any question refetches it). The first time a
finished topic leads the landing in a browser, the map celebrates
(`src/features/questions/trailMap/finish.tsx`, shared with Learning's railway
map): the page scrolls the map into view, the last stop pops filled, the line
runs on to the flag with a dot at its head, the flag waves while four sketched
fireworks (drawn-out rays with falling sparks, no rocket trails) open in turn in
the sky beside it, clear of the Finished tag and kept inside the map's width, in
a layer over the map but outside its clipping scroller, the done stops ripple
back and the Finished tag pops in; reduced
motion shows the finished map at once. Played keys live in localStorage
(`capy.map.finishPlayed`, `topic:<id>:<question count>`, the last 200), so a
topic finished again after new questions celebrates again (Epo, 2026-10-13).
The generator
returns pieces with a left and right edge; the view draws only those within
120 units of the visible stretch, tracked in whole question-widths, and the
faint and full-ink copies each hold only their side of the cut-off. The scroller hides its scrollbar like `Tabs` and fades an edge only while there is more to scroll that way (`scroll-fade-x`). Colours
mix from the theme's text and card tokens (`trailMap.css`, `tm-` classes: a
scoped selector does not reach elements placed with `<use>`). Mocks:
`artifacts/2026-10-09-bank-path-mocks.html`,
`artifacts/2026-10-09-bank-map-gallery.html`.

Every topic has the list pages' filter (`FilterPopover` from
`src/components/app/ListToolbar.tsx`) beside Edit mode's All/Unreviewed
buttons: Question type offers the answer types present in the topic's rows
(the editor's labels), and View mode adds Status (Correct, Wrong, Partially
wrong, Not done). `filterBankRows` keeps rows with any chosen type and any
chosen status; the search text applies on top, and the main panel shows the
same rows. Status is matched against the marks as they were when it was last
toggled, so a question answered while filtered stays in view.

Clone, right of the filter, turns the side panel's question list into a picker
for Copy to quiz and gives way to Copy to quiz and ✕ (cancel). Each row then
leads with a checkbox in place of its result mark; a click toggles the row and
still scrolls to its question, and on phones the sheet stays open between picks.
Picks survive filtering and cap at the route's 20. `/qb` is one route whose
`$topicId` and `$topicId/$questionId` children have no component
(`src/router.ts`), so moving between questions keeps the page, its filters and
picks mounted. `CopyToQuizDialog`
(`src/features/questions/CopyToQuizDialog.tsx`) has Workspace (workspaces with
`capabilities.canEdit`, each with its icon) dropdown, then a Quiz combobox
(`QuizTargetSelect.tsx`) styled after TagSelect but single-valued: the picked
quiz's name sits in the input. Its list loads on first open (skeleton until
then) with every top-level quiz in that workspace, newest edit first from the
Create page's list (`GET /api/materials?kind=quiz&location=workspace&scope=member`,
Load more past 100), each with its chapter name (nothing when unfiled) and
question count. Typing over a new quiz's name renames it with the list
closed; otherwise typing clears the pick and filters the loaded quizzes, and
Enter on "New quiz: …" (first row) names a new quiz. ✕ clears the field.
The form draws while workspaces load (Workspace select spinning) and focuses
the dialog, not the picker, on open. The default is a new quiz named after the
topic. A Chapter row keeps its space but stays hidden until a quiz is picked:
an existing quiz shows its chapter, locked; a new one uses the Add source
dialog's chapter picker (`src/features/workspace/ChapterSelect.tsx`, `field`
look): No chapter by default, an existing chapter, or New chapter…, whose
typed name is matched to an existing chapter in any case or sent as
`chapterName`; a name still being typed counts on Copy. Copy posts the copy route in topic order;
success shows a toast whose Open quiz opens the quiz in its workspace, and a
failure keeps the dialog open behind the global mutation toast. The MSW mock
seeds answers in Area practice and Mensuration and makes copies in the mock
workspaces.

## Delivery and checks

The Biology 101 MSW quiz and both note-embedded quizzes share
`src/mocks/biologyQuiz.ts`: 11 questions, 13 parts and 26 marks covering all seven
answer types, fixed-unit quantities, multipart questions, both layouts, formulas,
tables, an editable graph and all six chart styles. Every part has a worked
solution. The graph SVG is rendered from its stored JSXGraph recipe. The seeded
`at_1` attempt includes correct, incorrect, blank and partially credited answers
for inspecting review states; the seeded attempts are graded by the mock scorer
from text-shaped answers, as the server stores them. Image examples are
deferred. The MSW routes follow the answer-key rule like the server's, the
view-only and frozen-account scenarios included (`learnerMaterial` in
`src/mocks/db.ts`); attempt lists carry scores without answers or snapshots,
and Biology 101's review seeds one missed question so a session has a
question to check.

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
