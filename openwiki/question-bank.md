# Question bank

The bank is a separate syllabus and question database. Signed-in learners read
question content; granted bank editors can edit, mark reviewed, upload figures
and send a comment. The bank page is unlisted at `/bank`. Studying directly from
the bank and production Jev grading remain in `todo-question-bank.md`.

## Shared question format

`src/features/questions/types.ts` defines stem blocks and ordered parts. Each
part has a stable ID, blocks, one of seven answer types, plain marking items and
worked-solution blocks. Its marks equal the number of marking items. A matching
answer stores the full choice pool independently from its correct pairings, so
unused and reused options survive generation, editing and rendering.

The Go validator is `server/internal/questions`; the browser and collaboration
service share its JSON fixtures. Bounds originate in
`server/internal/fieldlimits` and are generated for TypeScript and Python by
`pnpm gen:openapi`. Bank parts require worked solutions; user quiz solutions
are optional. Levels are optional metadata and the unenforced timer was removed.

Quiz materials remain Plate/Yjs documents. A void `quiz_question` node stores
the question as an attribute, with the same ID and one empty text leaf. Part
IDs are unique within the material. Note chart/graph voids store their validated
block under `block`; their Markdown fences round-trip that JSON. Old question
nodes and old question JSON are rejected, without a compatibility converter.

## Editing and assets

`QuestionDialog` is shared by the bank and quiz edit page. It reuses
`ToolbarGroup`, `ToolbarButton` and `SimpleDialog`; block editors replace the
dialog body and keep Remove beside Save. English and Chinese labels use
Paraglide. MathLive renders formulas in both viewing and editing, including
question-editing previews. Read-only previews use the shared `MathPreview`
component with matching fonts/layout and no keyboard or menu controls. `BlockToolbar`
is shared by question blocks, note embeds, tables and columns.

Charts reuse the SVG renderer extracted from ChatChart. Graphs store a bounded
JSXGraph recipe and a static rendering. User quizzes and notes keep validated
SVG, at most 256 KiB, in their document. Bank graphs store the recipe in the
database and the SVG in the public bucket; bank images likewise use public
content-hashed URLs. Image blocks are currently bank-only.

`POST /api/bank/assets` checks the editor grant, validates the bytes and uses
server environment credentials. The local publisher has the same validation.
`BANK_ASSETS_URL` is the allowed public base URL for stored bank asset references;
it does not restrict uploads to one developer machine. Credentials stay on the
server or publisher. Existing private workspace editor assets are separate.

## Revisions and grading

Every authored quiz/flashcard form write carries `expectedRevision` from the
loaded draft. The collaboration service compares it under the material lock,
including pending projection state and the current live block. A rejected write
keeps the draft. Opening an embedded material to view or edit fetches fresh
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

The existing backend grading slot still gives an open part one 0/0.5/1 decision,
scaled by its marking-item count. Its text request preserves stem, earlier-part,
current-part, figure-description, table and chart context. Jev integration,
per-item decisions and the review computation classifier are deferred.

Attempts retain graded snapshots. Mistakes strip the attempt-only awards.
Completion and saved attempt pages share the part review renderer: score in the
marks column, marking scheme, submitted answer, then collapsed worked solution.
Closed parts show item awards from their deterministic result; open parts keep
their part award without inventing per-item scores.
Review batches respect the existing 200-question and 2 MiB bounds, namespace
their part IDs without changing stored source IDs, and remove only questions
answered correctly in that batch. Unattempted mistakes remain.

## Bank and publication

`server/internal/bank` owns lazy reader, editor and library pools, each with two
connections and bounded statement time. Missing bank configuration does not
stop unrelated app features. The app database only stores `bank_editors` grants;
the bank has its own migrations and roles. See
[deployment-runbook.md](deployment-runbook.md) for provisioning, environment
values, public/private buckets, local tunnel, comment recipient and backups.

Sources identify an excerpt, book and historical version. Both publisher and
reader resolve those references and apply the same provenance bounds and
copyleft-family computation. Publication refuses incompatible sources before
inserting a question.

`lab/questions` is a local staged builder. References stay private; a clean-room
writer, blind solver, judge/fix pass, actual component renderer and copy check
produce frozen publication evidence. See its [README](../lab/questions/README.md).
`server/cmd/bank` migrates, publishes and reports status. Publication uploads
immutable assets and inserts new IDs; it does not overwrite later reviewer edits.

## Delivery and checks

The implementation is in the working tree. The separate bank database and B2
buckets are provisioned; the public asset hostname is configured in Cloudflare.
Verified pilot catalogs cover 18 HKDSE units and 11 IELTS task types, with fresh
Astra medium subagents selected for each generation stage. The first topic,
Functions and their graphs, passed blind solving (50/50), visual review and
copy checks. Quadratics, logarithms and polynomials also passed all admission
checks, bringing the published count to 200, with zero dropped or skipped.
Another 150 questions are rendered and Go-valid but unpublished; the other 22
topics have admitted references/styles and writer packets ready. The user
requested wrap-up after this round, and all subagents/publication processes are
finished. See the [handoff](../question-bank-handoff.md) for exact continuation
state. Cloudflare serves a published graph with HTTP 200,
immutable cache headers and a cache hit.
Coordinate the old-quiz data cutover before application rollout.
Do not deploy the new readers over old question records without that cutover.

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
delivery, the CI editor performance gate and the remaining pilot admission remain
to verify. The final responsive recheck covers the approved desktop and phone
layouts, dedicated quiz edit routing and MathLive touch/physical entry; a focused
browser regression test verifies formula input survives commit and reopening.
