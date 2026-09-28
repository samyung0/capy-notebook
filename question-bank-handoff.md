# Question bank handoff — 2026-09-28

The pilot is complete. **1,098 questions are live** in the bank, all unreviewed:
18 HKDSE Mathematics Compulsory units × 50 and 11 IELTS Academic Reading task
types × 18 passage questions. Nothing is running and no generation is pending.

## Where things are

- Code: `main`. The pipeline is `lab/questions` (read its
  [README](lab/questions/README.md) before running anything); the bank CLI is
  `server/cmd/bank`; the question UI is `src/features/questions` and
  `src/routes/QuestionBank.tsx`.
- Decisions: `human/agentic-retrieval.md` (pipeline, model, IELTS library
  passages, render id filter), `human/miscellaneous.md` (question UI) and
  `human/frontend/plate-editor.md` (formula previews). They override anything
  older in this file's history, including the GPT-6 Astra instruction.
- Run data (ignored): `data/question-bank/pilot-2026-09-27/`, one directory per
  topic with receipts, renders, solves, reviews, copy checks and publication
  logs. A Git checkout alone cannot reproduce the evidence; keep that directory.
- Helpers used for this round, copied from the session scratchpad:
  `data/question-bank/pilot-2026-09-27/tools-2026-09-28/`.
  - `bind.py <packet-list> <agent-id>` binds every packet in a list.
  - `closed.py <topic>` lists closed-answer disagreements.
  - `fixq.py <topic> <issues.json>` turns review findings into fix packets
    (issues are `[{"id", "issue"}]`; run until it prints "applied").
  - `apply_packet.py <topic> <packet>` applies an admitted fix packet from its
    frozen input when the payload has since changed.
  - `delete_old_mc.py` removed the 50 first-round IELTS MC questions (its log is
    `deleted-2026-09-28.json` in that old run directory).
  - `ielts/` picks and remaps library excerpts and builds `passages.json`.

## How a topic was produced

Every stage ran as a fresh Claude Code Opus 5.5 medium subagent (`qb-worker`,
defined in the ignored `.claude/agents/qb-worker.md`) owning one topic.

1. `write` (maths, 50 per unit) or `passage` (IELTS, one question per library
   excerpt in `passages.json`, 450–950 words, CC BY / BY-SA / CC0 / public
   domain, current book version only).
2. `render.ts <topic>` for review and learner PNGs.
3. `solve` from the learner PNG only, then `compare`; open parts go to judge
   packets.
4. A reviewer agent viewed every review render (and, for IELTS, diffed each
   passage against its excerpt).
5. Disagreements and review findings became fix packets (`fixq.py`); fixed ids
   were re-rendered with `render.ts <topic> <id ...>`, re-solved and compared.
6. `copycheck` (12-word overlap with private references), `prepare-publish`,
   then `go run ./cmd/bank validate` and `publish` from `server/`.

Publishing IELTS needs the library database for provenance. `.env.local` has
`localhost`, which hangs on IPv6 through the tunnel; override it:

```bash
export LIBRARY_DATABASE_URL="$(grep '^LIBRARY_DATABASE_URL=' ../.env.local | cut -d= -f2- | sed 's/@localhost:/@127.0.0.1:/')"
```

The tunnel is
`ssh -i ~/.ssh/capy_ingest_159_195_61_195 -N -L 127.0.0.1:15433:10.77.0.2:5433 root@159.195.61.195`.

## Lessons from this round

These lived in the dispatch prompts given to each agent, not in the frozen
`prompts/*.md`; repeat them when dispatching new topics.

- Writers paraphrase instructions; the official IELTS rubric wording trips the
  copy check.
- Quantity answers with a `unit` are plain numbers: no thousands separators or
  surds (Go `quantityPattern`).
- Graph terms reject `PI`; use `x*0.017453292519943295` for degrees.
- Write JSON with `json.dump`; shell heredocs turn `\frac` into a form feed.
- Answer-position leaks were the most common review finding: heading lists in
  answer order, MC keys always longest or in a fixed slot, unused positions in
  sentence endings. Ask reviewers to check for them.
- Library excerpts sometimes repeat a paragraph (parser artefact, logged in the
  retrieval backlog); passage writers drop the repeat.
- Bind every agent before rerunning a stage, or the comparison runs on stale
  outputs.

## Open items

- **Matching layout.** Mock with options A (current), B (numbered items with
  spacing, recommended) and C (B plus roman numerals for heading options):
  https://claude.ai/artifact/2RshSuGZ3LBYXXWczDP2tw. Waiting for the developer's
  pick; then record it in `human/miscellaneous.md` and change
  `src/features/quizzes/QuestionRunner.tsx` / `QuestionView.tsx`.
- **UI notes seen in renders, not yet decided:** a faint grid shows when a graph
  sets `grid: false`; the review answer line prints raw LaTeX; IELTS
  instructions are stored in part 1's blocks rather than the stem; "65 °" renders
  with a space before the degree sign.
- **Review.** All live questions are unreviewed. Editors mark them in the bank
  UI; publication never overwrites their edits. Soft spots the blind solvers
  noted but that passed: diagram labels that lean on everyday anatomy (eye
  cornea/iris), a label pointing at a box already captioned "Generator" (both
  "power station" and "power plant" are accepted), and short passages under
  250 words (refraction, biological pump).
- **Rollout (unchanged).** Configure the production editor connection and grant,
  coordinate the old-quiz data cutover before deploying the new question shape,
  and verify the CI editor performance gate. No production rollout was approved.
- **Backups.** The nightly 03:15 Europe/Berlin dump covers the bank; the last
  restore test was at 200 questions (`backup-verification.md`). Repeat it with
  `verify-checkpoint-backup.py` and the new row count before relying on it.

## Infrastructure (unchanged since 2026-09-27)

- `bank` database in `capy-library-db` on `159.195.61.195`, private endpoint
  `10.77.0.2:5433`. Roles: owner `capy_bank`, editor `capy_bank_editor`, reader
  `capy_library_reader`. Credentials are in ignored `.env.local` and the host's
  `/opt/capy-library-db/.env`; never copy them here.
- B2 buckets `capy-notebook-question-bank-public` and `-private`
  (`eu-central-003`). Public assets are served from
  `https://bank-assets.capynotebook.com` through Cloudflare with immutable
  caching.
- `deploy/.env.uat` carries the reader `BANK_DATABASE_URL` and
  `BANK_ASSETS_URL`; `deploy/.env.prod` does not exist locally.
- Do not rerun `setup-backup.py`; it provisions keys and assumes an empty
  lifecycle configuration.
