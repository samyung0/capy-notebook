# Evo Notes

Evo Notes is an AI notebook where users can can upload files and study through curated routines and study tools. We want to address the shortcomings of other notebook apps such as NotebookLM, Recall, Copilot Notebooks:

- Lack of helpful tools and study routines that promotes learning behaviors
  - No one reads an AI-generated text-dense summary markdown file
  - The app doesn't know what the user is struggling with
- No support for collaboration
  - Studying with friends is fun, and it makes us want to study more

Here is what I want Evo Notes to be:

- a web application (working on), a mobile application on both android and ios with additional feature supporting pen writing and drawing (not working on)
- a fast and performant application on all platforms, audits for performance regressions, latency testing, stress testing should be made frequently to ensure the user experience is smooth
- offline-ready (an item to be worked on), certain features of the app should not always fail if requests to server fail.
- a foundation for a future platform catering for an entire school's operations: teachers and students study in the platform together, move mundane tasks like sending notices, grading assignments, posting scores etc. into the platform. The current application should provide the capabilities to achieving that: Rag pipelines, storage, AI capabilities, file managements, orchestrations, etc.

IMPORTANT:
The Netcup ingest host runs parser and ingest workloads for production, UAT,
and local development. We plan to separate those environments when the budget
allows it.

## Personal Preferences and Defaults

If `AGENTS.local.md` exists at repository root, read it and treat it as the developer-specific workflow preferences.
Repository requirements comes from the rest of this file (`AGENTS.md`) and takes priority over `AGENTS.local.md`.
If there are conflicts between rules, this file (`AGENTS.md`) takes precedence.

## Small Glossary

Understand the following terms so we can communicate on the same page:

- **user** means the person using the application
- **we, us, developers** means the persons developing the application
- **operators, IT support** means persons who can make use of the ops dashboard (this includes the persons developing application)
- **provider, llm provider** means the company or platform which are providing llm services through proprietary hardware computes (they own the compute/hardware AND the training process), e.g. OpenAI, Anthropic, Deepseek
- **llm routers, llm hops** means the companies or platform which they serve models across providers or redirects to platforms that do that (usually with a different request/response shape than the original provider due to unification across endpoints), e.g. OpenRouter, DeepInfra
- **compute providers, cloud providers** means companies or platform which mainly sells compute services and may or may not provide llm services as well, e.g. Digital Ocean, Nebius, Modal


## Coding Rules

- Read `human` skill for coding tasks. Read `ponytail` skill for coding styles. Read `unslop` skill for user-facing response.
- Keep things simple. Do not preserve existing complexity just because it already exists.
- Do not introduce machinery because it looks architectually impressive. Understand the real constraint and push for the smallest model that solves the issue.
- Tests are good, but endless smoke tests, "regression tests" for feature deletion, etc are not good. Make tests focused.
- Comments are good way to clarify functionality and how code is used, but dont comment every line, make it concise.
- Keep documentation and comments up to date.
- Avoid using type `any` unless absolutely necessary. Inferring types is good.
- Avoid setting defaults and fallbacks without a human signoff, sometime failing explicitly is better than assigning a wrong behavior.

## Documentation - OpenWiki (`openwiki/`)

Mandatory to read when the task touches that domain. Prefer the listed file over guessing from code alone.

