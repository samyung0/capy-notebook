# Plan: study progress and review

Date: 2026-10-01. Owner: Epo. Status: final, ready to implement. Plan A of two; plan B
(`library-agent-plan.md`) builds on it. Decisions: `human/miscellaneous.md` and
`human/authorization-permissions-lifecycles.md` (2026-10-01 entries). Deferred
work (offline review, bank progress, Jev in review): `todo-learning-outputs.md`.

## Goal

Each user has their own progress in each workspace: what they have read, which
quizzes and flashcard sets they have practised, and a memory state per question
and card. Progress is on by default. A Study tab shows it and offers Continue,
Review and Reset. Review mixes the weakest questions and cards from everything in
progress, ordered by FSRS, with no due dates anywhere.

No production or UAT data exists, so tables and endpoints are dropped and
replaced without migration code. The pilot bank database is untouched.

## Current state

- **Flashcard scheduling is shared, not per user.** `card_stats`
  (`server/migrations/0001_init.sql:458`) keys FSRS state by `card_id` alone.
  FSRS runs in the browser (`src/lib/srs.ts`, `ts-fsrs`), and the server stores
  whatever the client sends through `PATCH /api/flashcards/cards/{id}/study-state`
  (`server/internal/httpapi/huma_flashcards.go:69`), which requires edit access
  (`assertCardEditor`), so viewers cannot record progress. `known` and
  `known_pct`/`due_count` come from the same rows (`queries.go:1989`) and show on
  `MaterialRefCard.tsx:154` and `CenterContentHeader.tsx:150`.
- Chat Undo of a card removal restores the card's shared state through
  `agent_card_state_restores` (`0001_init.sql:902`), and the collaboration service
  refuses some undos when a card has progress (`collaboration/src/persistence.ts:970-1097`).
- **Quizzes are graded in the browser.** `QuizAttempt.tsx:153` scores closed parts
  locally and open parts through `/api/quiz-grade`; the server stores the
  snapshot with each part's `awarded` and trusts `correct`/`total`
  (`huma_quizzes.go:230`). Answers are keyed by part id; question ids are stable
  element ids, unique within a quiz but **not rewritten on clone**.
- `mistakes` (`0001_init.sql:502`), `GET /api/mistakes` and the `review_mistakes`
  virtual quiz exist on the server and in MSW only; no UI calls them. Learning
  has one tab, Past results (`src/routes/Learning.tsx`).
- Embedded quizzes and flashcards are rows with `parent_material_id`, hidden from
  the tree (`ListMaterialRefs`, `queries.go:1754`).
- Workspace rail: `PanelTab = 'files'|'chat'|'generate'` (`src/routes/WorkspaceOpen.tsx:62`);
  read-only users get files and chat. The Add file dialog has upload, import and
  create (`AddSourceDialog.tsx:511`).
- File panel order: `FilesPanel.tsx` `contentFor()` (`:118`) merges a chapter's
  files and materials by position, files before materials on ties, then newest.
- Settings: no generic settings table. Preferences are columns on `users`
  (`locale`) or `notification_prefs` (`Settings.tsx` Customizations and
  Notifications tabs).
- Lifecycle: `users` rows are tombstoned on deletion, so `ON DELETE CASCADE` on
  `user_id` never fires; `PurgeUser` (`account_purge.go:137`) deletes per-user
  tables explicitly. `TestOwnerColumnsAreCoveredByTransfer`
  (`workspace_transfer_test.go:211`) fails for a new table holding both
  `workspace_id` and `user_id` unless it is listed in `notOwnership`.

## Data model

Three tables and one column. All per user; none copied by clone; none charged
to storage.

```sql
-- Global default; a workspace row below overrides it.
ALTER TABLE users ADD COLUMN study_progress boolean NOT NULL DEFAULT true;

CREATE TABLE workspace_study (
  user_id      text NOT NULL REFERENCES users(id),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  enabled      boolean NOT NULL,
  PRIMARY KEY (user_id, workspace_id)
);

-- One row per touched file or material. No row = never touched.
CREATE TABLE study_progress (
  user_id      text NOT NULL REFERENCES users(id),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  file_id      text REFERENCES files(id) ON DELETE CASCADE,
  material_id  text REFERENCES materials(id) ON DELETE CASCADE,
  state        text NOT NULL CHECK (state IN ('started','done','removed')),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CHECK ((file_id IS NULL) <> (material_id IS NULL))
);
-- unique (user_id, file_id) and (user_id, material_id), partial on non-null

-- FSRS memory state per question or card, per user.
CREATE TABLE review_states (
  user_id     text NOT NULL REFERENCES users(id),
  material_id text NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  item_id     text NOT NULL,           -- quiz question id or flashcard id
  item_hash   text NOT NULL,           -- prompt + answer key; mismatch = new item
  stability   double precision NOT NULL,
  difficulty  double precision NOT NULL,
  reps        int NOT NULL,
  lapses      int NOT NULL,
  fsrs_state  smallint NOT NULL,
  last_review timestamptz NOT NULL,
  PRIMARY KEY (user_id, material_id, item_id)
);

-- Append-only; cheap now, needed later for offline merge and parameter fitting.
CREATE TABLE review_log (
  user_id     text NOT NULL REFERENCES users(id),
  material_id text NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  item_id     text NOT NULL,
  rating      smallint NOT NULL,      -- 1 Again .. 4 Easy
  reviewed_at timestamptz NOT NULL DEFAULT now()
);
```

