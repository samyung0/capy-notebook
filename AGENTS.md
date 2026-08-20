Developers and maintainers of this repository is allergic to semantic jargons and difficult words. Answer in simple words and in anime styles and make it fun, otherwise the project will be abandoned, leading to catastrophic consequences.

## OpenWiki (`openwiki/`)

Read these only when the task touches that domain. Prefer the listed file over guessing from code alone.

| When you need…                                                                                                                                                        | Read                                                                                          |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Roles, share visibility, who can mutate what, account states (`over_quota_*`, suspension, deletion), **who pays** for storage, upload/blob cleanup policy             | `[authorization-permissions-lifecycles.md](openwiki/authorization-permissions-lifecycles.md)` |
| How quota bytes are accounted (`user_storage` / deltas), plan limits, material size/shape bounds, Yjs compaction, reservation/clone gating math                       | `[backend-storage-quota.md](openwiki/backend-storage-quota.md)`                               |
| Ingest → index → hybrid search → chat agent / generate workflows, citations, clone/teardown                                                                           | `[agentic-retrieval.md](openwiki/agentic-retrieval.md)`                                       |
| Plate/Yjs editor, collab tokens/modes (`view`/`comment`/`edit`), checkpoints, projections, comment anchors, AI previews                                               | `[frontend/plate-editor.md](openwiki/frontend/plate-editor.md)`                               |
| Frontend error surfaces, query/mutation defaults, boundaries, offline/streaming behavior, and error test tooling                                                      | `[frontend/error-handling.md](openwiki/frontend/error-handling.md)`                           |
| Trace ids, structured logging, Sentry/PostHog wiring, LLM + GPU metering (`usage_events`, credits reserve/settle), rate limiting, operator access                     | `[observability-metering.md](openwiki/observability-metering.md)`                             |
| Manual setup outside this repo: DNS, Cloudflare rules (including Coolify tunnels), origin lockdown, B2 bucket/CORS/lifecycle, Sentry, PostHog, Modal, operator grants | `[deployment-runbook.md](openwiki/deployment-runbook.md)`                                     |
| How to run pipeline cassette tests and their disposable Postgres/Redis setup                                                                                          | `[pipeline-tests.md](openwiki/pipeline-tests.md)`                                             |
| Inventory of Vitest / Go / Python / Playwright / Cloudflare tests with one-line descriptions                                                                          | `[test-catalog.md](openwiki/test-catalog.md)`                                                 |

Cross-links: plate-editor defers structural ACL to authorization; authorization defers accounting internals to storage-quota; agentic-retrieval defers material quota/authz to authorization and test infra to pipeline-tests; observability-metering owns the second budget (inference/GPU) and defers byte accounting to storage-quota.

## Getting Started

### Code Changes

- run `pnpm run fmt` and `pnpm run fix` to fix and format codes after frontend changes
- run `pnpm run fmt:go` to format golang sever codes
- run `pnpm run fmt:py` to format python codes in pipeline

### Test Changes

- update `test-catalog.md`
- Re-record pipeline cassette tests (`pipeline/tests/cassettes/*.yaml`) when a request-shaping change alters an outbound body: prompt edits, `indexed_text` / embedding input, model or embedding-dimension changes, or chunking changes. Delete the YAML first, then `EVO_TEST_RECORD=once`. Do not loosen the body matcher to make a stale cassette replay.

### I18n

paraglide is used for internationalization. use paraglide functions to support i18n when appropriate.

## Common Pitfalls

### Frontend

- IMPORTANT: react-hook-forms and react-query use proxying for tracking whether state/status changes have subscribers or not, you MUST use destructuring to read the values rather than useXXX().isPending or useXXX().isError
- DO NOT directly import from `api/gen/model`, instead re-export type in `api/types.ts`. The file allows for subtle changes such as new frontend only fields on top of the auto generated types.
- Normally we should use useFieldArray for array values, e.g. in TagSelect. However sometimes we don't want to display individual error fields for each rendered element if they are too clustered, like in tagSelect, so we use standard control and dedup and format the error correctly before passing to InputError
- Sometimes its ok to use arbitary values instead of canonical values for tailwind, e.g. w-[200px] instead of w-50, in order to prevent element size changing when switching themes.
- DO NOT use template strings NOR variables just to hold classNames for tailwind, use `cn()` to inject conditional themes
- DO NOT make an index file for UI components, it will lead to cyclical import erorr during vite build
