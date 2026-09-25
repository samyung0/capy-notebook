# Office round: progress and how to resume

The plan is `artifacts/2026-09-25-office-implementation-plan.md`; decisions are in `human/`
(mainly `human/frontend/office-files.md`). Each agent writes its own note in this folder.

## Standing permissions from the developer

- Committing and pushing are approved; commit each package when it is suitable.
- No one uses UAT: deploy there and run the maintenance window without asking.
- Keep the developer's unrelated uncommitted work out of commits:
  `.agents/skills/html-communication/SKILL.md`, the knowledge-base records in
  `human/agentic-retrieval.md`, `lab/knowledge/*`, `lab/playground/configs/curate.json`, a few
  lines of `openwiki/agentic-retrieval.md`, `pipeline/pipeline/prompts/curate.py`,
  `pipeline/tests/test_odl_local_integration.py`, `bench/README.md`, `bench/rag/*` except
  `bench/rag/scripts/workspace_opening_agentic.py`. For mixed files, stage a blob built from HEAD
  plus the package's hunks with `git update-index`.

## State (2026-09-26)

| Package | State | Notes |
| --- | --- | --- |
| Docs, fixtures | Pushed, `a306592f` | |
| C1 collaboration and session | Pushed, `a26c7ddc` and fixes `1d3f5008` | `review-c1.md`, `review-c1-recheck.md` |
| C3 ingest host hardening | Pushed, `9c683991`; ansible rule not yet applied on the host | |
| C2 refresh policy, summaries, billing | Done, uncommitted in the working tree; review running | `c2.md`, `review-c2.md` |
| F1 upstream merge | Done on `capy/upstream-merge` in `C:\WEB\betteroffice-merge` | `f1.md` |
| F2 fork fixes | Committed up to `1f205f92`; final test run and push in progress | `f2.md` |
| C4 maintenance tooling | Not started; after C2 is committed | plan C4 |
| F3, C5, C6, window | Not started | plan |

Deferred on 2026-09-25: the multi-instance marker check (todo file).
