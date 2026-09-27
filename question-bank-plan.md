# Question bank implementation plan

Status 2026-09-27: phases 1–7 are implemented in the working tree; a further
UI comparison against the approved mocks has been rechecked after fixes. The shared bank
database and separate public/private B2 buckets are provisioned. The pilot uses
verified catalogs with 18 HKDSE and 11 IELTS topics, and fresh Astra medium
subagents at every generation stage. Four topics have passed blind solving,
visual review and copy checks, with 200 questions published. Another 150
questions are rendered and Go-valid; the other 22 topics have admitted
references/styles and frozen writer packets. Epo requested wrap-up after this
round; all subagents and publication processes have finished. Resume details are
in [question-bank-handoff.md](question-bank-handoff.md). Verification and
operational setup are documented in `openwiki/question-bank.md` and the ignored
pilot run records.
Epo's decisions are recorded in `human/agentic-retrieval.md`,
`human/authorization-permissions-lifecycles.md`, `human/frontend/plate-editor.md`
and `human/miscellaneous.md`. Deferred product work remains in
`todo-question-bank.md`.

September 27 decisions: bank asset uploads use an authenticated API endpoint
with environment credentials as well as the local publisher; editing retains
review; stale content saves are rejected; embedded materials refetch on every
view/edit open. Matching uses a separate choice pool. Quantity answers use an
authored fixed unit and value-only entry, without unit conversion. Jev grades
non-computational open answers, with its context and per-item scoring contract
still under evaluation.
The approved responsive layout is A throughout, with sequential navigation
and no redundant exam/subject heading above the question. The
[interactive preview](https://faflav2lddl1.postplan.dev) and
`artifacts/2026-09-27-question-bank-responsive-mocks.html` include the bank,
question dialog, text and graph editors.

Reviewers: check the plan against the recorded decisions and the code, not
against taste. A step that contradicts a decision in `human/` is a finding.

## Goal

1. A second knowledge base beside the textbook library: exam syllabi (exam,
   subject, topic) and large sets of original questions per topic, generated on
   the developer PC. Pilot: HKDSE Mathematics Compulsory Part and IELTS Academic
   Reading, about 50 questions per topic.
2. One question format for bank questions and the app's own quizzes: stem
   blocks plus parts, with formulas, charts, graphs, tables and images.
3. Question editing that handles formulas, charts and graphs properly: a
   question dialog with per-block editors, MathLive formulas in place of
   `window.prompt`, and chart and graph embeds in notes.
4. An in-app bank page where anyone signed in reads questions and bank editors
   review, edit and comment.

## Out of scope

Tracked in `todo-question-bank.md` or decided as later work:

- Studying from the bank: answer inputs on the bank page, Check answer,
  learning plans, correct/incorrect list icons, the "2 correct · 2 to retry"
  line. The bank page ships read-only for learners until this is designed.
- Per-answer-type control redesign, and whether seven types are too many.
- Production per-item Jev grading. The follow-up benchmark covers context,
  partial credit and computational-question detection before rollout.
- IELTS Listening (needs TTS), library-sourced subjects, GeoGebra, image or
  graph options in multiple choice.
- A production tunnel. Nothing here writes to an app database from the PC.

## Implemented structure

- Quiz materials remain Plate/Yjs documents. Each void `quiz_question` keeps
  its canonical question in a validated `question` attribute and one empty leaf.
  Go, the collaboration service and the browser enforce the same fixtures and
  generated limits. Legacy question payloads are rejected.
- All seven answer types use stem/parts. Parts own stable IDs, blocks, answer,
  plain marking items and worked solution. Marks are the marking-item count.
  Attempts retain their grading snapshot; mistakes retain authored fields only.
- `QuestionDialog` supplies block/part editors and a learner preview. The quiz
  edit page and bank share it. Notes use MathLive and the same chart/graph
  editors, with a shared floating toolbar. The old embedded QuizDialog is gone.
- Authored quiz and flashcard writes require the revision read when editing
  began. The collaboration service checks revision and pending projections
  under the material lock. Every view/edit open fetches current content.
- Bank reads, editor saves/review/upload/comment, dedicated database roles,
  source attribution, configuration and backup scripts are implemented. Pools
  connect lazily; missing bank configuration does not stop the rest of the app.
- `lab/questions` stages generation and review artifacts locally. The Go
  publisher validates evidence, resolves historical source references, uploads
  immutable assets and inserts without overwriting previously published items.
- User quizzes and notes keep bounded static graph SVG in their documents.
  Bank graphs/images use public content-hashed URLs written through the API or
  publisher. No browser receives bucket credentials.

## Question format

One shape for bank questions, quiz materials, attempt snapshots, generation and
agent tools. TypeScript source of truth in `src/features/questions/types.ts`,
re-exported through `src/api/types.ts` where the wire types override
`questions`.

```ts
type TextBlock = { type: 'text'; text: string; label?: string };
// text: plain text; `$…$` inline math, `$$…$$` display math, `\$` a dollar
// sign, a blank line starts a paragraph. label: paragraph letter (IELTS A, B…).

type ChartBlock = {
  type: 'chart';
  kind: 'bar' | 'hbar' | 'line' | 'area' | 'pie' | 'stacked';
  title: string; unit?: string; labels: string[];
  series: { name: string; values: number[] }[];
  xTitle?: string; yTitle?: string; gridlines?: 'normal' | 'fine';
  showValues?: boolean; // the data table under the chart, off by default
};

type GraphBlock = {
  type: 'graph';
  board: { bbox: [number, number, number, number]; axis: boolean; grid: boolean };
  elements: GraphElement[]; // whitelist below
  image: { url: string } | { svg: string }; // bank: public URL; user content: inline SVG
  width: number; height: number; description: string; attribution?: string;
};
type GraphElement =
  | { type: 'functiongraph'; id: string; term: string; domain?: [number, number]; dash?: boolean; hidden?: boolean }
  | { type: 'point'; id: string; name?: string; coords: [number, number]; hidden?: boolean }
  | { type: 'line' | 'segment'; id: string; points: [string, string]; dash?: boolean; hidden?: boolean }
  | { type: 'circle'; id: string; center: string; radius: number; dash?: boolean; hidden?: boolean }
  | { type: 'text'; id: string; coords: [number, number]; text: string; hidden?: boolean };

type TableBlock = { type: 'table'; header: boolean; rows: string[][] }; // cells are text with math
type ImageBlock = { type: 'image'; url: string; width: number; height: number; description: string; attribution?: string };
type Block = TextBlock | ChartBlock | GraphBlock | TableBlock | ImageBlock;

type Answer =
  | { type: 'mcq' | 'multi'; options: string[]; correct: number[] } // options: text with math only
  | { type: 'boolean'; correct: boolean }
  | { type: 'short'; accepted: string[]; unit?: string } // authored fixed unit; values only
  | { type: 'matching'; options: string[]; pairs: { left: string; right: number }[] } // right: index in options
  | { type: 'ordering'; items: string[] } // stored in the correct order
  | { type: 'open'; accepted: string[]; hints: string[] };

type Part = { id: string; blocks: Block[]; answer: Answer; markscheme: string[]; solution: Block[] };

type Question = {
  id: string;
  stem: Block[];
  parts: Part[]; // at least one
  layout: 'paper' | 'split'; // 1A or 1C
  labels: 'letters' | 'numbers'; // (a) (b) or 1 2
  level?: 'recall' | 'application' | 'analysis';
};
```

What changes from today, with no backward compatibility:

- `prompt` becomes `stem` plus part `blocks`; a one-part question has an empty
  or short stem and one part.
- `points` goes: a part's marks are `markscheme.length` (at least one item).
  `rubrics` becomes `markscheme`; the question and option `explanation` fields
  become the part's `solution` blocks.
- The `{ value }` wrappers on options, accepted answers, hints and ordering
  items go; they were only there for form keys.
- `level` is optional everywhere.
- Snapshot-only fields move to the part: `awarded`, `awardReason`.
- Attempt `answers` are keyed by part id.
- `sources` is not in the question; bank rows keep it in a column, and quiz
  materials keep using material `provenance`.
- Matching stores the complete choice pool in `options`, including unused
  distractors; each correct pair points to an option index. More than one
  left item may point to the same choice when the exam permits reuse.
  Shuffling preserves the original option identity. Learners receive the
  left items and complete pool, never the correct pair indices.
- Quantity short answers carry one required `unit` selected by the author.
  The prompt and non-editable input suffix show that unit; learner input and
  `accepted` contain values only, all expressed in that unit. Reject unit
  text instead of stripping it, interpreting another unit or converting it.
  Text blanks and unitless quantities omit the field.

Validation, one implementation per runtime, all checked by shared fixtures:

- Go `server/internal/questions` (new package): `Validate(q, policy)`. The
  bank policy requires image and graph URLs under `BANK_ASSETS_URL`, rejects
  inline SVG and requires a non-empty `solution` on every part. The quiz
  policy rejects image blocks and URL graphs, accepts inline SVG up to 256 KiB
  passing the static SVG allowlist, and allows an empty solution.
- TypeScript `src/features/questions/validation.ts` for the editor and
  `document.ts`; `collaboration/src/questions.ts` mirrors Go (same "keep in
  sync" note as `materialDocument.ts`).
- Shared fixtures: `server/internal/questions/testdata/*.json` valid and
  invalid cases, loaded by the Go test, the frontend Vitest and the
  collaboration Vitest, so the three validators cannot drift silently.
- Matching fixtures cover unused choices, reusable choices and invalid
  correct indices. Fixed-unit fixtures cover the authored unit, value-only
  accepted answers and rejection of learner-supplied units.
- Limits: 40 blocks per stem, part and solution; 26 parts; text block 12,000
  characters (an IELTS passage fits in one paragraph block per letter); table
  30 rows by 10 columns; chart 50 labels by 8 series; graph 60 elements, term
  200 characters from a JessieCode-safe character set; markscheme 20 items of
  1,000 characters. Constants live in `server/internal/fieldlimits` and are
  exported to TypeScript by the existing `-typescript-limits` generator.

## Rendering

All view code is static and small. Nothing below imports Plate, MathLive or
JSXGraph.

- `src/features/questions/TextView.tsx`: splits text on the math delimiters and
  renders math with the existing lazy `src/features/materials/Katex.tsx`.
  `parseMathText` is a pure function with its own tests (escapes, unclosed
  delimiters render as text, display math on its own line).
- Chart: move the drawing out of `ChatChart.tsx` into
  `src/components/charts/CategoryChart.tsx` (and the scatter drawing if it
  moves cleanly) taking plain `{ kind, title, unit, labels, series }` plus the
  optional axis titles, fine gridlines and values table. `ChatChart.tsx` keeps
  unpacking parser elements, its frame, citations and `InvalidChartContext`;
  the OpenUI catalog in `chat/schema.ts` does not change. Question and note
  charts render the drawing with a title and legend and no citation footer.
- Graph: `<img>` of the URL or of a `data:image/svg+xml` URL on a white
  background, `alt` from `description`. SVG is never inlined into the DOM.
- Table: plain HTML table, optional header row, cells through `TextView`.
- Image: `<img>` at natural size capped at the column width, attribution in
  small muted text beneath.
- `QuestionView` (1A): number, stem and total marks on the first line; parts in
  label, content and marks columns; no frames; `layout: 'split'` renders the
  1C split with the stem left and parts right.
- `QuestionReview` (after submitting): each part's score as plain text in the
  marks column, marking scheme first, then "Your answer" under a small heading,
  then the worked solution collapsed. Until per-item grading exists, closed
  parts show every item as 1 or 0 with the part result, and open parts list
  the items without per-item awards.
- `SourcesFooter`: bank questions render `sources` through the same line
  format as `MaterialAttributionFooter`.

## Storage of quiz questions in materials

Implemented: a `quiz_question` element is a void holding the
question as one attribute:

```json
{ "type": "quiz_question", "id": "q1", "question": { "stem": [], "parts": [], "layout": "paper", "labels": "letters" }, "children": [{ "text": "" }] }
```

- `quiz_prompt`, `quiz_option` and `quiz_explanation` nodes and their
  conversion code go (`quizQuestionNode`, `questionOptions`,
  `quizQuestionElementToQuestion`, `ExtractQuiz` shrink to wrapping and
  unwrapping). Validators call the question validator on the attribute.
- The empty `quiz` sentinel keeps its `id`; `timeLimitMin` is removed.
- Quiz questions stop being editable as Plate text in the collaborative editor;
  every quiz editing path goes through the question dialog, which 5A already
  requires. The static renderer and the collaborative editor both render
  `QuestionView`.
- `rejectOpaque` keeps refusing `questions`, `cards` and `code`; the new
  attribute is `question` and is validated, not opaque.

The alternative is a node type per block, part and answer, which keeps
questions editable as Plate nodes but needs about a dozen new node types in
three validators and two converters for editing nobody asked for.

## Question editing UI

New dependencies, loaded only by editor chunks: `mathlive` (MIT) and
`jsxgraph` (MIT or LGPL). Configure MathLive's `fontsDirectory` to Vite-served
assets and switch its sounds off. Pin JSXGraph so the headless publish render
uses the same version as the browser editor.

- `src/features/questions/editor/QuestionDialog.tsx` (2B): `SimpleDialog`
  with the outline on the left and a `QuestionView` preview on the right.
  - Outline rows are stem blocks, parts and each part's "Worked solution · N
    blocks"; whole-row native drag with the FilesPanel accent insertion line
    (copy `insertionLine` and the before/after midpoint rule, and call
    `stopPropagation` in `onDragStart` as FilesPanel does). No handles.
  - ⋮ per row; a part's menu has Answer type (submenu of the seven types),
    Answer and marking scheme, Move up, Move down, Remove part.
  - One + at the top right opens a small popover that adds a block or a part
    below the selected row.
  - The selected block gets the shared block toolbar above it in the preview:
    edit, replace, move, duplicate, delete.
  - Part rows show marks read-only from the scheme item count.
  - Header shows topic context for bank questions; footer "Question N
    of M", Cancel, Save.
  - The question-level settings `layout` and `labels` sit in a ⋮ on the
    outline header.
  - Clicking a row, or Edit on the toolbar, swaps the dialog body to that
    block's editor with a back link. A second dialog never opens.
  - The dialog takes `question` and `onSave(question)`. The quiz page's
    callback updates its draft; the bank page's callback PUTs the question.
    Both retain the loaded content version and keep the draft on a rejected
    stale save. A bank graph export or replacement image uploads through the
    bank asset endpoint before the question stores its returned public URL.
- Block editors (part 3), each with Remove block (danger-light) beside Save:
  - Text: a minimal Plate editor with only paragraphs and inline equations,
    serialised to and from the `$…$` text format. It shares the MathLive
    inline equation component with notes. Toolbar: Formula, ∑, ∫, lim, ⁿ√,
    logₐ, →, More. This is not the note editor; none of its plugins load.
  - Chart: Chart type dropdown, Title, Unit, X axis title, Y axis title, a data
    grid with a grey header row (Label plus one column per series, Add row),
    live chart, and a collapsed Advanced section (Gridlines: Normal or Fine,
    Show the data table under the chart). Advanced uses Radix `Collapsible`
    from the `radix-ui` umbrella, wrapped once in `src/components/ui`.
  - Graph: JSXGraph board, one + popover (Function, Point, Line, Segment,
    Circle, Label), an element list with a ⋮ per element (hide, style,
    delete), x range, y range and Grid. Save exports the SVG from the board.
    Terms go through JessieCode, never `eval`. The board has no rounded border.
  - Table: flat toolbar (Header row, Row +/−, Column +/−), cells edited in
    place with the Text editor mounted only in the focused cell. No merged
    cells.
  - Image (bank questions only): Replace, Description,
    Attribution. No display options.
  - Part settings: Answer type dropdown, the answer for that type (reusing the
    current `QuizForm` controls per type until the per-type redesign),
    marking scheme items with Add item, Remove part.
- `QuizForm.tsx`, its test and `createBlankQuestion`'s old shape are replaced
  by the dialog and a new blank-question factory.

Shared floating toolbar:

- `src/components/ui/BlockToolbar.tsx`: `role="toolbar"`, icon-only
  `ToolbarButton`s at the existing 16px icon size, one separator component,
  `PopupMotion`, one small radius and `shadow-pop`, anchored to an element
  with the Radix popover setup the table toolbar uses.
- Consumers: `TableFloatingToolbar`, the columns toolbar, the note embed
  toolbar, the question dialog preview toolbar, and the flashcards study-block
  toolbar. `FloatingActionButton` moves here, which removes the circular import.
- The text-selection toolbar (`FloatingToolbar.tsx`) and link toolbar keep
  their floating-ui positioning and adopt the same container styles.

## Quiz pages

- `/quizzes/$quizId/edit` gets `staticData: { hideSidebar: true }` and a
  `createRoute` entry like WorkspaceOpen. The page (5A) keeps its
  `PanelWithInvertedRadius` and `PageHeader` with TopInsetBar in the notch,
  Back and Save; questions render with `QuestionView`, each with Edit; Add
  question opens the dialog with a blank question.
- Embedded quizzes: Edit on the note's quiz card (`MaterialRefCard`,
  `MaterialRefElement.editQuiz`) navigates to the quiz page. The quiz slash
  command creates the embedded quiz with one blank question and inserts the
  card as today, without a dialog. `QuizDialog` and the quiz branches of
  `dialogContext.tsx` go; flashcards keep their dialog.
- Every explicit open of an embedded material for viewing or editing issues
  a fresh request for that material, even when its cached query is fresh.
  This applies to quiz and flashcard views, dialogs and edit-page navigation.
  Initialize the editing draft and its version from that response. A failed
  refresh shows the existing error/retry UI and does not initialize an edit
  from stale cache. Opening the parent note alone does not fetch every embed.
- Standalone quizzes in the workspace render `QuestionView` in both modes;
  editing links to the quiz page.
- `QuizAttempt` renders one question at a time (1A or 1C by `layout`, "3 / 10",
  Previous and Next without a divider) with the existing per-type inputs per
  part; `AttemptResult` renders `QuestionReview`.
- The unenforced `timeLimitMin` field and its editor are removed from the contract.
- Reject stale quiz and flashcard authored-content saves in standalone,
  workspace and embedded forms. Carry the version loaded with the draft to
  the authoritative write boundary, retaining existing Yjs guards. Existing
  server checks compare state read at save time and do not detect a browser
  draft that went stale earlier. Flashcard study state stays separate.

## Grading until per-item grading

- Epo's grading direction: open/essay answers are for non-computational
  questions and use text-only Jev; computational questions use deterministic
  answer types such as MCQ and fuzzy fill-in. Generation instructions apply
  this rule. Benchmark a Jev computation check for bank review/editing before
  choosing its admission behavior. Conceptual mathematics can be
  non-computational; a text-only judge also needs enough text to assess each
  marking item when the question contains a figure.
- Computational fill-in uses the authored fixed unit and value-only entry;
  neither Jev nor fuzzy matching performs unit conversion. It needs
  sign-sensitive deterministic matching of the permitted value forms.
  The current prose `fuzzyMatch` removes minus signs and other punctuation;
  reusing it unchanged would treat some different numeric answers as equal.
  Specify the accepted numeric/text forms before enabling this path.
- JSON is a valid input format for Jev. The existing benchmark sends a JSON
  `state` with text fields and a decision definition per marking point.
  Compare marking scheme plus student answer against variants that also
  include the question's text, shared stem and relevant part context. Images
  and SVG bytes do not give a text-only model visual understanding.
- Benchmark direct per-item 0/0.5/1 decisions against Epo's candidate
  probability bands: below 0.35 gives 0, below 0.65 gives 0.5, otherwise 1.
  The [September 27 screening](bench/grading/reports/2026-09-27-jev-partial-credit.md)
  completed 288 calls with genuine item-level half-credit labels. Direct
  grading matched 62/66 plain-item scores with context, versus 55/66 for
  bands; the latter gave zero to 10 of 11 half-credit answers. A `noul`
  probability measures support for a proposition, not the fraction of a
  mark earned. Prefer direct decisions for the next design, pending Epo's
  scoring-contract choice and held-out evaluation. Keep `markscheme` as
  plain strings unless a separate decision adds stored partial criteria.
- During the format migration, preserve the existing backend quiz-slot
  grading until the Jev follow-up lands. This is temporary behavior:
- `grade.ts`: part max = `markscheme.length`; closed types all-or-nothing per
  part as today; open parts one judge call each with `markscheme` passed as the
  marking scheme (the prompt text already says "Marking scheme"), award snapped
  to 0, 0.5 or 1 and multiplied by the part max. Question score is the sum of
  its parts.
- `scoreAttempt.ts`, `cloudGrade.ts`, `/api/quiz-grade` (`quiz_grade.go`
  request field renamed from `rubrics` to `markscheme`), the pipeline
  `build_grade_prompt` and `quiz_grade.golden.json` need an explicit adapter
  from shared stem and part blocks to the grading input. This is more than a
  field rename. Preserve old benchmark runs and add new input-contract cases;
  do not treat old whole-answer results as evidence for per-item scoring.
- `mistakes`: a question is a mistake when any part lost marks.

## Bank storage

A separate `bank` database in the `capy-library-db` container, shared by UAT
and production.

Schema, `server/bankmigrations/0001_init.sql`:

```sql
CREATE TABLE exams (id text PRIMARY KEY, label text NOT NULL, position int NOT NULL);
CREATE TABLE subjects (id text PRIMARY KEY, exam_id text NOT NULL REFERENCES exams, label text NOT NULL, position int NOT NULL);
CREATE TABLE topics (id text PRIMARY KEY, subject_id text NOT NULL REFERENCES subjects, label text NOT NULL, position int NOT NULL);
CREATE TABLE questions (
  id text PRIMARY KEY,
  topic_id text NOT NULL REFERENCES topics,
  position int NOT NULL,
  content jsonb NOT NULL,            -- Question
  sources jsonb NOT NULL DEFAULT '[]', -- [{excerptId, bookId, version}]
  run text NOT NULL,                 -- generation run folder name
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,                   -- production user id, no foreign key
  reviewed_at timestamptz,
  reviewed_by text,                  -- production user id, no foreign key
  UNIQUE (topic_id, position)
);
```

Migrations and roles:

- Export `store.MigrateFS(ctx, pool, fsys)` (the current `migrateWithFS`) and
  embed `server/bankmigrations/*.sql`. The ledger is `public.schema_migrations`
  inside `bank`. Changes stay additive while UAT and production run different
  code: add first, drop after both have deployed.
- `deploy/bank-db.sql`, a psql script run once by hand as `capy_library`
  (like `deploy/ops-roles.sql`), re-runnable to reset passwords and grants:
  - `CREATE DATABASE bank`; role `capy_bank` (LOGIN, owner of `bank`, used by
    migrations, publish and operator deletes from the PC).
  - `capy_library_reader` gets `CONNECT` on `bank`, `USAGE` on `public`, and
    default `SELECT` on tables `capy_bank` creates.
  - Role `capy_bank_editor` (LOGIN NOINHERIT): `SELECT` on every bank table,
    `UPDATE (content, updated_at, updated_by, reviewed_at, reviewed_by)` on
    `questions`, nothing else. Re-run after a migration that adds a column the
    editor writes.
- Backups: `deploy/library-db-backup.sh` also dumps `bank` and uploads that
  dump to the private bank bucket (rclone in a container, credentials in
  `/opt/capy-library-db/.env`); a bucket lifecycle rule keeps 30 days.
- Runbook §7.3 gains the bank database, roles, URLs, backup and restore; the
  existing tunnel on 15433 reaches `bank` too.

Buckets (runbook §4.2, new):

- Public bank bucket: figures and graph SVGs at `<sha256>.<ext>`, fronted by a
  Cloudflare hostname (the value of `BANK_ASSETS_URL`) with
  `Cache-Control: public, max-age=31536000, immutable`. No CORS needed for
  `<img>`. The local publisher and production API use environment-configured
  upload credentials. Production bank editors upload through the API; B2
  credentials never go to the browser. UAT and local app servers remain
  read-only under the existing bank environment policy.
- Private bank bucket: `references/`, `runs/` (style notes, prompts,
  receipts) and `backups/`. Key for the PC and a separate write-only key for
  the backup cron.
- Check the SPA's CSP `img-src` for the bank hostname and `data:` (inline graph
  SVG) and add them if missing.

