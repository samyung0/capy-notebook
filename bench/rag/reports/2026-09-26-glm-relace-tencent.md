# GLM-5.3-Flash: Relace vs Tencent TokenHub, 26 September 2026

A quick look at whether Relace (`models.relace.ai`, `z-ai/glm-5.3-flash`) could
serve the chat pin that Tencent TokenHub (`glm-5.3-flash`) serves today.
Measured from the developer PC (Japan). Runner:
[`glm_provider_latency.py`](../scripts/glm_provider_latency.py); raw samples in
the ignored `data/glm-provider-latency/samples.jsonl`. No earlier GLM chat
latency run exists in `bench/`; the DeepInfra GLM runs in the
[capture-page report](2026-09-12-capture-page-playground.md) recorded quality,
not latency.

Every call streamed, `reasoning_effort` as production sends it, temperature 0,
no retries. "Agent" is the production chat system prompt plus sixteen library
chunks as a `search_workspace` result, about 8k prompt tokens, low reasoning.

## Latency

20 interleaved cycles, random provider order per cycle. TTFT is the first
streamed token, reasoning or answer.

| Workload | Target | TTFT p50 | TTFT p95 | Total p50 | Total p95 | Max |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Agent, 8k prompt | Relace | 1.13 s | 2.23 s | 3.87 s | 7.67 s | 8.26 s |
| Agent, 8k prompt | Tencent | 1.42 s | 2.05 s | 5.13 s | 7.48 s | 9.08 s |
| Short prompt | Relace | 1.39 s | 3.00 s | 3.36 s | 8.15 s | 8.84 s |
| Short prompt | Tencent | 1.49 s | 1.91 s | 3.48 s | 5.10 s | 5.65 s |

Relace is slightly faster at the median, Tencent is steadier at the tail on short
prompts. Decode speed is the same, about 50 output tokens/s on both, well below
the 200 tok/s Z.ai advertises. All 80 calls succeeded. Both honour
`reasoning_effort` low/high/max with matching reasoning-token counts.

## Prompt caching

Three sessions per arm, five turns each, growing the conversation the way the
chat loop does. The system prompt is shared across sessions; the chunks and a
session nonce are not. Cached share of prompt tokens per turn, one number per
session:

| Arm | Turn 0 | Turn 1 | Turn 2 | Turn 3 | Turn 4 | Overall |
| --- | --- | --- | --- | --- | --- | ---: |
| Tencent | 0/0/0 | 30/28/29 | 99/98/98 | 97/98/98 | 98/98/98 | 65% |
| Relace, default routing | 0/29/0 | 0/29/29 | 0/97/99 | 0/97/97 | 0/96/95 | 45% |
| Relace, `prompt_cache_key` per session | 30/29/0 | 30/28/29 | 29/28/28 | 96/27/28 | 95/27/27 | 36% |

- Tencent was the most consistent: every session hit the full prefix from turn 2
  onward.
- Relace's default routing cached like Tencent in two sessions and never hit
  in the third, even on its own prefix. Relace documents caches as per server,
  with requests routed on a fingerprint of the opening messages, so a session
  that lands on a cold or different server gets nothing.
- Setting `prompt_cache_key`, which Relace recommends for session affinity, made
  it worse here: two of three sessions stayed at the shared system prompt (~28%)
  for all five turns. Three sessions is a small sample, but nothing suggests the
  key helps.
- In the latency run, where each prompt was new, Tencent served the shared
  system prompt from cache on 22% of prompt tokens against Relace's 5%.

## Rate limits

Concurrency ramp of tiny requests: 8, 16, 32, then 64 at once per target.

| Target | c8 | c16 | c32 | c64 ok / 429 | Limit message |
| --- | --- | --- | --- | --- | --- |
| Relace | 8/8 | 16/16 | 32/32 | 46 / 8 | per-key "Rate limit exceeded", `Retry-After: 60` |
| Tencent | 8/8 | 16/16 | 32/32 | 39 / 20 | `429002` "exceeds the current model RPM", `Retry-After: 60` |

Both limits are requests per minute: each provider accepted roughly 70-80
requests in the minute before its first 429. Relace documents a rolling 60 s
per-key budget that starts at 15 RPM on free accounts and rises by tier, so this
key is on a higher tier. The remaining c64 failures on both sides (10 Relace,
5 Tencent) were local `ConnectError`s: the connect times doubled (4, 8, 16,
21 s), which is SYN retransmission on this PC, not either API. No headers
report remaining budget on either provider; only `Retry-After` on the 429.

A separate organization key, before any subscription or credit purchase,
accepted the first 22 requests at 2.5 requests/s before its first 429 (about 20 RPM), then
returned 402 `insufficient_quota` ("Out of credits") after 28 successful calls.
Its models list and single calls worked. It needs credits before any use.

A later replacement `RELACE_AI_KEY` (subscribed account) took 300 requests at
5/s with no 429. From a clean window at 20/s, the first 429 came at request 690
and 780 of 900 succeeded within 51 s, so its budget is roughly 700-800 RPM, about
ten times the demo key. Latency held under that load (p50 0.9 s, p95 2.2 s for
tiny requests), and no 402s appeared.

The chat loop makes one request per agent step, so about 75 RPM is a handful of
concurrent users. The Tencent key tested would need a raised limit for
production; the subscribed Relace key above already has one.

## Price

Per million tokens. Relace's live `GET /v1/models` disagrees with its docs
table ($0.09 / $0.018 / $0.30); the endpoint is the stated source of truth.

| Provider | Input | Cached input | Output |
| --- | ---: | ---: | ---: |
| Relace (live `/v1/models`) | $0.040 | $0.015 | $0.50 |
| Tencent TokenHub | $0.111 | $0.032 | $0.389 |

Relace's uncached input costs about what Tencent's cached input does, so
Relace's weaker caching barely moves its bill. The measured turns, priced with
their own measured cache hits:

| Run | Relace $/1,000 turns | Tencent $/1,000 turns |
| --- | ---: | ---: |
| Agent latency run (fresh prompts, Relace 5% / Tencent 22% cached) | 0.40 | 0.83 |
| Multi-turn cache run (Relace 45% / Tencent 65% cached) | 0.34 | 0.60 |

At a 9k prompt and 300 output tokens, Relace ranges from $0.51 (no cache) to
$0.29 (98% cached) per 1,000 turns and Tencent from $1.12 to $0.42. Relace with
no cache hits is still cheaper than Tencent at 65%. Tencent only wins on output,
which matters for long generations such as notes and quizzes: on a 9k-token
prompt Tencent breaks even at about 1,500 output tokens per turn when both cache
98%, and about 2,500 at the measured 45% / 65% hit rates.

## Reading

On latency the two are interchangeable from this machine. Tencent caches more
reliably across multi-turn sessions, but Relace's input price is low enough that
this does not matter: chat-agent turns cost 40-50% less on Relace. The latency and cache runs used a Relace demo key
(about 75 RPM); the subscribed replacement key allows roughly 700-800 RPM, so
rate limits no longer favour Tencent. These are dev-PC numbers from one ~15 minute window.

About 260 requests, under $0.10 across both providers.
