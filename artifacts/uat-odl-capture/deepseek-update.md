# DeepSeek Flash update and model capacities

Verified on 2026-09-13. Changes are local SQL/code; no live database was modified.

`0010_deepseek_flash.sql` replaces the retired Flash Vision catalog identity
with `deepseek-flash`, displayed as DeepSeek Flash 4.1. It preserves credit
rates, configured capacities, supported slots and other model selections.
Historical rows stay available for pinned messages and jobs. GLM remains the
chat default. An operator-created conflicting canonical row causes an explicit
migration error instead of overwriting it.

DeepSeek's [official model table](https://api-docs.deepseek.com/quick_start/pricing/)
identifies `deepseek-flash` as V4.1 Flash with native vision. The model-list API
confirmed `deepseek-flash` availability. The
[thinking guide](https://api-docs.deepseek.com/guides/thinking_mode/) now supports
`max`; the adapter passes it through instead of reducing it to `high`.
Provider invoice prices do not change the application's credit rates.

## Small live test

Four paid requests used the configured UAT DeepSeek key and synthetic content.
They consumed 987 input and 210 output tokens, including 256 cached input tokens.

| Check | Result |
| --- | --- |
| Stream a search tool call, return its result, resume with reasoning continuity | Two live calls passed and the cassette replay passed |
| Read two counts from a generated PNG through the normal image message format | Correct JSON: apples 17, pears 29 |
| `max` thinking through the production adapter | Correct answer 46; reasoning content returned |

The certificate is checked in under `pipeline/tests/cassettes/replay/deepseek__deepseek_flash.yaml`.
Its auth headers were checked for secret removal. Image/max results are in
`deepseek-flash-smoke.json`; the repeatable check is
`pipeline/scripts/smoke_deepseek_flash.py`. These are compatibility checks, not
a document-quality benchmark or a capacity load test.

Offline verification passed: 73 Python adapter/certification tests; the Go
models, store and Ops packages; and three targeted SQL checks for migration
state preservation, catalog conflicts and capacity bootstrap behavior.

## Capacity SQL

`deploy/model-capacities.sql` fills missing rows after migrations. It preserves
operator overrides and uses transport identities, including `tencent` for GLM.
BYOK-only OpenAI models do not take platform leases and need no capacity rows.

| Model | Total concurrent calls | Interactive reserve | Maximum ingest calls | Basis |
| --- | ---: | ---: | ---: | --- |
| DeepSeek Flash | 2500 | 1500 | 1000 | [Official account limit](https://api-docs.deepseek.com/quick_start/rate_limit/) |
| GLM via Tencent | 30 | 24 | 6 | User-selected allocation; confirmed quota is 1,000,000 TPM / 60 RPM per model |
| Qwen embedding via DeepInfra | 200 | 80 | 120 | [Official per-account/model limit](https://docs.deepinfra.com/account/rate-limits) |

Reserves are 80% for Tencent GLM, 60% for DeepSeek and 40% for embedding.
These are application policy, not provider limits. Interactive calls
can use the entire total; the reserve restricts ingest admissions.

Tencent's [quota API](https://cloud.tencent.com/document/api/1823/136110) returns
account/model TPM and RPM. On 2026-09-13 the user confirmed the actual quota as
1,000,000 TPM and 60 RPM per model. Below about 16,667 tokens/request, RPM is the
tighter steady-state limit. With an assumed 30-second call and 10k tokens/call,
the quota supports `min(60, 1,000,000 / 10,000) * 30 / 60 = 30` concurrent calls.
The user selected 30 concurrent calls and 24 reserved for interactive use,
leaving at most 6 ingest calls. Under those assumptions, this implies about
60 RPM and 600k TPM, reaching the RPM limit.
Request duration and size are sizing assumptions, not measured traffic.
Bursts, shorter calls or larger prompts can still exceed provider quotas;
the concurrency gate does not enforce rolling per-minute token/request limits.
An existing GLM 200/120 row remains unchanged by this bootstrap.

Each script application targets one environment. Separate API keys on the same
provider account do not multiply its quota; divide the account budget before
using this script across databases that share an account.

## V4 Pro removal

V4 Pro had no shipped default. It was available as an optional model for chat,
generation and quizzes. The user confirmed there is no production data and
requested direct removal without compatibility handling.

`0011_retire_deepseek_pro.sql` deletes its catalog, capacity and per-model
reasoning preference rows. The capacity bootstrap, certification manifest and
cassette, model picker mock and BYOK text no longer include Pro. Tests use Flash,
GLM or explicit test models where they previously depended on Pro. The frozen
`0001` seed remains unchanged, and fresh databases replay `0011` to remove it.

Final removal checks passed: 70 Python adapter/certification tests, 302 frontend
and editor tests, and the Go models, store, Ops, HTTP API and mail packages.
Formatting/lint checks passed. No live database was changed.
