# Plan: anonymous quizzes and flashcards, Jev grading

Date: 2026-10-02. Status: implemented 2026-10-02 (uncommitted at the time of
writing); the Jev request contract follows
`bench/grading/reports/2026-10-02-jev-production-contract.md`. Durable
behaviour is documented in `openwiki/authorization-permissions-lifecycles.md`
(Anonymous quizzes and flashcards), `openwiki/observability-metering.md` and
`openwiki/question-bank.md`; this file keeps the plan's reasoning.
Decisions: `human/authorization-permissions-lifecycles.md`,
`human/observability-metering.md` and `human/question-bank.md` (2026-10-02
entries). The question bank is out of scope.

## Goal

Signed-out visitors open a shared standalone quiz or flashcard set from a signed
link, see its images, take the quiz (open parts graded by Jev) or study the
cards. Their attempts and reviews live only in that browser's IndexedDB.
Signed-in users keep server-stored attempts; their open parts move to Jev too.

## Decisions

- **Scope:** standalone materials only (`workspace_id IS NULL`,
  `parent_material_id IS NULL`, `privacy IN ('link','public')`, kind `quiz` or
  `flashcards`). Workspace materials cannot carry their own privacy
  (`materials_workspace_visibility_check`, `0001_init.sql:386`), and anonymous
  visitors cannot open workspaces or notes, so workspace and embedded
  materials stay signed-in only.
- **Local data stays local.** Nothing is imported into an account on sign-in.
- **Anonymous flashcards keep `ts-fsrs` in the browser** with an append-only
  local review log. `todo-learning.md` moves signed-in FSRS to Go but no
  longer deletes `ts-fsrs`.
- **Jev usage is recorded, never charged,** for signed-in and anonymous users.
- **Anonymous identity:** a salted hash of the client IP enforces caps; a
  random id kept in IndexedDB is recorded for reporting. No fingerprinting.
- **Caps are enforced and reported:** a per-IP-hash daily cap and a global
  daily cap on anonymous grading.

## Current state

- Only `GET /api/public/workspaces/{id}/summary` is anonymous
  (`server.go:189`, `auth/middleware.go:161`); store access helpers return
  `ErrNotFound` for an empty user (`share.go:73,96,190`).
- `/share/quizzes/$id` and `/share/flashcards/$id` are bare ids wrapped in
  `AuthGate` (`RouteComponents.tsx:31-45`); the Worker never sees `/share/*`.
- Workspace summary links are signed by Go (`store/share_link.go`) and checked
  by the Worker (`src/lib/shareLink.ts`, `workers/site/handler.ts:135`); Go does
  not re-check.
- The browser grades closed parts; open parts call `POST /api/quiz-grade` once
  per part, sequentially, through Python to the DeepSeek `quiz` slot. The
  endpoint grades whatever prompt and scheme the client sends. Results show only
  after the attempt save succeeds (`QuizAttempt.tsx:155-207`).
- Question images resolve through authenticated
  `GET /api/editor-assets/{id}/resolve`. Flashcard faces are text only.
- The only IndexedDB code is `src/features/files/sourceDraft.ts`.

## 1. Signed links

- Generalise `store.SharePath(secret, id)` to any `ws_` or `mat_` id (the id
  prefix already separates types; the `share:v1:` message stays). Quiz and
  flashcard API models gain `sharePath` for standalone link/public materials.
  Share links become `/share/quizzes/{id}.{sig}` and
  `/share/flashcards/{id}.{sig}`; `ShareDialog`, `Create.tsx` and
  `FlashcardStudy.tsx` use `sharePath`. Old bare links stop working (no
  production data).
- `src/lib/shareLink.ts` accepts `mat_` ids; Go gains the matching verifier.
  Extend the Go/TS cross-language test vector.

## 2. Worker `/p/*` routes (`workers/site`)

Add `/p/*` to `run_worker_first`. Every route verifies the signature first and
returns 404 for forged or unsigned refs without calling the origin.

| Route | Origin call | Cache |
| --- | --- | --- |
| `GET /p/quizzes/{ref}` | `GET /api/public/quizzes/{ref}` | `s-maxage=300`, keyed by id |
| `GET /p/flashcards/{ref}` | `GET /api/public/flashcards/{ref}` (set and cards) | `s-maxage=300` |
| `GET /p/quizzes/{ref}/assets/{assetId}` | `GET /api/public/quizzes/{ref}/assets/{assetId}` → presigned URL; the Worker fetches the bytes | `s-maxage=300` |

Link-privacy responses carry `X-Robots-Tag: noindex`. Making a material
private takes up to five minutes to clear the edge cache, as summaries do.
Grading is not a Worker route: on UAT (2026-10-02) Worker subrequests reached
the API without the visitor's IP, so every visitor shared one per-IP budget.
The browser posts `/api/public/quizzes/{ref}/grade` directly instead.

## 3. Go public endpoints

- `/api/public/quizzes/` and `/api/public/flashcards/` join `PublicReadPrefix`;
  the grade POST is admitted by an explicit public route rule.
- Each handler re-verifies the signature (the API hostname is public) and loads
  through one SQL projection with the scope rule above plus an active,
  non-deleted, non-suspended owner and `trashed_at IS NULL`.
- The quiz payload keeps answer keys and marking schemes: the browser grades
  closed parts, as it already does for signed-in link viewers.
