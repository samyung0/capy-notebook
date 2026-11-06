# Make a quiz: the pages with no indexed text (2026-11-05)

Epo asked to test sending less text after 2022 P2 Q34's digit rule failed, and pointed out they thought
only the image and the box JSON were sent. Here `mapcopy16` with the open-part fix runs with one change:
each page goes as its heading and image, with no indexed text.

All 1017 on the extraction route. Script: `scripts/copy_first.py`, variant flag `-notext`. No app or
pipeline code changed. Mac, 2026-11-05. Every call's tokens are in `2026-11-05-no-page-text/per-call.md`.

## Verdict

**Stop sending the text on every paper, and add two code fixes: strip `**` and convert `\(`.** The numbers
rule out keeping it everywhere. On scans they support dropping it. On born-digital papers they don't
separate the two, so my pick there rests on having one route, not on accuracy.

| Option | What the numbers say |
|---|---|
| Keep text everywhere | **Not supported.** It is the only option where the same wrong reading comes back every run. No check catches those, and Q34's rule test shows wording doesn't fix them |
| Keep it only for born-digital | **Supported, and the safe fallback.** It avoids most of the new `**`. It needs a per-page flag and a system sentence that fits mixed pages |
| **Drop it everywhere** | **Supported, and my pick.** One route, one sentence. Reading on born-digital ties once `**` is stripped. Dense, small-print and non-English pages are untested, and I would test one of each before shipping |

**What dropping fixes.** Q34 reads six zeros in 9 of 10 alone, against 1 of 10, and 3 of 3 in the real
batch, against 0 of 4. It also fixes a fault nobody had seen: 2021 P1 Q8(b)(ii) follows a wrong page read in
5 of 6 runs with text, and in 0 of 3 without.

**What it doesn't change.** The map: all 15 have the same rows as a map sent the text. No question or
figure was lost, parts, marks and totals held, and no number changed except Q34's.

**What it costs.**

- **On 2022 P2 it is a trade.** That paper has one fault a run either way. With text, it is Q34 every run. Without,
  it is a first alpha read as the letter a in Q1 (2 of 3) and an identity sign read as equals in Q3 (1 of 3). Those
  vary from run to run, so a second read could catch them. They are still faults, and Q1's changes the maths.
- **Raw `**` on born-digital papers:** 4 of 6 runs, against 1 of 12 with text. The app shows the asterisks.
- **It saves almost no money.** Input falls 0 to 5% in cost. Output swings by more than that, in both directions.

| Paper, kind | Set | Runs | Wall s | Billed | Credits | Input tokens | Recorded, answered | Marks right as saved | Figures: whole, tight, both | Never named |
|---|---|---:|---:|---:|---:|---:|---|---|---|---:|
| 2022 P2, scan | With text, fixed | 1 | 124 | $0.0327 | 73.5 | 618,706 | 45, 45 | 45/45 | 10, 10, 10 | 0 |
| | With text, before the fix | 3 | 182 (155-208) | $0.0360 | 80.9 | 637,461 | 45, 45 | 45/45 | 30, 30, 30 | 0 |
| | **No text** | 3 | **123 (105-145)** | **$0.0290** | 65.1 | 510,069 | 45, 45 | 45/45 | 30, 30, 30 | 0 |
| 2023 P2, scan with an OCR layer | With text, fixed | 1 | 194 | $0.0346 | 77.8 | 659,187 | 45, 45 | no gold | 9, 7, 7 | 0 |
| | With text, before the fix | 3 | 181 (155-214) | $0.0357 | 80.0 | 620,984 | 45, 45 | no gold | 27, 21, 21 | 0 |
| | **No text** | 3 | **173 (155-189)** | **$0.0346** | 77.2 | 507,131 | 45, 45 | no gold | 27, 21, 21 | 0 |
| 2021 P1, scan, no scheme | With text, fixed | 3 | 69 (62-82) | $0.0081 | 18.2 | 111,199 | 10, 10 | 9, 8, 9 of 10 | 6, 6, 6 | 0 |
| | **No text** | 3 | **77 (69-86)** | **$0.0083** | 18.7 | 107,245 | 10, 10 | 10, 9, 9 of 10 | 6, 6, 6 | 0 |
| Biology, born-digital | With text, fixed | 3 | 137 (135-138) | $0.0123 | 27.8 | 170,879 | 6, 6 | 6/6 | 21, 24, 21 | 0 |
| | **No text** | 3 | **170 (127-204)** | **$0.0139** | 31.4 | 195,073 | 6, 6 | 6/6 | 21, 24, 21 | 0 |
| Maths, born-digital | With text, fixed | 3 | 107 (69-156) | $0.0208 | 47.1 | 434,132 | 26, 26 | 26/26 | 27, 27, 24 | 0 |
| | **No text** | 3 | **129 (109-156)** | **$0.0224** | 50.5 | 426,208 | 26, 26 | 26/26 | 27, 27, 24 | 0 |

