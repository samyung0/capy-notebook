# Local quiz-grading benchmark

Compare small models against Capy's actual rubric-based quiz prompt. This is
an evaluation tool; it does not change the app's model selection or grading.

The reviewed core is 8 domains × 7 language/script groups × 50 questions × 5 answers
= 14,000 grading cases. A translated question is a localized version of its
source family, not an independent question. All versions and answer variants
of a family belong to the same split. The pilot establishes compatibility and
throughput and is excluded from the final test set.

Domains: mathematics, physics, chemistry, biology, computing, history/civics,
geography/economics, language/literature. Groups: en, es, fr, ja, ko, zh-Hans,
zh-Hant. Include native-language cases, matched translations, rubric changes,
and separately identified mixed-language challenge cases.

Codex authors and reviews the expected grades. They are AI-authored/reviewed,
not human-certified. Report provenance, ambiguity, translation review status,
and any incomplete coverage. Do not fill coverage targets with duplicates or
treat automatically translated labels as independently verified.

Use the production prompt from `pipeline/pipeline/retrieve/quiz_grade.py`.
Baseline settings mirror `src/llm-runtime/main.ts`: 1,024 context tokens,
80 output tokens and temperature 0.1. Native runs are screening results;
browser runs must record their actual runtime and GPU adapter. Unsupported
exports, context overflow, timeouts and invalid responses are failures with
their raw output preserved, not zero grades.

Weights, runtimes and raw run artifacts live in ignored
`data/grading-benchmark/`. Pinned source revisions and checksums accompany
downloads. Reports must separate score agreement from explanation review,
show subject/language results, and report how much of the planned set ran.

No hosted judge API is required. An AI-reviewed comparison does not establish
human grading accuracy or performance on weaker student devices.

## Reproduce a run

Python uses only the standard library for the runners. Install wllama 3.6.0
in `data/grading-benchmark/browser-runtime` for the browser page. Downloaded
model files and the llama.cpp b10809 Windows CUDA runtime must occupy the
paths in `benchmark.py`. `prepare.py` downloads pinned Hugging Face files or
official llama.cpp release assets and verifies the published checksums.
[`model_artifacts.json`](model_artifacts.json) records the six original file
sizes, hashes, pinned upstream revisions and download URLs used in this run.
EngSAF needs the documented local Transformers-to-GGUF conversion; its
derived artifact has its own checksum and upstream provenance.

`verified-browser-artifacts.json` records Gemma's five shard hashes and the
wllama runtime hashes. All 601 tensors, their quantization types and shapes,
and 56 model/tokenizer metadata fields were checked against the original
Gemma file. Splitting changes the container, while preserving its weights.

```powershell
python scripts/grading_benchmark/build_corpus.py --require-complete
python scripts/grading_benchmark/benchmark.py validate scripts/grading_benchmark/corpus.jsonl
python -m unittest discover -s scripts/grading_benchmark -p test_benchmark.py
node scripts/grading_benchmark/test_browser.mjs
python scripts/grading_benchmark/benchmark.py run --dataset scripts/grading_benchmark/corpus.jsonl --output data/grading-benchmark/runs/core-native.jsonl --models gemma4-e2b-q4 bonsai-1.7b-q1 qwen3.5-2b-q4 engsaf-qwen2.5-1.5b-q4 bonsai-4b-q1 lfm2.5-1.2b-q4 --parallel 32 --shuffle-seed 20260905
python scripts/grading_benchmark/benchmark.py report data/grading-benchmark/runs/core-native.jsonl
python scripts/grading_benchmark/browser.py --dataset scripts/grading_benchmark/browser-core.jsonl --output data/grading-benchmark/runs/core-browser-reproduction.jsonl --models gemma4-e2b-q4 qwen3.5-2b-q4 --shuffle-seed 20260905
```

Open `http://127.0.0.1:18892/` and press Run browser comparison. The browser
saves results back to the local server. Its resume identity includes the
case, model artifact, settings, browser adapter and implementation. Native
runs also preserve completed cases by their content and configuration.
Interrupted trailing records are preserved before append recovery, including
manifest and event records. Malformed complete records cause an explicit
error. Use a separate output file when changing dataset coverage, case order,
or implementation, or for intentional repetitions. Reports deduplicate repeats
of one case/configuration. The browser command above uses a fresh reproduction
output because the current harness differs from the archived original. Choose
a new filename for each repetition.

Native `--parallel 32` is a throughput setting for the large score comparison.
Use `--parallel 1` for isolated native response latency. Browser measurements
are serial. Keep concurrent GPU work stopped during measured runs. The
manifest and audit files record planned coverage, missing cases and model
failures, including models that produced no grading responses.

Browser load events preserve runtime context and backend logs. A detected
adapter establishes availability only; verify device selection and positive
GPU layer offload in the saved logs before claiming GPU execution. Model
loading and individual grading calls have 180-second deadlines. An inference
exception is recorded with its stack and bounded runtime logs before that
model stops and its worker is released. Other models can then run. Invalid
JSON returned by a completed generation remains a case failure and permits
the next case. A loading timeout stops
the comparison and requires a page reload, because wllama cannot cancel every
initialization phase. Completed results remain resumable.

