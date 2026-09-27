# Question bank handoff — 2026-09-27

The user asked to wrap up after the current subagent round. All subagents have
finished, new dispatches have stopped, and all publication processes have
settled. **200 questions are published; 150 more are written but unpublished.**
The pilot is not yet finished. Resume only when the user asks.

## Workspace and scope

- Repository: `C:\WEB\capy-notebook`, branch `main`, base commit
  `75512bb3ea413ff5aa134502b7f491c471b52d65`.
- Phases 1–7 of [question-bank-plan.md](question-bank-plan.md) are implemented in
  the working tree. There is extensive unrelated work in the same dirty tree;
  preserve it. Several question-bank implementation directories are untracked.
  No commit, PR, application deployment or old-quiz data reset was performed.
- The full pilot is 29 topics × approximately 50 questions: 18 HKDSE Mathematics
  Compulsory units and 11 IELTS Academic Reading task types. The first topic was
  completed end to end before expansion.
- Local generation data and receipts are ignored under
  `data/question-bank/pilot-2026-09-27/`. Continue in this workspace or preserve
  that directory separately; a Git checkout alone cannot resume this run.

## Stable pilot checkpoint

| Topic | Questions | State |
| --- | ---: | --- |
| Functions and their graphs | 50 | Published; 90 parts and 7 graph assets |
| Solving single-variable quadratics | 50 | Published; 53 parts |
| Exponential functions and logarithms | 50 | Published; 51 parts |
| Polynomial operations and theorems | 50 | Published; 50 parts |
| Further equation-solving methods | 50 | Rendered, Go-valid, visual PASS; fresh blind solving pending |
| Direct, inverse and joint variation | 50 | Rendered and Go-valid; blind solving and visual review pending |
| IELTS — Selecting answers from choices | 50 | Rendered and Go-valid; blind solving, visual and passage-fact review pending |
| Other 22 pilot topics | 0 | References/styles admitted; frozen writer packets ready and unbound |

Live `bank status` confirmed four published topics × 50 questions, all
unreviewed. All 200 passed blind solving from learner images, exact comparison,
complete visual review, Go validation and copy checking. No questions were
dropped or skipped from the published batches.

Exact local continuation records:

- [Progress inventory](data/question-bank/pilot-2026-09-27/expansion-progress.md): all 29 topic states.
- [Exact handoff state](data/question-bank/pilot-2026-09-27/round-handoff-state.json): every topic path,
  receipt path, worker identity, stage admission and output status.
- [Expansion notes](data/question-bank/pilot-2026-09-27/expansion-handoff-notes.md): frozen visual
  fix details, manual reference imports and resume commands.
- Each expansion publication retains `publication.log` and
  `publication-summary.json`; the first topic uses `publish-first-resume.log` in
  the pilot parent directory.

The root-owned MSW preview process was stopped. A separate existing IPv6 server
on port 5173 was left alone. The local bank tunnel remains on
`127.0.0.1:15433` (PID 43224 at handoff); no generation, renderer or publication
process remains active.

## Decisions already made

- Every generation stage uses a fresh **GPT-6 Astra, medium** subagent with no
  inherited conversation. The user explicitly chose this. Do not substitute a
  model API, Claude, or another effort. The UI review used **Astra xhigh**.
- Approved designs are
  [the original mock](artifacts/2026-09-25-question-bank-mocks.html) and
  [responsive layout A](artifacts/2026-09-27-question-bank-responsive-mocks.html).
  Prefer clean navigation; remove the redundant exam/subject heading. Use
  named minimum breakpoints (`sm:`, `md:`), never custom or maximum breakpoints.
- Reuse shared ToolbarGroup/ToolbarButton. Plate already has scroll fading;
  question toolbars add the scroll classes through `className`, without changing
  base Toolbar styles. Back navigation uses `navigationBack`. Remove sits beside
  Save on the right, using the shared dialog conventions.
- Content edits retain Reviewed. Do not add reviewer locks or approval workflow.
  Reject stale saves and retain drafts. All authored quiz/flashcard writes carry
  `expectedRevision`; bank writes use the exact `updatedAt` token. Embedded
  materials refetch on every view/edit open.
- Matching has a separate choice pool, including unused options and permitted
  reuse. Quantity answers prescribe one unit, display it separately and accept
  only the value. No typed units or unit conversion.
- Computational questions use deterministic answer types. Open/essay questions
  are non-computational. Production Jev integration, per-item scoring, the
  computation classifier and direct study from the bank remain deferred in
  [todo-question-bank.md](todo-question-bank.md). The completed Jev screening
  favors direct 0/0.5/1 grading; it is not production accuracy approval.
- Bank uploads use the authenticated server API with environment credentials,
  plus the local publisher. They are not restricted to this PC. Local/UAT app
  connections are readers; production gets the restricted editor connection.

## UI implementation and verification

The requested fresh Astra xhigh comparison found eight gaps and three follow-up
issues. They were corrected and a fresh closing review found no remaining
actionable issue within that scope. Reports and screenshots:

