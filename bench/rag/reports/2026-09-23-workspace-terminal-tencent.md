# Workspace terminal behavior on Tencent TokenHub

## Result

Do not promote the candidate terminal instruction from this test. Tencent
GLM-5.3-Flash at high reasoning answered all three tools-off replay contexts
without calling tools, even without the candidate. The candidate improved one
GPT-20 reply from plain Markdown to valid OpenUI, preserved the scoped refusal,
and did not fix the supported-author reply's invalid OpenUI quoting.

The earlier Ollama result was a finalization result, not a retrieval-algorithm
improvement. Its only candidate change was one system instruction appended to
the eighth request after tool schemas were removed. Search, ranking, top-k,
chunking, tool schemas and all earlier messages were unchanged. Three exposed
Ollama author turns changed from another tool call and an empty answer to a
supported answer. Different earlier search paths in unexposed turns cannot be
credited to that instruction.

## Exact candidate

> This is the final response for this turn. No tools are available and no
> further calls will be executed. Answer the user's request now using only
> evidence already shown, in the required OpenUI Lang format. Cite the shown
> passages that support each factual claim. If the available evidence is
> insufficient, state the precise remaining evidence gap. Do not claim the
> entire workspace lacks an answer merely because searches did not find it. Do
> not call or propose tools.

No wording was changed for this run. The instruction remains benchmark-only.

## Boundary replay

The replay used complete provider message histories recorded by the frozen
September 21 runtime. Each history was sent twice to Tencent TokenHub
`glm-5.3-flash`, high reasoning, temperature zero and no tools. The candidate
arm appended the exact instruction above. The baseline did not. The supported
and scope-excluded requests had naturally reached the tools-off boundary. The
GPT-20 request had finished early in the old run, so this test removed its tool
schemas to construct the boundary.

| Context | Baseline | Candidate |
| --- | --- | --- |
| Supported Mayor-Rocher/Reviriego, 21 shown passages | Correct people and affiliations; invalid OpenUI because quoted paper titles were not escaped | Correct people and affiliations; same invalid OpenUI problem |
| Relevant paper excluded from scope, 22 shown passages | Valid OpenUI; correctly limits the gap to the selected document | Valid OpenUI; same correct scoped gap |
| Unsupported GPT-20, 7 shown passages | Correctly distinguishes GPT-20 from GPT-2, but returns plain Markdown | Valid OpenUI citing passage 1; correctly distinguishes GPT-20 from GPT-2 |

Both supported-author replies name Mayor-Rocher as affiliated with Universidad
Autónoma de Madrid and Reviriego with Universidad Politécnica de Madrid. The
shown page-1 author passage supports those mappings. Both replies become
unrenderable programs because the title's embedded ASCII quotation marks are
not escaped. This is a serialization failure after evidence retrieval.

Both scope-excluded replies stay within `sesgo-linguistico-digital.pdf` and say
the requested names are absent from the selected source. They do not claim
absence from the whole workspace. Both GPT-20 replies say that the source only
mentions GPT-2. Their MarIA, Biblioteca Nacional Española and 50% statements
are supported for GPT-2 by shown passage 1. The replies explicitly label the
identifier correction rather than presenting those facts as GPT-20 facts.

| Context | Arm | Input | Output | Cache read | Seconds | Valid OpenUI |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| Supported author | Baseline | 13,486 | 600 | 0 | 21.4 | No |
| Supported author | Candidate | 13,577 | 630 | 13,440 | 18.6 | No |
| Scope excluded | Baseline | 18,473 | 265 | 0 | 11.4 | Yes |
| Scope excluded | Candidate | 18,564 | 869 | 18,432 | 31.3 | Yes |
| Unsupported GPT-20 | Baseline | 9,798 | 763 | 0 | 27.1 | No, Markdown |
| Unsupported GPT-20 | Candidate | 9,889 | 496 | 9,792 | 22.4 | Yes |

Candidate calls followed baseline calls and received cache reads for the shared
prefix. These paired timings and token counts do not measure efficiency.

## Current-runtime complete loops

Two fresh complete loops used the current application runtime, the saved
playground chat prompt, current production tool descriptions and Tencent high.
No terminal instruction was injected. The frozen lab database was opened with
`default_transaction_read_only=on`; local source PDFs supplied captures. The
saved chat prompt hash was
`23de9c383f444a21821e0c0fb4478f7e74eef6c81bde2b6f2825ad3983dffde8`.
It differs from the current production English prompt hash
`9e51096281420d468b959a0791a424a0ca88b3d45047a88fb49754aba1877518`
because the saved playground example includes an `AskUser` block.

### Supported author lookup

Question: `Quiénes son Marina Mayor-Rocher y Pedro Reviriego?`

The loop used six searches and one opening document read, then correctly found
both authors and affiliations. It took 252.8 seconds and 76,375 LLM tokens,
including 47,104 cache-read tokens. Retrieval succeeded, although only after
several irrelevant exact-name results and repeated searches. The final answer
starts with prose and then prints a raw OpenUI program. The stored answer is
therefore a current serialization failure after successful retrieval.

This case remains useful for retrieval-loop testing because it exposes the cost
of compensating for weak identifier hits. One case does not establish that a
ranking change is better. The earlier first-chunk catalog and distance-based
abstention candidates did not improve final answers.

### Unsupported GPT-20

Question: `Solo según el artículo seleccionado sobre las variedades del
español, ¿de qué proyecto es GPT-20 y qué datos usó para entrenarse?`

One search found only GPT-2 evidence. The answer says GPT-20 is absent, then
offers GPT-2 as a probable correction and supplies GPT-2's project and training
details. Every factual claim is correctly labeled as GPT-2 and supported by the
retrieved passage. A stricter response could stop after the exact GPT-20 gap,
but that is a prompt-policy choice rather than a factual failure. The definite
failure is plain Markdown instead of OpenUI. It is not a retrieval miss.

## Recommendation

Keep the terminal instruction unpromoted. On Tencent high, the baseline already
finished all tools-off replays. The remaining failures are OpenUI serialization
while the supported author case shows an expensive but ultimately successful
retrieval loop. Preserve these two current
`run.json` histories in the playground for prompt experiments. Any future
ranking candidate should be tested on broader multilingual fresh cases and must
improve final grounded answers, not just isolated hit position.

## Artifacts and checks

The [runner](../scripts/workspace_terminal_tencent.py) records ignored artifacts
under `bench/rag/reports/local/2026-09-23-workspace-terminal-tencent/`:

- `protocol.json`, six replay request/response/result records and `summary.json`;
- `fresh-protocol.json`, two authentic current-runtime `run.json` histories and
  `fresh-verification.json`;
- source request hashes, frozen and current prompt hashes, provider usage and
  elapsed time, without credentials.

The runner passed Python compilation and targeted Ruff formatting/lint. The
explicit read-only connection matched all 29 files and 2,217 chunks before and
after the fresh loops. The already-running lab database container and tunnel
were left running. No application code, prompt, config, database row or source
file was changed.

```sh
.venv/bin/python bench/rag/scripts/workspace_terminal_tencent.py check
.venv/bin/python bench/rag/scripts/workspace_terminal_tencent.py run
.venv/bin/python bench/rag/scripts/workspace_terminal_tencent.py fresh
```