Means, lowest and highest in brackets. Figure counts are sums over a row's runs. The fixed row has one run on
the two multiple-choice papers, so I show yesterday's three as well. Their copy calls differ only in
`record_answers`' schema. 2023 P2 and Biology's and Maths' whole, tight and both misses are the known detector
limits.

### What is noise

Three runs a paper is small.

- **Real:** Q34. 9 of 10 against 1 of 10 has about a 1 in 1,000 chance of arising by luck, and 3 of 3 against 0
  of 4 about 3 in 100. So is `**` on born-digital papers, at about 2 in 100.
- **Probably real:** 2021 P1 Q8(b)(ii), 3 of 3 against 1 of 6, about 5 in 100. The page read holds the wrong
  letters, which explains it.
- **Not settled:** Q1's alpha (2 of 3 against 0 of 4, about 14 in 100) and Q3's identity sign (once). Maths Q11 and
  Biology Q1's lost words (once each). The refusals below.
- **Not settled, on cost:** 2022 P2's lower bill. All three runs ($0.0263-$0.0322) sit below all four with text
  ($0.0327-$0.0392), and most of the fall is solve output. No other paper shows it.
- **Noise:** every other difference in wall time and billed cost, since the ranges overlap. Marks on 2021 P1, keys,
  answer lines copied, and the `\(` batch.

## The three kinds of paper

The brief asked for scanned and born-digital apart. There turn out to be three kinds, and a test for "has a text
layer" can't tell the last two apart.

| Kind | Papers | Where the indexed text comes from |
|---|---|---|
| Scan, no layer | 2022 P2, 2021 P1 | The VLM page read |
| Scan with a hidden OCR layer | 2023 P2 | Its PDF's layer, made by Acrobat's Paper Capture. The roughest text here |
| Born-digital | Biology, Maths | The text layer |

The parser's own `hidden_text_layer` flags all 15 of 2023 P2's pages and none on 2022 P2, Biology or Maths, so the
fallback option has its test. Without it, 2023 P2 would count as born-digital.

**Faults against the page.** I compared every run's text question by question, markup aside, then looked at the
page wherever runs disagreed. The bench's checks catch none of these.

| Paper, kind | Question | What goes wrong | With text | No text | Source |
|---|---|---|---:|---:|---|
| 2022 P2, scan | Q34 | One zero lost from a long number | 4 of 4 | 0 of 3 | Page read |
| 2021 P1, scan | Q8(b)(ii) | A triangle's letters in the wrong order, the same triangle | 5 of 6 | 0 of 3 | Page read |
| 2023 P2, scan with a layer | Q8 | Alpha written as the letter a throughout | 1 of 4 | 0 of 3 | OCR layer |
| 2022 P2, scan | Q1 | The first alpha read as the letter a | 0 of 4 | 2 of 3 | Image, the page read is right |
| 2022 P2, scan | Q3 | An identity sign read as equals | 0 of 4 | 1 of 3 | Image, the page read is right |
| Maths, born-digital | Q11 | A fraction in an exponent turned upside down | 1 of 6 | 0 of 3 | Text layer, which lists its digits that way |
| Maths, born-digital | Q16 | Its opening sentence lost | 1 of 6 | 0 of 3 | Unknown, before the fix |
| Biology, born-digital | Q1 | Four words lost from the first sentence | 0 of 6 | 1 of 3 | They went into that figure's description |
| Maths, born-digital | Q4 | The word "angle" written as the symbol, 3 times | 0 of 6 | 1 of 3 | The meaning holds |

"With text" here counts every saved `mapcopy16` run, fixed or not, and 2021 P1's scheme runs, whose copy calls are
identical. A reading every run shares can't show up in this comparison, so these are the faults I could find,
not all of them.

