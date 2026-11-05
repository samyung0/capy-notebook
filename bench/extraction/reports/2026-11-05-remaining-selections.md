# Make a quiz: the selections not yet run (2026-11-05)

Step 3 of the answer files work, through the finished route. Epo: "sure keep going dont ask me". Script:
`scripts/selections.py`. Papers, answers and Epo's images stay in the ignored `.results/selections/`, and nothing here
quotes them. All 1017 on the extraction route, Mac. Few runs each, so these show what breaks, not rates.

## Verdict

**The route holds on all of them after five code fixes these runs forced.** The worst was a paid 40-page run that saved
every question with no answers. Word, PowerPoint and text papers work end to end in the pipeline and gateway, but the
dialog doesn't offer them yet.

| Selection | Runs | Wall s | Billed | Result |
|---|---:|---|---:|---|
| Cut: starts inside a question | 3 | 36-58 | $0.0041 | Both questions found, and only what is on the pages copied. Nothing tells the user Q1 is cut. A worked-out key differed between runs on one part |
| 40 pages, three papers, 102 questions | 1 fixed | 256 | $0.1056 | Stops at the 100-part limit with 90 saved and all answered. 2022 P2 keys 44 of 45 right |
| Prints its own answers | 4 | 26-33 | $0.0024 | 3 of 3 questions right in all 4, from the key on the page. Teacher's notes not copied as questions |
| Dense, small print | 2 | 80-94 | $0.0088 | 13 questions found, the same answers in both. No key checked |
| Chinese, with 71-page scheme as text | 2 | 146, 352 | $0.0168, $0.0475 | 9 questions, marks matching in both. One run lost 4 parts' answers and took 41 calls: fixed below, not rerun |
| Chinese, no scheme | 1 | 131 | $0.0104 | 9 questions, the same marks |
| Word paper stand-in, no scheme | 3 | 91-126 | $0.0124 | 10 questions, all answered. Q7's split wrong in all 3, Q8's in 1 |
| Word paper stand-in, with scheme text | 3 | 118-132 | $0.0134 | 10 questions, all marks right in all 3 |
| Whiteboard, working rule | 6 | 15-25 | $0.0016 | Found and right in 6 of 6, working in the question in 0 of 6, against 2 of 6 without the rule |

The Word stand-in is 2021 P1's page reads treated as one file's indexed text. No real Word or PowerPoint file went through
the parser here, and production's indexed text may differ.

## What broke, and the fixes

| Fault | What happened | Fix |
|---|---|---|
| **A full quiz skipped every solve call** | 40 pages hit the 100-part limit while copying, so the run saved 88 questions with no answers, at about $0.05 | Copying stops, and what was copied still gets answers. The run then costs $0.1056 |
| **Whole-file paper over its output budget** | It counted as one page, so its 8,000 tokens ran out on the first copy call and nothing was saved | One page of budget for each 500 characters, up to 40 |
| **Part labels of other scripts all read the same** | `label_key` keeps only Latin letters and digits, so ① and ② both became empty and collided. One Chinese run lost those answers, and I think this also explains its 41 calls | Any letter or number is kept. Covered by a test, not rerun: the budget stop was reached |
| **A long scheme with a few scanned pages** | It counts as a scan, so all 71 pages would go as images. Production would refuse it at the cap, and the bench's 77 images stalled the provider past 15 s | Pages that don't fit the images left go as indexed text. Refused only with no text |
| **A failing question check ended the paid run** | Found by the landing session, not seen here | One retry, then only that thread ends, and the model is told nothing |
| **A map row called `none`** | Saved as a question labelled "none" | It is no row |

## Answer text and the provider

Size wasn't the problem I first took it for. The map's first event, with the 6 page images and growing answer text:

| Answer text | Input tokens | First event |
|---|---:|---:|
| 12,000 Chinese characters | 17,161 | 2.6 s |
| 47,961 Chinese characters | 43,998 | 3.7 s |
| 24,000 English characters | 21,622 | 3.4 s |
| 51,640 English characters | 36,537 | 2.8 s |

One call each. A 40-image map (44,000 tokens) has also started in time, though one attempt in that set missed 15 s and was
retried. Earlier failures here with long silences were the Mac sleeping, so they say nothing about the provider.

## Two papers with the same question numbers

The map adds its own prefix, such as a year, and copy calls sometimes dropped it, which named copied questions as missing and
put them out of order. I changed the label's description in both tools. One run after the change kept every label, which is
too few to call it fixed.

## Wording changed in production

Shown to Epo before these runs:

