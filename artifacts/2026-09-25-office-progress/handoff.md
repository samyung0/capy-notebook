# Handoff (2026-09-27): Office round, last open item

## State

- The released Office baseline is `4c960717`, whose CI was green. Local main has
  since advanced through unrelated work; the test changes below are uncommitted.
- UAT and its ingest lane run `4c960717`. Migrations 0029–0034 are applied.
- The maintenance window is done and Office editing has resumed. UAT had no `source_documents` rows to publish.
- `vendor/betteroffice` is pinned to `capy-ci` at `04560dd6`.
- UAT journeys: 10 of 13 pass.
  - Rich-content DOCX fails intermittently: 1 pass (run 36277362542, at `17698255`) and 2 failures (runs 36281542884 and 36282937259, at `4c960717`). The DOCX code path is the same in all three.
  - Rich-content XLSX and PPTX have not run on UAT yet, because the suite stops at the DOCX failure.

## Investigated: rich-content DOCX two-editor convergence

- **Failure:** `richContent.spec.ts:65` reports "saved docx edits did not converge". The journey polls the saved export for 180 s and waits for both edits:
  - the owner's edit changes `人數：20人` to `24人`
  - the collaborator's edit appends ` Collaborator confirmed the July tour.` after `主題：智能科技，精湛技術`
- **Findings:** see [docx-failure.md](docx-failure.md). A local two-editor control
  against the deployed Office runtime reproduces the original helper's failure:
  the owner count survives, but the collaborator's entire sentence lands in the
  first heading. This is an input-targeting failure, not a missing sentence in
  the combined export. `applyContentUpdate` recognizes the reproduced change.
- **Cause:** the mirror remains mounted while remote layout temporarily gates
  hit testing. Dispatching a click, or checking focus, does not confirm caret
  placement. The input can focus itself or be focused by Playwright before typing.
- **Changes:** the DOCX journey waits for the peer's count edit and the target's
  text cursor before clicking. Failed convergence now attaches saved text,
  checkpoint and epoch. No product code changed and the persistence timeout is
  still 180 s.
- **Verification:** three consecutive local attempts contain both edits in the
  right paragraphs and pass the existing DOCX preservation assertions. The final
  original-helper control fails again. These use a local Yjs relay and native
  export, not UAT database persistence or publication. The full UAT gate is pending.
  The 24 focused contributor/source-store tests, UAT TypeScript check and targeted
  Biome check also pass.
- **Historical evidence correction:** traces were disabled, and the old artifact
  contains neither a final export nor its readable text. Its truncated ZIP error
  cannot establish which edit was misplaced in that particular CI run.
- All local tests must use one worker (`pnpm e2e:slow` or `--workers=1`). The local
  reproduction scripts and raw output are under the locally ignored `local/`.

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