| Kind | Faults a run, with text | Faults a run, no text |
|---|---:|---:|
| Scans | 10 in 14 runs, 0.7 | 3 in 9 runs, 0.3 |
| 2022 P2 alone | 4 in 4, 1.0 | 3 in 3, 1.0 |
| Born-digital | 2 in 12, 0.2 | 2 in 6, 0.3, one of them harmless |

Scans lean clearly one way, but most of that lean is the harmless Q8(b)(ii). The born-digital row is a tie.

## Q34

| Flow | Set | Six zeros | Other counts | Printed exponents | Billed a run | Wall s | Copy reasoning, mean (range) | Copy output, mean (range) |
|---|---|---:|---|---:|---:|---:|---:|---:|
| Alone | With text, Arm A | **1 of 10** | five in 9 | 10 of 10 | $0.0032 | 23 (20-30) | 274 (96-747) | 528 (339-1,014) |
| Alone | **No text** | **9 of 10** | seven in 1 | 10 of 10 | $0.0031 | 25 (16-43) | 1,107 (35-3,867) | 1,394 (307-4,130) |
| Real batch | With text, saved runs | **0 of 4** | five in 4 | 4 of 4 | | | | |
| Real batch | **No text**, whole runs | **3 of 3** | none | 3 of 3 | | | | |

The flow alone is Arm A's: X over the whole selection, then `Copy question 34 now.` at low.

- **So the page read was the cause.** The rules last time moved this by little. Removing the read moved it from
  1 in 10 to 9 in 10.
- **It isn't perfect.** One run read seven zeros, a count no run with text ever gave.
- **Reasoning on that call rises about 4 times,** and that doesn't change the bill, since the input is smaller.
  Reasoning text isn't saved, so I can't say what it spends it on. Whole batches show no such rise (see Cost).
- **The key was right either way.** Q34 is on no run's list of keys that disagree with gold, on either side.

## Reading

| Paper | Set | Numbers unsupported | Dropped | Questions exact | KaTeX | Stray `$` | `\(` questions | `**` questions |
|---|---|---|---|---|---:|---:|---|---|
| 2022 P2 | With text, fixed | 0 | 0 | 45/45 | 0 | 0 | 0 | 0 |
| | No text | 0, 0, 0 | 0, 0, 0 | 45/45 all | 0 | 0 | 0, 0, 0 | 0, 0, 0 |
| 2023 P2 | With text, fixed | 110 | 153 | 14/44 | 0 | 0 | 0 | 0 |
| | No text | 110, 110, 110 | 153, 153, 153 | 14/44 all | 0 | 1, 0, 0 | 0, 0, 0 | 0, 0, 0 |
| 2021 P1 | With text, fixed | 0, 0, 0 | 0, 0, 0 | 8/8 all | 0 | 0 | 0, 0, 0 | 0, 0, 0 |
| | No text | 0, 0, 0 | 0, 0, 0 | 8/8 all | 0 | 0 | 0, 0, 0 | 0, 0, 0 |
| Biology | With text, fixed | 15, 15, 15 | 36, 36, 26 | 0/6 all | 0 | 0 | 0, 0, 0 | 0, 0, 0 |
| | No text | 15, 15, 15 | 36, 36, 36 | 0/6 all | 0 | 0 | 0, 0, 0 | 0, 6, 6 |
| Maths | With text, fixed | 19, 19, 19 | 17, 17, 17 | 14/26 all | 0 | 0 | 0, 0, 0 | 0, 0, 0 |
| | No text | 19, 19, 19 | 17, 17, 17 | 14/26 all | 0 | 0 | 0, 0, 10 | 0, 1, 1 |

**These checks can't judge this change on scans.** Their reference is the Tesseract read and the same page read
this test removes. 2023 P2's 110 and 153 and Biology's 15 and 36 are the same on every route, so they come from
how the check reads its pages. The direct comparison is better: across all saved runs of a paper, the only question
where no-text numbers differ from those with text is Q34. Differences in Biology and Maths belong to runs with
text that copied answer lines or lost Q16's sentence.

**`**`.** Without the text the model sometimes copies bold as Markdown. `TextView` renders plain text and `$` math,
so learners see the asterisks. Biology: 30 and 29 pairs in 2 of 3 runs. Maths: one question in 2 of 3. With text it
happened in one of 12 born-digital runs (Biology, 5 questions, before the fix) and never on scans. Scans here have
almost no bold, so that says little about bold on other scans.