- `data/question-bank/ui-alignment-2026-09-27/report.md`
- `data/question-bank/ui-alignment-2026-09-27/recheck.md`
- `data/question-bank/ui-alignment-2026-09-27/final-closing.md`
- `final-bank-header-{390,900}.png` and
  `final-formula-keyboard-{phone,desktop}.png` in the same directory.

Main corrections: dedicated quiz edit routing for standalone/material/embedded
entry points; safe return paths; phone full-screen question dialog with a
scrolling body and fixed header/footer; compact table/text/graph/chart editors;
outline summaries; aligned submitted scores; responsive headers. Shared base
Toolbar/Dialog/Header defaults remain unchanged.

MathLive needed a functional correction: its native beforeinput/input/keydown
events stop at the math field so Slate cannot cancel entry. Physical and virtual
digits now commit and reopen. The question dialog gives the virtual keyboard its
own grid row through scoped caller classes; escaped underscores and `!` in its
Tailwind height selectors are intentional, because MathLive uses unlayered CSS.
The relevant files are `src/features/questions/MathField.tsx`, `TextEditor.tsx`
and `QuestionDialog.tsx`. Note callers retain their native keyboard button.

Completed checks are recorded in `data/question-bank/verification.md`:

- Frontend: 428 tests / 82 files; editor helper suite: 4 tests.
- Collaboration: 194 tests / 24 files; focused Go harness: six affected packages.
- Final `pnpm run fmt`, `pnpm run fix`, `pnpm run typecheck`, and production build
  passed after the UI corrections. Build ran with Sentry upload disabled.
- Focused MathLive E2E passed: `pnpm run e2e:slow
  --config=e2e/editor/playwright.editor.config.ts question-formula.spec.ts`, with
  `EDITOR_E2E_PORT=4529`. Physical input/commit/reopen is automated; root also
  verified the virtual keypad in the browser.
- Focused pipeline normalization: 2 passed, 59 deselected. Focused publisher and
  question validator checks passed after archive upload was bounded to four
  workers.
- Local real HTTP handlers read the first published topic through the actual
  read-only bank role: syllabus/list/detail 200, learner answers/schemes/solutions
  absent. `live-reader-http.log` and archived `live-reader-http_test.go` are under
  the pilot directory. The temporary Go package was removed from `server/tmp`
  so future test suites cannot accidentally perform live reads.

CI editor performance budgets, deployed API verification and real comment-email
delivery remain unverified. Do not repeat broad suites solely to resume data
generation; rerun relevant checks when code changes or a failure warrants it.

## Infrastructure already configured

- Separate `bank` PostgreSQL database on ingest host `159.195.61.195`, container
  `capy-library-db`, private endpoint `10.77.0.2:5433`. Owner `capy_bank`, editor
  `capy_bank_editor`, reader `capy_library_reader`. Migrations and column grants
  are applied. Editor can update only the content/audit/review columns.
- Local owner/reader URLs and publisher credentials are in ignored `.env.local`.
  The local SSH tunnel uses port `15433`; its PID file is
  `data/question-bank/tunnel.pid`. Verify the listener before resuming.
- Ignored `deploy/.env.uat` has `BANK_DATABASE_URL` using the reader's private
  endpoint and `BANK_ASSETS_URL`. Its manifest check passed. No environment push
  or deployment ran. Private archive credentials were removed from the UAT API
  environment. `deploy/.env.prod` does not exist locally.
- Public B2 bucket: `capy-notebook-question-bank-public` (`allPublic`). Private
  bucket: `capy-notebook-question-bank-private` (`allPrivate`). Region
  `eu-central-003`; endpoint `https://s3.eu-central-003.backblazeb2.com`.
- **BANK_ASSETS_URL=https://bank-assets.capynotebook.com** is filled in both
  ignored local and UAT env files. Cloudflare has a proxied CNAME to
  `f003.backblazeb2.com`, a host-scoped URL rewrite adding
  `/file/capy-notebook-question-bank-public`, and host-only Strict TLS. The zone's
  existing global TLS setting was preserved. Both rules are active.
- A real browser request for a published SVG returned HTTP 200,
  `image/svg+xml`, `CF-Cache-Status: HIT` and one-year immutable cache headers.
  Evidence: `asset-delivery-browser.json` and `cloudflare-graph-delivery.png` in
  the pilot directory. Python urllib gets Cloudflare 1010; do not weaken browser
  protection to accommodate that diagnostic client.
