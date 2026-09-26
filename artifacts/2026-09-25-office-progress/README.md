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
| C1 collaboration and session | Pushed, `a26c7ddc`, fixes `1d3f5008` | `review-c1*.md` |
| C3 ingest host hardening | Pushed, `9c683991`; ansible rule not yet applied on the host | |
| C2 refresh policy, summaries, billing | Pushed, `e4db9568` | `c2.md`, `review-c2*.md` |
| C4 maintenance tooling | Uncommitted in the working tree; review fixes and decided items in progress; migration `0031` waits for the rerank session's uncommitted `0030` (the runner refuses gaps) | `review-c4.md` |
| F1, F2 | On `capy/upstream-merge` (`d1a2972b`), pushed | `f1.md`, `f2.md` |
| F3 | `capy/f3-xlsx` and `capy/f3-docx` pushed; merge into `capy/upstream-merge` plus full fork checks in progress | `f3-xlsx.md`, `f3-docx.md`, `f3-merge.md` |
| Fork review, capy-ci merge, C5, C6, window | Not started | plan |

Another session works on a rerank feature in the same tree (pipeline/elitellm, retrieval search/accounting,
models/slot, ops/src, migration 0030). Stage hunk by hunk; `stage_hunks.py` in the old scratchpad
keeps or drops -U0 hunks by pattern.

Deferred on 2026-09-25: the multi-instance marker check (todo file).