Notes:

- `review_states` keys include `material_id`, so cloned quizzes that share
  question ids stay separate.
- A row whose item has left the document is ignored by every read and revived
  if the item comes back (chat Undo). Rows die with the material. This replaces
  `agent_card_state_restores` and the collaboration service's progress-aware
  undo refusal: both are deleted.
- No due date is stored or shown. FSRS's next interval is not needed for
  ordering: retrievability is computed from `stability` and `last_review`.
- Embedded materials (`parent_material_id IS NOT NULL`) never get a
  `study_progress` row and never appear in combined review. Their flashcards
  still get `review_states` so their own Study page schedules (open decision 4).

Drop: `card_stats`, `known`, `known_pct`, `due_count`, `agent_card_state_restores`,
`mistakes`, `ReviewMistakesQuizID` and their indexes, seeds and fixtures.

## FSRS on the server

- Go package `server/internal/review` wrapping `github.com/open-spaced-repetition/go-fsrs`
  with default parameters, target retention 0.9, a one-year maximum interval,
  and fuzz off (nothing is scheduled by date).
- `Rate(state, rating, now) → state` and `Retrievability(state, now) → float`.
- Ratings:
  - Flashcards: the four buttons map directly.
  - Quiz questions: score = sum of the question's parts' `awarded` / max marks,
    normalised to 0–1. Below 0.5 → Again, below 0.7 → Hard, otherwise Good. Never
    Easy. Scores come from the client's snapshot, which the server already
    trusts for attempts; a user can only distort their own progress.
- `item_hash`: SHA-256 of the canonical prompt and answer key (card front and
  back; question stem, parts and accepted answers), not formatting. Computed by
  the server from the stored document when a rating is written; a mismatch at
  read or write time treats the item as new.
- Signed-in rating buttons no longer preview intervals. `src/lib/srs.ts` and
  `ts-fsrs` stay for anonymous, browser-local flashcard study
  (`anonymous-study-plan.md`, decided 2026-10-02).

## API

All progress endpoints need read access to the workspace, not edit access.

| Endpoint | Purpose |
|---|---|
| `GET /api/workspaces/{id}/study` | `{enabled, items: [{fileId?, materialId?, state}], recentAttempts, hardest}` for the Study tab, the file panel marks and Continue |
| `PUT /api/workspaces/{id}/study/enabled` | Per-workspace toggle (`workspace_study`) |
| `PUT /api/workspaces/{id}/study/items` | `{fileId \| materialId, state: done \| removed \| null}`: Mark as read, Remove from progress, Mark as unread (null deletes the row) |
| `POST /api/workspaces/{id}/study/reset` | Deletes the user's `study_progress` and `review_states` for this workspace's materials; keeps attempts and the log |
| `GET /api/workspaces/{id}/review?materialId=` | Next session: up to 20 items, unseen first only when reviewing one set, otherwise the lowest retrievability among items in progress (not removed, not trashed, not embedded), with each item's content |
| `POST /api/review/ratings` | `{materialId, itemId, rating}` for a flashcard; `{materialId, itemId, score}` for a question answered in review |
| `PATCH /api/me/study-progress` | Global default |

Side effects folded into existing writes, in the same transaction:

- `POST /api/quizzes/{id}/attempts`: for a workspace quiz that is not embedded,
  rate every question from the snapshot and upsert `study_progress` to `done`.
- `POST /api/review/ratings` on a flashcard: rate the card; for a workspace set
  that is not embedded, upsert `study_progress` to `started`, or `done` once
  every current card has a state.
- Attempting or rating an item the user removed puts it back in progress.
- Recording happens whether progress is on or off, so turning it on shows the
  history.

Delete: `PATCH /api/flashcards/cards/{id}/study-state`, `GET /api/mistakes`,
`GET /api/quizzes/review_mistakes`, the `known`/`srs`/`dueCount`/`knownPct`
fields from flashcard and material responses, and their openapi entries.

## Frontend

### Workspace rail

- Tabs become **Study, Files, Chat** (`WorkspaceOpen.tsx`), for every role that
  can read the workspace. Study is first.
- The Generate tab moves into the Add file dialog as an **AI generate** mode
  beside Upload, Import and Create (`AddSourceDialog.tsx`), reusing
  `GeneratePanel`/`GenerateFormDialog` unchanged. The `generate` rail tab and its
  wiring go.

### Study tab