- Bank backups use the existing 03:15 **Europe/Berlin** cron, a separate
  write-only key and private `backups/` prefix. B2 hides these after 30 days and
  deletes one day later; reference/run archives do not expire. Empty and first
  50-question backups were downloaded, hash-checked and restored, with exact
  table fingerprints. The final checkpoint also restored **all 200 questions**
  from `backups/bank-20260927T082121Z.dump` (60,045 bytes), with every public-table
  fingerprint matching the live bank. SHA-256:
  `73eb9d0292acdc866298a9e0da7db1b9d5c1deae2d117e5b9e452a8a670b3c58`.
  The disposable restore database was removed and its absence verified. Reader
  privileges and syllabus/list/detail SQL checks passed again. See
  [backup evidence](data/question-bank/pilot-2026-09-27/backup-verification.md)
  and `checkpoint-backup.log`. The bank-only helper is
  `verify-checkpoint-backup.py`; it requires an explicit expected row count.

Do not copy credentials into this file or chat. Existing local configuration and
the host's `/opt/capy-library-db/.env` contain what is needed. Do not rerun
`setup-backup.py`; it provisions keys and assumes an empty lifecycle configuration.

## Generation safeguards and resumption

Read [lab/questions/README.md](lab/questions/README.md) and the per-topic
`expansion-progress.md`/handoff records before doing work. The coordinator is
`/root/pilot_expansion`; current outputs are on the shared filesystem.

- Frozen packets live in each topic's `receipts/`. Input, prompt, schema and
  learner-image hashes are recorded. Bind a fresh worker identity, then rerun the
  original stage to validate/admit its output. Preserve admitted outputs and
  unused/stale packets. Never edit them to force agreement.
- Writers receive only topic metadata, approved style and the schema. Solvers
  receive only the learner projection and **must actually inspect every learner
  PNG**. Graph recipes, SVGs, URLs, schemes and accepted answers are excluded.
  Use fresh agents after repairs. Correctness and visual admission are separate.
- All review PNGs need visual review; contact sheets are useful for coverage,
  with full-resolution checks for long pages, figures or ambiguous rendering.
  A visual pass does not set the production Reviewed marker.
- Use explicit empty source arrays for these synthetic pilot questions before
  publication; unpublished batches still need that publication metadata.
  References stay private. Writers must not invent specific studies or historical claims
  in original IELTS passages. Some references have narrow exemplar coverage;
  their notes disclose this.
- Official reference downloads sometimes returned urllib 403. Workers saved
  actual official bytes through ordinary HTTPS/local copies and checked UTF-8
  notes; this is documented. Do not replace private references with generated
  text or modify already-admitted reference outputs.
- Run one topic renderer at a time. The renderer uses
  `node_modules/.vite-question-render`, separate from the app dev cache. It writes
  both review and learner PNGs, matching manifests and content-hashed graph SVGs.
- Publish only after blind comparison, visual review, Go validation and copy
  checks pass. `prepare-publish` logs unresolved drops. Publication inserts new
  IDs and never overwrites reviewer edits. Uploads must finish before insertion;
  four bounded archive workers are intentional. Do not use the errgroup's
  canceled child context for the later database transaction.

Commands, replacing `<topic>` with the existing absolute topic directory:

```powershell
uv run --project pipeline python -X utf8 lab/questions/run.py solve <topic>
# Dispatch fresh Astra medium workers for the frozen packets, then bind each:
uv run --project pipeline python -X utf8 lab/questions/run.py bind <receipt> --agent-id <canonical-worker>
# Rerun solve to admit outputs, then:
uv run --project pipeline python -X utf8 lab/questions/run.py compare <topic>
uv run --project pipeline python -X utf8 lab/questions/run.py fix <topic>
# After a repair: render, validate, solve and compare again.
pnpm exec tsx lab/questions/render.ts <topic>
uv run --project pipeline python -X utf8 lab/questions/run.py copycheck <topic>
uv run --project pipeline python -X utf8 lab/questions/run.py prepare-publish <topic>
# From server/:
go run ./cmd/bank validate <topic>
go run ./cmd/bank publish <topic>
go run ./cmd/bank status
```

Publication is already authorized as part of the pilot, but the user's latest
instruction is to stop at this round and hand off. Wait for a request to resume
before starting another generation round.

The next ready batch is Equations: all 50 current review renders pass visual
review, including an admitted repair to one malformed inequality distractor.
`current-solve-packets.json` inside that topic lists the current 50 learner
packets. Older packets from before the repair remain for audit; do not dispatch
them. Fresh blind solving has not started. The repaired question is
`eafe2dfd-2822-4810-8951-18b87edabbde`; option C now correctly displays
`c ≤ -1/4`. The topic's visual report documents both the finding and recheck.

Variations and IELTS Multiple Choice have 50 rendered, Go-validated questions
each. They still need fresh blind solving, complete visual review, comparison,
copy checks, publication metadata and publication. Do not treat their successful
authoring/schema validation as correctness admission.

## Application rollout remains separate

Configure the production restricted editor connection and application editor
grant, and the existing approved comment recipient `samyung@stablestudio.org`.
Coordinate the old-quiz data cutover before deploying the incompatible new
question shape. Prepare a concrete rollout and verify the CI editor performance
gate on its normal runner. No production rollout, destructive data cutover or
external email has been approved in this checkpoint. The user has no unresolved
choice blocking local pilot generation.