## Bank API

Go package `server/internal/bank`: pools, queries, and handlers registered from
`huma_register.go` as `registerBank`.

Config (`deploy/env-manifest.json`):

- `BANK_DATABASE_URL` (secret; targets `coolify`, `local`): reader URL. Empty
  means every `/api/bank/*` route answers 404 `bank_unconfigured`.
- `BANK_EDITOR_DATABASE_URL` (secret; target `coolify`, set only in the
  production env file): editor URL. Empty means edit routes answer 404
  `bank_read_only` and `editor` is false in the syllabus response.
- `BANK_ASSETS_URL` (variable; `coolify`, `local`): public bucket base URL
  for the bank validation policy.
- `BANK_PUBLIC_B2_*` (credentials secret; production `coolify`, and the local
  publisher's `.env.local`): public bank object storage configuration. The
  same variable names can carry separate deployment credentials; no PC-only
  upload restriction. The app API does not need private-bucket credentials.
- `BANK_COMMENT_EMAIL` (variable; `coolify`, `local`): comment recipient,
  samyung@stablestudio.org in production. Empty means 404 on the comment
  route.

Pools copy the ops library pool: lazy connect on first use under a mutex,
`MaxConns` 2, `statement_timeout` 15s, failures return 503 `bank_unavailable`
and are not cached. The API boots when the ingest host is down.

Editors: `server/migrations/0035_bank_editors.sql` (next free number at
implementation time):

```sql
CREATE TABLE bank_editors (
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
```

The lookup excludes suspended, deleted and deletion-requested users like
`ReadStore.Operator`. Granting is a hand `INSERT`, documented in runbook §8.
An editor is a `bank_editors` row and a configured editor pool.

Routes (all require sign-in; non-editor calls to editor routes get 404 like
other forbidden reads):

| Route | Who | Behaviour |
| --- | --- | --- |
| `GET /api/bank/syllabus` | signed in | exams, subjects, topics with `total` and `reviewed` counts, and `editor` |
| `GET /api/bank/topics/{topicId}/questions` | signed in | rows: id, position, preview (first stem text, 160 characters), marks, hasFigure, hasTable, reviewedAt, reviewer name |
| `GET /api/bank/questions/{id}` | signed in | editors get the full question, sources, `updatedAt` and review fields; everyone else gets the learner view |
| `POST /api/bank/assets` | editor | validates a bounded supported image or graph SVG, writes a content-hash object to the public bank bucket, returns its public URL |
| `PUT /api/bank/questions/{id}` | editor | body `{ question, updatedAt }`; bank-policy validation; `UPDATE … WHERE id = $1 AND updated_at = $2`, 409 `bank_conflict` on zero rows; sets `updated_by` |
| `PUT /api/bank/questions/{id}/review` | editor | `{ reviewed: boolean }` sets or clears `reviewed_at` and `reviewed_by`; an edit leaves the review as it is |
| `POST /api/bank/questions/{id}/comments` | editor | `{ text }` up to 2,000 characters; sends one email and returns 204 |

- Bank validation means the shared question schema plus the bank-specific
  rules, including required worked solutions and public asset URLs under the
  parsed `BANK_ASSETS_URL` origin/base path. The URL is a reference to bytes
  stored in B2, not an upload or a credential. Validate upload content and set
  the correct Content-Type and immutable Cache-Control at object creation.
- Question saves always store question content in Postgres. Text, formulas,
  chart/table data, graph construction data, dimensions and attribution live
  there. New or changed graph SVG/image bytes upload to B2 first; a metadata
  or text-only edit reuses the existing asset URL. Rendering a data-driven
  chart does not require an asset upload.
- Review remains a manual marker after content edits. Epo assigns reviewer
  scopes; Mark reviewed/Undo does not add a version-bound review protocol.
- Learner view: stem and part blocks, answer type, marks, and only what a
  learner needs to read the part (mcq/multi options; matching left items and
  the complete shuffled choice pool; ordering items shuffled; required answer
  units). No correct answers,
  accepted answers, hints, marking scheme or solution.
- Reviewer names come from the app database `users` table by id; ids unknown
  to that environment (production ids in UAT) show no name.
- Comment email goes out directly through the API's `mail.Sender` in plain
  text: question link (`/bank/{topicId}/{questionId}?mode=edit`), exam ·
  subject · topic, question number, commenter name and email, comment text.
  No outbox row: the editor sees a failure and presses Send again, per the
  no-retry rule for user-retryable calls. Local uses the log backend.
- The existing global rate limiter covers these routes; no new class.

## Bank page

Route `/bank/$topicId?/$questionId?` with `staticData: { hideSidebar: true }`,
search param `mode=view|edit` (edit only honoured for editors). Unlisted: no
sidebar entry. Layout (4A) inside `PanelWithInvertedRadius` with TopInsetBar
in the notch:

- Left: search box filtering the syllabus tree client-side; exam and subject
  headings; topics with counts (`50`, or `32/50` reviewed in edit mode).
- Middle: topic title; question rows with number, preview through `TextView`,
  "7 marks · figure"; edit mode adds the reviewer and age, an All /
  Unreviewed filter with count, and the reviewed badge per row. View mode
  shows no status icons until the studying follow-up.
- Right: topic context without the redundant exam/subject heading, with the
  CenterContentHeader view/edit toggle for editors; `QuestionView` without
  inputs or Check answer in view mode; in edit mode each part adds Answer,
  Marking scheme and Worked solution, and the footer shows "Reviewed by N ·
  date" with Undo (or Mark reviewed), Comment and Edit. No Delete.
- Comment: `SimpleDialog` with a textarea, Cancel and Send; the text stays on
  failure.
- Edit opens the question dialog; Save PUTs and refreshes the row; 409 shows
  "changed since you opened it" and preserves the draft. Reload/discard is
  an explicit user action.
- MSW handlers and seed data for the bank routes in `src/mocks/handlers.ts`
  and `src/mocks/db.ts`, including an editor and a non-editor scenario.
- Messages in `messages/en.json` and `messages/zh.json`.
- Responsive navigation uses approved A throughout: below `md`, show one
  level at a time (topics, questions, question), with Back returning to the
  previous level. At `md`, the question sits beside the list and Topics
  replaces the list with the syllabus. At `xl`, show all three panes.
  Keep the question dialog's Outline/Preview tabs below `md` and side-by-side
  panes from `md`. Omit extra topic/question pickers. Use mobile-first
  standard named minimum breakpoints only, without custom values or
  max-width breakpoint variants.

## Notes

- Formulas: `BlockEquation` and `InlineEquation` swap to a MathLive field in
  place on click, in edit mode only; click-away or Enter saves `texExpression`
  with `setNodes`, Escape reverts. `insertInlineEquation` inserts an empty
  inline equation and opens it instead of prompting. The inline focus style is
  an inset accent outline that hugs the formula; the block equation loses
  `EQUATION_BLOCK_CLASS`'s grey border.
- Chart and graph embeds: new void block elements `chart` and `graph` whose
  attributes are the block fields plus `id`; graph uses inline SVG. Inserted
  from the slash menu and toolbar insert list at the top level only (the
  mermaid container rule). Registration points to touch: `plugins.ts`,
  `nodeComponents.tsx`, `staticPlugins.ts`, `staticNodeComponents.tsx`,
  `document.ts`, `markdown.ts` (export only: chart as a titled table, graph as
  its description), `editorCommands.ts`, `noteEditorPrefs.ts`,
  `editorMode.ts`, `collaboration/src/materialDocument.ts` and
  `editCommands.ts`, `materialdoc/document.go` (validation through the
  question block validator, and chart title plus graph description in
  `ExtractIndexText`), `internal_documents.go`, and `agenttools.go`.
- Embed look: no label, `border border-transparent` that becomes the accent
  border plus ring when selected, so selection causes no layout shift. The
  mermaid `BlockShell` label, grey shell and inner border go the same way.
- Selecting an embed shows the shared block toolbar: Edit, Copy, Delete. Edit
  opens the block editor in a dialog with Remove block and Save; mermaid Edit
  opens a dialog with a source textarea and preview, as already approved.
- Editing stays inside the Yjs `content` root with stable ids; no runtime state
  on nodes.

## Generation (lab/questions)

Local only. Code in `lab/questions`, data in ignored `data/question-bank`,
secrets in `.env.local`.

```text
lab/questions/
  README.md
  syllabi/hkdse.json, ielts.json   committed: exam, subjects, topics (id, label, position, syllabus reference)
  prompts/references.md, style.md, write.md, solve.md, fix.md
  run.py        stage driver per topic
  render.ts     Playwright plus in-process Vite: PNG per question, graph SVG export
  copycheck.py  overlap check against the references
data/question-bank/<exam>/<subject>/<topic>/
  references/  style.md  questions/<id>.json  solve/<id>.json  compare.json
  render/<id>.png  assets/<sha256>.svg  receipts/<stage>-<timestamp>.json
```

Stages per topic use fresh Codex GPT-6 Astra medium subagents with no inherited
conversation, as Epo selected on September 27. The driver freezes input, prompt
and JSON schema, binds the dispatched agent identity, then validates its output.
Receipts record hashes and admission; token usage is explicitly unavailable from
the subagent tool. There are no automatic retries:

1. References: web tools allowed. Finds past and sample papers for the topic,
   saves them under `references/`, records source URLs. Never distributed.
2. Style notes: reads the references and writes `style.md`: question forms,
   mark allocation, difficulty, what is tested, typical stems. No quoted text.
3. Write (clean room): no tools; input is the topic, `style.md`, the question
   JSON schema and the graph element whitelist. Writes about 50 questions with
   answers, marking schemes and worked solutions. Instructions restrict
   computational tasks to deterministic answer types and open/essay tasks to
   non-computational grading, with marking items explicit enough to assess.
4. Solve (blind): no tools; input is each question's learner view. Returns
   answers. `compare.json` records per-part agreement (exact for closed types,
   a judge call for open).
5. Fix: disagreements go back to a fresh writer process with the solver's
   answer; unresolved questions are dropped and logged.
6. Render: `pnpm exec tsx lab/questions/render.ts <topic dir>` renders every
   question with the real `QuestionView` to PNG and exports graph SVGs with the
   pinned JSXGraph, writing `image.url` placeholders as content hashes.
7. Copy check: flags any 12-word run shared with a reference file; flagged
   questions are rewritten or dropped.
8. Publish (below).

IELTS mapping for the pilot, using existing answer types: True / False / Not
given as mcq with those three options, matching headings and matching
information as matching, sentence and summary completion as short, multiple
choice as mcq or multi. Passages are original writing (library sources are for
later subjects); the writer keeps facts general enough not to mislead, and the
review pass checks them.

Matching generation supplies the full `options` pool, including unused
headings, plus the correct option index for each left item. Exam-specific
instructions control whether choices may be reused. Quantity-answer
instructions prescribe one unit, write accepted values in that unit and use
the fixed-unit answer control. The broader answer-control redesign stays
deferred.

Publish is a Go command, `server/cmd/bank`, so it reuses the question
validator, the migrator and the B2 client:

- `bank migrate` applies `server/bankmigrations` with the `capy_bank` URL.
- `bank publish <topic dir>`: validates every question with the bank policy;
  uploads assets to the public bucket by content hash (skipping keys that
  exist); uploads `references/`, `style.md` and receipts to the private
  bucket under `runs/…`; then one transaction upserts the exam, subject and
  topic rows from the syllabus file and inserts questions with the next
  positions, `ON CONFLICT (id) DO NOTHING`. Prints inserted and skipped ids.
- `bank status`: counts per topic, reviewed counts, last run.
- Env from `.env.local`: `BANK_OWNER_DATABASE_URL` (through the 15433 tunnel),
  `BANK_PUBLIC_B2_*`, `BANK_PRIVATE_B2_*`, `BANK_ASSETS_URL`.
- Operator deletes are `DELETE FROM questions WHERE id = …` as `capy_bank`.

Models: GPT-6 Astra, medium effort, for every generation stage.

## Phases

Each phase ends with `pnpm run fmt`, `pnpm run fix`, `pnpm run fmt:go`,
`pnpm run fmt:py` where touched, the relevant tests, and `openwiki/test-catalog.md`
entries. Decision code references go into `human/` after each phase.

1. **Format and views.** `src/features/questions` types, validator, fixtures,
   `TextView`, block views, `QuestionView`, `QuestionReview`; chart extraction
   from `ChatChart`; Go `server/internal/questions`; collaboration mirror;
   limits, matching choice pool and fixed-unit answer metadata. Tests:
   validator fixtures in all three runtimes, `parseMathText`,
   chart extraction keeps chat rendering identical (existing chat tests plus a
   render test).
2. **Quizzes on the new format.** Void question-attribute storage; converters and
    validators in `document.ts`, `materialdoc`, collaboration; levels optional
   in all three and in `GenerateFormDialog`, `GenerateReq` (`minItems` gone)
   and the pipeline (`service.py`, `generate.py`, `workflows.py`); the
   generator's contract rewritten for the new shape with a JSON schema;
   agent tools and `agent_tools.json`; quiz markdown fences; `QuizAttempt`,
   `AttemptResult`, share and Explore pages; grading; attempts and mistakes;
   MSW fixtures, `dev_seed.sql`, `e2e/fixtures/seed.sql` and seed.ts; level
   badges and `src/lib/levels.ts` UI removed. Tests: Go materialdoc and
   httpapi quiz tests, store attempt tests, collaboration document tests,
    pipeline generate and quiz-grade tests, `grade.test.ts`, the quiz sharing
    e2e, and stale authored-content saves for quiz/flashcard forms across
    standalone, workspace and embedded materials; matching with unused and
    reused choices; fixed-unit entry, rejection of typed units and numeric
    sign preservation.
3. **Question dialog and quiz page.** MathLive and JSXGraph dependencies;
   `QuestionDialog`, block editors, `BlockToolbar`; quiz page 5A without the
   sidebar; `QuizDialog` removal; embedded quiz Edit navigation and fresh
   reads on every embedded-material open; `Collapsible`
   wrapper. Tests: text editor serialisation round trip, graph element
   whitelist and SVG export, dialog save and cancel, a Playwright spec that
   builds a question with a formula, a chart and a graph and saves it;
   reopen a cached embed after an external edit, check both view and edit
   show the latest content/version, and verify failed refresh cannot seed a
   stale editing draft.
4. **Notes.** MathLive equations; chart and graph embeds; mermaid restyle and
   edit dialog; `BlockToolbar` in table, columns and embeds. Tests: editor
   e2e for formula editing and chart insert/edit (MSW editor suite),
   validation tests for the new nodes in all three runtimes, index-text test.
   The CI `pnpm bench:editor` performance gate remains before rollout; compare on the same runner.
5. **Bank infrastructure.** `server/bankmigrations`, `store.MigrateFS`,
   `server/cmd/bank migrate`, `deploy/bank-db.sql`, backup script, env
   manifest keys, runbook §4.2, §7.3 and §8. Applying `deploy/bank-db.sql` on
   the ingest host, creating buckets and setting production env values are
   Epo's manual steps. Tests: bank migration applies to an empty database in
   the Go harness (copy `migrationDatabase`), editor role column grants
   (copy `privileges_test.go`'s role setup).
6. **Bank API and page.** `bank_editors` migration, `server/internal/bank`,
   routes, comment email, OpenAPI regeneration (`pnpm gen:api:full`), hooks,
   page, MSW. Tests: learner view strips every answer field for each type,
   editor gating with and without the editor pool, 409 on a stale update,
    review set and clear with review retained on edit, editor-only asset upload
    and returned URL accepted by bank validation, stale-save draft retention,
    comment 404 without recipient and one email sent
   (log sender), 503 when the pool is down; a Playwright MSW spec for view and
   edit mode.
7. **Generation tooling.** `lab/questions` as above, `server/cmd/bank
   publish` and `status`. Tests: `publish` against the Go harness bank
   database with a fixture topic (insert, skip on rerun, validation failure
   rolls back), `copycheck.py` unit test.
8. **Pilot.** One topic end to end on local, then the remaining pilot topics,
   published to the shared bank; Epo reviews in production. Findings feed the
   answer-type and grading follow-ups.

Phases 1 then 2 are sequential. 3 needs 1 and 2. 4 needs 3. 5 can run beside
1 to 4. 6 needs 1, 3 and 5. 7 needs 1 and 5; its writing stages can be tried
after phase 1 with local files only.

Documentation: a new `openwiki/question-bank.md` (format, rendering, bank
database, API, generation) added to the AGENTS.md table, plus updates to
`frontend/plate-editor.md` (quiz storage, new embeds, MathLive),
`deployment-runbook.md`, `authorization-permissions-lifecycles.md` (bank
editors) and `test-catalog.md`.

## Risks

- **Breadth of phase 2.** The quiz shape touches the frontend, Go, the
  collaboration service, the pipeline, agent tools, seeds and e2e fixtures at
  once. The shared validator fixtures are the guard; land it as one change.
- **MathLive inside Plate.** A focusable web component inside a Slate inline
  void can fight Slate's selection and keyboard handling. Spike it first in
  phase 3 with one inline equation before building the text editor on it.
- **JSXGraph export.** Labels drawn as HTML (MathJax/KaTeX) do not appear in
  the SVG, so graph text elements are plain text. Font rendering differs
  between the headless and browser export; the SVG uses a system font stack.
- **Shared database across versions.** A bank migration that breaks the older
  production code breaks production. Additive changes only, and the editor
  role grants are re-applied after column additions.
- **Ingest host availability.** The production bank page returns 503 when the
  host is down; the rest of the app is unaffected.
- **Generated passages.** Original IELTS passages can state invented facts as
  true. The writer prompt and the review pass both check for this.
- **Copyright.** References stay private; the clean-room writer never sees
  them; the copy check catches leaks.

## Remaining calls and operational work

- Generation uses the selected Astra medium subagents. Verified catalogs in
  `lab/questions/syllabi` cover 18 HKDSE units and 11 IELTS task types; the
  browser examples remain mock fixtures, not published questions.
- Bank roles, public/private buckets, local tunnel and Cloudflare asset hostname
  are provisioned. Empty-bank backup and restore are verified, and a published
  graph returned HTTP 200 with a Cloudflare cache hit. The handoff content backup
  restored all 200 questions with matching complete-row fingerprints. Configure the production
  editor connection and comment recipient for rollout. Coordinate the old-quiz
  data cutover before deploying this incompatible shape.
- Four local topics completed generation, blind solving, visual review,
  copy checks and publication (200 questions). The user stopped at this round:
  three more topics are written but need remaining admission checks, and 22
  have reference/style evidence ready for writing. Resume from the handoff when
  requested, then review the completed pilot in production after rollout.

The implementation uses the plan's recommended void question attribute,
inline SVG for user graphs, bank-only image blocks, layout/label fields,
required bank solutions and removal of the unenforced quiz timer.

Production Jev integration, per-item scoring, computational-question checks
and studying directly from the bank remain deferred. The completed screening
favors direct 0/0.5/1 decisions but does not establish production accuracy or an
admission threshold. See `todo-question-bank.md` and the benchmark reports.
