---
type: Backend
title: "Study Progress and Review"
description: "Per-user study progress in a workspace, FSRS review state in Go, suggested reviews and their scoring, recorded review sessions, Study → Practice (suggestions, every quiz as practice, topic sessions and their result), Hide study progress, Study → Summary and its topic labels, Learning's Overview, Past reviews and All results tabs, the workspace Dashboard's activity, the answer events log, lifecycle and access."
tags: [backend, frontend, study, review, fsrs, flashcards, quizzes, progress]
---

# Study progress and review

Each signed-in user keeps their own progress in each workspace: which
quizzes and flashcard sets they have practised (started, or done once every
item is) and an FSRS memory state per quiz question and flashcard. Progress
shows by default; Hide study progress hides it per workspace while recording
goes on. The workspace's Study section (the rail's Study, its panel listing
Study's pages) shows Practice: suggested topics, every quiz members can see
as practice and the learner's own topic reviews, each started as a review
session in the page's place, and Summary: the learner's label per topic.
Learning's Overview says what to do next across workspaces and how each stands.
Read progress (Mark as read, Stop tracking, read marks, "done" counts,
Learning's Progress tab and its railway map) went on 2026-11-03 (Epo): only
practice records progress now. Study plans, cross-workspace lists with their
own review sessions, went on 2026-11-04 (Epo; migration `0137_drop_study_plans.sql`
dropped their tables). In a class Study also holds
[Assignments](#assignments). FSRS runs in Go and
nothing is scheduled by date: no due date, due count or interval preview is
stored or shown for signed-in users. Review orders items by how likely the
learner is to have forgotten them (retrievability) and by their latest
answers, and Practice, the Dashboard and Learning suggest what to review with a
reason in words. Every review session is recorded with its first answer.

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
| `workspace_study (user_id, workspace_id, enabled)` | Hide study progress for one workspace (`enabled` false hides); no row shows progress (`StudyEnabled`). Migration `0108_study_plans.sql` dropped the old global default `users.study_progress`. |
| `study_progress (user_id, material_id, workspace_id, state, updated_at)` | One row per practised quiz or set (`markProgressTx`: a check or a rating writes it); `state` is `started` or `done`. No row means untouched. Migration `0145_study_progress_practice_only.sql` dropped what Mark as read and Stop tracking left behind: `file_id` and `removed`. |
| `review_states (user_id, material_id, item_id, item_hash, stability, difficulty, reps, lapses, fsrs_state, last_review)` | FSRS state per quiz question or card. The key includes `material_id`, so a cloned quiz that keeps its question ids stays separate. |
| `review_log (user_id, material_id, item_id, rating, reviewed_at)` | Append-only, rating 1–4 for every rating and every rated attempt question. Suggestions read each item's last 8 (`review_log_item_idx`); kept for offline merge and parameter fitting later too. |
| `review_sessions (id, user_id, workspace_id, topic_id, group_kind, mode, evidence, items, started_at, last_answer_at, finished_at)` | Migration `0071_review_sessions.sql` (chapters renamed topics, group `topic`, in `0136_topics.sql`). One recorded session, written with its first answer: what it drew from (`group_kind` topic, others or workspace; `topic_id` for a topic, set NULL when the topic goes), the suggestion's `mode` (NULL from the workspace list) and `evidence`, every served item in order (`items`, for Continue, each with the `reason` it was served for: `new`, `missed` or `fading`), and `finished_at` once every served item is answered or Done ends it. The id is minted by the browser. |
| `review_answers (session_id, material_id, item_id, kind, rating, correct, total, answers, graded, answered_at)` | One answered item of a session: a card's rating, or a question's rating, marks (`correct` of `total`), answers and graded question with its key. |
| `attempts.kind`, `attempts.started_at` | Migration `0094_flashcard_attempts.sql`. Quiz and flashcard attempts share `attempts`: `kind` is `quiz` or `flashcards`; `started_at` is the browser's start time (null when not sent, and never after the end), so results show minutes. A flashcard attempt keeps its cards in `questions` (`AttemptCard`: id, front, back, image, every rating in order, cards in the order first rated), `correct` the cards whose first rating is Good or Easy, `total` the cards rated, `taken_at` the latest rating. |
| `answer_events`, `attempts.workspace_id` | Migration `0143_answer_events.sql`: one row per graded part of every checked question, and the workspace an attempt was taken in ([Answer events](#answer-events)). |
| `flashcard_cards (card_id, material_id)` | The old `card_stats` without its review columns: the card-to-set lookup card edits, deletes, listing counts and clone use. `card_id` is a global key, so clones mint new card ids. |

`study_progress` and `workspace_study` cascade with their workspace;
`study_progress` also with its material; `review_states` and
`review_log` with their material. User foreign keys never cascade because user
rows are tombstoned; `PurgeUser` deletes the four tables and `review_sessions`
(answers cascade) explicitly. `review_sessions` cascades with its workspace,
`review_answers` with its session or material.

What still reads `study_progress`, so the table stays:

- `learningScope` and `learningStart` (`learning_overview.go`): a row brings a
  link or public visitor's workspace into Learning, its latest `updated_at` is
  the suggestions' interest and the workspace's last practice, and no row means
  a quiz or set is not started. `state` has no reader: a quiz's first check
  writes `done`.
- `ResetStudy` and `PurgeUser` delete rows; `markProgressTx` writes them.

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
- a question: SHA-256 of the text of its stem's text blocks, of each part's
  prompt text blocks and, as the stem's, of its groups' text blocks in reading
  order (`QuestionHash`). Answer keys, choices, marking schemes, hints, solutions,
  marks, images, graphs, layout and styling are left out, so editing them keeps
  the learner's state. A group with no text adds nothing, so grouping parts alone
  keeps it too, and a question with no group hashes as it always did.

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
| `GET /api/workspaces/{id}/study` | `StudySummary`: `enabled`, `recentAttempts` (the last 5 on the workspace's untrashed, non-embedded quizzes), `reviewable` (size of the review pool), `quickReview` and `unfinished` (the latest whole-workspace session left before its end, for Continue review). Since the workspace Study page went (2026-11-03) the app reads only `enabled` (Workspace settings → Study); `quickReview`, `unfinished`, `recentAttempts` and `/study/attempts` have no page, and stay for now. |
| `GET /api/workspaces/{id}/study/attempts` | `WorkspaceAttempts`: every untrashed, non-embedded quiz and set of the workspace with its `size` (questions or cards, from `itemsOf`), the user's attempt `count` and its latest three attempts, for the Study progress page. |
| `PUT /api/workspaces/{id}/study/enabled` | Upserts `workspace_study`: `false` is Hide study progress, `true` shows it. |
| `GET /api/workspaces/{id}/dashboard` | `WorkspaceDashboard` (`dashboard.go`), the workspace Dashboard for any reader: the owner's name, `members` (owner included) and `activity`, the five newest of the workspace's untrashed files (`uploaded`) and top-level materials (`added`), newest first, each with its actor's name and avatar for a caller with a membership (a link or public visitor gets the rows without them). A material the chat agent made (an `agent_operations` row of kind `create_material` naming it) reads `agent` when the caller asked for it, else `added` under the asker's name. There is no activity log: joins, edits and deletions do not show, and notifications (personal: invites, role changes, removals) are not used. |
| `POST /api/workspaces/{id}/study/reset` | Deletes the user's `study_progress` rows in the workspace and `review_states` of every material in it and of their own practice quizzes linked to it. Attempts, the review log and the switch stay. |
| `GET /api/workspaces/{id}/review?group=&topicId=&mode=&items=&count=&order=` | A new session: a suggestion's items (mode set) or the group's (no mode: a topic, Other files or the whole workspace, new items mixed in), each with its content (card faces, or the answer-free question, `questions.LearnerView`), material title and `reason` (`new` from the new pool, `missed` with an Again among its latest answers, else `fading`), plus the group, mode and evidence to send back with each answer. `items=quiz` serves questions only whatever the review items preference, and 10 of them unless the learner picked a session size (Practice's topic sessions). A topic not in the workspace is 404. |
| `GET /api/workspaces/{id}/practice` | `Practice` (`practice.go`), Study → Practice for any reader, by the workspace's kind: `suggestions`, this workspace's suggested reviews over its questions only (`groupSuggestions` at full interest, since the learner is here; at most three, none while study progress is hidden); `quizzes`, every untrashed top-level quiz in reading order with its question count (`itemCounts`, refused content left out) and the caller's `best` attempt (best share of marks); `reviews`, the caller's topic and Other files sessions that answered a question, one row per topic: the latest one's served count and the best one's marks. A class's owner and editor members get neither of those but `members` (viewer members) and per quiz `triedBy` (viewer members with an attempt) and `average` (the mean of their best scores, 0 to 1, only once five tried: aggregates need five, Epo 2026-11-03 §11.8); never anyone's answers. |
| `GET /api/review/sessions/{id}` | Continue: an unfinished session's items still to answer, read now (items that left their material drop, as do those of a material the caller may not read now, `materialEffectiveAccess`: hidden or assigned since it was served, or never theirs, since the browser sends the served list), with answered of total. Another user's session is 404. |
| `GET /api/review/sessions/{id}/result` | A session's result, finished or not: its Past reviews row (`ID` read), its answered items in answer order with their records (the resume read's `done`, under the same read rule), and `better`, how many were rated above their latest `review_log` rating before the session started. Another user's session is 404. |
| `POST /api/review/sessions/{id}/finish` | Ends a session before its last item. |

The new-session and Continue reads also carry `removedAssetIds`: the card and
question images of the items still to answer that their uploader deleted, or
that went with the uploader's account (M16, Epo 2026-10-24). The session shows
each as removed by its uploader, as flashcard study does from the set read's
own list and a quiz attempt from the quiz's. Answered items and the result are
graded copies: a missing image there keeps the plain empty box (Q270), the
result body resetting the session's list.
| `GET /api/review/sessions?sort=&dir=&workspaceId=&has=&offset=&limit=` | Past reviews: finished sessions with their quiz marks and cards remembered (Good or Easy). Sort date, quiz, cards or time; `has` quiz and/or flashcards. |
| `GET /api/learning/overview` | `LearningOverview`, Learning's Overview tab, below. |
| `GET /api/workspaces/{id}/study/topics` | `StudyTopics`, Study → Summary: `enabled` and each topic's standing. Refused (403) to a class's owner and editors. |
| `POST /api/review/ratings` | `{materialId, itemId, rating, session?, attempt?}` for a card; `attempt` (`{id, startedAt}`, minted by the study page when a run begins) adds the rating to that flashcard attempt for a workspace set, creating it with the first rating (`recordCardTx`, under the account lock, as quiz attempts, and the rating lock); another user's, another set's or a quiz attempt's id is 422 (`ErrFlashcardAttempt`); a question is 422 (it is rated by a check). Needs read access to the material, so standalone shared sets can be rated too; an embedded set is 422 (`ErrStudyEmbedded`), its study page sends nothing. |
| `POST /api/review/check` | `{materialId, itemId, answers, session?}` for a question: grades it on the server (open parts by the grading model), rates it from `correct / total` and returns `{correct, total, question}`, the question with its key and awards. A card is 422. |
| `POST /api/quizzes/{id}/check` | `{questionId, answers, attemptId?, startedAt?}`: grades one question on the server ([question-bank.md](question-bank.md#answer-keys-and-server-grading)) and adds it to the learner's attempt, whose `AttemptDetail` so far it returns; a missing or unknown `attemptId` (another user's, another quiz's, deleted) starts a new attempt, a question already checked in the attempt is 409. Its side effect is below. |

Side effects, in the same transaction as the write:

- A quiz check (`CheckQuizQuestion`, under the account lock and the rating
  lock) inserts or updates the attempt: its `questions` are the checked
  questions graded, in the quiz's order (questions since removed last),
  `answers` theirs, `correct` their awarded marks and `total` the quiz's
  marks, a checked question counting with the marks it was checked against
  (so an edit to its marks, or its removal, never takes the score past the
  total) and an unchecked one with its marks now, scoring 0. A check the
  attempt already holds is refused (409) before grading
  (`QuizQuestionChecked`), so a repeat costs no Jev call, and again under the
  locks. An attempt is never closed:
  one left partway counts as an attempt with what it checked (Epo
  2026-10-25), and `taken_at` is its latest check. On a workspace quiz that is
  not embedded the check also rates the question if it is still in the
  document, has marks and was not left wholly blank, and sets the quiz `done`
  (progress rows, read by Learning).
  Attempts on standalone quizzes record no review state. An embedded quiz's
  check is graded and returned in an attempt without an id and stores
  nothing: no Past attempts entry, and the try lives only on the page.
- A rating writes `review_states` and `review_log`. For a workspace material
  that is not embedded it also sets progress: a question or card makes its
  quiz or set `started`, or `done` once every current item has a state
  matching its hash (2026-10-25: a review that brings a new item must not
  mark an untouched quiz done; a quiz attempt's check marks it done itself). Ratings of one user on one material take an
  advisory lock, so a set's last cards rated at once still see each other and
  mark it done. Standalone ratings write state that nothing reads.
- A `done` row stays done; later cards do not reopen a set.
- A rating or check carrying `session` (id, workspace, group, mode,
  evidence, served items) also writes the session on its first answer and
  the answer, under a row lock on the session; the last served item finishes
  it. A session of another user, or an item outside the session's workspace,
  is 422 (`ErrReviewSession`).
- A quiz check and a review check also log each graded part as an answer
  event ([Answer events](#answer-events)).
- Recording happens whether study progress shows or is hidden; showing it again shows the history.

The browser refreshes Practice, review and Learning after every
attempt and rating (`invalidateStudy`, for every workspace when the caller does
not know which); the review session refreshes once at the end instead.

## Answer events

Migration `0143_answer_events.sql` (todo-study-tracking.md §5, step 3 of its
order of work). `answer_events` is an append-only log of every graded part,
read by the topic labels (below) and kept for the mastery model still to come. It
keeps partial credit, which `review_log`'s ratings drop.

- **Written** by `logAnswerTx` (`server/internal/store/answer_events.go`) in
  the check's transaction, one row per part, on the two routes that grade
  parts:
  - `POST /api/quizzes/{id}/check` (`CheckQuizQuestion`): source `quiz`,
    with the attempt's id. Every quiz check belongs to an attempt; there is no
    separate submit.
  - `POST /api/review/check` (`RateItem` with the graded question): source
    `review`, for review sessions and Quick review, with no attempt.
- **Not written:** a wholly blank question (`questions.Blank`, which an
  attempt also leaves unrated), a part without marks, embedded quizzes, signed-out and
  shared-note checks (which store nothing), bank checks (bank questions are
  not materials) and flashcard ratings.
- **Columns:** user; workspace (the quiz's when answered, null for a
  standalone quiz); material, question and part ids; `item_hash`
  (`QuestionHash`, as in `review_states`); `answer_type`; `awarded` of
  `marks`; `grader`, `ai` for an answered open part (Jev marks it) and
  `deterministic` for the rest, a blank open part included; `source`;
  `attempt_id`, with no foreign key (only an account purge deletes attempts,
  and it deletes these rows too); `key_seen`; `created_at`. The parts of one
  check share `created_at`, so they group back into their question; `id`
  orders a replay.
- **`key_seen`** says an earlier check returned this question's key to the
  user: a `review_log` rating of it, or another quiz attempt holding it,
  blank checks included. It is read before the check is rated and leaves the
  check's own attempt out. It serves the plan's same-day repeat rule. Seeing
  the key in the editor does not count.
- **Indexes:** (workspace, user, created_at) for member views and a
  workspace's replay; (material, question) for per-question statistics.
- **Lifecycle:** a deleted quiz leaves its events with no material (Epo,
  2026-11-03), as attempts outlive their quiz; they cascade with their
  workspace; `PurgeUser` deletes the user's rows; clones copy nothing.
  An event names no topic yet, so one whose quiz is gone counts toward a
  topic only once the topics step stores the question's topic on it.

`attempts.workspace_id` (same migration) is the workspace a quiz or flashcard
attempt was taken in, null for a standalone quiz, and set null when the
workspace goes, since attempts outlive it. The attempts list still filters by
the item's current workspace (`ListAttempts`).

## The review pool

`reviewPool` is every rated (practised) item whose hash still matches, across the
workspace's quizzes and sets that are not trashed or embedded, sorted by retrievability
ascending (ties keep material position, then document order). Unrated items
never enter it. It feeds `reviewable`, Quick review, the session and
Learning's count. It reads only materials the user has rated, states included,
in one query, and parses a document only when the cache misses its revision.
A quiz or set whose stored content the current rules refuse (`refused` in
`study.go`) is left out of the pool, the attempts list (`itemCounts`) and a
resumed session (its served items read as gone), so Practice, Learning and review sessions show everything else (Epo 2026-10-20). Rating a
card or checking a question of it still answers 422
`material_content_unreadable`, and opening it shows the center file error,
which names the quiz or flashcard set by the kind its list gave (the workspace
list, or a cached Files page list for a standalone one).

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
A workspace without topics is one group; otherwise each topic and the
items outside topics (Other files) is one, and when none passes alone but the
whole workspace does, the workspace is the group. A group shows when its sum
times the workspace's interest is at least 3; interest is 1 until 30 days
after the last progress change in the workspace, eases to 0.25 by 90 days and
stays there. The mode (Tricky, Fading or Just learned) comes from separate
signals, since `1 - R` scales every part alike and would leave time out of
it: fading `2 x (1 - R)` against the bare tricky and learned weights, summed
over the group, largest wins. So the same answers read Tricky or Just learned
while recent and Fading once mostly forgotten (a single first miss below about
60% recall); the focus preference changes ranking, not labels. Learning fills
What to do next with them, at most 2 per workspace. The evidence words the reason: items whose last answer was a
miss, items missed twice or more, probably forgotten items (the sum of
`1 - R`, rounded), items answered at most twice, and the latest practice.

A session takes the group's items by score up to the session size, items at
R at most 0.9 only for a suggestion, then interleaves the modes so a run of
missed items is broken up. A manual review (Learning's workspace list,
Practice's topic sessions over a topic or Other files) takes its
group (the whole workspace, a topic) with no recall
cutoff, and mixes in new items (human/study-progress.md 2026-10-25):
`newPool` is every item of the scope's tracked, untrashed, top-level quizzes
and sets that the user never rated or whose content changed since its rating,
in reading order (topics in order, then unfiled; by position, newest first on
ties). `withNew` gives the new items 60% of the session size
(`newShare`) and the practised ones 40% as `pickItems` ranks them; a side that
runs short leaves its places to the other, and the two are spread through the
session in their shares. Suggestions, Quick review and every count stay on
practised items: only a new manual session reads `newPool`, which parses every
quiz and set in scope (through the cache, documents loaded only on a miss).
Starting a session has its own rate limit, 60 an hour with a burst of 10
(`Review` in `ratelimit`), which its start dialog's question count shares since it
reads the same pools; continuing one reads only its own items. The focus
preference ranks the practised side as it ranks suggestions.

Preferences live in `users.study_preferences` with the chat's: `reviewSize`
10, 20 (default; a Practice topic session takes 10 until one is picked, Epo
2026-11-04, board F1), 30 or 50; `reviewItems` both (default), quiz or flashcards,
for suggested and manual sessions; `reviewFocus` balanced (default), tricky,
fading or learned, for suggestions, suggested and manual sessions and Quick
review. The chat ignores them.

## Practice

Study → Practice (Epo 2026-11-03, boards P1 and P2) replaced the workspace's
centre Study page (its railway map, Continue, Quick review, Quick actions,
Contents and plan select went with it, 2026-11-03). What each person gets
follows the workspace's kind (board U3, the map in
[authorization-permissions-lifecycles.md](authorization-permissions-lifecycles.md#permission-matrix)):
`studyView` in `src/features/study/practice/studyView.ts`. Every quiz members can
see is practice: until hidden quizzes exist, every untrashed, top-level quiz.
The page is `src/features/study/practice/PracticePage.tsx`, lazy-loaded into
the centre while nothing is open and the URL has `study=practice`
(`parseWorkspaceOpenSearch`). From lg it fills the centre panel without a
file header (28px 36px padding); one column keeps the header for the Files
dropdown and ⋮, which with the dropdown's foot lead to Practice, Summary and
Assignments, each only for whoever has that page. The rail's Study opens it and
its panel (`StudyPanel.tsx`)
lists Study's pages: in a class, Members, Assignments and Practice for owner
and editor members, Summary, Assignments and Practice for others; in a
personal workspace, Summary and Practice for everyone. Practice, Summary and
[Assignments](#assignments) are built; the rest show as muted rows with a
"Coming soon" title and do nothing. Practice's row is current on the page, during a topic session
and on its result.

Data: `GET /api/workspaces/{id}/practice` (`qk.practice`, under the
workspace's `study` key, so `invalidateStudy` refreshes it) and the topics.

- **Whoever practises** (P2: a class's members, and everyone in a personal
  workspace): the title with the workspace's name, then **Suggested**:
  up to three suggestions, each its group (topic, Other files or Whole
  workspace), the mode's label and today's reason in words (`reviewReason`),
  and Practise, which starts the suggestion's session (its mode, so due
  practised questions only). Then **All practice** with the Topic filter (All,
  the topics the rows hold in topic order, Other files last): first their own
  topic reviews (a circular arrow, "<topic> review", a lock and "Only you"),
  then the quizzes, each with its topic (one per quiz: the quiz's own topic
  until questions carry topics), question count, the best ("7 / 10", half
  marks kept; "–" before any attempt) and Practise. A review's Practise
  starts a new topic session on its topic; a quiz's opens its attempt page
  (`/quizzes/$quizId/attempt`, outside the workspace).
- **A class's owner and teaching assistants** (P1): the title with "· N members", the Topic
  filter and the quizzes with Tried by ("5 of 6") and Group average ("74%",
  "–" under five tries). No Suggested and no own reviews: their own study
  waits for Summary. A row opens the quiz in the workspace.
- Add practice (whoever may edit: a class's staff, a personal workspace's owner
  and editors, whose quiz rows also open the quiz) shows disabled with a "Coming
  soon" title. Everyone else gets Make my own practice (below).
- Below md the table becomes one row per item with its facts under the
  title (topic, questions, tried), the score and Practise on the right.

### The Dashboard's What to practise next

`SuggestedList` with `onReviewAll`, for whoever practises and while the workspace
holds a quiz: up to three suggestions, then Workspace review (board D2), whose Start
opens the topic session's dialog with `group=workspace`. So it is that session:
questions only, at most 10 until a size is picked, 60% new and 40% practised
(`withNew`), and the dialog lists them first. Sets are studied on their own page.

### Summary

`SummaryPage.tsx`, `study=summary` (boards G5, M1), for whoever practises: one
row per topic holding a quiz the caller can see, in reading order with Other files
last: its label, "9 of 10 right" (each question's latest check, full marks),
squares for every question (right, partly, wrong by its latest answer, grey when
not attempted, a quiz left partway included; above 10 they scale to 10 and any
unattempted question keeps at least 1 grey; `topicSquares`), and Practise, which starts that topic's session.
Assignments' overall joins it once they exist. While study progress is hidden it
says so, with a Workspace settings button. Make my own practice sits at the top right.

### Make my own practice

`MakePractice` (Epo 2026-11-04, boards P3 and T5) writes a quiz from sources with
the learner's credits, through `/generate`, and opens it ready to answer: From
(Topics or Files), the picks, Questions (5, 10, 15, 20), Question types (Mixed,
Multiple choice, Short answer, Open answer) and Mix in questions I have answered.
Only topics holding indexed files or notes are offered, and Summary starts on the
weakest. Only the quiz is kept. Mix in takes about 30% of the count
(`generateMixShare`) from `MixInQuestions`: the learner's own weak questions in
scope, copied into the new quiz.

Who can edit the workspace gets an ordinary quiz file there. A member of a class
gets one only they can reach: their own standalone material, charged to them,
linked by `materials.practice_workspace_id` and `practice_topic_id`. Those links
count only for its maker (`reviewPool`, `newPool`, `itemCounts`,
`Material.StudyWorkspaceID`), so it feeds their labels and reviews, shows on their
Practice marked Only you, and lists in their own Files. Its sources are what they
can read (`VisibleSourceItems`), and the pipeline reads hidden items only for an
editor (`readsHidden`).

### Topic labels

`review.TopicLabel` (Epo 2026-11-04, names and thresholds 2026-11-03) counts a
topic's labels from `answer_events` on read, with no tables and no fitted model:
success follows Beta(1 + right, 1 + wrong) over weighted marks. A part weighs
`repeat x parts x age`: `repeat` 1 for a question's first check, 0.5 a day or more
after its previous one, 0 for a same-day repeat with `key_seen`; `parts`
min(1, 3 / parts in the question); `age` 0.5^(days / 30). Only a question's latest
content counts. A check is one attempt's parts of a question, or with no attempt
(a review) those sharing a time, and the latest row per attempt and part stands,
so an assignment's open part marked later joins its check and a changed mark
replaces the earlier one. A question's topic is its quiz's, questions having none of their
own yet, so a quiz spanning topics counts wholly to one and a moved quiz takes its
history along. Flashcards stay out (2026-11-03).

| Label | Rule |
| --- | --- |
| Not started | No answers |
| Attempted | Fewer than 3 different questions |
| Needs practice | P(success < 0.6) at least 0.8; holds until that falls below 0.5 |
| Familiar | Between |
| Proficient | P(success > 0.7) at least 0.8 |
| Mastered | Proficient, then a question at least 3 days later scored 0.7 or more |

It ignores question difficulty, so once sessions adapt a weak learner served easier
questions reads better than they are; the mastery model replaces it without
touching the UI.

### Topic sessions

`TopicPractice.tsx`. Practise on a topic is a review of that topic with
today's engine (Epo 2026-11-03, F1): `GET …/review?group=topic&topicId=&items=quiz`
serves the topic's questions only, missed and fading ones ranked as a manual
review ranks them plus questions not seen yet (`withNew`), at most 10, or the
session size once the learner picked one (`topicSessionPrefs`); no AI-written
items. The URL holds the start (`group`,
`topicId`, `reviewMode` for a suggestion); the batch fetched then is the
session.

- **Start (F1, Epo 2026-11-04):** a dialog over Practice with the session's name
  and "n questions · about m minutes" (1.2 minutes a question, rounded). Questions:
  10, 20, 30, 50 under what the group holds, then All
  (`GET /api/workspaces/{id}/study/question-count`); it starts at 10 or All. Mode:
  Recommended (today's draw), Unattempted first (never answered in reading order,
  then the rest by score) or Answered incorrectly first (latest answer Again or
  Hard by score, then practised, then never answered), sent as `count` and `order`.
  Timer: off, or 10, 20, 30 or 60 minutes. Under them, a scrolling list of the
  questions those choices draw, each with its reason chip: every change fetches a
  new batch (counting toward the `Review` rate limit), and Start runs the batch on
  screen. Closing returns to Practice. Questions only: flashcards stay out.
- **Session (F1b):** in the page's place, a header row with the title, "3 of
  10", a 140px progress bar, the timer's time left when one was picked (at zero
  the session ends as End session does; the time is not recorded) and End session; then one question at a time,
  "Question n · <answer type>" and its chip over the quiz page's runner and
  Check (`POST /api/review/check` with the session, so the first answer
  records it), the checked result with its key, and Next. The last Next, or
  End session after an answer (`finish`), opens the result; End session
  before any answer goes back to Practice. Leaving refreshes Practice and
  progress once. The first check marks the Get started list's Practise a
  topic step.
- **Session done (F4):** `study=practice&review=<id>` reads
  `GET /api/review/sessions/{id}/result`: the title with Done, "n of m right"
  (full marks among the answered questions), QUESTIONS with each number, a
  result square and word (Right, Partly, Wrong; the square alone on phones),
  the first line and its reason chip; then ← Practice and Practise again (a
  new session on the same topic). The topic label change on the board (Needs
  practice → Familiar) waits for mastery.
- The session is kept in Practice as the learner's own review ("Only you").

Hide study progress (a switch in Workspace settings → Study, on while
progress is hidden) keeps recording; Practice then shows no Suggested. Everyone signed in with access
opens Workspace settings: phones on the tab list, wider screens on the first
tab, General for owner and editor members and Study for everyone else (viewers,
share-role visitors), their only tab beside Others when they may clone. The rail avatar's menu carries Workspace settings.

### Flashcard results

A study run on the app page mints an attempt (`StudyAttempt` in
`StudyBody.tsx`: a uuid and start time, renewed by Study again or Reset) and
sends it with every rating; the server records it for workspace sets only.
The run resumes after a reload or a later visit (Epo 2026-10-25): the app and
share pages keep it in localStorage (`capy.flashcardRun.<owner>.<setId>`,
the owner the signed-in user's id on the app page, so another account on the
browser starts its own run, and `share` on share pages; `useKeptFlashcardRun`
in `flashcardRun.ts`: the attempt id, start, latest
rating and each card's ratings, faces read from the set again, so a card
deleted since leaves the run; share pages read it after hydration), and
`resumeSteps` puts the rated cards behind (read only) and ahead the unrated
cards in set order, then those last rated Again; skips are not kept. Note
embeds keep nothing. While studying, once the run has a rating, an outline md
Reset at the far right of the title (`ResetButton`, also on quiz pages once a
question is checked) starts a new run and forgets the kept one; the run so far
stays an attempt. A result shows Study again (Redo quiz) instead. When the
run ends, the page shows `FlashcardResult` (`src/features/flashcards/FlashcardResult.tsx`)
in the quiz result's layout (TabContent, left aligned) from the page's own
ratings, so embeds and share pages show it too. The score of first ratings
Good or Easy, the gain in that count since the set's previous attempt (shown only when it rose)
(`previous` on `GET /api/attempts/{id}`, a flashcard attempt's latest earlier
attempt of the same set; the study page reads its own attempt back through
`usePrevious`, embeds and share pages show none) and a stat line (minutes,
cards) sit beside a bar per rating (Again, Hard, Good, Easy in
`bg-solid-error/warning/info/success`, each with its count, labelled by the
axis). Under a rule, Cards lists every card's back (`CardBackFace` tile:
front and answer each capped in height and scrolling with no scrollbar, edges
fading; no image) in a grid (`CardGrid`, the one every flashcard grid uses, columns of 350px or more; the
page is `TabContent wide`, max-w-4xl) with its number in
first-rated order and its ratings as tinted chips; the list pages' `SortMenu`
orders them by Flashcard order, Hardest (first rating, then last) or
Easiest. Study again sits where a quiz result's Redo quiz does. A recorded
attempt's page, `/flashcards/attempts/$attemptId`, is `AttemptResult` with
the same body and Study again in place of Redo quiz. Quiz results show
minutes too: each check sends when the try began, and the minutes run to the
latest check; the score
row reads "18.5 / 26 marks" with the minutes beside it under a clock
(`ResultScore`; only the Question bank's topic summary shows a percentage
there), and `attemptMeta` writes "date · workspace" in the stat line's type
(text-sm, fg-secondary) for quiz and flashcard results alike.

## Review session

`/learning/review/$workspaceId?from=workspace|review` with `group`,
`topicId` and `reviewMode` for a suggestion, or `session` to continue
(`src/routes/ReviewSession.tsx`), a full page scoped to one workspace, under the flashcard and quiz pages'
header (`QuizPageHeader`: back arrow and one crumb, Learning or the
workspace's Practice per `from`, above the title). Practice runs its own topic
sessions inside the workspace (above). The
session is the batch fetched when it began, so it does not reshuffle as
ratings land; the browser mints its id and every answer carries it with the
served items, so the first answer records the session. Items come one at a time
with small Previous and Next buttons (`StepNav`), the stepper shared with
flashcard study (`src/features/study/steps.ts`). Next skips an
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

The last item opens the session's result (below) once its pending ratings
are saved, with the next suggestion and Start under it. Review again there
waits for every pending
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
(`src/features/flashcards/CardStack.tsx`, also the review session's card;
note embeds use its shorter compact size):
"Card 1 of 6" centred above the card, which flips
on a click (the text swaps in place, old face up and out, new face in from
below, the ratings rising in one after another) and carries the text rating buttons
(`src/features/study/RatingTiles.tsx`) on its back; the back
(`CardBackFace`) pins the front's text as a centred header at the top and
centres the answer under it, the image staying on the front; small Previous and Next
(`StepNav`) sit under it at the right. Next skips without rating (the card goes
to the session's end), Previous shows the cards before it: a rated one read
only with its rating ringed, a skipped one still to rate. Moving on
swipes the top card off to the top left over the next one (no motion under
reduced motion). Signed in, each rating
posts to `/api/review/ratings`; a shared link, signed in or out, renders the same
page, rating with ts-fsrs into IndexedDB, as shared quizzes keep attempts in
the browser (Epo 2026-11-06, Q663 A). Embedded sets study there too and send no ratings
(`parentMaterialId` on the set).

## Learning

Rules and scores, no AI (Epo 2026-11-04; `features.learning`, on). Tabs:
Overview (default), Past reviews and All results; `src/routes/Learning.tsx`. The
session and result pages stay under
`/learning/review/$workspaceId` and `/learning/reviews/$sessionId`.

### Overview

`src/features/study/LearningOverview.tsx` over `GET /api/learning/overview`
(`server/internal/store/learning_overview.go`). Scope (`learningScope`): the
workspaces the user owns, has joined, or practised in while they can still read
them, minus a class they own or edit (Practice's own test) and Hide study progress.
A row is the link: it hovers whole and square and has no action at its end.

**What to do next**, at most 4 rows, led by what each is (the quiz or set's file
icon, the retry arrow for a session or suggestion). Assignments stay off it.

1. Practice, at most 3. What was left partway, newest first: an unfinished
   session, or a quiz whose newest attempt checked fewer questions than it holds,
   last answer within 14 days. Then new: each workspace's first quiz or set in
   reading order with no `study_progress` row, where the user is the owner or a
   member and opened or practised it in the last 30 days, the latest first.
2. Suggestions fill what is left: the engine above over questions only, at most 2
   per workspace, past a topic with an unfinished session. A row opens the topic
   session's start dialog over that workspace's Practice, as the Dashboard's do, so
   closing it stays there. Sets are not suggested anywhere for now (Epo 2026-11-04).

**Workspaces**, newest practice first, each workspace holding a quiz or set: counts
per topic label, weakest first, "38 of 120 items tried" (rated items with current
content, of all items) and the last practice. A row opens the workspace's Dashboard.

**You teach** lists a class's owner or editor's classes with their member count; a
row opens the class's Practice until Members exists.

With nothing in any section the page shows the ink book, "No quizzes or flashcards
yet" and an outline Go to Workspaces. An empty section is not shown.

### Past reviews

`src/features/study/PastReviews.tsx`, its own tab, its filter at the top right: finished sessions in Billing's plain table
(`BillingTable`, no border, scrolls sideways) at every width (Date,
Workspace, Topic, Quiz, Flashcards, Time, Status; Time and Status
from xl; no row menu: a click anywhere on a row opens the result, which has
its own Review again),
sorted from its column headers (`SortHeader`, no sort menu: date, workspace,
topic, quiz score, flashcard score, time spent, status; text columns
start A to Z, the rest newest or largest first, a second click flips) and the
list pages' filter (workspace, has quiz questions or flashcards), both kept in
the URL (`parsePastReviewsSearch`). Topic
is a topic session's topic or Other files (empty for whole-workspace
sessions) and sorts topic sessions by name with the rest last; status puts
completed before stopped. Quiz is marks of the questions answered, Flashcards
cards rated Good or Easy. A session ended early shows "Stopped after
N of M" under Status. Scores are plain "x / y" text. Thirty
rows a page. All results lays out as Files' list does: toolbar right under
the tabs, then the table in the list's padding. Workspace, topic and quiz
names show the workspace icon beside the name (`WorkspaceCell`) and wrap to
two lines before the ellipsis; their columns are somewhat wider than the
number columns, and every column shares the leftover width.

### Review result

`/learning/reviews/$sessionId` (`src/routes/ReviewResult.tsx`, breadcrumb
Learning / Past reviews), and the end of a session, draw `ReviewResultBody`
(`src/features/study/ReviewResult.tsx`) over `GET /api/review/sessions/{id}/result`.
The title is the group (topic, Other files, or the workspace), the meta the
start's date and time, workspace and minutes. "N better than last time" (plain
green, only when N > 0) sits beside an accent Review again. A split view puts
questions (marks) left and flashcards (Good or Easy of all) right, one column
on phones, each with one bar from best to worst and its counts (right, partial,
wrong; Easy, Good, Hard, Again). Then a Questions section and a Flashcards
section, each with its count and its own Sort (Review order, Hardest,
Easiest); items keep their session numbers. A question row leads with one
small square per part in its result colour, then "n. text", the quiz and its
marks in the result colour, and Right, Partial or Wrong; it opens to the quiz
result page's graded renderer (`QuestionRunner` with `review`,
`headerMarks={false}` since the row shows the marks). Flashcards are the
flashcard result page's tiles (`ResultCardTile`). A one-kind session shows
its half alone.

### All results tab

`src/features/study/AllResults.tsx`: quiz and flashcard attempts (Date
with the time, newest first by default; Name with the item's icon, Workspace,
Score, ⋮ with See result and Redo quiz or
Study again), the same table switch below md. A click anywhere on a row
opens See result (`resultLink` in `src/features/study/attempts.ts`:
`/quizzes/attempts/$id` or `/flashcards/attempts/$id`, one `AttemptResult`
route for both). A flashcard score reads "14 / 18 good". Attempts carry the
workspace's `iconId` (left out once the item is deleted).
`GET /api/attempts?sort=&dir=&kind=&workspaceId=&offset=&limit=` (`ListAttempts`)
sorts (date, score as correct / total, name, workspace name; from the
column headers, as Past reviews), filters by kind (the Filter's Kind
section: Quiz, Flashcards) and by the item's current
workspace and pages in SQL, thirty a page loaded on scroll; each attempt
carries that `workspaceId`, null once the quiz is deleted, so a workspace
filter leaves those out. The filter lists the user's workspaces as Files
does. Sort and filter live in the URL (`parseResultsSearch`; the route picks
the parser by `tab`). Each list's last sort pick is remembered in the browser
(`sortSearch`, `src/lib/localPrefs.ts`): opening Workspaces, Files, Blocks,
Past reviews or All results without a sort in the URL redirects to it.

## Lifecycle

| Event | Effect |
| --- | --- |
| Review session opened and left unanswered | Nothing is written. |
| Topic deleted | Its sessions keep their answers with no topic. |
| File or material trashed | Rows stay; every read skips trashed items; restore brings them back. |
| Material purged | `study_progress`, `review_states` and `review_log` cascade; `answer_events` stay with no material. |
| Item removed from a document | Its `review_states` row is ignored until the item returns. |
| Question prompt or card face edited | That item's state resets on its next rating; until then it is out of the practised pool and comes back in a manual review as a new item. |
| Workspace deleted | All four workspace-scoped tables and `answer_events` go by cascade; attempts stay with no workspace. |
| Member or link access lost | Rows stay, unreadable without access; Learning skips the workspace. |
| Workspace or material clone | Nothing is copied; cloned cards get new ids. |
| Workspace transfer | Rows stay with each user; `study_progress` and `workspace_study` are in `notOwnership` (`workspace_transfer_test.go`). |
| Account purge | `PurgeUser` deletes the user's rows in all four tables and `answer_events`, their review sessions. |
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
owner's workspace. Its `/practice` mock seeds Biology 101 with a Membranes &
transport review and fixed member counts (six members, an average once five
tried); Biology 101 is the mock's class, the other workspaces personal; the
`workspace-member` and `workspace-editor` scenarios (`src/mocks/scenarios.ts`,
kept across reloads) open workspaces as a viewer or an editor member.

## Chat agent

The chat agent cannot read study progress: `read_study_progress` went on
2026-11-04 (Epo, contract v48) until AI analysis of study progress is decided.

## Signed-out study

Signed-out visitors of standalone link or public quizzes and sets use
`ts-fsrs` in the browser (`src/lib/srs.ts`, fuzz on, with due dates and
interval previews): only due cards are queued, quiz attempts and an
append-only card review log plus card states live in IndexedDB
(`src/lib/localDb.ts`, database `capy-local`), and nothing is imported into an
account on sign-in. Shared quiz and flashcard pages keep a signed-in visitor's
attempts and ratings there too, since nothing on them counts (Epo 2026-11-06,
Q663 A). `SrsState` is a hand-written type in `src/lib/srs.ts`.

## Assignments

Work a class's owner and teaching assistants give its members (Epo 2026-11-03,
`todo-study-tracking.md` §4, §5, §7; boards A0 to A5, W1 to W4, G3, G3m). The
page is `src/features/study/assignments/AssignmentsPage.tsx`, the centre page
while the URL has `study=assignments` (`parseAssignments` in `openItem.ts`), and
`studyView` gates it: only a class lists Assignments, and elsewhere the link
opens Practice. The Study panel stays beside every view with Assignments current;
its count is what is left to do for a member and the assignments with answers
waiting for staff (`useAssignmentCount`, Claude's reading: the boards' counts
don't follow their rows).

**Words.** A *marked* assignment freezes a quiz: members submit it, it is marked
and it counts. An *unmarked* one is a title and optional files (picked from the
workspace's) that members tick. Neither is a file. There is no other state than
draft or published: a draft is invisible to members, and publishing posts it.

**Data** (migration `0147_assignments.sql`):

| Table or column | Holds |
| --- | --- |
| `assignments` | Kind, title, `source_quiz_id`, the frozen `questions` with their keys, `question_count`, `total_marks`, `due_at`, `time_limit_min`, `attempts_allowed`, `no_late`, `late_penalty_pct`, `assign_all`, `draft`, `marking` (`ai_approve`, `ai` or `manual`, migration 0157), `show_answers`, `shuffle`, `posted_at`, `closed_at` (closed by hand; a No late submissions one closes from its due date without it), `released_at` (its quiz became practice, once) |
| `assignment_assignees` | Picked names and a staff member's own "You" |
| `assignment_files` | An unmarked assignment's files and materials, in order; a file moved to another workspace leaves (`moveFileTx`) |
| `assignment_done` | A member's tick |
| `editor_assets.assignment_id` | A frozen copy's image rows |
| `assignments.frozen_by`, `frozen_bytes` | Who pays for the frozen question JSON and its size (migration `0149_assignment_storage.sql`) |
| `attempts` (kind `assignment`) | A try: `assignment_id`, `deadline_at`, `submitted_at`, `auto_submitted`, `waiting_marks`, `waiting_answers`, with no `material_id`, so no practice read (best score, tried by, averages, review pool) ever sees it, and `GET /api/attempts` and its list leave it out |
| `answer_events` | Source `assignment`, grader `owner`: closed parts at submit, open parts when marked; a changed mark is a new row, and the latest per attempt and part stands |
| `workspace_members.sharing_notice_seen_at` | When this member was told what they share (migration `0148_sharing_notice.sql`) |

**Who it went to.** `assign_all` is every viewer member, later joiners included,
and never an editor. Named lists fix who; a removed member drops out of the
counts and off the form's list (so saving it isn't refused) and keeps their rows.
An owner or editor is left out unless they tick "You" (A1b), which then gives them
the member's page too (`own=true`). A workspace that is not a class gives them to
nobody (`assigneesSQL`), and a start or a tick answers 404 and writes nothing there
or under an owner whose account is locked (`assignmentStaff`).

**The frozen copy.** Publishing (creating, unless it is a draft, whose quiz stays
live until Publish) copies the quiz's current questions, live edits projected
first, into `assignments.questions`. Images become new `editor_assets` rows of
the workspace with no material and an `assignment_id`, so editing or deleting the
quiz leaves them, deleting the assignment deletes them (the foreign key), and a
workspace clone leaves them out. They and the questions JSON are charged to whoever
published (Epo 2026-11-05, `frozen_by`, `frozen_bytes`,
[backend-storage-quota.md](backend-storage-quota.md#what-counts)), and the Embeds tab
doesn't list them. A publisher whose account is suspended or leaving stops nobody:
staff still delete, which ends the charge, and republish, which moves the questions
JSON's charge to whoever republished; an image the assignment already holds keeps its
payer (Epo 2026-11-05), so that payer's purge takes it out of the paper. Frozen staff
still delete an assignment, and Republish, which writes, is refused for them. They resolve for staff, whoever it went to and whoever holds an
attempt at it (`frozenAssetReadable`), never another member, and they paste for
nobody (`AdoptEditorAssets`).
Members are only ever served this copy:
answer-free while running (`questions.LearnerViews`), with keys only after
submitting if Show answers is on.

**One row** (Epo 2026-11-04). A quiz and its assignment are the same content: lists
hold one row, and making an assignment changes nothing about the quiz. Whether it
is hidden stays the owner's choice, and a draft does nothing at all. While a
published assignment is open (not closed by hand, not past a No late submissions
due date):

| Who | Their row | The quiz itself |
| --- | --- | --- |
| Owner, teaching assistant | The assignment icon (`assigned`), and it opens their usual view | Theirs as always |
| A link or public editor | The assignment icon, no Clone | Theirs to read and edit; they can't clone it |
| A viewer it went to | The icon, listed even if the quiz is hidden, and it opens the assignment (`assignmentId`, the earliest due of several) | Refused: reads, checks, images, its room and the chat agent answer 404 (`materialEffectiveAccess`, `editorAssetReadable`, `live_access`, `AccountDocumentAccess`), a device drops its kept copy (`ReadableMaterialIDs`), and it is off Practice, reviews and new items. New joins and token requests are refused; nothing about an assignment closes a connection (Epo 2026-11-05) |
| A viewer it did not go to | A normal quiz if it is visible; no row if hidden | As it was, the owner's choice |

`quizAssignedToSQL` and `quizAssignmentOpenSQL` in `store/assignments.go` are the
two reads; `materialIconName(kind, assigned)` is the icon, a quill in the file-icon
sprite, on the file tree, Recent, Blocks cards and the open file's header. A direct
link to the quiz, or any fresh open of it, sends its assignee to the assignment
(`CenterContent`). Delete
(the toast's Undo) restores nothing, since nothing changed. Clones: see
[authorization](authorization-permissions-lifecycles.md#class-clones).

What this leaves open: someone already connected when a quiz is assigned keeps
seeing it, with no keys, until they leave or lose connection (Epo 2026-11-05). The
room lets them be: their live updates stop when its token next renews, within five
minutes, and what is on screen stays as it was, with no error, toast or status
(`ItemRoom.unavailable`; `useLiveQuizQuestions` keeps its last questions, and a quiz
attempt page its opening read). The quiz's page in a workspace stays too: the next
refetch of the file list changes nothing while it is open (`alreadyOpen` in
`CenterContent`). A refused read still ends what shows (Epo 2026-11-05), so a refresh
of the material answering 404, as when the connection comes back and its last read is
over 5 seconds old, shows the error page. An unassigned member of a visible quiz keeps normal access with its
checks. A signed-out browser on a public or link workspace's share page is
nobody in particular, so an assignee could open it there. An attempt made before
the assignment stays readable by whoever took it.

**Taking it.** `POST /api/assignments/{id}/start` starts an attempt, or returns
the one running (one per member: `attempts_assignment_running_idx`). A time limit
asks first (Before you start, A0) because Start starts the clock: `deadline_at`
is set on the server, and the response's `now` is what the page's timer counts
against. No limit opens straight away; a start that fails toasts and leaves the
assignment's page with its way back and Start. Answers save whole (`PUT
/api/assignment-attempts/{id}/answers`, 2 s after typing rests, on Next and
Previous, when the tab hides and on leaving the page) and the header says Saved,
Saving or Not saved. A change made during a save goes out as that save ends. Every
opening reads the attempt afresh, never from a cache, so its answers and clock are
the server's: that read failing asks to retry, while a later refresh failing leaves
the running attempt on the page. Nothing retries a failed save but the next change
and Submit, which sends them all; a submit that fails at zero leaves Submit to
press. A shuffled paper's order comes from a seed of the attempt's id, so a reload
keeps it. Bookmarks stay in this browser. Taking it never joins a room, since it
serves the frozen copy.

**Settings** (Epo 2026-11-05, `AssignmentSettingsTab`). The report has no ⋮: its last
tab, `tab=settings`, holds every action as a row. Unmarked ones have Members and
Settings; a draft has no tabs, only the rows, with a Publish row and its dark button
first. Edit quiz opens the quiz in its room (hidden with no quiz), Assignment details
the edit dialog, then Close or Reopen and Delete, each confirming as the menu did. A
quiz in the trash has no Edit quiz or Republish (`manage.quizTrashed`).
Their buttons share one width, borderless (`ghost-hover`, `danger-light` for Delete).

**Republish** (Epo 2026-11-05, `POST /api/assignments/{id}/republish`,
`RepublishAssignment`). Editing a quiz never reaches its assignment by itself. An
open marked assignment's Republish row, hinted "Last published {date}", replaces the
frozen copy with the quiz as it is now, after a confirm, with the same projection and
no-answers warning as publishing. `posted_at` moves, so members read the new Posted
date and it rises in the lists.

A running attempt takes the new copy. `assignment_republished` on the user's stream
(`publishAssignmentRepublished`, after the commit, best effort) has a page taking it
read the new questions and say "The questions were updated."; a tab that misses it
shows the old ones until its next load, and its submit is graded on the new, where a
question it never showed counts 0. Saved answers that no longer mean what the member
chose go with practice's rule (D9, `stillAnswers` in Go and in
`features/quizzes/stillAnswers.ts`): a chosen option gone or moved, a changed set of
ordering items, a matching option gone, another number of gaps. A change to the key
or the wording keeps them. `dropStaleAnswersTx` does this in the republish for what
was saved, and the open page for what it holds.

A submitted attempt keeps its graded copy and marks. What left the copy that a
submission holds stays on the report (`withRemoved`), whole questions last and lost
parts at the end of their question, so its open answers can still be marked. Approve
lists a member only if their own copy of the question has an open part.

Storage: an image the assignment already holds keeps its row (same `object_path`),
so republishing the same image charges nothing; an image it stops using stays charged
until the assignment is deleted, as submissions may show it. The questions' JSON
charges who republished, gated on only what it adds to their own copy. As totals can
then differ between a member's attempts, the highest share of each attempt's own
total counts (`countedAttemptOrder`, Claude's pick), which is the highest mark when
totals match.

**Closing while someone takes it** (Epo 2026-11-05). Staff closing it tells whoever
has an attempt running: `assignment_closed` with its id on the user's stream
(`publishAssignmentClosed`, after the commit, best effort; reopening sends nothing).
A page taking it (`AssignmentTake`) ends as it does at zero, submitting what is on
the page, then goes straight to its results (`AttemptResults`, no Submitted); anyone
else ignores it. The close gets the
same 15 s grace as the time and a No late due date (`attemptRow.expired`, Claude's
pick), or the page's submit would be ignored for what was saved. A tab that doesn't
hear it, or answers past the grace, loses what wasn't saved: normally at most the
2 s wait, more if saves were failing. Its next save or the sweep submits what was
saved. `auto_submitted` now means the time ran out (`attemptRow.timedOut`), so closing
never says so. During the grace the quiz is
already open to them, the same short window a No late due date has.

**Submitting.** `POST …/submit` grades closed parts with the same deterministic
Go scoring as a quiz (`questions.Graded`). An answered open part is left
`pending` ("Not marked"), and the AI then marks it in the background, on the
workspace owner's credits (`markAnswersSoon`); a blank one earns 0. With Approve
AI marks on, its mark waits beside the answer (`aiAwards`, `aiComment`, `aiFlag`)
where only staff read it; off, it is the mark at once (`markedBy: "ai"`). A part left
Not marked joins no review; a quiz check can check it again (below). At zero the
page submits; a closed tab is the server's: 15 s past `deadline_at`, a No late
submissions due date or its closing by hand, the next request or
`SweepAssignments` (each minute, in `cmd/api`) submits what was saved,
`auto_submitted` unless closing was the cause. The sweep logs a row that fails and
passes over it, and picks each batch at random, so rows that keep failing never fill
it and hold up the rest. A panic in that run reports and leaves its answers Not marked; nothing above the run's goroutines would catch it, and the whole server would stop. A stack with no pipeline, like the e2e stack, marks nothing.

**The due date's policy** (Epo 2026-11-04, supersedes §11.5's close by the owner
alone). Set per assignment in New assignment's Advanced; marked work with a due
date only (the store refuses anything else, `checkLatePolicy`), so with no due date
Advanced holds Draft only.

Advanced (Epo 2026-11-04, `AdvancedSection.tsx`) is an accordion holding the policy
and Draft only, with the app's `motion-accordion` recipe. It starts closed unless a
saved assignment holds something other than the defaults there, a draft, No late
submissions or a penalty (`advancedStartsOpen`, Claude's pick). Once opened it
scrolls itself into view, since it opens at the dialog's foot, below the fold on a
phone. Editing a published assignment has no Draft only, and one with no due date
has no Advanced at all.

- **No late submissions on.** It closes itself at the due date: nothing starts, an
  attempt still running is submitted as saved, and nothing reads Late. Settings has
  no Reopen once it has closed itself (`closedItself`), though staff can still close
  it early.
- **Off, the default.** Late work is open until an owner or teaching assistant
  closes it (report's Settings, with a confirm since it shows the keys, and reversible); a
  note on Members says so. The late penalty (No penalty, −20%, −50%) comes off the
  mark of a submission past the due date: `Mark` is `Correct` less the penalty,
  which stays raw. It reads live, so changing it or the due date applies to work
  already in, and an open part marked later is penalised with the rest. Late work
  shows a warning badge, "Late −20%" or "Late" with no penalty (`LateBadge`, the
  app's `Badge`): beside the score on Results (under it on phones) and Submitted, on
  the report's Members and on the member's Assignments row. Results adds "30 / 40
  before the late penalty"; the class Average uses the penalised mark. A
  timed attempt submitted after the due date counts as late, and answer events,
  per-part marks and reviews keep the raw marks.

Nothing submitted past the due date reads Missing for staff and Overdue for the
member, with the penalty on it (Overdue −20%). An unmarked assignment has no policy
and leaves the open list at its due date. Attempts default to 1. With more than
one, the highest counts (Epo 2026-11-05, `countedAttemptOrder`): the highest mark
after any late penalty, a tie to the latest. A mark not fully approved compares on
the marks decided so far, in marks rather than a share (Claude's reading), and it
reads live, so marking an open part or changing the penalty or due date can change
which one counts. The member's row, the report and its question numbers, the class
Average and every link to a member's results read that submission.

An answer still waiting in another submission stays on Approve AI marks and in the
to-approve counts (Claude's pick), since marking it can make it the highest; a
member with two rows on a question reads "Attempt 2" on each. Reviews still rate a
member's latest submission (`latestAttempts`, Claude's pick), as what they know now,
and an earlier one marked after the release moves its mark alone.

**Results** (A5). The mark top right is marks decided over marks decided, so a
waiting part never reads as lost; Submitted (A4) says the same as "Your mark so
far". Right, partly, wrong and not marked counts sit above every question, which
opens to its answer, marking points and worked solution. Show answers off leaves
marks and comments and removes keys, marking points and solutions on the server
(`gradedWithoutKeys`). Practise again shows once its quiz is practice. The top right
shows the mark after any late penalty, with the unpenalised mark under it.

**The report** (G3, G3m, A3; `GET /api/assignments/{id}/report`, owner and editor
members only). Chips, then three tabs, each with its link: Questions (`tab` absent:
percent correct and answer frequencies, common wrong answers, how often each
marking point was awarded, "Often missed" under half), Members (`tab=members`:
submitted, Late with its penalty, Missing, minutes taken, mark, "n to approve"; a row opens that
member's Results, where any mark and comment can change) and Approve AI marks
(`tab=approve`, `&question=`, `&member=`; A3 by question, A3b by member). Percent,
average and the table's Average need five results (§11.8). The links
`/workspaces/{id}/study/assignments/{id}` redirect to this URL.

**Marks.** `POST /api/assignment-attempts/{id}/marks` sets one question's marks,
in half marks up to each point's or closed part's marks, and its comment.
Totals move in the same transaction. A row the AI marked reads its mark and its
pane starts from it, so Approve saves what shows; changing a mark approves it too.
A rule the answer broke shows as a warning above its marking points (red for copying
and instructions to the marker, amber for any other), with an icon on its row. Clear
warning takes it off at once (`clearWarning`), and Approve keeps it for the member
unless it was cleared. With Show answers off a member reads no warning until the
assignment closes, since it could quote the marking scheme while they can still
resubmit; reopening hides it again.
`POST /api/assignments/{id}/approve-ai-marks` takes every AI mark on one question
(Approve all). A row it has not marked (no credits, a failed part, a restart, or a
submission the sweep made, which starts no marking) reads Not marked, its AI column
"–": `POST /api/assignments/{id}/mark-with-ai` runs the AI over all of those, one
attempt at a time per payer, with "Marking 12 of 40 answers…" from the report's
`marking` while it runs. Nothing retries by itself (Epo 2026-11-03).

**Closing becomes practice** (Epo 2026-11-03, 2026-11-04: closing, not the due date
alone). Once it has closed, by hand or at a No late submissions due date, the sweep
(within a minute) sets `released_at` and makes the quiz a normal visible one
(`hidden=false`) unless another open assignment still holds it; the icon and the
assignee's refusal end at the close itself. A hidden quiz's row can so go missing
for that minute. Practice notes "Assignment, closed 24 Oct" (`assignmentClosedAt`).
The owner can hide it again from its ⋮, and the sweep leaves that alone. Marked
answers join reviews at that moment (§11.6): each attempt's fully marked questions
are rated on the quiz, a later-marked one when it stops waiting.

**Sharing notice** (Epo 2026-11-04, board V1). A simple compact dialog, 540px wide
from `sm` and the width of the page less its gutters on a phone, on a viewer member's
first open of a class after joining or once for those already in one: the workspace's
name, its owner as public pages show one (avatar left of the name, read with the
notice only while it is due, supersedes the 2026-11-03 "doesn't name the owner"),
"You are sharing the following data:", then what this branch really shares with its
owner and teaching assistants, results on assignments and practice on each quiz as
part of a class count and average, and one button (`SharingNotice.tsx`, `GET` and
`PUT /api/workspaces/{id}/sharing-notice`). Dismissing it counts as told, once per member
row, so leaving and rejoining tells again. Staff and personal workspaces never see
it. The board's own line about topic labels waits for topic summaries, and its Join
step and "What members see" link for an invite preview and board G5.

**To do page.** `/todo` (`src/routes/Todo.tsx`, `GET /api/todo`,
`store/assignment_todo.go`) lists each class's Dashboard rows across the classes
the viewer owns or belongs to, in `TodoRows`, the rows both share. A class with
nothing to show is left out; those with answers waiting come first, then by the
soonest due.

**New assignment's Quiz field.** Its last rows make a quiz on the spot, wherever the
dialog opens: New quiz opens Add file's Create tab (`?add=create`), Make a quiz from a
file opens Make a quiz (`?make=files`, whose cancel returns through `makeFrom`), and
Generate questions takes this dialog's place with the generate dialog, which stays on the
page once the quiz is made. Any of them discards what was typed. A frozen workspace shows no rows. With no quizzes the field
says "Make a quiz to begin." and has no search; a list that couldn't be read says so,
with Try again. Making a quiz either way refreshes `qk.practice`, which the field reads.

**Dashboard.** `TodoSection` (H1, H2, H2b). A member's To do is what went to them:
quizzes, and the rest with a tick; Show done brings finished ones back crossed
out. Staff's holds answers to approve and anything they gave themselves, with New
assignment at its top right. A row is one button with a square hover and no action
of its own (Epo 2026-11-05): it opens the assignment's page, which starts or
continues it, or Approve AI marks. Empty, the section doesn't show. Activity gains "assigned" rows, to whoever it
went to and staff.

**Not built.** The grading switch and everything behind it (AI marks, Mark with
AI, Approve all, quoted highlights, charging). Home's To approve list and the bell. Topic labels and mastery on Results. Regrade one
question. Per-member extra time and excused work.

Sources: [store](../server/internal/store/assignments.go),
[routes](../server/internal/httpapi/huma_assignments.go),
[sweep](../server/cmd/api/assignment_worker.go),
[migration](../server/migrations/0147_assignments.sql),
[page](../src/features/study/assignments/AssignmentsPage.tsx).

## Tests

- `server/internal/store/assignments_test.go` and
  `e2e/study/assignments.spec.ts`: see [test-catalog.md](test-catalog.md).
- `server/internal/review/review_test.go` also holds the answer-history
  order Epo signed off (`TestHistoryWeightsOrder`).
- `server/internal/review/topic_label_test.go`: the label counts Epo reviewed, a
  same-day repeat, an edited question, a long question's cap, Mastered, and Needs
  practice holding.
- `server/internal/store/review_sessions_test.go`: suggestion groups (a
  passing topic, the whole-workspace fallback, a workspace without topics,
  interest discounting), session picks interleaving modes and cutting recalled
  items, the interest curve, and recorded sessions (no row before an answer,
  resume, Continue review, another user refused, finishing, Past reviews and
  the quiz filter).

- `server/internal/review/review_test.go`: rating mapping, retrievability
  order, the prompt-only question hash, a first miss counting as a lapse, part
  marks with half marks.
- `server/internal/store/study_test.go`: attempts and ratings recording
  progress, embedded quizzes recording nothing, sets going started then done,
  review selection, Quick review, the Review list, Reset and purge.
- `server/internal/store/answer_events_test.go`: quiz and review checks log
  each graded part with its grader, source, attempt, workspace and
  `key_seen` (a blank check counts as the key seen), blank questions log
  nothing, standalone quizzes log no workspace, and purge deletes the rows.
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
  question scoring; `src/features/study/practice/PracticePage.test.tsx`:
  Practice for a member (Suggested, Only you, best scores) and an owner
  (members, tried by, group average), and the Study panel's rows by role.
- `server/internal/store/practice_test.go`: Learning's Overview for a learner and
  a class's owner; served items' reasons,
  Practice's quizzes, best attempt and the staff counts and average, and the
  Dashboard's owner, member count and activity (`TestWorkspaceDashboard`).
- `e2e/study/study-progress.spec.ts` (Docker stack, the detailed checks):
  quizzes and sets practised through the attempt and study pages becoming
  reviewable; a mixed review
  session; a Practice topic session to its result and its row; Hide study
  progress in Workspace settings.
- `e2e/uat/journeys/study.spec.ts` (deployed stack, thin): one quiz finished,
  one set studied, a three-item review, and the
  `study_progress`, `attempts` and `review_states` rows.

Sources: [migration](../server/migrations/0051_study_progress.sql),
[answer events migration](../server/migrations/0143_answer_events.sql),
[answer events](../server/internal/store/answer_events.go),
[FSRS wrapper](../server/internal/review/review.go),
[store](../server/internal/store/study.go),
[routes](../server/internal/httpapi/huma_study.go),
[attempt hook](../server/internal/store/queries.go),
[practice store](../server/internal/store/practice.go),
[Practice](../src/features/study/practice/PracticePage.tsx),
[topic sessions](../src/features/study/practice/TopicPractice.tsx),
[Dashboard store](../server/internal/store/dashboard.go),
[review session](../src/routes/ReviewSession.tsx) and
[Learning](../src/routes/Learning.tsx),
[Learning's store](../server/internal/store/learning_overview.go) and
[topic labels](../server/internal/review/topic_label.go).
