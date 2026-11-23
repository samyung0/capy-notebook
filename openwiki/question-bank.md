# Question bank

The bank is a separate syllabus and question database. Signed-in learners read
question content; granted bank editors can edit, mark reviewed, upload figures
and send a comment. The bank page is at `/qb`, under Explore in the
sidebar, inside the app shell: the main panel shows the chosen topic's
questions, and from `xl` a right column (`PanelHeader`, shared with the theme
drawer) holds one tree of exams, subjects, topics and the open topic's
questions (Exam tree and covers, below). Below `xl` a chooser button (the open
topic's name, else the last attempted exam's) opens the same tree in a dialog,
full screen on phones with close left of the title; phones put the chooser in
the top row between the menu and the avatar and hide the breadcrumb (browser
back covers it). Editors switch between View mode and Edit mode; edit mode adds
the answer key and a review bar (review status, Mark reviewed/Undo review,
Comment, Edit) under each question. In View mode signed-in learners answer and
check each question (Learner answering, below) and copy a topic summary's
missed questions into their quizzes.

## Exam tree and covers

The tree (`TopicTree` in `src/routes/QuestionBank.tsx`) lists every exam as a
44px cover strip (`ExamStrip` in `src/features/questions/ExamPicker.tsx`): the
art starts at the left edge and fades out to the right, the name sits on it in
the cover's text colour (`paint.light` dark, else white
over the strip shade; covers look the same in both themes), and the topic count
and a chevron sit on the panel. A strip opens its subjects in place; several
exams and subjects may stay open. The open topic's exam and subject, `?exam=`
and the last attempted topic's exam and subject (`/api/bank/progress`, newest
first) open on top of whatever the learner opened. A collapsed subject shows its
question count, and an open one indents its topics under a guide line; a topic
shows its question count, or "answered of total" once started, and edit mode's
reviewed/total. The open topic lists its questions as numbered squares
(`TopicSquares`, from the summary route): result colours in View mode (the
quiz result squares), plain in Edit mode with a corner tick once reviewed, the
current question ringed; a square scrolls the page to its question. Levels with one entry are hidden (`soleSubject`,
`soleTopic` and `topicPath` in `src/features/questions/bank.ts`): an exam with
one subject lists its topics without a subject header, and an exam with one
subject and one topic (a single paper, like a driving test) has no tree:
its strip opens `/qb/<topicId>` titled with the exam's name and counts
questions instead of topics. Page trails, search hits and the landing's progress
rows drop the hidden labels too. Above a topic's title the trail's segments
link to the bank and to the exam (`?exam=`, which opens it in the tree; the
subject opens its exam too), and the back arrow goes to the nearest one. The
header search (`searchSyllabus` in `src/features/questions/bankSearch.ts`)
lists hits in three sections, Exams, Subjects and Topics, each matched by its
own name and ranked best first: the name exactly, at its start, at a later
word's start, anywhere (an exam's full name or description counts from the
word-start rank); ties keep syllabus order. Hidden levels are not hits. An exam
hit opens it in the tree, a subject hit opens its exam and subject, a topic hit
opens the topic. It filters the syllabus already loaded, so it sends no request.

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
part has a stable ID, blocks, one of eight answer types, whole `marks` (1–20)
and worked-solution blocks. A multiple-choice part (`mcq`) has one or more
correct options (multiple answers, `multi`, merged into it on every layer,
Epo 2026-10-15). With one correct option it is answered as a single choice,
picking an option replacing the last; with several the options toggle like
checkboxes under a muted "Multiple answers can be selected" hint, shown in the
question editor beside the options as well (Epo 2026-11-08). Multiple answer
is its own type (Epo 2026-11-15, as Canvas and Google Forms): the answer's
optional `multiple: true` (only `true`, only on `mcq`; the TS, Go and Rust
validators refuse anything else) answers it with checkboxes even with one
correct option. Several correct options without the flag are still
checkboxes, so model output reads as before and no prompt writes the flag;
grading is unchanged (the exact set of correct options). A learner has no
key, so the learner view carries `multiple: true` on a part with the flag or
several correct options and nothing else about its key; a live quiz's content
document holds the same derived flag, written with the options by the browser
and the server, and its keys document holds the author's flag, so editors
read it back as written. The agent's quiz fence form (`authored` in
`pipeline/pipeline/retrieval/questions.py`) cannot write the flag, so a
Multiple answer part keeps its stored block. An mcq (single or Multiple
answer) may also carry Shuffle options (Epo 2026-11-15, as Canvas's Shuffle
Choices): `shuffle: true` and optional `locked`, the option indices kept in
place (sorted, distinct, in range, at least one, only with `shuffle`; the TS,
Go and Rust validators refuse anything else). Neither is secret, so a live
quiz holds both in the content document's answer map, `locked` as ticks by
option id (as the keys document's `correct`), so a lock follows its option
when options move; a room read drops locks without `shuffle`. Answers stay
option indices in the authored order, so grading, attempts, results and
statistics are unchanged: the learner view keeps `options` as written and
adds `order`, each shown option's authored index, the locked ones at their
own positions and the rest shuffled (`shownOrder` in `questions.go`;
`LearnerViewsSeeded` uses the per-part seed matching and ordering use, so a
paper attempt reads the same letters, and its read maps a letter through
`order` back to the authored index, `ShownChoices`). Every view a learner gets
is seeded, so one person keeps one order: `GET /api/quizzes/{id}` by the
viewer and quiz (`userID/quizID`), an assignment attempt by its attempt id
while running, with grades hidden and in its review (the same seed a paper
attempt reads letters by). A review with the answers gets the graded question
plus that `order` (`withShownOrders` in `assignments.go`), so it reads the
options and letters as answered; without the answers it is the seeded learner
view (`gradedWithoutKeys`). The anonymous share page has no viewer, so its
order is drawn per request. The runner and question view show options in
`order` with letters by shown position and store the authored index
(`shownOptions` in `types.ts`). A live quiz's readers keep the order showing
(the stored view's, then each read's) while it still fits, as many options
with the locked ones in place, so a sync or an edit to another part moves
nothing; one that no longer fits is drawn by `shuffledOrder` seeded with the
quiz and part (`readerOrder` in `liveQuiz.ts`, the seeded `Rng` of
`src/lib/rng.ts` the progress maps also use). The quiz fence form cannot write either
field, so `authored` leaves a shuffled mcq as its stored block. The card's ⋮
(the part's ⋮ in a question of parts) has Shuffle options, checked while on;
on, each option row gets a lock button (`aria-pressed`, "Keep in place" /
"Locked"); turning it off drops `locked` (`withShuffle` in
`editorFields.tsx`). Model prompts do not mention it. Only open parts carry a marking scheme: items of
text and whole marks that add up to the part's marks, because the model grades against
them. An open part takes at most one sample answer (`accepted`, 0 or 1 items),
and it is optional, and grading never reads it (a drawing part's drawn sample
goes to the marker as an image). Every screen shows a sample answer (written or
drawn) in its own Sample answer section after the marking scheme, before the
Solution (Epo 2026-11-15, superseding the 2026-11-13 Solution's first block
behind a green Answer tag). The question card (the quiz editor's open card and
the question dialog) edits it there: a written one in the question's text
editor with its formatting row (B, I, U and formulas; no Insert, `textOnly` on
`BlocksColumn`), a drawn one with `DrawnSampleField`, a trash beside its
heading removing it. For a long answer or drawing without one, the footer has
Sample answer (Draw sample answer) beside Solution; on
phones the card's ⋮ holds Solution and Sample answer. A closed part's answer is its own key and its solution explains it, so it
has none; the editor sets a closed part's marks, and each marking point's, in a
small typed box (`MarksInput`: whole marks 1 to the cap, arrows step, anything
else reverts on leaving; Epo 2026-11-15, as Google Forms' points) and an open
part's from its items, its footer reading them in the label's own text, "Marks 6"
(Epo 2026-11-19). Authored parts are told from learner parts by their
worked solution (`isAuthoredPart`). A matching
answer stores the full choice pool independently from its correct pairings, so
unused and reused options survive generation, editing and rendering. The
editor keeps the pool in the author's order, which readers and index text see
too: the card's Rows and Columns lists (board Matching) reorder by whole-row
drag with an accent drop line and no handles, as the ordering items do
(Epo 2026-11-15, as Google Forms' grid rows and columns; `useRowDrag`: since
2026-11-16 the dragged row at half opacity and a straight 2px line over the
landing row's edge, as a note's block drag draws them), and
Alt+ArrowUp or Alt+ArrowDown moves the focused row with focus following it. A
row carries its pair, its `right` with it (`moveRow`); a column move remaps
every pair's `right` to its column's new place, so each prompt keeps its
answer, as removing a column does (`moveColumn`, `MatchingFields` in
`editorFields.tsx`). Under the Rows and Columns lists the
Correct answers grid (`MatchingGrid.tsx`) sets each row's match: one radio
group per row, read-only in a closed card with the correct cells green, banded
rows, and on phones a sideways scroll with the row names sticky. Read-only, its
cells are `aria-disabled` rather than disabled, so a screen reader can walk
them, and a shown key or a checked answer names each cell's state ("Nucleus:
Makes ATP, your answer, incorrect", "…, correct answer") with a ✓ or × beside
a right, wrong or missed cell, not colour alone. Members
answer on the same grid (see the runner below).

A text block's `text` (stem, group, part and Solution text) and a table
block's cells are plain strings: `$…$` and `$$…$$` formulas (`parseMathText`,
only paired, unescaped delimiters) and, outside them, Discord-style marks
(Epo 2026-11-15): `**bold**`, `*italic*`, `__underline__`, nesting freely
(`***both***`, `__**x**__`, a formula inside a pair). Only tight pairs mark
(`parseMarkedText`): a run of one to three `*` or exactly two `_` whose content
is non-empty and has no space just inside it, paired by CommonMark's delimiter
rules (its rule of three, so `**ab*cd*ef**` marks `cd`). A longer run stays
text, so `2 * 3 * 4`, `a*b`, a `______` blank and anything inside `$…$` read
as written; a backslash escapes a marker character (`\*`, `\_`) as `\$` does a
dollar, and backslashes right before a marker character or `$` pair up, `\\`
reading as one backslash (`C:\\**word**` is `C:\` and a bold word; other
backslashes stay as written). Neither marker has CommonMark's intraword rule
for `_` (Epo 2026-11-15): `the__key__word` underlines `key`, Chinese text marks
without spaces, and `2*3*4`, `a*b*c` or a model's `__init__` outside a formula
mark too. The stored format, the live quiz room (a Y.Text of the
plain string) and the TS, Go and Rust validators are unchanged; markers count
toward the text's length; model prompts do not mention them and model-facing
text keeps them. `TextView` reads marks only where it is given `marks` (text
blocks, table cells and the question lines taken from them), so options,
matching rows, ordering items, accepted and sample answers and marking points
show `*` and `_` as written. The question text editor (`TextEditor`) has B, I
and U before its formula tools (Cmd/Ctrl+B, I, U; no Markdown input rules) and
writes marks back as tight markers (`valueToMathText`): spaces at a mark's
ends go outside it, the longer of two runs opens outside, a formula sits in
the marks of the text on both its sides, a blank breaks marks, a typed
backslash right before a marker, formula or escape is doubled, and typed `*`
or `_` stay bare unless the string would read back differently, in which case
only the runs that could pair (one to three `*`, two `_`) or that touch a
marker of their character are escaped, never a longer `______` blank or a
formula's text. Exports turn markers into bold, italic and
underline; plain-text readers strip them (`stripMarks`, Go
`questions.StripMarks`): bank search text, `PromptText` (a member's missed
questions), list-card previews, the question list's rows, the drawing board's
pinned summary and the report's part labels.

A text block is `{type: 'text', text}` and nothing more. Its optional run-in
`label` ("Reasoning", "Source A") was removed (Epo 2026-11-15): the editor
could not show it while typing, so the layout shifted between editing and
reading. Writers bold the first words (`**Reasoning** …`) instead. The TS, Go
and Rust validators and the live quiz room's update gate refuse a `label` key on
a text block as an unknown key (`text-label-rejected.json`), and the generate
prompt's text block form no longer offers one.

A long answer is `{type: 'open', accepted}`: at most one sample answer and
nothing else. Its `hints` list was removed (Epo 2026-11-15): learners never saw
hints, only the document export printed them (Moodle has hints; Canvas and
Google Forms do not). The editor has no Add hint, the closed card and the export
no Hints list, the chat agent's `add_questions` items no `hints` (agent contract
v49), and generation and extraction write none. The TS, Go and Rust validators
and the live quiz room refuse a `hints` key on an open answer as an unknown key
(`open-hints-rejected.json`).

### Drawing parts

A `drawing` part (Epo 2026-11-03) is answered on the drawing board
(`src/features/blocksuite/drawingBoard.ts`) and marked like an open part: it
carries a marking scheme, counts towards the quiz's AI-marked parts, and its
`itemAwards` and `pending` work as an open part's. Its answer is `{type:
'drawing'}` alone: every drawing part opens the same plain board, with no
background types or starting board (Epo 2026-11-06, which replaced the blank,
grid, axes and figure backgrounds agreed on 2026-11-03). Every validator
refuses any other key on it, on the shared `drawing-*` fixtures. Go's
`questions.ModelMarked`, Rust's `model_marked` and the browser's `modelMarked`
say which types a model marks; the Rust validator keeps the frozen Node
server's wording for a misplaced marking scheme. No model writes this type:
generation, extraction and the bank pilot's schemas leave it out, since adding
it would change what they are sent.

Answering (`src/features/quizzes/drawing/`): before drawing, the part shows one
generic squared grid with Draw answer (E1, Epo 2026-11-06), the same for every
drawing part. It is a whole number of 52 px cells across (up to ten) and of 13 px
rows down, about 52:30, with its closing right and bottom lines, so a narrow
column such as a canvas card never cuts it mid-cell (Epo 2026-11-13). Draw answer opens the board full screen (`DrawingBoardScreen`,
loaded with BlockSuite only then): the question pinned at the top left, folded to
one line under a top bar on phones, and Done at the top right, both hidden while a
card (a plane, a chart) is open full screen with its own Done. The board shows a dashed
answer area of 1,920 × 1,200 board units with a small "Answer area" label at its top
left (`answerArea`, W3 and W4, Epo 2026-11-07) and opens fitted to it, on phones too;
drawing inside it stays under the wide-board line below. It is on the page only:
never in the marking image, the saved board or a preview, and not shown read only. As it changes
(800 ms after the last change, and at once on Done or when the board goes, so the last
strokes stay), the board is kept on the device (`localDb` `drawingDrafts`) under the quiz
or the assignment attempt (`DrawingDraftScope`), and reopens from there until Done. Done
on an empty board leaves the part unanswered; past 250 KB (undo history stripped)
it toasts and the board stays open; on a board whose marking image would be more
than 2,000 board units on its longest side (`stats().span`, where lowercase
labels fade in the 1,568 px image) it asks first, Keep drawing or Done anyway (W1,
Epo 2026-11-07), though a time limit's Done never asks; otherwise the answer is the board's document
and its WebP marking image, and the part shows the drawing with Edit drawing.
Checked, it shows its verdict, the drawing and Open drawing, the whole board read
only. A time limit running out with the board open presses its Done before the
assignment is submitted; an assignment closing does not.

Saving (migration 0156 `drawings`, `server/internal/store/drawings.go`): a
practice board stays on the device until Check, which sends the board and its
image with the answers; an assignment's goes up on Done (`PUT
/api/assignment-attempts/{id}/drawings/{partId}`). The part's answer is then
`{"drawing": id}`. The person attempting pays for the board (Epo 2026-11-06),
through the storage gate. The marking image is kept only while its part waits on
marking (Not marked), and never under "Manual grading only". No picture of a
drawing is stored: answers, results, Approve, the report and Files › Canvas draw
it from the board (`drawBoardPreview`, `DrawingPreview`), fetched through `GET
/api/drawings/{id}` by the member or the assignment's staff. A practice board goes
when its quiz is deleted for good, an assignment's with the assignment; a leaving
member keeps their unmarked boards and loses the marked ones.

Files › Canvas (`CanvasTab`, mocks S2 and S3) lists the payer's drawings whose
parts are marked (`GET /api/drawings`), named by the quiz with no score; the
payer deletes one (`DELETE /api/drawings/{id}`) or all (`DELETE
/api/drawings`), the marks staying, and the result then says "Drawing deleted".
Billing's storage bar splits into Files, "Images and audio" and Canvas
(`BillingInfo.storageBreakdown`, recounted from the same rows as the meter;
see [backend-storage-quota.md](backend-storage-quota.md#counter-model)).
Marking (M1, Epo 2026-11-07): a drawing goes to the grading slot's model on the
open answer's path, credits and settings, its marking image sent as a data URL
in place of the answer (`grading.py` `drawing_message`), with the system prompt
plus `DRAWN_SECTION`; open-answer calls are unchanged. A drawing's quotes are not
checked against text and it gets no copy check. A part left Not marked keeps its
image so Check again (practice) or Mark with AI (assignments) can give it its one
marking later; the image goes once that marking lands (`DropDrawingImages`),
before any approval. The grading slot requires `vision` (M4, Epo 2026-11-07,
`models.slotRequirements`).

A quiz's drawing part may hold a drawn sample answer (Q3): `answer.sample:
{board, image}`, two of the quiz's editor assets, the board gzipped under the
`board` purpose (migration 0158, a drawing's 250 KB cap, kept out of Files ›
Embeds) and the image an ordinary quiz image. The bank refuses it. The live
quiz keeps it with the keys (`sampleBoard`, `sampleImage`), and it counts,
copies and freezes with the quiz's other assets; a copy missing either asset
drops it whole. Authors draw it as the first block of the part's Solution in
the quiz editor and the question dialog (`DrawnSampleField`, A1–A3); results show it drawn from its board, and marking sends its image
before the student's drawing. Its board takes no pictures (Epo 2026-11-10):
the sample names only its board and image, so a picture's file would have no
reference to keep it.

In an assignment, Done on an emptied board deletes the part's stored drawing
(`DELETE /api/assignment-attempts/{id}/drawings/{partId}`), so it is neither
submitted nor charged. A board still being drawn on the device belongs to the
signed-in account: `claimAccountData` deletes another account's drafts, and
everyone's on sign-out.

A checked model-marked part (open or drawing) shows its marking scheme in the
open, each point with a tick, a dash or a cross and its marks, with the
sample answer under it and the Solution folded below (R1, Epo 2026-11-06;
sample section 2026-11-15, `QuestionReview`).

### Grouped parts

Exam papers print one more level, such as (b) with its text and figure, then
(b)(i) and (b)(ii). The format stays flat (Epo 2026-11-04): an optional
`groups: [{id, blocks}]` on the question and an optional `group` id on a part. A
group holds text and figures, a stem's block kinds and caps counting towards the
same size limits, and has no answer or marks; it may hold no block, printing as
a label alone. Parts stay the one unit for answers, marks, grading, attempts,
answer events and review, so nothing keyed by part changes. One level only: a
group is strictly `{id, blocks}`, so it holds no group. A part's `group` must
name a group of the question, a group has at least one part, and a group's parts
sit next to each other in `parts`; a group has no place of its own, it sits where
its first part sits. A group's id is checked as a part's is, non-blank and at most
128 characters, so a stored `sheet 1.a` opens and saves in the quiz room, and so is a
question's, so a stored `q1.1` stays in it; only a key a client creates there must be
letters, digits, `-` or `_`. Every validator refuses the rest, on the shared `group-*`
fixtures. Reads of a live room repair what a merge leaves instead
(`repairGroups`, [plate-editor.md](frontend/plate-editor.md)).

Labels are computed, never stored (`src/features/questions/groups.ts`): a
top-level item (an ungrouped part or a group) takes the question's `labels`,
(a), (b) or 1., 2.; a part inside a group takes (i), (ii), (iii). A lone part
needs no label, but a question's one part inside a group has one, since its
group is printed beside it. Where nothing beside a part shows its group, it is
named in full: "(b)(i)" or "2(i)" (the dialog's hidden answers, the export's
answer key), and "Part B(i)" in an issue.

Board U2, G1: in `QuestionView` the group's label and text sit at part level with
no marks; its parts sit next as siblings in the same list, each with its own
marks, and the header's total is unchanged. A sub-part's label steps 16px in from
the question's own 36rem (`Label`), the same switch the layouts use, and
lines up with the group's below it (phones, the Study panel); the text column
stays where it is, as wide as the widest label with its step. A multi-part
question's part shows its marks in words ("2 marks"), as the board does, not
`[2]`, and once checked the header totals them ("6 / 8 marks", `QuestionReview`).

In the question card (board Parts, Epo 2026-11-15) the footer's Add part adds a
part at the end (in the card's ⋮ on phones, and in a one-part quiz card's ⋮).
There is no separate Group item (Epo 2026-11-16): a top-level part's ⋮ has Add
sub-part, which turns it into a group (`splitPart`): it stays (i) with its
text, answer, marking points and explanation (every part needs text of its
own), a new (ii) opens under it, and the group's shared text above starts
empty for the teacher to fill. The shared text and figures sit at the card's top, then each part
as one line (label, first words, answer type, marks) until clicked, with no
dividers between them; the open part, unoutlined, keeps its label and text
where its line had them and adds its own type menu, answer, Explanation button, marks and ⋮
(Move up, Move down, Add sub-part on a top-level part, Shuffle options, Remove
part or Remove sub-part). Sub-parts go one level deep, so a sub-part's ⋮ has no
Add sub-part. A group shows
its label and text with its parts under it, and its ⋮ holds Move up, Move down,
Add sub-part, Ungroup and Remove. A group moves as a whole among the top-level
items, past a part or another group, and a sub-part only among its group's
parts, so nothing moves in or out of a group. Ungroup turns its
parts into top-level parts where they are, its filled blocks joining its first
part's top (off when they would not fit there), and Remove takes the group and
its parts (off when they are all the question has). Removing a sub-part that
leaves one turns the group back into a plain part, as Ungroup does
(`removePart`), so Add sub-part then Remove sub-part on (ii) gives the part
back as it was. A group's last part cannot be
removed on its own; its Ungroup or Remove takes it.

Group text counts where stem text does: the grading text (below), the review hash
([study-progress.md](study-progress.md)) and index text
([embeds.md](embeds.md)). The chat agent's tools, generation and extraction do
not offer groups yet. A grouped question the agent reads stays as stored in
`inspect_document`, as a multi-part one does: `authored` declines it, so an edit
of the note cannot drop its group. Quick review skips a part inside a group
(`quickQuestion`).

The Go validator is `server/internal/questions`; the browser and collaboration
service share its JSON fixtures. Bounds originate in
`server/internal/fieldlimits` and are generated for TypeScript and Python by
`pnpm gen:openapi`. A count or text length that two people's edits merged at
once can pass (a section's blocks and texts, a question's parts and groups, a
part's marking items, answer lists and texts, table rows and columns, chart
series and labels, graph elements, a sample answer, a quiz's parts) is taken
up to twice its cap by readers, room admission, the store's checks and every
validator outside the bank (Epo 2026-11-22, "Yes, A everywhere";
`fieldlimits.Merged`, `limits::merged_cap`, `mergedCap`): nothing up to twice
is trimmed, hidden or refused, and past twice is refused. Editors stop at the
cap itself, checked against the question or quiz as it reads when written.
The bank holds every cap exactly (`Policy.held`), its questions being written
whole. The shared fixtures hold each at twice (`*-at-twice`) and one past it
(`*-past-twice-rejected`, `*-over-limit-rejected`, `*-long-rejected`). An open
part's one sample answer stays one (`OPEN_ACCEPTED_MAX`, on every layer), since
its field shows one (Epo 2026-11-22, "then last save wins? if we change the
question data structure now we need to change the UI as well, dont"): every
live writer (`writeSample` in the browser, `quiz::sync_sample` in Rust) puts a
new one under the fixed entry key `sample` (`SAMPLE_KEY`), so two editors
typing the first one at once set the same key and one of the two wins (Yjs
keeps the entry of the client with the higher id), and a removal wins over
typing at the same moment; the other's first keystrokes, typed before the
peer's entry arrived, are dropped, and from then on both type into the one
text. An entry held under another id
(seeded or generated) is edited and removed in place, never joined by a
second. Go writes no live quiz documents: its Plate JSON is seeded into the
room by the collaboration server's writer. Bank parts
require worked solutions; user quiz solutions are optional. Levels are optional metadata and the unenforced timer was removed.

A question may carry topics of its own (Epo 2026-11-15,
`todo-question-topics.md`, several since the same day: "let a question have
multiple topics"): an optional `topicIds`, at most `QUESTION_TOPICS_MAX` (5)
distinct non-blank ids of at most 128 characters each on every validator
(fixtures `topic`, `topic-blank-rejected`, `topic-duplicate-rejected`,
`topic-too-many-rejected`). Absent or empty means the quiz's topic; a question
with topics of its own counts fully under each of them, not the quiz's. The
format does not know the workspace, so nothing refuses an id on save; readers
keep an id only when it is one of the quiz's workspace's topics, so a deleted
topic, or a quiz moved to another workspace, drops out (all of them gone reads
as the quiz's topic again) and no other workspace's topic name is ever shown.
Nothing wipes the ids (Epo 2026-11-15): deleting a topic, moving or copying a
quiz and a single-item clone leave them in the content and the live document,
so a quiz moved back counts its questions' topics again. The live quiz keeps
the list as one plain value in the content document beside `level` (it is no
key; never written empty, and the room refuses anything but 1 to 5 distinct
ids), and it stays out of the review hash, so changing it resets no review
state. The learner view leaves it out,
but learners may still receive the ids (Epo 2026-11-15): in check results and
stored attempt questions (`questions.Graded` keeps every key), in the live
content document they join, and as the question topics in an assignment's
`topicIds`; nothing on their screens shows them. A workspace clone renames
them to the copied topics' ids, dropping one with no copy
(`materialdoc.RewriteQuestionTopics`); other copies carry them as they are,
the read rule ignoring those that are not the target's topics. Generated,
converted and chat agent questions carry none (Q3): the generate boundary
refuses the field, and the agent's `authored` declines a question with any so
an edit keeps it as stored. The quiz editor's open card shows a Topics field
in a workspace quiz with topics, in its footer before Marks (its own row above
the footer on phones): a multi-select (board "Several topics per question" on
the question editor mock) of the workspace's topics with checkboxes. A
question with none of its own shows its quiz's topic ticked, which it counts
toward (Epo 2026-11-15: no "Quiz's topic" item), and unticking the last one
leaves it following the quiz again; a bank question's menu starts with "No
topic" instead. The trigger joins the names in the workspace's order with ", ",
cut with an ellipsis; with five ticked the rest are disabled. The
menu stays open while ticking (`TopicField` in
`src/features/questions/TopicField.tsx`, placed by
`src/features/quizzes/QuestionPane.tsx`); its topics query stays out of the
error boundary, so while they load or fail the field is simply absent.

The chat agent does not write this format (Epo 2026-10-13). It writes a
multiple-choice question with one correct option, a short answer with an
optional unit, or an open question with marks and a markscheme, and adds a
chart, a plot or a library figure to a question separately; the retrieval
service expands each into one paper-layout question with one part, 1 mark
for a simple one and the explanation as its solution (see
[agentic-retrieval.md](agentic-retrieval.md), Question tools).

Make a quiz reads questions printed in an uploaded paper into this format: in
paper layout, printed option order kept, sub-parts flattened into parts. The model
reads a scan or an image from its page images alone, and a born-digital PDF with its
indexed text beside them. A map call lists the questions, copy batches copy them with no answers, and solve batches give
their keys, marking items and worked solutions, or a separate mark scheme or answer
file does, paired by printed label, which needs no solve call for a question it wholly
covers. Each question is checked by this validator as it is copied and as its answers
arrive, and each figure the page shows is cropped into an image block whose asset is
the quiz's own, like an uploaded quiz image. This format has no key-less form, so a
question with a part whose solve call failed is incomplete: it stays as copied, in the
quiz's live room only, like an incomplete question an editor is typing. It isn't marked
or counted, and a learner who checks it sees "No answers configured"; the run's report
names it (see [agentic-retrieval.md](agentic-retrieval.md), Make a quiz, and
[frontend/plate-editor.md](frontend/plate-editor.md)).

### Make a quiz screens

`src/features/makeQuiz`, for those who may edit the workspace (a viewer's `?make=`
link shows the Dashboard). The Dashboard's Make a quiz and Study's Add practice open
it as New quiz (Epo 2026-11-14, Add quiz until 2026-11-20): its files step is the Extract from file way (Convert to
quiz until Epo 2026-11-20), the first of the cards New quiz opens on (Epo 2026-11-20),
beside Generate quiz, From question bank and Create blank (`tabs`, [study
progress](study-progress.md)); a new assignment's Make a quiz from a file opens it
alone. The files step's footer holds a switch, Hide the quiz (Epo
2026-11-11), on by default wherever the dialog opens (Epo 2026-11-16; it was off from
Study's Add practice until then): `CreateExtractionReq.hidden` goes with the run, `question_extractions.hidden`
(migration 0169) keeps it and the saved quiz takes it. From a graded quiz's
dialog the run also sends `gradedQuiz` (`question_extractions.graded_quiz`), so
its quiz is saved waiting for the graded quiz. The dialog holds the choice,
so a reload on a later step starts from its default again. Files uploaded in the dialog stay
hidden either way, as its first line says.

One dialog (`MakeQuizDialog`, Epo 2026-11-05, "make the select pages from files the same
dialog rather than inside a page") runs from the files through their pages and the map to
the questions found, over the Dashboard, then gives way to the upload panel. Each step
gives the dialog its title, action and body (`DialogStep`); phones show it full screen. Each
step is an address, `?make=files`, `?make=pages&paper=…&answers=…&quizFile=…` and
`?make=run&run=…`, so the browser's Back walks them and a link or reload opens the step.

- **Files.** Up to `EXTRACTION_PAPER_FILES_MAX` (5) question files, such as a photographed
  paper's images, and up to `EXTRACTION_ANSWER_FILES_MAX` (3) mark scheme or answer files,
  from a menu of the workspace's indexed files other than Excel and audio or a new upload.
  The question paper's Upload a file is a dashed box under its menu (`UploadDropZone`, the
  Add file dialog's, Epo 2026-11-22) that also takes files dropped on its list
  (`useFileDrop`) and whatever is pasted on the step outside a text field
  (`usePastedFiles`): files as named, a copied image or screenshot as "Pasted image.png",
  and text alone as "Pasted text.txt" (`pastedFiles`). The answers keep Upload a file in
  their menu, so a paste only ever means the paper; a drop anywhere else is refused.
  A row names the file, with no page count: reading one would download a Word or PowerPoint
  file just to show it (Epo 2026-11-06).
  Each list keeps its Choose a file trigger (`ChooseFileButton`, shared with a task's and
  an assignment's Files) above the files chosen, each 32px row ending in a small muted ×
  (`RemoveFileButton`) in place of Change or Remove, with no dividers; its menu ticks the
  list's own files and stays open for more until closed, a ticked row takes its file off,
  and a file the other list holds is left out. At the list's cap the trigger still opens
  the menu, whose unticked rows and Upload a file (the paper's box) are disabled (Epo 2026-11-12).
  An upload takes the normal path (`useQuizUpload`, `startSourceTransfer`), hidden from
  members and in no topic. The upload panel sits under the dialog, so an upload from the
  dialog closes it (Epo 2026-11-09) once every file picked has started, since the browser's
  page count happens in the dialog, and the panel follows the files as below. A file from
  Files still being read is greyed out in the menus, "Reading pages" beside it, until it is
  read (Epo 2026-11-12; before, picking one closed the dialog as an upload does), so a pick
  never closes the dialog; a file still reading when the step opens from a link shows
  "Reading pages" on its row. Continue waits for no file to have failed; one that failed or was stored without parsing holds it until
  removed. With every file read it goes on to the pages. With any still reading (Epo
  2026-11-05, "upload might take a while") the dialog closes and the upload panel follows
  them (`quizWaits.ts`), one row at a time: the files' upload rows while they read, then the
  quiz's row, and a toast with it, offering Make quiz, which opens the pages, anywhere in the app. A file that
  fails no longer ends the wait (Epo 2026-11-09): once every file is through, the quiz's
  row names the lost ones and Make quiz opens the files step with those still good and a
  banner naming the lost (`useQuizNotice`); with every file failed the wait leaves the
  panel and an error toast offers Try again, which opens the files step empty. A failed
  upload row shows its failure as any upload's, with no Try again. The panel's close hides
  a wait while it reads; its row comes back when it ends. A toast's Make quiz with another Make a quiz dialog
  open starts that dialog again on the new files (`useQuizDialogKey`); the panel's own button
  sits under the dialog's overlay. The wait's file names and ids stay in `localStorage`
  (`capy.quiz.waits`, with the account they belong to, dropped when another signs in), so a
  reload finds it and takes the statuses from the server; a file whose bytes a reload cut off
  has no id, so it counts as failed. The runs the panel follows stay the same way
  (`capy.quiz.runs`, ids only, progress from the server), until the panel is closed or the
  server no longer has the run. Another tab that loads meanwhile reads the same list, so
  a file still sending there shows as failed in that tab. An
  upload has the Add dialog's checks: size, compression, name length and the workspace's file
  room. One that would be stored with no text (a password, too many pages, or no credits for
  its parse) isn't sent: an error names it and its row goes.
- **Pages** (`usePageStep`, Epo 2026-11-05, "use the 2 column design ... like what we did for
  workspace settings"). Two columns in a tall frame: the files with their counts on the left, a
  divider between Questions and Mark schemes and answers when there are both, one file's pages on the right, and on phones the same as settings, a list and then a file,
  with Back returning to the list, all under one title, "Choose the pages for the following
  files" (Epo 2026-11-21). A lone file needs no list. Every PDF, Word, PowerPoint and image
  file picks pages, answer files too; an image is picked already. A text file goes whole and
  counts for none, so the step neither lists nor shows it, and when every file is one the
  step is skipped: the files step's Continue does what Extract or Next would (Epo
  2026-11-21). One click selects a page, up to `EXTRACTION_PAGES_MAX` (30) across
  the files, and the Select all checkbox takes a whole file up to the cap. Each page has the
  From question bank checkbox beside its number (`CheckBox`, `CheckRow` for Select all; Epo
  2026-11-21), and its columns, at most three and at least 220px, fill the pane. The bottom bar holds "Selected:
  N pages (max 30)" with no divider above it (Epo 2026-11-21), Back (not on phones, whose
  title arrow goes back) and Extract from file
  (Extract questions until Epo 2026-11-11, then Convert to quiz until 2026-11-20; Next in New
  graded quiz), and sticks on phones; Change files and Cancel left it on Epo 2026-11-21. Back
  goes to the files and keeps the picks of files left in. Extract waits for answer files still
  reading, an answer file with no page picked and Word or PowerPoint pages still drawing. One
  that failed after the dialog says so in the list and doesn't hold the run. A refusal shows
  in the bar (`extractionRefusal`). The quiz takes the paper's name, the next number when it
  is taken. A Word or PowerPoint file's drawing frame sits on the body, so a hidden step or
  file still lays it out, and nothing draws before the pages first show.
- **The run** (`useRunStep`). Reading until the map ends, closable: the run keeps going, and
  a toast with Review reopens it when it has found the questions (`extractionEnd.ts`). Then
  the questions found, their price at 4 credits each and what finding them cost, naming any
  answer file left out unread. It offers at most the first questions whose map parts fit one
  quiz's 150 (`fittingQuestions`, Epo 2026-11-21), lists and prices only those, and says so.
  With credits short it offers the first questions they afford
  and Get credits, in a new tab so the run waits and the balance reads again on return.
  Only Cancel ends it, back to the pages with their picks: a stray click, Escape or route
  change doesn't lose the map it paid for.
- **The panel** (`QuizRunRows` in `SourceTransferPanel`, `quizRuns.ts`). Confirming adds the
  run to the upload panel: Copying 8 of 12, then Answers 5 of 12, half the bar each, read
  from `GET /api/extractions/{id}` every 3 s. It ends in Open quiz, with "Some questions may
  be incomplete" when the report left anything out, or the failure chosen by `errorCode`
  (`extractionFailure`; the row's `error` text never shows) with Try again. A run in the
  panel gets no toast. It depends only on the row's status, `errorCode`, `recorded`,
  `answered`, `confirmed`, `quizId` and `report`, never on how a run batches its calls.
- **Phones hide the chat dock** while the dialog is open; the chat stays mounted, so it keeps
  its draft and stream.

Quiz materials remain Plate/Yjs documents. A void `quiz_question` node stores
the question as an attribute, with the same ID and one empty text leaf. Part
IDs are unique within the material. Note chart/plot/graph voids store their validated
block under `block`; their Markdown fences round-trip that JSON. Old question
nodes and old question JSON are rejected, without a compatibility converter.

## Editing and assets

A quiz is edited where it is open, like a flashcard set: for someone who may
edit, the material page (`CenterContent.tsx`) renders `QuizEditor`, which joins
the quiz's content and keys rooms and edits live (live-items, Epo 2026-10-10; see
[plate-editor.md](frontend/plate-editor.md)): there is no Save or Reset, and no
switch. Files' Edit and New quiz open
`/materials/{id}`; there is no standalone quiz edit page, and
renaming goes through the item's Rename.

The editor is a page (board X2, Epo 2026-11-02; cards, Epo 2026-11-15, boards
Main and Phone; rail, Epo 2026-11-15, boards ListA and ListA2): a 60px rail of
question numbers on the left as Canvas's Build page has it (`QuestionRail`: the
open one dark, one with an issue dotted; its ≡ opens the outline of number, type
icon, first words, an issue's warning and marks, as Canvas's Question
Navigator; the numbers scroll between ≡ and, at the foot, + and From the bank,
which add after the open question, else at the end, as the floating bar does
(Epo 2026-11-16), faded at an edge with more and no scrollbar; a number drags
to reorder, `useRowDrag` into `moveQuestion`, and any reorder slides each
number from its old place to its new one in 200ms, none with reduced motion,
Epo 2026-11-16), and the questions as Google Forms cards on the right
(`QuestionPane`), the AI-marked count and Sources under them. Answering and
studying keep the full question list. No card opens with the page (Epo
2026-11-15): the keys arriving after the opening paint shift nothing open,
and closed cards draw what the content already holds while they come
(`PartKey`'s `pending`): choice and True / False rows unmarked, a short
answer's empty pills and unit, a gaps part's blanks from its text, each part
line's answer row (a choice part's options, else blank). Matching, ordering
and marking schemes live in the keys alone and still grow on connect.
Before the rooms sync the cards wait (`inert`) while the pane still scrolls,
and the page keeps that scroll as the live cards replace the paint
(`useQuizPick`'s `scrollTop`). The open card has a 2px accent
border and edits in place (`QuestionCard` in `src/features/questions/`): issues
at its top, its number row (number; a lone question's Add image and answer
type at its right, so the text keeps its width), the text (each text block
edited where it stands, with the formula
tools and an Insert + of Text, Table, Chart, Graph and Image while editing), the
answer type menu (`AnswerTypeSelect`: Multiple choice, Multiple answer,
True / False; Short answer, Long answer, Fill in the blanks; Matching,
Ordering, Drawing), the answer, marking points and Solution, then a footer of
Solution, Topic, Marks, Duplicate, Delete and ⋮ (Add to bank, Move up, Move
down, Shuffle options for a choice part, Layout, Part labels). Tables, charts, graphs and
plots show as figures with hover Insert below (+, the open text's Insert menu,
adding under the figure; Epo 2026-11-16), Move up, Move down and Remove; a click
edits one in `BlockDialog`: a chart or graph live, each change written as it is
made and Done only closing (Epo 2026-11-16, D13; see
[plate-editor.md](frontend/plate-editor.md), the bank's draft takes each
change at once too), a table staged until its Save. The dialog's Remove block is
pulled left by its padding to line up with the content (Epo 2026-11-16); a
graph opens in the graph editor instead (see the graph section below). An open text's formatting row ends
in Move up and Move down for the paragraph or display formula holding the
caret (`TextEditor`'s `moves`): it moves within the text, and at the text's
edge it moves past the next block as a text of its own; a text of one line
moves whole. It stays open where it went, and a gaps part's blanks keep their
answers and renumber (`gapListsByBlock`, `withGapsBlocks`). Taking a display
formula out from between two paragraphs (Delete or Backspace, or closing one
left empty) joins them back as one (`formulaJoin.ts`): directly where the seam
has a space, else with a line break; an empty formula is never written as `$$$$`.
A table there is drawn as a
note's table (Epo 2026-11-15, `TableBlockEditor` in `BlockEditor.tsx`, the
pills shared through `src/features/notes/blockMenu.tsx`): a row's pill drags the
row and opens Insert above, Insert below and Delete; a column's pill over its
first cell opens Insert left, Insert right and Delete; + bars along the right
edge and under the last row add one at the end; Header row toggles beside the
cell's formula tools in the dialog's heading row. A cell at rest lays its text out as the open cell does (4px from its top, 20px lines), so opening it to type moves no text (Epo 2026-11-19). The other cards are drawn in the
open card's own layout (`QuestionCardView`, Epo 2026-11-15, as Google Forms'
closed cards are): the number row with marks, the first text beside the
number where the card is 32rem wide or more (Epo 2026-11-16; opening moves it
under the number, a shift Epo accepted; a gaps part's text stays under it),
the rest at the open card's width, each answer type as its editor draws it with the controls' room kept
(`PartKey`): choice rows with "Correct", ordering's numbered rows, short
answer's Accepted answers pills and Unit, the blanks' pills, matching's Rows
and Columns lists (their Add rows' room kept) above the Correct answers grid,
a long answer's or drawing's marking points with their marks, a
group's ⋮ room; images centred at their size in both (Replace is in the open
card's hover tools); a question of parts in a line a part, one column
whatever the question's Layout (members' paper or split layout shows in
Preview), so opening one only adds its controls. A click opens it and keeps
it where it was clicked; on a question of parts the part clicked opens with
it (none from the rail), its label and text staying where its line had them. Closed cards are memoized on their question object, which
`useQuizQuestions` keeps while its JSON is unchanged, so typing in the open
card re-renders it alone. Add question floats beside the open card where there
is room, else in a bar at the bottom, and adds after it; a quiz with no
questions shows it in the cards' column at every width. Picking Multiple choice
on a part with several correct options keeps the first and drops the
`multiple` flag (`answerOfKind`); turning Fill in the blanks into another type
keeps the text, each numbered blank becoming a plain line, and drops only the
untouched sample sentence (`withAnswer`). A text block open in its editor
closes when its column's figures move or go, or when anyone else adds or
removes a block in that column, since rows are keyed by place. A figure's Save
writes into the question as it stands. It sits under
the normal header, beside the workspace's left panel: the quiz with its chip, ⋮
and save state, then Undo, Redo and Study. Until its rooms sync the same page shows
with a working rail and a question that takes no input: drawn from the device's copy
with its keys, else from the read, with answers waiting rather than a key it doesn't
know. Phones show the cards alone, the closed ones whole as on wider screens
(Epo 2026-11-19), 10px from the pane's sides and 12px inside, with the
type menu full width, the footer wrapping and Solution, Sample answer and Add
part in the card's ⋮; below md the rail hides. A full closed card carries an
issue's warning at its top right. A
question added stays as it was added, opened or not (Epo 2026-11-15, as
Google Forms keeps each card; a new question starts filled in). A note's quiz embed
in Edit is the same cards (Epo 2026-11-15, `QuizForm` with `QuestionPane`'s
`embedded`): in the note's flow and scrolled by it, no card outline, no rail
or floating add bar but Add question under the cards, Undo, Redo and the live
state above them.

`QuestionDialog` (board Dialog, Epo 2026-11-15) is the same `QuestionCard` in
a dialog, used by the bank (`ItemBankList`, `/qb`): Edit question with its
close, the card (Add part in its footer), the Topic row under it when the
class has topics, then Save. A quiz's questions never open it: they edit in
place on the quiz's page and in a note. There is no outline or "Edit all details" any
more. Its title names the question ("Edit question 10").
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
marks, image links) read "Finish the question and its answer."; an image
block added but not uploaded yet (an empty link) reads "Image: choose an
image file" on its row, and the asset-host rule skips it. The dialog
shows one issue box at the top of the body with the first issue and
"(+n more)" (`IssueSummary` in `IssueViews.tsx`, also at the top of the quiz
page's open card and under each question in `QuizForm`); a block editor shows
the same box for its own issues under its inputs, so it never moves
them (a graph lists its own), and a warning icon right of each affected
title in a read question (`IssueIcon`, through `QuestionView`'s `titleAside`:
the question's for question-level and generic issues and for a lone part,
each part's for its own) whose tooltip lists that title's issues. User-facing wording says blanks ("Fill in the blanks",
"Blank 1"); the stored type stays `gaps`. Menus (Insert, the card's,
a part's and a group's ⋮, graph element actions) are the note toolbar's popovers
(`ToolbarPopoverContent`, `ToolbarPopoverGroup`, `MenuItem` over
`ToolbarPopoverItem`), and block editors use `FieldInput` and `SelectField`,
the compact underline style of the answer options. It reuses
`ToolbarGroup`, `ToolbarButton` and `SimpleDialog`; `BlockDialog` keeps
Remove block beside Save (a table, a plot) or Done (a chart, a graph). English and Chinese labels use
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
unit and blank accepted answers, a blank's included (no accepted
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
(Epo 2026-10-17), and a question's credit is its bank `sources`. An open part's marks are its marking items' total (`schemeMarks`, live and
staged alike), and every reader of a live room's keys takes the total, so
items two editors added at once read as worth what they add up to: the
editor stops adding items at a total of `QUESTION_MARKS_MAX`, so a total two
people's adds take past it is a limit a merge can pass, kept up to twice the
cap (Epo 2026-11-22, "Yes, A everywhere"). Learners, who never read the keys,
get each marked part's total on the room's reader lists (`quiz-items`).
Outside the bank any part's marks may reach twice `QUESTION_MARKS_MAX` (40) on
every validator and in the room, a closed part's too, so marks written while
another editor turns the part closed both go in (fixtures
`quiz-open-marks-at-twice`, `quiz-open-marks-past-twice-rejected`,
`quiz-closed-marks-at-twice`, `quiz-closed-marks-past-twice-rejected`). A
total past 40 (three or more editors' adds at once, or a hand-made client) is
not refused by the room: it stays the explicit warning the user tunes (Epo
2026-10-14), and the question is left out of the stored quiz until it is
tuned. The bank holds the total to the cap and names the mismatch. Every live
writer (`writeQuestion`, `quiz::put_question`) writes a part's own marks as
the total it reads, at most 40, so an edit to a part worth more is still
admitted, and a part turned closed is brought back to the cap (`withAnswer`). Graphs store a bounded
recipe and a static rendering. Recipe elements are function graphs,
points, lines, segments, circles, labels, angles (three points with the vertex
in the middle, drawn under 180° with a square mark at 90°), arcs and sectors
(counterclockwise from the first point around a centre) and polygons (3–12
points); sectors and polygons can be shaded. A segment's `ticks` (1–3) draws
hatch marks, so equal sides carry the same count. Every graph surface draws
with one engine, `src/features/graph/` (no React, no BlockSuite, plan step 1,
Epo 2026-11-16): `model.ts` holds the one element model every surface stores
(quiz, note and bank graphs and the canvas plane; `questions/types.ts`
re-exports it), the ten constructions above plus the free marks below,
`view.ts` the camera (`{left, top, ppuX, ppuY}`, zoom clamped to 10⁻¹⁵–10¹⁵
pixels per unit in the question editor and 10⁻⁶–10⁶ on the canvas plane), the
tick rules and the Fit bounds, `draw.ts` one `drawGraph` onto a canvas 2D
context, `svg.ts` the same calls recorded as SVG (`graphSvg`: coordinates to
0.1 px, clipped groups, haloed labels as one `paint-order="stroke"` text;
a formula's stretched signs as KaTeX's own paths), and
`gestures.ts` the plane's gestures. The look is the canvas plane's everywhere
(D5/D14): 2 px round-capped ink, 4.5 px points with their names, 15 px labels
centred on their position and wrapped at 200 px, a fixed 24 px angle mark,
light or dark paper in the editor and white paper in every export. The graph
editor (`GraphEditor.tsx`) is the one graph editor (Epo 2026-11-17): quiz and
note graphs and the canvas's plane cards open in it, and it looks and behaves as
the plane's editor always did. `BlockDialog` opens a figure in a dialog filling
the screen with no title row or footer. The graph fills the editor; the rows'
list floats over its top left (a 300 px card under a list button, a sheet over
the lower half on phones; open on wider screens, shut on phones, the last
choice kept for the session), the tools float at the foot, and the top right
holds the ☰ menu (Fit to screen, at least 10 units each way; Undo, Redo and
Clear all for a plane; Full screen and Remove block for a figure; a − % + zoom
row whose 100% is the scale it opened at) and Done. A figure's view is its
stored size around the editor's middle at the editor's scale, as a canvas
card's camera is: a settled pan or zoom writes that as its `bbox`, and typed
bounds or size move the view; its frame is not drawn, so Full screen shows it
as readers will. Leaving the dialog fits its window (Epo 2026-11-18,
`fitWindow` in `src/features/graph/fit.ts`): once a mark or the view changed
in it, the figure keeps its size, as Desmos's Zoom Fit and Matplotlib's
autoscale keep the picture and move the window, and the window takes the frame
round its marks, labels' and formulas' text and functions with 40 px to spare,
scaled to fill the figure and centred, its units' ratio kept (zoomed in for a
small graph, out for a wide one). Not the origin: other apps fit to what is
drawn, so a graph far from it keeps its scale. The frame depends on what is
shown, so it is fitted again until it settles and a second Done keeps it.
Typing a size or bound in Advanced keeps what was typed for that visit;
nothing changed leaves it alone. One Undo takes the fit back. Functions count
as the ☰ menu's Fit samples them (`functionReach` in `curves.ts`), across the x
range shown and the marks' together (their restriction if set), as a plotted curve
counts over its plotted range in Matplotlib and Mathematica, at 101 even
steps; one that runs off to infinity there (an asymptote, found by halving
towards the larger end until it runs off or settles at a peak) leaves out
values past Tukey's far fences (three interquartile ranges out), as
Mathematica's automatic plot range drops outliers, while any other keeps every
value (a narrow peak, ln x beside where it is undefined). A fit counts a
function only within the y range shown, less the 40 px it leaves round a
frame, keeping that range's edge where the function runs past it, so x², x³ or
eˣ fills what was looked at; marks still widen it. A function never within that
range (y = 3x + 10000 on a plane round the origin) counts whole, so the frame
moves to it. An implicit curve is looked for over a box three times the
range shown and the marks' (`equationReach`, a 150 × 150 grid): a part closed
within that box counts whole (a circle crossing the shown edge), a part running
on to its edge (the lines of x² − y² = 0) counts within the range shown and
keeps the edges it runs past, as a function does, so fitting again keeps the
frame; one never within the range counts whole, and with none in the box it is
looked for ten times as wide, so one typed off the view is framed too. Typing a function row wholly above or below the view across the
x range shown moves the view up or down to it, its middle value in the
middle, scale kept (`revealed`, Epo 2026-11-18, though Desmos and GeoGebra
stay put); a plane card keeps that view on Done. The ☰ Fit frames as leaving
does (`fitPressed`: the window `fitWindow` settles on for the editor's view,
at least 10 units each way, an empty graph round the origin), so a second
press changes nothing (Epo 2026-11-18; it once added a 10% margin each press
over a range clamped to the view, zooming out every time). A canvas plane card's Fit to size (`fitMarks`) counts the same
but grows or shrinks the card instead, its size being board layout. Rows are the plane list's: 36 px, the kind's icon (the label of the row's
field: a click types in it), the field, ⋮ with the row's style and Hide above
Delete (Epo 2026-11-18); then + Label and
Advanced (a plane's holds its paper only). `graphSyntax.ts` turns rows into recipe
elements and back, reading each row's LaTeX with its own small reader (no
MathLive, so previews never load it), read as Desmos reads it (Epo
2026-11-18, "the desmos one makes the most sense"): fractions, roots
(`\sqrt[n]{}`, odd roots of negatives negative), powers as LaTeX reads them
(`x^23` is x²·3, only `x^{23}` is x²³), subscripted names, `\left…\right`
brackets (`\lbrack`, `\lbrace`), bars and `|x|` (abs, `2|x|` too),
`\lfloor`/`\lceil`, `\cdot`/`\times`, `\pi`, implicit products, `\le`/`\ge`
and braces; named functions and `\operatorname{…}` with `\sec`, `\csc`,
`\cot`, `\sinh`, `\cosh`, `\tanh`; `\sin^{-1}x` (and cos, tan) the inverse;
`\log` base 10, `\log_{b}x` base b, `\ln` natural. A restriction may be
one-sided (`\left\lbrace x\ge0\right\rbrace`, the other bound open).
Points and commands (`A = (1, 2)`, `segment(A, B)`, `polygon(…)`,
`circle(A, 3)`, `angle(…)`, `arc(O, A, B)`, `sector(…)`) are stored as their
elements. A formula row is stored as typed, as Desmos stores it (Epo
2026-11-18, "store user input as is"): `{type: 'expression', id, latex}` with
optional `dash`/`hidden`, a restriction `\left\lbrace a\le x\le b\right\rbrace`
inside the LaTeX, no grammar checked on any server, at most
`QUESTION_GRAPH_EXPRESSION_MAX` 1000 code points (Epo 2026-11-18, "1000 seems
enough": a rotated ellipse as MathLive writes it is under 200). What it
draws is read where it is drawn (`readExpression`, cached by `markExpression`
in `curves.ts`): `y = …`, `f(x) = …` or a bare expression in x is a function
of x, sampled every 2 px across; any other equation in x and y
(`x^2 - y^2 = 0`, `x = 3`, `x^2 + y^2 = 4`) is an implicit curve,
F(x, y) = left − right = 0, drawn by marching squares over the view
(`equationRuns`): F on an 8 px grid (typed arrays, reused), cells whose
corners differ in sign (or hold an undefined corner) split into four 4 px
cells, each crossing closed in on by four halvings of its edge and
interpolated, saddles split by the cell's middle, the traced runs kept for an
unchanged box and step (the last 32), so a redraw at the same view retraces
nothing. Timings on the Mac for a 1200 × 800 px view moved each frame
(uncached, medians, 2026-11-18): x² + y² = 4 0.5 ms, sin x = cos y 2.6 ms,
sin(xy) = 0.5 5.3 ms (10,759 points), from 12, 16 and 25 ms with one 4 px
grid and a map entry per edge; a loop smaller than an 8 px cell may be
missed, and an edge whose |F|
grows as it is closed in on (a pole, as in x / y = 1) left out so no false line
is drawn across it. A zero set with no change of sign, as (x − y)² = 0, draws
nothing (Desmos draws it; a known limit). Inequalities are "not yet". A row
that can't be read draws nothing and shows its issue. An implicit curve is
picked and erased by its distance to its drawn steps and can't be dragged, as
a function can't; typing one off the view does not move the view. Style (dash, equal-side marks, shading, labels, hide) sits in each
row's ⋮ menu. Focusing a row's field picks as clicking the graph does: a label
row selects its label alone, any other row clears the selection, and with
Shift, ⌘ or Ctrl held the label is added and nothing is cleared (Epo
2026-11-18). A focused function or equation row doesn't light its curve (Epo 2026-11-18,
"the highlight on curve is a bit intrusive"), hovering a row still does. A row's point names are its references; a saved point another
element uses but whose label is not a name gets the row name `P_n`. Issues read
like the question dialog's: the first one (with "+n more") above the editor for
the graph's own (its size or bounds, the row cap), never a row's (Epo
2026-11-18, "never show the error row"), and a warning icon on each row that
cannot be drawn, its message in the icon's tooltip, and beside Advanced when its size
or bounds are invalid; such a row or field is not written until it is fixed
(a cleared description is sent as none). The editor
takes the canvas plane's gestures (D4): the wheel or a two-finger scroll pans,
Ctrl/⌘-wheel and pinch zoom about the pointer, the middle button pans; moves
apply once per animation frame and the visible area is the saved `bbox`,
reported once a gesture settles (150 ms after the last wheel event, or the last
pointer up). It also takes the plane's tools (Epo 2026-11-16, D12), in a strip
with the plane's icons, labels and letter keys, floating at the dialog's foot
as on the plane (above the sheet on phones), the graph kept clear of it so it
hides no x-axis title or numbers (Epo 2026-11-17; Finish sits above the strip
while a line or curve is drawn) (V P L A C O T F E, once the canvas is pressed): Select (a click
picks a mark, Shift adds, a drag on empty paper draws a selection box, as on
the plane, so a primary drag no longer pans; handles, curve bends, label and
formula frames whose corner sizes the text, 8–96 px), Point (each point takes
the first name no point in the graph has, A … Z, then A_1 … Z_1, A_2 …
(`freePointName`, Epo 2026-11-17), so `segment(A, B)` can use it; on the plane
too, where it draws beside the point), Line, Vector,
Curve (Finish, or the last point clicked again; at most 100 points), Ellipse
(not on polar paper), Label (with the plane's symbol row), Formula (a card with
KaTeX's check) and Erase. The tools are `graphTools` in
`src/features/graph/tools.ts`, shared with the plane; points and marks snap to
the grid's small step (polar paper: rings and spokes), labels and formulas to a
tenth of it. Each tool write becomes rows (`rowsAfterEdit`): a moved named point
keeps its name, a new point is a named `A = (a, b)` row, a line or vector a
`(a, b) to (c, d)` row typed in place, a curve, ellipse or formula a row with
its kind's name, as the plane lists them; erasing or deleting a point takes what
is built on it too. A tool at 100 elements is refused and the cap's issue shows; a graph two
people's adds merged past 100 keeps every element, up to 200, and adds none.
Advanced's Paper chooses square or polar paper (`board.polar`). Full screen
opens the graph as shown in the note figure preview. A graph stores no picture
(D16, D11, Epo 2026-11-16): the block is its elements, board, size and
description, the same in quizzes, notes and the bank, and every view (the
question view, the runner, results, note figures, previews, share pages)
draws it with the engine through `GraphView` (a canvas at the block's size,
at most its column's width, redrawn at the screen's density and on a theme
change; `graphPaint.ts` is loaded in an effect, so share pages' Worker HTML
holds only the sized box). `graphSvg` runs only for the note export.
Numbers follow GeoGebra (Epo 2026-10-17): ticks every 1, 2 or 5 × 10ⁿ from
100px of units rounded down, finer grid lines between them, tick numbers plain
(`0.25`, `2010`) or scientific (`5E8`) when the step is under 10⁻⁵ or over
10⁷, an en dash for minus; an axis off the view leaves its numbers on the edge
it left by, as Desmos keeps them (Epo 2026-11-18, "do what other apps do"),
and a y axis with no room left of it numbers to its right. A graph is
120–1200 px wide and tall (120 keeps the bank's 150 px box plots) (`QUESTION_GRAPH_DIMENSION_MIN/MAX`, every server);
a size outside that is an issue, not clamped, and the row count shows the
x/100 counter beside Add label from 90%.
Rows write e-notation as `6.02·10²³` (LaTeX `\cdot 10^{23}`).
The engine draws in plain doubles from the view's corner, so it has no small
number cut-off and its grid holds far from the origin; a grid direction with
more than 1000 lines is left out.
Label text holds at most 60 characters (`QUESTION_GRAPH_LABEL_MAX`) and wraps at
200 px into one SVG `text` per line; point names and angle labels hold
at most 20 (`QUESTION_GRAPH_NAME_MAX`), on every server.
A graph holds at most 100 elements on every surface (`QUESTION_GRAPH_ELEMENTS_MAX`,
D7, Epo 2026-11-16; a point a construction names counts) and takes the canvas
plane's free marks, which hold their own coordinates (D1): a `polyline` (one
point while it is drawn, at most `QUESTION_GRAPH_PATH_MAX` 100; `arrow` puts a
head on its last point), a `curve` through its points with optional [in, out]
Bézier `handles`, one pair a point, an upright `ellipse` (`center`, `radii`)
and a `formula` (non-blank LaTeX up to `QUESTION_GRAPH_LATEX_MAX` 2000 code
points at `coords`, D6). A segment takes `arrow`, a label and a formula a
whole-pixel `size` of 8–96 (`QUESTION_GRAPH_TEXT_SIZE_MIN/MAX`), the board
`polar`. One element check serves every surface: `graphElementSchema` and
`graphElementsIssue` (`validation.ts`) in the browser, run by the graph
dialog's `validateGraphRecipe`, the question schema and the canvas plane's
load check, with Go `questions.graph` and Rust `questions::graph_element` on
the same shared fixtures (`graph-*.json`). All graph limits are question
bounds in `fieldlimits.go`; the board catalog reads the formula card's LaTeX
and the text sizes from them. The graph dialog has no rows for free marks yet:
it keeps each one in its place (a `mark` row) and a segment's arrow and a
label's size as they are. In the note export (`exportGraphSvg`) a formula
waits for KaTeX's layout and its faces, read lazily from KaTeX's own TTFs
with opentype.js (`glyphOutlines.ts`, out of the share Worker's build), and
each glyph is written as its outline, so the SVG in its `<img>` needs no
fonts; a graph without one takes the synchronous `graphSvg`. Implicit curves and inequalities are planned (the central todo list). Question charts sit
at about a graph's width with a centred title and never show a values table.
A `plot` block holds numeric series over numeric axes: optional `kind` (`line`,
the default, or `scatter`), `title`, `xTitle`, `yTitle`, optional `unit`, 1–4
`series` of `{name, points: [[x, y], …]}` (2–60 finite points drawn as straight
segments in x order, or 1–60 drawn as dots for a scatter, Epo 2026-10-14), and optional `lines`
(`{axis: x|y, value, label?}`, dashed reference lines) and `marks`
(`{x, y, label}`), at most 8 of each (`QUESTION_PLOT_*` in fieldlimits). Its
text is bounded as a chart's (Epo 2026-10-17): title, axis titles and unit at
`QUESTION_PLOT_TITLE_MAX` (100), each series name and line or mark label at
`QUESTION_PLOT_LABEL_MAX` (60) code points, on every layer.
`PlotChart` (beside `CategoryChart`, same frame, theme variables and ticks) draws
it in quizzes, notes and chat. Notes edit it (the embed catalog's plot
`edit.user` is `[note]`): the note's figure dialog shows `PlotEditor`
(`BlockEditor.tsx`, the chart editor's frame) with the type (line or scatter),
title, axis titles and unit, a points table per series (a series keeps one
point; add and remove rows and series up to the bounds), and under Advanced
the reference lines (added as horizontal or vertical), labelled points and the
description, the plot drawn beside them once every cell holds a number. New
rows come filled (Epo 2026-10-17): a point copies the row above it (or is
[0, 0]), a series starts with the points [0, 0] and [1, 1] on a line plot
and [0, 0] on a scatter, so it saves as it is, a reference line takes the
last value on its axis (or 0) and a labelled point the last one's place (or
(0, 0)), names and labels starting empty, which every validator allows. An
emptied cell is `NaN` in the draft, which the dialog's issue strip names
("Plot error: …", `blockIssues`) and which holds Save. Quizzes do not edit a
plot: the question dialog shows it (BlockEditor without `editPlot`) and can
remove it, and its add menu does not offer one. Go and the browser
validate it, and so does the Rust collaboration server (`questions.rs`,
`material.rs`: a live quiz question holding a plot and a note's `plot` embed,
with Go's bounds; Node's validator never knew it, Epo 2026-10-12). A live quiz
room keeps a plot as a map of its fields, as it keeps a chart and a graph
(`items/src/quiz.rs`, `liveFigures.ts`; the layout is in
[plate-editor](frontend/plate-editor.md); before 2026-10-13 the room's reader
dropped it, so an agent's plot vanished from the projection). Valid plots are in the shared fixtures
(`plot.json`, `plot-at-limits.json`), so the live quiz round trip and the
browser/server parity corpus carry them; refused plot cases are tested in each
validator, the text bounds by the shared `plot-long-*-rejected.json` fixtures. Grading text lists its curves' points and labels. Graphs keep no
picture anywhere (Epo 2026-11-16): a bank graph is its recipe in the database,
uploads no SVG and the bank's render script makes none; published bank
questions whose graphs still name an SVG file are rewritten without it by
`go run ./cmd/bank graphs` (a dry run listing them) and `graphs --write`, and
the old files stay in the public bucket. Bank assets are raster figures only
(PNG, JPEG, GIF, WebP; the browser draws an SVG upload as a PNG first). Image
blocks keep their source under `image`: bank images use `{ url }`, a public content-hashed
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
Figures are PNG, JPEG, GIF or WebP, capped at a flat 4 MiB, with no plan because the
platform pays; the bank editor shrinks a larger raster image in the browser
first, and re-encodes an AVIF as WebP whatever its size (`uploadBankAsset`,
`src/lib/fitImage.ts`; Epo 2026-11-23, [Image compression and checks](backend-storage-quota.md#image-compression-and-checks)).
`BANK_ASSETS_URL` is the allowed public base URL for stored bank asset references;
it does not restrict uploads to one developer machine. Credentials stay on the
server or publisher. Existing private workspace editor assets are separate.

## Item banks

Item banks (Epo 2026-11-14, `todo-graded-quizzes.md`) are not the `/qb` bank
above: they keep a teacher's or learner's own questions for reuse, in the
shared question format as a quiz holds it (validated with the quiz policy,
`questions.Policy{}`), each with up to 10 free-text tags (35 characters, no
comma). There are two kinds, both rows of `item_bank_questions` (migration
`0175_item_banks.sql`):

- **My bank**, one per account (`user_id`), seen only by its owner. It is the
  third tab of the sidebar's Study page (`/learning?tab=bank`), with New
  question in the page header.
- **A class's bank**, one per class workspace (`workspace_id`), seen and
  edited by its owner and editor members (`assignmentStaff`); a viewer member,
  link or public visitor, and a personal workspace get 404. It is the fourth
  tab of the staff's Study (Overview, Topics, Practice, Question bank;
  `/workspaces/<id>/study/bank`). A personal workspace has no staff, so it has none: its
  people use My bank.

Every route names the bank the same way, `me` or the workspace id
(`/api/item-banks/{bank}/…`); `GET /api/item-banks?workspaceId=` lists every
bank the caller reaches, with counts (Epo 2026-11-21): the class they are in
first when they are its staff, then My bank, then every other class they own or
edit, A–Z (`store.ItemBanks`). Users making banks of their own comes later.
A bank's list (`GET …/questions?q=&tags=&cursor=`) pages newest first and
returns `total`, the filtered count. Search matches `search_text`, the
lowercased stem, group, part and solution text plus answer options, accepted
answers, ordering items and matching prompts (`questions.SearchText`, text
blocks without their bold, italic and underline markers), with
typos tolerated as global search does (`search_typos`, migration 0172: per
word 0 edits under five letters, 1 from five, 2 from nine). A search lists
questions holding the query as typed first, then by fewest typos, then
newest; a question with typos shows only while fewer than three hits are
closer (`listBankSearch`), and its pages carry an offset rather than a
keyset, the hits being re-ranked each page. On a full bank of long questions
a search holding the query takes ~10 ms and a typo search ~0.3 s; Tags
keeps questions holding any picked tag; `GET …/tags` lists a bank's tags for
the filter and the tag input's suggestions. No folders, random draws or item
statistics; at most 2,000 questions a bank (`bank_question_limit`).

**Topics** (Epo 2026-11-15, `todo-question-topics.md`). A class bank's
question may carry topics of its own, the shared format's `topicIds`, of the
workspace's topics; tags stay free text and never count toward mastery. As
read (`bankQuestionRead`), an id the workspace no longer holds, or any id in
My bank, is left out (the list too once empty), as a quiz question's is
ignored. The list shows a coloured badge per topic, in the class's topic
order, before the plain tags (column Topic and tags, `TopicAndTags`), and
`topics=` (comma-separated ids) keeps questions carrying any of them. The bank page
(class bank and My bank) and From question bank have one Filter button at every
width, as Practice's (Epo 2026-11-15, `BankFilter` in `TopicAndTags.tsx`): a
Topic group in a class bank whose class has topics, then a Tags group, still
sent as `topics=` and `tags=`. The bank dialog
shows the Topics field under its card (`TopicField`, "No topic" first).
Add to bank sends the topics the quiz question counts toward (its own, else
the quiz's) into its class's own bank; any other bank, My bank or another
class's bank, gets each topic's name as a plain tag instead, commas turned to
spaces and cut to 35 characters by whole characters (`bankCopy`, `topicTag`).
The dialog's Topics field shows only when the class has topics. A copy out
(`CreateQuizFromBank`, `CopyBankQuestionsToQuiz`) keeps the topics only in a
quiz of the bank's own workspace; elsewhere it follows the new quiz's topic.

Questions come in only by hand: New question opens `QuestionDialog` staged
(`onSave`, quiz policy) on a blank question, and a quiz question's ⋮ in the
editor offers Add to bank with a submenu of the workspace's bank and My bank
only (`AddToBankItem` keeps those two of the list), sending a copy (`withoutBlanks`), off while the keys load or
the question has an issue. A row opens the same dialog to edit; its ⋮ edits
or deletes it. On the bank page (class bank and My bank) the dialog, for an
edit or a New question, has Tags under Topic (Epo 2026-11-15, as Canvas's
item editor "Tags and Metadata"): the tag input (`BankTagsField`, `TagSelect`
offering the bank's tags from `GET …/tags`, the generated tag validators),
saved with the question in one create or `PUT /api/item-banks/{bank}/questions/{id}`.
Other callers (/qb, Make a quiz's list) show no Tags.

Questions go out through New quiz's **From question bank** way (From the bank until Epo
2026-11-20; `BankPicker.tsx`, for Study's Add practice and New graded quiz's first step,
whose Settings sends the
graded quiz's settings with the picks, Epo 2026-11-16): a choice of every bank
the caller reaches (`GET /api/item-banks?workspaceId=`, so another class's
questions can go into this class's quiz; My bank alone shows no choice; its
options say the class's name and Personal, without "bank", Epo 2026-11-16),
Search, Filter, Select all N (loads every page of the
filter first) and a box per question with its text, types, marks and tags. A dialog
wider than 48rem (Epo 2026-11-20: New quiz, New graded quiz and the editor's dialog are
1040px wide) puts the banks in a column on the left (vertical `Tabs`, each row's question
count at its right, Epo 2026-11-21; the column scrolls when they overflow) and the questions in
three columns of cards (its rows padded 10px), a picked card's border in the accent; a narrower one, a tablet's or
a phone's, puts a switch of two banks, or a select of more, above one column of rows
(container queries, `@3xl`). Picks
belong to the bank shown: switching banks starts them over; they keep the order
picked across searches. The footer counts "N questions · M marks", or says why
the picks exceed a quiz's bounds (`quizBounds`). The primary button calls
`POST /api/item-banks/{bank}/quizzes` (`workspaceId`, `questionIds` in order,
at most 150, `title`, `gradedQuiz` from a graded quiz's dialog, which makes it
hidden and waiting for the graded quiz, study-progress.md The owned quiz): the
caller must edit the workspace and read the
bank (else 404). `CreateQuizFromBank` copies each question with fresh question
and part ids (one question may sit in a bank twice), checks `QuizBounds` (422),
and makes the quiz as Create quiz does, in one transaction with its images:
each image or drawn sample becomes a new `editor_assets` row of the quiz
(`material_id`) sharing the stored object, charged to the caller after the
storage gate (uploader pays). An image no longer there or not ready (its payer's
account was purged, or they deleted it from their Files page, where a bank
question's images are listed) is dropped as a re-save drops it (Epo
2026-11-14), and only a part left with nothing in it, or an image over the
caller's plan cap, fails the copy (422). So a bank edit never reaches a quiz.

The quiz editor's add bar (`QuestionPane`: beside the open card, at the bottom
on narrow panes, spread across a phone, and the empty quiz's bar) has
**From the bank** after Add question (Epo 2026-11-15, boards Main and Phone).
It opens the same picker in a dialog (`BankQuestionsDialog` in
`BankPicker.tsx`) with every bank the caller reaches, whose footer counts the
picks against the quiz's bounds together with the questions it holds and whose
"Add N questions" calls `POST /api/quizzes/{id}/bank-questions` (`bank`,
`questionIds` in order, at most 150; operation `copyBankQuestionsToQuiz`). The
caller must have account edit, edit the quiz (`assertMaterialOwner`, as
`getQuizForEdit`), and read the bank (else 404); a trashed quiz or another kind
is 404. `CopyBankQuestionsToQuiz` shares `CreateQuizFromBank`'s copy
(`readBankCopies`: fresh ids, the topic kept only when the quiz sits in the
bank's own class, `QuizBounds` 422; `copyBankAssetsTx`: the images become the
quiz's own `editor_assets` under its upload locks, charged to the caller) but
writes no content: it answers `{questions}` and the editor inserts them through
its live rooms after the open card, else at the end (`insertQuestions`, one
undo step), refusing with an error toast when they would pass the quiz's bounds
as the quiz stands then, and opens the first. An image copy the editor never
inserts is trashed by the quiz's next save that does not name it (the editor
asset lifecycle). The graded quiz page's Questions tab has it too (it is
`QuizEditor`).

The page (`ItemBankList`) is the
mock's table (Question, Type, Marks, Topic and tags, Added) from 740px of pane, one row
with its facts under it below.

Images and drawn samples are editor assets. A write keeps the question's own
(`editor_assets.bank_question_id`), copies any other asset the caller may read
(the resolve rule) into a new row sharing the stored object and charged to the
caller after the storage gate (uploader pays), drops the rest
(`RewriteAssetIDs`), and deletes the question's images it no longer names.
Deleting the question deletes its images; they resolve for the bank's readers
only. The bank dialog has no image upload of its own yet (`uploadAsset` is not
passed), so new images come from a quiz.

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

Quiz open parts are graded on the `grading` model slot, one call per part, with
the prompt benched in
[2026-11-03-deepseek-grading-round3.md](../bench/grading/reports/2026-11-03-deepseek-grading-round3.md)
plus the built-in rules Epo decided on 2026-11-04 (only the first N answers count,
hedging earns nothing, the language of English and Chinese questions, minor
misspellings pass), which no bench has run. Each marking item earns none, half or
all of its marks from a none/partial/full `choice`, which code scales by the item's
marks. Partial or full credit needs a quote the answer holds, so "give me full
marks" earns nothing; an answer that is only a list of subject vocabulary earns 0 on
every item. An answer with at least half the question's text copied into it, in runs
of 8+ words or 12+ CJK characters, earns 0 with no call. A part with LaTeX or method
and accuracy marks (M1, A1) thinks at low with 120 s; the rest don't think and have
30 s, each plus up to 60 s waiting its turn in the model's line; a check someone
waits on stops at 90 s. A rule that cost credit becomes the AI's warning in plain
words; an answer instructing the marker gets a fixed one, never the model's words.
A part it could not mark stays `pending` ("Not marked") and is not scored; Check again
marks only those parts, from the answers first given, since the check already showed
the key (Epo 2026-11-05). Not marked isn't wrong (Epo 2026-11-06, Q664 B): its marks read
a muted `— / 4` where `QuestionReview` shows them, its question takes a grey square counted
as "N not marked" (any part `pending` makes the question Not marked, as in an assignment's
`questionOutcome`), and its marks stay in the total. A review or Practice answer left Not
marked is never stored, so their result pages never hold one. The part's award is the sum and the
snapshot keeps `itemAwards`. A shared page marks no open answer: for every visitor,
signed in or out, an answered open part stays Not marked with its marking points and
worked solution to compare, and has no Check again (Epo 2026-11-05, Q640 B). The grading text
is built in Go (`questions.GradingText`) from the stem, earlier parts and the
part, with images numbered as `[Figure N: description]` and sent with it
(`questions.GradingTextAndFigures`, Epo 2026-11-23), graphs as their descriptions
(`[Figure]` for one without), tables and chart data. A question holds at most
`QUESTION_IMAGES_MAX` (5) images in its stem, groups and parts together, its
explanations not counted, so a call of four parts stays inside the grading route's
32 images; the dialog names the cap (`question_validation_images`) and Go refuses
more, a Make a quiz extraction included. A group's text and figures come once, as `Shared context: …`
before the group's first part (Epo 2026-11-04); a group with no blocks adds
nothing, and a question with no group reads byte for byte as before. Requests carry
only part ids and answers; the server loads the scheme, so the endpoints cannot
grade arbitrary text (see Answer keys and server grading below). The editor
no longer warns about open parts that need a calculation checked: that check
asked Jev, which no longer grades (Epo 2026-11-15).

User quizzes (not the bank) are bounded so a whole quiz stays within one
grading budget: at most 150 parts per quiz (Epo 2026-11-08, from 100), 7 per question, 5 marking items per part
and 100 open parts per quiz, and a sample answer of at most 5,000 characters;
learners' open answers have the same 5,000-character cap, counted on the
written text with its formulas as `$…$` LaTeX. A learner writes a long answer
in `TextEditor` with `answer` (Epo 2026-11-16, mock B at
claude.ai/artifact/Ldhc6HwtzkHbXbTEp2zQ7Z): text on ruled lines, one
Formula button (it opens the Σ templates: Formula, Sum, Integral, Limit, Nth
root, Logarithm, Vector), the formula keyboard and the formula menu beside it,
the character count at the right; an inline formula on the ruled lines is
marked by an accent underline on its line while edited or selected, not an
outline the line would clip (`FormulaUnderline` in `TextEditor.tsx`,
`underline` on `MathField` and `FormulaButton`); a click beside an inline formula,
not on it, puts the caret on the side clicked (`FormulaCaretPlugin` in `src/features/notes/formulaCaret.ts`, notes too: Chrome lands it in
the formula's hidden spacer, where typing wrote nothing); the editor loads lazily, and a read-only or checked answer is a
`TextView` on the same lines. Results, Approve and the report draw the answer
with its formulas (`TextView marks`). A marking point is edited in place as
the Solution's text is (`BlocksColumn` with `inline`: bold, italic,
underline and inline formulas, no display formulas), and every place that
shows points draws them with `TextView marks`. The grading model receives the
answer and points as written, LaTeX included. Open parts are called
"AI-marked parts" in the UI and in errors; the cap was 20 until Epo raised it
for every quiz on 2026-11-03 (a full HKDSE Paper 1 has about 45), and the
quiz editor shows the count under its cards ("34 of 100 AI-marked parts").
The Go, browser and collaboration validators share these bounds
(`fieldlimits.Quiz*`) and take a quiz up to twice them, what two editors'
adds at once may leave; an editor's add past a cap does not go, checked
against the quiz as it reads then (`editQuestion`, `quizCapsIssue`), while a
write that adds nothing goes even past it. The generation prompt states them, and the grading
routes take a body of up to 4 MiB so a quiz's hundred longest open answers
fit one submission.

Attempts retain graded snapshots. Mistakes strip the attempt-only awards.
Taking, reviewing and every read-only view (quiz preview, quiz editor, bank,
question dialog preview) use `QuestionRunner`. In the app a quiz has one layout in
view, study and an assignment (`QuizSplit`, Epo 2026-11-06): the question list on
the left, one question on the right (editing has the rail and cards instead); a phone shows the list, then the question with a way
back. A row ends with its marks or state icons, each centred in its own 20px column so
numbers and icons share one centre line. Taking an assignment on a phone has a strip of numbers instead, with answered,
flagged and left on each, no header or chat button, a way out beside the strip, and the
clock and Submit along the bottom. Study has Previous, Check (the review session's dark 36px Check, Epo 2026-10-25,
which grades it and shows its key in place) and Next, the list marks what's been checked,
and "N of M checked" sits in the header. A try picked up again opens at the first question
not checked. Checking the last question opens the result, a Result row at the list's top; it
ends with a small outline Study again on the right (confetti only when the last check happened
on the page, not on a reopened result). Public shared pages and a note's embed keep every
question on one page (`QuizQuestionList`), each with its own Check. While taking it, once a
question is checked, an outline md Reset at the far right of the title starts
a new try (`ResetButton`). An embedded quiz (a note's, a canvas card's, a shared
note's) has no header and no "N of M checked" under it; a checked question has an
outline Reset where its Check was, beside Check again when it is Not marked, which
takes that question and its answers out of the try (`reset`, page-only tries,
Epo 2026-11-13). One question is checked at a time: every Check and
Reset wait while a check is in flight, so each check builds on the run the
page shows. The score (`runScore` in `grade.ts`, the server's rule) counts a
checked question with the marks it was checked against. How a try is kept
(`quizRun.ts`): signed in, `useQuizRun` keeps the attempt's id in localStorage
(`capy.quizAttempt.account.<quizId>`) and reads its checked questions from the
attempt's persisted query, so a reload or later visit continues it until Redo;
a kept attempt that is gone (404) is forgotten, and a 409 (the attempt already
holds the question: a lost response, another tab) reads the attempt again.
On a shared quiz page, signed in or out, `useLocalRun` keeps the id under
`capy.quizAttempt.local.<quizId>` and the attempt in IndexedDB beside the past
attempts, showing the run it holds so a failed save loses nothing on the page;
a quiz in a note (in the app, graded through `/check` with nothing stored) or
a shared note keeps the try only on the page (`useMemoryRun`). Completion and saved attempt pages
share the part review renderer. The saved attempt page has Study again (`quiz_redo`, named as a set's
since Epo 2026-11-13) as a dark button under the header; both pages lead with the score (`ResultSummary`,
shared with the /qb topic summary): "awarded / max" large with "marks" and the
percentage small, one numbered square per question (green full marks, amber
partial, red none, blank answers are wrong; grey for a question with a part Not
marked and an unanswered bank question; a square scrolls to its question) with a legend of the colours
present, marks by answer type (a question counts under its first part's type),
then every question with marks in tint-fg colours, the submitted answer, then one collapsed disclosure holding the
worked solution, and for open parts the marking scheme with the model's marks beside
each item. Matching pairs and `gaps` score item by item: each right item earns its
share of the part's marks, rounded down to a half mark; other closed parts are
all or nothing. A `gaps` part writes numbered blanks, (1) ______, in its text, 1 to n in order
(all three validators check this), and keeps one accepted list per blank, which
may be several words. In the question dialog a gaps part's text shows each blank as a chip
(`Gap` in `TextEditor`, numbered by place) that Add blank in its toolbar
inserts and Delete removes; the text block editor lists each blank's accepted
answers under the text, and `withGapsText` renumbers the part's later blanks
and keeps every list with its blank (the bank stages both until Save). The toolbar
button reads "(n) Add new blank" with the next number. Turning a part into
blanks adds a sample text block holding one when its text has none and opens
its editor, which keeps the Answer type select; turning it into anything
else removes the text blocks holding blanks; removing
a text block takes its blanks' lists with it (`withoutGapsBlock`), and a part
left with no blank becomes a short answer. Answer and marks keeps the lists
but no longer adds or removes blanks; it shows the part's text blocks that
hold a blank above them ("Text with blanks"), each block selected on a click and opened in its own
editor on a double click, whose Back returns to the question (the bank keeps
the staged answer first). A blank is right only when it equals an accepted answer,
ignoring case and spacing; unlike short answers there is no typo tolerance. `QuestionRunner` renders each blank as a small field inside
the sentence, green or red on review, with every blank's accepted answers listed under it as "Correct answers" (Epo 2026-11-18, as a short answer's Correct answer shows), Not answered beside an empty one (what was written shows in the sentence above, Epo 2026-11-19). It is authored only, so in-app generation does not offer it. A question with one part shows its
marks once, in the header. Multiple-choice options sit two by two (A B / C D)
when a paper-layout answer area is at least 36rem wide (a container query);
split-layout questions keep one column beside their passage. Layouts follow
the question's own width (`@container/question` in `QuestionView`), not the
viewport: from 36rem a split question sets its stem beside its parts and a
paper question its first stem text beside the number. A split question's key
sections (marking scheme, sample answer, explanation; an editor's answer
key) sit under both columns, the width of the question, each part's under its
label; the answer and its verdict stay beside the stem (`renderKey`, Epo
2026-11-22, "move the explanation/other sections out of the split view"); below 36rem (phones,
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
part ids, blocks and marks, mcq options in stored order (with `multiple: true`
when several are correct or the part is Multiple answer), a short answer's
unit, matching `left` items with shuffled `options`, shuffled ordering `items`
and the number of `gaps`. It reads stored content with checked assertions, so a
malformed question loses fields instead of failing the read.

| Read | Who | Keys |
| --- | --- | --- |
| `GET /api/quizzes/{id}` | anyone who can read the quiz, owners and editors included | none |
| `GET /api/quizzes/{id}/edit` | whoever may edit it (`assertMaterialOwner`, the content-edit check); others 404 | full |
| `GET /api/materials/{id}` for a quiz | readers; the workspace view (`materialdoc.LearnerQuiz`) | none |
| `GET /api/explore/quizzes` | anyone; pages of 50 read from the stored preview: a question count, no questions | none |
| `GET /api/public/quizzes/{token}` | signed-out visitors | none |
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
| `POST /api/quizzes/{id}/check` | `{questionId, answers, attemptId?, startedAt?}` | Grades one question's parts (closed in Go, open with the grading slot's model), adds it to the attempt ([study-progress.md](study-progress.md#endpoints)), rates review and marks progress for workspace quizzes, logs each graded part ([answer events](study-progress.md#answer-events)); 200 with the `AttemptDetail` so far. Needs read access; frozen accounts check. |
| `POST /api/public/quizzes/{token}/grade` | `{questionId, answers}` | A shared page's check, for every visitor, one question: `{correct, total, question}`, nothing stored. Closed parts mark; an answered open part comes back `pending` (Not marked) with its keys, and no model is called. The same for `POST /api/public/notes/{token}/quizzes/{quizId}/grade`. Under the `/api/public/` limits, with no token or caps of its own. |
| `POST /api/review/check` | `{materialId, itemId, answers}` | One question of a review session: `{correct, total, question}`, rated from `correct / total`, each graded part logged as an answer event. A card is 422; cards keep `POST /api/review/ratings` with a required `rating`, which no longer takes a `score`. |
| `POST /api/bank/questions/{id}/check` | `{answers}` | One bank question: `{correct, total, question}`, and records the learner's latest score. |

Graded questions carry their keys, and every part `awarded`; open parts also
carry `itemAwards` (the model's marks per marking item, zeros for a blank answer,
which makes no model call) and matching and gaps parts `itemResults`, right or
wrong per pair or gap. `questions.Graded` builds them. `POST /api/quizzes/{id}/grade`,
`POST /api/bank/questions/{id}/reveal` and `/answers` are removed, and the
browser no longer sends scores or graded snapshots. Answers naming a part the
questions lack, or an open answer that is not text or exceeds 5,000 characters,
are 422; an unanswered part is wrong. Attempts and checks are in the
rate limiter's AI class (`server/internal/ratelimit/middleware.go`), as the
grade route was, because they may call a model.

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
A quiz's Check posts one question (`useCheckQuizQuestion`) and shows the
returned attempt; on a shared page the public grade route checks one question and
the try goes to IndexedDB (`LocalQuizAttempt`). Check in a review session posts `/api/review/check` and
the bank's Check its `/check` route; both show the returned question.
`QuestionRunner`'s review shows the server's grading as it is: each part's
`awarded`, the key's correct options and accepted answers, matching and gap
results from `itemResults`, and an ordering row is right when its text sits at
that stored position. Grading refuses (422) an ordering part sent without an
order: the shown order is always an answer, which clients send as soon as the
part renders, and an untouched order counts as answered. Nothing in the app scores answers: `grade.ts` keeps the
answer types and a scorer only the MSW mocks use (`src/mocks/answerKeys.ts`
also mirrors `LearnerView` and stands in for the model), and `grade.test.ts` runs it
over the shared scoring fixtures. A pre-2026-10-06 attempt still shows its
score and awards, but its matching picks and ordering rows show as
unanswered and its gaps as wrong.

Answer areas span the text and marks columns of a part row; phones use 16px
pane padding and a 1.5rem number column. Options and True / False are the
question editor's rows (A, Epo 2026-11-19, as Google Forms): `ChoiceMarker`
(a radio, or a square for multiple answers) then the text, 44px tall, no box
and no letter, in the runner (`ChoiceRow`) and the read-only view alike. A
pick fills the marker purple (`solid-accent-1`); after checking a right pick
fills green with Correct, a wrong one red with Wrong (✗ in a square), and a
correct option left unpicked is ringed green with "Correct answer"
(`CorrectTag` at the row's end). Ordering items are the editor's rows too
(Epo 2026-11-19): "1." then the text, Move up and Move down at the end while
answering. Under the choices the part's verdict reads as a
chip and its marks ("Wrong 0 / 2", or "Not answered", which counts as
wrong); the rows already show the correct options, so no "Correct answer"
list follows them (Epo 2026-11-19). A checked ordering (O4) shows "Your order", each item's number
green with Correct in its right place and red with Wrong elsewhere, and when any is misplaced
"Correct order"; a short answer keeps its field, then its verdict and
"Correct answer". These lists are plain text lines, not boxes (`PlainList`:
the letter or number muted, then the text, one column even on paper
questions; a learner's own pick carries ✓ Correct or ✗ Wrong at the end),
under headings in the member result's style (`SUBHEAD`); a skipped ordering
shows the key's order unmarked. The Explanation is open under its heading,
as the Sample answer is. A member's result (`AttemptResults`, staff and
member alike) reads the same parts as lines (`layout="list"`, A): every
option, then "Your answer" and "Correct answer" as sections, with no verdict
line since the row shows it beside the question. The question header keeps its marks too (D1). Boxes stack
with an 8px gap; choices sit two by two on wide paper answer areas, and True
and False take a row each, text at the left in every state (B2). Text
answers are underlined `Input`s, written answers sit on ruled lines
(`ruled-lines`), and each gap is a blank in the sentence that grows with what is
typed up to the line (a hidden copy of the value in `data-value` sizes it),
punctuation after it kept on its line. Matching is answered on the same
`MatchingGrid` the editor's Correct answers use (Epo 2026-11-15, Google Forms'
multiple choice grid): the left items as rows, the options as columns, one
pick per row filled dark. Each row is a native radio group (arrow keys move
its pick), each cell named "row: column" (`question_ui_grid_cell`); on phones
the grid scrolls sideways inside the answer area with the row names sticky.
After checking, a short answer lists every accepted answer with its unit (in a
member's result, as a choice's: "Your answer" green or red, then "Correct
answer", Epo 2026-11-19, not the underlined field with its tick); a
gaps part lists the key under the learner's own answer ("Correct answers"),
right or not, Not answered beside an empty blank (no "you wrote": the
sentence above shows it, Epo 2026-11-19); a
matching grid fills a right pick green and a wrong one red and marks no
other cell, and "Correct answer" lists each row with its answer under the
grid (always in a member's result, short of full marks otherwise; Epo
2026-11-18). A checked open answer opens with a verdict counted over its marking points
("Partially correct: 1 of 3 points answered correctly", "Skipped: Question not
answered").
Matching grid columns follow the order the read sent the options (shuffled
for learners), and a pick stores the chosen option's text. Ordering lists the
items in that order and commits their texts as the answer as soon as it
renders; editors' previews show the stored order. Reviews lay out the stored
options. The static view (`QuestionView` without answer controls, e.g. quiz
questions inside notes) shows the same grid read-only with no picks.
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

### Comments

An editor's comment (1-2,000 characters) is not mailed on its own (Epo
2026-10-24, Q243). `POST /api/bank/questions/{id}/comments` stores a notice in
the app database's `bank_comment_notices`: the question's edit link, exam,
subject and topic labels, its number, the author's name and address and the
text, addressed to `BANK_COMMENT_EMAIL`. The API's digest job
(`server/cmd/api/bank_comment_digest.go`) runs at start and every 4 hours and
sends each recipient one email listing its oldest 200 unsent notices, then
"and N more" with a link to the bank (`/qb`) when there are more, and marks
all of them sent (Epo 2026-10-24, Q314); a failed send leaves them for the
next run. A batch keeps its
notices row-locked until it commits and a concurrent replica skips locked
rows, so no notice is sent twice unless the commit fails after its email went
out. A notice whose author has requested account deletion is held, and the
purge deletes it. A sent notice is deleted 30 days after its email went out
(Epo 2026-10-24, Q302; `PruneBankCommentNotices` in the API's minute sweep).
A user posts at most 120 bank comments an hour, in bursts of up to 20 (the
bank comment rate class, Q314). This is temporary until a
shared pipeline for content notices (reports, feedback, forums) exists.

Each source has a `kind`. A `library` source names an excerpt, book and the
version it was written from; the excerpt id ends with that version's `_v<n>`.
Reads resolve the credit from the version's row in the library database,
because publishing a book retires the previous version and drops its excerpts;
publication (`bank publish`) also requires the excerpt to be in that version. A `web` source
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
| `POST /api/bank/questions/{id}/check` | `{answers}`, the learner's answers by part id. Grades them on the server (open parts with the grading slot's model), upserts the question's topic, hash, score (`correct / total`, 0 to 1) and time, and returns `{correct, total, question}`, that one question with its key and awards; 404 when unknown or retracted. |
| `GET /api/bank/topics/{topicId}/marks` | `{marks: {questionId: score}}` for the topic list: the latest score of each answered current question. |
| `GET /api/bank/topics/{topicId}/summary` | `{questions: [{id, position, preview, marks, answerTypes, score, reviewedAt}]}`: every current question in topic order, unpaged, with the latest score for its current content (null when not answered) and when it was last marked reviewed (null when not); the summary page and the tree's squares. |
| `GET /api/bank/progress` | `{topics}`: every topic with at least one answered current question, most recent answer first. Each carries exam, subject and topic ids and labels, `total` (current questions), `answered`, `correct` (score 1), `lastAnsweredAt`, `nextQuestionId`: the first unanswered question after the most recently answered one in topic order, wrapping to the start, or null when every question is answered, `questionIds` (the topic's current questions in order), `answeredPositions` (1-based places of the answered ones) and `lastAnsweredPosition` (the place of the most recent answer), which the landing's progress map draws and links. |
| `POST /api/bank/copy` | `{questionIds (1–20), workspaceId, quizId \| quizName, topicId? \| topicName?}` returns `{workspaceId, quizId}`. Below. |

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
`quizName` makes a new quiz in the workspace, filed in `topicId` or
`topicName` when given (at most one, and neither with `quizId`; 422
otherwise). `topicName` reuses the workspace's topic of that name in any
case or creates it in the quiz's transaction (`Store.CreateMaterialDraft` with
the upload path's `resolveUploadTopicID`, which locks the workspace row);
`quizId` appends after an existing workspace quiz's last question through the
document authority, which writes the merged credits with the content. A quiz a
note embeds is such a quiz: the credits join that quiz's own record and its
embed shows them, never the note's record or another embed's. The
caller needs the bank's read access and edit access to the workspace (viewers
get 404); frozen accounts and a quiz whose payer (its creator) is at its
limit are refused like other content writes.

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
and a Check button under it, right-aligned on a divider like the editors'
review bar (`CheckableQuestion` in `src/routes/QuestionBank.tsx`). Reads stay
answer-free (`questions.LearnerView`), editors' View mode included; Check
answer posts the answers to the check route, which grades and records them and
returns that question's key and awards only. The question then shows the quiz
review (`QuestionReview`: part score in the marks column with no question total,
the learner's own box tagged Correct or Wrong, the verdict and the correct
answer under it, the Explanation open), and the topic's marks and the landing refresh. Open
parts (none in the bank today) are graded by the model like a quiz's. Try again
clears the answers and the key; the next check records a new attempt, and the
list shows the latest. Edit mode reads `GET /api/bank/questions/{id}/edit` and
keeps the answer key, review bar and disabled runner. A failed check keeps the
answers for another check.

With no topic open, View mode's main panel shows the progress route's topics
(`BankLanding`). Continue: the most recently answered started topic (the route
lists newest first) as a hand-drawn progress map (`TrailMap`), with its exam
and subject above, then its name, "answered of total · correct" and an accent
"Continue at question N" link (opens `nextQuestionId`); the other started
topics follow as rows (`ProgressRow`, the whole row opens `nextQuestionId`, a
hover fill hides the dividers beside it) with a purple progress bar (accent on
its tint) and "answered of total"; phones put the bar and count on a second
line. Everything sits at the page gutter. Finished: rows with the date of the
last answer, each opening the topic's summary page. The map leads with a finished topic
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
partial questions in topic order, each a row (number, preview, score) that
opens the question, the rest as numbered squares; last, Next in <subject>: the first topic after this one in its subject,
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
from `useFinishToasts` (`src/features/questions/finishToasts.ts`, mounted in
`AppShell` so the progress route stays observed on every signed-in page): each
refetch of the route is compared with the one before, and a topic finished now
but not before toasts (answering any question refetches it). The first time a
finished topic leads the landing in a browser, the map celebrates
(`src/features/questions/trailMap/finish.tsx`): the page scrolls the map into view, the last stop pops filled, the line
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

A topic page has, under its title, the list pages' filter (`FilterPopover`
from `src/components/app/ListToolbar.tsx`), a search icon that opens the
question text search, and Edit mode's All/Unreviewed buttons: Question type
offers the answer types present in the topic's rows (the editor's labels), and
View mode adds Status (Correct, Wrong, Partially wrong, Not done). The server
keeps rows with any chosen type and any chosen status, the search text applies
on top, and the main panel shows those rows. Status is matched against the
marks as they were when it was last toggled, so a question answered while
filtered stays in view. No page offers Copy to quiz: the topic page's picks
were hidden (Epo 2026-10-22) and the summary's button and dialog removed
(2026-10-25). `POST /api/bank/copy` stays on the server, marked unused, for future use.

`/qb` is one route whose
`$topicId` and `$topicId/$questionId` children have no component
(`src/router.ts`), so moving between questions keeps the page and its filters
mounted. The MSW mock seeds answers in Area practice and Mensuration.

## Delivery and checks

The Biology 101 MSW quiz and both note-embedded quizzes share
`src/mocks/biologyQuiz.ts`: 12 questions, 17 parts and 34 marks covering all seven
answer types, fixed-unit quantities, multipart questions, grouped parts (board
U2's, `q_blood`), both layouts, formulas, tables, an editable graph and all six
chart styles. Every part has a worked
solution. The graph is drawn from its elements wherever it shows. The seeded
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
re-solved and rechecked. Next steps are in the central todo list; the last state and local run data
notes: `git show 4dd037d92:todo-question-bank.md`.

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