- Progress toggle for this workspace.
- Progress summary in plain counts (items done, sets started), no percentage.
- Actions: **Continue**, **Review**, **Reset** (with a confirm dialog).
- Recent quiz attempts in this workspace (from `attempts` joined to the
  workspace's materials), linking to the result page.
- Hardest items: the few questions and cards with the most lapses, linking into
  a review of that set.
- With progress off, the tab shows only the toggle and a one-line explanation.

### Continue

Computed in the browser from the tree the file panel already loads: chapters by
position, each chapter's `contentFor()` order, then unfiled. Opens the first file
or material whose state is neither `done` nor `removed`. Embedded materials are
not in the tree. Extract `contentFor` so the panel and Continue share it.

### File panel and viewers

- With progress on, `FileListItem` and `MaterialListItem` show a check beside the
  icon for `done` and a partial mark for `started`.
- The row ⋮ menu and the viewer header (`CenterContentHeader`) get **Mark as
  read** / **Mark as unread** and **Remove from progress** / **Add back**.
- `MaterialRefCard` and `CenterContentHeader` drop "% known" and "N due"; card
  count stays.

### Review

- New route `/workspaces/$id/review` (optionally `?materialId=`): lists the
  quizzes and flashcard sets in progress with their item counts, a **Review**
  button for a mixed session and a per-set button.
- Session runner, one item at a time: flashcards flip and take the four ratings;
  questions reuse the question components from the quiz page and are graded the
  same way (`scoreAttempt.ts`, `/api/quiz-grade` for open parts), then the score
  is posted. Twenty items per session; "Review more" fetches the next 20.
- `FlashcardStudy.tsx` keeps its per-set page but takes its queue from
  `GET .../review?materialId=` (new cards first in document order, then lowest
  retrievability) and posts ratings to `/api/review/ratings`. Standalone sets
  (no workspace) use a material-scoped variant of the same endpoint.

### Settings

Customizations tab: a **Study progress** switch for the global default, following
the `NotificationsTab` switch pattern.

### Learning

Past results stays as it is. Nothing to remove in the UI (no Review mistakes UI
exists).

### i18n and mocks

Paraglide keys for every new label in `messages/en.json` and `zh.json`. MSW
handlers and `db` state for the new endpoints, replacing the card_stats, srs and
mistakes mocks (`src/mocks/db.ts`, `handlers.ts`, `scenarioFixtures.ts`,
`scenarios.ts`, `scenarioFailures.ts`, `scenarioJourneys.ts`).

## Lifecycle

| Event | Effect |
|---|---|
| Material or file deleted (purge) | Cascades `study_progress`, `review_states`, `review_log` |
| Material or file trashed | Rows stay; reads skip trashed items; restore brings them back |
| Item removed from a document | Its `review_states` row is ignored until the item returns |
| Workspace deleted | Cascades all four workspace-scoped tables |
| Member or link access lost | Rows stay, unreadable without access |
| Workspace or material clone | Nothing copied |
| Workspace transfer | New tables listed in `notOwnership` (`workspace_transfer_test.go`) |
| Account deletion | Explicit deletes in `PurgeUser` for all four tables |

## Tests

- Go: FSRS rating mapping and retrievability ordering; quiz attempt rates
  questions and marks done; embedded quiz attempt records nothing in progress;
  flashcard set moves started → done; Remove then attempt re-adds; Reset scope;
  review selection skips removed, trashed, embedded and orphaned items; hash
  mismatch resets; viewers and link visitors can record; clone copies nothing;
  `PurgeUser` deletes the rows; transfer test passes.
- Vitest: Continue order over files and materials across chapters; review runner
  posts ratings and scores; Study tab with progress off.
- Playwright: mark as read shows the check; Continue opens the next item; a short
  mixed review session.
- Delete tests for removed code: `mistakes_test.go`, card-state restore in
  `edit_inverses_test.go`, study-state cases in `share_access_test.go`,
  `scenarios.test.ts` study-state dispatch, the non-owner study-state check in
  `e2e/sharing/flashcards-sharing.spec.ts`.
- Docs: new `openwiki/study-progress.md`, a row in the AGENTS.md OpenWiki table,
  `openwiki/test-catalog.md`, and the study-progress lines in
  `openwiki/authorization-permissions-lifecycles.md`.

## Order of work

1. Server: schema, `internal/review`, endpoints, attempt hook, deletions, Go tests.
2. Frontend: rail tabs and AI generate move, Study tab, file panel marks, viewer
   actions, Settings switch.
3. Review route and runner; flashcard page on the new endpoints.
4. MSW, vitest, Playwright, docs.

## Settled during review (2026-10-01)

- Frozen accounts record all progress and review ratings (supersedes the
  2026-09-29 rule refusing flashcard progress). Remove the frozen gate from the
  new endpoints; delete the "study progress" case in `TestFrozenEdges`
  (`collaboration_owner_test.go:353`) and `keptWhenFrozen` handling in
  `src/mocks/scenarios.ts`.
- Hardest items are those with the most lapses.
- A flashcard set is done once every card has been seen; later cards do not
  reopen it.
- Embedded flashcards keep per-user FSRS ordering on their own Study page,
  outside progress and combined review.
- "% known" and `known` are removed.

No open decisions remain.