| Where | Before | After |
|---|---|---|
| `label` on both tools | `The question number, e.g. "7".` | `The question's label from the map, e.g. "7".` |
| Leave out line | `Leave out answer lines, boxes for working, "Answers written...` | `Leave out answer lines, boxes for working, working written under a question, "Answers written...` |
| Word, PowerPoint or text system prompt, first paragraph | none | `You copy the questions in the selected files into a quiz, exactly as they appear. You see their indexed text at once. After the questions may come answer files: a mark scheme, an answer key or someone's own answers, in any layout.` |
| Its page heading | none | `Page 1 of <file name>. Its indexed text:` then a `<source>` block |

That system prompt has no figures paragraph, and its message has no boxes. The working rule ran on Epo's two images only, not
on a paper. Its worksheet runs still misread marks in some runs, so it doesn't help there. The rest of the prompt is
`todo-study-tracking/R6-extraction-prompt.md`.

## Epo's samples

| Paper | Run | Wall | Billed | Credits | Result |
|---|---|---:|---:|---:|---|
| S5 M2 mock, born digital, 12 pages | 2 | 126-143 s | $0.0163 | 33.7-39.6 | 13 questions, all answered. The paper prints no marks, so each part has 1. The system of equations comes back as `\\begin{cases}` and KaTeX renders that form |
| The same, as text with no images | 2 | 139-188 s | $0.0169 | 35.6-39.2 | The same 13 questions and the same Q5. It stands in for a Word file; no real file went through the parser |
| JLPT N1, scanned, 15 pages, with a scanned answer grid and script, 13 pages | 1 | 947 s | $0.0744 | 170.4 | 70 questions, and all 70 keys match the printed grid, checked by eye |

**JLPT failed twice at the 15 s first-event limit.** Each of its calls is 8.6 MB, and from this Mac they took 20 to 58 s to start, 947 s
and 437 MB in all, with the limit raised for the run. The limit counts the upload. It now allows 8 s for each MB on a request over 1 MB,
which needs a run to confirm on production's connection, since its upload speed isn't this Mac's. Sending images by short-lived URL would
remove the upload, and it is untested.

## Pricing

A run already settles what its calls used, so a flat price would be a new rule. Measured, on the extraction rates:

| Run | Pages | Questions | Credits | A page | A question |
|---|---:|---:|---:|---:|---:|
| 2021 P1, no answer file | 7 | 10 | 16.9 | 2.4 | 1.7 |
| 2021 P1, scheme as text | 7 | 10 | 19.8 | 2.8 | 2.0 |
| 2021 P1, scheme as images | 7 | 10 | 27.9 | 4.0 | 2.8 |
| 2021 P1, whole paper, scheme as images | 22 | 19 | 55.0 | 2.5 | 2.9 |
| S5 M2 mock, no answer file | 12 | 13 | 36.7 | 3.1 | 2.8 |
| Dense reading, no answer file | 6 | 13 | 19.8 | 3.3 | 1.5 |
| Chinese, no answer file | 6 | 9 | 23.4 | 3.9 | 2.6 |
| Chinese, long scheme as text, the run without the label fault | 6 | 9 | 39.1 | 6.5 | 4.3 |
| Worksheet that prints its key | 6 | 3 | 5.7 | 1.0 | 1.9 |
| JLPT, scheme as images | 15 | 70 | 170.4 | 11.4 | 2.4 |
| 40 pages, quiz full, all answered | 40 | 90 | 239.6 | 6.0 | 2.7 |

Pages range from 1 to 11 credits, and questions from 1.5 to 4.3. So cost follows questions, and an answer file adds less than a dense paper does.

## Open

- **The dialog offers only PDFs and images** (`isPaperFile`), so a Word paper can't be picked yet. It needs a whole-file row in
  place of the page picker: a mock first.
- **A Word or PowerPoint question that needs a picture loses it,** since no page image exists.
- **Upload on a full selection:** 260 MB across 52 calls on the 40-page run. That is the cost of images in every call.
- **Solve batches all start together,** like copy batches, and the landing session is capping copy batches at about 4 because
  they overshoot credits. The 40-page run started many at once. I'd apply the same cap to solve batches, and it will slow them.
- **Nothing tells the user a question is cut.** A warning would need the map to say so.
- **A real hand-written answer sheet and a full-size phone photo** are still untested.

## Spend

$1.63 in all for this work against a $1.80 stop: $0.91 for the answer files report and $0.72 here. That includes the failed Chinese
runs and those lost to sleep. The fixes above were tested with unit tests after the money ran out, except where a table says a
run followed them. Keys stayed in the process.

## Reproduce

```bash
python -I bench/extraction/scripts/selections.py run --refs <question-bank references> \
  --detections <pp-plus-l-onnx.json> <2023-p2 detections> <biology detections> --env-file deploy/.env.uat \
  --hard-stop 1.5 --jobs word:3 word-scheme:3 cut:3 printed:3 dense:2 chinese:2 chinese-alone:1 large:1
python -I bench/extraction/scripts/selections.py show --jobs cut
```
