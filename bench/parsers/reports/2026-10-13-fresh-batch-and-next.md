# Fresh unseen batch, an ODL fork, and what to do next

Date: 2026-10-13. Follows [parser v13 and the budget](2026-10-12-parser-v13-budget.md)
and the [native-role experiment](2026-10-13-native-role-model.md).

## Findings

- **No overfitting.** On 30 documents that no parser round has seen, the
  current parser scored as follows against v12 in a blind A/B review of 88
  pages:

  | Element | v12 | Current |
  | --- | ---: | ---: |
  | Figures | 0.35 | **0.60** |
  | Headings | 0.59 | 0.61 |
  | False headings | 44 | 41 |

  Formulas, tables, section paths and prose were identical. No document got
  worse overall.
- **Three regressions, all in vector figures, now fixed.** The fresh batch
  showed v13's figure detector taking three kinds of non-figure:
  - shaded callout boxes (a Chinese curriculum guide);
  - framed code listings (two Smalltalk books);
  - small ruled tables whose rows ODL had merged (Federal Reserve statements).

  The guards that fix them are in `pictures.add_vector_figures`: a sentence,
  code characters, or merged table rows inside a cluster keep it as text.
  Source and note lines become the figure's footnote. Effect:

  | Document | Figures before | After |
  | --- | ---: | ---: |
  | Federal Reserve statements | 14 | 3 |
  | Smalltalk book (pharo) | 252 | 100 |
  | Second Smalltalk book | 11 | 5 |
  | Bundestag charts | 19 | 9 (real charts kept) |
  | Instrumentation diagrams | 8 | 8 |
  | Biology textbook | 143 | 127 |

  The blind grades above were taken before these guards; the guards only remove
  figures the reviewers had flagged.
- **An ODL fork would not pay for itself yet.** Our repair logic is cheap; the
  cost is in re-reading PDF pages that ODL has already read (section 3). That
  can be removed inside our own code first.

## 1. Fresh batch

- **What's in it:**
  - 24 web PDFs from official publishers: arXiv (math, physics, two-column
    REVTeX), a Caltech thesis, NACA's 1948 scanned report, Federal Reserve
    financial statements, EIA and UN reports, an IRS form, an ETSI standard, a
    US Supreme Court opinion, a UK POSTnote, CMU lecture slides, an AQA GCSE
    exam, a chemistry lab manual, an LLNL magazine, a WHO poster, VA/DoD and
    CDC guidelines, a MEXT Japanese white paper, a Hong Kong Chinese curriculum
    guide, a German Bundestag report, a French Senate report, and a Spanish law.
  - 6 library books no round had used.
- **Limits:** every document fits the upload limits.
- **Manifest:** `fixtures/fresh-pdfs-2026-10-13.json`, with licences as stated
  on each source page; the PDFs stay in the ignored `reports/local/2026-10-13-fresh/`.
- **Arms:** v12 is commit `6cafe6a0`'s `parser/`; "current" is the working tree.
- **Review:** 3 seeded pages per document, graded by six blind reviewers with
  the same rubric as before, with A and B shuffled per page.
- **Automated checks:**
  - No crashes.
  - Time is +4% on average; the largest increase is +13% on a 420-page
    Smalltalk book with 252 drawn frames, which is now 100.
  - Maximum heading depth falls everywhere, for example from 85 to 10 (EIA) and
    from 57 to 7 (Bundestag).
  - Private-use glyphs are gone from the Supreme Court opinion.
- **What the reviewers credited to the current parser:**
  - the WHO poster's step illustrations;
  - the UN report's map and line chart;
  - the LLNL magazine's scaling chart;
  - the CMU course footer, now treated as page furniture;
  - the Chinese guide's heading levels.

## 2. What still fails, from the fresh batch (both parsers)

Ranked by how many of the 30 documents show the failure:

