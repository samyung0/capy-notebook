# Learning: status and remaining work

The one working file for study progress and review, the chat agent's single
build flow, and the learning outputs deferred after them. It replaces
`study-progress-plan.md`, `library-agent-plan.md`, `todo-learning-outputs.md`
and `todo-knowledge-curate-and-dedup.md` (merged 2026-10-04; the originals are
in git history).

Decisions: `human/miscellaneous.md`, `human/authorization-permissions-lifecycles.md`,
`human/agentic-retrieval.md`, `human/frontend/plate-editor.md` and
`human/question-bank.md`, 2026-10-01 onward. Current behaviour:
`openwiki/agentic-retrieval.md`, `openwiki/question-bank.md` (grading) and
`openwiki/authorization-permissions-lifecycles.md` (signed-out quizzes and
flashcards).

## State (2026-10-05)

Everything below is on `main` (CI green at 2e530e72). UAT runs 2400641b, which
predates 2.5 and the part 1 frontend.

- **Part 1 is built.** Server: migration 0051, `server/internal/review`,
  `store/study.go`, `httpapi/huma_study.go`, the attempt hook, `card_stats`
  slimmed to `flashcard_cards`; mistakes, the card-state undo restores and
  per-set review are gone (review only mixes quizzes and sets, Epo).
  `StudySummary` carries `quickReview` and `reviewable`, the session drops
  `sets`, and `GET /api/review/workspaces` feeds Learning. Frontend from the
  round 4 picks (https://9rn5fsnigkz1.postplan.dev): the Study tab
  (`features/study/StudyPanel.tsx`), marks and Mark as read / Stop tracking
  (`studyItems.tsx`), the header icon, Learning → Review and the session page
  (`routes/ReviewSession.tsx`), AI generate as a mode of the Add file dialog
  (`GenerateFilePanel.tsx`), Reset in Workspace settings → Danger (viewers see
  only that row), the global switch in Customizations, MSW
  (`src/mocks/study.ts`), and Files | Blocks | Trash (`/create` redirects).
  Left: "Tests and docs" below. Only `review_test.go` exists; there is no
  Vitest or Playwright for Continue, the session or progress off, and no
  `openwiki/study-progress.md`.
- **Part 2 phase 1 is done** except the playground output preview. One prompt
  (`prompts/chat.py`) with skills read through `read_skill`
  (`prompts/skills.py`: `editing` and `workspace_building`; `deck` in the
  playground); writes are refused until their skill is in the request. Tool
  descriptions are cut to what the schema cannot say (contract v12). Study
  preferences (`prompts/preferences.py`), the turn context appended last and
  left in place so GLM on Relace caches (`retrieval/turn_context.py`; it lists
  the chapters, capped at 20 by the server), the todo-only ledger and
  `ledger_write`, the limits, `read_study_progress`, and the playground on the
  Library switch with `server/cmd/quizcheck`. The note fence format is in the
  `create_material` contract (`check_note` in the playground). Decks follow
  ppt-master's Quick route (`lab/playground/DECKS.md`, style `editorial`).
  A note and quiz build now takes 7 calls and 107k input, 63% cached (before:
  12 calls, about 290k, 23% cached, nothing written). Handoff for the tuning:
  `lab/playground/HANDOFF.md`.
- **Part 2 phase 2, 2.1 to 2.5, is done.** 2.1: migration 0052 drops
  `conversations.curate`; the Library chip is on by default and Go grants
  `library.read` per turn. 2.2: the collaboration service converts agent
  markdown with the editor's import (`src/features/notes/markdownConvert.ts`,
  bundled by `collaboration/scripts/build-markdown.mjs`: 1.9 MB, 0.4 s to load,
  about 4 ms a note, about 100 MB resident); quiz and flashcards fences become
  embedded rows in the same transaction; `insert_markdown` replaces
  `insert_block`; `mdblock` is deleted; `html-embed` fences stay code blocks
  until phase 3. CI builds the collaboration image (the local build hangs).
  2.3: `chapter_id` on `create_material`, chapters in `list_sources`. 2.4:
  migration 0053 `users.study_preferences`, `PATCH /api/me/study-preferences`,
  the Settings section. 2.5: the bank only through Go
  (`/api/internal/bank/{list,read,copy}`), `copy_questions` (contract v13),
  per-question credits, quiz figure URLs only under `BANK_ASSETS_URL`.
- **Review fix round (2026-10-05):** two reviewers checked part 1 and part 2
  and fixed what they found. Part 1: a first miss counts as a lapse; quiz
  attempts and ratings refresh the Study tab and Learning; an advisory lock
  per user and material finishes a set rated concurrently; `reviewPool` reads
  only rated materials in one query with a per-process document cache keyed
  by revision (StudySummary 420 → 40 ms on 20 sets and 10 quizzes); the hash
  covers only stem and part prompt text; Learning excludes removed items;
  Review more waits for ratings to save. Part 2: bank figures pass the
  collaboration and browser validators (`BANK_ASSETS_URL`,
  `VITE_BANK_ASSETS_URL`); copied credits keep their licence; unsourced copies
  work without indexed files; a refused `insert_markdown` trashes the rows it
  made; the study-progress route requires progress on; `copy_questions`
  counts as a write; no `fallback` in `html-embed` (contract v14). Playwright
  `e2e/study/study-progress.spec.ts` and `openwiki/study-progress.md` exist.
- **Unblocked:** the `/generate` defaults from study preferences (2.4; AI
  generate moved into the Add file dialog), and learners answering on `/bank`
  with bank mistake review (Later, "Question-bank progress"; part 1's FSRS
  package exists).
- **Phase 3 mocks:** https://5i16xblach8o.postplan.dev. Epo picked A (media
  frame, like diagrams). People may edit the snippet, since the risk is the
  same whoever writes it. Signed-out pages never show these blocks (notes are
  not part of them). `SECURITY.md` attack path 11.
- **Lab database** (`capy-odl-agentic-db`), changed by hand: the 0044 and 0050
  catalog updates (2026-10-04); an empty `rag_material_contents` and nullable
  `materials.trashed_at` and `parent_material_id` (2026-10-05); four test
  chapters (`ch_lab_*`) in `odl_eval_odl_nocaption` with 13 files filed.
- **bench/rag cleanup (2026-10-05):** 44 one-off and curate-era scripts and six
  orphaned fixtures deleted; their reports stay, listed in `bench/README.md`.
  `rich_chat_validity.py` now samples GLM on Relace.
- Signed-out study shipped on 2026-10-02: flashcards keep `ts-fsrs` and a
  review log in IndexedDB; Jev grades every open part, signed in or not.
- No production or UAT data needs keeping.

### Decided 2026-10-05 (Epo)

- UAT gets part 1 and 2.1 to 2.5 after the review fix round, in one deploy.
- 2.6: the deck proposal is approved; a deck turn's context and cache are
  measured with written slide SVGs left out of the history.
- Study preferences keep saving on each change (forms are for typed values).
- Phase 3: no fallback; a free `pages.dev` hostname; one Pages project with
  the production branch and a `uat` branch alias.
- The review hash covers only what a question asks; Learning's counts exclude
  removed items; Review more selects again after ratings save.

### Open decisions (Epo)

