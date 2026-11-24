# Canvas answers: the question's content in the marking image (2026-11-23)

A canvas part is answered on the question's own canvas (Epo 2026-11-23), so the
image the grader reads holds the teacher's text, diagram and boxes as well as the
student's work. Epo asked for a short test before changing `DRAWN_SECTION`, then
whether the grader needs to tell the two apart ("if a question is a complex
diagram, or is partly answered already, or if we add marking scheme later on").

## Setup

- `scripts/canvas_answers.py`, the production prompt, model
  (`deepseek/deepseek-v4.1-flash-1017`) and route read from
  `pipeline/pipeline/retrieval/grading.py`; one call a part, no sample answer, no
  retries.
- Three questions drawn at the marking image's size (1,568 × 980, WebP), the
  student's words in a blue hand:
  - **cell**: "Label A, B and C on the plant cell", three empty boxes. Answers:
    all right (3/3), "chlorophyll" for C (2/3), only A (1/3).
  - **cycle**: the water cycle, with a word bank on the canvas holding every
    answer (its words are the teacher's). Answers: all right (3/3), only stage 1
    (1/3), stages 2 and 3 swapped (1/3).
  - **squares**: "Complete the table of squares"; the teacher filled the first
    row (3 → 9) as a worked example in the same pen and hand the student uses,
    and the marking scheme names that row too, as one written later might. Its
    mark is never the student's. Answers: both rows (2/3), only 16 (1/3), both
    wrong (0/3).
- Conditions (the first line of `DRAWN_SECTION`, and the image):
  - **today**: "the image is the student's work".
  - **plain**: "…the student's work on the question's canvas … The canvas may
    already hold the question's own text, diagrams and boxes."
  - **faded**: the question's content at 40 % over white; "the question's own
    text, diagrams and boxes are drawn faded; the student's work is drawn at full
    strength. Credit only the student's work."
  - **faint**: the question's content at 25 %; "Faded marks are the question's own
    text, diagrams, boxes and worked examples, printed before the student
    answered: they earn nothing, even where they match a marking item. Only marks
    at full strength are the student's work."
  - **pair**: the question's canvas as set as a first image, then the answered
    canvas; "The question's canvas as set comes first: anything already on it,
    worked examples included, is the question's and earns nothing, even where it
    matches a marking item. Credit only what the student's canvas adds to it."

## Results

| Condition | cell + cycle (items matched) | squares (items matched) | Unearned marks |
| --------- | ---------------------------- | ----------------------- | -------------- |
| today     | 36 / 36 (2 runs)             | 18 / 27 (3 runs)        | 9 (every squares answer) |
| plain     | 36 / 36                      | 18 / 27                 | 9              |
| faded     | 36 / 36                      | 18 / 27                 | 9              |
| faint     | 54 / 54 (3 runs)             | 27 / 27                 | 0              |
| pair      | not run                      | 24 / 27                 | 3              |

No failed calls; about 2.4 s a call; the 99 calls cost under $0.01. In every
condition but faint the grader credited the teacher's worked "9" to the student,
quoting it ("3 squared written as 9"), at 40 % fade too. The word bank never
earned a mark. At 25 % the teacher's text, labels and word bank were still read
right (cell and cycle 54/54).

## Decision

Epo took **plain** first (2026-11-23), without "credit only what the student
added". After his follow-up, the squares trap showed one picture needs the
teacher's content told apart, and Epo took **faint** ("Yes, use it",
2026-11-23): the marking image draws the question's parts at 25 % under the
student's work at full strength (`QUESTION_FADE`, `drawingBoard.ts`), and
`DRAWN_SECTION` holds the faint line. Screens, previews and Download as image
are unchanged.
Untested: a student who draws in a very light colour, and a sample answer image
alongside. Raw replies: [2026-11-23-canvas-answers.jsonl](2026-11-23-canvas-answers.jsonl).