1. **Running headers and footers become headings and enter section paths.**
   Seen in about 10 documents: ETSI, VA/DoD, IRS, LIGO, CDC, Chinese guide,
   MEXT, Bundestag, Spanish law banner, music book. Examples: page-number
   footers ("February 2022 Page N of 159", "x-y 特殊學校課程指引") and headers
   carrying a volume or issue number. The native-role model's furniture class
   (F1 0.98 on held-out books, no running head promoted) targets exactly this.
2. **Headings swallowed into list items** (Caltech thesis, ETSI, MEXT, Spanish
   law, Perelman, VA/DoD). A numbered heading ("1.5 Noise models", "5.10 …",
   "Artículo 18.") starts a list item together with its paragraph, so later
   chunks keep the previous section's path. This is an ODL list-detection
   decision; our list repairs never split a heading out of a list item.
3. **Slide titles and slide tables** (CMU deck). Every slide title is missed and
   slide tables become lists.
4. **Tables:**
   - sparse or borderless tables are flattened (statistics book, POSTnote);
   - body rows are merged into one cell (EIA Table 7d, Federal Reserve);
   - boxed digits and tick boxes become false tables (AQA exam);
   - table captions become headings (lab manual, ETSI).
5. **Formula and chemistry structure:**
   - error bars (`0.09^{+0.03}_{-0.04}`);
   - ⇌ read as "l";
   - flattened exponents and fractions (Perelman);
   - subscripts (N2, NH3).

   This is the formula gap measured on 2026-10-12, unchanged.
6. **Captions not attached to figures** (LIGO, pharo, LLNL, WHO), and
   magazine reading order (LLNL).
7. **Text details:**
   - lost line-break hyphens ("mid1950s", "merriamwebster");
   - a space inserted at Japanese line breaks;
   - small-caps titles garbled ("chAPter 9");
   - italic run-in headings missed (French Senate, marine ecology).

## 3. Would an ODL fork be more efficient?

Profile of whole-document parses on the M1 (cProfile; the Java step is the
`select.poll` wait on its subprocess):

| Book | Total | Java | Structure + repairs | PyMuPDF `get_text` (cumulative) | Our Python logic (self time, largest modules) |
| --- | ---: | ---: | ---: | ---: | --- |
| logic-1016p (1,016 pp.) | 82 s | 7 s (9%) | 41 s | 14 s | headings 2.8 s |
| textbook-26mib (610 pp.) | 210 s | 112 s (54%) | 91 s | 28 s | pictures 3.6 s, headings 1.8 s |

Other PyMuPDF time on the textbook: drawings 5.6 s and pixmaps 2.8 s. In all,
about 40% of the Python stages' time goes to PyMuPDF re-extracting text,
drawings and renders that ODL's veraPDF pass has already read. About 50 call
sites in 18 modules re-open or re-read pages. The repair logic itself is a few
seconds per book.

What each option buys:

- **Extract once inside our own code (no fork).** Build one page cache per
  document (spans with font and flags, drawings, image info) and have every
  stage read it, instead of each stage calling `get_text("dict")` again.
  - *Expected [E]:* the PyMuPDF share falls from about 40% to under 10% of the
    Python time, which is roughly −15% to −25% total on large books.
  - *Risk:* low; stage outputs must be byte-identical before and after, which
    the budget fixtures check.
  - *Memory:* a full-book span cache at 1,400 pages needs measuring; caching per
    page and processing page by page avoids it.
- **Fork ODL so its JSON carries spans, fonts and drawings.** This removes the
  remaining PyMuPDF reads and the box mismatch between ODL and PyMuPDF that
  several repairs work around (the thin-box retry, the source-span evidence
  test).
  - *Cost:* a Java fork to maintain against upstream. The BetterOffice
    `capy-ci` workflow is the template.
  - Worth it after the page cache, once the remaining gap is measured.
- **Run repairs inside Java as a first pass.** This saves little: the repairs
  themselves cost seconds. Rewriting about 9k lines of tested Python in Java
  would cost months of risk for that.