1. Phase 3 export and limits. Markdown export writes `[Interactive
   snippet](<note URL>)` (Epo, 2026-10-05). Open: DOCX writes the same link
   (Word embeds only approved video sites, not an arbitrary page); the URL
   carries the block id (`?block=<id>`) so the note opens scrolled to it,
   which the editor does not support yet; a per-note cap on interactive
   blocks (proposal 10) with frames mounted only near the viewport.

## Order

1. Done: part 1 mocks, server, frontend, tests and docs; part 2 phase 1;
   phase 2 steps 2.1 to 2.5 and 2.7; the review fix round.
2. The `/generate` defaults.
3. 2.6 decks, then phase 3 (after the open decision above).
4. The playground output preview.
5. Epo's acceptance test (1.9), last: mostly prompt tuning.

---

## Part 1: study progress and review

Each user has their own progress in each workspace: what they have read, which
quizzes and flashcard sets they have practised, and a memory state per question
and card. Progress is on by default. A Study tab shows it and offers Continue,
Review and Reset. Review mixes the weakest questions and cards from everything
in progress, ordered by FSRS, with no due dates anywhere.

### What exists today

- **Flashcard scheduling is shared, not per user.** `card_stats`
  (`0001_init.sql`) keys FSRS state by `card_id`. FSRS runs in the browser
  (`src/lib/srs.ts`), and `PATCH /api/flashcards/cards/{id}/study-state`
  (`huma_flashcards.go`) stores what the client sends behind edit access
  (`assertCardEditor`), so viewers cannot record progress. `known`, `knownPct`
  and `dueCount` come from the same rows (`queries.go`, `listing.go`) and show on
  `MaterialRefCard.tsx` and `CenterContentHeader.tsx`.
- **`card_stats` is also the card-to-set lookup.** `CardMaterialID` (`share.go`),
  card update and delete, card listing, projection sync, workspace clone and
  edit inverses (`edit_inverses.go`) read it.
- Chat Undo of a card removal restores shared state through
  `agent_card_state_restores`, and the collaboration service refuses some undos
  when a card has progress (`collaboration/src/persistence.ts`).
- **Quiz grading.** The browser scores closed parts (`grade.ts` `scorePart`).
  `gradeAttemptQuestions` (`scoreAttempt.ts`) sends open parts to
  `POST /api/quizzes/{id}/grade` (`quiz_grading.go`; read access, at most 20 open
  parts). Signed-out visitors use `/api/public/quizzes/{token}/grade`; both run
  `gradeOpenParts`. `POST /api/quizzes/{id}/attempts` stores the snapshot with
  each part's `awarded` (open parts also `itemAwards`) and trusts
  `correct`/`total`, which are mark totals. It still receives `wrong` for
  mistakes.
- **Marks.** Every part has whole `marks` set by the author. An open part's
  marking items each carry whole marks, set by the author and adding up to the
  part's; Jev gives none, half or all of each item. Closed parts with several
  items (matching pairs, gaps) earn each right item's share, rounded down to a
  half mark; single-item answers are all or nothing.
- Question ids are element ids, unique within a quiz and not rewritten on clone.
  Card ids are rewritten on clone.
- `mistakes`, `GET /api/mistakes`, `ReviewMistakesQuizID` and the
  `review_mistakes` branches in `createAttempt` exist; only MSW calls them.
  Learning has one tab, Past results.
- Embedded quizzes and flashcards are rows with `parent_material_id`, hidden from
  the tree (`ListMaterialRefs`).
- **Workspace tabs.** `PanelTab = 'files' | 'chat' | 'generate'`
  (`WorkspaceOpen.tsx`); read-only users get files and chat. The Add file dialog
  (`AddSourceDialog.tsx`) has upload, import and create. Upload and Import hand
  off to `SourceTransferPanel` and close the dialog, and `GeneratePanel` takes
  tab-only props (`renderTabRow`, `onGeneratingChange`).
- File panel order: `FilesPanel.tsx` `contentFor()` merges a chapter's files and
  materials by position, files first on ties, then newest.
- No settings table. Preferences are `users` columns (`locale`) or
  `notification_prefs` (Customizations and Notifications tabs in `Settings.tsx`).
- **Lifecycle.** `users` rows are tombstoned, so `ON DELETE CASCADE` on `user_id`
  never fires; `PurgeUser` (`account_purge.go`) deletes per-user tables.
  `TestOwnerColumnsAreCoveredByTransfer` (`workspace_transfer_test.go`) fails for
  a new table holding `workspace_id` and `user_id` unless `notOwnership` lists
  it. `notOwnership` still lists a dead `card_stats.user_id`.
- Signed-out study imports the generated `SrsState` type (`localDb.ts`,
  `AnonymousFlashcardStudy.tsx`, `srs.ts`).

### Data model

All per user; none copied by clone; none charged to storage.

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
  item_hash   text NOT NULL,           -- what the item asks; mismatch = new item
  stability   double precision NOT NULL,
  difficulty  double precision NOT NULL,
  reps        int NOT NULL,
  lapses      int NOT NULL,
  fsrs_state  smallint NOT NULL,
  last_review timestamptz NOT NULL,
  PRIMARY KEY (user_id, material_id, item_id)
);

-- Append-only; needed later for offline merge and parameter fitting.
CREATE TABLE review_log (
  user_id     text NOT NULL REFERENCES users(id),
  material_id text NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  item_id     text NOT NULL,
  rating      smallint NOT NULL,      -- 1 Again .. 4 Easy
  reviewed_at timestamptz NOT NULL DEFAULT now()
);

