---
type: Backend
title: "Study Progress and Review"
description: "Per-user study progress in a workspace, FSRS review state in Go, suggested reviews and their scoring, recorded review sessions, Study → Practice (suggestions, every quiz as practice, topic sessions and their result), Study → Overview's Topics and their labels, Study → History, Study → Members (a class's members for its staff), Learning's Overview, Past reviews and All results tabs, the workspace Dashboard's activity, the answer events log, lifecycle and access."
tags: [backend, frontend, study, review, fsrs, flashcards, quizzes, progress]
---

# Study progress and review

Each signed-in user keeps their own progress in each workspace: which
quizzes and flashcard sets they have practised (started, or done once every
item is) and an FSRS memory state per quiz question and flashcard. Progress
always shows: Hide study progress, its switch and the `workspace_study` table
went on 2026-11-09 (Epo, Q727 A). The workspace's rail leads to four pages that
were Study's until Epo 2026-11-11 gave each its own place: To do (Assignments to
a class's owner and editors), Practice (suggested topics, every quiz members can
see as practice and the learner's own topic reviews, each started as a review
session in the page's place), Members, and Study, which is now only the
viewer's own marks and mastery (the learner's label per topic; it was Study's
Summary page) and which a class's owner and editors do not have. Where this file
says "Study → Practice", "Study → Assignments", "Study → Members" or "Study →
Summary", read the rail's Practice, To do or Assignments, Members and Study.
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
| `study_progress (user_id, material_id, workspace_id, state, updated_at)` | One row per practised quiz or set (`markProgressTx`: a check or a rating writes it); `state` is `started` or `done`. No row means untouched. Migration `0145_study_progress_practice_only.sql` dropped what Mark as read and Stop tracking left behind: `file_id` and `removed`. |
| `review_states (user_id, material_id, item_id, item_hash, stability, difficulty, reps, lapses, fsrs_state, last_review)` | FSRS state per quiz question or card. The key includes `material_id`, so a cloned quiz that keeps its question ids stays separate. |
| `review_log (user_id, material_id, item_id, rating, reviewed_at)` | Append-only, rating 1–4 for every rating and every rated attempt question. Suggestions read each item's last 8 (`review_log_item_idx`); kept for offline merge and parameter fitting later too. |
| `review_sessions (id, user_id, workspace_id, topic_id, group_kind, mode, evidence, items, started_at, last_answer_at, finished_at)` | Migration `0071_review_sessions.sql` (chapters renamed topics, group `topic`, in `0136_topics.sql`). One recorded session, written with its first answer: what it drew from (`group_kind` topic, others or workspace; `topic_id` for a topic, set NULL when the topic goes), the suggestion's `mode` (NULL from the workspace list) and `evidence`, every served item in order (`items`, for Continue, each with the `reason` it was served for: `new`, `missed` or `fading`), and `finished_at` once every served item is answered or Done ends it. The id is minted by the browser. |
| `review_answers (session_id, material_id, item_id, kind, rating, correct, total, answers, graded, answered_at)` | One answered item of a session: a card's rating, or a question's rating, marks (`correct` of `total`), answers and graded question with its key. |
| `attempts.kind`, `attempts.started_at` | Migration `0094_flashcard_attempts.sql`. Quiz and flashcard attempts share `attempts`: `kind` is `quiz` or `flashcards`; `started_at` is the browser's start time (null when not sent, and never after the end), so results show minutes. A flashcard attempt keeps its cards in `questions` (`AttemptCard`: id, front, back, image, every rating in order, cards in the order first rated), `correct` the cards whose first rating is Good or Easy, `total` the cards rated, `taken_at` the latest rating. |
| `answer_events`, `attempts.workspace_id` | Migration `0143_answer_events.sql`: one row per graded part of every checked question, and the workspace an attempt was taken in ([Answer events](#answer-events)). `answer_events.topic_ids` (`0177_answer_event_topics.sql`): the topics at answer time. |
| `flashcard_cards (card_id, material_id)` | The old `card_stats` without its review columns: the card-to-set lookup card edits, deletes, listing counts and clone use. `card_id` is a global key, so clones mint new card ids. |

`study_progress` cascades with its workspace;
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
  order (`QuestionHash`). Answer keys, choices, marking schemes, solutions,
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
| `GET /api/workspaces/{id}/study` | `StudySummary`: `recentAttempts` (the last 5 on the workspace's untrashed, non-embedded quizzes), `reviewable` (size of the review pool), `quickReview` and `unfinished` (the latest whole-workspace session left before its end, for Continue review). No page reads it since the workspace Study page (2026-11-03) and Hide study progress (2026-11-09) went; `quickReview`, `unfinished`, `recentAttempts` and `/study/attempts` stay for now. |
| `GET /api/workspaces/{id}/study/attempts` | `WorkspaceAttempts`: every untrashed, non-embedded quiz and set of the workspace with its `size` (questions or cards, from `itemsOf`), the user's attempt `count` and its latest three attempts, for the Study progress page. |
| `GET /api/workspaces/{id}/dashboard` | `WorkspaceDashboard` (`dashboard.go`), the workspace Dashboard for any reader: the owner's name, `members` (owner included) and `activity`, the five newest of the workspace's untrashed files (`uploaded`) and top-level materials (`added`), newest first, each with its actor's name and avatar for a caller with a membership (a link or public visitor gets the rows without them). A material the chat agent made (an `agent_operations` row of kind `create_material` naming it) reads `agent` when the caller asked for it, else `added` under the asker's name. There is no activity log: joins, edits and deletions do not show, and notifications (personal: invites, role changes, removals) are not used. |
| `POST /api/workspaces/{id}/study/reset` | Deletes the user's `study_progress` rows in the workspace and `review_states` of every material in it and of their own practice quizzes linked to it. Attempts and the review log stay. |
| `GET /api/workspaces/{id}/review?group=&topicId=&mode=&items=&count=&order=` | A new session: a suggestion's items (mode set) or the group's (no mode: a topic, Other files or the whole workspace, new items mixed in), each with its content (card faces, or the answer-free question, `questions.LearnerView`), material title and `reason` (`new` from the new pool, `missed` with an Again among its latest answers, else `fading`), plus the group, mode and evidence to send back with each answer. `items=quiz` serves questions only whatever the review items preference, and 10 of them unless the learner picked a session size (Practice's topic sessions). A topic not in the workspace is 404. |
| `GET /api/workspaces/{id}/practice` | `Practice` (`practice.go`), Study → Practice for any reader, by the workspace's kind: `suggestions`, this workspace's suggested reviews over its questions only (`groupSuggestions` at full interest, since the learner is here; at most three); `items`, every untrashed top-level quiz and flashcard set in reading order (sets since Epo 2026-11-13), each with its `kind`, `covers` (its topic, then the workspace's other topics its questions name as their own, in topic order; an id the workspace does not hold adds none), `size` (questions or cards, `itemCounts`, refused content left out) and the caller's `best` attempt (best share of marks, or of cards first rated Good or Easy; a set's best counts only runs through every card, since a set's attempt counts the cards rated so far); `reviews`, the caller's topic and Other files sessions that answered a question, one row per topic: the latest one's served count and the best one's marks. A class's owner and editor members get neither of those but `members` (viewer members) and per quiz or set `triedBy` (viewer members with an attempt, for a set a full run) and `average` (the mean of their best scores, 0 to 1, only once five tried: aggregates need five, Epo 2026-11-03 §11.8); never anyone's answers. |
| `GET /api/review/sessions/{id}` | Continue: an unfinished session's items still to answer, read now (items that left their material drop, as do those of a material the caller may not read now, `materialEffectiveAccess`: hidden or assigned since it was served, or never theirs, since the browser sends the served list), with answered of total. Another user's session is 404. |
| `GET /api/review/sessions/{id}/result` | A session's result, finished or not: its session row (`pastReview`), its answered items in answer order with their records (the resume read's `done`, under the same read rule), and `better`, how many were rated above their latest `review_log` rating before the session started. Another user's session is 404. |
| `POST /api/review/sessions/{id}/finish` | Ends a session before its last item. |

The new-session and Continue reads also carry `removedAssetIds`: the card and
question images of the items still to answer that their uploader deleted, or
that went with the uploader's account (M16, Epo 2026-10-24). The session shows
each as removed by its uploader, as flashcard study does from the set read's
own list and a quiz attempt from the quiz's. Answered items and the result are
graded copies: a missing image there keeps the plain empty box (Q270), the
result body resetting the session's list.
| `GET /api/learning/history?sort=&dir=&kind=&status=&workspaceId=&offset=&limit=` | Learning → History: revisions and quiz and flashcard attempts with their score and status (below). |
| `GET /api/learning/overview` | `LearningOverview`, Learning's Overview tab, below. |
| `GET /api/learning/continue?workspaceId=` | Continue: History's rows that can go on, left within the week and not removed, at most 6 (3 shown, 3 spares; Overview, below). |
| `DELETE /api/learning/continue/{kind}/{id}` | Removes the caller's revision (`kind` revision) or try (`quiz`, `flashcards`) from Continue; History keeps it. Another user's is 404. |
| `GET /api/workspaces/{id}/study/topics` | `StudyTopics`, Study → Overview's Topics: each topic's standing. Refused (403) to a class's owner and editors. |
| `GET /api/workspaces/{id}/study/members` | `MembersProgress`, Study → Members: each viewer member's marks, practice this week, full storage and topic standings, and the topic columns, read for the whole class in a fixed number of queries. A class's owner and editor members only: everyone else (its viewer members, a link editor, a nonmember) and a personal workspace 404; the store refuses a member with `ErrForbidden`, which the API answers as 404 too. |
| `GET /api/workspaces/{id}/study/members/{memberId}` | `MemberProfile`, a member's profile: assignments, topics, questions still missed, recent work. The same rule; a `memberId` who isn't this class's viewer member (staff, removed, another class's) 404. |
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
  (`QuizQuestionChecked`), so a repeat costs no model call, and again under the
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
  `marks`; `grader`, `ai` for an answered open part (the grading model marks it) and
  `deterministic` for the rest, a blank open part included; `source`;
  `topic_ids` (migration `0177_answer_event_topics.sql`, `text[]`, never
  null), the topics the answer counted toward when given (the question's own
  that are the workspace's topics, else the quiz's when that is one; empty
  with none; existing rows took their quiz's when it was one of the answer's
  workspace's). No foreign key: reads keep only ids that are topics of the
  answer's workspace, so a deleted topic drops out without touching the rows
  (topic ids are never reused);
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
  Reads take an event's topics from its question's current topics while the
  quiz exists, trashed or not, and `topic_ids` only once the quiz is deleted,
  so a deleted quiz's answers still count toward their topics (Summary and
  Members standings, a day's reviews in Recent activity); with no topic left
  they count nowhere. The latest row per attempt and part is picked before
  topicless rows are dropped, so a later mark with no topic replaces an
  earlier one.

`attempts.workspace_id` (same migration) is the workspace a quiz or flashcard
attempt was taken in, null for a standalone quiz, and set null when the
workspace goes, since attempts outlive it. History still filters by the
item's current workspace (`StudyHistory`).

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
Only a real topic is a group (Epo 2026-11-13): items outside topics,
and a workspace without topics, suggest nothing, so no file or the whole
workspace is offered as if it were a topic. A group shows when its sum
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
The page is `src/features/study/practice/PracticePage.tsx`, loaded into
the centre with Study's other tabs as one page (`StudyTabsPage`: Overview
and Topics, History, Question bank and Practice load together, as the Files
page's tabs do, so a tab switch never blanks the page; Epo 2026-11-16; editors
stay out of it, e.g. the bank's `QuestionDialog` loads when it opens) at
`/workspaces/<id>/study/practice`.

Assignments, Members and Study's tabs are routes under the workspace's (Epo
2026-11-18, `src/router.ts`): `/workspaces/<id>/assignments`,
`/workspaces/<id>/members` and `/workspaces/<id>/study/<tab>`, the tab one of
`summary` (Overview), `topics`, `practice`, `bank` and `history`, all one
route so a tab switch keeps the page mounted. `WorkspaceOpen` stays mounted
across them (rail, chat, side panels) and draws the route's page through an
`<Outlet/>` in its centre (`useChildMatches` names the page); the router loads
a page's code before it commits, so a first open keeps the page before on
screen instead of a blank centre. Each route parses its own search
(`src/features/study/studyRoutes.ts`: `parseAssignmentsSearch`,
`parseStudySearch`), and `assignmentsLink`, `membersLink` and `studyLink`
build every link to them. An open file or material (`file`, `material`) is
the Files page at the workspace's own URL, whose other pages (Dashboard,
`view=files`, `view=chat`, `view=canvas`) stay search values. A page this
person doesn't have redirects to Practice (`studyView(ws).pages`, in
`WorkspaceOpen`), as does an unknown Study tab (the route's params parser).
From lg it fills the centre panel without a
file header (28px 36px padding); one column keeps the header for the Files
dropdown and ⋮, which with the dropdown's foot lead to the same pages as the
rail, each only for whoever has that page. The rail lists them
(`workspaceSections` in `WorkspaceRail.tsx`, Epo 2026-11-11; the Study panel
that listed them went): Assignments, Members and Study for a class's owner and
editor members; To do, Members and Study for every other member, in a class or a
personal workspace. Study has tabs (Epo 2026-11-13, `StudyTabs`). Whoever
practises gets **Overview** (`study/summary`, or `study/practice`: the same
page) and **History** (`study/history`, `HistoryPage.tsx`: the account
History's table, `StudyHistory` with `workspaceId`, so without the Workspace
filter and column). A class's staff get Overview and Topics (every member's
marks, Members' tabs until then), Practice (`study/practice`) and the class's
**Question bank** (`study/bank`, Epo 2026-11-14; see
[question-bank.md](question-bank.md#item-banks)). The account's Study page
(`/learning`) has Overview, History and My bank's Question bank (`tab=bank`).
`PAGE_SECTION` lights Study on the rail for any of them. A link or public visitor has no Members,
as they may not read who the members are. Outside a class's staff Members shows
no marks (`MembersRoster.tsx`, Epo 2026-11-11, mock C): the people and their
roles. First, in the settings page's order,
whoever shares the workspace (owner and editors) sets Visibility, what anyone
with access may do, and copies the link: the Share dialog's controls without
its own list of people. Under them its owner invites from a row (address, role
dropdown, Invite), changes a role with the row's dropdown and removes with the
row's Remove button after a confirmation; pending invitations list under the
people with Cancel. Roles and buttons keep one width each, so every row ends
on the same line. In a class on a phone, where Teaching assistant leaves no
room, each row has a Manage button instead, opening a dialog with the role
dropdown and Remove (Epo 2026-11-12). It shares its logic
with the Share dialog's list (`useMemberManager`). A class's owner and teaching
assistants get the same page, Members with no tabs (Epo 2026-11-13). Workspace
settings has no Sharing tab (Epo 2026-11-11): the rail avatar's Invite member
opens Members. All four are built ([Members](#members),
[Assignments](#assignments)). Study is current on the rail on Practice, during
a topic session and on its result.

Data: `GET /api/workspaces/{id}/practice` (`qk.practice`, under the
workspace's `study` key, so `invalidateStudy` refreshes it) and the topics.

- **Whoever practises** (P2: a class's members, and everyone in a personal
  workspace): their Overview. Study's title with the workspace's name and
  its tabs, then **Suggested**: up to three suggestions, each its topic, the
  mode's label and today's reason in words (`reviewReason`),
  and Practise, which starts the suggestion's session (its mode, so due
  practised questions only). Then **Topics** (`TopicsSection.tsx`, the
  former Summary): one row per topic with its marks squares and Practise.
  Then **All practice** with the list pages' toolbar (`ListToolbar` with
  `inPage`, the section's title in its `before` slot for members; Epo
  2026-11-16, Filter since Epo 2026-11-13: the topics the rows hold, any number picked, no Other files)
  and column sorts from its header (Name, Topics, Size, Your best; a class's
  staff Tried by and Group average), reading order until one is picked, a row
  without the value last: first their own
  topic reviews (a circular arrow, "<topic> review", a lock and "Only you"),
  then the quizzes and flashcard sets (sets since Epo 2026-11-13; the
  assignment dialog's quiz list keeps quizzes only), each with its kind's
  icon, its Topics: what it covers (`covers`, Epo 2026-11-15: its topic, then
  the workspace's other topics its questions name as their own, in topic
  order), the first named and "+N" for the rest as in the Assignments table
  (`TopicsCell` in `studyPage.tsx`); "–" with none. The Topic filter keeps a row
  covering any topic picked, Size (questions or cards; on phones "10 questions" or "18
  cards") and the best ("7 / 10", half marks kept; "14 / 18" for a set; "–"
  before any attempt). The first column,
  Name, starts at the section's edge, and the whole row is the action (Epo
  2026-11-13, no Practise button): a review's row starts a new topic session
  on its topic; a quiz's opens its attempt page (`/quizzes/$quizId/attempt`,
  outside the workspace), a set's its study page (`/flashcards/$flashcardSetId`),
  for a personal workspace's owner too.
- **A class's owner and teaching assistants** (P1): the title alone (no hint text beside any page title, Epo 2026-11-13), the Topic
  filter and the quizzes with Tried by ("5 of 6") and Group average ("74%",
  "–" under five tries). No Suggested and no own reviews: their own study
  waits for Summary. A row opens the quiz in the workspace.
- Add practice (whoever may edit: a class's staff, a personal workspace's owner
  and editors, whose quiz rows also open the quiz; off in a frozen workspace)
  opens New quiz (Add quiz until Epo 2026-11-20), one dialog with four ways (Epo 2026-11-11, `AddPractice.tsx`,
  at `study/practice?make=files`, so Study stays behind it and Cancel
  returns there; the Dashboard's Make a quiz opens it too, at `?make=files`
  on the workspace's own URL).
  The ways are Extract from file, Generate quiz, From question bank, Create
  blank (Epo 2026-11-16; Extract from file and From question bank were Convert
  to quiz and From the bank until Epo 2026-11-20). The dialog opens on them as
  cards, in place of a tab row (Epo 2026-11-20, board B of the quiz source
  cards mock, the cards drawn smaller): each card is the shared `Tile` with a
  `description`, holding a line drawing (`QuizWayArt.tsx`, in theme colours so
  dark mode follows; From question bank an open archive box with a document
  pulled up, Create blank a wide dashed card), the way's name and a line on
  what it does. From sm they sit in two rows (Epo 2026-11-20), three and two
  for New graded quiz's five, two and two for New quiz's four, and phones list
  them with the drawing beside the words; the cards' footer has Cancel. Their
  dialog fits them (Epo 2026-11-20, `other.fit`): as tall as they are and as
  wide as cards of about 230px (760px, or 520px for four), growing to the
  ways' one size once one is picked.
  Picking one opens it under its name, and Back (from sm; the header's arrow on
  phones) returns to the cards, the way keeping what was picked in it. Every
  way shares one size (1040px wide since Epo
  2026-11-20, for From question bank's three columns; 88dvh tall like the pages, with a
  compact footer, `SimpleDialog`'s `compactFooter`; phones full screen): a way's body scrolls inside it, so moving between ways or adding files
  never resizes the dialog, and From question bank's list fills what is left.
  **Extract from file** comes first (Epo 2026-11-14), and a link or reload
  with files picked (`?make=files&paper=…`, or a later step) opens on it. **Create
  blank** (Create quiz until Epo 2026-11-16) is a gallery like Add file's Create tab: Blank quiz and one template
  per answer type (`quizTemplates.ts`), each tile picturing its example
  question; Create makes "{workspace} quiz {n}" holding that one complete
  question (none for Blank). **Generate quiz** is Make my
  own practice's form (`useMakePractice`) without Mix in, for everyone. Its From select marks Topics and Files with
  their icons; Files is Convert's field (Choose a file over the chosen rows,
  a searchable menu of the workspace's readable files and notes), at most 5
  (`GENERATE_FILES_MAX`, `fieldlimits.GenerateFiles`, the request's
  `maxItems`). **Extract from file** is Make a quiz from a
  file's files step: the dialog is `MakeQuizDialog` with its `tabs` slot
  (`onBack` to the cards, `other` for the cards or another way), so Back and
  Continue sit at the footer's end like every way's, and Continue goes on to
  its pages and run. The step's switch, Hide the quiz,
  starts on here too (Epo 2026-11-16, every quiz an editor makes starts
  hidden; it was off here, so the quiz listed on members' Practice at once). **From question bank**
  (Epo 2026-11-14, `BankPicker.tsx`) copies picked item bank questions into a
  new "{workspace} quiz {n}" (`question-bank.md`, Item banks). Once a way's
  quiz is made (Extract's too, should its run end with the dialog on it) the
  dialog closes on the page behind it and a Quiz created toast's Open opens
  the quiz (Epo 2026-11-20, in place of opening it; `made` in
  `AddPractice.tsx`, which is also `MakeQuizDialog`'s `onDone`). A run
  confirmed and left to the panel ends there as before.
  Everyone else gets Make my own practice (below).
- Below md the table becomes one row per item with its facts under the
  title (topic, questions, tried), the score and Practise on the right.

The Dashboard has no suggestions since Epo 2026-11-13 (What to practise
next and its Workspace review went): whoever practises gets Continue there,
and Suggested lives on Study's Overview.

### Topics

`TopicsSection.tsx` on the Overview (boards G5, M1; `SummaryPage` until Epo
2026-11-13), for whoever practises: one row per topic holding a quiz the caller can see, in reading order with Other files
last: its label, "9 of 10 right" (each question's latest check, full marks),
squares for every question (right, partly, wrong by its latest answer, grey when
not attempted, a quiz left partway included; above 10 they scale to 10 and any
unattempted question keeps at least 1 grey; `topicSquares`), and Practise, which starts that topic's session.
Assignments' overall joins it once they exist. Make my own practice sits at
the Overview's top right and preselects the weakest topic (`weakestTopicId`).

### Members' marks (a class staff's Study)

`MembersMarks` in `src/features/study/members/MembersPage.tsx` (boards Main, G4
and G2 on the study-tracking canvas, Epo 2026-11-02/03; built 2026-11-08), for a
class's owner and teaching assistants (editor members) only: every other member
gets the people without marks (above), a visitor is sent to Practice, and the
routes refuse both. Since Epo 2026-11-13 they are Study's tabs for staff,
beside Practice: **Overview** (`study/summary`), the Overview below, and
**Topics** (`study/topics`), the By topic grid below; a member's profile is
`member` on either. Members (`members`) is then the roster page alone, no tabs:
link sharing, the invite row and each person's role and Remove, where a
class's roles read Member and Teaching assistant and on phones a row's
dropdown and button go under the name. The heading has no New assignment (Epo
2026-11-11): Assignments has it. It lists the
class's viewer members; `GET /api/workspaces/{id}/study/members`
(`WorkspaceMembersProgress` in `store/members_progress.go`, `qk.membersProgress`,
under the workspace's `study` key).

- **Overview** (Main): one 52px line per member: Assignments ("76% · 3 of
  4 done", then "2 missing"), Practice this week (questions checked in quizzes
  and reviews over the last seven days, never assignments; "–" for none) and
  Needs practice (the topics labelled so, as amber chips on one line: the two
  most missed, the share of latest answers wrong with a partial counting half,
  more answers then the workspace's order breaking ties, each chip cut with "…"
  only by what doesn't fit, then "+n" whose hover or tap lists the rest, Epo
  2026-11-19, mock A; else Not started
  before any answer, Nothing flagged otherwise: Attempted shows only on
  Topics, Epo 2026-11-12). Overall is the counted submission's mark after any late
  penalty (`countedAttemptOrder`, `attemptMarkSQL`) over the marks decided so
  far, summed across submitted marked assignments; "x of y" counts published
  assignments given to them, submitted or ticked; missing is marked ones past
  due with nothing submitted. Columns sort from their headers (Epo 2026-11-13,
  `sortMembers`, not kept in the URL): Member A to Z first, Assignments by
  overall, Practice this week, Needs practice by how many topics; a member
  without the value sorts last. The list pages' toolbar (`ListToolbar`
  `inPage`, as Practice's, Epo 2026-11-16: 16px under the tabs, the Filter
  icon on the gutter, Topics' "Labels need…" note in its `after` slot) has a
  Filter with Needs attention
  (`needsAttention`: work missing or a topic needing practice), on Topics too,
  whose topic headers sort the members by their standing there (weakest Not
  started to Mastered, then share right). A line opens the profile; there is
  no accordion.
- **Storage full** (Epo 2026-11-08, added since the mock): a red chip by the
  name while the member's own storage is full (`StorageUsage.Full`; the list
  reads every member's in one query, `membersStorageFull`). Hover or tap says
  "Their storage is full. They can't upload files, including for new
  assignments." (Q722; [backend-storage-quota.md](backend-storage-quota.md)).
  It shows to class staff, owner and editor members alike (Q720), on the
  member's row in Members, where the owner acts on it, and on the profile; not
  in Overview, Topics or an assignment's pages (Epo 2026-11-12). While any
  member's storage is full the rail's Members carries a red
  dot (`useMembersNeedAction`, from the same members query, asked only by
  staff).
- **Topics** (G4, `show=topics`): members × topics, by name, at every width (a
  phone scrolls it sideways), 64px rows, each cell
  the member's label as a pill with "9 of 10 right" (or "–" and Not started),
  under a pinned All members row: how many need practice when any do, else the
  commonest label, a tie to the stronger (`topicCount`). Columns are the
  topics any member has standing in, in topic order with Other files last, each
  with its size, the most questions any member can answer in it. A member's
  labels are exactly their own Summary's (`topicStandings` read as them), so a
  graded quiz's own quiz counts only what was answered; the list reads them for the
  whole class in one pass (`membersStandings`: the quizzes, their sizes, then
  the class's answers grouped by member, `review.TopicLabel` per member),
  which `TestMembersStandingsMatchSummary` keeps equal to `topicStandings`.
  The grid scrolls sideways only and the page scrolls down (Epo 2026-11-12,
  replacing Q723's pinned header: a box capped at the window's height scrolled
  inside a scrolling page).
- **Profile** (G2, `member=<id>`, keeping `show`): back to Members, name, "Joined
  2 Sep · active today" (their latest answer or submission), then Assignments (mark of total and Submitted, In progress, Missing,
  Done or the due date; a row opens their results, whose back link then names
  the member and returns to the profile (`member` beside `attempt` in the URL,
  Epo 2026-11-16), or the report's Members tab
  (a graded quiz's Responses) before a submission) with Overall score, and Topics as Summary shows them; both
  lists share one grid, an assignment's status and date over a topic's count
  and squares (Epo 2026-11-16). From
  lg that side takes what the right's 380px leaves, up to 1000px, and the gap
  between them grows to 96px from 2xl (Epo 2026-11-16). Assign quiz sits
  at the header's end for every member, needing practice or not (under the name
  on phones; the Needs practice card that held it was removed, Epo 2026-11-16).
  On the right: Frequently wrong (Still missing until
  Epo 2026-11-11)
  (up to five questions whose latest check was not right, most missed first,
  from the class's own quizzes Summary counts, the prompt from
  `questions.PromptText`; a member's own practice quiz is private and stays
  out, and an assignment's answers wait for released grades as labels do,
  `gradesHeldSQL`; Q723 findings 2 and 7); and
  Recent activity (the latest five: an attempt at a class practice quiz with its
  title and question count, a day's reviews in a topic, and submissions). A
  member's own practice quiz is private, so it shows as its topic, never its
  title. Assign quiz (Assign practice until Epo 2026-11-16) opens New graded
  quiz with the member as its only assignee, and its Generate starts on the
  weakest topic needing
  practice (lowest share right), if any (Q721,
  `presetAssignee`, `presetTopicId`). A `memberId` that isn't one (a removed
  member) shows Member not found with nothing to retry. Board G2's Draft a follow-up
  quiz (F3) was removed (Epo 2026-11-08): the labels already show which topics
  to make a quiz on; remaking a quiz from another one is queued instead. The ⋮
  menu is not built. An empty section keeps its heading with one muted line
  ("None given to … yet.", "No answers in any topic yet.", "Nothing answered
  wrong.", "No activity yet."); a member with no assignments, nothing wrong, no
  activity and no topic answered gets one line for the whole page instead,
  "… hasn't started here yet" (Epo 2026-11-12, mock B then A). The mocks'
  Dan Kim, Farah Ali, Gus Ito and Cara Moss show these cases.
- Phones and narrow panes (below the `@4xl` container, where the table no
  longer fits) get a plain list instead of either view (Epo 2026-11-08; its
  rows the Study pages' shared `ListRow`, 56px at least, its score
  `RowScore` "88% overall", Epo 2026-11-16): the
  name, "3 of 4 done · 2 missing" under it and the
  overall on the right, with Sort but no Show. Practice and topic labels are
  left to the profile.

MSW (`src/mocks/members.ts`) serves Biology 101's viewers with the boards' own
numbers, Farah's storage full.

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
Practice marked Only you, and lists in their own Files. Its quiz read says
`onlyYou` (the Quiz API, from `practice_workspace_id`), and its attempt page
shows an Only you chip after the title (Epo 2026-11-20, board D of the hidden
quiz callout mock: Practice's lock and words, icon alone on phones; no button,
as nobody can share it: the Hidden switch needs a workspace item,
`SetItemHidden`). The first one opened on a browser points at it in the same
accent callout as the Hidden chip's: "Only you can see this quiz", "Your own
quiz cannot be shared to other members." and Got it
(`capy.tips.ownPractice`; `OnlyYouChip` in `HiddenChip.tsx`). Its sources are what they
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
replaces the earlier one. A question counts fully under each of its own
topics (Epo 2026-11-15, todo-question-topics.md, as Canvas counts a question
toward every aligned outcome; `itemTopics` in `server/internal/store/study.go`):
those of its `topicIds` ([question-bank.md](question-bank.md)) that are the
quiz's workspace's topics, else its quiz's (all deleted, or a quiz moved to
another workspace, falls back). Topic labels and sizes (Summary, Members, a
member's profile, Learning), Frequently wrong's topic (its first topic's id,
every topic's name joined with ", "), suggested reviews and their topic groups,
topic sessions (Practise a topic draws the questions carrying that topic, from
any quiz in the workspace), Make my own practice's Mix in (a question on any
picked topic) and the question counts all read them from the quiz's current
content, so changing a question's topics, or moving its quiz to another topic,
moves its past answers with them. A trashed quiz's answers keep counting (Epo 2026-11-15, "count while
trashed"), toward its questions' topics, in topic labels and standings
(Summary, Members, a profile, Learning) and Frequently wrong, so trashing and
deleting a quiz count alike; its questions leave the topic's size, as a
deleted quiz's do. Reviews, sessions, Practice, the pools and the question
counts still serve and count only untrashed quizzes, since a trashed one cannot
be opened. A deleted quiz's answers count toward `answer_events.topic_ids`
([Answer events](#answer-events)). A day's reviews in a member's Recent activity
group by each question's topics too, a check under every one (Epo 2026-11-15,
`memberReviewDays`, over the member's latest days with reviews). Flashcards stay out (2026-11-03).

Questions' topics come from the parsed documents the reads already load
(`cachedItems` over `parsedItems`), never a query per question: Members still
reads a class in a fixed number of queries; Summary and a profile read the
workspace's topics once more (`topicsOf`, shared by the profile's standings,
Frequently wrong and Recent activity); Learning reads every workspace's topics
in one query (`topicsIn`) for its labels and pools; the other review pools read
them only when a question names a topic of its own (`topicsNamed`), and Practice
only when a quiz's question does.

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
serves the topic's questions only (each question under its own topics, `itemTopics`), missed and fading ones ranked as a manual
review ranks them plus questions not seen yet (`withNew`), at most 10, or the
session size once the learner picked one (`topicSessionPrefs`); no AI-written
items. The URL holds the start (`group`,
`topicId`, `reviewMode` for a suggestion); the batch fetched then is the
session.

- **Start (F1, Epo 2026-11-04):** the shared dialog (`SimpleDialog`, Cancel
  and Start in its footer as every dialog's) over Practice with the session's name
  ("Topic practice" alone while the topic's name loads or once it is gone)
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
- **Session done (F4):** `study/practice?review=<id>` reads
  `GET /api/review/sessions/{id}/result`: the title with Done, "n of m right"
  (full marks among the answered questions), QUESTIONS with each number, a
  result square and word (Right, Partly, Wrong; the square alone on phones),
  the first line and its reason chip; then ← Practice and Practise again (a
  new session on the same topic). The topic label change on the board (Needs
  practice → Familiar) waits for mastery.
- The session is kept in Practice as the learner's own review ("Only you").

Workspace settings has no Study tab since Hide study progress went (Q727 A):
owner and editor members open it on General, a viewer member on Others when
they may clone, else Danger (Leave), and a share-role visitor on Others when
they may clone; a visitor who may not has no Workspace settings entry
(`hasWorkspaceSettings`). The rail avatar's menu carries Workspace settings.

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
stays an attempt. An embedded set (a note's, a canvas card's, a shared note's) has
no title: an outline Reset at the far left of its Previous and Next row starts the
run over once it has a rating or has moved past the first card (`StepNav`'s
`start`, Epo 2026-11-13). A result shows Study again instead. When the
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
Easiest. Study again sits where a quiz result's does. A recorded
attempt's page, `/flashcards/attempts/$attemptId`, is `AttemptResult` with
the same body and the same Study again. Quiz results show
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
answers to `POST /api/review/check`, which grades (open parts with the grading model), rates,
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
Overview (default) and History; `src/routes/Learning.tsx`.
The sidebar and the page title read Study (`nav_study`, Epo 2026-11-13); the
route stays `/learning`.
The page calls a review a revision and a quiz or set attempt a practice (Epo
2026-11-13): Overview's workspace row "Biology 101 revision", History's
"Revision" rows, and a revision's result Revise again, Revision order and
"This revision is unavailable."; the code and this doc keep review. The
session and result pages stay under
`/learning/review/$workspaceId` and `/learning/reviews/$sessionId`.

### Overview

`src/features/study/LearningOverview.tsx` over `GET /api/learning/overview`
(`server/internal/store/learning_overview.go`). Scope (`learningScope`): the
workspaces the user owns, has joined, or practised in while they can still read
them, minus a class they own or edit (Practice's own test).
A row is the link: it hovers whole and square and has no action at its end.

**Continue** (Epo 2026-11-13, canvas Artifact VbcRu6HCgwGiz15UHZ7bPN board B),
first and only when it holds something: `ContinueCards.tsx` over
`GET /api/learning/continue` (`store.ContinueRows`; `continueQuery`, stored
with the Overview's and prefetched beside it by the `/learning` and workspace
routes; the Overview tab draws once both are in, so Continue never shifts the
page). History's In progress rows
(an unfinished revision; the newest try of a quiz or set the user can still open,
answered partway), left within the week (`continueWindow`, 7 days) and not
removed, outside classes the user owns or edits: the newest 3, one card each, in
a grid (one column on phones, two from `sm`, three from `lg`). The server sends
up to 6, so a removed card's place fills at once from the spares instead of
after the refetch (Epo 2026-11-13). See all (top right, an underline link without an arrow) opens History filtered
to In progress: the account's (`?tab=history&status=open`) from Learning, the
workspace Study's History tab (`study/history?status=open`) from a Dashboard, Continue's removed and older rows included. A card shows the
kind's icon and name ("Limits revision", a quiz or set's title), its workspace,
a progress bar in the theme's accent (`ProgressBar` tone `accent`) with "3 of 9 checked" (quiz), "4 of 10 cards" (set) or "5 of 12
answered" (revision) and when it was left. The whole card continues it as
History's row does (`ContinueLink`). Its ⋮ is the file and workspace cards'
(`CardActions` + `Menu`): **Remove from Continue** sets the row's
`continue_hidden_at` (`DELETE /api/learning/continue/{kind}/{id}`, migration
`0173`), dropping the card at once (`useHideContinue` edits every Continue cache
and restores them if the server refuses); History still lists it In progress and
continues it. **Start over** removes it the same way and begins again: a new
topic session for a revision (none when its topic is gone), a new quiz attempt
(the kept attempt id cleared), a new set run (the kept run cleared). A workspace's
Dashboard shows its own Continue above To do (`?workspaceId=`), without the
workspace name, for whoever practises there.

**What to do next**, at most 4 rows, led by what each is (the quiz or set's file
icon, the workspace icon for a suggestion). Assignments stay off it, and what was
left partway is Continue's.

1. New, at most 3: each workspace's first quiz or set in reading order with no
   `study_progress` row, where the user is the owner or a member and opened or
   practised it in the last 30 days, the latest first.
2. Suggestions fill what is left: the engine above over questions only, at most 2
   per workspace, past a topic Continue holds a revision of. A row opens the topic
   session's start dialog over that workspace's Practice, as the Dashboard's do, so
   closing it stays there. Sets are not suggested anywhere for now (Epo 2026-11-04).

**Workspaces**, newest practice first, each workspace holding a quiz or set: counts
per topic label, weakest first, "38 of 120 items tried" (rated items with current
content, of all items) and the last practice. A row opens the workspace's Dashboard.

**Your classes** (Epo 2026-11-13) lists a class's owner or editor's classes with their member count; a
row opens the class's Members.

With nothing in any section the page shows the ink book, "No quizzes or flashcards
yet" and an outline Go to Workspaces. An empty section is not shown.

### History

One tab for revisions and practices (Epo 2026-11-13; it replaced Past reviews
and All results, which split the same work by an internal difference):
`src/features/study/StudyHistory.tsx` over
`GET /api/learning/history?sort=&dir=&kind=&status=&workspaceId=&offset=&limit=`
(`StudyHistory`, `server/internal/store/study_history.go`), one `UNION ALL`
over the user's review sessions and quiz and flashcard attempts (never
assignment attempts, which live in To do), sorted, filtered and paged in SQL,
thirty a page loaded on scroll. A status filter cannot run in SQL (an
attempt's status needs its quiz or set's current size), so with one the store
reads a hundred rows at a time in the page's order and pages what matches.
Laid out as Files' list: the list toolbar's
filters (`ListToolbar`: Kind (Revision, Quiz, Flashcards), Status (In progress,
Partly answered, Done) and Workspace, the
user's workspaces as Files lists them) right under the tabs, then Billing's
plain table (`BillingTable`, 44 px rows, scrolls sideways on phones): Date
(the day only), Workspace (`WorkspaceCell`), Name, Topic, Score, Status. The
headers sort (`SortHeader`: date, workspace, name, topic, score; text A to Z
first, the rest newest or largest first); Status does not sort. Sort and
filters live in the URL (`parseHistorySearch`) and the last sort pick is
remembered (`sortSearch`, `src/lib/localPrefs.ts`).

- **Name** leads with what the row is: the retry arrow and "Revision" for a
  revision, the quiz or set's file icon and name for an attempt.
- **Topic**: a revision's topic, Other files, or All topics for a whole
  workspace; an attempt's topics joined with commas.
- **Score** "x / y": a quiz's marks (an unchecked question scores 0), a set's
  cards first rated Good or Easy of cards rated, a revision's question marks
  plus its Good or Easy cards over its marks plus cards answered.
- **Status**: Done when everything was answered; "6 of 15 answered" (amber)
  when it ended with some left, skipped or ended with Done, which the data
  cannot tell apart (a revision finished with fewer answers than served, or a
  quiz or set try a newer one followed); "In progress · 4 of 10" (blue) when it
  can go on: a revision not finished, or the newest try of a quiz or set the
  user may still open with fewer checked or rated than it holds now (counts
  from the parsed-items cache). A whole row is its link: an In progress
  revision continues (`/learning/review/$workspaceId?session=`), an In
  progress quiz or set first keeps the attempt as this browser's run (the
  quiz's attempt id, or the set's ratings read from `GET /api/attempts/{id}`)
  so it goes on there whichever device began it, and the rest open their
  result (`/learning/reviews/$id`, or `resultLink`).

Names the user can no longer reach are blank on revisions, as on the Files
page; attempts keep their stored names. With nothing yet the tab says "No
revisions or practices yet"; a filter that hides every row, "No matches".

### Review result

`/learning/reviews/$sessionId` (`src/routes/ReviewResult.tsx`, breadcrumb
Learning / History), and the end of a session, draw `ReviewResultBody`
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

### Attempt results

A quiz or flashcard attempt's result (`resultLink` in
`src/features/study/attempts.ts`: `/quizzes/attempts/$id` or
`/flashcards/attempts/$id`, one `AttemptResult` route for both, breadcrumb
Learning / History) has its own Study again. Attempts carry the workspace's
`iconId` (left out once the item is deleted).

## Lifecycle

| Event | Effect |
| --- | --- |
| Review session opened and left unanswered | Nothing is written. |
| Topic deleted | Its sessions keep their answers with no topic. |
| File or material trashed | Rows stay; every read skips trashed items but a trashed quiz's answers, which keep counting in topic labels, standings and Frequently wrong (Epo 2026-11-15); restore brings them back. |
| Material purged | `study_progress`, `review_states` and `review_log` cascade; `answer_events` stay with no material. |
| Item removed from a document | Its `review_states` row is ignored until the item returns. |
| Question prompt or card face edited | That item's state resets on its next rating; until then it is out of the practised pool and comes back in a manual review as a new item. |
| Workspace deleted | All three workspace-scoped tables and `answer_events` go by cascade; attempts stay with no workspace. |
| Member or link access lost | Rows stay, unreadable without access; Learning skips the workspace. |
| Workspace or material clone | Nothing is copied; cloned cards get new ids. |
| Workspace transfer | Rows stay with each user. |
| Account purge | `PurgeUser` deletes the user's rows in all three tables and `answer_events`, their review sessions. |
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
at `/workspaces/<id>/assignments` (`parseAssignmentsSearch` in `studyRoutes.ts`), and
every workspace has it (Epo 2026-11-11): the rail calls it Assignments for a
class's owner and editors and To do for everyone else, whose page is headed To
do and says "Nothing to do" when empty, as the To do page does. The rail's
count is what is left to do for a member and the assignments with answers
waiting for staff (`useAssignmentCount`, Claude's reading: the boards' counts
don't follow their rows), read from To do's own list (`GET /api/todo`), as is
the Dashboard's To do section.

**Pages** (Epo 2026-11-13). `GET /api/workspaces/{id}/assignments` is filtered,
ordered and paged in SQL, 50 a page with an offset `cursor`, as the To do page's
Done tab is (`ListAssignments`): `closed` keeps the closed ones (staff's Show
closed; a member's page always asks for them), `done` keeps the caller's done
ones (a member's Show done; staff always ask), and `topic` (comma-separated)
keeps those covering one of the topics, its quiz's or one its questions name as
their own, as Practice's filter does (staff's Filter, the list pages'
`FilterPopover`, offering every topic of the workspace, no Other files), and
`kind` (`marked` or `unmarked`) keeps only graded quizzes or only assignments
(staff's Filter's Kind, Epo 2026-11-19; both picked sends none, keeping both). Each
row's question topic ids are read from its JSON once (`questionTopicIDsSQL`:
the posted questions, a draft's quiz content), for the filter, the sort and
`topicIds` alike.
With no `sort` the server puts open ones first by due date, then the closed
ones latest due first; no due date goes last, newest posted first. The page
always sends one: Posted, newest first, until a column header is picked (Epo
2026-11-20, `useAssignmentSort`). `sort` (title, kind, topic, posted, due) and
`dir` order by that column, open ones still first, a row without the value last; topic sorts by the first topic the row shows (its
quiz's, else its questions' first in topic order). `useAssignments` is an infinite query; the
page's `ListEnd`, on the page's own scroller, reads the next page as it nears
the end. Closed rows are muted (opacity 55%), as To do's done rows are.
Below the `@4xl` container the staff's table becomes one row per assignment:
its title, its progress bar, and "Due Sat 14 Nov" at the row's end (Epo
2026-11-16, in place of the average, which the wide table's Average column
keeps); no kind line, so it takes two lines (Epo 2026-11-20, the wide table's
Kind column keeps it). The wide table keeps Posted's label whole (`Th`'s
`fit`), as it starts sorted and its dates alone are narrower. Anyone else's
page there, a class member's or a personal workspace's To do, is To do's table
for that workspace (Epo 2026-11-20, "the two todo should align"):
`TodoSection` with `page`, the Dashboard's To do with a page title, New (New
task for a class member), Show done and the To do page's selection bar
(Mark as done, Mark as not done), newest posted first; a row opens To do's
details dialog. It reads To do's list (`GET /api/todo`), not the paged
assignments list, which only staff's table reads now.

**Words** (Epo 2026-11-14). A class's marked assignment is a *Graded quiz*: it
owns a quiz of its own (`materials.assignment_id`, migration
`0174_graded_quiz_owner.sql`), freezes it, members submit it, it is marked and it
counts. A class's unmarked one is an *Assignment*: a title and optional files
(picked from the workspace's) that members tick, graded on points when it has
them (below). One set for oneself (`own`) is a *Task*, marked or not, never
graded on points (`kindLabel` in `assignmentText.ts`). None is a file. There
is no other state than draft or published: a draft is invisible to members, and
publishing posts it.

**The owned quiz.** A graded quiz and its quiz are made together (Epo
2026-11-16; until then the quiz was made first and waited, `graded_pending`,
for a second request to take it). Each way of getting questions carries the
graded quiz's settings as `gradedQuiz` (an `AssignmentFormReq`, kind marked,
no `quizId`): Create blank (`CreateMaterialReq`), From question bank (`BankQuizReq`)
and Existing quiz (`POST /api/quizzes/{id}/graded-copy`, a copy of one of the
workspace's practice quizzes, never another graded quiz's own, which is an
assignment already, nor one made only for oneself; its questions given fresh
ids and its images
new `editor_assets` rows as From the bank's copies are) make the quiz and the
assignment in one transaction. Generate and Convert's run check the form when
they start and keep it with the run; the assignment is made in the transaction
that makes the run's quiz (a form that no longer fits then fails the run), and
the run's `assignmentId` (and the quiz's) tells the dialog; a run refused then
says why (`graded_quiz_invalid`, or one of the assignment limits). The dialog
sends Generate's, Convert's and Create blank's as drafts, so AI-made or empty
questions are read before anything goes out, except a task for oneself, which
has no draft (`checkOwnTask`). Settings may leave the title empty: each way then
sends its quiz's name (the picked quiz's, "{workspace} quiz {n}", the
generated or converted quiz's title). Once made, the dialog closes on the page
behind it with a Graded quiz created toast (Epo 2026-11-20, in place of
opening it, Epo 2026-11-16): Open goes to its report's Questions tab (a task
for oneself to its page) and Undo deletes it, wherever it was made (the
Assignments page, To do, a member profile). The Assignments page's own toast
is left to Assignment. `POST
/api/workspaces/{id}/assignments` no longer makes a graded quiz from a quiz id.
An owned quiz never lists (Files, the file tree, Recent, search, Practice, Study,
reviews and new items, pickers, Explore, a workspace clone with its images, the
agent's outline and summary search; each list's SQL has `m.assignment_id IS
NULL`), is held from every viewer for good (`materialHiddenSQL` reads
`m.assignment_id IS NOT NULL`, as `live_access` does), so only the class's staff
(and a Task's maker) open it, and it cannot be trashed, cloned or hidden by hand
(`ErrNotFound`; its header has no Hide or ⋮). Members' answers on it still count
in their topic standings and Still missing once released, as answered only
(`standingQuizSQL`). Deleting the assignment deletes the quiz (`ON DELETE
CASCADE`, the quiz owners' storage rows locked first). It stays charged to
whoever made it, so their account purge deletes it and the assignment keeps
only its frozen copy (Epo 2026-11-14). Publish and Republish freeze it as
before. Migration 0174 gave each existing marked assignment's untrashed quiz to
the earliest marked assignment of its maker in the same workspace (set
`hidden`), unlinked the others' `source_quiz_id`, deleted drafts left with
neither a quiz nor questions, dropped `practice_at`, and made `source_quiz_id`
unique.

**Data** (migration `0147_assignments.sql`):

| Table or column | Holds |
| --- | --- |
| `assignments` | `own` (migration 0168: a task a member set themself, its maker's alone, whose `workspace_id` may be null; it takes the rest of this row as a class's assignment does, but for `assign_all` and `draft`). Kind, title, `source_quiz_id`, the frozen `questions` with their keys, `question_count`, `total_marks`, `due_at`, `time_limit_min`, `attempts_allowed`, `no_late`, `late_penalty_pct`, `assign_all`, `draft`, `marking` (`ai_approve`, `ai` or `manual`, migration 0157), `answers_shown` (`closed`, `submitted` or `never`, migration 0159), `shuffle`, `posted_at`, `closed_at` (closed by hand; a No late submissions one closes from its due date without it), `released_at` (its answers joined reviews, once) |
| `materials.assignment_id` | The marked assignment that owns this quiz (migration 0174, unique, cascades on delete) |
| `question_extractions.graded_quiz` | A Convert run started there, whose quiz is saved waiting |
| `assignment_assignees` | Picked names and a staff member's own "You" |
| `assignment_files` | An unmarked assignment's files and materials, in order; a file moved to another workspace leaves (`moveFileTx`) |
| `assignment_done` | A member's tick |
| `assignments.points` | A graded Assignment's points, 1 to `fieldlimits.AssignmentPoints` (1000); null is not graded; only on a class's unmarked one (migration 0176) |
| `assignment_grades` | A member's grade on a graded Assignment: `points` (one decimal place at most), `graded_by`, `graded_at`; apart from the tick, so Undo hand in keeps it (migration 0176) |
| `editor_assets.assignment_id` | A frozen copy's image rows (an own task's have no `workspace_id` either: migration 0168 lets the assignment alone own a row) |
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
[backend-storage-quota.md](backend-storage-quota.md#what-counts)), and the Files
page's embeds don't list them. A publisher whose account is suspended or leaving stops nobody:
staff still delete, which ends the charge, and republish, which moves the questions
JSON's charge to whoever republished; an image the assignment already holds keeps its
payer (Epo 2026-11-05), so that payer's purge takes it out of the paper. Frozen staff
still delete an assignment, and Republish, which writes, is refused for them. They resolve for staff, whoever it went to and whoever holds an
attempt at it (`frozenAssetReadable`), never another member, and they paste for
nobody (`AdoptEditorAssets`). An own task's quiz may sit in another workspace or
none (below), so its image copies name the task alone, with no workspace, and are
copied from the task's source quiz (`copyFrozenAssetsTx`); only its maker reads them.
Members are only ever served this copy:
answer-free while running (`questions.LearnerViews`), with keys after
submitting only as Show answers allows (below).

**One row** (Epo 2026-11-04, 2026-11-14). Since a graded quiz owns its quiz
(above), an assignment never holds a quiz that lists: there is no assignment
icon on a quiz row, no row that opens an assignment, and nothing about a quiz
changes when an assignment opens, closes or is deleted. An unmarked
assignment's attached files and quizzes keep their own visibility. Clones: see
[authorization](authorization-permissions-lifecycles.md#class-clones).

No reader is ever left connected to a quiz that turns hidden: a graded quiz's quiz
is made with it and hidden from the start (Epo 2026-11-14 and 2026-11-16, migrations
0174 and 0180; "Existing quiz" makes a copy), and hiding any other item drains its
room (`SetItemHidden`), so the room checks hidden at join only
(`collaboration-rs/crates/server/src/pubsub.rs` `keeps_access`). Past the close a member it did not go
to has the quiz back at once while grades wait under Show grades Manual, when
those it went to are still refused (Epo answered for Do not show only). A signed-out browser on a public or link workspace's share page is
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
press. A No late due date ends it as its time running out does: the attempt's
`closesAt` carries it, the page counts to the earlier of that and `deadlineAt`, and
shows the clock always when timed but only in the last hour when only the due date
ends it, ticking only then (Epo 2026-11-08). Editing the assignment sends
`assignment_updated` to whoever is taking it, whose page rereads the attempt, so a
moved or lifted due date moves the clock. A shuffled paper's order comes from a seed of the
attempt's id, so a reload keeps it. Bookmarks stay in this browser. Taking it never joins a room, since it
serves the frozen copy.

**Settings** (Epo 2026-11-05, redone 2026-11-13, `AssignmentSettingsTab`). The report
has no ⋮; its `tab=settings` is as wide as account Settings' forms (`max-w-5xl`).
On top, one row of actions: Publish (an unmarked draft's, the dark button; a
graded quiz's sits in the report header, Epo 2026-11-15), Republish, then Close
or Reopen. A graded quiz's quiz is edited on its Questions tab, so Settings has
no Edit assignment. Under it, on its own line, "Last published {date}" (never the
quiz file's name, which members do not know), led by "Unpublished changes" in the
warning colour while the quiz was saved after the last publish
(`manage.quizChanged`: the quiz's `updated_at`, which only a changed projection
moves, past `posted_at`; Epo 2026-11-14), then "· Last edited {date}", that
same `updated_at` read with the assignment (`manage.quizUpdatedAt`, Epo
2026-11-16; a draft's note carries it too). The assignment's own settings keep
no edit time, and nothing records who edited. A quiz in the trash has no Republish
(`manage.quizTrashed`). Below sit every field of the details dialog, in Details,
Marking and results (marked only), and Submissions, kept until Save, with Discard
putting back what is saved; an untouched form follows saves made elsewhere. The
fields, their defaults, checks and request body are shared with the dialog
(`assignmentFields.tsx`), and kind and quiz stay as made. Delete sits in the danger
zone. Republish, Close (a marked one's) and Delete confirm first; Delete's confirm says
members' attempts and marks (hand-ins for an unmarked one) go with it
and it can't be undone.

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
credits of the member attempting (`markAnswersSoon`, Epo 2026-11-08; one lock per
member); a blank one earns 0. A part it could not mark keeps why, `aiError`
`credits` (that member has none left), `error` (the grade failed) or `file` (a
file of its paper can't be read, Q730), which only staff read: Approve AI marks
shows it on the row as No credits, Grade Error or Can't read file and in the
answer pane as one line, with no banner and no names (mock T3). Waiting
answers count as `toApprove`, and `notGraded` how many of them have no AI mark,
which the Assignments row, the report header and Approve AI marks show apart from
those to approve. Mark with AI runs each attempt on its member's credits and is
refused only when grading isn't set up. While a run holds answers they read
Marking… with a spinner (Q729): the gateway notes, in memory beside the run's
progress (one gateway process; a restart forgets it), each attempt it holds
from queued until its call returns or fails, its parts by id, or every part
while its paper is read; a re-grade of a paper holds exactly the parts it
sends (four to a call in the pipeline, all of them at once). Submit and the
sweep hold the attempt before the reply, and Mark with AI what it lists, so
the next read already says so. The report's answer rows and members and the
attempt (with `marking` on each part held) carry `marking`, which Approve
shows in place of a row's badge or waiting text, Responses By member in place of
"to approve", and the member's submitted page and results as Marking… (each
waiting part too); the report and the attempt are read again every 3 s while
anything says it, and each report read invalidates the attempts whose answer
rows moved (`changedAttempts`, Epo 2026-11-19), so Grading's open answer takes
the AI's marks as they land rather than after its 5-minute stale time, and under Show grades Manual the flag still shows, telling
nothing of the marks. With Approve
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
date only, and the penalty on marks or a grade only (the store refuses anything
else, `checkLatePolicy`), so with no due date Advanced holds Draft only.

Advanced (Epo 2026-11-04, `Accordion` in `src/components/ui/Accordion.tsx`) is an accordion holding the policy
and Draft only (and a graded Assignment's Show grades), with the app's `motion-accordion` recipe; a graded quiz's Show
grades and Show answers sit at its top (Epo 2026-11-12, back in it 2026-11-20 after
two days on the form). It starts closed unless a
saved assignment holds something other than the defaults there, a draft, No late
submissions or a penalty (`advancedStartsOpen`, Claude's pick), Shuffle, or grades or
answers other than Automatic and After assignment close. Opening it never
scrolls the dialog (Epo 2026-11-20); rows it opens below the fold are scrolled to
by hand. Editing a published assignment has no Draft only, and one with no due date
has no Advanced at all.

Both kinds follow the same rules (Epo 2026-11-09, "same rules", migration 0162
`assignments_late_policy`): an Unmarked one with a due date has No late
submissions too and closes only by hand or under it, its ticks and hand-ins
read Late past the due date, and a closed one takes no tick, Hand in or Undo.
The penalty needs something graded: a graded quiz, or an Assignment with points,
whose grade loses it when the tick or hand-in was late (migration 0176 widened
`assignments_late_policy` from `kind = 'marked'`).

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
opens to its answer, marking points and worked solution. Show answers (C3, Epo
2026-11-08) picks when a member reads those: After assignment close (the
default: closed by hand, or at the due date under No late submissions), After
submission, or Do not show. Until then the server leaves marks and comments and removes keys, marking
points and solutions (`gradedWithoutKeys`), so an early submitter has no answers to
pass on while classmates still answer; per-part marks still show on submit.
Reopening hides the keys again.

**A graded quiz from a file** (Epo 2026-11-20, migration 0186, mock "Graded
quiz from a file"): Settings asks a file for its "Points" (whole, 1 to 1000,
the form's `totalMarks`, which only this graded quiz has; "Total marks" until
Epo 2026-11-20 named it as Assignments' Points) and makes
it with `POST /api/files/{id}/graded-quiz` (`MakeFileGradedQuiz`, the caller an
editor of the file's workspace), its untitled name the file's without the
extension.
- `paper_file` marks it; its one `assignment_files` row is the question paper,
  read live, not copied (Epo: a copy would mean publishing every edit). It is
  Upload only and Manual grading only, which Settings shows locked and the
  server keeps on every save, with its file.
- Its frozen copy is one question with no words and one open part worth N
  (`paperQuestion`), whose one marking point is the file's name, so attempts,
  the clock, Grading's typed mark, late penalties and released grades work as
  any graded quiz's. A draft holds the copy from the start; Publish gives it
  out as it is.
- Handing in skips the read (`paper` goes straight to `read`): no AI maps pages
  or marks anything, and Grading shows every page of the hand-in with one mark
  out of N and no AI line.
- The member's attempt shows the Question paper card (name, Download of the
  latest saved state) above Your answers, and the file in the workspace's own
  viewer beside them (on a phone the file first, its name and Download over it,
  Your answers under it). A member reads it in View: an Office, text or CSV file
  is one `GET /api/files/{id}/source-session?view=true` (its saved edits read
  once), a PDF, image or audio its signed link; no room joins, so they see what
  was last saved, not live typing. The report's Questions tab is Question paper,
  the same viewer, where staff who may edit the file can; Preview shows it too.
- Who reads it (Epo 2026-11-20, "just like quiz"): those it is given to see its
  name; once they start they read the file through the quiz, even when it is
  hidden from members in Files (`FileReadRole`,
  authorization-permissions-lifecycles.md › Hidden from members). A visible
  file stays readable in Files to every member, so staff hide a paper they want
  unread before the quiz (its picker row says "Hidden from members"). One moved,
  trashed or deleted reads "The question paper can't be opened".
- Points, the total (Epo 2026-11-20, mock "File quiz follow-ups" A; named
  Points later that day): the Settings tab shows it beside Marking and saves it with the rest (`setPaperMarksTx`). Marks
  already given stay as they are, out of the new total, as Canvas and Google
  Classroom keep them; Save asks first while any submission is graded (the
  staff summary's `graded`, past members' included), saying theirs change only
  by hand. A total below a mark
  given is refused (409 `total_below_mark`, shown under the field). The stored
  copy, every submission's graded copy and totals, and running attempts'
  totals follow (`rewritePaperTx`).
- Change file (Epo 2026-11-20, as Gradescope's Replace template PDF): staff's
  button on the Question paper tab, also when the file is gone, opens the
  workspace's files in Existing file's rows; `PUT
  /api/assignments/{id}/paper-file` (`ChangePaperFile`) moves the one
  `assignment_files` row and renames the marking point. Answers and marks stay,
  and those who started read the new file from their next open (the read rule
  follows the row); open pages reread (`assignment_updated`).
- Results (Epo 2026-11-20, mock "File quiz follow-ups" boards 6 and 7, as Canvas
  and Classroom show a hand-in's grade): the member's page has the total and
  percent, then Feedback, the comment staff wrote on its one question in
  Grading (there is no separate feedback field), then Your answers with Open
  on each file (its signed link; "No files handed in." when there are none)
  and the Question paper with Open (the viewer
  in Preview's dialog) and Download; no question row and no outcome chips.
  While grades are held back it shows the two file sections alone. Staff
  opening a member's attempt (Epo 2026-11-20, "a file is not a quiz
  question") get the same page with Grade (one mark out of the total) and
  Feedback (the comment box) in Feedback's place, saved as Grading saves
  them, Save waiting for a change; then Answers and the Question paper. Until
  it is marked the score reads "– / 40", not "0 / 0". Neither page has
  dividers (Epo 2026-11-20, "remove all dividers"). Grading is the same
  (Epo 2026-11-20): the members, then that pane for the one picked, Save
  moving on to the next waiting; no questions column, chips or Overview, and
  a phone opens on the members.

**Answering by upload** (Epo 2026-11-08, todo-file-submissions.md 5a, migrations
0161 and 0185, mocks C1, S2, S5, T1, F1, F2):
- A marked assignment's Submission (Epo 2026-11-19) is Online assessment only,
  Upload only (`upload_only`, which needs `allow_uploads`), or Online assessment
  or upload (`allow_uploads` alone). For the last, Before you start asks "How
  will you answer?" with two cards, Online assessment and Upload, and says the
  choice can't be switched once started (S2); upload-only starts as an upload
  and the server refuses it online. Before you start lists the questions, marks,
  time limit, attempts and (with one mode) the submission as an item's
  properties do (`PropertyList`), and opens for any timed assignment or one that
  takes uploads. Upload needs storage not full (S6); the attempt runs with
  `attempts.paper = 'upload'`, the clock covering the upload. Typed and uploaded
  answers never mix in one attempt.
- An online assessment lists its questions as numbers only (`QuestionNumbers`,
  the same grid in staff's Preview): a six-column grid in the list's place, each
  square filled when answered, dashed when partly, ringed when open, a bookmark
  in its corner, with what each look means under it; phones keep the number
  strip above the question (`NumberStrip`).
- An upload attempt shows Your answers at the left (above the questions on
  phones) and every question in one scroll, read only: choices, matching and
  ordering show their options, written answer fields don't. Your answers lists
  each file with its size (a PDF's pages too), a ⋮ to open or remove it, and the
  files, size and pages used. Its files are the member's own standalone uploads through the normal
  source upload with `attemptId` (`files.attempt_id`, in `attempt_position`
  order): ingest runs and charges them as any upload, but credits never refuse
  one and its bytes save past the storage limit. A photo or an Office file's
  pictures are compressed in the browser first, as any upload's are
  (`compressSource`). At most 15 files within the member's source file cap
  across them (O1), and at most 15 pages, which the browser counts as files
  are picked (a PDF's pages, anything else one) and refuses with "A paper holds
  at most 15 pages…" (finding 7). A password-protected or damaged PDF or Office
  file is refused as it is picked, by the normal upload's browser analysis
  (`localSourceAnalysisInput`, codes `password_protected` and `unreadable`, in
  `useAddSubmissionFiles`, so hand-ins too), with its own message, while the
  other picked files upload (Q726 A); such a PDF counts no pages. They keep
  the order they were added in and can be removed until Submit, which waits while a file uploads (the clock's own submit does
  not, finding 6), and never list in Files, search, Recent or account chat;
  their member opens them read only (no editing session, finding 4).
- An upload attempt's matching options and ordering items are shuffled with the
  attempt as the seed (`questions.LearnerViewsSeeded`), so the letters on paper
  match what the read call is given.
- Submitting leaves every part waiting with nothing logged (`paper = 'reading'`).
  The read starts at the member's submit, decided from the attempt as stored
  (`NeedsMarking`), whatever Show grades hides from them (finding 1), and when
  the server submits the paper for them: the sweep, or an attempt found past its
  time when read or restarted (`store.OnPaperHandedIn`). Marking waits for the
  files' ingest, then the pipeline's `/paper` reads every page of the paper as
  the attempt holds it (`t.questions`, not a later republish, finding 10) and
  grades the open and drawn parts on their pages, one call
  (`observability-metering.md`). Go maps each closed answer from the member's
  letters to the stored answer and marks it against the key, drops an answer
  read with no pages, stores each part's `pages`, logs the answers
  (`paper = 'read'`), then saves the AI's marks and failures as for typed
  answers. A text or Office file with no text (its ingest failed, or was
  skipped for credits) is not read: every part waits with Can't read file or
  No credits (finding 8, Q730). A PDF the pipeline can't open (or that opens
  with no pages) or render answers `/paper` 400 `file_unreadable`, and its
  `file_unavailable`, `unsupported_format` and `unavailable_target` refusals
  read the same: every part waits with Can't read file, which Mark with AI
  still retries (Q730). Processing is never part of submitting: an uploaded
  file counts as handed in, and nothing about its processing shows to the
  member or holds Submit (Q730). A failed read, or one that waited out the ingest, leaves
  the paper `reading`, every question of it on Approve (closed ones too), and
  Mark with AI reads it again (`PapersToRead`); nothing retries by itself. Mark
  with AI later grades the waiting open parts again on their pages. Under
  manual marking the paper is still read, on the member's credits (Q716): the
  read maps each part to its pages and marks closed parts (`/paper` with
  `grade: false`), and open parts wait for staff. A read that fails there
  notes no reason: its parts wait for hand marking with no badge, as any
  Manual answer (Q730). There Read papers again sits
  where Mark with AI would, shown while the report's `papersToRead` (papers
  still `reading`: a read that failed, never ran, or runs now) is above zero;
  it is the same `mark-with-ai` call, reading without grading on each
  member's credits (Q725).
- Grading shows a part's pages of the paper (T1), or the whole paper where it
  was found on none, under the paper's files by name: each underlined
  (`SubmissionFileLink`, Epo 2026-11-19) and opening its signed link, a PDF or
  photo in the browser and anything else downloading; both read
  `GET /api/assignment-attempts/{id}/paper/{fileId}/links` (the member, or
  staff once submitted).
- The Files page lists a paper's files once every part is marked and the
  assignment has closed with its grades out, as Files › Canvas does for
  assignment drawings (Epo 2026-11-08; one list with the member's other files
  since 2026-11-09, `GET /api/items`); deleting keeps the
  marks, and Approve then says the member deleted it (F2). As a member leaves
  the class, their read papers with nothing waiting and their hand-ins go, as
  their marked drawings do (`dropLeaverSubmissionsTx`, finding 11).
- Releasing grades rings each member who handed in (`grades_released`, linking to `/workspaces/<id>/assignments?assignment=<id>`).

**Handing in files** (Epo 2026-11-08, migration 0162, mocks C2, S3, T2): the
same switch on an Unmarked assignment (C2: Files below Due and Assign to, then
the switch) turns Mark as done into Hand in, which the Assignments list and To do
then leave to the page (no quick tick). The member's page gets Your work,
with Add files while it is open; each file is their own standalone upload with
`handInId` (`files.hand_in_assignment_id`, in `submission_position` order),
stored with no parse and never read or marked. Hand in needs a file, waits
while one uploads (as Submit does), and ticks the assignment
(`assignment_done`), the meta line then saying Handed in on its date; Undo hand
in reopens it until the assignment closes. Once the member's storage is full
no file is added (`storageFullErr` at the ticket and the upload session, as a
Marked paper's start, Q728 A): the refusal toasts the storage-limit copy, a
file added while there was room still saves past the limit, and Hand in and
Undo still work. The report's chip reads
"N of M handed in", and its Members tab lists each member's date (Late past the
due date) and what they handed in, each file by name opening it in a new tab,
under no Member header (the section's title says it), grades read only; a row
opens the Grading tab at that member (Epo 2026-11-19, as a graded quiz's row
opens the attempt). **Grading** (`tab=grading`, `GradingTab.tsx`, mock A after
Google Classroom's grading tool; named Hand-ins when there are no points) is
the tab of an Assignment taking files or graded on points: the members on the
left in the app's `Accordion` (folds by hand), the open one (`member=<user
id>`, else the first who handed in) showing when they handed in, their files
with sizes (`work=<file id>` the one shown; not `file`, which the workspace
route owns) and the grade (`GradeField` on the graded quiz's `MarkField`, with
Save); the file on the right in the workspace's own viewers, `PdfView` with
its page count and zoom in the pane's header and `ImageViewer` with the
header's zoom, or FileViewer's `UnsupportedPreview` with the hand-in's
download (a .docx), and an open-in-new-tab icon, the three buttons one run with no gaps. From md up, Full screen (icon and label) at the right end of Grading's tabs row puts `fullscreen=true` in the URL (`useFullscreenSearch`, the workspace viewer's hook) and covers the sidebar, title and tabs, leaving the members and the file; switching members keeps it, and the file header's exit icon (the Count row's, with no files) or Escape leaves it. A graded quiz's Questions tab has the same Full screen while its quiz edits (Epo 2026-11-19): the editor (rail and cards) covers the page under a 48px bar holding its save status, Undo, Redo and the exit icon, which move there from the header; Escape leaves it except from inside a field (an input, a text or math editor: `useFullscreenSearch({ fieldsKeepEscape: true })`, the report's both tabs). A phone
drills down: the list, then the member's file with their details under it.
One without uploads has no file side. A file opens on its signed link itself,
with no app page between (Epo 2026-11-19): the link is signed to show a PDF or
photo inline and download anything else (`blob.ReadHeaders`). The file name
(`SubmissionFileLink`, in Members and under a paper answer in a graded quiz's
Grading) and Grading's open-in-new-tab icon and Download call
`useOpenSubmissionFile`: it fetches the link through `paperFileLinksQuery`,
whose cache stays fresh only until half a minute before the link's
`expiresAt` (read links are signed for `B2_LINK_TTL`, 5 minutes), with no
retry; a PDF or photo goes to a new tab opened on the click itself (a blocked
one says so, with no fallback onto the page), anything else downloads through
a hidden frame, so the page neither leaves nor raises Leave site. A mounted
viewer keeps the bytes it loaded. The mock signs for 5 minutes too and serves
its files as blob URLs, which a new tab opens as it would the real link (a
data: URL it refuses). The Files page lists a hand-in's files once the assignment
closes, by hand or at a No late due date.

**Show grades** (C4, S7, T5; Epo 2026-11-08, migration 0160 `grades_shown`,
`grades_released_at`). Automatic, the default, shows marks as they are decided.
Manual holds them until an owner or editor presses Release grades in the report
header (`POST /api/assignments/{id}/release-grades`), which confirms with how
many answers still wait for approval. Until then a member's `gradesHidden`
results carry their answers and the questions without marks, outcomes,
comments or keys (Answered or Blank per question), their row reads Submitted,
and the Submitted page says who releases it. Answers never show before grades.
The topic-label read leaves out events of an attempt on such an assignment, and
the sweep makes its quiz practice, rating what was submitted, only once it has
closed and its grades are released. After release, later marks show as they
land. There is no Practise again: the owned quiz stays held (Epo 2026-11-14). The top right
shows the mark after any late penalty, with the unpenalised mark under it.

**The report** (G3, G3m, A3; `GET /api/assignments/{id}/report`, owner and editor
members only). Chips (a green Open first while published and not closed (Epo
2026-11-16), the time limit with a clock, due, late rule, closed, grades; no
kind, submissions or average since Epo 2026-11-13), then its tabs,
each with its link (`reportView` in `assignmentPage.ts`). A graded quiz (Epo
2026-11-15, boards Main and Responses of todo-question-editor.md) has
Questions (`tab` absent), Responses (`tab=responses`) and Settings; a draft
Questions and Settings. Its header row ends in Preview (outline, the eye; only
the eye on phones) and, for a draft, Publish (dark), with Release grades when it
waits; while Questions shows, the quiz editor's save status and Undo and Redo sit
before them (`FileActionsTarget`). Questions edits the graded quiz's own quiz
(`manage.quizId`) in place with the quiz page's `QuizEditor`
(`GradedQuizQuestions`; read only to someone who can't edit it, and the frozen
questions to read when the quiz is gone); after publishing, edits reach members
only on Republish (Settings). Responses opens with a row: View, a select of By
member (default) or By question (`by=question`), "n of m handed in · average
x / y" (the mean of the marks and totals the members' rows show), the select
36px as Preview (Epo 2026-11-16). Marking is the Grading tab (`tab=grading`,
its own tab between Responses and Settings since Epo 2026-11-19), so the row
has no Approve AI grades button any more (Epo 2026-11-19). The report's head
reads as a member's attempt: the back link, then the title on one line (an
ellipsis, the full title on hover) with its chips under it 4px down, the
actions (save status, Preview, Publish, Release grades) at the right, top
aligned; below 20rem of room the actions wrap under. Older links still open: a graded quiz's `tab=members` is
Responses By member, and an unknown tab (the old `tab=preview`) its first tab. By question's folded rows
are one 36px line from md, as By member's table rows (Epo 2026-11-16). By
question shows a row of numbers first, Submitted
"n of m", Average, Average time (the mean of members' minutes), and Attempts
and Uploads when allowed; per question one wording, "Average 80%" (the
average share of its marks, partial marks counted) or for an open or drawing
part "Average 2.8 of 4", only "Average" muted, "–" until one is marked, led by an
"AI graded" badge on a question with open or drawing parts unless Marking is
Manual (Epo 2026-11-14); answer frequencies, common wrong
answers, how often each marking point was awarded; under them the part's answer
key where the bars do not mark it, an open part's sample answer or a drawing
part's drawn one, and the Solution. An open question folds on a click
anywhere on it but a control or a text selection. A question of several parts
lists each part on a row of its own (Epo 2026-11-14, board C), named with its
full label, "Q18 (a)(i)" or "Q19 (2)" (Epo 2026-11-19, not "Q19.2"), with its own type, marks and numbers (the
report's `parts[].percent` and `.average`, taken as the question's are); opened,
it shows "From Q18", the question's stem and its group's text and figures above
them; a one-part question's row shows its group's too. The first three rows start open,
and what is opened or folded by hand stays so across the report's tabs, held by
the report, Epo 2026-11-14). By member lists
submitted, Late with its penalty, Missing, minutes taken, mark, "n to approve"; a row opens that
member's Results (whose back link returns to Responses), where any mark and
comment can change. Grading takes `&question=` and `&member=` (A3 by
question, A3b by member). Percent,
average and the table's Average count from the first marked result: the
five-result minimum (§11.8) no longer applies to assignments (Epo 2026-11-13). An unmarked
assignment keeps Members, Settings and Preview (a draft Settings and Preview);
its Members tab opens with its Handed in or Done count. Preview shows what
members see (Epo 2026-11-13 A). A graded quiz's (`PreviewDialog`, a large
dialog, full screen on phones) shows the question list and one question at a
time (`AssignmentPreview`, `TakeQuestion` shared with `AssignmentTake`), with
Previous and Next but no clock, Bookmark, save state or Submit; answers stay in
the dialog and nothing is sent. A published one shows its frozen questions (the
report's); a draft its quiz file, read as the quiz page reads it (`useQuiz` then
`useLiveQuizQuestions`), keeping the questions with answers that Publish freezes
(`QuizFilePreview`). A practice quiz's header has the same Preview
(`QuizPreviewButton`, the dialog loaded as it opens; on phones an item in the
header's ⋮, Epo 2026-11-16), and no tabs. Its Practice ("Study" until Epo
2026-11-16) sits at the questions' top right beside the quiz's title, as a
set's does (`QuizPaneTitle`: the edit view's cards, the read view's open
question, and on phones above its question list): its Responses
waits for an endpoint listing members' practice attempts. An unmarked
assignment has Members and Settings tabs only, a draft Settings alone: its
Preview tab went (Epo 2026-11-19, "theres literally nothing to preview"). Its
Files, on the report and on the member's page alike (`AssignmentFiles`), are
rows that open each file or the Files page's cards (`ItemCard`, a file's
page-1 thumbnail signed by `GET /api/assignments/{id}` and a text file's or
material's preview), with the Files page's list and grid toggle. The links
`/workspaces/{id}/study/assignments/{id}` redirect to this URL.

**Marks.** `POST /api/assignment-attempts/{id}/marks` sets one question's marks,
from 0 up to each point's or closed part's marks with at most one decimal place
(Epo 2026-11-18; staff type them in `MarkField`, on the member's result and the
Approve tab, which refuses keys past one decimal place or above the marks,
with no message, as `GradeField` does for a grade), and its comment.
Totals move in the same transaction. A row the AI marked reads its mark in a
purple chip until approved, then plain (no "AI" before it: the question says AI
marked, Epo 2026-11-19), and its pane starts from it, so Approve saves what shows; changing a mark approves it too.
A rule the answer broke shows as a warning above its marking points (red for copying
and instructions to the marker, amber for any other), not on its row (Epo
2026-11-19: it is about the marks taken off, not the grading). Clear
warning takes it off at once (`clearWarning`), and Approve keeps it for the member
unless it was cleared. While the keys are hidden from them a member reads no warning until the
assignment closes, since it could quote the marking scheme while they can still
resubmit; reopening hides it again.
`POST /api/assignments/{id}/approve-ai-marks` takes every AI mark on one question
(Approve all). A row it has not marked (no credits, a file it can't read, a failed
part, a restart, or a submission the sweep made, which starts no marking) reads Not
graded in amber, whatever the cause (Epo 2026-11-14: no red No credits chip); the pane
says why, and its AI column reads "–". `POST /api/assignments/{id}/mark-with-ai` runs
the AI over all of those across the assignment, one attempt at a time per payer,
with "Grading 12 of 40 answers…" from the report's `marking` while it runs. Nothing
retries by itself (Epo 2026-11-03).

**A graded quiz's Grading** (Epo 2026-11-14 as Approve AI grades, a view of
Responses from 2026-11-15, its own Grading tab since 2026-11-19, after
Gradescope and Crowdmark; `ApproveTab`). A row above the columns holds what is assignment-wide: "{n} to
approve · {k} not graded", Grade {k} with AI (only when some wait; Read papers again
under manual marking), an "Only {name}" chip when opened from a member's "to approve"
on Responses By member, Overview and Next to approve. Below, from `lg` three columns: every
question (Epo 2026-11-19; the report's `answers` hold a row for every answer)
under To approve (count of waiting answers; under Manual marking, To grade, as are the toolbar's "N to grade", Start grading, Next to grade and the form's Save marks, Epo 2026-11-20) and Done (tick), "AI marked" in the
accent colour after "Q3 · 6 marks" on one with a written or drawn part unless
Marking is Manual; the chosen question's members (waiting first, Approve all),
and the grading pane, showing a written answer as the member's results do (Epo
2026-11-19: `OpenPart`, Your answer boxed, Marking points | AI | Awarded, the
sample answer and Solution; under 448px of its own width the points and the
mark alone). A question marked by rule opens the results' own staff
view (`ResultBody`: the member's answer against the key, a Mark field per
part, a comment, Save marks), a read paper's pages above it, or the whole
paper while it waits to be read. From `md` each column scrolls on its own, the two
lists with no scrollbar, and Full screen at the tabs row's end covers the page
with the row and the columns (`fullscreen=true`, exit at the row's end or
Escape), as a task's Grading. From
`md` to `lg` (T1) the questions become a strip of chips (count or tick) above members
| pane. Below `md` (P1) it goes one screen at a time: the question list with
Overview and Start approving (the first waiting answer), a question's members under
"← Questions", then the answer under "← Q3 members" with "1 of 5" and Previous /
Approve kept at the bottom. Past the list the tab carries `data-approve-drill`, and
`tailwind.css` hides the workspace header and the report's head (back link, title,
tabs) while it does. Approve and Next move to the next waiting answer in question order, on to the
next question once one is cleared. Overview opens Crowdmark's grid in a dialog:
members × questions, purple for To approve, amber for Not graded,
plain once approved, "–" for no answer; a cell opens that answer. The report header
chips, the Assignments row and By member's link use the same colours: purple
for to approve, amber for not graded.

**Closing releases** (Epo 2026-11-03, 2026-11-04: closing, not the due date
alone). Once it has closed, by hand or at a No late submissions due date, and
its grades show, the sweep (within a minute) sets `released_at` and rates each
attempt's fully marked questions on the quiz (§11.6), a later-marked one when it
stops waiting. Under Show answers Do not show a class's graded quiz is never
released, so its answers never join reviews (a Task is released as before).
The owned quiz stays held for good either way: Turn to practice is gone (Epo
2026-11-14), and a closed graded quiz never becomes practice. Closing a marked
assignment asks "Close assignment" and lists what it does (`closeOutcomes`,
Epo 2026-11-14): closing before the due date (in red) or ending late work, how
many have not submitted, the answers it releases or keeps hidden (nothing under
After submission, where they already show) and grades held under Manual. The
members list's late note says only that late work stays open until staff close
it.

**Graded assignments** (Epo 2026-11-14, `todo-graded-quizzes.md`, after Canvas;
migration `0176_assignment_points.sql`). A class's Assignment may have **Points**
(New assignment's own row under Due and Assign to, board Task, and the Settings
tab's Details; empty is not graded, whole points 1 to 1000; a Task has none, and
the store refuses points on a graded quiz or a task). Graded, the form adds Show
grades (in Advanced; Settings' Marking and results) and the late penalty, and an
ungraded one sends Show grades Automatic and no penalty. Its staff enter each
member's grade on the Grading tab (`GradeField`), the Members tab showing it
read only (Epo 2026-11-19, as a graded quiz's Responses), from 0 to the points
with at most one decimal place, saved on Enter or Save, never on
leaving the field (as quiz marks wait for Save), emptied to clear it (`PUT
/api/assignments/{id}/grades/{userId}`, `SetAssignmentGrade`: staff only, as
quiz marks, for anyone it went to, ticked or not, open or closed; a draft or an
ungraded one refuses). Every read takes the grade where a graded quiz takes its
counted submission (`gradesSQL`, `assignmentGrades`): the report's member rows
(`correct`, `mark` after the penalty, `total` the points, `latePenaltyPct`), the
Assignments table's Average and the Members tab's stat (the mean of mark over
points), `mine` (the member's Assignments row, To do's Details and the details
dialog read "17/20", their page "Grade 17 / 20" or "Out of 20"), and Members'
standings and profile (a grade counts its points into Overall). Late is the
tick's or hand-in's, so a grade with no tick is never late. Show grades Manual
holds it as it holds marks (`gradesHidden`), Release grades shows on the report
header, and releasing rings each member graded. A grade on an assignment whose
points were taken off stays stored and unread. Lowering the points leaves a
higher grade as it was (Epo 2026-11-14, as Canvas keeps extra credit): it counts
as given, a share above 1 in the Average and Overall, with no rescale.

**Sharing notice** (Epo 2026-11-04, board V1). A simple compact dialog, 540px wide
from `sm` and the width of the page less its gutters on a phone, on a viewer member's
first open of a class after joining or once for those already in one: the workspace's
name, its owner as public pages show one (avatar left of the name, read with the
notice only while it is due, supersedes the 2026-11-03 "doesn't name the owner"),
the one line "Your practice and attempts are shared" (Q718: Members shows its owner
and teaching assistants each member's practice and attempts), and one button; a
member who dismissed the earlier wording is not told again (`SharingNotice.tsx`, `GET` and
`PUT /api/workspaces/{id}/sharing-notice`). Dismissing it counts as told, once per member
row, so leaving and rejoining tells again. Staff and personal workspaces never see
it. A class's viewer agrees to it on the invite page instead (Epo 2026-11-19):
before Accept the page reads the invite (`GET /api/workspace-invites/{token}`, its
role and workspace kind, for the invitee alone) and a class viewer's shows "By
accepting this invitation, you agree to share the following with the class's owner
and teaching assistants: Your practice and attempts"; Accept marks the notice told
and goes straight into the class, so its first open (an assignment link's Before you
start included) never stacks a second dialog. The in-class dialog stays for a member
who joined some other way or became a viewer later. The board's own line about topic labels waits for topic summaries, and its Join
step and "What members see" link for an invite preview and board G5.

**To do page.** `/todo` (`src/routes/Todo.tsx`, `GET /api/todo`,
`store/assignment_todo.go`) lists what the viewer has to do across the classes
they own or belong to, as a table (`TodoTable`; Epo 2026-11-10, board K at
Artifact EwrCcGhudqpqvwTYQtqaeJ): Billing's table style with the Study pages'
header cells (`Th`, as Assignments' tables; no icons since Epo 2026-11-20), a
group per class with its open count that folds, and columns To do,
Details, Posted (the day it went out, Epo 2026-11-20) and Due. Phones stack each row's due date and details under its title.
Tabs To do (open work and answers waiting, with its count, all of it in one read)
and Done (`GET /api/todo/done`, `ListTodoDone`, `qk.todoDone` under `qk.todo`,
read only while the tab is open: what was given to the viewer that they finished
or ticked off by hand, with the quiz's mark, "Waiting for marks" or "Not handed
in", or that closed undone, dated by the day it was done, ticked off or closed; thirty a page, the next loading near the end as on
Files, sorted and filtered in SQL with an offset cursor; a row a later page
repeats is skipped). The headers sort, all in the URL (`parseTodoSearch`:
`tab=done`, `sort=due` or `sort=title`, `dir` only against the column's own
order, `type=quiz,task`): To do by Posted, newest first, until another header is
picked (Epo 2026-11-20), by Due, soonest first (with Posted, classes with
answers waiting first, then the one whose first row leads), or by To do (title,
classes by name), in the browser; Done by its date, on the server, its Posted
column not sorting.
Neither sorts nor filters by class (Epo 2026-11-10: class against personal stays
inside the workspace). A class with nothing to show is left out. Due reads
"Today, 15:40" and "Tomorrow, 09:00" for the next two days, and Overdue past it
until ticked.

Every row has a checkbox that selects it, and the header's selects them all
(Epo 2026-11-10); the toolbar then
turns into the Files page's selection bar with Mark as done and Mark as not done
(`useTodoTicks`). A plain task's tick is its
done (`PUT /api/assignments/{id}/done`). A quiz or one handed in with files ticks
itself once submitted or handed in, and marking one done by hand asks first
(`TodoCheckDialog`, once for several), then only takes it off To do: `PUT
/api/assignments/{id}/todo-check` stores the tick in `assignment_todo_checks`
(migration 0165), read back as `mine.checkedOff` while `mine.done` and Missing
stay as they were; the row reads Not handed in. Staff tick the answers waiting
the same way (`approvals`), read as `manage.approvalsCheckedOff` until an answer
is submitted after it. What's done or ticked off leaves To do for Done at once, closed or not (Epo
2026-11-10: done for them is done; `todoSections`, `checkedAt` dates it on
Done), and Done's Mark as not done brings a task's tick or a tick by hand back;
ticked-off answers waiting leave To do until more come in. A mark shows at once
and holds until To do has reread: the picked rows' requests go out together
(`useTodoTick`) and one refresh follows them, and a dialog that marks its row
closes with it. The tab's count and the empty state follow at once too: the
header stays and "Nothing to do" shows under it the moment the last rows are
marked. Its dates carry the year and no weekday ("18 Nov 2026"; Today and
Tomorrow keep the time). On Done the date column is Done on (the day it was done
or ticked off, else "Closed" and the day it closed), rows are muted past their box (no
strike line), and the selection bar adds Delete (danger, after Mark as not done): after
asking, the rows leave the caller's Done list only (`POST /api/todo/done/hide`,
`assignment_todo_hidden` in migration 0165), nothing else changing; a row finished
again after it was deleted shows on Done again. A row opens `TodoDialog` (600px, Epo 2026-11-10 round 6
option A): the title alone in the header, then facts with an icon each (its
workspace, answers waiting, the due date with how long is left, the quiz's size,
time limit and attempts, who posted it) and its files as the workspace panel
draws them, each opening in its workspace. The shared dialog footer holds the action
(Epo 2026-11-10; no Cancel, the corner closes): Mark
as done for a task, Start quiz, Continue quiz or See results for a quiz, Hand in
or Open for a hand-in, Approve marks for an approval, each of these with Mark as
done (or Mark as not done on Done) beside it while it can be ticked, which still
asks first. On phones both buttons follow the content, since a long
title needs the header's width. The table takes the page's full width; titles stay
on one line and end in an ellipsis, and a Posted by column shows from xl (1280px).
Add task, a dark button, sits at the toolbar's right for everyone
(`NewAssignmentAnywhere`, Epo 2026-11-10). The form opens at once as a task with no
workspace, and its first field, Workspace (optional, No workspace then the
workspaces the caller is a member of), puts it in one (Epo 2026-11-11: "the same
design as existing one, just with a workspace option"; the step that asked which
workspace first is gone). It is one dialog (`NewAssignmentDialog`, Epo
2026-11-11: "dont spwn another dialog, make both dialog the same thing, just
hide/render the options/inputs that applies"): picking a workspace shows or hides
fields in place, a class the caller runs giving the assignment's fields and
anything else or No workspace a task's: every one of those but Assign to and
Draft only (below). What is typed stays; what belongs to the workspace left
behind is cleared (its quiz, its people, an assignment's files), while a task's
quiz and files stay from task to task.
Outside a workspace the words are
the same for everyone (Epo 2026-11-10): the button, the dialog and its toast say
task and workspace, never assignment or class.

**A task with no workspace** (Epo 2026-11-11) is `own` with a null
`workspace_id` (migration 0168 drops the NOT NULL, with a check that only an own
task has none). `POST /api/todo/tasks` makes one from the same body, held to a
task for oneself; its maker alone reads, changes, ticks and deletes it through the
assignment routes (`lockTaskTx` and `taskRow` take an empty workspace, `ownedSQL`
stands in for the membership `givenSQL` reads). `GET /api/todo` and
`/api/todo/done` return these tasks as a section with an empty `workspaceId`, name
and icon, first on To do; the table shows it first under either sort, under a
group row reading No workspace with no icon, and the details dialog has no
Workspace row. The 100-task cap counts them apart from any workspace's, and the
account purge deletes a person's own tasks, since no workspace's cascade would.
Its pages (taking its quiz, results, its report and settings) have no workspace
to sit in, so `/todo/task?assignment=` hosts the same components
(`routes/TodoTask.tsx`, `assignmentPage` picking between it and
`/workspaces/{id}`); with no `assignment` it goes back to `/todo`, as the pages'
own back links do.

**A task's files come from anywhere** (Epo 2026-11-11: "files chosen should have
nothing to do with which workspace this task belongs to"). For an own task, in a
workspace or not, the store takes any file or block its maker can open
(`ownTaskFileSQL`, `ownTaskMaterialSQL`: their own with no workspace, and what a
workspace they are a member of shows them, a canvas left out; one they only pay
for in a workspace they left is not theirs to open) and reads each back only while they still can, so one
they lose leaves the task. `AssignmentFile` carries `workspaceId` and
`workspaceName`, absent for a file with no workspace. In the form
(`TaskFilesField` in `TaskFiles.tsx`, which the dialog shows in place of the
class's `FilesField` for a task of one's own) Choose a file opens Make a quiz's
search menu (`FileSearchMenu`): a field over `GET /api/items?scope=all&q=`, newest
first until something is typed, each row with its workspace's name or No workspace;
a row adds the file. Both Files fields keep Choose a file, a full-width
select-like trigger (`ChooseFileButton`), above the files chosen, each 32px row ending
in a small muted × (`RemoveFileButton`), with no dividers; the menu ticks the files
already on the task and stays open for more until closed, a ticked row takes its file
off, and at the files cap its unticked rows are disabled while the trigger still opens
it (Epo 2026-11-12). The task's Quiz field opens the same menu and closes on its pick. A picked row
names its workspace, and the details dialog opens each file where it sits
(`/workspaces/{id}?file=`, or `/files/{id}` and `/materials/{id}` with none),
naming the workspace when it is not the task's own. An assignment's files stay
its class's, picked from the class (`FilesField`), since members must open them.

Inside a workspace the words follow who gives out work (Epo 2026-11-10, the
menu 2026-11-14): a class's owner and editor members get the New menu
(Assignment, Graded quiz), a personal workspace's people the New menu with Task
and Graded quiz, and a class's viewer members New task, since a viewer gives out
no assignments. The button sits in the Dashboard's To do section (a small
outline `NewAssignmentMenu`, `small`) and at the top of the Assignments or To do
page. The Dashboard's section stays with nothing in it (Epo 2026-11-10: always
show, and nothing is hidden that he did not ask to hide): its heading, its
button (a visitor who is no member has none) and the To do page's "Nothing to
do". A
workspace with no files shows it too, above its empty state.

New task is a task for oneself, the same dialog with `own` set (its heading New
task; there is no second form), saved as an assignment with `own` set (migration
0168) that names its maker alone. It takes every option an assignment does but
Assign to (Epo 2026-11-11: "everything should apply except for the assigning
members, and maybe filtering files"): marked or not, time limit, attempts,
marking, Show grades, Show answers, Allow submission with uploads and Advanced.
There is no Draft only, since To do lists no drafts and the task would have
nowhere to be found. A marked Task is made through New › Graded quiz (below) and
owns its quiz as a class's graded quiz does: it is made with its quiz in one
request (the quiz maker's `gradedQuiz`, or Existing quiz's copy; The owned
quiz), and Republish freezes the
owned quiz again (`checkFreezeTx`). `POST /api/workspaces/{id}/assignments` takes a task from any
member who is not a class's staff, and from them only for themself
(`checkOwnTask`: no draft, nobody else); a class's staff make assignments there
as before.

An own task is the case of staff who are also the one it went to: its maker
holds both `manage` and `mine` (`readAssignments`), and every assignment route
reads standing from the task's row (`taskRow`, `staffOf`, `lockStaffOfTx`)
instead of the workspace alone, so its maker publishes again, closes, reads the
report, approves and changes marks, and takes it, in a class, a personal
workspace or none, while a class's staff and the workspace's owner get 404 on
all of it (`givenSQL`): they neither list it nor count it (Members, the
Dashboard's Activity, the `todo` event and the class's caps leave it out). A
task in a workspace needs its maker still a member; on leaving or removal their
tasks there move to no workspace with their attempts
(`RemoveWorkspaceMemberWithResult`), and a workspace that is deleted leaves every
member's tasks the same way (`deleteWorkspaceWithResultTx`) instead of taking
them in its cascade. While the workspace's owner is suspended or leaving, a task
in it is out of reach like everything else there. What it does not do: it never
hides a quiz it does not own, releasing its grades sends no notification,
and its answer events log under the quiz's own workspace, as practising the quiz
does, so that workspace's row is key-shared before the accounts
(`taskRow.lockQuizWorkspaceTx`). What a
class gave out still hides while the workspace is personal. The task sits in its
maker's To do and Done under the workspace's name, in the Dashboard's To do and
the workspace's To do page; its tick is the plain task's, and it opens To do's
details dialog wherever it is listed (ticking as the To do page does: a plain
task's tick is its done, a quiz's or a hand-in's asks first and only clears To
do), with Delete and Edit in
the footer and, for one with a quiz, Start quiz, Continue quiz or See results:
Edit opens the same form, Delete asks and then deletes the task for good (`DELETE
/api/assignments/{id}`, its maker only, also while frozen). Its results page
keeps Attempt again and Practise again for its maker, though they run it too, and
its back link opens the report. A file on its pages opens where the file sits
(`fileLink`). A member holds at most 100 own tasks in one
workspace, and 100 with no workspace, done or not (`OwnTasksPerMember`, 409
`task_limit`).

A class holds at most 500 assignments, 100 of them open
(`row_caps.go`, 409 `assignment_limit` and `assignment_open_limit`, shown in the
New assignment dialog or as a toast), and making or publishing one is limited
to 60 an hour per person (authorization-permissions-lifecycles.md,
observability-metering.md § rate limiting). The nav's To do row carries the notifications dot while `todoCount`
(open and waiting, not ticked) is above zero (Epo 2026-11-08).

**Keeping To do current** (Epo 2026-11-08). A `todo` event on the user's stream
(`publishTodo`, after the commit, best effort) asks every open tab to refetch
`qk.todo`, its Done pages too, and every class's assignments (the Dashboard's To
do), a second after the last of a burst. Posting,
editing (those it was given to before and after), closing, reopening, republishing,
deleting and approving AI marks tell everyone it is given to and the class's staff
(`TodoAudience`); a submission, a mark, saved AI marks or a read paper's marks tell the staff and that member; a tick
tells the member's own tabs. Reconnecting refetches To do with the notifications.
A No late due date closes with no request, so nothing is sent: To do's lists go
stale in 15 s and refetch on window focus, and clicking a row past it refetches To
do while its page says it closed. The sweep submitting an attempt left running
tells the class's staff and that member (`publishSweptTodo`).

**The New menu** (Epo 2026-11-14, `NewAssignmentMenu.tsx`). Assignments' header
(a class's staff) offers Assignment and Graded quiz; a personal workspace's To do
offers Task and Graded quiz; a class member keeps a plain New task. Assignment and
Task open `NewAssignmentDialog`, which has no Kind or Quiz field (an unmarked
form). Graded quiz opens `GradedQuizDialog`, titled New graded quiz, with its
questions first and Settings last (Epo 2026-11-20, reversing 2026-11-16's
Settings first, which followed Canvas, Google Classroom and Moodle: what was
picked decides some settings, and Title can start on its name). There is no
stepper in the title (Epo 2026-11-19). It is one dialog (`MakeQuizDialog` with
`tabs.settings`), 1040px wide (Epo 2026-11-20, for From question bank's three
columns; every way and Settings alike, so moving between them never resizes it) and 88dvh
tall, and Settings shows in place of the steps before it, which stay mounted, so
Back finds the pick as it was. Step 1 is New quiz's (`AddPracticeDialog` with
`graded`) opening on five ways as cards (Epo 2026-11-20, board B), each step
under its way's name: Existing file first (Practice's quizzes and the
workspace's files in the Convert file menu's 36px rows; a quiz is copied whole, a
file becomes the question paper of a graded quiz from a file, below), then
Extract from file (was Convert to quiz), Generate quiz, From question bank (was
From the bank) and Create blank. Each way's Next (Extract's after its pages)
hands its pick (`GradedSource`: name, whether it is a file or a draft, and how
to send it) to Settings and saves nothing. Step 2 is Settings
(`useAssignmentForm` with `graded`, the form `NewAssignmentDialog` wraps): the
marked fields, the due date required, Title starting on the pick's name (a
quiz's title, a file's name without its extension, Generate's "{topic}
practice", a bank or blank quiz's "{workspace} quiz {n}") and following later
picks until something is typed. A file's Settings show Marking locked at Manual
grading only with Points (the total, typed) beside it, and Submission locked at
Upload only, as its Settings tab does; picking a quiz again puts back what they
were. A quiz's Settings show its Points beside Marking, fixed: its questions'
marks as members would get them (`useQuizFileQuestions`, the stored questions
followed live, those with answers), loaded when it is picked. Show grades and
Show answers are at the top of Advanced (Epo 2026-11-20). Create
sends the pick with the settings in one request (The owned quiz) and a failure
shows above the footer; Existing file and From question bank say Create,
Generate, Extract and Create blank say Create draft. Back returns to the pick
(on a phone, the header's back arrow). Extract's pages and run stay in the
dialog's own state, with no Hide the quiz switch, and its run shows once
Create starts it. Cancel leaves nothing behind. A member profile's Assign quiz
(Epo 2026-11-16, was Assign practice) opens the same dialog with that member as
the only assignee and Generate on their weakest topic. Editing a graded quiz shows its quiz as a locked field. Making a quiz
refreshes `qk.practice`.

**Dashboard.** `TodoSection` (H1, H2, H2b) is the To do page's `TodoTable` for one
class (Epo 2026-11-12, `single`: no group row): a box on every row, the row opening
its details, Posted (newest first to start, as the page, Epo 2026-11-20), Due and
To do sorting it. A member's To do is what went to them; staff's
holds answers to approve and anything they gave themselves, with New assignment (New
task for everyone else) at its top right, which turns to Mark as done (Mark as not
done for done rows) while rows are selected, using the page's `useTodoTicks`. Show
done brings finished ones back, muted, and keeps a row in place as it is marked
(`keepTicked`). Narrower than the table's 680px, beside an open panel, it stacks
each row's facts under it as phones do. Empty, it says Nothing to do. Activity gains
"assigned" rows, to whoever it went to and staff.

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
- `server/internal/store/members_progress_test.go`,
  `server/internal/httpapi/members_progress_test.go`,
  `src/features/study/members/membersRows.test.ts` and
  `src/features/study/members/MembersPage.test.tsx`: Members; see
  [test-catalog.md](test-catalog.md).
- `server/internal/review/review_test.go` also holds the answer-history
  order Epo signed off (`TestHistoryWeightsOrder`).
- `server/internal/review/topic_label_test.go`: the label counts Epo reviewed, a
  same-day repeat, an edited question, a long question's cap, Mastered, and Needs
  practice holding.
- `server/internal/store/review_sessions_test.go`: suggestion groups (a
  passing topic, nothing suggested outside topics, interest discounting), session picks interleaving modes and cutting recalled
  items, the interest curve, and recorded sessions (no row before an answer,
  resume, Continue review, another user refused, finishing, History's open,
  partial and done revisions and its kind filter).

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
  Study's Overview for a member (Suggested, Only you, best scores) and Practice
  for an owner
  (members, tried by, group average), and the rail's rows by role.
- `server/internal/store/practice_test.go`: Learning's Overview for a learner and
  a class's owner; served items' reasons,
  Practice's quizzes and sets (a set's best from full runs), best attempt and the staff counts and average, and the
  Dashboard's owner, member count and activity (`TestWorkspaceDashboard`).
- `e2e/study/study-progress.spec.ts` (Docker stack, the detailed checks):
  quizzes and sets practised through the attempt and study pages becoming
  reviewable; a mixed review
  session; a Practice topic session to its result and its row; Workspace
  settings kept in the URL.
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