- The asset handler requires the asset to belong to the material
  (`editor_assets.material_id`) and to appear in its content
  (`questions.AssetIDs`), then presigns it.
- Rate limit class `anonymous` already keys by IP; grading gets its own class
  (section 6).

## 4. Frontend

- Share routes drop `AuthGate`. The route param is the signed ref. Signed in,
  the page uses the existing authenticated queries by id; signed out, it uses
  public query functions against `/p/...`.
- `AssetFigure` takes its URL from a small context: authenticated resolve by
  default, `/p/quizzes/{ref}/assets/{id}` on the public page.
- Anonymous quiz: grade (closed parts locally, open parts via
  `/p/.../grade`), show the result immediately, store the attempt locally. The
  share page lists this browser's past attempts at that quiz. Signed-in
  attempts still save to the server; the result view no longer waits on the
  save to show the grade.
- Anonymous flashcards: study with `ts-fsrs`, append each rating to the local
  log, derive per-card state from it.
- A sign-in prompt explains that progress stays in this browser.

### Local store: `src/lib/localDb.ts`

One IndexedDB database `capy-local`, version 1, raw IndexedDB in the
`sourceDraft.ts` style:

| Store | Key | Holds |
| --- | --- | --- |
| `quizAttempts` | `id`, index `quizId` | snapshot, answers, correct, total, takenAt |
| `cardReviews` | auto-increment, index `setId` | setId, cardId, rating, reviewedAt |
| `cardStates` | `[setId, cardId]` | derived ts-fsrs card |
| `meta` | key | the anonymous reporting id |

Later offline work adds stores in new versions. When IndexedDB is unavailable
(some private modes), the page says progress cannot be saved in this browser
and the session continues in memory.

## 5. Jev grading (contract pending the benchmark)

- New `server/internal/jev`: one POST to `https://api.typesafe.ai/v1/systemone`
  with `JEV_TYPESAFE_API_KEY`, a timeout and no retry (the user retries).
  The key joins `deploy/env-manifest.json`, the env examples and compose files.
- Grading is by reference. Signed in: `POST /api/quizzes/{id}/grade`; anonymous:
  the public twin. Body `{parts: [{partId, answer}]}` for one attempt. The
  server loads the stored quiz, skips blank answers, sends each open part's
  marking items to Jev with bounded concurrency, and returns per-part
  `{awarded, itemAwards}`. Any Jev failure fails the request.
- Each marking item earns 0, 0.5 or 1; the part's `awarded` is the sum. The
  attempt snapshot stores `itemAwards: number[]` on open parts and drops
  `awardReason` (Jev returns no text). Review shows one mark per item.
- Removed: `quiz_grade.go`, pipeline `/quiz-grade` (`retrieve/service.py`,
  `retrieve/quiz_grade.py`, `prompts/quiz.py`), the `quiz` model slot rows and
  enum value (migration), `cloudGrade.ts`, `judge.ts`, and the unused browser
  grader (`src/llm-runtime`, `llm-runtime.html`, `@wllama/wllama`, its framing
  headers and deploy step).
- Author warning: `POST /api/questions/computation-check` (signed in) takes one
  open part's text and marking items, asks Jev the benchmark's computation
  question, and returns `{computational, probability}`. The question dialog
  shows a non-blocking warning when an open part is saved.

## 6. Usage, caps and abuse controls

- **Signed in:** one `usage_events` row per grade request: surface `quiz`,
  provider `typesafe`, the resolved Jev model, input tokens, cost, no credit
  change.
- **Anonymous:** new `anonymous_grading_usage` table (`usage_events` requires an
  actor): day, `ip_hash` (HMAC of the IP with a server secret), `local_id`,
  graded parts, Jev calls, input tokens, cost. Rows older than 30 days are
  deleted.
- **Caps:** per `ip_hash` per day N graded parts, generous because classrooms
  share an IP; a global daily cap on anonymous Jev calls. Over either, grading
  returns a typed error and the page asks the visitor to sign in. Closed parts
  still grade locally.
- **Other controls:** forged links stop at the edge and again in Go; public
  reads are edge-cached; grading needs a real part of a public quiz, so the
  endpoint is not a general grader; per-part answer and per-request part caps;
  dedicated anonymous grading rate-limit class plus the existing edge rule.
  Turnstile only if abuse appears.

Signed-off numbers: 300 graded parts per IP hash per day, 50,000 per day
overall, 5,000-character answers, at most 20 open parts per grade request, 30
days of anonymous usage rows. User quizzes are bounded at 100 parts, 7 parts
per question, 5 marking items per part and 20 open parts.

## 7. Interaction with `todo-learning.md`

Independent of it, except that plan keeps `ts-fsrs` for local study and its
quiz attempt flow adopts by-reference Jev grading and `itemAwards`. Either plan
can land first.

## Tests

- Go: signature verify for `mat_`; public projections refuse private,
  workspace, embedded, trashed and suspended-owner materials; asset membership;
  grade by reference rejects unknown parts; caps; Jev client decode and error
  paths with a stub server; usage rows.
- Worker: forged refs never reach the fetcher; cache keys; POST passthrough.
- Frontend: `localDb` round trips; anonymous attempt flow with MSW; FSRS log
  derivation.
- e2e: `quiz-sharing.spec.ts` and `flashcards-sharing.spec.ts` change from
  "anonymous denied" to anonymous attempt and study.