- **Parallel Java on large books.** ODL runs one Java thread per document, so a
  610-page book spends 112 s there.
  - ODL has an experimental parallel page mode, which its wrapper says may vary
    its output.
  - Measuring it against the budget fixtures (identical output, time) is cheap
    and needs no fork.

## Update: step 1 done (margin runs)

`headings._margin_runs` targets the most common failure from section 2:
running heads and feet whose folio sits anywhere in the text, or whose text
fails span evidence.

- **Coverage:** 49 documents, the 30 fresh ones and 19 earlier books.
- **Removed:** 841 heads and feet. Every distinct text was inspected and all
  are running furniture: "February 2022 Page N of 159", ETSI and MEXT
  headers, the CDC footer, "Turn over ►", the journal header, and Marine
  Ecology's "marine ecology notes N".
- **Section paths:** 685 chunk paths drop such a head. Matched by position, no
  other path changes (VA/DoD 0 of 469, Marine 0 of 504, Bundestag 49 of 489,
  all junk removed).
- **Line-model furniture:** not needed for this class; the rule reads only
  block text and needs no model.

## Update: step 2 done (headings folded into list items)

`list_headings.split_headings` splits a numbered heading ODL read as a list
item into list, heading and paragraph.

- **What was missed at first:** the targeted cases needed three readings of
  the source the first version lacked. Caltech and ETSI set the number apart
  from the title on the same row; MEXT marks headings by a heavier font
  (Medium against a Light body, 0.3 pt larger); BOE sets "Artículo 18." bold
  and "Organización." italic.
