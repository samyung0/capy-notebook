---
type: Backend
title: "Study Progress and Review"
description: "Per-user study progress in a workspace, FSRS review state in Go, the Study tab, Continue, Quick review, the review session, Learning's Review tab, lifecycle and access."
tags: [backend, frontend, study, review, fsrs, flashcards, quizzes, progress]
---

# Study progress and review

Each signed-in user keeps their own progress in each workspace: which files
and materials they have read (done), started or stopped tracking (removed),
and an FSRS memory state per quiz question and flashcard. Progress is on by
default. The workspace's Study tab shows it and offers Continue, Review and
Quick review; Learning lists every workspace in progress. FSRS runs in Go and
nothing is scheduled by date: no due date, due count or interval preview is
stored or shown for signed-in users. Review orders items by how likely the
learner is to have forgotten them (retrievability).

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
| `users.study_progress` | The global default, `true`. Settings → Customizations → Study preferences → Track study progress (`PATCH /api/me/study-progress`). |
| `workspace_study (user_id, workspace_id, enabled)` | The Study tab's switch for one workspace; when present it overrides the default (`StudyEnabled`). |
| `study_progress (user_id, workspace_id, file_id \| material_id, state, updated_at)` | One row per touched file or material, exactly one of the two ids set; `state` is `started`, `done` or `removed`. No row means untouched. Unique per (user, file) and (user, material). |
| `review_states (user_id, material_id, item_id, item_hash, stability, difficulty, reps, lapses, fsrs_state, last_review)` | FSRS state per quiz question or card. The key includes `material_id`, so a cloned quiz that keeps its question ids stays separate. |
| `review_log (user_id, material_id, item_id, rating, reviewed_at)` | Append-only, rating 1–4 for every rating and every rated attempt question; kept for offline merge and parameter fitting later. Nothing reads it yet. |
| `flashcard_cards (card_id, material_id)` | The old `card_stats` without its review columns: the card-to-set lookup card edits, deletes, listing counts and clone use. `card_id` is a global key, so clones mint new card ids. |

`study_progress` and `workspace_study` cascade with their workspace;
`study_progress` also with its file or material; `review_states` and
`review_log` with their material. User foreign keys never cascade because user
rows are tombstoned; `PurgeUser` deletes the four tables explicitly.

Embedded quizzes and sets (`parent_material_id` set) never get a
`study_progress` row and never enter review. Standalone materials have no
workspace and so no progress either.

## FSRS

`server/internal/review` wraps `github.com/open-spaced-repetition/go-fsrs/v3`
with no workspace assumptions:

- default weights, target retention 0.9, maximum interval 365 days, fuzz off,
  and `EnableShortTerm` off, so there are no same-day learning steps;
- `Rate(prev, rating, now)` returns the next state (`prev` nil for a first
  rating). A first rating of Again also sets `lapses` to 1, because go-fsrs
  counts lapses only on items it has seen and Quick review keys on lapses;
- `Retrievability(state, now)` is go-fsrs' forgetting curve over elapsed
  fractional days and stability.

Ratings:

