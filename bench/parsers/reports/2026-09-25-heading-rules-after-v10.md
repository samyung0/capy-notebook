# Heading rules after v10

2026-09-25. The developer approved measuring four heading rules on top of parser v10
(decision 2026-09-25) and will pick what the implementer ports:

1. book-title marks past the first body-text page narrowed to the title heading (Census
   Income 2024);
2. #12 placement at the outline destination, with `band2` rerun on top;
3. front matter closed at the first chapter in books without an outline;
4. running heads without a folio just below the margin band.

Each rule was measured against production v10 (`ebf5c584`) on the section-path measure,
the agents' paths and the gate profile. No production code was changed, nothing was
committed, no container was started, and the live library and the backfill were only
read. Everything is in `bench/parsers/reports/local/2026-09-25-heading-rules/`, which
git ignores.

## Summary

- **Baseline correction.** With #12's headings in place, production v10 measures
  **1,770** wrong-path chunks.
  - Without them it measures 1,481 under the same mapping. The v10 gate's 1,528 used
    the old mapping and dropped them.
  - ReStorying Education accounts for the rise: 90 → 402.
  - On the agents' paths #12 is still worth +233 chunks (College Research 24 → 248).
  - Every number below compares against v10 with #12 in place.
- **1. Census Income: port the refined form. The gain is small.**
  - The rule as worded unmarks 21 headings in 13 library books. It breaks 8 of them:
    books that repeat their title page after a series page (5 Language Science Press
    grammars, the Unicode Cookbook, Electromagnetics 2, Bad Ideas) get their author
    and publisher lines back in their paths. Agents' paths: 0 fixed, 3 worse.
  - Refined form: the narrowing applies only on pages that themselves carry body text.
    It changes 6 headings in 5 library books, plus Census (9) and NIST FIPS 203 (1) on
    the gate. Agents' paths 0 / 0, measure unchanged, gate profile unchanged.
  - It clears ReStorying's "INTRODUCTION" and keeps its root gain (90). It also unmarks
    ReStorying's subtitle, which then heads 7 introduction chunks.
  - Census was smaller than the v10 gate report said. 900 of the 958 components its
    body lost are the book title, printed three times. The headings the rule restores
    cover 26 body blocks on pages 4-8.
