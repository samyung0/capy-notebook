# Canvas levels: parts answering in one canvas (2026-11-23)

Canvas levels let several parts answer in the stem's or a group's canvas, so one
marking image holds the answers to all of them, and each part is graded on it
alone. Epo approved a line for `DRAWN_SECTION` and sending a question's shared
images once per call, then asked for this bench before anything lands ("I'd add
that line and run the canvas bench before landing").

## Setup

- `scripts/canvas_levels.py`. It uses the production prompt and message code read
  from `pipeline/pipeline/retrieval/grading.py`, the model
  (`deepseek/deepseek-v4.1-flash-1017`) and route of `canvas_answers.py`, reasoning
  off, temperature 0, four workers and no retries.
- Marking images are drawn as production draws them: 1,568 × 980 WebP, the
  question's canvas at 25 %, the student's words in a blue hand at full strength.
  A canvas as set (a figure) is a JPEG at full strength.
- **shared**: one call a part, as a check's `/grade`. Each question's two parts
  answer in the stem's canvas, so the canvas is no figure of theirs. The text is
  Go's (`Earlier part 1: …`, `Part to grade: …`). Gold is in brackets, (a) then (b).
  - **cell** (canvas_answers' plant cell). (a) "Label A and B.", (b) "Label C."
    Answers:
    - all right ([1,1] [1]);
    - "nucleus" written at C with B empty ([1,0] [0]);
    - B and C swapped ([1,0] [0]).
  - **values**: boxes "(a) 2 × 8 = □", "(b) 4² = □". Both answers are 16.
    Answers:
    - both right ([1] [1]);
    - (a) 18 ([0] [1]);
    - (b) empty ([1] [0]).
  - **chain**: "A → B → fox". (a) a producer in box A, (b) a herbivore in box B.
    Answers:
    - both right;
    - swapped ([0] [0]);
    - (b) empty ([1] [0]).
  - **times**: one box, no labels. (a) "Work out 3 × 4.", (b) "Work out 2 × 6."
    The one answer is "2 × 6 = 12" ([0] [1]). It holds (a)'s value but is (b)'s
    working alone.
  - **percent**: as times, with (a) 15 % of 80 and (b) 80 % of 15. The answer is
    "0.8 × 15 = 12" (gold [0] [1]). The gold is ambiguous: x % of y is y % of x, so
    this is a valid method for (a) too.
  - Conditions:
    - **today**: `DRAWN_SECTION` as it is;
    - **line**: with "The canvas may hold the student's answers to other parts
      too; mark only the answer to the part in <question>." as its first rule.
  - Three runs each; times two.
- **batch**: two four-part `/grade-batch` calls, ordered as an assignment's
  marking orders them (each question's first parts first), under `SYSTEM_PROMPT`
  + `DRAWN_SECTION` (with the line) + `BATCH_SECTION`. Three runs each.
  - **A**: cell (swapped) and values ((a) 18). Each question's parts share a
    drawing.
  - **B**: chain (swapped) and a triangle question. The triangle question's stem
    canvas (Fig. 1, as set) is a figure of both its parts, and each part answers
    on its own canvas: (a) perimeter, right; (b) area, "3 × 4 = 12 cm²", wrong.
  - Formats:
    - **today**: every part carries all its images;
    - **once**: each image goes with the first part that shows it, and later
      parts point at it.
- **own canvas**: `canvas_answers.py`'s production condition (faint), which now
  holds the line, on its three own-canvas questions, one run (9 calls).

149 calls, about $0.014.

## Results

### One call a part (shared canvas)

| Question | today | line |
| -------- | ----- | ---- |
| cell (3 answers × 2 parts × 3 runs) | 27 / 27 items | 27 / 27 |
| values | 18 / 18 | 18 / 18 |
| chain | 18 / 18 | 18 / 18 |
| times (2 runs) | 4 / 4 | 4 / 4 |
| percent (ambiguous) | 3 / 6, (a) credited 3 of 3 | 3 / 6, (a) credited 3 of 3 |

- No part was credited with another part's answer in any unambiguous case, under
  either condition. That includes a nucleus or chloroplast written in the other
  part's box, two 16s side by side, a swapped food chain and "2 × 6 = 12" next to
  (a)'s 3 × 4. The model quoted only the part's own box, for example "Wrong
  multiplication written; 3 × 4 not shown".
- percent: (a) got full credit for (b)'s unlabelled "0.8 × 15 = 12" in all six
  calls, with and without the line ("Correct calculation giving 12"). The working
  is a valid method for (a) as well, so this is one unlabelled answer credited to
  every part it fits. The line does not change that.
- The line adds 26 prompt tokens a call (2,452 → 2,478) and no time (2.0 s).
- **Own canvas, with the line**: 27 / 27 items, the same as the faint condition
  in [2026-11-23-canvas-answers.md](2026-11-23-canvas-answers.md). The worked
  example "9" earned nothing.

### Four parts a call (`/grade-batch`)

| Call | Format | Images | Prompt tokens | Items matched | Cost (3 calls) |
| ---- | ------ | ------ | ------------- | ------------- | -------------- |
| A (cell + values, shared drawings) | today | 4 | 5,655 | 15 / 15 | $0.00070 |
| A | once | 2 | 3,811 (−33 %) | 15 / 15 | $0.00062 |
| B (chain shared + triangle with a stem figure) | today | 6 | 7,589 | 12 / 12 | $0.00108 |
| B | once | 4 | 5,740 (−24 %) | 12 / 12 | $0.00085 |

- The two formats gave the same shares on all 24 parts, run by run, and every
  share matched gold.
- Each image left out saved about 920 prompt tokens.
- Latency was 2.7 to 3.6 s a call in both formats.

## The message format (the change Epo approved, now in production code)

Before, every `<part>` in a `/grade-batch` call or a paper call sent all of its
images. After, an image an earlier `<part>` of the same call already sent is
replaced by one text line. The line keeps the part's own label and points to
where the image was sent:

```
Figure 1: the same image as Figure 1 in part p2.
Student's drawing: the same image as the student's drawing in part p1.
Sample answer: the same image as the sample answer in part p3.
```

- In a paper call the part ids are the paper's labels ("… in part 1a.").
- A drawing with no sample answer is sent with no label, as before. A later
  part's pointer gives it the label "Student's drawing:".
- The first part to show an image sends it exactly as before. One part's own
  call (`/grade`) and a call with no shared image are unchanged.
- Images are matched by their bytes: Go sends a figure or a drawing's image as
  the same data URL every time it appears in a call.

## Untested

- Shared answers drawn rather than written (lines, arrows, plotted points).
- A third part on the same canvas.
- A sample answer next to a shared drawing.
- Paper calls: their pointer text is the same code, but no paper was run here.
- The percent case suggests the line cannot keep an unlabelled answer that fits
  two parts from earning both. The editor's tip ("AI may allocate marks
  incorrectly for multiple parts on the same canvas") stays the guard.

Raw replies: [2026-11-23-canvas-levels.jsonl](2026-11-23-canvas-levels.jsonl)
(`study`: `shared`, `batch`, `own-canvas`).
