# Make a quiz: selections longer than 40 pages (2026-11-21)

Epo asked how Make a quiz maps questions and whether a long textbook can be sent whole. Today a run
reads at most 40 picked pages, because one map call sees every page image and every copy and solve
call carries that same message. This round measures what happens past the cap: the whole selection
in one map, maps in page windows, and (Epo's question mid-round, "shouldnt we send chunks?") a map
over the pages' indexed text with images only for the pages that hold questions.

All 1017 on the extraction route. Script: `scripts/long_selections.py`, around the production
`extraction.run`. No app or pipeline code changed. Mac, 2026-11-21. Scores and per-purpose tokens of
every run are in `2026-11-21-long-selections/scores.json`.

## Answer

**Yes, with a text map.** Map every picked page from its indexed text (no images), then copy and
solve in threads that carry only the pages that hold questions, at most 30 page images a call. On
110 textbook pages with 144 questions, in both runs, it found every question with every printed
number, agreed with the book's solutions on 145 of 146 parts (the other is 1.0 gal/hour for the
book's 0.96), kept every figure, and cost 2.1 credits a question in about 4 minutes.

- **One map over everything doesn't work.** Past about 109 page images InferenceNet refuses the
  request, and past 32 so does Cloudflare, so only Wafer served it: 30 minutes a run, 2.7 GB
  uploaded, and 5.8 credits a question against the 4 we charge. The first run lost one solve batch
  to Wafer's rate limit. In the second the map's pages drifted by about 5 pages mid-book for 47
  questions, and 44 questions were copied with another set's numbers. Today's 40-page runs are
  already past Cloudflare's 32, so the route's second provider never serves one.
- **Fixed page windows work but need code the text map doesn't.** Windows of 20 pages scored as well
  and cost the same, but each window letters its sets from A again: 59 and 90 labels a run that a
  merge would have to re-letter. Windows of 40 renumbered 25 exercises in one run and copied 9
  practice questions with their exercise twins' numbers in the other. Windows of 10 took 11 worked
  examples for questions in both runs (the user would pay 4 credits each).
- **The text map holds on scans.** On four scanned HKDSE papers, mapped twice each from their page
  reads, every label, part list and page matched the gold and production's image map, with 2.5 times
  fewer tokens.
- **Twin sets are the one fidelity risk.** This book prints each practice set again as an exercise
  set with the same wording and new numbers. In 3 of 12 runs copies took the twin's numbers (44
  questions in one map, 9 at 40 pages, 2 at 10 pages from the page before the window); never in the
  text-map or 20-page runs, but two runs an arm can't rule it out there.
- **The quiz, not the pages, is now the limit.** This selection's 144 questions are 150 AI-marked
  parts; one quiz holds 100, so only the first 101 questions fit.