- **2. #12 placement: port the developer's variant. `band2` can go in on top, if it
  reads both folios.**
  - The placement changes nothing without `band2`. Production #12 fires 107 times in 8
    library books and twice on the gate. No saved chunk starts between the top of a
    page and one of those destinations, and the two on the gate are at the top of the
    page or have no height.
  - ReStorying's stale chunks are not caused by placement:
    - #12 fires only where the running head carries the chapter title (chapters that
      open on odd pages).
    - Chapters that open on even pages sit under the book-title running head and get
      no heading.
    - The inserted heading of the chapter before them stays open: 312 chunks.
  - Option (outside the approved rule): promote a body line at the outline destination
    that matches its entry even when no running head carries the title.
    - Agents' paths: +118 fixed, 0 worse.
    - Measure: 1,770 → 1,433. ReStorying goes to 65.
    - Gate: every lost ancestor is explained.
    - Reach: 164 headings in 32 books.
    - It needs two guards, or Media Studies' author tags become headings.
  - `band2` with the variant:
    - Gate real losses go from 24 to 0 (the tail of Chemistry's Key Terms).
    - It adds 953 banners in 10 documents, all OpenStax "N • Title NNN" heads.
    - Agents' paths: +2 / 0. 99 Physics chunks lose a running head from their path.
  - Taking only the larger number breaks running heads whose title ends in a number
    ("12 • MEDIA STUDIES 101") and loses 45 banners. `band2` has to add the larger
    reading, not replace the first one.
- **3. Front matter without an outline: drop it. There is nothing to fix.**
  - 39 documents take the backbone.
  - In the 24 with a chapter chain, no front-matter heading stays in a path past the
    first chapter. The one heading that does is a real Part.
  - The 15 without a chain have no first chapter to close at.
  - Last round's cases no longer occur in v10.
- **4. Folio-less running heads: port, with a guard.**
  - Widening the seed band to 0.10 alone adds 4,911 banners in 47 documents. Most are
    callout labels: "Example", "LINK TO LEARNING", "Note".
  - The guard: a seed below the old 0.065 edge must repeat a title printed earlier as
    a larger body heading.
    - Banners: 3,241 in 13 documents, all running heads.
    - Agents' paths: +983 fixed, 0 worse. Papuan Malay 744 → 1,173, Accounting
      Principles 416 → 816, Unicode Cookbook 106 → 258.
    - Gate: 4 body blocks change and nothing is lost.
  - Adding "or recurs on a quarter of the pages" also catches Accounting Principles'
    book-title and licence heads: +1,460 fixed, 0 worse.
- **The recommended set together** (1 refined, 2 with additive `band2`, 4 with the
  quarter clause):
  - Agents' paths 19,785 → 21,247 (+1,462 fixed, 0 worse). With the line option,
    21,363.
  - Measure 1,770 → 1,770. With the line option, 1,433.
  - Gate: every anchor, root, witness and scope case is kept, and no lost ancestor is
    real.

## How it was measured

**The chain.** `scripts/hr.py` runs the committed parser's stages from `correct_roles`
to `mark_book_titles`, importing `parser/odl` read-only (the working tree equals
`ebf5c584`). A variant is swapped in for one call and restored.

**Arms.**
- `v10` is production. #12's inserted headings stay where production puts them.
- `v10p` is the v10 gate's replay form, which drops them.

**Replay.**
- Chunk starts stay where the saved corpus put them.
- Inserted blocks are replayed in chain order.
- A chunk starts at its first region that is still content. A region the chain turned
  into a heading, banner or furniture hands its stack to the next content block. This
  is what the chunker does with a promoted title line.
- The old mapping (`--map legacy`) reproduces the v10 gate's measure exactly: 1,528,
  with 99 title components. The content mapping gives 1,481 for `v10p`. All numbers
  below use it.

**Section-path measure.** `measure.py` from the section-path investigation, copied as
`measure_x.py` with that one hook. It covers 37 books and 11,658 chunks.
- Its references come from the raw PDF outline, author tags included. Media Studies'
  260 wrong chunks are mostly that: its "mediatexthack" entries end each chapter's
  reference span.

**Agents' paths.**
- Frozen at 01:27 into `gold-2026-09-25.json`, from the same sources and in the same
  override order as last round's `gold.py`.
- A backfill scope's review counts only when the scope directory holds
  `parent-received.json` or `parent-cleanup-received.json`. Physics `scope-024` and
  Open Logic `scope-020` had no receipt and were left out.
- The frozen gold has 48 books (34 from intake, 14 from backfill), 27,963 corrections
  and 35,570 chunks:
  - 34,617 scored;
  - 953 reported apart as unreviewed: Programming Fundamentals, and the Physics chunks
    without a `section_path` correction.
- Scoring is last round's `gold_eval.agree`.
- On this gold, `v10p` scores 19,552 and `v10` 19,785. The v10 gate's 19,388 of 33,372
  used an earlier, smaller gold.
- The second-pass `cleanup-v1` repairs (5,880 path corrections in 68 scope passes) are
  not read, as last round. They would add books to the gold.

**Gate.**
- Item 1 is exact. The final v10 outputs (`v10b`), with their book-title role removed,
  were marked again with each variant. Marking them again with production's rule
  reproduces `v10b`'s marks on all 68 documents.
- Items 2 and 4 are emulated. The chain runs on the fresh v6 parses of the 66
  documents (`v6afresh`, the input of last round's gate replay), and every arm is
  compared with the emulated production arm (`v10e`).
- The emulation is close to the real outputs:
  - 22,297 headings against 22,287;
  - the same 2 #12 headings;
  - the same 94 book-title marks.
- Compares use `gate_parser_fresh.py compare`, and lost ancestors are classed with the
  v10 gate's `classify_lost.py`.
  - `open_check.py` then rechecks each "open" loss: does the next section's #12 heading
    start above the block or below it?
  - The class is computed from the baseline's outline listing. It also counts, as
    "open", a heading that the baseline wrongly held over a section it lacked.

## Baseline: v10 with #12 in place

| Book | Measure `v10p` → `v10` | Agents' paths `v10p` → `v10` |
| --- | ---: | ---: |
| ReStorying Education | 90 → 402 | not in the gold |
| Introduction to College Research | 63 → 56 | 24 → 248 |
| Introduction to Game Theory | 30 → 14 | 144 → 156 |
| Fundamentals of Compressible Fluid Mechanics | — | 531 → 528 |
| **All** | **1,481 → 1,770** | **19,552 → 19,785** |

ReStorying's saved parse is v7's, so its current chunks do not have this problem. A v10
re-parse would give it the 402 (see item 2).

## 1. Census Income 2024: book-title marks past the first body-text page

**Root cause.** `mark_book_titles` marks every unnumbered heading from page 1 to the
last of the first ten pages that carries the title.

- Census reprints its title at the top of its introduction page (page 7). So page 2's
  "Acknowledgments", page 4's "Suggested Citation", the contents on pages 5-6 and page
  7's "INTRODUCTION", "Highlights" and "HOUSEHOLD INCOME BY SELECTED CHARACTERISTICS"
  are all marked.
- ReStorying's "INTRODUCTION" is marked the same way. The title is printed on page 7,
  after the licence page.

**What Census actually loses.** Against v9, Census's 507 body blocks lose 958 path
components.

- 900 of them are the book title itself, which v9 put at the root of the paths:
  - the title page's "Income in the United States: 2024 Issued…" on 495 blocks;
  - the page-7 reprint on 393;
  - the cover on 12.

  The settled path form drops the title, so v10 is right there.
- 21 more stay marked under the refined form: the cover's series line "Current
  Population Reports" (12) and page 2's "Acknowledgments" (9).
- The other headings cover 26 body blocks on pages 4-8: 15 in the front matter and 11
  in the introduction. ODL typed Census's sections one level below its figure titles,
  so "INTRODUCTION" closes at the first figure title on page 8. Nothing past page 8
  changes under any variant.

**The rules.** "Body text" is the dropped 150-character stop's count: characters of
non-heading text blocks on a page. Each variant unmarks headings that do not match a
title source:

| Variant | Which pages lose their non-title marks | Library (126 books) | Gate | Agents' paths | Measure |
| --- | --- | --- | --- | --- | --- |
| as worded (`narrow-after`) | after the first body-text page | 21 headings, 13 books | Census 10, NIST 1 | 0 / 3 | 1,770 |
| inclusive (`narrow`) | from the first body-text page | 27, 15 | Census 11, NIST 3, Music 2, OpenStax Micro 1 | 0 / 5 | 1,770 |
| per page (`narrow-page`) | any page with body text | 12, 7 | Census 10, NIST 3, Music 2, Micro 1 | 0 / 2 | 1,770 |
| **refined (`narrow-both`)** | after the first body-text page, and only pages with body text | **6, 5** | **Census 9, NIST 1** | **0 / 0** | **1,770** |

**Why the wording is not enough.**

- The Language Science Press grammars print title, author and "science press" on page
  1, a series page with body text on page 2, and the title page again on page 3.
- Past page 2, the author line on page 3 is unmarked. It comes back into the paths
  until the outline closes it: "Angela Kluge › science press" in Papuan Malay, "Steven
  Moran Michael Cysouw" in the Unicode Cookbook.
- This is exactly the case the v10 title rule was built for. The same happens to
  Electromagnetics 2's author and Bad Ideas' editors.
- The 13 books the worded rule changes:
  - Palula, Papuan Malay, Pite Saami, Yakkha and Yauyos Quechua: author and "science
    press";
  - the Unicode Cookbook and Electromagnetics 2: authors;
  - Bad Ideas: its editors and "TABLE OF CONTENTS";
  - Entrepreneurship Education and Training: its licence line and "Contents";
  - Basic Income Tax, Educational Administration and Marketing: "Contents";
  - ReStorying: its subtitle and "INTRODUCTION".
- The inclusive and per-page variants go further: they unmark companions on a title
  page that itself carries body text. That hits Music's CUNY cover lines, OpenStax's
  "SENIOR CONTRIBUTING AUTHORS", NIST's "Category: Computer Security" and Evidence-based
  SE's author.

**What the refined form changes.**

- Gate: Census's "Suggested Citation", "U.S. CENSUS BUREAU", "Contents TEXT", the two
  contents headings, "APPENDIXES", "INTRODUCTION", "Highlights" and "HOUSEHOLD INCOME BY
  SELECTED CHARACTERISTICS"; NIST FIPS 203's page-4 "Federal Information Processing
  Standards Publication 203".
- Library: ReStorying's subtitle and "INTRODUCTION"; "Contents" on the contents pages
  of Basic Income Tax, Educational Administration and Marketing; Bad Ideas' "TABLE OF
  CONTENTS".
- Nothing else changes, in the library or on the gate.

**Gate (exact).**
- Anchors 4,876 of 4,876, with the same 17 anchors and 14 roots left out as titles.
  Every one of them matches a title source, and Technology Tools' "Contents" is its
  outline root.
- No witness changes, scope 6 of 6, no body unit goes missing, wrong-path chunks stay
  at 627.
- Body blocks that lose a book-title component: 15,653 → 15,614. Census regains 37
  components on 26 body blocks, and NIST 2 on 2.

**ReStorying.**
- "INTRODUCTION" is cleared, and the measure's root gain is kept: 90 in the gate's
  replay form, as with v10.
- The subtitle "Critical Perspectives in Public Education", printed under the page-7
  title, matches no title source (the PDF title is "ReStorying Education"), so it is
  unmarked too.
  - With #12 in place, chapter 1's heading closes it after 7 introduction chunks.
  - Where nothing closes it, it heads 624 of 633 chunks. That is the gate's replay form,
    with #12 dropped. The measure counts it as a benign title component.
- Among the 126 library books, only ReStorying loses a subtitle mark this way. On the
  gate, the nearest case is NIST FIPS 203's page-4 publication line, which enters the
  paths of 2 body blocks.

**Recommendation.** Port the refined form if the developer wants Census's page 7 and
ReStorying's "INTRODUCTION" fixed; it costs nothing measurable elsewhere. Otherwise
drop it: its whole gain is 26 Census body blocks and 5 ReStorying chunks, traded against
ReStorying's subtitle on 7 chunks. Do not port the rule as worded.

## 2. #12 placement, and `band2` on top

**Production #12.** An outline entry with no heading on its page becomes a heading when
the page's running head (a discarded banner) carries its title. The heading is inserted
before the page's first block.

**The developer's variant** (`insert_outline_headings_dest` in `hr.py`):

- The same entries, running-head test and levels.
- The first non-discarded block at or below the outline destination (y − 5, as
  `outline_levels._positions`) is checked first.
  - If it is a body line whose title key equals the entry's, it becomes the heading,
    with its printed text kept.
  - Otherwise the heading is inserted before that block, with the running head's box.
- A destination without a height keeps production's place.

**Without `band2` it changes nothing.**

- Library: #12 fires 107 times in 8 books (College Research 90). Under the variant:
  - 92 headings go before the first block at the destination (in College Research,
    just after the page's discarded running head);
  - 2 go before the page's first block;
  - 8 have no height;
  - 5 are ReStorying's promoted chapter lines.
- Agents' paths and the measure are identical to `v10`. No saved chunk starts between
  a page top and one of these destinations. ReStorying's chapter number above its title
  line falls in the same chunk either way.
- Gate: #12 fires twice (English Composition at the top of a page, Game Theory without
  a height), and no body block changes.

**ReStorying's stale chunks come from #12's trigger, not its placement.**

- Its chapter openers print "N" at y = 0.151 and the chapter title as body text at
  y = 0.260, exactly where the outline points.
- On odd pages the running head carries the chapter title, so #12 fires for chapters 1,
  3, 5, 8 and 9.
- On even pages (chapters 2, 4, 6, 7 and 10) the running head is "26 RESTORYING
  EDUCATION", so there is no heading.
- The L1 heading inserted for chapter 1 stays open over chapter 2, and so on: 312
  chunks (90 → 402).
- The variant promotes the five odd-page title lines instead of inserting headings, and
  still measures 402.

**Option: the destination line alone** (`r12l2`, `insert_outline_headings_line2`).

- A body line at the destination whose title key equals the entry's is promoted even
  when no running head carries the title. Two guards:
  - The entry must survive `outline_levels._entries`: wrappers, machine bookmarks and
    repeated author tags are dropped. Without this, Media Studies' "mediatexthack" tags
    became headings and made 221 gold chunks worse.
  - The entry's parent entry must not point to the same page. This catches the single
    "media texthack" byline under "About", which alone made 18 chunks worse.
- Agents' paths: +118 fixed, 0 worse.
  - The Impact of Open Source Software 38, Business Ethics 26, Business Processes 18,
    Concepts of Biology 17, Educational Psychology 14, Physics 5.
  - Unreviewed Programming Fundamentals shows 6 "worse". In all 6 its gold lacks a
    listed subsection ("4.7.6.1 Problem 04a - Instructions") or is broken ("› ›
    22.2.1 Overview").
- Measure: 1,770 → 1,433. ReStorying goes 402 → 65, below `v10p`'s 90, because its
  chapters now get headings.
- Reach: 164 promoted lines in 32 books.
  - First Course in ECE: 68 module titles.
  - Programming Fundamentals 20, Integrated Infrastructure 8, Business Fundamentals 6,
    and numbered sections elsewhere ("11.5 The industry environment", "9.6 Arbitrage
    pricing theory").
  - Spot checks of the unscored books found only real section titles that ODL typed as
    body text.
- Gate:
  - 124 promotions in 12 documents, 1,490 body blocks changed;
  - anchors, roots, witnesses and scope unchanged, and wrong-path chunks stay at 642;
  - 496 lost outline-confirmed ancestors, all explained: 350 closed spans, 115
    unlisted, 31 duplicates, 0 open. Examples: ECB's "Box 1", OECD's "Definitions",
    LibreOffice's "Menu bar", OpenStax's "Summary" and "Exercises";
  - 65 "missing" units are the promoted title lines, which move from text to path.
    Search still finds them through the path.

**`band2` on top.** `band2` lets a line with a decimal at both ends take the larger
number as its folio. OpenStax's odd-page end-matter heads "4 • Chapter Review 521" then
form families. It must add that reading, not replace the old one:

| | naive (larger only) | additive (either reading) |
| --- | ---: | ---: |
| banners added on the gate (emulated) | 840 | 840 |
| banners lost on the gate | 45: Media Studies 101 ("12 • MEDIA STUDIES 101", 39), INSEE ("74 … – Édition 2025", 6) | 0 |
| gate wrong-path chunks (642) | 643 | 642 |

The additive reading adds 953 banners in 10 documents and removes none
(`band2_survey.py`): Physics (113, both in the library and on the gate) and 8 OpenStax
gate books (840 on the gate in all). Every one is an "N • Title NNN" head: Test Prep,
Chapter Review, Key Terms, Homework, Exercises and so on. In the library only Physics
changes.

**Gate, additive `band2`, against `v10e`:**

| | `band2` + production #12 | `band2` + the variant | `band2` + the variant + line option |
| --- | ---: | ---: | ---: |
| #12 headings | 70 inserted | 28 inserted, 42 promoted | 28 inserted, 129 promoted |
| anchors / roots / witnesses / scope | 4,874 / 448 / 0 changed / 6 of 6 | same | same |
| lost outline-confirmed ancestors | 307 | 261 | 522 |
| … "open" | 55 | 26 | 26 |
| … real losses (`open_check.py`) | **24** (Chemistry) | **0** | **0** |
| missing units | 188 removed banners | 166 banners, 36 other | 166 banners, 95 other |
| wrong-path chunks (642) | 642 | 642 | 642 |

- **The 24 real losses** are all in Chemistry. On pages such as 61, the Key Terms
  glossary runs into the top of the page, and production inserts "Key Equations" above
  it. The variant promotes the "Key Equations" line where the section starts.
- **The 26 remaining "open" losses** in Physics and Astronomy are the other way round.
  - The new "Chapter Review" or "Summary" heading sits at the top of the page, where
    the outline points.
  - The baseline, which lacked it, had held "Key Equations" or "Key Terms" over that
    page.
- **The 36 other missing units** under the variant:
  - promoted title lines;
  - a gate artefact: an inserted heading carries its running head's box, and the
    compare looks blocks up by box.

**Library.** Agents' paths +2 / 0. Physics' "Key Equations" is right twice, and 99 more
Physics chunks lose a running head ("1 • Chapter Review 43") from their path. Those 99
stay wrong because the gold also expects "Concept Items", which the parse never typed as
a heading. The measure is unchanged: none of its books is OpenStax.

**Recommendation.**
- Port the variant.
- Port `band2` with it, as an added reading.
- The line option is the only one of these that moves the numbers (+118 / 0, measure
  −337). It widens #12's trigger from the v8 rule, so it needs its own decision (see
  open questions).

## 3. Front matter in books without an outline

**Finding: no target in v10.**

- **The backbone already closes front matter** when it finds a chapter chain. Front
  matter headings are levelled at the chapter rank or below it, so the first chapter
  pops them.
- **Survey** (`front_survey.py`, 126 library books and 64 gate PDFs through the v10
  chain):
  - 39 documents take the backbone.
  - The 24 with a chain hold no front-matter heading past the first chapter.
  - The one held heading, Human Anatomy Self-Assessment's "Part 1: Self-Assessment
    Questions" (130 blocks), is a real Part accepted by the part chain. Closing it
    would be wrong.
  - The 15 without a chain (First Course in ECE, Bad Ideas, Electromagnetics 2, Open
    Research, Census and others) have no first chapter for the rule to key on.
- **Last round's cases are gone.**
  - Bad Ideas' "TABLE OF CONTENTS" is inside its marked title pages.
  - The Compact Anthology Part 3's "Acknowledgements", which heads 4,298 body blocks,
    is in an outline book. Its outline destinations are broken (y = −273) and its
    chapter titles are printed as tabs ("Korea 10"), so olga matches no chapter. That
    is a matching problem, not a backbone one.
- In the library's v10 outputs, a front-matter title heads text past the first fifth of
  the book in only three books: the Anthology, Integrated Infrastructure's
  "INTRODUCTION" (outline book, 111 blocks) and Open Research's "INTRODUCTION" (no
  chain, 257 blocks). On the gate there are two stray blocks: WeasyPrint's "Table of
  contents" and ACL's "Acknowledgments".

**Recommendation:** drop it.

## 4. Running heads without a folio just below the band

**Root cause.** `_additional_banners` confirms a running band only from seeds that end
above y = 0.065, and it takes top candidates only from y0 < 0.065. Papuan Malay's "1
Introduction" / "1.2 Genetic affiliations" heads sit at y = 0.069-0.086, typed as L5
headings, so they are never candidates. Each one enters the path of the page under it
("1 Introduction › 1.1 Geographical setting › 1 Introduction").

**The rules** (`scripts/r4heads.py`, a copy of `_additional_banners` with its geometry
as parameters):

| Mode | Rule | Banners (library and gate) | Agents' paths |
| --- | --- | ---: | ---: |
| `folio` | top candidates and seeds reach 0.10 | 4,911 in 47 documents | +1,481 / 37 |
| **`titled`** | as `folio`, but a seed below 0.065 must repeat a title printed earlier as a larger body heading | **3,241 in 13** | **+983 / 0** |
| **`titled25`** | `titled`, or the seed text recurs on a quarter of the pages | **3,744 in 13** | **+1,460 / 0** |
| `titled10` | `titled`, or on a tenth of the pages | 3,834 in 15 | not scored; adds the 27 "Example" headings |

- **`folio`'s extra banners** are mostly real headings or labels printed at the top of
  pages: OpenStax's "LINK TO LEARNING", "Solution", "EXAMPLE N", "HOW TO"; LibreOffice's
  "Note" and "Tip"; "Example" (Brief Calculus); "SUMMARY" (Conservation Techniques);
  speaker names in the Anthology; "Sources" (College Research).
- **Its 37 worse gold chunks** are real headings discarded: Accounting Principles'
  chapter 3 title, at the top of its opening page (18), College Research's "Sources" (9), Applied
  Human Anatomy's "Application Exercises" (7), and 3 more.
- **The titled test** is the one production already applies to the other members of a
  confirmed band. It keeps:
  - the seven grammars' chapter and section heads (239-586 each);
  - Accounting Principles' chapter heads (434);
  - the Unicode Cookbook (93);
  - "ASSESSMENT" in Learning in the Digital Age, "ATSUMORI" in the Anthology and
    "Preface" in Liquidity.
  All are running heads.
- **`titled25` adds** Accounting Principles' licence line ("This book is licensed under
  a Creative Commons Attribution 3.0 License", typed as a heading on 503 pages) and its
  book-title head (+477 agents' paths). Nothing else changes. The tenth-of-the-book
  variant also takes Brief Calculus's "Example" (27) and Integrated Infrastructure's
  section head (33).

**Measured (`titled25`).**
- Agents' paths +1,460 / 0: Accounting Principles 416 → 1,293, Papuan Malay 744 →
  1,173, the Unicode Cookbook 106 → 258, Liquidity +2. `titled` alone gives +983 / 0.
- The measure is unchanged. Of these books only Liquidity is in it, and its count does
  not move.
- Gate: 4 body blocks change (Liquidity's "Preface" head), wrong-path chunks go 642 →
  641, and anchors, roots, witnesses and scope are unchanged. The quarter clause changes
  nothing on the gate.

**Recommendation.** Port `titled25`, or `titled` if the frequency clause looks too
specific: it is worth 477 chunks, all in one book.

## The recommended set

Rules 1 (refined), 2 (the variant, additive `band2`) and 4 (`titled25`) together, with
and without the line option:

| | `v10` | the set | the set + line option |
| --- | ---: | ---: | ---: |
| measure (37 books) | 1,770 | 1,770 | 1,433 |
| title components (measure) | 97 | 104 | 104 |
| agents' paths, scored (34,617) | 19,785 | 21,247 | 21,363 |
| … fixed / worse | | 1,462 / 0 | 1,578 / 0 |
| unreviewed (953), fixed / worse | 655 | 0 / 0 | 0 / 6 (gold errors) |
| gate: anchors / roots / witnesses / scope | 4,874 / 448 / — / 6 of 6 | kept / kept / 0 changed / 6 of 6 | same |
| gate: lost outline-confirmed ancestors | | 261, 0 real | 522, 0 real |
| gate: missing units | | 167 banners, 36 other | 167 banners, 95 other |
| gate: wrong-path chunks | 642 | 641 | 641 |

The effects add up, apart from a 2-chunk overlap in Physics. No rule changes another
rule's result:

- the running heads give +1,460;
- `band2` gives +2;
- the line option gives +116 on top (118 alone; 2 of its Physics fixes are also
  `band2`'s);
- the title narrowing gives 0.

The 7 extra title components are ReStorying's subtitle.

## What the implementer needs to port

Per the developer's note of 2026-09-25, nothing runs in production. Each rule changes the
parser outright, with no version gate or compatibility path for older parses or chunks.
The parser version bumps as usual, and `CHUNKER_VERSION` does not change: none of these
rules touches the chunker.

**1. Refined title narrowing** (`outline_levels.mark_book_titles`, about 8 lines).
- Count body characters per page, as the dropped stop did: non-heading text blocks.
- Find the first page with more than 150.
- A heading on a later page that itself has more than 150 characters stays marked only
  if it matches a title source (`_same_title` against the same `titles` list).
- Tests:
  - a reprinted title on a body page, whose section headings are unmarked (Census);
  - a repeated title page after a series page, which keeps its author mark (Papuan
    Malay);
  - a title page whose own body text is over 150 characters, which keeps its marks
    (NIST FIPS 203).

**2. #12 at the destination** (`headings.insert_outline_headings`).
- Which entries fire, and at which level, stays as today.
- Read `get_toc(simple=False)` for the destination height.
- Find the first block on the page, neither discarded nor a page number, whose top is
  at or below the destination minus 5.
  - If it is a text block without `text_level` or `_source_role` whose `_outline_title`
    equals the entry's, set its `text_level` and `_source_role: outline-heading`.
  - Otherwise insert the heading before it.
  - With no height, or no such block, keep today's placement.
- The prototype is `_outline_headings(..., running_head=True)` in `scripts/hr.py`.
- Tests:
  - the destination line promoted (OpenStax "Key Equations" at y = 0.223 under the
    previous section's tail);
  - an insert at the destination's height;
  - no height, which keeps today's placement.

**2b. `band2`, additive** (`headings`, about 12 lines).
- A `_folio_title_larger` that returns the last decimal when both ends are decimals and
  the last is larger.
- `_family_banners` and `_wide_only` return the union of their results under both
  readings. The prototypes are `family_banners_either` and `wide_only_either` in
  `hr.py`.
- Tests:
  - "4 • Chapter Review 521" forms a family with "522 4 • Chapter Review";
  - "12 • MEDIA STUDIES 101" keeps its family.

**2c. The line option, if chosen** (in the same function).
- Promote the destination line also when no running head carries the title.
- The entry must be one `outline_levels._entries` keeps (build the set once; import it
  inside the function to avoid a cycle), and its parent entry must not point to the
  same page.
- The prototype is `_outline_headings(..., running_head=False, own_page=True)`.
- Tests:
  - ReStorying's even-page chapter promoted;
  - Media Studies' repeated tag refused;
  - a byline under its parent on the same page refused.

**4. Titled running-head seeds** (`headings._additional_banners`, about 10 lines).
- Top candidates `y0 < 100`, seeds `y1 <= 100`. Both were 65.
- A seed that production would not take (y0 ≥ 65 or y1 > 65) counts only when every
  line repeats a `body_titles` entry printed earlier at a larger size (the existing
  member test), or, for `titled25`, when its text recurs on max(5, a quarter of the
  pages).
- The prototype is `scripts/r4heads.py`.
- Tests:
  - Papuan Malay's "1 Introduction" at 0.069-0.086 becomes a banner;
  - "Example" at the top of three or more pages stays a heading;
  - a licence line on a quarter of the pages becomes a banner.

**Gate after the port.** Run a fresh-parse gate. It will be the first real parse of
`band2` and the placement variant; this round emulated them.

## Open questions

1. **The line option.** It changes #12's v8 trigger ("only when the running head carries
   the same title"). Adopt it with its two guards (+118 / 0, measure −337, 164
   headings)? Or keep the running-head requirement, which leaves ReStorying's even-page
   chapters without headings?
2. **ReStorying's re-parse.** Under production v10 it would measure 402 wrong-path
   chunks, against 90 without #12 and 65 with the line option. Hold its re-parse until
   the #12 decision?
3. **Title narrowing.** Port the refined form for Census's page 7 and ReStorying's
   "INTRODUCTION", accepting ReStorying's subtitle in 7 chunks, or drop the rule?
4. **The quarter clause** for folio-less running heads. It is worth 477 gold chunks, all
   in Accounting Principles.
5. **Physics and Concept Items.** 99 Physics chunks lose a running head under `band2`
   and stay wrong, because the gold expects OpenStax's "Concept Items" and "Critical
   Thinking Items", which the parse types as body text. The line option does not reach
   them: they are not outline entries.
6. **Measure references.** `measure.py` builds its references from the raw outline, so
   Media Studies' author tags cut every chapter's reference span, and 260 of its chunks
   read as wrong. Dropping tags there, as `_entries` does, would make its Media Studies
   number meaningful.

## Reproduction

Local and ignored: `bench/parsers/reports/local/2026-09-25-heading-rules/`.

- `scripts/`:
  - `hr.py` is the chain and variants; `paths.py` sets `sys.path`.
  - `score.py measure|gold` runs the replays, using `measure_x.py`.
  - `goldsnap.py` freezes the gold.
  - `titles_survey.py` and `make_arm.py` cover item 1; `front_survey.py` and
    `front_roots*.py` item 3; `r4heads.py` and `heads_survey.py` item 4;
    `band2_survey.py`, `r12_reach.py` and `show12.py` item 2.
  - `gate_arm.py` and `run_compares.sh` build and compare the emulated gate.
  - `open_check.py` rechecks open losses; `flips.py` lists gold flips.
- `gold-2026-09-25.json` is the frozen gold, with provenance and the skipped scopes.
- `runs/`:
  - `measure-*.json` and `gold-*.json`, with `*-dump.json` for flips;
  - `titles-*.json`, `front-*.json`, `heads-*.json`, `band2-survey.json`,
    `r12-reach.json`.
- `gate/`: the exact title arms from `v10b` and their compares.
- `gate-emu/`: the emulated arms, `compare-base-<arm>-<arm>.json` and
  `lost-<arm>.log`.

```sh
L=bench/parsers/reports/local/2026-09-25-heading-rules
export PYTHONDONTWRITEBYTECODE=1
uv run --project pipeline python $L/scripts/goldsnap.py $L/gold-2026-09-25.json
uv run --project pipeline python $L/scripts/score.py measure $L/runs/measure-legacy.json v10p --map legacy  # 1,528
uv run --project pipeline python $L/scripts/score.py measure $L/runs/measure-a.json v10p v10 t1after r12d r12l2 e2d
uv run --project pipeline python $L/scripts/score.py gold $L/runs/gold-a.json v10 v10p t1both r12d r12l2 e2d h4 h4q --dump $L/runs/gold-a-dump.json
uv run --project pipeline python $L/scripts/make_arm.py $L/gate v10b t1-narrow-both narrow-both
uv run --project pipeline python $L/scripts/gate_arm.py $L/gate-emu v10 r12d r12l2 e2 e2d e2l2 h4 t1both all alld
bash $L/scripts/run_compares.sh r12d r12l2 e2 e2d e2l2 h4 t1both all alld
cp -r $L/gate-emu/v10 $L/gate-emu/base-check
uv run --project pipeline python $L/scripts/open_check.py $L/gate-emu base-check e2d
```

Arm names (`score.py` `ARMS`):
- `v10` and `v10p`: production, with and without #12's inserted headings.
- Titles: `t1after` (as worded), `t1` (inclusive), `t1page`, `t1both` (refined).
- #12: `r12d` (the variant) and `r12l2` (with the line option).
- `band2`: `e2*` are additive and `b2*` naive, each with `d` (the variant) or `l2`
  (the line option).
- Running heads: `h4` (titled), `h4q` (titled25), `h4f` (plain).
- Together: `alld` (the recommended set) and `all` (with the line option).
