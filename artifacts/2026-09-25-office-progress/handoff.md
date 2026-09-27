# Handoff (2026-09-27): Office round, last open item

## State

- `main` and `origin/main` are at `4c960717`. CI is green there.
- UAT and its ingest lane run `4c960717`. Migrations 0029–0034 are applied.
- The maintenance window is done and Office editing has resumed. UAT had no `source_documents` rows to publish.
- `vendor/betteroffice` is pinned to `capy-ci` at `04560dd6`.
- UAT journeys: 10 of 13 pass.
  - Rich-content DOCX fails intermittently: 1 pass (run 36277362542, at `17698255`) and 2 failures (runs 36281542884 and 36282937259, at `4c960717`). The DOCX code path is the same in all three.
  - Rich-content XLSX and PPTX have not run on UAT yet, because the suite stops at the DOCX failure.

## Open item: rich-content DOCX two-editor convergence

- **Failure:** `richContent.spec.ts:65` reports "saved docx edits did not converge". The journey polls the saved export for 180 s and waits for both edits:
  - the owner's edit changes `人數：20人` to `24人`
  - the collaborator's edit appends ` Collaborator confirmed the July tour.` after `主題：智能科技，精湛技術`
- **Investigation so far:** it was stopped before it wrote a report, so there are no findings yet. The investigator was building a local two-editor repro harness, `rich.mts`, in the session scratchpad; the harness is not in the repo.
- **Candidate causes, not yet ranked:**
  - a. Journey timing: the caret or keystrokes land before the editor is ready. This would be test-side.
  - b. An edit reaches the room but is never saved. Possible reasons: the save is skipped, a flush race, or the unchanged-save check misreads a real change. That check is `storeSnapshot` in `collaboration/src/sourceDocuments.ts` plus its helper in `contributors.ts`, added in `df08f63e`.
  - c. A merge loss: `replicaCatchUp`, or a remote update that arrives during input.
  - d. The save is just slower than 180 s on UAT.
- **Where to look first:** the failed run's Playwright trace and the saved export. They show which edit is missing. Also check the UAT collaboration logs around the failure time. Everything else rests on that answer.
- **If it's a product bug** (b or c), it is data loss: fix it in the collaboration service and add a focused test. **If it's test-side** (a or d), fix the journey in `e2e/uat/journeys/richContent.ts`.
- Reproduce locally with one worker only (`pnpm e2e:slow` or `--workers=1`).

## Ship after the fix

1. Commit to `main` and push. CI runs on push; nothing deploys on push.
2. Deploy in this order:
   - `deploy-uat.yml` with `revision=<sha>`
   - then `deploy-ingest.yml` with `environment_name` UAT and the same revision (it requires the backend to already serve that SHA)
   - then `uat-quality.yml` with journeys enabled
   - The local helper `$TEMP/capy-rollout.sh` does all of this after CI passes. Edit its `SHA=$(git rev-parse …)` line first.
3. Done when all 13 journeys pass, including rich-content XLSX and PPTX. A run costs about 1¢ in provider calls.

## Loose ends to mention

- Older committed files still contain local paths:
  - `artifacts/2026-09-17-curate-mode-plan.md`
  - two lines in `human/deployment-runbook.md`
- Sentry issue CAPY-BACKEND-J (PoolTimeout from the stale WireGuard peer) stopped at 13:57:38 after the playbook rerun and can be resolved.
- Some tests fail only on Windows, which doesn't affect CI:
  - `fcntl` in `pipeline/ingest/capacity.py`
  - `os.fchmod` in `scripts/env/test_config.py`
  - copytext "access denied"
