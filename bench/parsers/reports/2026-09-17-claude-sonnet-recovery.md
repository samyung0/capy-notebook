# Headless Claude Code Sonnet 4.6 recovery comparison

Date: 2026-09-17 local, 2026-09-16 15:04 to 15:10 UTC. Requested by the
developer after the DeepSeek recovery review, to learn whether Claude Sonnet
can serve selective transcription through the Claude Code harness on the
developer's Max subscription, with no Anthropic API key and no long-running
session as orchestrator.

## Result

Yes on both counts. The Python runner orchestrates one headless `claude -p`
process per crop, so no interactive session stays alive. Sonnet 4.6 at
medium effort returned 16/16 schema-valid transcriptions in each of two runs.
Run 2 passes every frozen check: 57/57 mathematical targets, 36/36 associated
cells, 6/6 complete tables with LaTeX inside HTML cells, 27/27 neighbor
anchors, and the Hefferon wave `v` stays Latin. Run 1 silently corrected the
AHSS printed `0.431(1000)` to `0.0431(1000)` without flagging it, the exact
failure the rubric penalizes. The two runs are the same prompt and image
bytes, so that difference is generation variance, not a prompt effect.

Two costs come with the harness. The CLI adds its own context to every
request, and the account's claude.ai connectors were loaded as MCP servers
until explicitly disabled, which multiplied run 1's input by roughly fifteen
times. Median latency is about six times DeepSeek's. This is a bounded
comparison on 16 manually chosen crops; it selects no production backend and
does not test automatic region selection.

## Method

- Same 16 frozen crops, system prompt, user prompt and JSON schema as the
  Qwen explicit and DeepSeek arms. Image bytes equal the crops the DeepSeek
  review inspected (all 16 SHA-256 match).
- Transport: `claude -p --model claude-sonnet-4-6 --effort medium --tools ""`
  with `--input-format stream-json` carrying the image as a base64 content
  block, `--system-prompt` for the frozen system text, and `--json-schema` for
  structured output. The CLI's StructuredOutput tool call is the response;
  the runner revalidates it locally.
- Run 2 adds `--strict-mcp-config --mcp-config '{"mcpServers":{}}'` and
  `--disable-slash-commands`. Nothing else changed.
