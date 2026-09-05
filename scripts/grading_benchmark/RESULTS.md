# Local grading comparison

All six native core runs are complete as of 2026-09-05 11:19 UTC: 84,000
grading attempts, with no missing or duplicate cases. At the user's request,
further tests were limited to Gemma and Qwen. Their native controls are
complete. Gemma completed its browser pass; Qwen developed a repeatable
runtime allocation exception and its browser coverage is incomplete. Two
short diagnostic repetitions confirmed the failure. Quality rankings below
use completed runs.

Each model grades a supplied student answer against a supplied reference
answer and rubric, using Capy's application prompt. The core questions use
two additive marking points and clean text for short-answer grading.

Gemma 4 E2B Q4_K_M agreed with 80.8% of the primary grading keys. Its main
weaknesses were giving credit to wrong answers and deducting credit from
valid paraphrases. This is a controlled, AI-authored and AI-reviewed corpus;
these percentages do not establish accuracy on real student work.

For the current Capy grading prompt, Gemma is the candidate I would keep.
It led the completed native comparison and finished the full browser subset.
Its remaining grade and explanation errors still need attention before its
grades can be relied on in student work.

| Completed native run | Primary agreement | Family bootstrap 95% interval | Macro F1 | All 14,000 cases | Invalid output |
| --- | ---: | ---: | ---: | ---: | ---: |
| Gemma 4 E2B Q4_K_M | 80.8% | 79.8%–82.0% | 0.792 | 84.7% | 4 / 14,000 |
| Qwen 3.5 2B Q4_K_M | 63.0% | 61.9%–64.0% | 0.670 | 70.2% | 192 / 14,000 |
| Bonsai 1.7B Q1_0 | 43.4% | 42.8%–44.1% | 0.228 | 41.5% | 432 / 14,000 |
| EngSAF Qwen 2.5 1.5B Q4_K_M | 41.4% | 40.5%–42.3% | 0.425 | 52.8% | 192 / 14,000 |
| Bonsai 4B Q1_0 | 34.4% | 33.6%–35.3% | 0.381 | 47.2% | 1,928 / 14,000 |
| LFM2.5 1.2B Q4_K_M | 25.3% | 24.6%–26.1% | 0.210 | 36.8% | 2,233 / 14,000 |
| Literal-point baseline | 74.7% | 74.4%–74.9% | 0.552 | 79.6% | N/A |

Primary metrics exclude 2,800 copied reference answers and 28 labels marked
ambiguous before inference, leaving 11,172 cases. The language, domain and
answer-type tables also use these primary cases. The majority-class baseline
is 50.4%. The literal baseline recognizes complete rubric strings and cannot
understand paraphrases. The isolated partial answers copy rubric wording,
which makes this portion of the corpus especially easy for literal matching.
Gemma's paired advantage over it was 6.2 percentage
points, with an exploratory family bootstrap interval of 4.9–7.3 points.

Bonsai 1.7B frequently assigns half credit to both full-credit and zero-credit
answers. It falls below the majority-class baseline on the primary cases.
Only 64 of 2,800 valid paraphrases received their expected full credit, and
only 57 of 2,744 zero-credit answers received zero. This result describes the
Q1_0 artifact under this production prompt and decoding configuration.

Qwen performs better than Gemma on full-credit paraphrases and misconceptions,
but often awards full credit when only one required point is supplied. It
gave 3,464 primary partial-credit answers full marks. Its overall result is
17.9 percentage points below Gemma, with a paired interval of 16.3–19.2 points.
These different error patterns matter: a ranking on this fixed answer mix
does not establish a ranking for every grading workload.

EngSAF also struggles to allocate partial credit, awarding full marks to
4,060 primary half-credit answers. Its sensitivity to wording is substantial:
98.7% agreement on copied reference answers falls to 46.9% on full-credit
paraphrases of those answers. The result applies to the converted Q4_K_M
artifact with the same application prompt used for the other candidates.

Bonsai 4B scores 34.4% on primary cases. It awards full credit to 4,401
half-credit answers and returns invalid JSON on 1,928 of all 14,000 attempts.
Its 85.1% agreement on valid paraphrases contrasts with 2.4% on point A alone
and 13.7% on point B alone. The larger Q1_0 artifact therefore does not improve
the overall grading result over Bonsai 1.7B under this configuration.

LFM2.5 scores 25.3% on primary cases. It gives the correct zero grade to only
5 of 2,744 zero-credit answers and awards full marks to 3,664 half-credit
answers. Its output failures include 1,916 scores outside the allowed
numeric contract, 314 invalid JSON responses and three missing reasons.
Of those score-contract failures, 1,669 are quoted numeric strings and 247
are numeric values outside the scale. Because the application parser can
accept numeric strings, a post-hoc diagnostic accepts only string values
that convert exactly to 0, 0.5 or 1. LFM's primary agreement then rises to
29.5%; the other five models are unchanged. The headline figures keep the
original contract. This diagnostic leaves malformed JSON and out-of-range
values as failures and does not simulate the application's other coercions.