-- card_stats without its review columns: the card-to-set lookup.
CREATE TABLE flashcard_cards (
  card_id     text PRIMARY KEY,
  material_id text NOT NULL REFERENCES materials(id) ON DELETE CASCADE
);
```

- `review_states` keys include `material_id`, so cloned quizzes that share
  question ids stay separate.
- Every read ignores a row whose item has left the document; the row comes back
  into use if the item returns (chat Undo). Rows die with the material. This
  replaces `agent_card_state_restores` and the collaboration service's
  progress-aware undo refusal; both are deleted.
- No due date is stored or shown. Ordering uses retrievability, computed from
  `stability` and `last_review`.
- Embedded materials never get a `study_progress` row and never appear in
  combined review. Rating their cards still writes `review_states`, unused.

Drop: `card_stats` (replaced by `flashcard_cards`), `known`, `known_pct`,
`due_count`, `agent_card_state_restores`, `mistakes`, `ReviewMistakesQuizID`, the
attempt's `wrong` field, and their indexes, seeds and fixtures.

### FSRS on the server

- Go package `server/internal/review` wrapping
  `github.com/open-spaced-repetition/go-fsrs/v3`: default parameters, target
  retention 0.9, a one-year maximum interval, fuzz off, and no short-term
  learning steps, so a miss on any rated item counts as a lapse (hardest items
  rank by lapses). No workspace assumptions inside it, so bank progress reuses
  it.
- `Rate(state, rating, now) → state` and `Retrievability(state, now) → float`.
- Ratings:
  - Flashcards: the four buttons map directly.
  - Questions: score = sum of the parts' `awarded` / sum of the parts' `marks`,
    0 to 1 in half-mark steps. Below 0.5 → Again, below 0.7 → Hard, otherwise
    Good. Never Easy. Scores come from the client's snapshot, which the server
    already trusts for attempts; a user can only distort their own progress.
- `item_hash`: SHA-256 of what the item asks. Cards: front and back text.
  Questions: the stem text and each part's prompt text; answer options,
  marking schemes, hints, image sizes and styling stay out (Epo, 2026-10-05).
  The server computes it from the stored document when it writes a rating; a
  mismatch at read or write time treats that one item as new.
- Signed-in rating buttons stop previewing intervals. `src/lib/srs.ts` and
  `ts-fsrs` stay for signed-out study; `SrsState` becomes a hand-written type in
  `src/lib/srs.ts` once the generated one goes.

### API

All progress endpoints need read access to the workspace, not edit access.
Frozen accounts record progress and ratings like anyone else.

| Endpoint | Purpose |
|---|---|
| `GET /api/workspaces/{id}/study` | `{enabled, items: [{fileId?, materialId?, state}], recentAttempts, hardest}` for the Study tab, the file panel marks and Continue |
| `PUT /api/workspaces/{id}/study/enabled` | Per-workspace toggle (`workspace_study`) |
| `PUT /api/workspaces/{id}/study/items` | `{fileId \| materialId, state: done \| removed \| null}`: Mark as read, Remove from progress, Mark as unread (null deletes the row) |
| `POST /api/workspaces/{id}/study/reset` | Deletes the user's `study_progress` and `review_states` for this workspace's materials; keeps attempts and the log |
| `GET /api/workspaces/{id}/review` | Next mixed session: up to 20 already-rated items with the lowest retrievability among quizzes and sets in progress (not removed, trashed or embedded), each with its content |
| `POST /api/review/ratings` | `{materialId, itemId, rating}` for a flashcard; `{materialId, itemId, score}` for a question answered in review |
| `PATCH /api/me/study-progress` | Global default |

Side effects in the same transaction as existing writes:

- `POST /api/quizzes/{id}/attempts`: for a workspace quiz that is not embedded,
  rate every question from the snapshot and set `study_progress` to `done`.
- `POST /api/review/ratings` on a flashcard: rate the card; for a workspace set
  that is not embedded, set `study_progress` to `started`, or `done` once every
  current card has a state. Later cards do not reopen a done set.
- Attempting or rating an item the user removed puts it back in progress.
- Recording happens with progress on or off, so turning it on shows the history.

Delete: `PATCH /api/flashcards/cards/{id}/study-state`, `GET /api/mistakes`,
`GET /api/quizzes/review_mistakes`, the `known`/`srs`/`dueCount`/`knownPct`
fields from flashcard and material responses, and their openapi entries.

**Grading in review** is the quiz page's path. Closed parts are scored with
`scorePart`; open parts go to `POST /api/quizzes/{quizId}/grade` for the item's
own quiz, one question at a time as the learner submits it. Usage is recorded
like any quiz grade. A failed grade shows an error and the learner resubmits.

### Frontend

Mock first (Epo picks): the Study tab, the Review page and session, AI generate
in the Add file dialog, and the file panel marks with their menu items. The
Settings switch reuses the existing switch pattern without a mock.

- **Tabs** become Study, Files, Chat (`WorkspaceOpen.tsx`) for every role that
  can read the workspace, Study first. The `generate` tab and its wiring go.
- **AI generate** becomes a mode in the Add file dialog beside Upload, Import and
  Create, reusing the generate form, with the kind picked from tiles (mock B). It needs its own footer and generating
  state, since Upload and Import close the dialog and `GeneratePanel`'s props are
  tab-only.
- **Study tab** (mock B): Up next with Continue; Review with the in-progress
  count; Done per chapter ("4 of 5"); recent quiz attempts in this workspace
  linking to their results; Quick review, above Done: one flashcard at a time
  from the sets in progress, among cards with at least one lapse, lowest
  retrievability first, so a card rated Good drops down; it flips and takes
  the four ratings, recorded like any review rating. Track progress and plain
  counts sit at the bottom. A section with nothing in it is not rendered; with nothing tracked,
  one centred line ("Read a file or attempt a quiz to start tracking your
  progress."). Top spacing matches the Files panel. Reset (with a confirm
  dialog) is a row in Workspace settings, Danger; viewers, who cannot open
  settings today, get the dialog with only that row.
- **Continue** runs in the browser on the tree the file panel already loads:
  chapters by position, each chapter's `contentFor()` order, then unfiled. It
  opens the first file or material that is neither `done` nor `removed`. Extract
  `contentFor` so the panel and Continue share it.
- **File panel and viewers.** With progress on, `FileListItem` and
  `MaterialListItem` show a check for `done` and a partial mark for `started`
  at the row end, left of where the hover ⋮ appears (mock B); untracked items
  show muted. The row ⋮ menu gets Mark as read / Mark as unread and Stop
  tracking / Start tracking. `CenterContentHeader` gets an icon button right of
  the view/edit toggle on every file, note, quiz and set (`BookOpenCheckIcon`;
  `BookCheckIcon` in the marks' green once read) and the same items in its ⋮
  menu, and loses its question, card and known counts. `MaterialRefCard` drops
  "% known" and "N due".
- **Review** lives in Learning: a Review tab beside Past results with one row
  and one Review button per workspace in progress (no per-set review). The
  session is a full page with the app navigation, scoped to one workspace; the
  Study tab's Review opens it directly and Back returns to where it started.
  It shows one item at a time: flashcards flip and take four ratings;
  questions reuse the quiz page's question components and grading, then post
  the score. Twenty items per session; "Review more" fetches the next 20.
- **Files and Create merge** (Epo, 2026-10-04): the Files page gets tabs
  Files, Blocks and Trash. Blocks is the user-facing word for materials (code
  keeps "material"); the Create page's list and New button move there as New
  block, and Create leaves the navigation.
- `FlashcardStudy.tsx` keeps its per-set page: every card in document order,
  Again sends a card to the end, Study again restarts; each rating posts to
  `/api/review/ratings` (done).
- **Settings:** a Study progress switch for the global default in the
  Customizations tab, following the `NotificationsTab` switch.
- **Learning** keeps Past results unchanged beside the new Review tab.
- **i18n and MSW.** Paraglide keys in `messages/en.json` and `zh.json`. MSW
  handlers and `db` state for the new endpoints replace the card_stats, srs and
  mistakes mocks (`src/mocks/db.ts`, `handlers.ts`, `scenarioFixtures.ts`,
  `scenarios.ts`, `scenarioFailures.ts`, `scenarioJourneys.ts`).
  `keptWhenFrozen` swaps the study-state entry for `/api/review/ratings` and
  `/api/workspaces/*/study/*`, which the `ownerContent` rule would otherwise
  refuse inside a frozen owner's workspace.

### Lifecycle

| Event | Effect |
|---|---|
| Material or file deleted (purge) | Cascades `study_progress`, `review_states`, `review_log` |
| Material or file trashed | Rows stay; reads skip trashed items; restore brings them back |
| Item removed from a document | Its `review_states` row is ignored until the item returns |
| Workspace deleted | Cascades all four workspace-scoped tables |
| Member or link access lost | Rows stay, unreadable without access |
| Workspace or material clone | Nothing copied |
| Workspace transfer | New tables listed in `notOwnership` (`workspace_transfer_test.go`); drop the dead `card_stats.user_id` entry |
| Account deletion | Explicit deletes in `PurgeUser` for all four tables |

### Tests and docs

- Go: rating mapping and retrievability order; a quiz attempt rates questions
  (half marks included) and marks the quiz done; an embedded quiz attempt records
  nothing in progress; a flashcard set moves started → done; Remove then attempt
  re-adds; Reset scope; review selection skips removed, trashed, embedded and
  orphaned items; a hash mismatch resets; viewers and link visitors can record;
  frozen accounts can record; clone copies nothing; `PurgeUser` deletes the
  rows; the transfer test passes; card update and delete still find their set
  through `flashcard_cards`.
- Vitest: Continue order over files and materials across chapters; the review
  session posts ratings and scores; Study tab with progress off.
- Playwright: Mark as read shows the check; Continue opens the next item; a short
  mixed review session.
- Delete tests for removed code: `mistakes_test.go`, card-state restore in
  `edit_inverses_test.go`, study-state cases in `share_access_test.go`, the
  "study progress" case in `TestFrozenEdges` (`collaboration_owner_test.go`),
  `scenarios.test.ts` study-state dispatch, and the non-owner study-state check
  in `e2e/sharing/flashcards-sharing.spec.ts`.
- Docs: new `openwiki/study-progress.md`, a row in the AGENTS.md OpenWiki table,
  `openwiki/test-catalog.md`, and the study-progress lines in
  `openwiki/authorization-permissions-lifecycles.md`.

---

## Part 2: one build flow, Library switch, search and output formats

Curate mode goes away. Every chat turn can answer or build, and a per-turn
**Library** switch (default on) adds the knowledge library to the workspace as a
source. One prompt holds one build flow: clarify, survey, propose when building
more than one item, build on a todo-list ledger, reply. Study preferences steer
what gets built. The agent searches the question bank, writes real notes with
interactive HTML blocks, and writes decks.

### What exists today

- **Curate mode** is `conversations.curate` (migration 0019), fixed at creation.
  Go refuses a mismatched turn (`curate_mismatch`, `chat_stream.go`) and an
  actor without edit access (`curate_requires_editor`; at creation in
  `huma_chat.go`, which also refuses frozen and full actors), grants
  `library.read` only on curate turns, and forwards `curate` and `ledger` to
  Python. The ledger route refuses non-curate conversations
  (`internal_ledger.go`).
- **Python switches on `ctx.curate`.** `prompts/chat.py` picks the prompt;
  `retrieval/tools.py` offers the library tools and `create_ledger`
  (`KNOWLEDGE_TOOLS`) only on curate turns with the library configured, and
  `schemas_for` swaps in `prompts/curate.TOOL_DESCRIPTIONS`. `agent.py` drops
  the planning ceiling on curate turns, renders curate replies with
  `PlainRenderer` (`retrieval/openui.py`) and refuses curate under a 200k window
  (`_curate_unavailable`). `evidence.py` packs library excerpts only on curate
  turns.
- The Go contract gates `create_ledger` on `OpLibraryRead`
  (`server/internal/agenttools/agenttools.go`). `ContractVersion` and
  `SUPPORTED_VERSION` (`retrieval/contract.py`) are 9.
- **Ledger** (`tools.py`): `requests`, `todos`, `materials`, `next_todo_id`,
  plus turn-only `reads`. `create_ledger`'s `body` replaces `requests`.
  `curate_write` requires a ledger, an open `todo` and read excerpt ids; outside
  curate it ignores `todo` and refuses `excerpt_ids`. Go stores the ledger
  opaquely.
- **Limits** (`retrieval/limits.py`): chat has 8 planning responses, 4 tools per
  response, 32 per turn and an 8-capture cap (`captures_per_turn`,
  `CAPY_CAPTURES_PER_TURN` in `config.py`); curate has 160 per turn, no capture
  cap and the stall guard (5 responses without progress, +2 per errored write,
  at most 9). `prompts/curate.py` hard-codes 4/160/5/2. Compaction caps input at
  250k for every call (`retrieval/compact.py`).
- **Agent-written notes are plain text.** `create_material` stores a note's
  markdown as one paragraph (`materialdoc` `FromLegacyMarkdown`), and
  `insert_block` turns each line into a plain paragraph
  (`internal_documents.go`), so mermaid fences show as raw text. Only the
  browser's markdown import (`src/features/notes/markdown.ts`) builds custom
  nodes; it leaves quiz and flashcards embeds as `pending` refs that the editor
  resolves. `server/internal/mdblock` has no callers. Go `materialdoc` and
  `collaboration/src/materialDocument.ts` let unknown node types through.
- **The collaboration service** builds only `collaboration/src` (`tsconfig`
  `rootDir`, Dockerfile), lacks `platejs`, `@platejs/markdown` and the `remark`
  packages, and `markdown.ts` imports `@/` modules (`materials/*`,
  `questions/validation`, `lib/id`).
- **Playground** (`lab/playground`): imports the app's prompts, tools and agent.
  `scripts/ui.html` has a Curate checkbox. Chat mode grants only `source.read`
  and `material.read` with an empty `user_id` (`scripts/playground.py`), so it
  cannot build. `configs/chat.json` carries a stale prompt copy,
  `configs/curate.json` a frozen curate prompt, and the playground keeps its own
  `KNOWLEDGE_TOOLS`/`ALLOWED_TOOLS`. Its local quiz writes accept payloads the
  app's converter rejects.
- **Frontend:** `ChatPanel.tsx` has the curate toggle, the history chip, the
  AskUser suppression and the curate placeholder; `curateToggle.ts`;
  curate errors in `src/api/chatStream.ts`; MSW scenarios
  `chat-curate-mismatch`/`chat-curate-requires-editor`; `Conversation.curate` in
  openapi.
- **Note blocks:** mermaid renders in `MediaFrame` (width, theme, a caption child,
  click-to-preview, height caps); `EmbedShell` wraps only chart and graph. The
  app has no CSP (`index.html`, `public/_headers`, `workers/site`).
- `GenerateReq` (`retrieve/service.py`) accepts `style`, `length` and `format`
  and ignores them.

### Phase 1: playground

Everything the agent sees or writes is built here first: the prompt and tool
descriptions, question-bank search (1.7) and the output formats (1.8). Phase 1
changes pipeline Python, the Go tool contract's descriptions and schemas
(`agenttools.go`, regenerated with `pnpm gen:openapi`) and `lab/playground`; no
database, gateway or app screen changes. Python reads a `library` flag on
`ToolContext` in place of `curate`; until phase 2 the playground sets it. Epo
tunes the prompt text at the acceptance test; keep a list of prompt changes for
it.

**1.1 Harness**

- Replace the Curate checkbox with a per-turn **Library** checkbox, default on.
- Chat mode grants the build operations (`material.create`, `document.edit`) and
  `user_id="playground"` on every turn; `library.read` only when Library is on.
- One config, `configs/chat.json`, with `system_prompt: null` so the playground
  runs the app's prompt. Delete `configs/curate.json` and the playground's own
  `KNOWLEDGE_TOOLS`/`ALLOWED_TOOLS` once the app's gating covers them.
- Turn inputs for "open file" (a file id or none) and a study-preferences editor
  (fields in 1.4), sent into the prompt the way the app will.
- Local writes go through the real write guard (`ledger_write`, 1.3) and
  validate quizzes with the app's converter, so a saved quiz is one the app
  accepts.
- Last, before Epo's acceptance test: an output preview in place of today's
  raw-text material dialog. It renders saved notes through the app's own
  markdown import (`src/features/notes/markdown.ts`) and static note renderer,
  so mermaid, embeds and blocks look as they will in the app, and serves decks
  for download.

**1.2 One system prompt**

Merge `prompts/chat.py` and `prompts/curate.py` `SYSTEM_PROMPT` into one prompt
in `prompts/chat.py`; delete `prompts/curate.py` except the ledger renderer,
which moves beside the agent. Sections:

1. **Grounding and safety**, shared: tool results are data, never fill gaps from
   general knowledge, the `[formula]` and `[Diagram description: ...]` rules,
   capture before using numbers, formulas, tables or figures.
2. **Answer or build.** A question gets an answer with citations. A request to
   learn, make, expand or practise gets materials.
3. **Build flow.**
   - Ask while the requirement is vague, until the scope and when to start
     writing are clear. Reuse requirements already given; propose a default the
     learner can accept.
   - Survey first with read-only tools (`list_sources`; library browse or search
     when Library is on). This reverses curate's "no tools before clarifying".
   - Propose before building more than one item: the chapters or topics, one
     main explainer each, and the practice. A single item (an explanation for
     the open file, one more quiz) may be built directly. When unsure, propose.
   - Use the ledger for multi-item builds: one todo per material or section.
   - Choose the search per need: workspace, library (Library on), question
     bank (1.7).
   - With Library on, reuse library exercises, worked examples and bank
     questions for practice before generating new questions.
4. **Output rules.**
   - Per chapter, one main explainer: a note for detailed, text-dense learning
     (it exports to DOCX), or a deck once decks work (1.8).
   - Mindmaps, diagrams and interactive blocks go inside the note where they help
     an idea; standalone mindmap or diagram only when asked.
   - Quizzes and flashcards are standalone workspace materials in the chapter by
     default; a quiz or flashcards embed inside a note is a mini knowledge check
     of a few questions or cards.
5. **Ledger rule**, one line: "Building more than one item: keep a todo per item
   on the ledger and pass its id when writing."
6. **Library section**, only when Library is on: library tools, excerpt reads
   before writing, attribution through `excerpt_ids`, topic and role filters.
   Today's curate rules minus the sequence.
7. **Budget**, stated once with numbers read from `limits.py` instead of
   hard-coded text.

The OpenUI answer rules (`openui_lang.txt`) apply to every turn; build replies
become ordinary OpenUI answers listing the materials made. Delete
`PlainRenderer`. Fold the curate tool descriptions into the contract
descriptions in `agenttools.go` (one set, no per-mode swap) and delete the swap
in `tools.schemas_for`.

**1.3 Ledger and limits**

- Stored shape: `todos`, `next_todo_id`. Drop `requests` and `materials`
  (`STORED_REQUESTS`, `STORED_MATERIALS`). The turn-only `reads` stay.
- `create_ledger {todos}`: drop `body` from the Go schema; strings add todos,
  `{id, todo}` upserts; at most 10 open, refused atomically. Offer it whenever
  the turn can write (`material.create`), not only with the library.
- The write guard (`curate_write` → `ledger_write`) runs on every turn: a todo
  is required only when a ledger exists with open todos; read excerpt ids are
  required whenever library excerpts were read.
- Ledger message: open todos by id, excerpts read this message, the final notice
  when tools are off. It stays outside the message list and compaction.
- Progress for the stall guard: creating the first todo and completing a todo.
- A turn without a ledger: 8 responses, the last with tools off. That covers
  answers and single-item builds; a turn needing more room creates a ledger.
- Once the turn's ledger has todos, the stall guard (5 responses without
  progress, +2 per errored write, at most 9) and 160 tool calls per turn govern
  it, with no response ceiling.
- Every turn: 4 tool calls per response, no capture cap (`captures_per_turn` and
  `CAPY_CAPTURES_PER_TURN` go). `search_workspace` stays one per response.
- Plain names: `CURATE_TOOLS_PER_TURN` → `LEDGER_TOOLS_PER_TURN`,
  `CURATE_STALL_RESPONSES` → `STALL_RESPONSES`, and so on. `TOOLS_PER_TURN` (32)
  goes, since 8 × 4 already bounds a turn without a ledger.
- Delete the 200k window check (`agent._curate_unavailable`). No window test:
  the ops model catalog manages context windows (DeepSeek Flash, DeepSeek Pro and
  GLM today), and it can refuse small windows if that ever matters.

**1.4 Study preferences in the prompt**

Rendered with the ledger message from the requester's saved preferences
(phase 2 stores them; the playground edits them).

| Field | Values | Default |
|---|---|---|
| Explainer style | brief, standard, detailed | standard |
| Practice with each chapter | none, quiz, flashcards, both | quiz |
| Quiz length | questions per chapter quiz | 8 |
| Flashcards per chapter | count | 15 |
| Mini knowledge checks in notes | on, off | on |
| Visual aids in notes | fewer, more | more |

A small mapping in `prompts/` turns these into instructions ("detailed: a full
note per chapter with worked examples; brief: a short note, key points first").
Language is the account locale (`prompts/locale.py`). The request overrides any
field ("make it brief this time"). A main-format field arrives with decks.

**1.5 Open file.** One prompt line: the file or material the learner has open
(title and id), or none.

**1.6 Study progress tool.** `read_study_progress` (read-only; `source.read` and
progress on for the requester in this workspace): done, started and removed item
ids, recent quiz results per chapter (score, date), and chapters with the weakest
review state. The app reads part 1's tables; the playground stubs it from a
fixture.

**1.7 Question-bank search**

A separate tool, so the agent reuses bank questions before generating.
Workspace and library search keep their tools and defaults; the library
experiments stay under Later.

- **Data.** Experiments read a local restore of
  `data/question-bank/backups/bank-2026-10-03-before-round2.dump` (1,098 pilot
  questions in the older format), never the live bank, which UAT reads. Drop
  the local copy when done.
- **Tools.** `list_question_bank(subject?, topic?, offset?)`: the exams and
  subjects, a subject's topics with counts, or a topic's questions as compact
  cards 50 per page; and `read_question` for one question with its worked
  solution and marking scheme. Epo, 2026-10-04: the syllabi are fixed and the
  exams well known, so listing replaces the embedding search (precision@5 0.71
  against keyword 0.38 on maths, but 0.20 on IELTS task types). Revisit search
  when topics outgrow a few pages.
- **Prompt.** With Library on, practice reuses bank questions and library
  exercises before generating new ones.
- Before phase 2: the retrieval service's reader role, the provenance record
  for a bank question copied into a workspace quiz (question id, version,
  author or licence, unremovable like library attribution), and whether bank
  figures are referenced or copied (copying is charged to the workspace owner).
  Copies of later-retracted questions stay.

**1.8 Output formats**

Main explainers are notes and decks. Mindmaps, diagrams and interactive blocks
are assistive blocks inside notes; nothing else is planned.

- **Notes:** markdown with mermaid fences, quiz and flashcards fences as mini
  checks, and interactive fences, following the output rules (1.2) and the
  preferences (1.4).
- **Interactive blocks:** ` ```html-embed ` fences (title and html), under the
  64 KB cap, rendered with phase 3's sandbox, CSP, theme tokens and resize
  script.
- **Decks** (PPTX main explainer, for learners who want something brief or
  lecture-like):
  - Tools: create a deck from an outline (a title and brief per slide), then
    write one slide per call as SVG, grounded in what was just read. A slide
    whose text leaves its module is a tool error carrying the checker's
    message. Use fonts the PPTX runtime ships
    (`src/office-runtime/pptxFonts.ts`).
  - The playground exports the `.pptx` with ppt-master's exporter; Epo
    downloads and opens it.
  - A main-format preference: note, deck, or the agent chooses from explainer
    style (brief leans deck, detailed leans note).
  - Before decks carry them: book figures in a downloadable PPTX under each
    book's licence (placed through the `capture_knowledge_page` guard),
    attribution in the bytes (a credits slide or footer), and where a slide's
    diagram is rasterised (collaboration service, a headless renderer, or the
    client on first open).
  - Designs, 2026-10-04: ppt-master's templates first (slot filling on the
    `presentation_core` layouts, one palette from `ppt169_lora_hu_2021`),
    then, since the example decks looked nothing like ours, ppt-master's own
    method. Its decks come from its skill (`skills/ppt-master/SKILL.md`,
    about 40 reference guides and Python scripts), not its templates: the
    model writes each slide as SVG, `svg_quality_checker.py` refuses text
    outside its module's bounds, and `svg_to_pptx.py` exports native shapes.
    A probe with GLM-5.3-Flash at high reasoning wrote four tangents slides
    in each example's style; Epo picked `ppt169_muelltrennung_de_quick` as the
    default and asked to move the deck tools to this method, with more styles
    and templates later. The slot code and the copied templates are gone;
    ppt-master is a pinned checkout in the ignored `local/ppt-master` (its
    attribution guard refuses partial copies). Skip banana-slides (AGPL,
    slides are images).
  - Live run on the new method, 2026-10-04 (GLM-5.3-Flash high, lab
    target): a complete 10-slide deck in the editorial style with drawn
    diagrams, two cropped book figures and a table, in 12.8 minutes and
    about 160 credits (944k input tokens, almost none cached). For the
    acceptance test: prompt caching on the GLM route, stubbing written SVGs
    in the history, and the ledger fit (each `write_slide` completes the
    todo it names; the tools now ask for one todo per slide, and
    `ledger_write` names every missing field in one refusal). Numbers in
    `lab/playground/DECKS.md`.
  - Found in the live runs: DeepSeek v4 pro captured whole book pages for
    figures (now refused; a picture slot needs a bbox crop) and filled slides
    sparsely in the large template panels (prompt tuning). "Response flagged
    due to safety concern" ended four of eight runs, on both DeepSeek and GLM:
    it is our `response_guard`, not provider moderation. The model wrote its
    next tool call as text (GLM's `<tool_call>` markup) right after a refused
    `create_deck`, while re-sending the long outline. The message misdescribes
    the cause; the playground now records the text (`flagged_text`). Decide at
    the acceptance test whether to rename the error or repair the call.

**1.9 Acceptance.** Saved playground runs covering: a vague request (asks), a
broad request (proposes, then builds several chapters on the ledger), a
single-item request with a file open (builds directly), a question (answers
with citations, no build), Library off (workspace only), a preference change
(brief vs detailed), practice that reuses bank questions, and each output format
including a deck. Epo tunes the prompts against them at the end.

Found before the test (2026-10-04): GLM-5.3-Flash on Relace sends a tool
call's arguments in one piece when they are complete, with no keep-alive, so
a large write (a quiz copying eight IELTS questions with their passages, a
long note) leaves the stream silent for 40 s or more. The interactive idle
bound (`CAPY_INTERACTIVE_PROVIDER_TIMEOUT_S`, 15 s) then failed the turn with
`agent_failed`; two of three live bank turns ended this way at the quiz
write. Fixed with Epo's agreement: a stream must start within 15 s, then may
stay silent for `CAPY_INTERACTIVE_STREAM_IDLE_S` (120 s), and the timeout
names which bound fired. Bank questions are now copied by id
(`copy_questions`, playground-only), so they never stream back at all.
A live "practise my English comprehension" turn then listed IELTS reading,
copied three questions of different task types into a quiz and answered in
five calls and 70k tokens. For the test: GLM once sent its OpenUI answer as
a malformed tool call (the answer text as the tool name, ending
`</arg_value>`); it was refused as an unknown tool and the next response
answered, at the cost of one call. Related to the "Response flagged" leaks.

Deck items for the test (Epo, 2026-10-04; the output looks good):

- The deck prompts: the `deck` skill (`deck.skill_text`: the method,
  `deck.RULES` and the `editorial` style text), the one-line `create_deck` and
  `write_slide` descriptions and `deck.ADDON`. Watch for
  slides refused over ledger fields, todos a grouped write closes early, and
  thin or invented content.
- Cost: the first live deck took 944k input tokens with 35k read from cache
  (about 160 credits). Check whether the GLM route caches the stable prefix
  (system prompt, tools, the style returned by `create_deck`), and whether
  replacing a written slide's SVG in the history with a short stub keeps
  quality while cutting the context. Since 2026-10-05 requests are
  append-only, so rerun a deck and compare.

Skills and prompts for the test (Epo, 2026-10-05):

- The lean base prompt, the `editing` and `workspace_building` skills
  (`prompts/skills.py`) and the
  one-line tool descriptions (contract v12). Watch whether the model reads
  the skill before writing (the writes refuse otherwise, which costs a call)
  and whether answers to plain questions still skip it.
- Caching: per-call `cached_read_tokens` in `run.json`. Captured images ride
  into the next request only, so a capture still breaks the cache once;
  keeping them for the turn would trade context for hits.
- The answer format (`LANG_RULE`, about 2k tokens on every call) is the
  largest part of the base prompt; splitting rich components into a skill
  waits for Epo.

### Phase 2: application

**2.1 Remove curate mode**

- Migration: drop `conversations.curate`.
- Go: delete `curate_mismatch`, `curate_requires_editor` and the curate branch in
  `createConversation`. `chatStreamReq` gets `library bool` and an optional
  `openResourceId`. Grant `library.read` when `library` is true, for any role
  that can chat; writes stay gated by role. The ledger route drops its curate
  check. Delete the frozen/full refusal of curate turns; frozen and full actors
  already lose the write operations.
- Python: `ChatStreamReq.curate` → `library`; `ToolContext.curate` goes; library
  tools are offered when `library.read` is granted and the library is
  configured; `evidence.py` packs library excerpts whenever any were read.
- Frontend (`ChatPanel.tsx`): the curate toggle becomes a Library chip in the
  input, on by default, sent with every turn. Delete `curateToggle.ts` and its
  test, the history chip, the AskUser suppression, the curate placeholder and
  i18n keys, the `chatStream.ts` error mappings, the two MSW scenarios and
  `Conversation.curate`. Send the open file or material id.
- Regenerate the contract (`pnpm gen:openapi`), bump `ContractVersion` to 10 and
  `SUPPORTED_VERSION` with it.

**2.2 Agent notes become real documents**

The collaboration service converts markdown to Plate with the editor's own
deserializer, so agent markdown and pasted markdown produce the same nodes.
Prototype first: bundle `src/features/notes/markdown.ts` and the block helpers
it imports into the collaboration build (a bundling step from the repository
root that resolves the `@/` imports), and add `platejs`, `@platejs/markdown` and
the `remark` packages to the service. Check image size and start-up time before
wiring it in.

- `create_material` (note): Go sends the markdown to the converter and stores the
  result instead of `FromLegacyMarkdown`'s single paragraph.
- `edit_document`: a new `insert_markdown {after_block_id, markdown}` command
  replaces line-per-paragraph `insert_block` for notes.
- Mermaid fences become mermaid nodes. Quiz and flashcards fences become
  mini-check embeds: the converter creates the embedded rows (with
  `parent_material_id`) through Go and writes resolved `material_ref` nodes in
  place of the import's `pending` ones. Interactive fences become the phase 3
  block.
- Delete `server/internal/mdblock`.

**2.3 Output rules in the contract**

- `create_material` takes `chapter_id`, so standalone quizzes and flashcards land
  in the chapter they practise. Kinds stay note, quiz, flashcards, mindmap,
  diagram.
- `list_sources` groups standalone quizzes and flashcards under their chapter,
  so the agent sees which chapters have practice.

**2.4 Study preferences**

- Storage: `users.study_preferences jsonb`, validated by a Go struct with the 1.4
  enums. No per-workspace override.
- API: read with the account, `PATCH` from Settings; generated zod validators.
- Settings: a Study preferences section in the Customizations tab with the
  existing input components and react-hook-form.
- Chat: Go forwards the requester's preferences on each turn; Python renders
  them with the ledger message.
- `/generate` (not done): `GenerateReq` reads the same preferences as defaults; wire the
  `style`/`length`/`format` options that map to preferences and delete the rest.

**2.5 Question-bank search** (done 2026-10-05, Epo's picks)

- The retrieval service holds no bank credentials (1b): it lists and reads
  through Go's `/api/internal/bank/list` and `/read`.
- `copy_questions` is in the contract (v13) with Go's `/api/internal/bank/copy`:
  Go reads the questions from the bank and creates a quiz or appends to one
  through the create and edit writes. A note is not a destination.
- Credits are scoped to the question (Epo): each copy's sources are kept in the
  quiz's provenance under its question id and shown under it, with no bank id,
  revision or footer.
- Figures link to the bank's public URLs (3a); the Go validator accepts quiz
  figure URLs only under `BANK_ASSETS_URL`.

**2.6 Decks**

Decks are made the ppt-master way (`lab/playground/DECKS.md`): the model
writes each slide as SVG, ppt-master's checker (`svg_quality_checker.py`)
refuses a slide whose text leaves its module or the canvas, and its exporter
(`svg_to_pptx.py`) compiles the SVGs into a PPTX of native shapes. The app
stores the PPTX as a file instead of building it with Office commands.

Approved by Epo on 2026-10-05:

- **Where they run:** in the retrieval service image. Pin the whole
  ppt-master checkout (MIT; its attribution guard refuses partial copies) with
  its dependencies in their own virtualenv, and call the two scripts as
  subprocesses. `write_slide` needs the checker inside the agent turn, which
  runs there; the ingest host is a shared queue for every environment, the
  wrong place for a check the model waits on. Slides live in a per-turn
  working directory, so a deck is finished within one turn (the ledger allows
  160 calls).
- **Storing:** once every slide passes, the exporter's bytes go to Go through
  `create_file` (`artifacts/2026-09-17-curate-files-todo.md`), which lands
  first: the upload path, quota charged to the owner, the ingest job so the
  deck is searchable, and `files.provenance`. The style's Sources slide is the
  attribution inside the bytes.
- **Edits:** after export the PPTX is the document. People edit it in the
  PPTX editor; the agent edits text with the existing `replace_text`
  `OfficeCommand`, and anything larger is a new deck. No SVG copy is kept:
  re-exporting from it would discard the person's edits.
- **Figures:** nothing is rasterised. Drawn diagrams export as native shapes;
  book figures are the bbox crops the turn captured, embedded as images. The
  library admits only CC BY, BY-SA, CC0 and public domain
  (`lab/knowledge/scrape.py`), so every crop may be redistributed with its
  credit and licence on the Sources slide; a BY-SA figure stays BY-SA.
- **Fonts:** load Caladea (in `vendor/betteroffice/packages/fonts`) in the
  PPTX viewer (`src/office-runtime/pptxFonts.ts`) for the `editorial` style's
  Cambria titles. The viewer serves only Liberation Sans as Arial today.
- **Cost:** a deck now takes about 47 credits (607k input, 88% cached;
  160 before requests were append-only). Leaving written slide SVGs out of
  the history cost more (Relace caches at the end of each response, so a
  changed response misses) and the model copied the stub into two slides:
  send history unchanged (2026-10-05, `lab/playground/DECKS.md`). The next
  saving is fewer `write_slide` refusals (5 of 13 for missing ledger fields).
- **WASM:** the PPTX editor and viewer grew 34% and 50% at the last upstream
  merge (`todo-office.md`), and decks make a first PPTX view common.

**2.7 Tests and docs**

- Go: a chat turn grants `library.read` by flag, not by conversation; a ledger
  write is accepted for any conversation; `create_ledger` without body;
  markdown conversion of a note with mermaid, quiz and flashcards fences;
  preferences validation.
- Python: one prompt in both Library states; write guard rules (todo only with
  open todos, excerpt ids after library reads); the 8-response ceiling without a
  ledger and the stall guard with one. Delete the curate-only tests in
  `test_agent.py` and `test_retrieval_helpers.py` (mismatch, 200k,
  PlainRenderer).
- Vitest: Library chip default and per-turn body.
- Update `openwiki/agentic-retrieval.md` (curate sections),
  `openwiki/test-catalog.md`, and mark `knowledge-base-plan.md`'s curate design
  as history.

### Phase 3: interactive HTML block

A note block holding an agent-written, self-contained HTML snippet. The agent
side and the sandboxed rendering are tried in the playground (1.8); this phase
is the app element, after a mock round.

- **Element:** void `html_embed {id, html, title?}` with one empty text
  leaf, the chart/graph shape (`blocks/plugins.ts`). Register it in
  `document.ts` (type and validation), `blocks/plugins.ts`, `elements.tsx`, and
  the static node components and plugins in `src/features/materials/`.
  Container: the media frame (mock A). The source dialog edits the snippet
  (Epo, 2026-10-04), with Save and the 64 KB cap.
- **Markdown:** an ` ```html-embed ` fence (`blocks/shared.ts`
  `CUSTOM_BLOCK_LANGS`, a `markdown.ts` serialize rule), which the 2.2 converter
  builds.
- **Rendering:** `<iframe sandbox="allow-scripts">`, never
  `allow-same-origin`, forms, popups, modals or top navigation, loading a fixed
  wrapper page from a separate site: its own registrable domain, so browsers
  give it its own process and a runaway script cannot freeze the app's tab
  (`*.capynotebook.com` would share the app's process). A Cloudflare Pages or
  Workers hostname is free and counts as its own site (`pages.dev` and
  `workers.dev` are public suffixes); a second domain costs about $10 a year.
  The wrapper sends its CSP as a header (`default-src 'none'; script-src
  'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src
  data:`), receives the snippet and theme tokens by `postMessage`, and reports
  its height. Messages count only when `event.source` is that frame, and only
  `{type: 'resize', height}`. A visible label on the frame marks it as a block.
- **Deploy:** a Cloudflare Pages project (Epo prefers Pages; the wrapper is one
  static file). The wrapper and a `_headers` file live in the repo, and the
  reusable `deploy-environment.yml` uploads them with `wrangler pages deploy`
  in the job that already deploys the Office and SPA Workers, at the same
  pinned revision and before the SPA, so promotion to production carries it
  too. One project on a free `pages.dev` hostname, with the production branch
  and a `uat` branch alias (Epo, 2026-10-05); the SPA reads the frame's origin from the deployment
  configuration. First setup by hand in `deployment-runbook.md`: create the
  project and give the deploy token Pages edit permission. Local development
  serves the wrapper from `127.0.0.1` while the app runs on `localhost`: a
  different port alone is the same site.
- **Limits:** 64 KB for `html`, checked in Go
  `materialdoc` and the collaboration validator.
- **Export:** `export/render.ts` handles the type (it throws on unknown types).
  No fallback (Epo, 2026-10-05: the chat's text answer explains); what export
  shows in its place is open. Export never runs the snippet; the rasteriser in
  `figures.tsx` uses an unsandboxed same-origin iframe and must not receive it.
- **Indexing:** skipped by retrieval like mermaid (`document.go`).
- **Agent guidance** in the tool description: self-contained, no network, use the
  provided theme variables, keep it small. Interactive
  results do not feed progress.
- **Tests:** Go and collaboration caps; export of a note with the block; a vitest
  that the iframe carries exactly `allow-scripts`.

---

## Later

Not scheduled. Each item lists what to decide before it starts.

### Deck templates and styling preferences

Epo, 2026-10-04. More deck styles (each a folder in
`lab/playground/deck-styles/`, `DECKS.md` "Adding a style") and templates:
ppt-master's structured layouts with Masters and slots, including a school's
own template imported from a `.pptx` (`workflows/create-template.md`). Users
choose: a style per deck or a default in study preferences, and their own
colours or fonts. Decide how a choice reaches `create_deck` (an enum from
`deck.styles()`), whether user colours override a style's tokens or make a
new style, and which faces the PPTX viewer must serve.

### Screening interactive blocks

Epo, 2026-10-04: use Jev (typesafe.ai's model, already used for grading and
question screening) to check whether an interactive snippet carries deceiving
content, such as fake sign-in or login buttons and phishing, before other
readers see it. Decide when it runs (on save or on first view by someone
else), what a flagged block shows instead (a notice), and who
pays for the call.

### Review session polish

Epo, 2026-10-04: the end-of-session summary and the size of questions in a
review session come back later. Until then the session end is the round 2
mock ("20 reviewed", Done, Review 20 more).

### Question-bank progress

The bank page session builds learners answering on `/bank` and bank mistake
review on part 1's FSRS code. Separate from workspaces: grouped by topic and
exam, per-topic mistake review.

- **Storage:** `bank_review_states` in the app database keyed by user and bank
  question id (no foreign key across databases), with the topic id copied in for
  grouping and a content hash that resets state on edit.
- **Retraction:** published bank questions are retracted with a flag and never
  hard-deleted, so progress ids stay valid; review skips retracted questions.
  This supersedes "operators delete as owner" (2026-09-27) when it lands.
- **Where:** `/bank`. Check answer records the attempt; the topic list shows
  right and wrong marks.

### Offline review

- **Source of truth:** the append-only review log; server state is a replay in
  time order, so two devices merge.
- **Scheduling offline:** a client copy of FSRS (`ts-fsrs`) with the same
  parameters and version, or the client records grades and orders its queue
  locally until sync.
- **What to download:** question and card content plus images for the sets in
  progress, and the storage that takes on a phone.
- **Clock skew** between devices when ordering the log.

### Study suggestions

A small, optional suggestion (for example a dashboard banner) once progress has
data. No due dates, deadlines or "study this today" pressure anywhere.

### Agent loop quality

From the curate experiments of 2026-09-21 to 09-23 (`bench/rag/reports/`): keep
the current retrieval defaults; the compact twenty-preview library search stays
experimental (fewer searches, no clear cost or quality gain); Ollama and Tencent
return a tool call after tools are removed. Retarget these to the single build
flow once part 2 lands. Use separate unseen questions after tuning and record
material completion, evidence support, retrieval fit and latency and token cost.

- [ ] Longer follow-ups and material edits through real in-turn compaction.
  Offline checks cover evidence invalidation and the 160-call cap; the live
  cases reached neither.
- [ ] Match requested generality across domains: general statistics against
  R-dependent instructions, school-specific against general leadership, and
  method, population, jurisdiction, time and unit restrictions. Use the
  excerpt's reviewed scope, tell incidental examples from necessary conditions,
  and treat missing metadata as unknown. Keep library retrieval tunable apart
  from workspace retrieval.
- [ ] A bounded draft-check-and-repair pass against the passages actually read.
  Start with the Athens note's unsupported institutional claims and leadership
  overgeneralisations, beside supported controls. Measure missed errors and
  wrongly rejected supported claims.
- [ ] Trust Sol-reviewed library text while checking generated numbers,
  formulas and tables against the evidence read. Capture only for missing visual
  detail, unresolved extraction or contradictions.
- [ ] Research that ends without a material or a clear explanation: test
  final-answer steering and provider handling of the tools-off phase on Ollama
  and Tencent, with insufficient-evidence controls. Keep gaps visible instead of
  forcing a note. Recheck published versions before repairing context links
  whose target lacks the promised facts (business-statistics excerpt 261 → 262).

### Duplicate examples in library search

Lower priority until crowded results cause a final-material failure the loop
does not recover from. Similar topic or difficulty does not make two passages
equivalent. Research: `bench/rag/reports/2026-09-21-knowledge-duplicate-strategy.md`
and `2026-09-21-retrieval-improvement-directions.md` (exact cross-book text is
1.7% of chunks, mostly forks).

- [ ] A contrast set around the repeated Elmhurst example that keeps different
  datasets, variables, populations, units and simple versus multiple regression
  apart. Exercise/solution pairs, split continuations, concept versus R
  implementation and different derivations are not duplicates by default.
- [ ] Conservative exact-text grouping first. Embeddings and text overlap only
  nominate candidates; an offline reviewer classifies ambiguous pairs from the
  passages (equivalent, complementary, different variant, insufficient
  evidence).
- [ ] Group confirmed equivalents in results while keeping every source and
  citation; pick a representative for the request and refill the result count.
  No blanket one-result-per-book rule. MMR only if repetition remains.
- [ ] Measure false merges first, repeated result positions second, answer
  coverage third, then reviewer and latency cost. Bind accepted pairs to source
  versions and text hashes; evaluate on held-out pairs. Deduplication cannot
  repair incomplete extraction.