**`\(`.** One run wrote Maths Q17 to Q26, a whole copy batch, in `\(`. **That corrects the last report,** which said
`\(` follows a page read that uses it. Maths' text layer holds none, and this run was sent no text. Page reads do
hold it (235 on 2022 P2, 3 on 2021 P1), but dropping them won't remove the fault. The code fix is needed either way.

**Everything else matches.**

| Check | With text, fixed | No text |
|---|---|---|
| Parts, marks and totals as copied, Biology and Maths | All right | All right |
| Parts and marks, 2022 P2 | 45/45 | 45/45 all |
| 2021 P1 part marks right as copied, of 19 | 17, 15, 17 | 19, 17, 17 |
| 2021 P1 totals | 10/10 all | 10/10 all |
| 2021 P1 Q7's split wrong | 3 of 3 | 2 of 3 |
| Biology Q2(b) lead-in | 3 of 3 | 3 of 3 |
| 2021 P1 Q8(b) and Q10(b) lead-ins | 3 of 3 | 3 of 3 |
| Maths Q16's opening sentence | 3 of 3 | 3 of 3 |
| Tables: 2023 P2 Q44, Biology Q4 and Q6, Maths Q16 | One each, the same cell counts | The same |
| Answer lines copied, questions a run: Biology | 0, 2, 5 | 0, 0, 2 |
| Answer lines copied, questions a run: Maths | 0, 0, 0 | 0, 1, 0 |
| Open parts with a model answer | All | All |

**Keys.**

| Paper | With text | No text |
|---|---|---|
| 2022 P2, worked-out keys right, of 45 | 43 fixed; 44, 42, 44 before | 42, 44, 43 |
| 2022 P2, saved, after the gold key list | 45/45 | 45/45 all |
| 2023 P2, keys off the commonest, no gold | None fixed; Q21, Q18, none before | Q21, none, none |
| 2021 P1, final answers against the real scheme, a rough number check | 17 of 17 all | 17 of 17 all |
| Maths, parts off the commonest final numbers, no gold | 4, 5, 4 | 7, 10, 3 |

Q16, Q18, Q21 and Q26 make up most of Maths' spread, and they vary with text too: it was 9, 5, 4 before the fix.
Whether Biology's and Maths' answers are right stays untested.

## The map

X lost a source of text, so I checked it row by row against each paper's truth and against the maps sent the text.

| Paper | Rows | Labels missing or extra | Pages wrong | Parts wrong | Same rows as a map with text |
|---|---:|---:|---:|---:|---:|
| 2022 P2 | 45 | 0 | 0 | 0 | 3 of 3 |
| 2023 P2 | 45 | 0 | 0 | 0 | 3 of 3 |
| 2021 P1 | 10 | 0 | 0 | 0 | 3 of 3 |
| Biology | 6 | 0 | 0 | 0 | 3 of 3 |
| Maths | 26 | 0 | 0 | 0 | 3 of 3 |

"Same rows" covers label, first page, last page, parts and figure boxes, so it is an exact match on all 15. The
copy calls moved nothing from the map either. Page numbers come from the page headings, which stay. 2021 P1 tests
that: its selection starts at page 2.

| X call | Input, with text | Input, no text | Saved | Output, with, without | Reasoning, with, without | Seconds, with, without |
|---|---:|---:|---:|---|---|---|
| 2022 P2 | 24,396 | 19,304 | 21% | 891, 1,103 | 250, 462 | 8, 11 |
| 2023 P2 | 23,041 | 18,245 | 21% | 985, 1,088 | 345, 448 | 11, 12 |
| 2021 P1 | 10,997 | 9,816 | 11% | 309, 336 | 142, 169 | 5, 6 |
| Biology | 24,872 | 21,563 | 13% | 670, 726 | 486, 542 | 11, 11 |
| Maths | 24,875 | 21,561 | 13% | 813, 1,119 | 387, 693 | 10, 13 |

X spends a little more on all five. Yesterday's rows run as high as 687 reasoning tokens, so this is not settled,
and it costs little.

## Figures