| Language/script group | Gemma | Qwen 3.5 2B | Bonsai 1.7B | EngSAF | Bonsai 4B | LFM2.5 | Primary cases/model |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| English | 86.6% | 67.0% | 39.7% | 42.9% | 32.7% | 26.1% | 1,596 |
| Spanish | 75.7% | 62.2% | 34.6% | 40.2% | 29.4% | 21.4% | 1,596 |
| French | 79.6% | 58.4% | 39.1% | 47.4% | 30.9% | 25.6% | 1,596 |
| Japanese | 77.1% | 60.8% | 44.7% | 32.1% | 33.4% | 31.0% | 1,596 |
| Korean | 77.6% | 59.8% | 46.9% | 42.5% | 25.9% | 30.4% | 1,596 |
| Simplified Chinese | 85.0% | 65.0% | 49.9% | 42.5% | 46.7% | 18.1% | 1,596 |
| Traditional Chinese | 84.3% | 67.7% | 49.1% | 42.3% | 41.9% | 24.7% | 1,596 |

These totals include language-specific adaptations. Paired comparisons use
only the 392 families represented in every language, 1,564 primary cases per
group. For Gemma on those matched cases, Spanish was 10.7 percentage points below
English, Japanese 9.4 points below and Korean 9.2 points below. Traditional
Chinese was 0.8 points below Simplified Chinese for Gemma; the paired interval spans
−2.4 to +0.8 points, so this run does not clearly distinguish their accuracy.
For Qwen, Traditional Chinese was 2.6 points above Simplified Chinese on the
matched cases, with an exploratory interval of +0.6 to +4.5 points.
The [complete language/domain tables](LANGUAGE_DOMAIN_RESULTS.md) show all
56 combinations for each model, with their denominators.

| Domain | Gemma | Qwen 3.5 2B | Bonsai 1.7B | EngSAF | Bonsai 4B | LFM2.5 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Biology | 89.4% | 67.7% | 45.6% | 45.9% | 38.4% | 30.8% |
| Chemistry | 80.4% | 64.4% | 44.8% | 42.1% | 32.4% | 24.4% |
| Computing | 78.4% | 58.0% | 42.4% | 37.0% | 32.4% | 22.6% |
| Geography/economics | 81.8% | 61.6% | 45.0% | 41.7% | 34.2% | 26.6% |
| History/civics | 84.3% | 67.4% | 43.9% | 43.4% | 36.8% | 25.9% |
| Language/literature | 79.0% | 58.3% | 40.2% | 41.9% | 38.7% | 22.0% |
| Mathematics | 75.4% | 62.4% | 40.9% | 39.0% | 29.2% | 23.7% |
| Physics | 78.1% | 64.1% | 44.8% | 40.3% | 33.4% | 26.5% |

| Answer type | Gemma | Qwen 3.5 2B | Bonsai 1.7B | EngSAF | Bonsai 4B | LFM2.5 | Literal baseline |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Valid full-credit paraphrase | 71.4% | 86.1% | 2.3% | 46.9% | 85.1% | 65.7% | 0.0% |
| Only rubric point A | 92.7% | 15.5% | 77.5% | 10.4% | 2.4% | 18.0% | 100.0% |
| Only rubric point B | 99.0% | 56.8% | 90.6% | 17.5% | 13.7% | 16.8% | 100.0% |
| Misconception, with reviewed partial-credit exceptions | 60.1% | 93.9% | 3.0% | 91.4% | 36.5% | 0.6% | 99.0% |

The native explanation reviews use the same 42 preselected cases per model, balanced
by language and expected grade. They found invented credit, deductions for
equivalent wording and contradictions between reasons and scores. This
qualitative sample does not estimate an explanation-error rate.

| Explanation assessment | Gemma records | Qwen 3.5 2B records | Bonsai 1.7B records | EngSAF records | Bonsai 4B records | LFM2.5 records |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Accurate, specific content | 12 | 24 | 9 | 11 | 21 | 16 |
| Accurate but generic content | 15 | 5 | 3 | 2 | 1 | 13 |
| Wrong or unsupported | 10 | 10 | 16 | 24 | 14 | 9 |
| Explicitly contradicts the stated score | 5 | 3 | 9 | 5 | 5 | 4 |
| Unusable | 0 | 0 | 5 | 0 | 1 | 0 |

