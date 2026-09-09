# OpenDataLoader agentic answer comparison

Compare the final native OpenDataLoader output from the September 9 parser
evaluation with existing MinerU output through the current production agent,
tools, chunk storage and hybrid search. Production code and services remain
unchanged. The optional formula-model ODL branch is separate from this primary
native comparison.

Use the same 29 source documents, 663 pages, in two isolated workspaces. Verify
source and coordinate-PDF hashes. Preserve parser-specific extraction and image
selection. Caption selected images using the current production image-only
prompt, filtering and encoding with Alibaba `qwen3.8-flash`; generate current
document summaries with that model. Embed with DeepInfra
`Qwen/Qwen3-Embedding-4B`, 2,560 dimensions. Record all provider attempts and
usage, excluding credentials. Reuse captions only for identical image bytes and
document vectors only for identical embedding inputs and model identity.

Run the current agent directly inside an isolated process, using its real
Postgres search, tools, scope checks, citations and streaming response assembler.
This bypasses application admission, gateway and billing. Provider receipts are
the cost evidence. Use fresh conversations, temperature 0.3, an explicit
65,536-token experiment context budget, 8,192-token output budget and the current
planning-step limit. `enable_thinking=false` matches the previous Qwen experiment;
Qwen is the reasoning/answering model in every condition. Do not substitute
historical answer results for a fresh arm.

Freeze 64 source-grounded questions before looking at new answers: 16 development
and 48 held-out cases. Keep related/translated families together. This is a
shared-source question holdout, not an independent corpus. Old chunk indices
are retrieval hints, not answer gold. Ground rubrics in source PDF pages and
literal values. Explicitly restrict source-scoped missing-evidence questions.
Keep rubric/evidence files out of model inputs.

First compare unchanged retrieval on both parsers. On development cases only,
test generic instructions for using existing document reads to recover table,
list and formula context. Select the smallest measured improvement before
running held-out comparisons. Preserve first attempts including empty/error
responses. No answer-specific prompt, oracle search term or source-PDF bypass
may enter the primary agent arms.

Score correct required claims, claim-to-source grounding and actual citation
support separately. Distinguish extraction absence, retrieval misses, incorrect
association and unsupported answering. Keep latency, provider failures and
tokens separate from answer quality. Inspect representative paired successes
and failures directly against the source. Results are agent source reviews,
not independent human grading or broad generalization guarantees.

If preparation fails, preserve its first outcome and provider receipts. Apply
the production worker's cleanup of incomplete content and mark the source
failed. Keep it in the workspace inventory and keep its questions in the
evaluation. Do not supply a replacement summary or manually retry rejected
content. Report completed-ingest coverage separately from answer quality; a
question about an unavailable source may still produce an abstention or an
unsupported answer through the actual agent.

## Additional retrieval capability, registered before scored runs

Also test an isolated `read_source_page` tool. The agent must choose an allowed
file and page itself after inspecting ordinary retrieved evidence. The tool
renders that exact source PDF page, checks its source hash, and uses the same
image-only Qwen caption prompt. It exposes the resulting page evidence with an
actual source-page citation. Limit it to three page requests per turn and retain
the current overall tool budget. No question or answer rubric enters the image
caption request. Successful identical page images may be reused with their
generation provenance; empty results are retained as failures, never cached.

This is a separate retrieval-plus-page-reading condition. It changes the agent's
available evidence and is not evidence that native parsing alone improved.
Select any use of it on development cases and freeze it before held-out runs.
Report extra provider calls, token use and answer latency separately. A small
additional known-failure diagnostic set covers the earlier parser failures; it
is neither fresh held-out data nor part of the primary 64-question score.

Development conditions are unchanged MinerU, unchanged ODL, ODL with the generic
table-context instruction, and ODL with source-page reading and its generic
instruction. Select a candidate only if its strict grounded-answer count exceeds
unchanged ODL. Among qualifying candidates prefer the higher strict count, then
the higher equal-question mean factual score, then fewer additional Qwen calls.
Resolve remaining ties in favor of the simpler table-context instruction.
Otherwise keep unchanged ODL. Freeze that decision before viewing held-out
answers, and retain unchanged ODL and MinerU as the primary held-out comparison.

## Diagnostic time budget, registered after development and before held-out answers

Development page reading returned five descriptions and four provider errors
near the 15-second interactive timeout. Test the five separately frozen known
parser-failure questions with a 60-second interactive provider timeout for all
three diagnostic conditions: unchanged ODL, unchanged MinerU, and ODL with page
reading. Keep the same model, prompts, source scope, three-page limit and overall
tool budget. Use a separate diagnostic page cache and retain every first attempt.
Run these after candidate selection. The diagnostic results are separate from
the primary held-out score and cannot establish the effect of page reading under
the primary 15-second budget. This diagnostic choice used development outcomes
only.

## Availability diagnostic, registered during held-out execution

Recurring DeepInfra timeouts were observed again after 53 primary attempts.
After the primary run completes, take the union of question IDs for which either
arm has status `empty` or `error`. Run both arms once on every selected question
with the same frozen baseline and a 60-second provider timeout. Select by run
status only, without consulting answer correctness, and preserve the original
question fixture, source scope, model, index and 12-round/tool limits. Record the
selected IDs and primary run hash before the additional attempts. Run this after
the already registered difficult-source diagnostics; make no further retries.

These are additional attempts on a failure-selected subset. They never replace
the primary outcomes and are not an independent held-out quality score. Report
whether a usable answer and source support are recovered, together with added
latency and provider use. A recovery can reflect sampling variability as well as
the larger timeout; it does not by itself prove a parser improvement.
