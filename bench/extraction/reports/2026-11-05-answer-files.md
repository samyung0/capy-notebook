# Make a quiz: answer files sent to the model (2026-11-05)

Epo rejected pairing in code: "no thats why dont use code for pairing, send the files directly", then "or
indexed text if any/layout ocr text", and "i can draw in a jpg and the extract should be able to pair the
answer". Mid-run they added: "for schema, i think the quesitons is down to whether its cheaper to parse the text
(all files except images can chunk the file), questions is whether we send the chunk text or the page screenshots
(e.g. useful when its scanned so we dont need to overload the ocr) and we can cap the total pages, and if we send
on copy or solve".

All 1017 on the extraction route, around this branch's `extraction.run` at `e89a06d85`. Script:
`scripts/answer_files.py`. No app or pipeline code changed. Mac, 2026-11-05. 2021 P1 is a scan, so the paper goes
with no page text, as production sends it.

## Recommendation

**Build it: send the answer files in the first message, with no parse and no `pair()`.** It costs more than the
parse, but the parse saves another question's answers without warning when a file is out of order.

| Decision for Epo | My pick | Why |
|---|---|---|
| Parse, or send the file | **Send the file** | About 40% dearer and 28 s slower as text (19.8 against 14.1 credits), but right on any layout. See [the main table](#the-main-table) |
| First message, or on solve | **First message** | Marks right in 30 of 30 runs, against 3 of 6. On the whole paper on-solve also looks dearer |
| Text or page images | **Text for born-digital PDFs, Word, PowerPoint and text files. Page images for scans and picture uploads** | The same line you drew for question pages, "scans only": a scan's page read is where wrong readings come from. Text is cheaper and faster, and they tied on accuracy here |
| Cap on pages | **40 images in all, paper and answer pages together** | Each answer page adds about 166 KB to every call. See [what a page costs](#what-a-page-costs) |
| Wording | **Add "even when your own working disagrees"** | Without it the model replaced the file's answer in all 6 runs. With it, 10 of 12 parts follow the file. See [following the file](#does-the-model-follow-the-file) |
| The `marks` field on `record_answers` | **Drop it** | It changed nothing in any first-message run: the copy calls already get the marks right. On solve, where it was meant to help, it left Q7 wrong in 2 of 3 text runs |
| Lower reasoning on solve | **No** | No clear saving, and the marks and answers were the same |
| A whiteboard photo with no question number | **No "printed" or "handwritten" in the prompts, as you decided** | Whole whiteboard found and solved 6 of 6, against 2 of 9. See [no "printed"](#no-printed-in-the-prompts) |

## The main table

2021 P1, Q1 to Q10: 19 parts, 7 pages, with its 14-page mark scheme. Three runs a row, means with the lowest and
highest in brackets. Answers and marks are out of 19 parts, one figure for each run.

| Route | File | Wall s | Credits | Billed | Upload, all calls | Answers right | Marks right | Q4 split 3, 1 | Q7 split 1, 1, 2 |
|---|---|---|---|---:|---:|---|---|---:|---:|
| **No answer file** | | 64 (57-71) | 16.9 (16.4-17.2) | $0.0075 | 10.3 MB | 19, 19, 18 | 19, 15, 17 | 3 of 3 | 1 of 3 |
| **Today's parse and `pair()`** | Real scheme | **45 (36-50)** | **14.1 (12.1-16.6)** | **$0.0063** | 4.1 MB | 19, 19, 19 | 18, 18, 18 | **0 of 3** | 3 of 3 |
| | Out of order | 45 (38-52) | 17.2 (15.7-18.9) | $0.0077 | 5.4 MB | **14, 14, 12** | 18, 17, 16 | 1 of 3 | 3 of 3 |
| | No question numbers | 42 (35-48) | 15.3 (14.1-16.4) | $0.0068 | 6.2 MB | 17, 19, 17 | 19, 16, 19 | 2 of 3 | 3 of 3 |
| **Text, first message** | Real scheme | 73 (58-100) | 19.8 (16.5-25.0) | $0.0087 | 9.2 MB | 19, 19, 19 | 19, 19, 19 | 3 of 3 | 3 of 3 |
| | Out of order | 77 (61-97) | 22.1 (18.1-25.1) | $0.0097 | 10.5 MB | 19, 19, 19 | 19, 19, 19 | 3 of 3 | 3 of 3 |
| | No question numbers | 66 (62-68) | 19.4 (18.6-20.1) | $0.0085 | 10.1 MB | 19, 19, 19 | 19, 19, 19 | 3 of 3 | 3 of 3 |
| **Images, first message** | Real scheme | 125 (117-132) | 27.9 (26.4-29.9) | $0.0123 | 25.0 MB | 19, 19, 19 | 19, 19, 19 | 3 of 3 | 3 of 3 |
| | Out of order | 92 (67-113) | 25.8 (21.5-29.5) | $0.0113 | 23.9 MB | 19, 19, 19 | 19, 19, 19 | 3 of 3 | 3 of 3 |
| | No question numbers | 96 (65-118) | 25.0 (20.1-28.4) | $0.0109 | 24.6 MB | 19, 19, 19 | 19, 19, 19 | 3 of 3 | 3 of 3 |
| **Text, on solve** | Real scheme | 66 (59-71) | 19.2 (17.4-20.4) | $0.0084 | 10.0 MB | 19, 19, 19 | 17, 19, 17 | 3 of 3 | **1 of 3** |
| **Images, on solve** | Real scheme | 80 (78-82) | 22.8 (21.2-24.4) | $0.0099 | 22.0 MB | 19, 19, 19 | 18, 19, 19 | 3 of 3 | 3 of 3 |

The baselines you were given, 29 s and 13.2 credits with the scheme and 69 s and 18.2 with none, came from before
this branch's changes and with page text. The rows above are this branch, rerun today, and I can't explain 45 s
against 29 s beyond that change and run-to-run spread.

**Answers and marks in all 30 first-message runs on the real and doctored schemes:** 570 of 570 parts right on
both, counting the 12 runs with lower reasoning or the stricter wording below. Q4 is right 30 of 30. The file route
also fixes what the parse could not, without any new rule:

| Check | Parse | File, first message |
|---|---|---|
| Q4 split (a) 3, (b) 1 | 0 of 3: (a) came out 4 every time | 30 of 30, right already at the copy |
| Q8(b)(i): the page read's wrong letter | In the saved quiz, 3 of 3 | 0 of 9 text runs, though they read the same text |
| Parts saved with no worked solution | 6 in 3 runs: Q4(b) and Q10(b)(i) each time | 0 |
| The map, with Q11 to Q19 in the file but not on the pages | 10 rows | 10 rows, every run. The file never added a question |
| Figures | Q8 and Q9 | Q8 and Q9, every run |

**The parse on an out-of-order file is the worst result here.** It names entries with the wrong question's labels,
so Q8 and Q9, and Q10 in one run, get other questions' answers, 5 to 7 parts a run. The report's fields do flag repeats and
disagreements, but the wrong answers are what gets saved. With no question numbers, it left Q8's parts empty in 2
of 3 runs.

**What is noise.** Three runs a row is few.

- **Real:** the parse's Q4 fault, and its answers on the out-of-order file. Images being slower and dearer than text
  on the real scheme: the ranges don't overlap. Text and images overlap on the two doctored files, so the gap is less
  certain than the real scheme's row suggests.
- **Probably real:** on solve losing marks, 3 of 6 fully right against 30 of 30.
- **Noise:** differences in copy wording. Q4, Q7, Q8 and Q9 each show harmless variations (delta or triangle, a
  sentence moved between stem and part), in every set including those with no file.

The one wrong answer in the table, Q9(b) in one no-file run, is a worked-out range. No file route gave it.

## First message or on solve

| | First message | On solve |
|---|---|---|
| Map and copy calls | Carry the file | Exactly as today, so the file can't affect them |
| Copy gets the marks | Yes: right at the copy in every real-scheme run | No: it guesses a split, and `marks` on solve may or may not fix it |
| Cache on the first solve call | 0.99 or more | 0.50 to 0.72: each solve thread pays for the file |

On a one-thread paper on solve saves a little, since the map and copy don't carry the file. That reverses as threads
grow. The whole paper, all 19 questions on 22 pages with the same scheme, gave two copy threads and three solve
batches. Two runs each:

| | Wall s | Credits | Billed | Upload | Solve cost |
|---|---|---|---:|---:|---:|
| First message | 161 (115-206) | 55.0 (47.5-62.5) | $0.0242 | 72 MB | $0.0111 |
| On solve | 184 (162-207) | 64.1 (52.3-75.9) | $0.0280 | 82 MB | $0.0170 |

Two runs each overlap, so I'd trust the mechanism more than the totals: the solve cost is where it shows. One on-solve
run's map found 18 of the 19 questions. Its map never sees the file, so I don't blame the placement, and the repair
that would catch this reads page text, which these bench runs leave empty. It is the first map I've seen lose a question
on this route, so watch for it.

## Text or images

| | Text | Images |
|---|---|---|
| Extra input on the map, real scheme | 8,083 tokens | 14,352 tokens |
| Upload added to each call | 0.02 MB | 2.3 MB |
| Reasoning, copy and solve, mean of the three schemes | 2,537 and 1,940 | 3,478 and 4,457 |
| Credits, mean of the three schemes | 20.4 | 26.2 |
| Wall, mean of the three schemes | 72 s | 105 s |
| Depends on a page read | Yes | No |

Images cost more because the model reasons more with them, not because of the input. I can't say why: reasoning text
isn't saved.

**Your OCR point.** A page read costs about $0.00034 and 4.5 s a page, measured on two of this scheme's pages at the
read's 1,280 px. That is about $0.0048 for this file. So one quiz made from a scan costs about the same either way:
images cost $0.0025 more a run, but could skip $0.0048 of reading. Skipping needs a change, since today every file
must be indexed before a run starts and a scan with no text is refused. A file used in several runs favours text.

**A limit on this comparison.** The text here is a scan's cached page read. No born-digital scheme was tried, and
its text layer should be better than this.

## What a page costs

Measured on the real scheme, 14 pages, for a run of 7 calls:

| Per answer page | Input on the map | Later calls, cached | Input cost a run | Upload a call |
|---|---:|---:|---:|---:|
| Image | 1,025 tokens | 1,025 each | $0.00016 | 166 KB |
| Text | 577 tokens | 577 each | $0.00009 | 1.6 KB |

The extra reasoning isn't in these. With 40 answer page images, each call would carry about 6.6 MB of them on top of
the paper's. Today's limit is 40 selected pages with answer files read whole, so a 26-page paper with a 14-page scheme
is the most this cap allows.

## Does the model follow the file?

**Not by default.** The stand-in has two answers planted wrong, to check that the file wins. Your earlier decision is
that a scheme's answer always replaces the model's.

| Wording | Text | Images |
|---|---|---|
| As shown to Epo | 0 of 6 planted parts followed | 0 of 6 |
| With "even when your own working disagrees" | 5 of 6 | 5 of 6 |

The stricter wording cost no accuracy on the real scheme: all 19 and 19, in 6 runs. Its cost is unsettled, at 24.3
against 19.8 credits on text with overlapping ranges, and 26.6 against 27.9 on images.

It leaves two things open. A question whose working disagrees gets a thin solution, such as saying the answer file
gives the value. And it still overrides 2 parts of 12, so a teacher's deliberately different key isn't guaranteed.
Nothing in this route tells the user when the model and the file disagreed. The parse route's `keyDisagreements` did,
and step 2 removes it, as the brief says.

**The parse doesn't follow it either** in this case, for a different reason: a file with no marking points can't
replace an open part's answer, so the model works it out. All 3 runs ended with the true values. So a hand-drawn file
with only final answers needs this route to count at all.

## Long numbers

The selection is Q15 and Q18, whose scheme carries the file's 10 long numbers. It has no saved layout boxes, so its
figure takes the box call.

| | Runs | Wall s | Billed | Wrong digits | Long numbers kept whole, of 10 |
|---|---:|---|---:|---:|---|
| Images | 3 | 52 (47-57) | $0.0050 | 0 | 3, 8, 3 |
| Text | 3 | 44 (31-54) | $0.0047 | 0 | 2, 1, 1 |

No run wrote a wrong digit. The rest were rounded correctly in the worked solution, or not shown. **This doesn't
settle the fear behind the test,** because this scheme's page read has all 10 right: nothing on these pages could
mislead the model. I also compared long numbers on a page of 2024's scheme with its read. The digits match, though one
line gained a squared sign the page doesn't print. Q34's lost zero was in a question's text, not a scheme. A page read
that really does lose a digit in a scheme hasn't turned up to test.

## Lower reasoning on solve

| | Wall s | Credits | Marks and answers |
|---|---|---|---|
| Text, medium | 73 (58-100) | 19.8 (16.5-25.0) | All right |
| Text, low | 78 (65-94) | 20.5 (17.5-24.1) | All right |
| Images, medium | 125 (117-132) | 27.9 (26.4-29.9) | All right |
| Images, low | 98 (75-114) | 25.4 (21.5-28.4) | All right |

No clear saving, so I would keep medium.

## The stand-in JPG

Not a real drawing: a handwriting font with each character wobbled, on lined paper, skewed and saved as a low-quality
JPEG, far cleaner than handwriting. It lists Q1 to Q10 out of order, gives marks for Q4 and Q7 only, and has one answer
struck through and replaced. Answers are out of the 17 parts not planted.

| | Wall s | Credits | Answers right of 17 | Marks right of 19 |
|---|---|---|---|---|
| Image | 86 (69-103) | 20.6 (16.9-25.9) | 17, 17, 17 | 19, 19, 19 |
| Its caption, as text | 138 (113-158) | 29.5 (27.6-30.7) | 17, 17, 17 | 19, 19, 17 |
| Today's parse, of the caption | 59 (53-64) | 16.7 (15.7-17.5) | 17, 17, 17 | 19, 19, 19 |

The caption read the struck-through answer correctly but turned the Greek letters into Latin ones. It costs far more
as text here, with no overlap, which I can't explain, since Epo's own images below show no such gap.

## Epo's images

Two thumbnails from videos, which Epo sent as questions to be solved with nothing in the answer slot: a worksheet with
working written on it (480 by 640) and a whiteboard (2,000 by 1,125) whose working stops partway. I also cropped each
question out and sent the handwriting as the answer file, which is the first test on real handwriting.

| Image | How sent | Runs | Question found | Answer right | Note |
|---|---|---:|---:|---:|---|
| Worksheet, whole | Empty slot, today's wording | 3 | 3 | 3 | Marks total 7 in 2 runs: the page prints 5 |
| | Empty slot, new wording | 3 | 3 | 3 | Marks total 7 in 1 run |
| Worksheet, cropped | Empty slot | 3 | 3 | 3 | Marks total 5 in all |
| | Handwriting as image | 3 | 3 | 3 | Marks total 5 in all |
| | Handwriting's caption as text | 3 | 3 | 3 | Marks total 5 in all |
| **Whiteboard, whole** | **Empty slot, today's wording** | **6** | **1** | 1 | The other 5 save no question |
| | Empty slot, new wording | 3 | 1 | 1 | |
| | Empty slot, with the map sentence below | 3 | 2 | 2 | One copies all the working into the question |
| Whiteboard, cropped | Empty slot | 3 | 3 | **0** | Misreads the numerator in all 3, then solves that |
| | Whole board as image | 3 | 3 | 2 | One misreads it. 2 attach the question as a figure |
| | Whole board's caption as text | 3 | 3 | 3 | |

What this shows:

- **The worksheet works as you expected.** The written working never got into the question, and it was solved. All 6
  runs on the whole image found and solved it.
- **The whole whiteboard doesn't.** The map's reply says why, for example that it shows handwritten working with no
  printed question. The system prompt's first line asks for questions "printed on exam or worksheet pages", and the
  map asks for a printed number. A run with no rows ends as `extraction_empty`.
- **Your crop finds the question, but doesn't make it readable.** I think the numerator's handwritten first letter looks
  like a plus sign, and the crop has lost the working below that makes it clear. These are low-resolution frames, so a real
  phone photo may do better. That is the test I can't run on these.
- **A map row can be labelled `none`.** The map wrote `none | pages 1-1 | parts none | figures none` in several runs, and
  `parse_map` takes it as a question called "none". That needs fixing in step 2.

**The map sentence I tried,** added to the map ask after "...would otherwise share a number.":

```text
A question with no printed number takes the next number in order, starting from 1.
```

It took the whole whiteboard from 2 of 9 to 2 of 3, and it lets working into the question. Alone it wasn't enough: the
next section's removal is what fixed it.

## No "printed" in the prompts

Epo, 2026-11-05: "remove printed/handwritten, i thought thats removed already, i dont care how the quesitons is made".
They had not been removed. All these runs also have the stricter answer sentence and the map's numbering sentence.

| Image or paper | How sent | Runs | Question found | Answer right | Note |
|---|---|---:|---:|---:|---|
| **Whiteboard, whole** | Empty slot | 6 | **6** | **6** | Working copied into the question in 2 |
| Whiteboard, cropped | Empty slot | 3 | 3 | 1 | The crop still misreads the numerator in 2 |
| Worksheet, whole | Empty slot | 3 | 3 | 3 | Marks total 7, not 5, in all 3 |

| 2021 P1 | Wall s | Credits | Answers right | Marks right | Q4, Q7 right | New wording in a copy |
|---|---|---|---|---|---:|---|
| Text in the first message | 84 (68-99) | 20.5 (17.4-22.2) | 19, 19, 19 | 19, 19, 19 | 3, 3 of 3 | None |
| Images in the first message | 92 (91-94) | 22.0 (21.7-22.5) | 19, 19, 19 | 19, 19, 19 | 3, 3 of 3 | One harmless symbol form |
| No answer file | 99 (81-131) | 20.1 (16.4-25.7) | 19, 19, 19 | 19, 17, 17 | 3, 1 of 3 | None |

Nothing got worse on the paper. The map has its 10 rows and the figures are the same, in every run. Costs sit within the
earlier ranges, except images, which came in below them (22.0 against 25.0 to 27.9, with few runs). I can't say that is real.

**What remains on photos.** Working now reaches the question on a whiteboard in 2 of 6 runs, and a page's marks are misread
on the low-resolution worksheet. A rule would be untested wording, for your call: the "Leave out" line could also name
`working written under a question`.

**Every string,** before and after. The box call and two tool results are listed but were not all exercised here: the box
call ran with its old wording, and the results never fired.

| Where | Before | After |
|---|---|---|
| System, opening | `You copy the questions printed on exam or worksheet pages into a quiz, exactly as printed.` | `You copy the questions on the selected pages into a quiz, exactly as they appear.` |
| Answer files sentence | `..., in any layout, possibly handwritten.` | `..., in any layout.` |
| Copying order, mcq, map, schema | `in printed order` | `in order` |
| Answer sentence | `never change the printed question` | `never change the question` |
| Copying | `exactly as printed` | `exactly as they appear` |
| Copying | `a printed dollar sign for money` | `a dollar sign for money` |
| Copying | `never simplify or reword the printed text` | `never simplify or reword the text` |
| Parts | `follow its printed labels` | `follow its labels` |
| Parts | `Text printed under (b)` | `Text under (b)` |
| Marks | `the part's printed marks` | `the part's marks as shown` |
| Marks | `only the question's total is printed` | `only the question's total is shown` |
| Marks | `give the printed total` | `give that total` |
| Marks | `An item printed without marks has 1` | `An item with no marks shown has 1` |
| Map | `<printed part labels, or none>` | `<part labels, or none>` |
| Map | `the question's printed number alone` | `the question's number alone` |
| Map, added after the section sentence | none | `A question with no number takes the next number in order, starting from 1.` |
| Map, schema `pages` | `it is printed on` | `it is on` |
| Map | `its printed part labels` | `its part labels` |
| Schema, blocks | `text: the printed text.` | `text: the text.` |
| Schema, label | `The printed question number` | `The question number` |
| Schema, part label | `The printed part label` | `The part label` |
| Schema, unit | `the unit printed beside` | `the unit shown beside` |
| Schema, accepted | `a unit is printed beside` | `a unit is shown beside` |
| Schema, lead-in | `the text printed under its parent` | `the text under its parent` |
| Schema, stem | `Text printed before the first part` | `Text before the first part` |
| Schema, total | `The question's printed total, when only a total is printed.` | `The question's total, when only a total is shown.` |
| Box call, to change when built | `You find figures on a printed exam or worksheet page.` | `You find figures on a page.` |
| Tool result, to change when built | `its printed label` | `its label` |
| Tool result, to change when built | `the page numbers it is printed on` | `the page numbers it is on` |

The parse's prompt also says "printed", and goes with the parse.

## The wording, verbatim

As in the brief, shown to Epo.

**System prompt, added after `You see all the selected page images at once.`:**

```text
After the question pages may come answer files: a mark scheme, an answer key or someone's own answers, in any layout, possibly handwritten.
```

**Answer sentence.** Before:

```text
Copy an answer the page prints; otherwise work it out, and never change the printed question.
```

After:

```text
Take each answer and its marks from the answer files or the page when they give them; otherwise work it out, and never change the printed question.
```

Stricter, which I recommend:

```text
Take each answer and its marks from the answer files or the page when they give them, even when your own working disagrees; otherwise work it out, and never change the printed question.
```

**Heading for an image, then the image:**

```text
Answer file page image 1: page 3 of <file name>.
```

**Heading for text:**

```text
Answer file <file name>. Its indexed text:
<source>
<the file's indexed text>
</source>
```

**`record_answers` part property,** which I recommend dropping:

```json
"marks": {"type": "integer", "minimum": 1, "description": "The part's marks when the answer file gives them."}
```

**Where the blocks go:** after the boxes JSON and before the map ask, so the figures paragraph's "After the pages comes
what it found" stays true.

**On solve only, tested and not recommended.** The system sentence becomes the one below, and the blocks go in the solve
message before its ask:

```text
With the ask for answers may come answer files: a mark scheme, an answer key or someone's own answers, in any layout, possibly handwritten.
```

Call settings, tools and every other string are production's, in `todo-study-tracking/R6-extraction-prompt.md`.

## Limits and failures

- 130 runs, all served by InferenceNet. No reply was cut off. One solve stream failed in a whole-paper run,
  and its retry recorded the answers.
- The longest reply was 10,656 tokens.
- Refusals were production's existing kinds, up to 10 across a set's 3 runs. All were recorded in a later round.
- No copy call tried to record answers.

## What this can't show

- **One paper, one real scheme.** Only 2021 P1. A scheme's layout varies far more than I could fake.
- **Real handwriting at real resolution.** Only video thumbnails, and only one worksheet with working on it. It is the
  biggest gap. A photo of handwritten answers to 2021 P1 Q1 to Q10 would test it directly, with a wrong answer on purpose.
- **Answers judged loosely.** A part counts as right if its answer holds the scheme's final value. Q8(a) is a proof, judged
  by its conclusion. Marking points weren't compared with the scheme line by line.
- **The figures on pages past 8,** which have no saved layout boxes.
- **Production's index.** The text is the bench's cached page read, and production goes through the parser.
- **A born-digital scheme, a Word or PowerPoint file, a paper that prints its answers, a cut selection.** These are step 3.

## Open calls from the brief

- A run stopped by credits or the output limit doesn't name no-answer questions. I'd add a sentence saying some have none.
- A quiz with no complete questions can't be published as an assignment. I'd keep that.
- `mcq` ignoring a scheme's marks goes away with this route.
- Incomplete questions dropped on clones and lineage rebuilds: nobody has run it.
- `insert_child` of an unanswered question: check on UAT once it lands.

## Spend

$0.89 of the $1 stop, against the $0.60 budget, all 1017 on the extraction route. The rise came from what was added along
the way: the stricter wording, the parse on the doctored files, Epo's images and the removal of "printed". One process at a time, 3 runs in
flight at most, peak RSS about 300 MB on the one run measured. Keys stayed in the process, read only from their named lines
in `deploy/.env.uat`. Nothing covers this script with a test.

## Reproduce

Answers, the stand-in's lines, Epo's images and the truth are exam or private material, so they stay in the ignored
`.results/answerfiles/`: `standin.json`, `truth.json`, `files/`. Layout boxes are the layout bench's `pp-plus-l-onnx.json`.

```bash
R=<references>/hkdse-math-compulsory
python -I bench/extraction/scripts/answer_files.py make --refs $R
python -I bench/extraction/scripts/answer_files.py caption --env-file deploy/.env.uat --refs $R
python -I bench/extraction/scripts/answer_files.py run --refs $R --detections <pp-plus-l-onnx.json> \
  --env-file deploy/.env.uat --hard-stop 1 --jobs main:parse::3 main:none::3 main:scheme:img:3 main:scheme:txt:3 \
  main:scheme:img-onsolve:3 main:scheme:txt-onsolve:3 main:shuffled:img:3 main:shuffled:txt:3 main:nonumbers:img:3 \
  main:nonumbers:txt:3 main:standin:img:3 main:standin:txt:3 long:scheme:img:3 long:scheme:txt:3
python -I bench/extraction/scripts/answer_files.py score --refs $R
```

`python` is the repository's `.venv`. Flags on a mode: `-strict`, `-lowsolve`, `-onsolve`, `-mapnum`, `-plain`. Results land in the
ignored `.results/answerfiles/`.
