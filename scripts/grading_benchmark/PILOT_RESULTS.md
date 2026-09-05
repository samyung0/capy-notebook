# Browser grading pilot, 5 September 2026

All six candidates loaded and completed the pilot on this PC. Gemma 4 E2B
matched the most authored grades. These earlier compatibility results stay
separate from the [larger domain and language comparison](RESULTS.md).

| Browser model | Matching grades | Agreement | Invalid outputs | Median response |
| --- | ---: | ---: | ---: | ---: |
| Gemma 4 E2B, Q4_K_M | 50/70 | 71.4% | 0 | 3.16 s |
| Bonsai 1.7B, Q1_0 | 39/70 | 55.7% | 3 | 1.45 s |
| Qwen 3.5 2B, Q4_K_M | 33/70 | 47.1% | 0 | 1.72 s |
| EngSAF Qwen 2.5 1.5B, Q4_K_M | 30/70 | 42.9% | 0 | 1.42 s |
| Bonsai 4B, Q1_0 | 28/70 | 40.0% | 9 | 2.95 s |
| LFM 2.5 1.2B, Q4_K_M | 13/70 | 18.6% | 3 | 1.01 s |

Always predicting half credit matches 42/70 cases, or **60%**. Most candidates
did not beat that simple baseline on this deliberately partial-answer-heavy
pilot. This is agreement with AI-authored labels, not measured human grading
accuracy. There are only eight source question families: eight English
questions and six translated versions, each with five answers. Forty cases
are English; each other language/script has only five cases. This cannot
establish language or domain rankings.

Independent Codex review found ambiguity in whether four answers must
explicitly restate a mechanism or name a literary device. Excluding those
four cases leaves the same ordering: Gemma 49/66, Bonsai 1.7B 36/66, Qwen
32/66, EngSAF 30/66, Bonsai 4B 28/66, LFM 13/66. The larger corpus states its
credit requirements explicitly and checks that partial answers do not
already convey both criteria.

Gemma overgraded 20 cases and undergraded none in the full pilot. Other
models sometimes credited information the student had not written. Bonsai
1.7B sometimes returned the literal placeholder `one short sentence` as its
reason. A valid score or valid JSON does not establish a useful explanation.

The browser runs used wllama 3.6.0 with WebGPU offload requested in Chromium
152. An NVIDIA Ampere adapter was available, with cross-origin isolation and
four threads. These pilot events did not capture device/offload logs. The host has a
Ryzen 7 3700X, approximately 32 GB RAM and an RTX 3060 Ti with 8 GB VRAM.
Settings were the current application baseline: 1,024 context tokens, 80
output tokens, temperature 0.1, the production grading prompt, full rubrics
and reference answer. Reported response times exclude model loading. The
weights were loaded from localhost; these are not internet download times.

Native CUDA screening matched 50/70 for Gemma, 39/70 for Bonsai 1.7B, 30/70
for Qwen, 28/70 for EngSAF, 26/70 for Bonsai 4B and 14/70 for LFM. Its median
response times ranged from 0.13 to 0.30 seconds. Those timings describe
llama.cpp on this desktop and must not be presented as browser performance.
An additional eight-request-concurrency Gemma pilot matched the same 50
labels; its per-request latency is a different load condition.

The EngSAF weights were converted from the author's pinned Transformers
checkpoint to F16 GGUF, then Q4_K_M using llama.cpp b10809. All general
models use pinned downloaded GGUF revisions. Gemma's browser export was
split into shards for browser loading. This comparison tests the common
Capy grading prompt; it does not assess each model's best possible custom
prompt or other quantizations.

Raw evidence is in ignored `data/grading-benchmark/runs/pilot-native.jsonl`,
`pilot-browser.jsonl` and `pilot-browser-remaining.jsonl`, with server logs,
browser events and JSON summaries beside them. The question set is
[`pilot.jsonl`](pilot.jsonl); independent reviews are under
`data/grading-benchmark/reviews/`. No application model choice or grading
behavior has been changed.