The failure logging and stop-on-exception behavior were added after a Qwen
browser run developed repeated internal transport errors. Earlier results
retain their original implementation hashes and archived source. The failed
run and diagnostic repetitions remain separate from completed quality runs.

The experiment fixes the sampling seed, disables thinking through the chat
template option and disables prompt caching. The application currently leaves
those options to the runtime. Both use the same grading prompt, temperature,
context limit and output limit. Browser model loading reads local HTTP files
with wllama's model cache disabled; operating-system and shader caches may
already be warm. Load times therefore do not measure internet downloads.

## Dataset construction and review

Each seed row contains a question, two separately assessable required points,
a full-credit paraphrase and a deliberately wrong answer. The builder creates
five answers: the reference itself, the paraphrase, each isolated point, and
the misconception. This controlled set measures instruction and rubric
adherence. It is easier and more artificial than naturally occurring student
work. The reference-copy answers are reported separately. Primary metrics
exclude all 2,800 reference anchors and the 28 ambiguous-label cases described
in `label_exceptions.json`, leaving 11,172 core cases. Eight reviewed label
exceptions change some deliberately wrong answers to partial credit: an
incorrect overclaim does not erase a separately conveyed correct point.
The actual label distribution and majority-class baseline are computed for
every reported group.

Codex authors the English source and grading keys. Local Qwen 3.5 9B Q4_K_M
drafts translations, then Codex reviewers check all strings and supply exact
corrections. Drafts stay outside the corpus. `admit_review.py` applies a
reviewed patch only if its English and draft hashes still match, and records
the admitted hash in `reviewed_seeds.json`. Unreviewed translations and stale
review hashes are rejected by the builder. Review by separate Codex agents
is AI review, not independent human validation or a different-model judge.
Translator identity and draft provenance remain available for assessing
possible stylistic bias. The complete build requires all 56 reviewed cells
and eight native language/literature adaptations per non-English group.
Native adaptations use distinct families; paired Simplified/Traditional
Chinese adaptations share their own Chinese source families. Primary matched
metrics contain only families represented in all seven groups; native metrics
are separate. Review hashes bind translations and label exceptions to the
specific English source version.

The directory's `.gitattributes` preserves file bytes so Git line-ending
conversion cannot invalidate the raw review hashes. Intentional seed or
template edits still require new review records and a separate experiment.

Reports show raw grade agreement and agreement requiring a usable JSON score
and nonempty reason. Explanation correctness is a separate review. Invalid
scores count as failures in agreement, while MAE is explicitly conditional on
valid scores. Macro F1 uses all three grade labels; balanced accuracy averages
recall over the labels present in each group. Confidence intervals resample
source families, keeping translations and answer variants together.

`select_browser_cases.py` chooses source question indices 1, 18, 34 and 46
in every domain/language cell. This gives 224 question versions and 1,120
grading cases per model, selected before full-run results were inspected.
`browser_selection.json` records the selection. Shared native and browser
cases have the same hashes and explicitly controlled decoding settings.
Unspecified sampling defaults belong to the pinned runtimes. The comparison
includes differences in runtime versions, batching and GPU backends.
Each runtime shuffles its
own dataset with the same seed and gives every model that same order. The
full native dataset and smaller browser subset have different permutations.
Their accuracy can be compared on the shared subset;
native request times at concurrency 32 are not isolated browser latency.

After all six native core runs finished, the user requested stopping further
tests of the weaker models. The browser cohort and remaining controls are
therefore limited to Gemma 4 E2B and Qwen 3.5 2B. The selected browser cases
are unchanged. Bonsai 1.7B had already completed its controls when the broader
run was stopped; those results remain in the raw file. `run_scope.json` under
the local data directory records this decision and the resumed Qwen controls.

After both runtimes finish, `compare_runtimes.py` requires complete coverage
against each dataset, checks that every browser case has the identical native
hash, and reports browser-minus-native paired differences on shared cases.
It also requires matching complete prompt-source hashes (including the system
instructions), recorded original model hashes and explicitly
controlled decoding settings, except for native concurrency. Gemma's browser
shards were separately checked for identical tensor bytes and model metadata.

```powershell
python scripts/grading_benchmark/compare_runtimes.py --native-dataset scripts/grading_benchmark/corpus.jsonl --browser-dataset scripts/grading_benchmark/browser-core.jsonl --native-input data/grading-benchmark/runs/core-native.jsonl --browser-input data/grading-benchmark/runs/core-browser.jsonl --models gemma4-e2b-q4 --output data/grading-benchmark/analysis/runtime-pairs.json
```

Use a separate baseline run on the same browser subset when comparing browser
models with literal criterion matching:

