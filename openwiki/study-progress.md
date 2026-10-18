---
type: Backend
title: "Study Progress and Review"
description: "Per-user study progress in a workspace, FSRS review state in Go, suggested reviews and their scoring, recorded review sessions, the Study tab, Continue, Quick review, Learning's Progress, Review, Past reviews and All results tabs, the railway map, lifecycle and access."
tags: [backend, frontend, study, review, fsrs, flashcards, quizzes, progress]
---

# Study progress and review

Each signed-in user keeps their own progress in each workspace: which files
and materials they have read (done), started or stopped tracking (removed),
and an FSRS memory state per quiz question and flashcard. Progress is on by
default. The workspace's Study tab shows it and offers Continue, Review and
Quick review; Learning's Progress tab draws the latest workspace as a map, and its Review tab lists every workspace with progress and what a review would draw on. FSRS runs in Go and
nothing is scheduled by date: no due date, due count or interval preview is
stored or shown for signed-in users. Review orders items by how likely the
learner is to have forgotten them (retrievability) and by their latest
answers, and Learning's Review tab suggests what to review with a reason in
words. Every review session is recorded with its first answer.

Who may record, frozen accounts and the lifecycle rules are summarised in
[authorization-permissions-lifecycles.md](authorization-permissions-lifecycles.md);
this page is the detail. Question-bank progress is separate: only the latest
score per bank question, with no FSRS state or review queue
([question-bank.md](question-bank.md#learner-progress-and-retraction)).

## Data model

Migration `0051_study_progress.sql`. Every table is per user, none is copied by
clone or charged to storage.

| Table / column | Holds |
| --- | --- |
| `users.study_progress` | The global default, `true`. Settings → Study → Track study progress (`PATCH /api/me/study-progress`). |
| `workspace_study (user_id, workspace_id, enabled)` | The Study tab's switch for one workspace; when present it overrides the default (`StudyEnabled`). |
| `study_progress (user_id, workspace_id, file_id \| material_id, state, updated_at)` | One row per touched file or material, exactly one of the two ids set; `state` is `started`, `done` or `removed`. No row means untouched. Unique per (user, file) and (user, material). |
| `review_states (user_id, material_id, item_id, item_hash, stability, difficulty, reps, lapses, fsrs_state, last_review)` | FSRS state per quiz question or card. The key includes `material_id`, so a cloned quiz that keeps its question ids stays separate. |
| `review_log (user_id, material_id, item_id, rating, reviewed_at)` | Append-only, rating 1–4 for every rating and every rated attempt question. Suggestions read each item's last 8 (`review_log_item_idx`); kept for offline merge and parameter fitting later too. |
| `review_sessions (id, user_id, workspace_id, chapter_id, group_kind, mode, evidence, items, started_at, last_answer_at, finished_at)` | Migration `0071_review_sessions.sql`. One recorded session, written with its first answer: what it drew from (`group_kind` chapter, others or workspace; `chapter_id` for a chapter, set NULL when the chapter goes), the suggestion's `mode` (NULL from the workspace list) and `evidence`, every served item in order (`items`, for Continue), and `finished_at` once every served item is answered or Done ends it. The id is minted by the browser. |
| `review_answers (session_id, material_id, item_id, kind, rating, correct, total, answers, graded, answered_at)` | One answered item of a session: a card's rating, or a question's rating, marks (`correct` of `total`), answers and graded question with its key. |
| `flashcard_cards (card_id, material_id)` | The old `card_stats` without its review columns: the card-to-set lookup card edits, deletes, listing counts and clone use. `card_id` is a global key, so clones mint new card ids. |

`study_progress` and `workspace_study` cascade with their workspace;
`study_progress` also with its file or material; `review_states` and
`review_log` with their material. User foreign keys never cascade because user
rows are tombstoned; `PurgeUser` deletes the four tables and `review_sessions`
(answers cascade) explicitly. `review_sessions` cascades with its workspace,
`review_answers` with its session or material.

Embedded quizzes and sets (`parent_material_id` set) are quick checks that
record nothing (Epo, 2026-10-06): no `study_progress` row, no review, no
stored attempt and no rating. Standalone materials have no workspace and so no
progress either.

## FSRS

`server/internal/review` wraps `github.com/open-spaced-repetition/go-fsrs/v3`
with no workspace assumptions:

- default weights, target retention 0.9, maximum interval 365 days, fuzz off,
  and `EnableShortTerm` off, so there are no same-day learning steps;
- `Rate(prev, rating, now)` returns the next state (`prev` nil for a first
  rating). A first rating of Again also sets `lapses` to 1, because go-fsrs
  counts lapses only on items it has seen;
- `Retrievability(state, now)` is go-fsrs' forgetting curve over elapsed
  fractional days and stability.

Ratings:

- Flashcards: the four buttons map directly, 1 Again, 2 Hard, 3 Good, 4 Easy.
- Questions: a score from 0 to 1 (`ScoreRating`): below 0.5 Again, below 0.7
  Hard, otherwise Good, never Easy. The server grades every question
  ([question-bank.md](question-bank.md#answer-keys-and-server-grading)): a
  review check rates `correct / total` of the one question, and an attempt's
  `QuestionScore` sums the graded snapshot's part `awarded` over part `marks`
  (half marks included); a question carrying no marks is not rated, nor is
  one the learner left wholly blank (`questions.Blank`: it still scores 0 in
  the attempt, but a skip says nothing about recall). A question with an
  ordering part is never blank, because the shown order is itself an answer.
  The browser sends answers only, never scores.

## Items, hashes and resets

`materialItems` reads a material's current document: each flashcard (a card
with both sides blank is a new set's placeholder and is not an item), or each
quiz question by its element id. Every read and write works from the current
document, so an item that has left the document is ignored and its row comes
back into use if the item returns (chat Undo). Rating an item that is not in
the document returns 404.

Each item has a hash, stored as `item_hash` when it is rated:

- a card: SHA-256 of its front and back text (`CardHash`);
- a question: SHA-256 of the text of its stem's text blocks and of each part's
  prompt text blocks (`QuestionHash`). Answer keys, choices, marking schemes,
  hints, solutions, marks, images, graphs, layout and styling are left out, so
  editing them keeps the learner's state.

A mismatch resets that one item. At read time the item is skipped (not in
review, Quick review or the reviewable count) until it is rated again; at
write time it is rated as new (`prev` nil) and the row takes the new hash.
Other items of the material keep their state.

Parsed items are cached per material and revision in one process-wide map
(`itemsOf`, up to 32 MiB of document JSON, cleared when full); every content write bumps
`materials.revision`, and titles are read fresh because a rename does not.

## Endpoints

All in `huma_study.go` except attempts. Reads need read access to the
workspace; writes need read access plus an account that can sign in
(`requireAccountMutate`), so frozen accounts record.

| Endpoint | Effect |
| --- | --- |
| `GET /api/workspaces/{id}/study` | `StudySummary`: `enabled`, `items` (rows of untrashed items), `recentAttempts` (the last 5 on the workspace's untrashed, non-embedded quizzes), `reviewable` (size of the review pool), `quickReview` and `unfinished` (the latest whole-workspace session left before its end, for Continue review). |
| `PUT /api/workspaces/{id}/study/enabled` | Upserts `workspace_study`. |
| `PUT /api/workspaces/{id}/study/items` | `{fileId \| materialId, state?}`: `done` (Mark as read), `removed` (Stop tracking), omitted deletes the row (Mark as unread, Start tracking). The target must be an untrashed file or untrashed, non-embedded material of the workspace, else 404; both or neither id is 422. |
| `POST /api/workspaces/{id}/study/reset` | Deletes the user's `study_progress` rows in the workspace and `review_states` of every material in it. Attempts, the review log and the switch stay. |
| `GET /api/workspaces/{id}/review?group=&chapterId=&mode=` | A new session: a suggestion's items (mode set) or the whole workspace's (no mode), each with its content (card faces, or the answer-free question, `questions.LearnerView`) and material title, plus the group, mode and evidence to send back with each answer. A chapter not in the workspace is 404. |
| `GET /api/review/sessions/{id}` | Continue: an unfinished session's items still to answer, read now (items that left their material drop), with answered of total. Another user's session is 404. |
| `POST /api/review/sessions/{id}/finish` | Ends a session before its last item. |
| `GET /api/review/sessions?sort=&dir=&workspaceId=&has=&offset=&limit=` | Past reviews: finished sessions with their quiz marks and cards remembered (Good or Easy). Sort date, quiz, cards or time; `has` quiz and/or flashcards. |
| `GET /api/review/overview` | Learning's Review tab, below. |
| `POST /api/review/ratings` | `{materialId, itemId, rating, session?}` for a card; a question is 422 (it is rated by a check). Needs read access to the material, so standalone shared sets can be rated too; an embedded set is 422 (`ErrStudyEmbedded`), its study page sends nothing. |
| `POST /api/review/check` | `{materialId, itemId, answers, session?}` for a question: grades it on the server (open parts with Jev), rates it from `correct / total` and returns `{correct, total, question}`, the question with its key and awards. A card is 422. |
| `GET /api/learning/progress?lead=` | Learning's Progress tab, below. |
| `PATCH /api/me/study-progress` | The global default. |
| `POST /api/quizzes/{id}/attempts` | `{answers}`, graded on the server ([question-bank.md](question-bank.md#answer-keys-and-server-grading)); its side effect is below. |
| `POST /api/internal/study-progress` | The chat agent's `read_study_progress`, below. |

Side effects, in the same transaction as the write:

- An attempt on a workspace quiz that is not embedded rates every question of
  the snapshot the server graded that is still in the document and sets the
  quiz `done`. Attempts on standalone quizzes record no review state. An
  embedded quiz's attempt is graded and returned without an id and stores
  nothing (`CreateAttempt`): no Past attempts entry, and the result lives only
  on the page.
- A rating writes `review_states` and `review_log`. For a workspace material
  that is not embedded it also sets progress: a question makes its quiz
  `done`; a card makes its set `started`, or `done` once every current card has
  a state matching its hash. Ratings of one user on one material take an
  advisory lock, so a set's last cards rated at once still see each other and
  mark it done. Standalone ratings write state that nothing reads.
- A `done` row stays done; later cards do not reopen a set. Practising a
  `removed` item puts it back (started or done).
- A rating or check carrying `session` (id, workspace, group, mode,
  evidence, served items) also writes the session on its first answer and
  the answer, under a row lock on the session; the last served item finishes
  it. A session of another user, or an item outside the session's workspace,
  is 422 (`ErrReviewSession`).
- Recording happens with progress on or off; turning it on shows the history.

The browser refreshes the Study tab, marks, review and Learning after every
attempt and rating (`invalidateStudy`, for every workspace when the caller does
not know which); the review session refreshes once at the end instead.

## The review pool

`reviewPool` is every rated item whose hash still matches, across the
workspace's quizzes and sets that have a `study_progress` row other than
`removed` and are neither trashed nor embedded, sorted by retrievability
ascending (ties keep material position, then document order). Unrated items
never enter it. It feeds `reviewable`, Quick review, the session and
Learning's count. It reads only materials the user has rated, states included,
in one query, and parses a document only when the cache misses its revision.

## Suggested reviews

`server/internal/store/review_sessions.go` (Epo, 2026-10-10). Each pool item
the user's review items preference lets in is scored

    item score = (1 - R) x (1 + tricky + learned)

where tricky and learned come from its latest answers
(`review.HistoryWeights`): ratings newest first, the last 8, weighted 0.9^k,
Again a full miss and Hard half. The miss rate is pulled towards "probably
not known yet" with 2 assumed misses and 0.75 assumed correct answers,
`p = (misses + 2) / (weights + 2.75)`, rescaled so 8 straight correct answers
add nothing and the most a history adds is 2. Tricky is the share of `p` the
seen misses make, learned the share still assumed. So a correct streak lowers
an item, a single first miss counts more as just learned than as tricky, and
repeated misses barely add at the top. The three parts per item are fading
`(1 - R)`, tricky `(1 - R) x tricky` and learned `(1 - R) x learned`; the
focus preference doubles its part.

Groups sum their items' parts, so more practised content ranks higher and
nothing ranks by a rate. Only items at R at most 0.9 (FSRS's target) count.
A workspace without chapters is one group; otherwise each chapter and the
items outside chapters (Others) is one, and when none passes alone but the
whole workspace does, the workspace is the group. A group shows when its sum
times the workspace's interest is at least 3; interest is 1 until 30 days
after the last progress change in the workspace, eases to 0.25 by 90 days and
stays there. The mode (Tricky, Fading or Just learned) comes from separate
signals, since `1 - R` scales every part alike and would leave time out of
it: fading `2 x (1 - R)` against the bare tricky and learned weights, summed
over the group, largest wins. So the same answers read Tricky or Just learned
while recent and Fading once mostly forgotten (a single first miss below about
60% recall); the focus preference changes ranking, not labels. Learning lists the top 5 across workspaces with progress on, at most
2 per workspace. The evidence words the reason: items whose last answer was a
miss, items missed twice or more, probably forgotten items (the sum of
`1 - R`, rounded), items answered at most twice, and the latest practice.

A session takes the group's items by score up to the session size, items at
R at most 0.9 only for a suggestion, then interleaves the modes so a run of
missed items is broken up. A manual review (the workspace list, the Study tab's Whole
workspace) takes the whole workspace with no recall cutoff: every item is
eligible, the score only decides which are picked first. The focus
preference ranks it as it ranks suggestions.

Preferences live in `users.study_preferences` with the chat's: `reviewSize`
10, 20 (default), 30 or 50; `reviewItems` both (default), quiz or flashcards,
for suggested and manual sessions; `reviewFocus` balanced (default), tricky,
fading or learned, for suggestions, suggested and manual sessions and Quick
review. The chat ignores them.

## Study tab

`src/features/study/StudyPanel.tsx`. Workspace tabs are Study, Files and Chat
for every role that can read the workspace (`WorkspaceOpen.tsx`); Study opens
first unless the URL already names an item. Sections hide while empty; with
nothing tracked (every item untouched counts as tracked, so this is an
empty workspace or one whose items all stopped tracking), no attempts and
nothing reviewable, one centred line says how to start, and with progress off a
line says quiz results are still kept. Top to bottom:

- **Quick actions**, two rows. The next item with Continue: the first item
  in reading order that is neither
  `done` nor `removed`. Reading order (`readingOrder` in
  `features/workspace/workspaceContent.ts`, shared with the Files panel's
  `contentFor`) is chapters by `order`, each chapter's files and materials by
  position (files first on ties, then newest), then unfiled items. It is
  computed in the browser from the loaded tree; there is no plan order.
  Continue is an accent underlined link with the forward arrow. Then, always,
  the workspace icon, "Whole workspace" and Review, which starts a
  whole-workspace session (no mode, recorded with its first answer like any
  session). When `unfinished` is set the link reads Continue review and
  reopens that session, with "Progress: answered of total · when" (its last
  answer) muted under the title. Review is disabled with nothing reviewable
  and nothing to continue. Suggested reviews live on Learning's Review tab
  only (Epo, 2026-10-18).
- **Quick review**: `quickReview` (`quickReview` in `study.go`) ranks the
  pool's cards and quick questions as a suggested review does
  (`scoreItems`, so the focus and item preferences apply) among those at or
  below `suggestedRecall`, so an item just answered waits until it fades,
  and takes the top four. A quick question (`quickQuestion`) has a single
  part answered by choice, true/false, a short answer or gaps; open,
  matching, ordering and multi-part questions are left to review sessions
  (they run 350 to 1000px tall at phone width). A question shows with the
  review session's runner and Check (`POST /api/review/check` without a
  session, keys hidden by `questions.LearnerView` in the handler), then its
  checked result read only until Next; Next past the last checked question
  ends the round. A card shows on
  the shared card in its `panel` size (at most 360px wide, 160 to 190px
  tall, subtitle-size front text, denser rating tiles; smaller than a note
  embed's compact card) with the set's name under it, flips
  and takes the four ratings. The round is a snapshot kept while
  ratings refresh the summary (rated items leave the list); once its last
  item is done the section leaves with the smoky dissolve
  (`motion-smoke-out`: rise 8px, swell to 1.04, blur 8px, fade over 500ms,
  then the row closes over 350ms; reduced motion removes it at once) and
  stays gone until the workspace is opened again.
- **Done** per chapter ("4 of 5", unfiled as Others), counting tracked
  (not removed) items. A finished chapter shows the green check, a started
  one a solid circle and an unstarted one a dashed circle.
- **Recent quizzes**, linking to each attempt's results.
- The Track progress switch.

Reset is a row in Workspace settings → Danger with a confirm dialog; viewers,
who cannot manage settings, get the dialog with only that row.

### Marks and menus

With progress on, Files panel rows (`FileListItem`, `MaterialListItem`) show a
check for `done`, a dashed circle for `started` and a muted title for
`removed`, at the row end left of the hover ⋮ (at the right edge in the
Files dropdown below lg, whose rows have no ⋮). The row ⋮ gains Mark as read or
Mark as unread and Stop tracking or Start tracking; that menu is rendered only
for roles that can edit, so viewers use the viewer header instead.
`CenterContentHeader` has a Mark as read toggle right of the view/edit toggle
on every workspace file and material (an open book with a check, the marks'
green closed book once read) and the same items in its ⋮ menu, for every role.
On phones the workspace header hides the toggle and keeps the ⋮ items. Below
lg the workspace has no Study tab; Study gets its own page later.

## Review session

`/learning/review/$workspaceId?from=workspace|review` with `group`,
`chapterId` and `reviewMode` for a suggestion, or `session` to continue
(`src/routes/ReviewSession.tsx`), a full page scoped to one workspace, under the flashcard and quiz pages'
header (`QuizPageHeader`: back arrow and one crumb, Learning or the
workspace per `from`, above the title). The
session is the batch fetched when it began, so it does not reshuffle as
ratings land; the browser mints its id and every answer carries it with the
served items, so the first answer records the session. Items come one at a time
with small Previous and Next buttons (`StepNav`), the stepper shared with
flashcard study and Quick review (`src/features/study/steps.ts`). Next skips an
item without rating it: it waits at the end of the session, and a second skip
leaves it behind so the session still reaches its end. A skip records nothing,
neither rating nor `review_log` row, so a skipped item keeps fading and
resurfaces as Fading rather than Tricky. Previous walks back through the items
shown: one already rated or checked is read only (a card's rating ringed, the
other ratings disabled; a question's graded result), so nothing is recorded
twice, while a skipped one can still be answered there. Cards use the study
card (`CardStack`, below), and a rated card swipes away only over another card.
Review items carry the card's image, shown under the front. Questions use the
quiz page's `QuestionRunner` on the answer-free question; Check posts the
answers to `POST /api/review/check`, which grades (open parts with Jev), rates,
records and returns the question with its key, and the item stays on its
marked answer until Next. A failed check shows an error and the learner checks
again. Card ratings save in the background; a failed one shows a toast.

Continuing a session (`GET /api/review/sessions/{id}`) returns `done`, the
items already answered in answer order with what was recorded (a card's
rating, or a question's rating, marks, answers and graded question), ahead of
the items still to answer, so Previous reaches them read only.

The last item opens the review summary (`src/features/study/ReviewSummary.tsx`),
in the bank's topic summary style and built from the same `ResultSummary`
pieces: "N reviewed" and the skips, one square per item (questions by marks;
cards Good and Easy green, Hard amber, Again red; skipped grey), a by-kind row
for questions (marks) and flashcards (rating counts), the misses to look at
again with Open, the skipped items as numbers, and the next suggestion with
Start. Open goes to the item in its material
(`/workspaces/$id?material=&item=&mode=view`): a quiz scrolls to the question
and a set opens that card in its preview. Review more waits for every pending
rating, refreshes, and starts a new session on the same group; Back returns to
where the session started. The session is finished once its answers are saved,
skipped items or not, so a continued session whose items left their material
still ends. Leaving early keeps it unfinished for Continue review. Leaving the
page refreshes progress once the pending ratings settle.

The per-set Study page (`src/routes/FlashcardStudy.tsx`) takes every written
card in document order; Again sends a card to the end. It uses the quiz pages'
frame (header with back, breadcrumb and title) and never edits cards. The same
`StudyBody` (`src/features/flashcards/StudyBody.tsx`) serves the page, note
embeds and the shared page, drawing the card with `CardStack`
(`src/features/flashcards/CardStack.tsx`, also the review session's and Quick
review's card; note embeds use its shorter compact size and Quick review the
smaller panel size):
"Card 1 of 6" centred above the card, which flips
on a click (the text swaps in place, old face up and out, new face in from
below, the ratings rising in one after another) and carries the text rating buttons
(`src/features/study/RatingTiles.tsx`) on its back; small Previous and Next
(`StepNav`) sit under it at the right. Next skips without rating (the card goes
to the session's end), Previous shows the cards before it: a rated one read
only with its rating ringed, a skipped one still to rate. Quick review steps
the same way through its round. Moving on
swipes the top card off to the top left over the next one (no motion under
reduced motion). Signed in, each rating
posts to `/api/review/ratings`; a shared link opened signed out renders the same
page, rating with ts-fsrs into IndexedDB, as shared quizzes keep attempts in
the browser. Embedded sets study there too and send no ratings
(`parentMaterialId` on the set).

## Learning

Learning has four tabs: Progress (default), Review, Past reviews (recorded
review sessions) and All results (quiz attempts, the old Past reviews table). The title, tabs and tab padding
follow Settings (`TabContent`), without its width cap so the map runs to the
panel's edges.

### Review tab

`src/features/study/ReviewTab.tsx` over `GET /api/review/overview`, for the
workspaces the user has a non-removed `study_progress` row in, can still read
and has progress on. Rows lead with the 32px workspace icon (`rounded-button`,
as on workspace cards).

- **Worth reviewing**: the suggestions (above), each with its group (chapter,
  Others, or the workspace with "Whole workspace"), the reason in words
  (`reviewReason` in `reviewText.ts`; phrasing to be tuned), the mode label in
  its theme colour (Tricky warning, Fading info, Just learned success) and
  "N items", and Start, which opens the session straight away. Study
  preferences links to Settings → Study.
- **Continue review**: unfinished sessions, newest answer first, with
  "answered of total · when" and Continue.
- **All workspaces**: name, last review or "Not reviewed yet" / "Nothing
  practised yet", "N items" a manual review draws from (hidden on phones), and
  Review, or Review again once any session exists there.

### Past reviews tab

`src/features/study/PastReviews.tsx`: finished sessions in the Files table
style (Date, Workspace, Chapter, Quiz, Flashcards, Time, ⋮ with Review again),
sorted from its column headers (`SortHeader`, no sort menu: date, workspace,
chapter, quiz score, flashcard score, time spent, status; text columns start
A to Z, the rest newest or largest first, a second click flips) and the list
pages' filter (workspace, has quiz questions or flashcards), both kept in the
URL (`parsePastReviewsSearch`). Chapter sorts chapter sessions by name with
Others and whole-workspace sessions last; status puts completed before
stopped. Quiz is marks of the questions answered, Flashcards
cards rated Good or Easy. A session ended early shows "Stopped after
N of M" under Status. Scores are plain "x / y" text. Below xl the Files table
gives way to Billing's plain table (`BillingTable`, no border, scrolls
sideways) without Time and Status, its headers sorting the same way. Thirty
rows a page. Both table tabs lay out as Files' list does: toolbar right under
the tabs, then the table in the list's padding. Workspace, chapter and quiz
names show the workspace icon beside the name (`WorkspaceCell`) and wrap to
two lines before the ellipsis; their columns are somewhat wider than the
number columns, and every column shares the leftover width.

### All results tab

`src/features/study/AllResults.tsx`: quiz attempts (Quiz, Workspace, Score,
Date, ⋮ with Check result and Redo), the same table switch below md. A
click anywhere on a row opens Check result. Attempts carry the workspace's
`iconId` (left out once the quiz is deleted).
`GET /api/attempts?sort=&dir=&workspaceId=&offset=&limit=` (`ListAttempts`)
sorts (date, score as correct / total, quiz name, workspace name; from the
column headers, as Past reviews), filters by the quiz's current
workspace and pages in SQL, thirty a page loaded on scroll; each attempt
carries that `workspaceId`, null once the quiz is deleted, so a workspace
filter leaves those out. The filter lists the user's workspaces as Files
does. Sort and filter live in the URL (`parseResultsSearch`; the route picks
the parser by `tab`). Each list's last sort pick is remembered in the browser
(`sortSearch`, `src/lib/localPrefs.ts`): opening Workspaces, Files, Blocks,
Past reviews or All results without a sort in the URL redirects to it.

### Progress tab

Progress only, with no review counts or Review links.
`GET /api/learning/progress` (`LearningProgress` in
`server/internal/store/learning_progress.go`) takes the same workspaces as the
Review tab, most recently studied first (`lastStudiedAt`, the latest
`study_progress.updated_at` that is not `removed`: marking, attempts and
ratings all write it), skips ones with nothing tracked, and splits them into
`active` (done below total) and `finished`, at most 10 each. Each carries name,
icon, cover, done and total. `lead` is the map's workspace with its chapters
and tracked items (id, file or material, title, chapter, position, created
time, state): the `lead` query's workspace when it is listed, else the first
active, else the first finished. The browser puts the items in reading order
with `inReadingOrder`, the Study tab's sort, so the map and Continue always
agree.

- **Continue review**: the heading with an accent "Continue: <item>" link at
  its right (the Study tab's next item: first in reading order not done), the
  map, then the workspace's icon and name and "done of total done".
- **Other workspaces**: rows with icon, name, "Studied <when>", the small
  trail (done of total), "done of total" and Continue, which opens the
  workspace on its Study tab.
- **Finished**: rows with icon, name, "Finished <when>", "total of total" and
  Open.

The map leads with a finished workspace when the URL's `finished` names it
(the finish toast's Go check, sent on as `lead`) or nothing is in progress; it
then heads "Workspace finished" without the Continue link and leaves the
Finished rows. Finishing a workspace's last tracked item raises a success
toast, "Workspace finished" with Go check, which opens
`/learning?tab=progress&finished=<workspace>`; it comes from
`useFinishToasts`, which compares each refetch of the progress route (every
study write refetches it) with the one before, as the bank's does. The first
time a finished workspace leads the tab in a browser, the railway map plays the
finish animation described in [question-bank.md](question-bank.md) (key
`workspace:<id>:<tracked count>`), so finishing again after new items
celebrates again (Epo, 2026-10-13).

With nothing in either list the tab shows only `PlaceholderRailMap`: four
unnamed stations (five or six stops at the first, two to six at the others,
drawn afresh per visit), nothing studied, no tag, numbers, tooltips or clicks,
and a blue station notice board (`MapBoard`, shared with the bank) just past
the first stop saying what the map will show. Under it, `RecordProgress`
(How we record progress) draws the three things that record progress (mark a
file as read, take a quiz, study flashcards) as small stickers in the map's ink,
then a Create a workspace link to /workspaces, like the dashboard's empty state. On a narrow map the board
is pulled left (container query units) so it ends inside the opening view.

### The railway map

`src/features/study/railMap/` (`map.ts`, `buildings.ts`, `RailMap.tsx`)
follows the question bank map (seeded, budgeted, culled; see
[question-bank.md](question-bank.md)) with a railway theme. Each named
chapter opens with a train station (house, platform, a canopy with the name
on one or two board lines of at most 18 characters, longer names ending in an
ellipsis), and its first item comes after the platform; unfiled items have no
station and follow on. The line wanders past stations (it may cross a
platform) and ends at a terminus with the finish flag and a buffer stop; a
workspace with one or two items still fills the panel, the scenery running on
past the buffer stop. Stops: done filled, started half filled, untouched
hollow; the next has a ring and a "Next: <item>" tag (raised above a station
it would cover); faint from six items past the next or last touched item,
whichever is later. Hover shows the title, a click opens the item. Once every
item is done there is no ring or Next tag: the line is solid to the buffer stop
and a "Finished" tag sits left of the terminus's flag, as on the bank's
summit (`map.flag`, reported by the terminus drawing).

Biomes are 260 to 440 map units (about 4 to 7 items), blending over 60:
city and industry (rows of buildings behind the line and, partly hidden by
the bottom edge, in front), town, farms, countryside, river (a steel bridge)
and woods. Each question-width's visual-weight ceiling (40 city, 36 industry,
22 else) is split 56% above the line and 44% below. `DENSITY` labels come from
`measure()` (20 seeds; under 7 sparse, under 16 medium, else dense): city and
industry dense, town, farms and woods medium, countryside and river sparse.
The order never puts dense next to dense or three sparse in a row; the urban
level (city and industry 3, town 2, farms 1, countryside and woods 0, river
any) changes by at most one across a border, so a city thins out through town
or a river; a dense biome comes at least every fifth, and that rule gives way
first when both can't hold. The line, stops and numbers (with a halo) are
drawn over the scenery.

The trail takes the workspace cover's colour (`coverInk` in
`src/lib/coverInk.ts`): the cover colour, or a paper cover's ink (genkō: its
line colour); in dark themes it is mixed 38% towards white; without a cover,
the theme's link colour. The small trails on Progress rows and in the Study
tab use the same colour.

## Lifecycle

| Event | Effect |
| --- | --- |
| Review session opened and left unanswered | Nothing is written. |
| Chapter deleted | Its sessions keep their answers with no chapter. |
| File or material trashed | Rows stay; every read skips trashed items and marking one is 404; restore brings them back. |
| File or material purged | `study_progress`, `review_states` and `review_log` cascade. |
| Item removed from a document | Its `review_states` row is ignored until the item returns. |
| Question prompt or card face edited | That item's state resets on its next rating; until then it is out of review. |
| Workspace deleted | All four workspace-scoped tables go by cascade. |
| Member or link access lost | Rows stay, unreadable without access; Learning skips the workspace. |
| Workspace or material clone | Nothing is copied; cloned cards get new ids. |
| Workspace transfer | Rows stay with each user; `study_progress` and `workspace_study` are in `notOwnership` (`workspace_transfer_test.go`). |
| Account purge | `PurgeUser` deletes the user's rows in all four tables and their review sessions. |
| Reset | Clears progress rows and review states in the workspace; attempts and the log stay. |

## Authorization

Progress and review state are private to their user. Any signed-in user who
can read the workspace records their own: owners, members of every role, and
link or public visitors, including viewers. Frozen (`over_quota_frozen`)
accounts record progress and ratings like anyone else, since the data is
their own and charges no storage; suspended, deletion-pending and deleted
accounts have no API access. Rows hold only ids, timestamps and FSRS numbers.
MSW mirrors this in `src/mocks/study.ts`: `keptWhenFrozen` keeps
`/api/review/ratings` and `/api/workspaces/*/study/*` open inside a frozen
owner's workspace.

## Chat agent

`read_study_progress` (requires `source.read`) calls
`POST /api/internal/study-progress`, which refuses with 403 when progress is
off for that user and workspace; the pipeline offers the tool only when the
turn's `studyProgress` is on. `AgentStudyProgress` returns `enabled`, the
tracked items with titles and states, recent attempts, and the three chapters
with the lowest mean retrievability. That average uses the stored states
without re-reading documents, so an edited item counts until it is rated
again. The agent never writes progress.

## Signed-out study

Signed-out visitors of standalone link or public quizzes and sets use
`ts-fsrs` in the browser (`src/lib/srs.ts`, fuzz on, with due dates and
interval previews): only due cards are queued, quiz attempts and an
append-only card review log plus card states live in IndexedDB
(`src/lib/localDb.ts`, database `capy-local`), and nothing is imported into an
account on sign-in. `SrsState` is a hand-written type in `src/lib/srs.ts`.

## Tests

- `server/internal/review/review_test.go` also holds the answer-history
  order Epo signed off (`TestHistoryWeightsOrder`).
- `server/internal/store/review_sessions_test.go`: suggestion groups (a
  passing chapter, the whole-workspace fallback, a workspace without chapters,
  interest discounting), session picks interleaving modes and cutting recalled
  items, the interest curve, and recorded sessions (no row before an answer,
  resume, Continue review, another user refused, finishing, Past reviews and
  the quiz filter).

- `server/internal/review/review_test.go`: rating mapping, retrievability
  order, the prompt-only question hash, a first miss counting as a lapse, part
  marks with half marks.
- `server/internal/store/study_test.go`: attempts and ratings recording
  progress, embedded quizzes recording nothing, sets going started then done,
  removed items coming back, review selection, Quick review, the Review list,
  Reset and purge.
- `server/internal/store/learning_progress_test.go`: Progress orders by last
  studied, splits finished, leaves stopped-tracking items off the lead's map
  and drops a workspace with progress off.
- `src/features/study/railMap/map.test.ts`: same map per workspace and only
  extended by more items, no dense neighbours or city beside open country, a
  short workspace filling its panel, the per-view element budget, station
  name wrapping, and density labels matching `measure()`.
- `server/internal/httpapi/share_access_test.go`
  (`TestShareHTTPReadersRecordReviewRatings`): viewers and link visitors rate.
- `server/internal/httpapi/answer_keys_test.go`
  (`TestReviewSessionChecksQuestionsOnTheServer`): the session is
  answer-free, a check grades, rates and returns the key, and a question
  score through the ratings route is refused.
- `server/internal/httpapi/account_gates_test.go`: frozen accounts and members
  of a frozen owner's workspace record over HTTP.
- `src/features/workspace/workspaceContent.test.ts`: reading order.
- `src/features/study/ratings.test.ts`: the review session's rating queue and
  question scoring; `src/features/study/StudyPanel.test.tsx`: the Study tab
  with progress off, and the whole workspace's Review / Continue review.
- `e2e/study/study-progress.spec.ts` (Docker stack, the detailed checks): a
  file read and unread from its row menu and its header; quizzes and sets
  started and finished through the attempt and study pages; Continue skipping
  done and removed items across chapters; Learning → Progress leading with the
  workspace and its Continue; Learning → Review's counts; a mixed review
  session.
- `e2e/uat/journeys/study.spec.ts` (deployed stack, thin): one file read, one
  quiz finished, one set studied, Continue, a two-item review, and the
  `study_progress`, `attempts` and `review_states` rows.

Sources: [migration](../server/migrations/0051_study_progress.sql),
[FSRS wrapper](../server/internal/review/review.go),
[store](../server/internal/store/study.go),
[routes](../server/internal/httpapi/huma_study.go),
[attempt hook](../server/internal/store/queries.go),
[Study tab](../src/features/study/StudyPanel.tsx),
[marks and menus](../src/features/study/studyItems.tsx),
[review session](../src/routes/ReviewSession.tsx),
[Learning](../src/routes/Learning.tsx) and
[railway map](../src/features/study/railMap/map.ts).