A factually correct sentence can still fail to justify an incorrect grade.
The numerical score was correct in 27 of Gemma's sampled cases, 32 of Qwen's
and 12 of Bonsai's; EngSAF had 24 correct scores. This deliberately grade-balanced sample has a different
answer mix from the primary corpus. Bonsai's unusable reasons include three
literal instances of the placeholder "one short sentence." Qwen's overgrades
often invent the missing second rubric point. None of these reviews identified
a concrete grading-key correction in the sampled cases. EngSAF sometimes
explicitly identifies a missing point while awarding full credit; some of
its correct zero grades also come with false accounts of what the student said.
Bonsai 4B had 21 correct scores in this sample, but none of its 14 expected
half-credit grades was correct. Six malformed outputs retained null scores;
their readable reasons were assessed for factual accuracy without recovering
an award from the raw text. Score contradictions require a valid parsed score.
LFM had 14 correct scores in its sample. Many factually accurate reasons
simply repeat reference facts without establishing that the student supplied
them. All 252 records across the six fixed samples were reviewed and checked
against their original response packets.

For example, a student claimed that bacteria consciously change genes on
demand and antibiotics kill only resistant variants. Both claims contradict
the supplied rubric. Gemma awarded 0.5 and attributed a correct mutation
statement to the student that the answer did not contain.

Gemma completed 14,000 native requests in 34 minutes 59 seconds at concurrency
32. Its prompts used at most 414 of 1,024 context tokens. None of its responses
hit the 80-token output limit. Four responses contained malformed JSON. These
bulk-run timings are separate from the serial browser response latency below.

Bonsai completed its native run in 22 minutes 16 seconds. It produced 431
malformed JSON responses and one HTTP 500 inference failure: llama.cpp's
response parser rejected the model's generated format. A total of 374
responses hit the 80-token limit; these counts overlap and must not be added.
Its prompts used at most 494 context tokens. Failures count as incorrect
attempts and are never silently converted to zero-credit grades.

Qwen completed 14,000 requests in 41 minutes 37 seconds. It had 192 malformed
JSON responses and eight responses that hit the 80-token limit. Its longest
prompt used 396 context tokens. The short output limit therefore does not
explain most of its output-format failures.

EngSAF completed 14,000 requests in 19 minutes 54 seconds. It had 178 malformed
JSON responses, 14 responses with no reason, and 18 output-limit hits. Its
longest prompt used 490 tokens. Requiring a usable reason as well as a correct
grade lowers its all-case agreement from 52.8% to 52.7%; its primary agreement
is unchanged because those 14 missing reasons belong to reference anchors.

Bonsai 4B completed its native run in 35 minutes 1 second. Its longest prompt
used 494 tokens. A total of 1,847 responses hit the 80-token limit; this overlaps
with its invalid JSON count and is a material limitation for this artifact in
the application's short-output configuration.

LFM2.5 completed its native run in 15 minutes 45 seconds, the fastest bulk
run among these six artifacts. Its longest prompt used 485 tokens and ten
responses hit the output limit. Its frequent invalid grades therefore have
little overlap with output truncation. Requiring a usable reason changes
primary agreement from 25.331% to 25.322% under the original score contract.

The additional native controls give the following primary results:

| Control | Cases/model | Gemma | Qwen 3.5 2B | Literal baseline |
| --- | ---: | ---: | ---: | ---: |
| Changed rubric: credit only point A | 224 | 67.0% | 82.1% | 75.0% |
| Answer in another language | 224 | 74.1% | 56.3% | 25.0% |
| Student instructions / contradiction | 168 | 57.1% | 40.5% | 66.7% |
| All primary controls | 616 | 66.9% | 61.4% | 54.5% |

Qwen has higher agreement under the single-point rubric, while Gemma leads
on mixed-language answers and the instruction/contradiction group. Neither
model reliably follows all of the supplied grading constraints. These
controls share only eight source families and are diagnostic, with much less
content breadth than the core. The last group contains two instruction
attempts and one answer that explicitly withdraws a previously stated point
per localized question. Gemma has no invalid control outputs; Qwen has three
across all 728 cases, including two among the 616 primary cases.

Gemma and Qwen each completed all 728 controls. Bonsai 1.7B also finished
its controls before the user requested pruning; its raw results are retained.
Qwen's control run resumed six already saved cases after the broader run was
stopped, preserving the same configuration and complete coverage.

Gemma completed all 1,120 selected browser cases. Removing 224 reference
anchors and seven pre-identified ambiguous cases leaves 889 primary cases
from 37 families. Its grade agreement was 78.3%, with an exploratory family
interval of 74.3%–81.9%, and macro F1 of 0.765. All-case agreement was 82.8%.
There were no invalid outputs or output-limit hits.