No change. Whole, tight and both match the fixed rows run for run on all five papers (table above). Never named is 0
in all 15 runs, and nothing went to the box call. The misses are the same ones as with text: Biology Q2's graph, Maths
Q17 and Q25, and 2023 P2's Q23 and Q38.

## Cost and time

**Almost nothing is saved.** The page text is a small part of the input: images dominate, and later calls read it
from cache at a tenth of the price.

| Paper | Uncached input, with, without | Cached share, with, without | Input's cost saved | Output, with, without | Billed change |
|---|---|---|---:|---|---:|
| 2022 P2 | 27,346, 22,005 | 0.956, 0.957 | $0.0014, 4% | 46,857, 42,439 | -11% |
| 2023 P2 | 25,971, 20,560 | 0.961, 0.959 | $0.0018, 5% | 49,982, 52,770 | 0% |
| 2021 P1 | 11,785, 10,562 | 0.894, 0.902 | $0.0001, 2% | 11,567, 12,229 | +2% |
| Biology | 25,343, 22,188 | 0.852, 0.886 | $0.0000 | 16,529, 19,586 | +13% |
| Maths | 26,494, 23,307 | 0.939, 0.945 | $0.0003, 2% | 28,064, 31,480 | +8% |

The with-text side is the fixed row, one run on 2022 P2 and 2023 P2. Against the three earlier runs, 2022 P2 is -19%
and 2023 P2 is -3%. Biology's rise comes from two runs: one with long replies, and one of 9 calls whose solve thread
used 6 rounds. Upload hardly moves: 33.3 to 31.9 MB on 2022 P2.

**Reasoning on copy calls, a run:**

| Paper | With text | No text |
|---|---|---|
| 2022 P2 | 3,567 fixed; 9,212, 5,794, 2,789 before | 4,817, 8,511, 6,666 |
| 2023 P2 | 5,610 fixed; 9,455, 13,052, 6,311 before | 9,535, 6,295, 8,641 |
| 2021 P1 | 3,135, 1,954, 2,181 | 1,637, 2,119, 2,169 |
| Biology | 3,102, 4,101, 2,878 | 6,331, 2,437, 2,270 |
| Maths | 4,856, 10,838, 1,989 | 8,714, 4,159, 5,131 |

The ranges overlap on every paper. The low-reasoning problem stays as it was, in both directions.

**Limits:** 231 calls over the 25 runs, none cut off, none failed, all on InferenceNet. The longest reply was 14,023
tokens (119 s), a 2023 P2 solve. The longest copy reply was 9,740 (77 s). The cached share on first rounds was 0.989 or
more on copy calls and 0.992 or more on solve calls, and 0.991 or more on later solve rounds.

**Refusals:** 8 in 3 of the 15 runs, all recorded in a later round.

| Kind | Run | Times |
|---|---|---:|
| `a marking scheme has 1 to 5 items` | 2021 P1 | 2 |
| `marking items must add up to the part's marks` | Biology Q3 | 1 |
| `invalid accepted answers` | Biology Q3, Maths Q16 | 3, 1 |
| `figures[0].part: the question has no part a` | Maths Q16 | 1 |

The fix's `invalid accepted answers` had never fired in 11 runs with text. Here it fired in 2 of 15, and it took
Biology's thread to 6 rounds, more than any thread in the structured report. I can't tie that to the missing text,
since it is a solve call's answer, and 2 runs is too few to call it either way.

## The wording, verbatim

