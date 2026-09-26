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
  `bench/rag/scripts/workspace_opening_agentic.py`; since 2026-09-26 also the knowledge-base
  session's withheld-pages work (`pipeline/pipeline/retrieval/{library,tools}.py` withheld hunks,
  `pipeline/tests/{test_capture,test_library}.py`, `server/internal/ops/testdata/library_schema.sql`,
  `bench/rag/scripts/knowledge_base_library.py`) and the GLM latency session's
  `bench/rag/scripts/glm_provider_latency.py`, its report and its `bench/README.md` lines. For mixed files, stage a blob built from HEAD
  plus the package's hunks with `git update-index`.

## State (2026-09-26, 12:00)

| Package | State | Notes |
| --- | --- | --- |
| Docs, fixtures | Pushed, `a306592f` | |
| C1 collaboration and session | Pushed, `a26c7ddc`, fixes `1d3f5008` | `review-c1*.md` |
| C3 ingest host hardening | Pushed, `9c683991`; the developer applied the nftables rule with the playbook on 2026-09-26; the parser code reaches the host with the next ingest deploy | |
| C2 refresh policy, summaries, billing | Pushed, `e4db9568` | `c2.md`, `review-c2*.md` |
| C4 maintenance tooling | Pushed, `09c946c8`; recheck regressions R1-R6 fixed inside the C5 working tree (R1 depends on C5's quota rule), so the old-pin deploy runs without them | `review-c4*.md`, `c5.md` |
| Rerank (other session's work) | Pushed, `4a47d986`, migration `0030`; UAT's ingest lane must run this pipeline code before UAT migrates `0030` | runbook |
| F1-F3 | On `capy/upstream-merge` (`b8ee465c`), pushed | `f1.md`, `f2.md`, `f3-*.md` |
| Fork review and fixes | Done. `capy/upstream-merge` and `capy-ci` fast-forwarded to `8516544a` on 2026-09-26 (H1, H2, M1-M3, N1, N2, happy-dom, the comment-9 test fix); docx-parse, docx-edit (346), `test:golden` (32) and `test:poc` pass | `review-fork*.md`, `fork-fixes.md` |
| C5 new pin and storage side | Implemented, uncommitted (ships in the window); stored candidate seed dropped; reviewed (`review-c5.md`: 2 medium, 4 low, 6 nits), fixes in progress (M2 goes to C6); `vendor/betteroffice` checked out at `capy-ci` `8516544a` (the pin to commit in the window) | `c5.md` |
| C6 journeys | Written, uncommitted (ships in the window): three rich-content journeys, banner and quota checks, cleanup fix; verified locally against the runtime, not yet on UAT; journeys budgets raised (90 min suite, 95 min step, 150 min job) until the first measured run | `c6.md` |
| Window | Not started; the collaboration image builds at `e912e8e0` | plan |

Another session works on a rerank feature in the same tree (pipeline/elitellm, retrieval search/accounting,
models/slot, ops/src, migration 0030). Stage hunk by hunk; `stage_hunks.py` in the old scratchpad
keeps or drops -U0 hunks by pattern.

Deferred on 2026-09-25: the multi-instance marker check (todo file).

## Deploy order (UAT; nothing goes to production)

Phase A, old pin (C1-C4, rerank, CI fixes):

1. Land the CI fixes on `main` (from the `C:/WEB/cifix` worktree), push, wait for `CI` green.
   Landed and pushed 2026-09-26 as `33453e8f..c5fbc44a` on top of `40683aef` (roles migration
   renumbered to `0032`; C5's migrations are now `0033` and `0034`).
2. `gh workflow run deploy-uat.yml -f revision=<sha>`: migrations `0029`-`0032` apply. Started
   2026-09-26 at `bca522ef` (CI green, run 36241092368; the two e2e fixes `061c1926`, `bca522ef`
   landed first).
3. `gh workflow run deploy-ingest.yml -f environment_name=uat -f revision=<sha>` right after: Deploy
   ingest refuses a revision the backend does not serve, so the app goes first; running UAT
   workers keep their loaded catalog in between (the `0030` coupling, see the runbook).
4. Dry run on the UAT gateway container: `office-maintenance pause`, `status`, `resume`.
5. Done 2026-09-26 by the developer: the C3 nftables rule on the ingest host, verified (parser egress refused at once, `/healthz` ready, container healthy).

Phase B, the window:

6. `pause`; `publish-all` and `status` until `0 unpublished, 0 in flight`. Done 2026-09-26 on UAT
   after Phase A (UAT and its ingest lane at `bca522ef`, dry run passed): paused, `0 requested`,
   `0 unpublished, 0 in flight`.
7. Fork: fast-forward `capy-ci` to the rechecked `capy/upstream-merge` tip; pin `vendor/betteroffice`
   to it; `office:prepare`, `test:collaboration`, `test:office`, `test:golden`, `e2e:slow`.
8. Commit C5, C6, the pin and the CI golden step (hunk-staged, other sessions' work excluded);
   push; `CI` green. Prepared 2026-09-26 as the local, unpushed branch `office-window`
   (`16939bfc` on `c5fbc44a`; clean-tree Go store/httpapi and pipeline refresh tests pass). At the
   window, rebuild it on the then-current `main` with a normal `git commit` (hooks run) and check
   the tree matches.
9. Deploy the UAT ingest lane, then UAT, at that SHA (C5 changes `pipeline/pipeline/store/db.py`);
   `0033` and `0034` run while paused.
10. `resume`; open one file per format in Edit, edit, publish, check quota and `source_documents`;
    then the `uat-quality` journeys with `critical_paths` (paid calls: estimate in `c6.md`).