| When you need…                                                                                                                                                        | Read                                                                                          |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Roles, share visibility, who can mutate what, account states (`over_quota_*`, suspension, deletion), **who pays** for storage, upload/blob cleanup policy             | `[authorization-permissions-lifecycles.md](openwiki/authorization-permissions-lifecycles.md)` |
| How quota bytes are accounted (`user_storage` / deltas), plan limits, material size/shape bounds, Yjs compaction, reservation/clone gating math                       | `[backend-storage-quota.md](openwiki/backend-storage-quota.md)`                               |
| Ingest → index → hybrid search → chat agent / generate workflows, citations, clone/teardown                                                                           | `[agentic-retrieval.md](openwiki/agentic-retrieval.md)`                                       |
| Plate/Yjs editor, collab tokens/modes (`view`/`comment`/`edit`), checkpoints, projections, comment anchors, AI previews                                               | `[frontend/plate-editor.md](openwiki/frontend/plate-editor.md)`                               |
| Frontend error surfaces, query/mutation defaults, boundaries, offline/streaming behavior, and error test tooling                                                      | `[frontend/error-handling.md](openwiki/frontend/error-handling.md)`                           |
| Trace ids, structured logging, Sentry/PostHog wiring, LLM + parse metering (`usage_events`, credits reserve/settle), rate limiting, operator access                   | `[observability-metering.md](openwiki/observability-metering.md)`                             |
| Manual setup outside this repo: DNS, Cloudflare rules (including Coolify tunnels), origin lockdown, B2 bucket/CORS/lifecycle, Sentry, PostHog, ingest host, operator grants | `[deployment-runbook.md](openwiki/deployment-runbook.md)`                                     |
| What to verify after a UAT deploy: stack health, Clerk/Stripe webhooks, the per-developer dev hostname, quota and bucket sanity, error reporting                       | `[uat-activation-checklist.md](openwiki/uat-activation-checklist.md)`                          |
| Editor Playwright budgets, the manual `Editor perf` workflow, snapshot compare vs last successful run                                                                 | `[editor-perf.md](openwiki/editor-perf.md)`                                                   |
| Inventory of Vitest / Go / Python / Playwright / Cloudflare tests with one-line descriptions                                                                          | `[test-catalog.md](openwiki/test-catalog.md)`                                                 |
| Repository-wide adversarial review, source/UAT workflows, gates, artifacts, Strix, and the `$review-repository` skill                                                  | `[review-automation.md](openwiki/review-automation.md)`                                       |

Cross-links: plate-editor defers structural ACL to authorization and editor perf checkpoints to editor-perf; authorization defers accounting internals to storage-quota; agentic-retrieval defers material quota/authz to authorization and test inventory to test-catalog; observability-metering owns the second budget (inference/GPU) and defers byte accounting to storage-quota. editor-perf defers file inventory to test-catalog and save-cycle render rules to plate-editor. uat-activation-checklist only verifies; every step it checks is set up in deployment-runbook.

## Verification and Cleanup

### Formatting

- run `pnpm run fmt` and `pnpm run fix` to fix and format codes after frontend changes
- run `pnpm run fmt:go` to format golang sever codes
- run `pnpm run fmt:py` to format python codes in pipeline

### Tests

- Use the test scripts in the root `package.json` when available; they set up the required test harnesses. For example, run `pnpm test:go` instead of `go test` directly.
- Update `test-catalog.md`
- Prefer `e2e:slow` on local machines, it uses only one worker and does not drain resources.

## I18n

paraglide is used for internationalization. use paraglide functions to support i18n when appropriate.

## Pull Request

- Do not make a PR unless requested.
- Always use `file-pr` when available.
- Rebase onto main branch before opening.

## Frontend Pitfalls

- IMPORTANT: react-hook-forms and react-query use proxying for tracking whether state/status changes have subscribers or not, you MUST use destructuring to read the values rather than useXXX().isPending or useXXX().isError
- DO NOT directly import from `api/gen/model`, instead re-export type in `api/types.ts`. The file allows for subtle changes such as new frontend only fields on top of the auto generated types.
- Normally we should use useFieldArray for array values, e.g. in TagSelect. However sometimes we don't want to display individual error fields for each rendered element if they are too clustered, like in tagSelect, so we use standard control and dedup and format the error correctly before passing to InputError
- Sometimes its ok to use arbitary values instead of canonical values for tailwind, e.g. w-[200px] instead of w-50, in order to prevent element size changing when switching themes.
- DO NOT use template strings NOR variables just to hold classNames for tailwind, use `cn()` to inject conditional themes
- DO NOT make an index file for UI components, it will lead to cyclical import erorr during vite build

## Final Remarks

- If a rule here fights the work you are trying to do, say so explicitly and get a human sign-off before breaking it.
