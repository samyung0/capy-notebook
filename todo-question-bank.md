# Question bank: status and remaining work

The one working file for the bank. How the bank, format, grading and pipeline
work is in [openwiki/question-bank.md](openwiki/question-bank.md) and
[lab/questions/README.md](lab/questions/README.md); Epo's decisions are in
`human/question-bank.md` (and older ones in `human/agentic-retrieval.md`,
`human/frontend/plate-editor.md`, `human/miscellaneous.md`).

## State (2026-10-05)

- **Live bank.** 32 round-2 questions, all unreviewed: Basic properties of
  circles, More about trigonometry and Measures of dispersion (10 each), and
  one IELTS passage each in Society and culture and Health and medicine. The
  other 15 HKDSE units and 5 IELTS subject areas are empty. Topics use the EDB
  unit names and the seven IELTS subject areas; IELTS task types are stored per
  question in `questions.question_types` (bank migration 0002).
- **Code.** On `main`. UAT runs 2400641b, which has the bank page but not
  the chat's bank tools (c8315c43). Production is not promoted and must not be
  until Epo says UAT is ready.
- **Chat.** The agent walks the bank by listing (`list_question_bank`,
  `read_question`) and copies with `copy_questions`, all through Go's
  `/api/internal/bank/{list,read,copy}`; each copied question carries its
  credits. Details in `todo-learning.md` 1.7 and 2.5.
- **Before round 2.** The 1,098 pilot questions are gone from the bank. Their
  dump is `data/question-bank/backups/bank-2026-10-03-before-round2.dump`; the
  pilot run evidence is archived in the private bank bucket.

## Local data (`data/question-bank/`, ignored)

| Path | What |
| --- | --- |
| `analysis/` | Analyses of real papers (HKDSE 2021–2025, Cambridge IELTS 19/20); copies in the private bucket under `analysis/` |
| `references/` | Private past-paper texts for the copy check and readability calibration. Never redistribute |
| `style/` | One writer guide per exam; each topic's `style.md` copies it |
| `round2-2026-10-03/` | The published run: five topic dirs, `REVIEW-BRIEF.md`, `dispatch-log.md`, `gallery/` |
| `web-candidates/` | Openly licensed web passages found for IELTS, with licence evidence |
| `tools/` | Run helpers, called from the repository root (below) |
| `ops/` | Bank provisioning and backup records: `operations.md`, `backup-verification.md`, backup scripts. Do not rerun `setup-backup.py` |
| `backups/` | Bank dumps taken before destructive changes |

## Running a round

Read `lab/questions/README.md` first. Every stage is a fresh `qb-worker`
subagent (Opus 5.5, medium, defined in the ignored `.claude/agents/`) that owns
one topic.

- **Tools.**
  - `tools/bind.py <packet-list> <agent-id>` binds every packet in a list.
  - `tools/closed.py <topic>` lists closed-answer disagreements.
  - `tools/fixq.py <topic> <issues.json>` turns review findings
    (`[{"id", "issue"}]`) into fix packets; run until it prints "applied". It
    cannot change a question's part count: rebuild the topic instead.
  - `tools/apply_packet.py <topic> <packet>` applies an admitted fix packet
    from its frozen input when the payload has since changed.
- **Tunnel.** `ssh -i <key> -N -L 127.0.0.1:15433:10.77.0.2:5433 root@159.195.61.195`;
  the key is `~/.ssh/id_ed25519_capy_ingest` on the Mac and
  `capy_ingest_159_195_61_195` on the Windows PC.
  `.env.local` has CRLF line endings; strip `\r` when reading values.
- **IELTS provenance.** Publishing library passages reads the library database;
  `localhost` hangs on IPv6 through the tunnel:

  ```bash
  export LIBRARY_DATABASE_URL="$(grep '^LIBRARY_DATABASE_URL=' ../.env.local | cut -d= -f2- | tr -d '\r' | sed 's/@localhost:/@127.0.0.1:/')"
  ```

- **Traps.**
  - Editing a prompt in `lab/questions/prompts/` after dispatch changes the
    packet hash. Revert it to admit the packet, then restore it.
  - Bind every agent before rerunning a stage, or the comparison runs on stale
    outputs.
  - Figure sizes are whole pixels; graph terms use `x*0.017453292519943295`,
    not `PI`; write JSON with `json.dump` (heredocs turn `\frac` into a form
    feed).
  - Library excerpts sometimes repeat a paragraph (parser artefact); passage
    writers drop the repeat.
  - Production and UAT both read the bank database. Dump it before deleting or
    relabelling anything, and only with Epo's go-ahead.

## Next

- [ ] **Epo's UAT review** of the 32 live questions. Open point: Health and
      medicine item 10, where the Not given / False call is close.
- [ ] **Full run.** Decide the per-topic totals (exam share from the analyses
      times a subject total) and the floor, then generate every topic in the
      style of `round2-2026-10-03`.
- [ ] **Production.** Promote only after Epo signs off UAT. The bank needs the
      same environment values as UAT (`BANK_*` in `deploy/env-manifest.json`)
      and editor grants as `bank_editors` rows in the production app database.
- [ ] **Backups.** The nightly 03:15 Europe/Berlin dump covers the bank; the
      last restore test was at 200 questions. Repeat it with
      `ops/verify-checkpoint-backup.py` once the full run is published.

## Later

- [ ] **Bank page UI** (handed to a separate session, 2026-10-03): the
      question-type filter and fixes to the editing screens.
- [ ] **Learners answering on `/bank`** (today its runner is read-only) and
      reviewing their mistakes. Unblocked: part 1's FSRS package
      (`server/internal/review`) exists. Needs the bank review screen mock
      first; storage and the retraction flag are "Question-bank progress" in
      `todo-learning.md`.
- [ ] **Copy to quiz** from the bank page. The chat copies already
      (`copy_questions`, `/api/internal/bank/copy`), and the validator accepts
      quiz figures under `BANK_ASSETS_URL`; the page's own button reuses that
      route.
- [ ] **Agent filter by question type.** `list_question_bank` lists by exam,
      subject and topic; IELTS task types (`questions.question_types`) show on
      each question card but are not a filter. Search was tried and dropped
      (`bench/rag/reports/2026-10-04-bank-search.md`); revisit when topics
      outgrow a few pages.
- [ ] **Jev grading for bank open parts.** Round 2 writes closed parts only,
      so this waits until a subject needs open answers.
- [ ] **Answer options** stay plain strings; graph or image options are out of
      scope until decided otherwise.