- The runner strips `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and
  `ANTHROPIC_BASE_URL` from the child environment, because any of those takes
  precedence over the subscription login. The developer's global settings had
  pointed the CLI at an unreachable third-party router; the developer removed
  that and signed the CLI in before this run.
- Four workers, 300-second timeout, no retries, cached records replay without
  new calls. The CLI exposes no temperature control.

Runner: [`compare_claude_recovery.py`](../scripts/compare_claude_recovery.py).
Receipts under ignored `bench/parsers/reports/local/2026-09-16-selective-recovery/r2/`:
`claude-sonnet-4-6-medium/crops/` (run 1) and
`claude-sonnet-4-6-medium-nomcp/crops/` (run 2), each with `input.jsonl`,
`manifest.json`, `records/`, `results.json`, `summary.json` and
`transcripts/`. Review: `claude-sonnet-source-review.json`.

```powershell
python bench/parsers/scripts/compare_claude_recovery.py check
python bench/parsers/scripts/compare_claude_recovery.py crops --workers 4
```

## Source checks

Same frozen gold, adjudication and abstentions as the earlier reviews. The
`ahss-source-typo` prose anchor `is in $1000s` abstains for every engine; the
LSJ `attended?` exact rowspan abstains. Equivalent LaTeX formatting is allowed.

| Measure | Sonnet 4.6 run 2 | Sonnet 4.6 run 1 | DeepSeek JSON object | Qwen strict schema | MinerU CPU |
| --- | ---: | ---: | ---: | ---: | ---: |
| Semantic math targets | 57/57 | 56/57 | 57/57 | 55/57 | 50/57 |
| Correct associated cells | 36/36 | 36/36 | 35/36 | 32/36 | 27/36 |
| Semantically complete tables | 6/6 | 6/6 | 5/6 | 5/6 | 1/6 |
| HTML tables with LaTeX math cells | 6/6 | 6/6 | 3/6 | 5/6 | n/a |
| Neighbor anchors | 27/27 | 27/27 | 27/27 | 27/27 | 26/27 |

Findings by case, run 2 unless noted:

- `ahss-source-typo`: run 1 wrote `0.0431(1000)`; the crop prints
  `0.431(1000)` after a line using `0.0431`. Run 2 retains both as printed.
  Neither run reported uncertainty here.
- `hefferon-wave-table`: `velocity of the wave $v$`, Latin U+0076, in both
  runs. DeepSeek had substituted Greek `ν`.
- Hefferon tables: exponents as LaTeX in every cell in both runs, where
  DeepSeek used HTML `<sup>`.
- `lsj-formula-table`: `read textbook` spans the two data columns and
  `attended?` uses `rowspan="2"` in both runs. Run 1 wrote the blank corner
  as one `colspan="2"` cell, run 2 as two empty cells; the abstention covers
  that layout.
- Exo7 tables: 9/9 rows each, correct associations, both runs.
- `hefferon-pendulum-table`: run 1 reported two uncertainties, the clipped
  sentence and the untranscribed diagram. Run 2 reported none for the same
  crop. All other uncertainty arrays are empty in both runs.

Run-to-run transcript differences are otherwise formatting: `frac` versus
`dfrac`, `\mathrm` placement, bold versus italic emphasis, table attributes.

## Usage, latency and the harness prefix

Both usage views are kept because they disagree. Per-call usage comes from
the streamed assistant events, which snapshot input at message start and so
under-report output. The CLI result aggregate is what the CLI prices.

| Run | Wall, 4 workers | Median crop | API calls | CLI cache write | CLI cache read | CLI output | CLI list-price estimate |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Run 1, connectors loaded | 80.2 s | 13.8 s | 40 | 299,487 | 2,602,988 | 13,720 | $2.110 |
| Run 2, MCP disabled | 47.9 s | 9.6 s | 19 | 6,876 | 134,256 | 7,118 | $0.173 |
| DeepSeek, 16 crops | 7.35 s | 1.61 s | 16 | n/a | n/a | 3,341 | about $0.003 |

Run 1's first request per crop was about 4.2k tokens. Every later request in
the same crop read a constant 93,921 cached tokens that no first request had
written. The debug log shows the CLI connecting the account's claude.ai
connectors as MCP servers after the first request; their tool schemas then
ride on every following request. `--tools ""` removes only built-in tools.
With MCP disabled, a whole crop costs about 8k cached input tokens, and the
remaining fixed overhead is the CLI's own context, roughly 4k tokens above
the frozen prompt and image. Some crops still took two or more API turns
because the model called StructuredOutput more than once.

The dollar column applies list API rates to the CLI's counts. Nothing was
billed: the subscription serves these requests and every rate-limit event
reported the five-hour window as allowed. Subscription rate limits are not
published, so the quota cost of a larger pass cannot be estimated from here.

## What this does and does not establish

- The harness path works for a developer-run pass on this PC: script as
  orchestrator, headless CLI per request, subscription login, structured
  output, receipts. No live session is needed.
- Sonnet 4.6 medium matches or beats DeepSeek on these crops for format
  compliance and the symbol check, with one silent correction in one of two
  runs. Sixteen crops and two draws do not rank the models.
- Every uncertainty list in run 2 is empty, and run 1's silent correction was
  unflagged. As with DeepSeek, an empty uncertainty list is not evidence of
  correctness and does not authorize automatic replacement.
- The CLI is a coding-agent harness wrapped around one vision call: no
  temperature, an opaque fixed prefix, multi-turn behavior the runner does
  not control, and per-crop latency several times a raw API call.
- Anthropic's support guidance ties subscription limits to ordinary
  individual use and points always-on deployments to API keys. This path
  fits a developer building the curated library locally. It is not a backend
  for the ingest host or ordinary uploads, where DeepSeek remains the
  selected candidate.
- No automatic crop selection was run. The routing gap found earlier is
  unchanged.
