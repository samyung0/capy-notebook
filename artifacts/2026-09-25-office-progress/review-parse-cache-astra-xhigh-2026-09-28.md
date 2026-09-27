# Parse-cache removal and measurement reviews

Every reviewer below was explicitly configured with `gpt-6-astra` and `xhigh`
reasoning. Reviews were read-only. They read the applicable stored user decisions
and repository rules. No remaining actionable finding was reported in the final
checks of these changes.

| Reviewer | Scope | Result |
| --- | --- | --- |
| `parse_cache_astra_review` | Runtime cache removal, migration, retained local validation/receipts/donors and UAT probes | Stop old parse consumers before migration; resolved in the rollout instructions. |
| `parse_cache_astra_closing` | Fresh removal review and deployment protocol | Prepare initially rejected the deliberately stopped consumers; bounded fix independently rechecked. |
| `provider_receipt_probe_astra_review` | Waiting for uncertain provider receipts in the UAT spend probe | No actionable findings. Existing accounting assertions remain intact. |
| `comment_ci_astra_review` | Comment accessible name and fixture-name isolation after the separate `d5d31d17` merge | No actionable findings. Browser execution remained with the parent. |
| `parse_cache_measurement_astra_closing` | Comparison assembler, report/JSON, migration evidence and closing look at the two CI fixes | One evidence-wording correction verified; no remaining actionable findings. |

## Rollout findings and corrections

The old coordinator uploaded a B2 bundle before registering it. Migration 0038
rejects that retired cache kind, so leaving the old coordinator running during
the app migration could create unregistered objects. The runbook now requires
idle queues and stopped old parse/ingest consumers before the migration, and
keeps them stopped until the matching ingest release activates.

The fresh review reproduced a second problem with that sequence. Deploy ingest
required all previous consumers to be running during prepare. The correction
allows existing stopped consumers with the exact previous revision during
prepare, while rejecting absent or wrong-revision containers. Parser readiness,
activation and recovery still require running containers. The reviewer verified
matching stopped consumers can prepare/activate, missing or mismatched consumers
fail, a stopped previous parser fails, and a stopped candidate worker fails
activation. The parent passed all 19 remote release tests and executed the
reviewed sequence on UAT.

## Runtime and measurement checks

The removal reviews confirmed that full local checksum/archive/manifest/Office
validation remains before the handoff and at extraction. Creator receipts,
atomic continuation, retry source retention, database donors and active-job spool
protection remain intact. Migration 0038 releases only document parse bundles
through the existing reference trigger and grace period; source and paid image/
audio cache references remain. Office probes require real parsing and no cache
row or exact-key B2 version, including hidden versions and delete markers.

The measurement reviewer independently hashed all six paired uploads and all 18
native fixtures, matched the 36 live records to retained snapshots, and checked
all three run manifests for successful cleanup and unchanged ingest identities.
Offline regeneration produced identical JSON and every numeric table row.
Published active payload recomputed to 1,749,174 before and 1,251,716 bytes after.
Observed payload recomputed to 3,488,561 before and 2,493,600 bytes after. The net
92-byte change in other values reconciles both totals to the removed bundles.

The reviewer checked the native totals against September 27, the baseline
provider timeout against its receipt deadline, and migration cleanup against
the original database/B2 observations. Editing checkpoints, user quota,
calculated publication overlap, local ZIPs and retained B2 versions are described
separately. No sampled disk peak or physical expiry is claimed.

The only report correction separated public-marker checks at preflight from
ingest image/container identity checks before and after each run. The reviewer
reread and confirmed the corrected sentence.

The final reviewer did not independently certify the subsequently downloaded
full UAT gate artifacts or the parent's error audit. Those results are recorded
separately in the [measurement report](../../bench/parsers/reports/2026-09-28-office-storage-no-parse-cache.md)
and [rollout evidence](parse-cache-rollout-2026-09-28.json).
