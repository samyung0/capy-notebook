# Independent final recovery correction review

Reviewed the current working tree on 2026-09-06. No actionable confirmed findings in this bounded correction.

Read the root correction request and implementation report, then independently traced the production hook, recovery grouping/storage functions, Office runtime integration, all four recovery controls, error normalization, streamed chat dispatch, Generate error handling, and English/Chinese copy. No repository edits or native builds were made.

## Recovery lifecycle

- `src/features/files/sourceDraft.ts:96` selects one incompatible lineage and groups all snapshots matching its epoch and Office base hash. Text preserves compatibility across same-epoch published hash changes. Other incompatible groups and current-compatible drafts remain outside that selection.
- `src/features/files/useSourceSession.ts:183` merges every selected recovery snapshot into the presented Y.Doc. `:142` captures only the presented versions, waits for queued writes, uses the existing atomic exact-version cleanup, then reloads. A concurrently replaced version remains stored and is presented again; later incompatible groups become reachable; the current-compatible group then restores and reconnects. The live-session recovery path uses its restored/latest snapshots when no initial recovery group exists.
- Download remains separate from discard. The explicit discard action appears in text, DOCX, XLSX and PPTX recovery controls, and is disabled while its operation runs. Cleanup errors retain recovery and expose the failure.
- `src/features/files/useOfficeRuntime.ts:132` remounts on a changed Y.Doc identity, including recovery groups with the same epoch and different Office base bytes. The capability gate at `:225` pauses an old editing frame while discarding or reconnecting and clears previous frame errors when switching documents. The corresponding text binding replaces its document when recovery advances.

## Source changed error

`src/lib/errors.ts:78` recognizes `source_changed` before generic HTTP status classification and returns the localized retry description. Generate already uses `describeError`. Streamed chat maps the code in `src/api/chatStream.ts:55`, covering both the initial HTTP failure and SSE error dispatch at `:209`; `useChatStream` displays that supplied message on the failed turn. English and Chinese messages describe the source changing during this request and ask the user to retry. No automatic retry or historical-citation notice was introduced.

## Verification and limits

- Independently ran `pnpm exec vitest run src/features/files/sourceDraft.test.ts src/lib/errors.test.ts`: 2 suites, 21 tests passed. These cover merged recovery lineage, other-base/current-group preservation, same-epoch text compatibility, and coded error descriptions.
- Read the implementation's real-IndexedDB/actual-hook browser probe and result. It exercises a concurrent draft version update, repeated explicit discard, same-epoch/different-base recovery, and restoration/reconnection of current drafts. I did not repeat that browser probe or the previously verified Office input/IME checks in this bounded review.
- Office remount/reconnect behavior and streamed error integration were statically traced; no new authenticated end-to-end session or real distributed service test was run. The prior full source review and its limits remain in `/private/tmp/capy-source-frontend-final-rereview.md`.