- **False splits removed by rule, all seen on the 49 documents:** review
  questions and instructions (healthcare book), exercise parts ("a.
  Explain…"), contents lists (legal citation, LLNL, Senate), figure step
  labels ("3 Anaphase I"), numbers ("0.000 1.00", "76 %"), a name ("M.
  Olivier"), Perelman's run-in theorem labels, and fragments caused by a
  slicing bug.
- **Result:** 455 headings split in 21 of 49 documents; 1,143 of 10,512 chunk
  paths in those documents change. Sampled changes are corrections (Caltech,
  BOE, marine ecology, ETSI, open-logic, MATLAB). Left: one flow-chart box
  ("5. Box 9") in VA/DoD, and the topological-insulators paper, where the new
  "A."/"B." sections let the backbone find the Roman chapter chain, so the
  page-2 subsections sit at chapter rank while later ones nest.

## Update: blind holdout gate (figure guards plus steps 1 and 2)

The first run of `scripts/holdout_gate.py` (see the README). A subagent
fetched 29 openly published PDFs that no earlier set contains. It parsed them
with HEAD's parser and the candidate, and graded 86 pages blind. The developer
saw only these aggregates; the details stay in the ignored
`reports/local/holdout-2026-10-13/`.

- **The set:** 4 scans, 7 math or engineering, 8 table-heavy, 4 slide decks,
  7 non-English (Arabic, Japanese, Chinese, Korean, Russian, German), 7 over 150
  pages, plus a form, a magazine, a poster, a thesis, a standard and a court
  opinion.

| Element | n | Base | Candidate | Win/tie/loss | Difference [95% CI] |
| --- | ---: | ---: | ---: | ---: | --- |
| Formulas | 100 | 0.41 | 0.41 | 0/100/0 | +0.00 |
| Tables | 44 | 0.76 | 0.76 | 0/44/0 | +0.00 |
| Figures | 38 | 0.59 | 0.59 | 0/38/0 | +0.00 |
| Headings | 114 | 0.66 | 0.69 | 4/110/0 | +0.03 [+0.00, +0.08] |
| Section paths | 86 | 0.47 | 0.49 | 7/74/5 | +0.02 [−0.04, +0.08] |
| Text | 86 | 0.72 | 0.72 | 0/86/0 | +0.00 |

- **False headings:** 43 → 28. False tables unchanged (11).
- **Documents:** 4 better, 3 worse, 22 the same.
- **Crashes:** none in either arm.
- **Time:** +6% in total (median +5%, max +12%).
- **Verdict:** passes. Nothing is worse with confidence, and headings
  improve. The weakest elements on unseen documents are formulas (0.41) and
  section paths (0.47), which the next steps target.
- **This set is spent for this version.** The next gate fetches new
  documents.

## Update: speed (step 3) and folding the repairs into ODL

Measured on the M1 with base and candidate run alternately; the Mac was
shared with other work (load 4–6), so whole-document totals vary by ±15%.

- **Page cache** (`page_text.py`). Nine stages read the same
  `get_text("dict")` and three the same words. They now share one read per
  page, up to 100,000 spans (about 90 MiB). Two stages' text-trace reads became
  one set of small facts, and the hidden-layer test reads image placements only
  for pages whose characters qualify. A whole-document cache was ruled out on
  memory: 414 MiB of dicts for the 1,016-page logic book and 870 MiB of traces
  at the page cap.
  - **Effect:** output byte-identical on 9 budget PDFs over two rounds. The
    Python stages ran 11–38% faster: legal 8.9 → 5.5 s, worked math
    6.6 → 4.4 s, textbook 64 → 54 s, logic 33 → 29 s, page cap 41 → 36 s.
- **ODL's `--threads`.** Same output at 2 and 4 threads, but no speed gain:
  the textbook ran 124 s at 1 thread against 133–141 s with more. It stays at 1.
- **No ODL image files.** A Java Flight Recorder profile of the textbook put
  85% of ODL's time in decoding every placed picture pixel by pixel (AWT
  `getPixel`/`setPixel`) and PNG-encoding it. The only use of those files was a
  SHA-1 for repeat detection; the Markdown was not read at all. ODL now runs
  `--format json --image-output off`, and `pictures.classify` takes MuPDF's
  image digest for the image whose box overlaps the picture by at least half
  the union. The first version matched by largest overlap, so page-wide
  backgrounds swallowed every small picture: 9,354 repeats came back on the
  textbook, a bug caught by the identity check.
  - **Output:** identical on 52 of 56 outputs (49 documents and 7 budget
    PDFs). The other four now drop 48 tiny repeated pictures that ODL had never
    written usable files for: 1×1-pixel patches stretched over NACA's scan, and
    3–6 pt icons in the curriculum guide and the textbook.
  - **Time:** the textbook falls from 189 s to 87 s and its Java step from 127 s
    to 8 s. Vector drawings fall from 45 to 36 s and worked math from 17 to 11 s.
    The 49 documents took 1,055 s before and 921 s with the first version.

**Where the time is now** (per stage, PyMuPDF share in brackets):

| Book | Total | Java | Largest Python stages | PyMuPDF overall |
| --- | ---: | ---: | --- | ---: |
| textbook (610 pp.) | 96 s | 8 s | picture triage 45 s (28 s), table recovery 6 s (6 s), ligatures 5 s, heading roles 7 s | 50 s |
| logic (1,016 pp.) | 75 s | 8 s | OCR of 18 text-less pages 35 s, heading roles 15 s (10 s), list headings 4 s | 21 s |
| legal (277 pp.) | 13 s | 4 s | OCR 3 s, heading evidence 1.5 s | 4 s |

Picture triage is now the largest stage on figure-heavy books. Its MuPDF
`get_image_info` call replays every page's drawing operators to find where
images are placed: 18.6 s on the textbook, almost all of it the replay
(hashing the 2,338 image streams raw takes 0.1 s). This is work veraPDF has
already done inside ODL: `ChunkParser` creates each `ImageChunk` with the
image's object key.

### Folding the repairs into ODL

A read of ODL 2.5.7's source (`DocumentProcessor`, veraPDF `ChunkParser`,
wcag-algorithms) found:

