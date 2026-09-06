# Qwen3.8 Flash agent comparison

Repeat the frozen 48-question curated agent evaluation twice with each of
Qwen3-Embedding-4B at 2,560 dimensions and Voyage 4 Large at 2,048 dimensions.
Compare all 192 new first attempts with the previous DeepSeek Flash Vision
results. Review the complete answers, citations and tool evidence using the
same source-checking protocol, including negative questions.

Qwen runs through the supplied Alibaba Cloud Frankfurt workspace endpoint.
The authenticated model inventory and a streaming tool-call round trip confirm
`qwen3.8-flash`. Use `enable_thinking=false` to match DeepSeek's recorded
`instant` default. Keep temperature 0.3, the frozen agent, system prompt,
reference-following instruction, tools, exact hybrid search, result limits,
timeouts and existing pre-byte retry policy. Record every provider attempt.
The transport asserts the original request disables thinking before mapping it.

Restore the exact cached document vectors for the 532 chunks in both curated
workspaces. Other workspaces cannot contribute to these scoped searches.
Use two temporary tables and exact distances; no ANN measurement is repeated.
New agent queries use the same live embedding routes and query formatting as
the prior experiment. Do not use a cache for those requests.

`qwen38.py` wraps the archived embedding experiment's `chat.py`, `embed.py` and
`run.py`. Those files and their corpus are required in `/lab/qwen38`, alongside
the new adapter and baseline snapshots. The retained original lab lives at
`/lab`; use its frozen Docker image and environment. The adapter sets the
artifact root and scratch schema before calling the archived runner. Run
`qwen38.py setup`, then start an isolated service with `qwen38.py serve`; run
the separate routing pilots before `qwen38.py run`.

The lab database retains its DeepSeek model pin for the unchanged admission
and accounting envelope. It is not the actual answering model. Every Qwen
request and response is recorded separately in `llm-requests.jsonl`, and the
response model must match `qwen3.8-flash`. Lab dollar charges must not be used
as Qwen prices. The comparison does not deploy or register a production model.

Archive and verify all new artifacts locally, check source and original lab
fingerprints, delete only this run's conversations and scratch schema, remove
the temporary service and credential files, and return retained containers
to their original stopped state.

The questions have already been evaluated. Results are a repeated comparison
on known fixtures, not a fresh holdout. Codex source review is not independent
human grading, and the two repetitions are dependent observations.

After all primary attempts finish, `probe.py` replays each empty answer's last
provider request with only `tool_choice="none"` added. It records the original
response ID and request hash alongside the new response. This diagnostic does
not replace primary results, rerun the agent, or alter stored conversations.
Alibaba documents explicit tool disabling in its
[OpenAI-compatible Chat API](https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-openai-chat-completions).