| Browser outcome | Original model file | Cases saved / planned | Serial median | Serial 95th percentile |
| --- | ---: | ---: | ---: | ---: |
| Gemma 4 E2B: completed | 3.11 GB | 1,120 / 1,120 | 3.50 s | 4.28 s |
| Qwen 3.5 2B: runtime failure | 1.28 GB | 318 / 1,120 | Incomplete | Incomplete |

File sizes use decimal GB. Gemma's response timings cover all 1,120 serial
requests with prompt caching disabled and exclude loading. Its observed load
took 7.87 seconds after a recent compatibility load that took 31.07 seconds.
Qwen loaded in 16.53 seconds in the original pass. Cache warmth differs, so
these load observations do not establish cold-start performance. Runtime logs
confirm WebGPU device selection and positive layer offload for both models.
Reported buffer allocations and GPU snapshots are available with the events;
they do not establish peak or isolated model memory requirements.

| Gemma on the same 889 primary cases | Grade agreement |
| --- | ---: |
| Browser | 78.3% |
| Native CUDA | 77.6% |
| Literal-point baseline | 74.8% |

The browser-minus-native difference is +0.7 percentage points, with a paired
family interval of −0.2 to +1.7 points. The two runtimes gave identical grades
on 873 of 889 cases, or 98.2%. There is no clear accuracy change in this
subset. Comparing the browser's 78.3% directly with the full native core's
80.8% would mix different cases. This comparison checks identical prompts,
case hashes, original weights and explicit decoding settings; runtime
versions, GPU backends, batching and unspecified sampler defaults can differ.

Gemma's browser advantage over literal matching is 3.5 percentage points,
with a wider interval of −0.3 to +7.5 points that includes zero. Its remaining
grading errors include giving half credit to 93 of 217 zero-credit answers
and deducting half credit from 71 of 224 valid paraphrases. It correctly graded
197 of 224 point-A answers and 222 of 224 point-B answers. The complete
browser language/domain matrix is appended to the detailed tables.

Qwen's first browser pass produced 99 valid outputs, one malformed JSON
response and 218 internal `Invalid magic number` errors before it was stopped
at 318 cases, leaving 802 unattempted. The errors began at request 84 and
continued through request 301, followed by 17 responses before the manual
stop. A fresh Qwen-only repetition of the first 100 identical prompt payloads
reproduced the failure at request 84: 82 valid outputs, one malformed JSON
response and 17 transport failures. These repetitions remain diagnostics,
separate from quality results. The original failed records are retained.

The second diagnostic saved 84 attempts and stopped at its first runtime
failure, again request 84. It captured `std::bad_alloc` before the GLUE
deserialization error. This confirms a C++/WASM allocation exception; the
exact allocation site and memory limit were not determined. Source review
found a library error path that can mask this exception as `Invalid magic
number`. Qwen therefore has no completed browser
accuracy or latency estimate here. The partial file's latency statistics
include early failures. The benchmark harness now saves bounded runtime logs
and the error stack, then stops requests to the affected worker and reports
the incomplete run. Its original source remains archived with the original
results; the diagnostic change does not alter the grading prompt or decoding.

The host is a Ryzen 7 3700X with approximately 32 GB RAM and an RTX 3060 Ti with
8 GB VRAM, running Windows 11. Native inference uses llama.cpp b10809 CUDA
12.4. The browser experiment uses wllama 3.6.0 in Chromium 152. Model files
load from local HTTP, so load times will not measure internet downloads.

The core contains 2,800 localized question versions, with five answers each.
There are 400 English source families and 40 additional native families.
Codex authored the English material and keys; local Qwen 3.5 9B drafted the
translations, which Codex reviewers checked and corrected before admission.
Shared translation style can affect these results, and translations and answer
variants do not count as independent source questions.
There are also 728 reviewed controls and a prospectively selected 1,120-case
browser subset per model. The browser phase now covers Gemma and Qwen only.
[Methods and reproduction](README.md) describe the
dataset, prompt, model artifacts, exclusions and uncertainty calculations.

Current machine-readable evidence is in
`data/grading-benchmark/analysis/core-native.json`, with raw native responses in
`data/grading-benchmark/runs/core-native.jsonl`. The native core file is complete.
The same analysis directory contains `challenge-native.json`, `core-browser.json`
and `runtime-pairs.json`; the last two contain Gemma's completed browser
comparison and the relevant baseline or native pairs. `browser-run-status.json`
records Qwen's missing coverage, preserved failures and separate diagnostics.
The seven Python runner checks and the focused browser failure-lifecycle check
passed. Changes are confined to benchmark tooling, datasets and documentation.
Pilot results stay separate in
[PILOT_RESULTS.md](PILOT_RESULTS.md).