```powershell
python scripts/grading_benchmark/baseline.py --dataset scripts/grading_benchmark/browser-core.jsonl --output data/grading-benchmark/runs/core-browser-literal.jsonl
python scripts/grading_benchmark/analyse.py compare --dataset scripts/grading_benchmark/browser-core.jsonl --input data/grading-benchmark/runs/core-browser.jsonl data/grading-benchmark/runs/core-browser-literal.jsonl --models gemma4-e2b-q4 literal-point-baseline --output data/grading-benchmark/analysis/core-browser.json
```

These analysis commands intentionally read the preserved original
`core-browser.jsonl`, rather than the reproduction output above. They select
Gemma because it completed all 1,120 browser cases. Qwen stopped with 318 saved
and 802 unattempted; including it in the
complete-run analysis correctly fails validation. Its runtime allocation
failure reproduced at request 84 in two separate 100-case diagnostic plans.
The diagnostic IDs differ, but their prompt bytes and expected grades match
the first 100 cases of the original shuffled sequence. The first diagnostic
completed 100 attempts with 17 transport failures; the traced diagnostic
stopped at request 84 and logged `std::bad_alloc`. Keep these diagnostic files
separate from quality runs. `analysis/browser-run-status.json` under the data
directory records coverage and artifact hashes. Original runtime source is
archived in `frozen/browser-final-manifest.json`; the logging and failure
lifecycle revision is archived in `frozen/browser-diagnostics-manifest.json`.

To investigate the same sequence with the current failure logging, start a
new Qwen-only output; the runner stops that model on its first runtime error:

```powershell
python scripts/grading_benchmark/browser.py --dataset scripts/grading_benchmark/browser-core.jsonl --output data/grading-benchmark/runs/qwen-browser-reproduction.jsonl --models qwen3.5-2b-q4 --shuffle-seed 20260905
```

## Controls, baseline and explanation review

`build_challenges.py` derives 728 controls from the first source question in
each domain, across all seven groups. Its reviewed templates and source hashes
are bound by `challenge_review.json`. The controls cover three changes:

- 280 cases with a revised rubric that awards credit only for point A.
- 280 cases with answers in another language, English answers for non-English
  questions and French answers for English questions.
- 168 cases with a student instruction attempting to alter the grade, or a
  contradiction that withdraws an otherwise present rubric point.

There are 616 controls after removing reference anchors. These controls share
eight underlying source families, so they are a diagnostic stress test with
limited content breadth. Run them to a separate output file:

```powershell
python scripts/grading_benchmark/build_challenges.py --dataset scripts/grading_benchmark/corpus.jsonl --output scripts/grading_benchmark/challenges.jsonl --review scripts/grading_benchmark/challenge_review.json
python scripts/grading_benchmark/benchmark.py run --dataset scripts/grading_benchmark/challenges.jsonl --output data/grading-benchmark/runs/challenge-native.jsonl --models gemma4-e2b-q4 qwen3.5-2b-q4 --parallel 32 --shuffle-seed 20260905
```

`baseline.py` awards the fraction of complete criterion strings found in the
answer after Unicode, case and whitespace normalization. It retains
punctuation, numbers and operators. This exposes the ease of verbatim partial
answers; it does not understand paraphrases, negation or mixed-language
meaning. Baseline timing and explanation metrics are N/A. A raw `seconds: 0`
is an explicitly unmeasured placeholder used by the shared report code.

```powershell
python scripts/grading_benchmark/baseline.py --dataset scripts/grading_benchmark/corpus.jsonl --output data/grading-benchmark/runs/core-literal-final.jsonl
python scripts/grading_benchmark/analyse.py compare --dataset scripts/grading_benchmark/corpus.jsonl --input data/grading-benchmark/runs/core-native.jsonl data/grading-benchmark/runs/core-literal-final.jsonl --models gemma4-e2b-q4 bonsai-1.7b-q1 qwen3.5-2b-q4 engsaf-qwen2.5-1.5b-q4 bonsai-4b-q1 lfm2.5-1.2b-q4 literal-point-baseline --output data/grading-benchmark/analysis/core-native.json
```

`analyse.py` refuses incomplete coverage, revised case hashes and mixtures of
configurations. It reports paired differences by source family, matched
language contrasts, label confusion, overgrading, undergrading and separate
domain/language results. Its 95% intervals are exploratory and unadjusted for
multiple comparisons. They describe uncertainty across these source families,
not representativeness of student work.

`select_explanation_cases.py` fixed 42 primary cases before full-run outputs
were reviewed: two per grade and language, with domains rotated. The selection
is in `explanation_selection.json`. Export a review packet for a completed
model with `analyse.py explanations`, providing the dataset, result input,
model, selection and output paths. Review the reason against the actual
rubric and answer, including unsupported claims and contradictions between
score and explanation. This stratified qualitative sample does not estimate
the prevalence of explanation errors. The prompt does not mandate the
language of the reason.

The small compatibility pilot is in [`PILOT_RESULTS.md`](PILOT_RESULTS.md).
Its result files are separate from the larger test set.