- Flashcards: the four buttons map directly, 1 Again, 2 Hard, 3 Good, 4 Easy.
- Questions: a score from 0 to 1 (`ScoreRating`): below 0.5 Again, below 0.7
  Hard, otherwise Good, never Easy. In review the browser sends
  `awarded / questionMarks(question)`. For an attempt, `QuestionScore` sums the
  snapshot's part `awarded` over part `marks` (half marks included); a
  question carrying no marks is not rated. Scores come from the client, as
  attempt totals already do, so a user can only distort their own progress.

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
| `GET /api/workspaces/{id}/study` | `StudySummary`: `enabled`, `items` (rows of untrashed items), `recentAttempts` (the last 5 on the workspace's untrashed, non-embedded quizzes), `reviewable` (size of the review pool) and `quickReview`. |
| `PUT /api/workspaces/{id}/study/enabled` | Upserts `workspace_study`. |
| `PUT /api/workspaces/{id}/study/items` | `{fileId \| materialId, state?}`: `done` (Mark as read), `removed` (Stop tracking), omitted deletes the row (Mark as unread, Start tracking). The target must be an untrashed file or untrashed, non-embedded material of the workspace, else 404; both or neither id is 422. |
| `POST /api/workspaces/{id}/study/reset` | Deletes the user's `study_progress` rows in the workspace and `review_states` of every material in it. Attempts, the review log and the switch stay. |
| `GET /api/workspaces/{id}/review` | The next session: the first 20 of the review pool, each with its content (card faces, or the question JSON with its answer key) and material title. |
| `POST /api/review/ratings` | `{materialId, itemId, rating}` for a card, `{materialId, itemId, score}` for a question; the wrong field for the item's kind is 422. Needs read access to the material, so standalone shared sets and embedded sets (through their note) can be rated too. |
| `GET /api/review/workspaces` | Learning's Review tab, below. |
| `PATCH /api/me/study-progress` | The global default. |
| `POST /api/quizzes/{id}/attempts` | Existing route; its side effect is below. |
| `POST /api/internal/study-progress` | The chat agent's `read_study_progress`, below. |

Side effects, in the same transaction as the write:

- An attempt on a workspace quiz that is not embedded rates every snapshot
  question still in the document and sets the quiz `done`. Attempts on
  embedded and standalone quizzes record no review state at all.
- A rating writes `review_states` and `review_log`. For a workspace material
  that is not embedded it also sets progress: a question makes its quiz
  `done`; a card makes its set `started`, or `done` once every current card has
  a state matching its hash. Ratings of one user on one material take an
  advisory lock, so a set's last cards rated at once still see each other and
  mark it done. Embedded and standalone ratings write state that nothing reads.
- A `done` row stays done; later cards do not reopen a set. Practising a
  `removed` item puts it back (started or done).
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

## Study tab

`src/features/study/StudyPanel.tsx`. Workspace tabs are Study, Files and Chat
for every role that can read the workspace (`WorkspaceOpen.tsx`); Study opens
first unless the URL already names an item. Sections hide while empty; with
nothing tracked one centred line says how to start, and with progress off a
line says quiz results are still kept. Top to bottom:

- **Up next** with Continue: the first item in reading order that is neither
  `done` nor `removed`. Reading order (`readingOrder` in
  `features/workspace/workspaceContent.ts`, shared with the Files panel's
  `contentFor`) is chapters by `order`, each chapter's files and materials by
  position (files first on ties, then newest), then unfiled items. It is
  computed in the browser from the loaded tree; there is no plan order.
- **Review**: the reviewable count and Review, which opens the session.
- **Quick review**: one card at a time from `quickReview`, the pool's cards
  with at least one lapse, least retained first, at most 20. A card flips and
  takes the four ratings, posted like any rating; the round is a snapshot of
  the list and restarts from the refreshed list when it runs out, so a card
  rated Good drops down.
- **Done** per chapter ("4 of 5", unfiled as Others), counting tracked
  (not removed) items.
- **Recent quizzes**, linking to each attempt's results.
- The Track progress switch, with "N of M done" and started sets.

Reset is a row in Workspace settings → Danger with a confirm dialog; viewers,
who cannot manage settings, get the dialog with only that row.

### Marks and menus

With progress on, Files panel rows (`FileListItem`, `MaterialListItem`) show a
check for `done`, a dashed circle for `started` and a muted title for
`removed`, at the row end left of the hover ⋮. The row ⋮ gains Mark as read or
Mark as unread and Stop tracking or Start tracking; that menu is rendered only
for roles that can edit, so viewers use the viewer header instead.
`CenterContentHeader` has a Mark as read toggle right of the view/edit toggle
on every workspace file and material (an open book with a check, the marks'
green closed book once read) and the same items in its ⋮ menu, for every role.

## Review session

`/learning/review/$workspaceId?from=workspace|learning`
(`src/routes/ReviewSession.tsx`), a full page scoped to one workspace. The
session is the batch fetched when it began, so it does not reshuffle as
ratings land. Cards flip and take the four ratings. Questions use the quiz
page's `QuestionRunner`; Check grades closed parts in the browser and sends
open parts to `POST /api/quizzes/{quizId}/grade` (Jev) for the item's own
quiz, one question at a time, then posts the score and shows the marked
answer. A failed grade shows an error and the learner checks again; a failed
rating shows a toast. Ratings save in the background. The end screen says how
many were reviewed and offers Done (back to where the session started) and
Review 20 more, which waits for every pending rating, refreshes, and selects
again from the saved ratings, so FSRS may bring back an item just rated.
Leaving the page refreshes progress once the pending ratings settle.

The per-set Study page (`FlashcardStudy.tsx`) is unchanged in shape: every
card in document order, Again sends a card to the end, and each rating posts
to `/api/review/ratings`. Embedded sets study there too, outside progress.

## Learning

Learning has two tabs, Review (default) and Past results (attempt history).
`GET /api/review/workspaces` lists, by name, the workspaces where the user has
a non-removed `study_progress` row, can still read, and has progress on. Each
row has the reviewable count, "done of total" and Review (disabled at zero,
`from=learning`). Total counts the workspace's untrashed files and untrashed,
non-embedded materials, and done its `done` rows; both leave out items the
user stopped tracking, matching the Study tab.

## Lifecycle

| Event | Effect |
| --- | --- |
| File or material trashed | Rows stay; every read skips trashed items and marking one is 404; restore brings them back. |
| File or material purged | `study_progress`, `review_states` and `review_log` cascade. |
| Item removed from a document | Its `review_states` row is ignored until the item returns. |
| Question prompt or card face edited | That item's state resets on its next rating; until then it is out of review. |
| Workspace deleted | All four workspace-scoped tables go by cascade. |
| Member or link access lost | Rows stay, unreadable without access; Learning skips the workspace. |
| Workspace or material clone | Nothing is copied; cloned cards get new ids. |
| Workspace transfer | Rows stay with each user; `study_progress` and `workspace_study` are in `notOwnership` (`workspace_transfer_test.go`). |
| Account purge | `PurgeUser` deletes the user's rows in all four tables. |
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

- `server/internal/review/review_test.go`: rating mapping, retrievability
  order, the prompt-only question hash, a first miss counting as a lapse, part
  marks with half marks.
- `server/internal/store/study_test.go`: attempts and ratings recording
  progress, embedded quizzes recording nothing, sets going started then done,
  removed items coming back, review selection, Quick review, Learning, Reset
  and purge.
- `server/internal/httpapi/share_access_test.go`
  (`TestShareHTTPReadersRecordReviewRatings`): viewers and link visitors rate.
- `server/internal/httpapi/account_gates_test.go`: frozen accounts and members
  of a frozen owner's workspace record over HTTP.
- `src/features/workspace/workspaceContent.test.ts`: reading order.
- `src/features/study/ratings.test.ts`: the review session's rating queue and
  question scoring; `src/features/study/StudyPanel.test.tsx`: the Study tab
  with progress off.
- `e2e/study/study-progress.spec.ts`: Mark as read on a file row, Continue,
  and a mixed review session.

Sources: [migration](../server/migrations/0051_study_progress.sql),
[FSRS wrapper](../server/internal/review/review.go),
[store](../server/internal/store/study.go),
[routes](../server/internal/httpapi/huma_study.go),
[attempt hook](../server/internal/store/queries.go),
[Study tab](../src/features/study/StudyPanel.tsx),
[marks and menus](../src/features/study/studyItems.tsx),
[review session](../src/routes/ReviewSession.tsx) and
[Learning](../src/routes/Learning.tsx).
