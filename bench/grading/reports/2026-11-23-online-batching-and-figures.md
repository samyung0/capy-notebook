# Typed answers four to a call, and question figures as images

Two small tests Epo asked for before either prompt change ships (2026-11-23: "test first, small test should be enough, assignment only", and "Bench it first" for figures). Both ran on the grading pin, `deepseek/deepseek-v4.1-flash-1017`, on its production route (wafer/us, InferenceNet, Cloudflare, fallbacks off). The prompt and code come straight from `pipeline/pipeline/retrieval/grading.py`, so "one a call" is what assignment marking sends today. Each condition ran once, with four workers and no retries. The expected marks are AI-labelled, not human-certified.

## Four parts to a call

**Setup** ([script](../scripts/online_batching.py)):
- 68 answers from the committed fixtures:
  - the 20 LaTeX working parts, which are thinking parts;
  - 48 written parts: 16 contract, 8 held-out partial-credit, 8 held-out rubric, 8 zh-Hant and 8 injection.
- Cases the copy check catches are left out, since code scores them before any call in both modes.
- The batch mode sends 17 calls of 4 parts, each part from a different question where the pool allows, as one student's assignment.
  - Thinking parts batch apart from plain ones.
  - Each call uses the same thinking setting, limits and timeout as one part, with max tokens times the part count (capped at 32k, as `/paper` does).

| | One part a call | Four a call |
|---|---|---|
| Calls | 68 | 17 |
| Items matching the expected mark | 160 of 165 | 161 of 165 |
| Unearned marks | 3.5 | 2.0 |
| Missed marks | 0.5 | 0.5 |
| Prompt tokens | 94,221 | 34,839 |
| Output tokens | 11,024 | 11,507 |
| Cost | $0.0068 | $0.0064 |
| Median call time (plain / thinking) | 1.6 s / 2.2 s | 2.7 s / 3.7 s |
| Slowest call | 4.2 s | 5.9 s |

**Findings:**
- **Batching graded as well as one part a call.**
  - The two modes agree on 163 of 165 items.
  - On both parts that differ, the batch is closer to the expected mark:
    - a maths partial, which the batch marks exactly;
    - a contradiction, given 0.5 in the batch against 1 one a call (expected 0).
- **Injections are flagged the same.** All 11 injection answers set `injection_suspected` in both modes, with the same marks. No part in a batch with an injection lost or gained marks.
- **Calls fall to a quarter and prompt tokens by 63%.**
  - Cost barely moves (−6%), as `/paper`'s test found: output tokens drive it.
  - Each call takes about 1.7× as long, which is about 2.4× faster per part.

**Batch section tested** (after SYSTEM_PROMPT, batch calls only):

```
Several parts: this time you mark every part listed in <parts> at once. Each <part> holds its own <question>, <marking_items> and <student_answer> or drawing. Everything above applies to each part on its own.
- Mark each part only on its own answer; what the student wrote for one part earns nothing in another.
Reply with JSON only, one entry per part in the given order: {"parts": [{"part": "p1", "steps": [], "vocabulary_only": false, "injection_suspected": false, "comment": "", "items": [{"id": "m0", "quote": "", "reason": "", "choice": "full"}]}]}
```

Each part goes as `<part id="p1">` around today's user message for one part.

## Question figures as images

**Setup** ([script](../scripts/question_figures.py), [fixture](../fixtures/question-figures.json)):
- Eight questions whose marking needs their figure: a bar chart, a labelled cell, a distance–time graph, a results table, a map, a pie chart, a food web and a triangle.
- Each figure is drawn at 820 × 520 px and has three answers. Some are right, and some read the figure wrongly.
- The description is a short alt text such as "Bar chart of monthly rainfall", without the figure's details.
- All 24 are plain parts with no working pattern, so no thinking, as in production.

**Conditions:**
- **text:** today, `[Figure: description]` in `<question>`.
- **image:** the drafted wording below, `[Figure 1: description]`, and the image after `<marking_items>`, labelled `Figure 1:`.
- **check:** image, plus one sentence asking the marker to check what the answer reads from a figure against its image.

| | text (today) | image | check |
|---|---|---|---|
| Items matching the expected mark | 26 of 39 | 34 of 39 | 34 of 39 |
| Unearned marks | 13.0 | 4.5 | 4.5 |
| Missed marks | 0 | 0 | 0 |
| Cost for 24 parts | $0.0016 | $0.0018 | $0.0022 |

**Findings:**
- **Without the image the grader credits wrong figure readings.**
  - Text only credited 8 of the 9 answers that get the figure wrong: the wrong month, label, value, direction, slice or angle.
  - It has nothing to check them against, so it trusts the answer.
- **With the image:**
  - 5 of those 8 now score as expected.
  - One more is half caught: an angle misread, given 0.5 for method.
  - Two are still credited, where the model misread the figure itself:
    - "B is the vacuole" (B is the nucleus);
    - "Gas is about a quarter" (gas is 40%, wind 25%).
  - Both conditions credit an arithmetic slip (180 − 50 − 60 = 80). It is a plain part, with no working pattern for the model to think on.
- **The check sentence changed nothing.** It gave the same four misses at slightly more cost, so the shorter wording is enough.

**Wording tested** (the `You receive` line of SYSTEM_PROMPT):

```
BEFORE: - <question>: the question text (stem, earlier parts and the part to grade). Figures appear as text descriptions.
AFTER:  - <question>: the question text (stem, earlier parts and the part to grade). An image in the question appears as [Figure N: description], and the image itself follows <marking_items>, labelled "Figure N:". Any other figure appears as a text description.
```

## Limits

- **Small samples:** 68 and 24 parts, each condition run once. The plain parts ran at temperature 0.
- **Synthetic figures:** drawn diagrams, not photos or scans.
- **Untested here:** drawings in a batch, and figures in a batch.
- Raw rows and the figures are in the ignored `data/grading-benchmark/online-batching-20261123/` and `question-figures-20261123/`.
