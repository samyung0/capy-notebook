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

## Whole paper, nothing labelled (same day, after Epo: "upload a single 10 page pdf and nth else should be needed")

Epo ruled out members labelling pages and asked whether one call can mark a
whole paper. `scripts/paper_fixture.py` draws a 10-page handwritten answer paper
for a 16-part, 22-mark quiz with planted mistakes (7 parts wrong). Q6 runs over
pages 5–6, Q10 is answered after Q11, Q7 is a drawn graph and Q12 is blank.
`scripts/paper_marking.py` compares:
- **G1, one call:** every page plus every part's question and items, with a
  bench-only "Whole paper" section after `SYSTEM_PROMPT`, reasoning on, at
  1,568 or 1,024 px.
- **G2, map then grade:** one map call that sees every page at 1,024 px
  (reasoning off) and returns each part's pages. Then one call per part with
  only those pages at 1,568 px: `SYSTEM_PROMPT` + `DRAWN_SECTION` + the
  todo's P1 "Page answers" section, ten at a time, thinking as production
  picks it.

Two runs each (run 2 mostly cached):

| Method | Parts right | Credits, run 1 / 2 | Output tokens (reasoning), run 1 / 2 | Wall s, run 1 / 2 |
|---|---|---|---|---|
| G1 one call, 1,568 px | 15/16, 15/16 | 8.4 / 16.8 | 5,076 (2,483) / 13,801 (10,836) | 21 / 48 |
| G1 one call, 1,024 px | 16/16, 16/16 | 19.3 / 5.0 | 15,197 (12,737) / 3,986 (1,916) | 49 / 12 |
| G2 map + 16 part calls | 16/16, 16/16 | 10.4 / 5.7 (map 1.2 / 0.3) | 4,178 / 3,790 | 11 / 8 |

- **The map was right both times:** every part found its pages, including Q6's
  two pages, the out-of-order Q10 and the blank Q12's page.
- **G1 1,568 px gave Q9 0 of 2 in both runs.** Q9's answer is "cell wall,
  chloroplasts, vacuole"; the other methods gave 2. The reply wasn't kept;
  the likely cause is the bare-list rule (7) read differently in a long reply.
- **G1's cost and time swing about 4× between runs** with how long it reasons:
  the whole paper is one reply. G2's cost is steady and its calls run in
  parallel.
- **What a failure loses:** a G1 failure or cut-off loses every part, while a
  G2 failure loses one part (Not marked, as today). A 40-part paper in one G1
  reply risks the output cap.
- **Cost per member, 10 pages, 16 parts:** about 6–10 credits with G2, against
  roughly 13 for the same parts typed today (about 0.8 a part).

Raw records: `2026-11-08-paper-marking.jsonl` (marks and pages per part,
usage; no model text kept).

## Fewer calls: closed parts read at once, open parts in batches (same day)

Epo asked whether every part needs its own call, since an exam can have 120+
multiple-choice questions. `scripts/paper_batching.py` checks two ways to cut
calls. Two runs each.

**Closed parts need no grading call.** Today they are marked in code against
the key. From a page, the model only has to read which option was marked.
- The sheet: a 120-question bubble answer sheet (A–D), with 10 erased marks
  (a faint fill beside a dark one), 6 double marks and 5 blanks planted.
- One call with no reasoning returns every question's letter, or null for a
  blank, a double mark or a mark it can't read. Code compares the letters with
  the truth, as it would with the key.

| Sheet | Right | Credits | Time |
|---|---|---|---|
| 2 pages of 60, 1,568 px | 120/120, 120/120 | 1.27 / 0.90 | 3 s |
| 1 page of 120, 1,568 px | 104/120, 104/120 | 1.08 / 0.90 | 3 s |

- **60 a page reads perfectly, erased and double marks included.**
- **At 120 a page it fails:** it reads blanks and double marks as letters, and
  shifts some rows by one option.
- So a dense page needs more pixels or splitting: a crop per column, or a
  larger render. Neither was tested.

**Open parts in batches.** Same map call, then several parts a call with their
pages' union (the "Whole paper" section after P1):

| Method | Calls | Parts right | Credits |
|---|---|---|---|
| G2, one call a part | 17 | 16/16, 16/16 | 10.4 / 5.7 |
| Batches of 4 | 5 | 16/16, 16/16 | 9.9 / 12.7 |
| Batches of 8 | 3 | 15/16, 15/16 | 8.0 / 5.5 |
| G1, all 16 in one call | 1 | 15/16, 15/16 (1,568 px) | 8.4 / 16.8 |

- **Batches of 4 matched one call a part.** Batches of 8, like the single
  call, gave Q9's bare list 0 both times.
- **Calls are not what costs.** Output tokens are, and they are the same work
  however it's split. A call only repeats the system prompt, about 1,300
  tokens, mostly cached at 0.03 credits.
- **Batching cuts call count and time, not credits.**

Raw records: `2026-11-08-paper-batching.jsonl`.

Not tested: real scans and photos, pencil marks, options circled on a printed
question paper instead of a bubble sheet, and multi-select, true/false and
matching read the same way.

## One read call: pages, boxes and short answers (same day)

Epo asked whether one call can map every part to its answer, with closed answers
read off the page and marked in code, and whether long, open and drawn answers
could be cropped by a box. `scripts/paper_transcribe.py` sends the 10-page
paper once (reasoning off, prompt `TRANSCRIBE`) and asks per part for its pages,
one box per page around the answer (thousandths of the page), and, for the five
short parts, the final answer written. Boxes are scored against where
`paper_fixture.py` drew each answer: how much of the answer the box covers, as
returned and with a margin of 2% or 4% of the page on every side. Six runs:

| Render | Pages right | Short answers right | Covers ≥ 90%: as returned / +2% / +4% | Credits |
|---|---|---|---|---|
| 1,024 px | 16/16 every run | 5/5 every run | 11–14 / 14 / 16 of 16 in four runs; 0 / 4 / 6 in one | 0.9–1.9 |
| 1,568 px | 16/16 every run | 5/5 every run | 0–8 / 4–6 / 9–11 of 16 | 1.0–2.9 |

- **The page map and short answers hold:** every part's pages right in all six
  runs, the two-page Q6, out-of-order Q10 and blank Q12 included. 3–8 s.
- **Boxes don't:** the same request swings from covering every answer to
  clipping most of them, and the larger render is worse. A crop would sometimes
  cut a student's working off, so it can't stand in for the page.
- So: mark closed parts from the read answers, grade open, long and drawn parts
  from their whole mapped pages (16/16 in the earlier runs), and show the marker
  those pages.

Not tested: reading matching, ordering, fill-in-the-blank and multi-select
answers; real scans and phone photos.

Raw records: `2026-11-08-paper-transcribe.jsonl` (scores and boxes per part).
