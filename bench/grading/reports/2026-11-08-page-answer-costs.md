# Page answers: what a handwritten page costs on 1017 (2026-11-08)

Asked for the file-submissions design (`todo-file-submissions.md`): what each
existing path costs per page when a member's answer is a scanned or
photographed page.

## Setup

- One synthetic handwritten A4 answer page (Bradley Hand on ruled paper, 0.8°
  tilt, light blur, JPEG quality 75): four answered questions, about 20 lines.
  `scripts/page_answer_render.py` renders it at 1,024, 1,280 and 1,568 px on the
  long side, plus a 1,568 × 272 crop of question 3 alone.
- `scripts/page_answer_costs.py` sends each case twice to
  `deepseek/deepseek-v4.1-flash-1017` on OpenRouter, routed `wafer/us`,
  InferenceNet, Cloudflare (the captioning and grading route), with prompts
  read verbatim from the repo: `VLM_PAGE_PROMPT` for the ingest page read, and
  `SYSTEM_PROMPT` (+ `DRAWN_SECTION` for images) for grading. Image cases add
  one line before the question: "The image is a whole page of the student's
  answers. Mark only the answer to the part in <question>; ignore other answers
  on the page." (a bench-only line; production sends no such line today).
- Two parts: Q3 "Solve x² − 5x + 6 = 0" with M1 A1 A1 (thinking, as
  `has_working` picks it) and Q2(a) a two-point biology explanation (plain).
- Credits use the 1017 catalog rate (200 / 20 / 1200 microcredits per input /
  cached / output token). USD is OpenRouter's `usage.cost`. Every call was
  served by Wafer. The key was read from the UAT env file and not printed.

## Results

Run 1 is uncached; run 2 repeats the same request, so Wafer serves the prompt
(images included) from its cache.

| Case | Input tokens | Cached | Output | Reasoning | Credits | USD | s |
|---|---:|---:|---:|---:|---:|---:|---:|
| VLM page read, 1,280 px (ingest) | 785 | 0 | 208 | 0 | 0.41 | 0.000134 | 2.4 |
| VLM page read, 1,568 px | 1,071 | 0 | 207 | 0 | 0.46 | 0.000144 | 3.1 |
| Grade Q2(a) from the whole page, 1,568 px, plain | 2,461 | 0 | 108 | 0 | 0.62 | 0.000148 | 1.7 |
| Grade Q3 from the whole page, 1,568 px, thinking | 2,512 | 0 | 448 | 216 | 1.04 | 0.000319 | 3.9 |
| Grade Q3 from the whole page, 1,024 px, thinking | 1,988 | 1,408 | 523 | 257 | 0.77 | 0.000298 | 3.8 |
| Grade Q3 from a crop of Q3 only, thinking | 1,755 | 1,280 | 293 | 52 | 0.47 | 0.000177 | 1.5 |
| Grade Q3 from typed text, thinking | 1,375 | 1,152 | 357 | 119 | 0.50 | 0.000198 | 2.2 |
| Grade Q2(a) from typed text, plain | 1,308 | 1,152 | 99 | 0 | 0.17 | 0.000067 | 0.9 |
| VLM page read, 1,280 px, repeat | 785 | 768 | 208 | 0 | 0.27 | 0.000112 | 1.4 |
| VLM page read, 1,568 px, repeat | 1,071 | 1,024 | 207 | 0 | 0.28 | 0.000116 | 2.3 |
| Grade Q2(a), whole page, repeat | 2,461 | 2,432 | 108 | 0 | 0.18 | 0.000079 | 1.6 |
| Grade Q3, whole page 1,568, repeat | 2,512 | 2,432 | 565 | 306 | 0.74 | 0.000310 | 2.9 |
| Grade Q3, whole page 1,024, repeat | 1,988 | 1,920 | 512 | 227 | 0.67 | 0.000278 | 2.1 |
| Grade Q3, crop, repeat | 1,755 | 1,664 | 521 | 266 | 0.68 | 0.000281 | 2.3 |
| Grade Q3, typed text, repeat | 1,375 | 1,280 | 425 | 183 | 0.56 | 0.000229 | 2.6 |
| Grade Q2(a), typed text, repeat | 1,308 | 1,280 | 99 | 0 | 0.15 | 0.000063 | 1.3 |

Every grading call gave full marks with the right quotes: the model found the
asked part on a page holding three other answers, at 1,568 and 1,024 px.

## Findings

- **A 1,568 px A4 page is about 1,000 input tokens; 1,280 px about 720;
  1,024 px about 610; a one-question strip about 380.** At the 1017 input rate
  a 1,568 px page adds about 0.2 credits to a call uncached (about 0.02 cached).
- **Output, not the image, sets most of a grading call's cost.** A plain part
  costs 0.15–0.6 credits and a thinking part 0.5–1.0, page or text. A page
  answer costs about 0.2–0.5 credits more than the same answer typed.
- **The ingest page read is charged 1.0 credit flat** (`vlm_ingest_page`)
  against a token cost of 0.27–0.41 credits; reading pages once and grading the
  text would cost about the same as grading the images, with a second place to
  misread handwriting and no drawings.
- **The cost to control is pages × calls.** One call per part: a part that sees
  only its own question's pages stays near 1 credit; a part that sees the whole
  submission pays 0.2 credits per page for every part.

Not tested: real scans and phone photos (shadows, skew, faint pencil), long
answers that run over several pages, Chinese handwriting, a mark scheme
needing a drawn diagram from a page. Synthetic handwriting in a script font is
easier to read than a student's. These go in the grading bench before the
prompt is final.