Nothing else moved: the boxes JSON, all asks, tools, settings and the rest of the system prompt, including its last
`<source>` sentence, are the [structured report's](2026-11-05-copy-first-structured.md#the-prompts-verbatim). The
scheme call reads its own text, unchanged. The wording worked as the brief gave it.

**System prompt, first paragraph.** Before:

```text
You copy the questions printed on exam or worksheet pages into a quiz, exactly as printed. You see all the selected page images at once, each with the page's indexed text, which may be rough: the image is what counts.
```

After:

```text
You copy the questions printed on exam or worksheet pages into a quiz, exactly as printed. You see all the selected page images at once.
```

**Each page in X's user message, then its image.** Before:

```text
Page image 1: page 2 of <file name>. Its indexed text:
<source>
<the page's indexed text>
</source>
```

After:

```text
Page image 1: page 2 of <file name>.
```

Each run saves X's system prompt and text blocks as sent, in `x_sent_text`. All 25 hold the new sentence, and none
holds `<source>` or the words "indexed text" in its user message. Code still reads the page text for one thing, the
copy repair's check for a next question number, which sends nothing to the model.

## Remaining issues

| Issue | How often | Noise? | What I would do |
|---|---|---|---|
| **An image misread on a scan** | Q1's alpha 2 of 3, Q3's identity sign 1 of 3 | Not settled, and only 2022 P2 shows it | Compare the copy with the page's text in code, and re-ask where they disagree. Untested |
| **Raw `**`** | 4 of 6 born-digital runs, 1 of 12 with text | Real | Strip it in code. It is not a prompt change |
| **`\(` math** | 1 of 15 runs here, a whole batch | Real, and not caused by the page read | Convert it in code, or refuse it |
| **Seven zeros** | 1 of 10 alone | Too few | It is why the code comparison above would help |
| **`invalid accepted answers` loops** | 2 of 15, up to 6 rounds | Not settled | Watch for it. `STEPS` caps it at 12 |
| **Words moved into a figure's description** | Biology Q1, 1 of 3 | Once | Watch for it |
| **The word "angle" written as a symbol** | Maths Q4, 1 of 3 | Once | Leave it. The prompt's own example uses the symbol |
| **2023 P2 is a scan with a text layer** | One of the three scans here | Real | The fallback option needs `hidden_text_layer` as well as the text-less list |

## What this can't show

- **Dense, small-print or non-English pages.** Images go at a 1,568 px longest edge. A born-digital page in small type,
  or in Chinese, is where the exact layer should matter most. None is here, and I would not ship the drop without one
  of each.
- **Tables across many pages, handwriting, photos of pages.**
- **The scheme route with no text.** X and the copy calls don't depend on it, but no run tried it.
- **Production's index.** These runs compare against the bench's page text: the PDF's layer or a cached VLM read.
  Production's indexed text goes through the parser, and it may differ.
- **Bold on scans.** Only the born-digital papers here print much bold.
- **Faults every run shares.** Comparing runs can't find those. Only 2022 P2 has any gold for wording, and that is
  option signatures.
- **A rule against `**`.** I tested none, and the fix in code looks enough.
- **Whether Biology's and Maths' answers are right.** No scheme on disk.

## Spend

$0.356 of $1, all 1017 on the extraction route. No downloads and no new venvs. Keys stayed in the process, read only
from their named lines in `deploy/.env.uat`. One process at a time, 3 in flight at most, peak RSS 449 MB.

| Item | Billed |
|---|---:|
| 2022 P2, 2023 P2, Biology and Maths, no text, 12 runs | $0.300 |
| 2021 P1, no text, no scheme, 3 runs | $0.025 |
| Q34 alone, no text, 10 runs | $0.031 |

Nothing covers these scripts with a test.

## Reproduce

```bash
V=mapcopy16-low-fix-notext
python -I bench/extraction/scripts/copy_first.py run --set nopagetext --hard-stop 1 \
  --jobs 2022-p2:$V:1 2023-p2:$V:1 igcse-biology-0610-2023-sp4:$V:1 igcse-maths-0580-2025-sp2:$V:1 \
  2021-p1:mapcopy16-low-fix-noscheme-notext:1 ... \
  --scans <refs>/hkdse-math-compulsory --digital <refs>/born-digital --detections <pp-plus-l-onnx.json> \
  --env-file deploy/.env.uat --parallel 3
python -I bench/extraction/scripts/copy_first.py run --set nopagetext --hard-stop 1 \
  --jobs 2022-p2:mapcopy16-low-fix-noscheme-copyonly-q34-notext:1 ... --scans ... --digital ... --detections ... \
  --env-file deploy/.env.uat --parallel 3
python -I bench/extraction/scripts/copy_first.py no_text --set nopagetext --scans ... --digital ... --detections ...
```

`python` is the repository's `.venv`. Results land in the ignored `.results/nopagetext/`. `no_text` regenerates
`per-call.md` and prints every table here beside the saved runs with text in `.results/copyfirst/` and `copyfirst2/`.
Its last section lists each question's distinct readings, which is what I checked against the pages. Arm A's numbers
are from `copy_first.py q34 --set copyfirst3 --scans x --digital x`. To check a paper's layer, call `hidden_text_layer` from
`parser/odl/hidden.py` on each page.