- **No fork is needed to run Java inside ODL's pipeline.**
  `opendataloader-pdf-core` is on Maven Central, and every processor entry
  point plus `DocumentProcessor.extractContents`, `sortContents` and
  `generateOutputs` is public static. A Capy Java main can run ODL as a library
  and add steps after extraction. Inserting steps mid-pipeline means copying
  the private `processDocument` (about 190 lines) and re-syncing it each
  release.
- **Some data is gone before ODL runs.** veraPDF drops glyph codes and the
  font's ToUnicode map, the text rendering mode, and path fill colours. The
  font repair, hidden-layer detection, cell styles and vector figures depend
  on these. Moving those into Java means forking veraPDF too; its files are
  MPL-2.0, so patched files must be published.
- **Upstream moves fast.** There were 27 releases from 2.0.0 (March) to 2.5.13
  (12 October) and 360 commits in six months; the processors changed by
  hundreds of lines per minor release. Open PRs touch lists, headings, reading
  order and vector overlays, the same areas as our repairs.
- **The rules are tuned to MuPDF spans.** veraPDF's chunks are cut and merged
  differently, so porting a rule is not a translation. Every ported rule needs
  the lab replay and a blind gate again, and that is most of the cost.

**What a Java first pass would remove:** at most the PyMuPDF time (50 s on the
textbook, 21 s on logic, 4 s on legal) plus the Python overhead of the rules
themselves (roughly 30 s, 10 s and 2 s). OCR stays where it is.

**Recommendation:**

- Do not port the 8,000 lines of repairs into ODL. The gain is at most about
  half of today's Python time. The cost is a Java rewrite of rules that took
  months to tune, re-validation of every rule, and a fork of a project
  releasing every one or two weeks, plus a veraPDF fork for four stages.
- Instead, add a small Capy Java entry point that runs ODL as a library and
  enriches its JSON with facts our stages re-extract, starting with the
  output-neutral ones:
  1. each picture's image object (removes the 18.6 s placement replay, about a
     fifth of the textbook parse);
  2. per-chunk weight, italic angle, baseline and glyph ends, which the
     heading and list rules now read from MuPDF spans.

  Each one is adopted only if the budget fixtures stay byte-identical, or the
  blind gate passes where output changes. That keeps the upstream jar
  unmodified and the maintenance to one small module.

## Update: quality round (text, captions, formulas, headings, tables) and the Java entry point

- **Java entry point.** `parser/java/CapyMain.java` runs ODL as a library:
  - Same options, byte-identical JSON and the same speed as the CLI.
  - It adds `capy-images.json`, the PDF object each picture element draws.
  - Picture triage decodes each object once (1.5 s on the textbook) instead of
    replaying every page in MuPDF (18.6 s).
  - Output was identical on 54 of 56 documents and budget PDFs; the other two
    are the same book, where 2 of 13,435 repeat decisions changed.
  - Built by `parser/java/build.sh`; the image gets a JDK build stage.

All numbers below are on the 49 development documents unless stated.

| Change | Effect | Check |
| --- | --- | --- |
| Line joins (`joins.py`) | 2,484 spaces ODL put between wrapped CJK lines removed; 996 dropped hyphens restored ("long-term", "mid-1950s", URLs) | Samples read correct; short lines (lists of names) and camel-case code are left alone |
| Captions and note labels are not headings | 55 headings ("Figure 4.10:", "Abbildung 3:", "Table A-2.", "Notes:") become text | 358 of 20,744 chunk paths change, by removing such a head |
| Figure captions attached | ODL had captioned 0 of 5,841 pictures; 832 now carry their printed caption | Sentences that only refer to a figure stay text |
| Formula structure (`scripts.py`) | Scripts, fractions, roots and big-operator limits rebuilt from geometry, in 1,258 blocks | Blind grading, 47 pages and 269 formulas: good 46 → 180, none worse, no prose damaged |
| Heading recall (`layout_headings.py`), no model | 425 headings recalled; 3,975 of 20,929 chunk paths change (see below) | Line-level heading F1 on 12 held-out books 0.77 → 0.81 (the trained model: 0.85); 72 review pages 0.82 → 0.84 at precision 0.97 |
| Empty tables | 927 of 1,923 tables had no text: dropped after recovery, and they no longer block vector figures | No index text changes |