| Arm | Runs | Found | Map pages off | Extra | Relabelled | Collide | Numbers right | Keys | No answer | Figures | Wall s | Map s | Billed | Credits | Credits a question | Peak calls | Upload MB |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `one` | 2 | 144, 136 of 144 | 0, 47 | 0, 8 | 0, 16 | 0, 0 | 144, 92 | 64/73, 41/70 | 14, 0 | 7, 5 of 7 | 1827 (1813-1840) | 63 (57-69) | $0.374 (0.359-0.388) | 834 (786-882) | 5.79 (5.46-6.12) | 6 (6-6) | 2665 (2611-2719) |
| `w40` | 2 | 144, 144 of 144 | 0, 0 | 0, 0 | 25, 0 | 0, 70 | 144, 135 | 72/73, 65/74 | 0, 0 | 6, 7 of 7 | 269 (265-272) | 34 (31-37) | $0.174 (0.174-0.175) | 364 (363-366) | 2.53 (2.52-2.54) | 6 (5-7) | 584 (573-594) |
| `w20` | 2 | 144, 144 of 144 | 0, 0 | 0, 0 | 0, 0 | 59, 90 | 144, 144 | 73/73, 72/73 | 0, 0 | 7, 7 of 7 | 228 (216-239) | 28 (22-33) | $0.154 (0.145-0.162) | 319 (303-334) | 2.21 (2.11-2.32) | 7 (7-7) | 343 (335-351) |
| `w20o` | 2 | 144, 144 of 144 | 0, 0 | 0, 0 | 0, 0 | 90, 86 | 144, 144 | 72/73, 73/73 | 0, 0 | 7, 7 of 7 | 238 (216-260) | 36 (34-39) | $0.148 (0.148-0.149) | 300 (300-301) | 2.08 (2.08-2.09) | 7 (7-7) | 341 (334-348) |
| `w10` | 2 | 144, 144 of 144 | 0, 0 | 14, 13 | 0, 0 | 105, 104 | 144, 142 | 72/73, 73/73 | 0, 0 | 7, 7 of 7 | 231 (222-241) | 31 (29-33) | $0.171 (0.169-0.174) | 352 (348-357) | 2.23 (2.21-2.26) | 12 (11-12) | 226 (224-228) |
| **`c30`, text map** | 2 | 144, 144 of 144 | 0, 0 | 0, 0 | 0, 0 | 0, 0 | 144, 144 | 73/73, 72/73 | 0, 0 | 7, 7 of 7 | 233 (222-245) | 38 (35-40) | $0.142 (0.134-0.151) | 302 (286-318) | 2.09 (1.98-2.21) | 8 (6-10) | 341 (338-344) |

Two runs an arm, both listed or as a mean with the lowest and highest in brackets. Found is by question
text against the gold, on a page within one of the map's; map pages off counts those found only with
the page ignored. Relabelled counts labels that aren't the printed number; collide counts labels a
merge of windows would overwrite. Numbers right: every number the book prints in the question is in
its copy. Keys: parts whose model answer agrees with the book's printed solution, practice sets only,
counted on the parts as saved.

## Decisions for Epo