**Where the path changes are:**

- **Corrections:**
  - The anthology's real sections ("Europe", "Middle East", "China", "Japan")
    replace a "Part Two" volume label as the top of 2,140 paths.
  - Statistical thinking and multivariable calculus gain their chapter titles.
  - Marine ecology gains its sections.
  - The CDC guideline gains "Recommendation N".
- **Still noise:** dated subtitle lines in the anthology ("Written in the late
  1100s C.E."), and one author line in VA/DoD.
- **Fixed before shipping:**
  - title pages (no recall before the parser's first heading);
  - "[1 mark]" and parenthetical asides;
  - run-in labels;
  - calculation lines with "=".

**Speed.** One run of each version on the budget PDFs, CPU time; the Mac was
loaded, so wall times vary by ±15–40%. The baseline is the parser just before
this round: page cache, no image files, entry point.

- **Python CPU overall:** +11%.
  - textbook +29%, page cap +21%, logic +6%;
  - vector drawings −13% (empty tables free its OCR order work).
- **Peak memory:** unchanged.
- **New stage costs on the 1,016-page logic book:** formulas about 12 s, heading
  recall about 8 s, joins about 4 s.
  - Most of this is re-reading pages past the page cache's budget.
  - Reading each page once inside these stages cut heading recall and formulas
    by 20–25%, with identical output.

**A regression caught and fixed.** The first image-digest matcher compared
every picture with every image on a page. The 3,311-page instrumentation
manual has pages of 17,561 inline images and ran for hours. An exact box key
and a cell grid fixed it, with identical matches; that book now parses in 335 s
(v13: 283 s). The budget gained an `inline-images` fixture (11 pages of that
CC BY book) so the gate catches this class.

**Not done:**

- Merged body rows in financial tables, and charts read as tables with doubled
  characters (EIA).
- Fractions with no drawn bar and formulas set as images: this is where a
  recognition model would earn its cost.
- Headings set in the body style (37 of the 77 the rule still misses).
- Levels for recalled headings come from style rank and can sit too high.

## 4. Next steps, in order

1. ~~Running header and footer furniture~~: done, see the update above.
2. ~~Split headings out of list items~~: done, see the update below.
3. ~~One extraction per page, Java's parallel mode~~: done, see "Update:
   speed" below; ODL also stopped writing image files.
4. ~~Heading recall~~: done without a model, see the quality round.
5. ~~Formula structure~~: done natively (geometry), see the quality round; the recognition model only for barless fractions and image formulas.
6. **Tables:**
   - Empty tables are dropped (done).
   - Still to do: row splitting for merged body cells, and charts read as
     tables.
7. **Ship as v14:**
   - Bump the parser identity: this round changes output well beyond v13.
   - Run the blind holdout gate on a new set.
   - Re-derive the CI budgets from three green runs: the proposed ones predate
     the speed work and the new stages.

## Reproduction

- Fresh batch: `fixtures/fresh-pdfs-2026-10-13.json`; the PDFs are in
  `reports/local/2026-10-13-fresh/pdfs/`.
- Review data: `reports/local/2026-10-13-fresh/` (`review/`, `blind_key.json`, `packets/`, `stats.json`); the parses themselves were in the session scratch `fresh-eval/`, holding the `out-v12/`,
  `out-final/` and `out-final3/` parses, the blinded packets, `blind_key.json`
  and `review/`, plus `aggregate.py` and `stats.py`. It is not kept in the
  repo; the review JSON is summarised above.
- Profile: `cProfile` over `odl.refine.parse_pdf`, run on the budget fixtures
  with the shipped parser venv.