| Decision | My pick | Why |
|---|---|---|
| Route past 40 pages | **Text map, then threads of question pages** | Same accuracy as 20-page windows, no label collisions, no worked examples taken for questions, cheapest map. See [the arms](#the-arms) |
| Images a thread | **30**, answer images included | Cloudflare refuses 33; InferenceNet stops near 109. See [provider limits](#provider-limits) |
| Answer files | **The whole file in every thread, as today** | Giving each window only its own solution pages saved 10% and scored no better; code can't pair them anyway |
| Page cap | **150 picked pages** | What a run costs follows its questions, not its pages: an explanation page costs only its text in one map call (about 330 tokens a page here). At the 6,000 characters a page the map already allows, 150 pages stay near 300K tokens, inside 1017's 1M |
| Word and PowerPoint | **Keep 40 pages until the browser sends each drawn page's text** | Their drawn pages carry no text and the indexed text's pages need not match them, so the text map can't place their questions. Untested. See [what changes](#what-the-build-changes) |
| More questions than one quiz holds | **The confirm dialog offers the first that fit, as it does for credits** | One quiz holds 150 parts and 100 AI-marked parts. Several quizzes from one run would be a product change |
| Price | **Keep 4 credits a question** | The text map cost 2.0 to 2.2 credits a question, the windows 2.1 to 2.5; one map over everything (5.5 to 6.1) would not be covered |
| How prompts are sent | **Needs your OK**: the map gets the text-paper system prompt, a scan's page read included (today a scan sends no text, your "scans only" of 2026-11-05), and each copy thread starts from its pages with the map's lines for its questions as the reply | No wording changes, but which prompt, which text and which reply a call sees does. The copy still never sees a scan's text. See [what changes](#what-the-build-changes) |
| The 40-page cap today | **Note only** | A run of 33 to 40 images can't go to Cloudflare, the route's second provider. Threads of 30 would fix that too |

## The arms

Every arm runs production's `extraction.run` unchanged, over the same 110 question pages and the same
answer file.

| Arm | What it does |
|---|---|
| `one` | The whole selection in one run: one map over all 110 page images, then copy and solve threads that each carry all of them. Today's route with the cap lifted |
| `w40`, `w20`, `w10` | The pages cut into windows of 40, 20 or 10. Each window is today's run over its own pages plus the page before and the page after; code keeps the map rows whose first page is the window's own, so a question over an edge is copied whole by the window it starts in and dropped by the next. Copy repairs look only at own pages. This stands in for `trailing_text` with no prompt change |
| `w20o` | As `w20`, but each window gets only the solution pages of the sets it holds. Code can't know that (Epo: no pairing in code), so it is the best case for "answers only to their windows" |
| `c30` | Epo's chunks: one map over every page's indexed text, no images (production's text-paper map: `SYSTEM_TEXT_ONLY`, `text_page` headings, the same `MAP_ASK`). Code then groups the map's questions in printed order into threads of at most 30 page images. Each thread is today's run over its pages, with the map's lines for its questions standing in for its map reply, so copy, repair and solve are production's |

All maps start at once. Copy and solve calls share one gate of 4 across windows or threads, as one
run's batches do (`BATCHES_AT_ONCE`).

### Provider limits

The route is InferenceNet, then Cloudflare, then Wafer's US endpoint. In the `one` arm every copy and
solve call carried all 110 pages, and each provider answered differently:

| Provider | Answer to a 110-image call | Limit it names |
|---|---|---|
| InferenceNet | 400: `Request decoded media exceeds VLLM_MAX_MEDIA_REQUEST_DECODE_BYTES=715827880 (722158080 bytes)` | About 6.6 MB a page decoded at 1,568 px, so about 109 pages |
| Cloudflare | 400: `too many images in request (max 32)` | 32 images |
| Wafer | Served 142 of 152 calls in the first run and 152 of 160 in the second. In the first it answered 429 (rate-limited upstream) often enough to fail one solve batch: 14 parts of Practice 4.1 saved with no answer | none seen |

So a call over 32 images skips Cloudflare and one over about 109 has only Wafer, which the extraction
route puts last because two earlier runs on it lost every open part's model answer
(`2026-11-03-keys-in-one-prompt.md`). Today's 40-page cap is already over 32. Every call in the window
and text-map arms stayed under 109 and went to InferenceNet; the `c30` threads, at 30 images or fewer,
would also fit Cloudflare.

### Windows: labels and extra questions

- **Collisions.** Each window's map letters its sets from A, as the map prompt asks when two questions
  on its pages share a number. So `A1` is Practice 1.1a #1 in one window and Practice 2.1 #1 in the
  next. Production's run keeps one question per label, so merging windows needs code to re-letter
  them: 59 and 90 labels a run at 20 pages, 104 and 105 at 10.
- **Renumbering.** At 40 pages, the first window labelled each exercise set as a continuation of the
  practice set of the same number: Exercise 1.1a #1 became `1.1a-4`. The questions were right; 25
  labels weren't the printed numbers.
- **Worked examples.** At 10 pages, the window over pages 26 to 35 holds explanations and worked
  examples only, and its map took 11 examples for questions, in both runs. The confirm dialog would
  charge for them. Two or three more extras a run came from copy repairs.

The text map labels the whole selection once (A1 to V11 here), so none of this happens: one map sees
the explanation pages next to the exercise pages and listed no worked example in either run.

### Twin sets

Each practice set comes back two pages later as an exercise set: the same sentences with other
numbers ("a specific gravity of 1.69" against "1.47"). A copy call that sees both can take the wrong
one's numbers, and the questions then look right and match the gold by wording.

| Run | Questions copied with the twin's numbers | Where |
|---|---|---|
| `one-2` | 44 | Mostly Practice and Exercise 2.3, 3.1 and 4.1, after the map's pages drifted; 110 page images in every call, on Wafer |
| `w40-2` | 9 | Practice 3.1 #1 to #9 copied from Exercise 3.1 on the window's own pages; the exercise is then in the quiz twice |
| `w10-2` | 2 | Exercise 3.2 #2 and #4 copied with Practice 3.2's numbers from the page before the window |
| every other run | 0 | |

Numbers right in the table counts a question right when every number the book prints in it (less 1
to 3, which the text layer also prints for superscripts) is in its copy. The keys catch the same nine
in `w40-2`, since their answers follow the wrong numbers.

The text map's threads hold both twins too (its first thread had 30 question pages, from 9 to 76), so
what keeps a copy right is not having fewer pages in view. The likeliest difference is that every map
line the thread holds is right; the bench can't separate that from luck in two runs.

### The text map on scans

The textbook is born digital. A scan's indexed text is the ingest page read, the text Epo stopped
sending to the copy (2026-11-05, "scans only"). In the text-map route only the map reads it, to find
questions and pages; the copy reads the page images. To check the map on scans, `scan-maps` mapped
the four scanned HKDSE gold papers twice each, as production maps them (images, no text) and from
their cached page reads alone, with no answer file:

| Paper | Map | Runs | Labels right | Parts right | Same pages as the image map | Input tokens | Billed |
|---|---|---|---|---|---|---|---|
| 2021-p1 | image | 2 | 10, 10 of 10 | 10, 10 of 10 | — | 9810 (9808-9811) | $0.0013 (0.0010-0.0016) |
| 2021-p1 | text | 2 | 10, 10 of 10 | 10, 10 of 10 | 10, 10 of 10 | 3674 (3674-3675) | $0.0006 (0.0006-0.0006) |
| 2022-p1 | image | 2 | 10, 10 of 10 | 10, 10 of 10 | — | 9810 (9809-9811) | $0.0010 (0.0010-0.0010) |
| 2022-p1 | text | 2 | 10, 10 of 10 | 10, 10 of 10 | 10, 10 of 10 | 3704 (3703-3704) | $0.0006 (0.0006-0.0007) |
| 2024-p1 | image | 2 | 10, 10 of 10 | 10, 10 of 10 | — | 9810 (9809-9811) | $0.0010 (0.0010-0.0010) |
| 2024-p1 | text | 2 | 10, 10 of 10 | 10, 10 of 10 | 10, 10 of 10 | 3646 (3646-3647) | $0.0006 (0.0006-0.0006) |
| 2022-p2 | image | 2 | 45, 45 of 45 | 45, 45 of 45 | — | 18972 (18972-18972) | $0.0021 (0.0021-0.0022) |
| 2022-p2 | text | 2 | 45, 45 of 45 | 45, 45 of 45 | 45, 45 of 45 | 7681 (7681-7681) | $0.0019 (0.0019-0.0020) |

Same pages compares each text map with the image map of the same repeat. Every row of every map was
right; this says nothing yet about a scanned textbook, whose explanation pages a page read may render
less cleanly.

### Cost and the quiz

- **Where the credits go.** Solve calls are most of every arm's cost, because each carries its
  thread's page images (cached) for every batch. The one-map arm's solve calls carried 21 and 23 million
  cached tokens. The text map's single map call is 48K tokens against 157K with images, but each
  thread's first copy call misses the cache (about 140K uncached tokens a run, some 28 credits);
  starting one batch a thread before the others would mostly save that.
- **Credits a question.** The charge is 4 credits a saved question plus the map by tokens (about 20
  credits for the text map here). The routes that fit the providers cost 2.0 to 2.5 credits a
  question; one map over everything cost 5.5 and 6.1.
- **The quiz holds 101 of the 144.** All but one part here is AI-marked, and a quiz holds 100
  AI-marked parts (and 150 parts). A long textbook selection will usually find more questions than
  one quiz holds, so the page cap matters less than what the confirm dialog offers.

## What the build changes

Only for a selection that doesn't fit one thread (over 30 page images with the answer images); a
shorter one keeps today's route exactly.

1. **The map** reads every picked question page as text: production's text-paper map
   (`SYSTEM_TEXT_ONLY`, `text_page`, `MAP_ASK`), with the answer files as today. Its lines have no
   box numbers, so `fill_figures` (the map's boxes for a question its batch gave none) has nothing to
   fill from; on earlier benches it filled 28 of 536 rows.
2. **Threads.** Code groups the map's rows in printed order by their pages, at most 30 page images a
   thread, answer images included. A scanned answer file that doesn't fit goes as its indexed text, as
   today when its pages exceed the images left.
3. **Each thread's first message** is production's `map_messages` over its own pages (images, boxes,
   answer files) and, as its reply, the map's lines for its questions. Copy, repairs and solve run as
   today, 4 batches at once across threads.
4. **Layout** runs only on the grouped pages. Its run budget (`ALL_PAGES_TIMEOUT_S`, 90 s for all of
   a run's pages) fits about 40 pages on a full queue
   ([layout capacity](2026-11-04-layout-capacity.md), int8 halves it), so it should scale with pages.
5. **Gateway and dialog.** `fieldlimits.ExtractionPages` 40 to 150 and the picker's counter; the
   confirm dialog offers the first questions that fit one quiz, as it already does for credits.
   A selection of exam papers is all question pages, so 150 of them is 5 or more threads; nothing
   else changes.
6. **Word and PowerPoint** don't fit this as they are. The browser draws their pages and they go as a
   scan's do, images with no text, because the indexed text's page breaks need not match the drawn
   ones (`_drawn_pages`). A text map over their indexed text can't say which drawn page a question
   is on, and the threads are cut by page. Either the browser sends each drawn page's text with its
   image, or Word and PowerPoint keep today's 40-page cap. Untested.

This changes which prompts calls see but no wording: the map gets the text-paper system prompt (today
only plain text files do) and each thread's first reply is code's copy of the map's
lines, not the model's own reply.

## Limits and noise

- Formats: one born-digital PDF end to end; scans only at the map step, on four short exam papers
  (no long scan, no text-map run through copy and solve on a scan); Word and PowerPoint not at all.
- One textbook, born digital, two runs an arm. Its practice questions are worked unit conversions and
  geometry, one or two parts each, no printed marks.
- No layout service on the Mac: no boxes, so every figure took the box call in every arm. The text
  map with layout boxes in the threads is untested.
- The raw PDF text layer stands in for the parser's indexed text; on the solution pages it is
  scrambled, and the keys still agreed.
- The quiz's part caps were lifted during the runs and applied in the score.
- Wall time is the providers'. The one-map arm's 30 minutes is Wafer serving 110 images a call, not
  the Mac.
- Key agreement is a number check: a part agrees when a number in its model answer is within 1.5% of
  one the printed solution works out (not one the question prints, not a conversion factor), or for a
  "show how" item the value it prints; two keys were read by hand (`FINAL`, `MCQ_KEY`). The one key
  that differs in several runs is Practice 4.1 #4, answered 1.0 gal/hour where the book has 0.96.
- Both #6 questions of unit 4 are counted wrong on parts in every arm: the model splits (c)'s two
  listed prices into c(i) and c(ii).

## What ran

- **The selection.** Advanced Waterworks Mathematics (CC BY 4.0, the parser bench's
  `bench/parsers/fixtures/budget/waterworks-math.pdf`), units 1 to 4: question pages 6 to 115 and the
  practice solutions, pages 285 to 313, as the answer file: 139 picked pages, 3.5 times today's cap.
  Every set numbers from 1. The book is born digital, so pages go with their text and the answers as
  text, as production sends them.
- **The gold** (`long_selections.py gold`) comes from the text layer: 144 questions, 148 parts, 7 with
  a figure; 70 practice questions with a printed solution and 74 exercises without. Nothing prints
  marks, so every part is worth 1. A saved question matches the gold by its text, on a page within one
  of the map's.
- **Patched for the bench only:** no layout service; the quiz caps lifted; a nonce on the system prompt
  so no run reads another's cache; the window and thread rules above.
- **Model:** `deepseek/deepseek-v4.1-flash-1017` on the extraction route; credits at Epo's 1017 price
  (200, 20 and 1,200 micros a token).
- **Spend:** $2.43 of the $5: $2.33 for the 12 measured runs, $0.08 for smoke tests on pages 9 to 21, $0.02 for the 16 scan maps.

## What other apps do

None of them documents reading a long file's existing questions in windows, and none publishes
a page cap for it. Canvas and Moodle import only structured formats; the one app that extracts
questions from any file cuts the file off instead.

| App | Takes existing questions from a PDF or Word file? | Limit | Source |
|---|---|---|---|
| Canvas | No: New Quizzes imports QTI packages, not Word or PDF | none published | [New Quizzes FAQ](https://community.instructure.com/en/en/kb/articles/664245-faq-new-quizzes), [QTI import](https://community.instructure.com/en/kb/articles/661050-how-do-i-import-a-quiz-from-a-qti-package-in-new-quizzes) |
| Google Forms | Gemini makes a new quiz from a Drive file; extracting the file's own questions isn't documented | none published | [Workspace Updates, 2026-07](https://workspaceupdates.googleblog.com/2026/07/use-gemini-in-google-forms-to-quickly-create-a-new-quiz.html) |
| Moodle | Only structured text (Aiken, GIFT) or the Word-table plugin's layout, not a free-form PDF | memory-bound; the plugin says 1,000 questions or more | [Word table plugin](https://moodle.org/plugins/qformat_wordtable) |
| Wayground (Quizizz) | Yes: it extracts questions from PDF, DOCX, PPTX and images | only the first 16,000 characters, one file at a time; the rest is ignored | [Wayground AI](https://help.wayground.com/support/solutions/articles/158000405095-wayground-ai-turn-worksheets-question-banks-more-into-interactive-assessments) |
| NotebookLM | Sources, then generated quizzes, not imports | 500,000 words or 200 MB a source | [NotebookLM FAQ](https://support.google.com/notebooklm/answer/16269187) |
| Microsoft Forms | Quick Import takes Word and PDF; Copilot generates from text | no number published | [Copilot in Forms FAQ](https://support.microsoft.com/office/frequently-asked-questions-about-copilot-in-forms-c9941b72-b32e-4c7e-9af9-e603929bb1d2) |

The context window isn't the limit: 1017 takes about 1M tokens on all three of the route's providers
(OpenRouter's endpoint list, 2026-11-21). The images a request are, at 32 on Cloudflare and about 109
on InferenceNet ([provider limits](#provider-limits)). Anthropic's API, for comparison, takes 600
images a request and advises splitting large PDFs into chunks
([vision](https://platform.claude.com/docs/en/build-with-claude/vision),
[PDF support](https://platform.claude.com/docs/en/build-with-claude/pdf-support)). So past 30 images
the cap is ours to set, from cost, wait and accuracy.

## Reproduce

```sh
S=bench/extraction/scripts; D=data   # the question bank and the earlier rounds' caches
python -I $S/long_selections.py gold
python -I $S/long_selections.py run --env-file deploy/.env.uat \
  --arms one:2 w40:2 w20:2 w10:2 w20o:2 c30:2 --hard-stop 4.5
python -I $S/long_selections.py score --detail --json scores.json
python -I $S/long_selections.py scan-maps --env-file deploy/.env.uat \
  --refs $D/question-bank/references/hkdse-math-compulsory \
  --gold <extraction gold> --text-cache <.results/text of the earlier rounds> --repeat 1
python -I $S/long_selections.py scan-maps --refs ... --gold <extraction gold> --score
# --pages 9-21 on run and score keeps a smoke test apart.
```

Results land in the ignored `.results/long/`.
