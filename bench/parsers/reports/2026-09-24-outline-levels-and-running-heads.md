# Outline levels, running heads and book-title roots

2026-09-24. Three rules were prototyped on top of v9:

1. **Outline levels, gated.** For books with a usable PDF outline, heading levels change
   only where the current path contradicts the outline.
2. **A running-head band.** Folio running heads just below the margin band become
   banners.
3. **Book-title root drop.** Added during the round, after the developer settled that new
   section paths omit the book-title root.

Each rule was replayed on the saved parses and scored against the agents' corrected paths
and the section-path measure. Each was also run through the fresh-parse gate. The report
also measures composition with v8's outline-heading rule (#12).

No production code was changed, nothing was committed, and no container was started.
Everything is in `bench/parsers/reports/local/2026-09-24-outline-levels/`, which git
ignores.

## Summary

- **Outline levels: recommended (`olga`).** It passes the gate.
  - Agents' paths: 12,585 → 17,949 of 31,007 chunks. 5,494 chunks are fixed and 130 made
    worse.
  - All 130 are in Programming Fundamentals. Its gold paths were never reviewed (3
    repairs in 947 chunks), and every one of the 130 is numerically impossible
    ("1.1 › 1.1.2 › 1.2.3.3").
  - Section-path measure: 2,743 → 2,061 wrong-path chunks, and no book gets worse.
  - Gate:
    - all 4,889 anchors and 277 roots are kept;
    - 6 of 6 scope cases pass;
    - 17 witnesses change, all toward the gold expectation or the settled path form;
    - no body text goes missing;
    - wrong-path chunks fall from 810 to 663.
  - The gate counts 805 lost outline-confirmed ancestors, and all are explained:
    - 574 are duplicates, where the same title is still in the path;
    - 220 are headings the outline closes before that body block;
    - 11 are title fragments or stray headings.
  - The span and hybrid variants lose 2 gate roots each and make 206 to 223 chunks
    worse.
- **#12 composes.** On its own it fixes 244 chunks and makes 4 worse. On top of `olga` it
  fixes 259 and makes 4 worse. The two gains add up, and the gate profile does not
  change.
- **Running-head band: recommended.**
  - Java's regressions were 77 in the last report. Under this round's stricter scorer
    and larger gold they are 151, and 142 of them end in a running head. The band
    recovers all 142.
  - Agents' paths: 437 chunks fixed, none made worse. The gains are in Java 260,
    Compressible Flow 167 and Learning Statistics with R 10.
  - Across all 126 saved parses the band adds 3,599 banners in 7 books. Every one is a
    running head, a footer or a page number.
  - On the gate it adds 255 banners in 5 documents and changes no witness.
- **Larger-folio band: hold.**
  - It also catches OpenStax's end-of-chapter running heads ("4 • Chapter Review 521").
    Alone it is clean.
  - With #12 it adds 43 real ancestor losses. #12 turns the newly discarded heads into
    headings at the top of the page, above where the section starts.
- **Book-title root drop: recommended, done by refine and the chunker together.**
  - 22 saved parses have a recognised title root. 21 of them are the book's printed title
    and 1 is ambiguous.
  - On its own the drop fixes 1,284 agents' paths and makes 13 worse. 5 of the 13 are
    real false positives. 7 are title-page chunks whose accepted path is the title itself.
    1 is Technology Tools' "Contents".
  - It also cuts wrong-path chunks from 2,743 to 1,928, because title-page author and
    subtitle headings leave the paths along with the title.
  - On top of `olga` it adds little, because `olga` already removes most roots in books
    with an outline.
  - On the gate it needs an exemption: it removes 17 anchors and 14 roots, all of them
    title headings the outline lists plus Technology Tools' "Contents".

## How it was measured

- **Baseline (v9).** v9 is built in three layers:
  - the v6 role rules from `odl_head/` (a snapshot of `parser/odl` at `92073e5f`);
  - a simulation of v8: margin paragraphs join banner families (#5), body-style headings
    are demoted (#11) and capitals headings promoted (#10);
  - the three v9 rules from the last report (`fragments`, `contents`, `backbone`).

  v8 was committed as `c0a7233a` during the round. The #12 arms simulate it as that
  commit builds it (see "Composition with #12").
- **Agents' paths.** The gold path is the agents' corrected path, else the path they
  accepted. The intake is live, so each table below comes from one run of all its arms
  together. The final gold has 48 books and 31,007 chunks. The scorer changed in four
  ways since the last report, so the totals are not comparable with it:
  - A leading book-title component is dropped from both sides, per the 2026-09-24 path
    decision. Some published gold paths still carry a root. Where that choice changes a
    verdict, it is reported under "Title flips".
  - Chapter titles count as path components. A leading chapter or part component that
    the gold omits is tolerated. A chapter title deeper in the path, such as a running
    head typed as a heading, is an error. Last round it was skipped anywhere.
  - Numbered titles with different numbers never match. Last round "4 Reduplication"
    matched "4.1.1.1 Reduplication of…" as a truncation.
  - When a chapter and its first section share a title, both matchings are tried.
- **Section-path measure.** `measure.py` from the section-path investigation, imported
  read-only. It covers 37 books and 11,658 chunks.
- **Fresh-parse gate.** Each rule is applied to the gate's `v6afresh` content lists (66
  documents) after the v9 rules. Then `gate_parser_fresh.py compare` runs with both gold
  files and the measure directory.
  - Every compare got its own copy of the baseline arm. `compare` writes
    `parsed/refinement.json` into the baseline folder, and parallel compares that share
    one baseline crash on a half-written file.
  - `lost_outline.py` sorts the gate's lost outline-confirmed ancestors by cause.

## Rule 1: outline levels, gated (`olga`)

**When it runs.** The book has a usable outline, as in the last report: at least 5
entries, and at least 30% of them found as headings on their page. The outline must also
not be broken (see "Veto" below).

`backbone` runs on books without a usable outline. In the replay a vetoed book gets
neither rule; the port notes propose letting `backbone` run there.

**Reading the outline.**

- `get_toc(simple=False)` is read, entries are sorted by page (the sort is stable), and
  each entry keeps the height of its destination.
- Wrappers with children are dropped and their children move up a level: "Main Body",
  "Front Matter", "Back Matter", "Contents", "Table of Contents". A childless "Contents"
  is the contents page itself and stays.
- Machine bookmarks are dropped ("_GoBack", "_Hlk…", "tmp.…").
- If one title is bookmarked twice on the same page at two levels, the shallower copy is
  kept. This is OECD's "Part A" at level 3 and again at level 1; the spacing differs, and
  so did Parts B to D.
- Author tags are dropped: a title repeated three or more times, word for word, that
  mostly shares a page with the previous entry at its level (Media Studies'
  "mediatexthack"). Numbered repeats are kept, such as Healthcare's "8.1 Learning
  Objectives".

**Matching entries to headings.**

- A cursor moves through the headings in reading order. For each entry it tries the
  destination page, then the next page, then the previous page. Titles are compared
  after stripping labels and numbers.
- A second pass matches entries that the outline lists out of reading order to an unused
  heading on their own page. Healthcare bookmarks "Reimbursement" before "Health
  Insurance &".
- A running head typed as a heading never matches an entry. A running head here is a
  heading with a number at either end, in the top or bottom fifth of the page, whose
  text without digits recurs there on three or more pages, and whose end number the
  entry's title does not carry.
  - Precalculus' "4 • Exercises 525" had matched "Exercises".
  - Physics' "18.5 Capacitors and Dielectrics" still matches: the number is its own.
- An unmatched entry starts at the first block at or below its destination, but never
  before the entry listed ahead of it. Learning Statistics with R has entries without a
  height, which had ended "The undiscovered statistics" at the top of its own page.
- Split titles are joined. Two same-level entries whose headings sit next to each other,
  with no body text between them, read as one title, the second under the first.

**The walk.** The headings are walked as the chunker walks them. A heading's level
changes only where the stack contradicts the outline.

- **A listed heading** (one an entry matched):
  - It closes every listed heading whose outline span has ended.
  - It sits directly under its outline parent, closing the unlisted headings between
    them.
  - A top-level one closes unlisted front matter, such as a book-title root or an author
    line. An unlisted Part heading stays; NIST AI RMF's outline points "Part 1" at page
    1.
- **An unlisted heading or a banner boundary** cannot close a listed heading that is an
  outline ancestor of the next listed heading. It is placed just below it instead.
  - Exception: a heading numbered as that listed heading's peer. The BCcampus toolkit's
    outline leaves out the "4. Images" chapter; without the exception, "What are
    images?" went under "3. Organizing Content".
- **A changed heading** carries its subtree by the same step. No block is added, removed
  or retyped.
- **When constraints conflict** (17 headings in 126 books), the level is left alone.

**Veto.** An outline is broken, and not used, when an entry that is not Part-like spans
more than half the book and either:

- most of its children are typed larger than it. Compressible Flow's "Version 0.5"
  change-log bookmark holds every chapter;
- or it is front matter whose children are typed as large as it. Message Processing's
  "Ackowledgements" holds every chapter.

The veto stops these two books only. The BCcampus toolkit's "Best Practices" is a
legitimate grouping and is not vetoed.

**Variants.** They differ only in what an unlisted heading may close. Final3 snapshot,
48 books, 30,668 chunks:

| Variant | Agents' paths (v9: 12,498) | Fixed / worse | Gate roots | Gate wrong-path (810) |
| --- | ---: | ---: | ---: | ---: |
| span: every listed heading whose span covers it is protected | 17,671 | 5,396 / 223 | 275 / 277 | 674 |
| hybrid: ancestors, plus spans the outline closes, except numbered peers | 17,729 | 5,437 / 206 | 275 / 277 | 674 |
| ancestors (`olga`) | 17,805 | 5,437 / 130 | 277 / 277 | 663 |

- **The span and hybrid variants** hold a listed heading open for its whole outline
  span. A same-level heading that the outline leaves out is then nested under it:
  - the anatomy lab's "Materials Needed › Learning Objective";
  - Physics' "Key Terms › Section Summary";
  - Java's "Special Topic" boxes;
  - Web Writing's "What To Do Next › Reflection Activities".

  The agents keep these as siblings. Beyond Programming Fundamentals' 130, span loses 93
  chunks (Physics 49, Java 21, the anatomy lab 8, Philosophical Ethics 7 and 8 more) and
  hybrid loses 76.
- **Gate roots.** Both lose the root of the Entrepreneurship Toolkit and the Business Plan
  guide, which fails the gate.
- **The numbered-peer guard** changes nothing on the 48 gold books or the 37 measure
  books. On the gate it removes BCcampus's 101 lost ancestors.

**Results.** Final gold snapshot: 48 books and 31,007 chunks, the same gold as the
title-root run. `olga` here includes the numbered-peer guard. The measure covers 37
books. Only books with a change are listed.

| Book | Chunks | Agents' paths v9 → olga | Fixed / worse | Measure v9 → olga |
| --- | ---: | ---: | ---: | ---: |
| A Grammar of Papuan Malay | 1,780 | 0 → 745 | 745 / 0 | — |
| Accounting Principles | 2,915 | 385 → 416 | 31 / 0 | — |
| An Introduction to Formal Logic | 302 | 1 → 255 | 254 / 0 | 302 → 113 |
| Business Ethics | 1,194 | 200 → 836 | 636 / 0 | — |
| Business Processes and IT | 1,598 | 183 → 872 | 689 / 0 | — |
| Concepts of Biology | 2,052 | 223 → 1,706 | 1,483 / 0 | — |
| English Composition | 276 | 245 → 249 | 4 / 0 | 10 → 5 |
| Fundamental Methods of Logic | 685 | — | — | 11 → 6 |
| Intermediate Financial Accounting | 1,433 | 2 → 824 | 822 / 0 | — |
| Introduction to Game Theory | 259 | 148 → 148 | 0 / 0 | 35 → 31 |
| Introduction to GNU Octave | 361 | 258 → 258 | 0 / 0 | 86 → 56 |
| Learning Statistics with R | 1,953 | 1,799 → 1,847 | 48 / 0 | — |
| Liquidity, Markets and Trading | 281 | 185 → 219 | 34 / 0 | 107 → 90 |
| Media Studies 101 | 312 | 259 → 259 | 0 / 0 | 277 → 263 |
| Open Logic Project | 678 | 0 → 132 | 132 / 0 | — |
| Overview of Healthcare Compliance | 290 | 224 → 224 | 0 / 0 | 31 → 5 |
| Philosophical Ethics | 495 | 90 → 456 | 366 / 0 | 29 → 27 |
| Private Pilot ACS | 186 | 1 → 53 | 52 / 0 | 163 → 83 |
| Programming Fundamentals | 947 | 777 → 653 | 6 / 130 | — |
| Public Policy | 375 | 269 → 270 | 1 / 0 | 2 → 2 |
| Impact of Open Source Software | 1,433 | 1,206 → 1,294 | 88 / 0 | — |
| Unicode Cookbook | 327 | 3 → 106 | 103 / 0 | 311 → 1 |
| **All 48 / 37 books** | 31,007 | 12,585 → 17,949 | 5,494 / 130 | 2,743 → 2,061 |

Of the chunks the agents repaired, 2,265 → 7,385 now match.

**Reach.** Of the 126 saved parses, 107 have a usable outline and 2 of those are vetoed.
The rule changes 85 books: 15,841 heading levels and 7,057 banner boundaries.

**False positives.**

- **Programming Fundamentals, 130 chunks.** They are gold errors: every one of its 130
  accepted paths is numerically impossible, and `olga`'s paths are all consistent.
- **Remaining misses are not level problems.** They are:
  - missing headings, such as Healthcare's truncated "8SpecialTopicsandEmerging";
  - sidebar titles the agents drop;
  - running heads without a folio typed as headings (Papuan Malay, "1 Introduction" at
    y ≈ 0.07).

**Title flips.** These are verdicts that change if the root is kept in scoring.

- v9 has 532; `olga` has 2,210.
- The difference is almost all in Papuan Malay (745), Intermediate Financial Accounting
  (822) and the Unicode Cookbook (103). These are published books whose gold keeps the
  root, and `olga` removes it.
- Scored with the root kept, `olga` still goes from 12,053 to 15,739.

## Rule 2: running-head band (`band`)

**The case.** Java's even pages carry "184 CHAPTER 4 • Input/Output…" at y = 0.107. That
is just below the 0.10 edge of `_folio_band`, so the banner families never see it and it
stays a heading. Last round, the `fragments` rule demoted the dingbat headings ("☛ ✟")
that used to close these heads, and that exposed them.

**The rule.**

- In `correct_roles`, `_folio_band` is widened to the top and bottom fifth of the page
  (0.20 / 0.80) for the family scan. That includes #5's margin-paragraph shadow.
- A family found only through the wider band must cover 5 or more pages and a tenth of
  the book. Families are grouped by folio kind, page offset, top or bottom, and the
  height in hundredths.
- All other family conditions stay as they are: a repeated title, the offset proof and
  the style key.

**Java.** At the final run's gold, 1,240 chunks:

- v8 → v9 makes 151 chunks worse: this round's scoring of last round's 77.
- 142 of the 151 end in a running head, and the band recovers all 142.
- The other 9 are code lines typed as headings ("do", "default :", "public boolean
  takeSticks…").
- v9 → band: 618 → 878, with 260 fixed and none made worse.

**All books.** Agents' paths: 437 fixed and none made worse:

- Java 260;
- Compressible Flow 167, from its "250 CHAPTER 9. NORMAL SHOCK" heads at y = 0.123;
- Learning Statistics with R 10, from bare folios at y = 0.868 typed as headings.

The section-path measure does not change: 2,743 on the 37 books and 810 on the gate
books. None of the three books is in the measure set.

**Body retention.** `band_audit.py` lists every block the band discards that v8 kept,
across all 126 saved parses. There are 3,599 such blocks, in 7 books:

| Book | Banners | What |
| --- | ---: | --- |
| Open Logic Project | 1,029 | "Release: 9620cc7(2026-07-12) 3" footers, bare folios |
| Learning Statistics with R | 795 | bare folios at y = 0.868 |
| Java, Java, Java | 763 | "168 CHAPTER 4 • …", "SECTION 4.4 • … 169" at y = 0.107 |
| Compressible Flow | 362 | "250 CHAPTER 9. NORMAL SHOCK" at y = 0.123 |
| Crystal Ball manual | 254 | "20 CHAPTER 2. THREE KINDS OF ATOMIC DATA" at y = 0.087 |
| Phylogenetic Comparative Methods | 233 | bare folios at y = 0.873 |
| Marine Ecology Notes | 163 | "marine ecology notes 12", proven only through the wider band |

- The longest is 76 characters (a Java section head), and all are single lines.
- No body text is among them.

**Gate.** It adds 255 banners in 5 documents: page numbers in three, and running heads in
QMUL Probability and the bookdown manual.

- All 4,889 anchors and 277 roots are kept.
- 85 body units go missing. The gate classes every one as the removed banner itself.
- No witness changes, and no outline-confirmed ancestor is lost.
- 3 body blocks in scope-latex-author lose a code line typed as a level-5 heading. A
  page-number heading turned banner keeps its level-5 scope reset, which is the approved
  banner behaviour.

## Larger-folio band (`band2`): hold

`_folio_title` takes the leading number as the folio. OpenStax's odd-page end-matter
heads read "4 • Chapter Review 521", so the chapter number 4 becomes the folio, the page
offset differs on every page, and no family forms. `band2` makes a line with a decimal at
both ends take the larger one.

- **Alone.**
  - Saved parses: 3,712 banners in 8 books, the 7 above plus Physics' 113 "N • Test
    Prep NNN" and "N • Chapter Review NNN" heads.
  - Agents' paths: the same 437 fixes as `band`. Physics' gold is mostly unreviewed, so
    it does not move.
  - Gate: 261 missing units, all removed banners. No outline-confirmed ancestor is lost
    and no witness changes.
- **With #12.** It adds 403 lost outline-confirmed ancestors, 43 of them real losses, in
  the OpenStax gate books.
  - #12 turns the newly discarded "1 • Key Equations 47" head into a "Key Equations"
    heading at the top of the page.
  - The section starts at y = 0.223, where the outline entry points, and its title sits
    there as body text.

Fix #12's placement first (see open questions), then rerun this.

## Composition with #12

#12 is simulated as the commit builds it (`headings.insert_outline_headings`):

- an outline entry with no heading on its page;
- the page's running head, a discarded banner, carries its title;
- the new heading takes its matched siblings' level, else one below its parent, else 1;
- it runs after the role pass and before the capitals rule.

The replay cannot add blocks, so the banner itself becomes the heading.

- **Alone.** 244 fixed and 4 made worse. The gains are College Research 231 and Game
  Theory 13.
- **On top of `olga`.** 259 fixed and 4 made worse. College Research goes from 25 to 268
  of 341.
  - The worse chunks: College Research's "Chapter Scenario › Scenario" (3), and one Game
    Theory chunk where the running head names the next section.
- **Measure.** 2,061 → 1,808.
  - ReStorying Education goes from 617 to 402. The measure still calls 349 of its
    chunks stale.
  - This may come from the in-place simulation. The real rule inserts its heading
    before the page's first block, so this is not verified.
- **Gate.** No change in profile:
  - all anchors and roots are kept;
  - the same 17 witnesses change;
  - lost outline-confirmed ancestors are 809 (4 more closed spans);
  - wrong-path chunks fall from 810 to 646.

**All together: band, #12, `olga`.** At the final run's gold:

- Agents' paths: 12,585 → 18,721, with 6,270 fixed and 134 made worse. The 134 are
  Programming Fundamentals' 130 and #12's 4.
- Measure: 2,743 → 1,808.
- Gate:
  - all 4,889 anchors and 277 roots are kept;
  - the 17 witnesses change as above;
  - 85 missing units, all banners;
  - 802 lost outline-confirmed ancestors (574 duplicates, 217 closed spans, 11
    fragments);
  - wrong-path chunks fall from 810 to 646.

## Rule 3: book-title root drop (`troot`)

**Recognising the title.** Three sources are used. The library's title is used only to
score them.

- **Metadata:** the PDF's title field. Junk titles are skipped ("Microsoft Word - …",
  file names, "Untitled").
- **Outline root:** a single top-level outline entry that spans 90% or more of the
  pages.
- **Title page:** the most prominent heading on the first page that has headings, within
  the first 5 pages. This source counts only when that heading roots half of the body,
  meaning it is at the bottom of the chunker's stack for half of the body blocks.

**What is dropped.** The title pages run from page 1 to the last page, within the first
10, that carries a heading matching a title source. That covers the cover, the half
title and the title page.

- Every unnumbered heading on those pages is dropped: titles, subtitles, authors, and
  series or publisher lines.
- Headings the outline lists under another title are kept.

The title alone is not enough:

- Papuan Malay's paths read "A grammar of Papuan Malay › Angela Kluge › …".
- The Unicode Cookbook's read "… › Steven Moran Michael Cysouw › …".
- Intermediate Financial Accounting repeats its title on pages 1, 5, 7 and 9.

**How it is dropped.** A title heading still closes the headings above it but never
enters the path. The replay writes it as a banner boundary. The printed title must stay
in the chunk text, so the real change belongs in the chunker (see port notes).

Demoting the title to body text loses its scope reset. When that was tried, ReStorying
Education's "Contents" became the root of all 627 chunks.

**Prevalence.** Saved parses, 126 books, 90,601 chunks, v9:

- 22 books have a recognised title root, carrying 20,452 chunk paths. By source:
  - metadata only: 8 books;
  - metadata and title page: 7;
  - title page only: 7;
  - outline root: none.
- 17 of the 22 are the library title.
- 4 are the printed title in another form:
  - "THE OPEN LOGIC TEXT";
  - "Introduction to Statistics" (Online Statistics Education);
  - "ReStorying Education in the United States";
  - "INFRA STRUC TURE", the letter-spaced cover of the Infrastructure Design Guide.
- 1 is ambiguous: the Compact Anthology Part 3's "The Renaissance", the volume's era
  title.
- Library-title-first chunks: 15,167 chunks in 105 books start with the library title
  (strict match). In 56 of those books it is fewer than 20 chunks, mostly title-page
  chunks.
  - After `olga`: 3,499 chunks in 105 books, because `olga` already removes the root in
    outline books.
  - After `troot`: 350 in 25 books.
  - After both: 334 in 22 books.
- **What is left after both** is recognition misses: Introducing Marketing 94, How does
  Cognition Influence Emotion 56, Project Management 42, Introduction to G Programming
  36, Accounting Principles 33. Two causes:
  - a title heading after page 10;
  - no metadata title, and a title page that does not root half the book.
- **The strict match.** A path component counts only if it is the title or a truncation
  of it. A looser prefix match also counted chapters that start with the title, such as
  Business Ethics' "Chapter 5 Business Ethics Case Studies" and Bad Ideas' "Bad Ideas
  about Genres".

On the gate set, v9 has 17 documents rooted at a recognised title, carrying 3,392 of
41,775 chunks. All 17 are the document's title:

- Discrete Mathematics, the ECB and BOJ reports, forallx and the R manual, among others;
- one-page examples such as w3c-complex-table.

The four OpenStax books are rooted at their promotional page ("Study where you want,
what you want, when you want", about 10,500 chunks). That is not a title, and `olga`
already removes it.

**Results.** Final4 snapshot, 48 books, 31,007 chunks.

| Arm | Agents' paths | Fixed / worse vs the arm without `troot` | Measure (2,743) | Chunks holding a title component (measure) |
| --- | ---: | ---: | ---: | ---: |
| v9 | 12,585 | | 2,743 | 1,224 |
| + `troot` | 13,856 | 1,284 / 13 | 1,928 | 135 |
| + `olga` | 17,949 | | 2,061 | 861 |
| + `olga` + `troot` | 17,960 | 24 / 13 | 1,530 | 99 |
| + band, #12, `olga` | 18,721 | | 1,808 | 222 |
| + band, #12, `olga`, `troot` | 18,732 | 24 / 13 | 1,804 | 99 |

- **The gains beyond the title.** The agents' score drops a leading title anyway, so the
  gains come from what goes with it.
  - Intermediate Financial Accounting +710: "with Open Texts" was the second root.
  - Papuan Malay +441: the author line.
  - The Unicode Cookbook +106.
- **The measure.** ReStorying goes from 617 to 90 (its subtitle heading) and the Unicode
  Cookbook from 311 to 27.
- **The 13 chunks made worse:**
  - 5 are real false positives: Message Processing's chapter 1 section "MESSAGE
    PROCESSING", on page 7, matches the title;
  - 7 are title-page chunks whose accepted gold path is the title itself ("forallx",
    "Basic Analysis II", "Java, Java, Java › Object-Oriented Problem Solving",
    Liquidity's series line "Classroom Companion: Business" three times). Under the
    settled form their path is empty;
  - 1 is Technology Tools' "Contents". Its outline's only root is "Contents", so
    "Contents" counts as the book's outline root. The agents removed it from their 84
    repaired paths but kept it on this one chunk.

Other false positives and side effects seen on the saved parses:

- ReStorying's "INTRODUCTION" sits on its last title page (page 7) and is dropped with
  the title.
- The Compact Anthology Part 3's "The Renaissance" is dropped. It may be a volume title.
- **Exposed front-matter ancestors.** The drop exposes ancestors that were already
  wrong under the title: the Anthology's "Acknowledgements" becomes the root, and so
  did Bad Ideas' "TABLE OF CONTENTS" until the title pages were widened. These are the
  same front-matter ancestor problem that `olga` solves in outline books.
- **No one-chapter books among the saved parses.** On the gate, one-page documents
  (w3c-complex-table, the prince samples) lose their only heading. That is consistent
  with "omit the book-title root", but it leaves them with no path.

**Gate.** Replay form, where the title becomes a banner boundary. Arms: `troot` alone,
`olga` + `troot`, and all rules + `troot`.

- **Anchors 4,872 / 4,889 and roots 263 / 277.** 17 anchors are lost in 13 documents
  and 14 roots in 12. Every loss is a title heading that the outline lists, plus
  Technology Tools' "Contents". Examples: "Report example", the NIST FIPS 203 title,
  "Anatomy of the Somatosensory System", "English Composition" and "Keys to
  Understanding the Middle East".
- **Ancestry.**
  - The titles leave 15,801 body blocks' paths. The gate counts these as removed
    artefacts, not as outline-confirmed ancestors.
  - Lost outline-confirmed ancestors stay at 803 (`olga` + `troot`, with the
    numbered-peer guard).
- **Witnesses.** The 17 `olga` witness changes, plus weasyprint's 18–20. Those three
  drop only "Report example" from the path, and their blocks are unchanged. `troot`
  alone changes 18 witnesses, all by removing a title from the path.
- **Other checks.** Scope 6 of 6 pass, no body text goes missing, and wrong-path chunks
  fall from 810 to 660.

**What the gate should treat as intended.** A heading marked `book-title` (see port
notes) should be left out of the anchor and root counts. Its removal from ancestry is
the path decision itself.

**Interaction with the 2026-09-20 root correction.** `correct_outline_roots` promotes
headings that match level-1 outline entries to level 1, when the source confirms them.
On 11 gate documents the book title is one of those entries, so it counts as a gate root
at level 1: 13 of the 14 roots above. The fourteenth is Technology Tools' "Contents",
its outline's only root. If the title is the outline's only level-1 entry, nothing at
its level follows to close it.

- `troot` runs after the correction and removes the title.
- The correction still protects real top-level sections ("1 Introduction" in lua50),
  which `troot` leaves alone because they are numbered and do not match the title.

Whether the correction or ODL itself put each title at level 1 was not separated.

**Interaction with `backbone` and `olga`.**

- Of the 22 books with a recognised title root, 19 have a usable outline. There `olga`
  already closes most title roots: only 4 books keep one after `olga`.
- The other 3 have no outline, so `backbone` levels them: Bad Ideas about Writing,
  Electromagnetics Volume 2 and ReStorying Education. `backbone` keeps their title roots.
- `troot` runs after both.

## What the implementer needs to port

**`olga`, the outline-levels rule.**

- **Code.** The prototype runs to about 380 lines with docstrings, for a new
  `parser/odl/outline_levels.py`. It is `newrules.py` in the local folder:
  - `okey`, `outline_entries`, `running_heads`, `folio_left`, `match_entries`,
    `reading_order`, `entry_positions`, `listing`, `broken_nesting`;
  - `olg_plan` in its `ancestors2` mode.

  Port only that mode. Drop `span`, `hybrid`, `ancestors` and the `DEBUG` hook. The
  constants (`WRAPPER`, `PART_LIKE`, `FRONT_MATTER`, `SECTION_NUMBER`) come along.
- **Call site.** After the v9 rules in `refine.parse_pdf`, where `backbone` runs.
  - The two rules are complementary. Use one test for both: a usable outline that
    `broken_nesting` does not veto takes `olga`, and every other book takes `backbone`.
  - Measured on the vetoed Compressible Flow, letting `backbone` run adds 138 chunks
    (324 vs 186), or 242 with the band. Message Processing is unchanged.
- **Block contract.**
  - The rule changes `text_level` on headings and `_heading_boundary_level` on banner
    boundaries.
  - It never adds, removes, reorders or retypes blocks. The chunker and
    `CHUNKER_VERSION` are unchanged.
- **Tests.** One per behaviour:
  - a listed heading moved under its outline parent;
  - an unlisted heading held under a listed ancestor, and a boundary raised;
  - front matter closed by a top-level listed heading, with a Part heading kept;
  - a numbered peer not held (BCcampus "4. Images");
  - outline parsing:
    - a wrapper with children, and a childless "Contents";
    - machine bookmarks;
    - a same-page duplicate at two levels (OECD);
    - an author tag versus a numbered repeat;
  - matching:
    - an out-of-order entry (Healthcare);
    - a running head refused (Precalculus) and a section number accepted (Physics);
    - a position clamp (Learning Statistics with R);
    - a split title;
  - vetoes: Compressible Flow and Message Processing vetoed, BCcampus kept.

**The running-head band.**

- In `headings.correct_roles`, widen `_folio_band` to 0.20 / 0.80 for the family scan
  and for #5's margin paragraphs.
- Keep a family found only through the wider band when its group (kind, offset,
  top/bottom, y in hundredths) covers 5 or more pages and a tenth of the book.
- The prototype is `_band_extras` in `newrules.py`. It runs the v8 replay twice
  (narrow and wide) and keeps the wide-only banners. The port can make one pass instead,
  recording which members lie outside the narrow band.
- Test: Java's y = 0.107 family, Compressible Flow's y = 0.123 family, and a body
  paragraph at y = 0.15 on three pages that must stay body text.

**The book-title root drop.**

- **Refine marks.** After `olga` and `backbone`, `title_roots(blocks, document)` sets
  `_source_role: "book-title"` on the title-page headings and keeps their `text_level`.
  Refine has the PDF metadata, the outline and the final heading stack, and recognition
  needs all three.
- **The chunker drops.** A text block with that role closes the stack at its level, as a
  banner boundary does. It is not pushed. Its text goes into the pending chunk text, so
  the printed title stays in the chunk.
  - This is about five lines in `chunk_content_list`, plus a `CHUNKER_VERSION` bump.
  - The gate's `stacks()` needs the same rule.
- **Why not refine alone.** A refine-only version that demotes the title to body text
  loses the scope reset. ReStorying's "Contents" then roots the book.
- **Gate.** Exclude `book-title` headings from anchors and roots.
- **Tests:**
  - title and author dropped (Papuan Malay);
  - repeated title pages (Intermediate Financial Accounting);
  - a subtitle in body text between title and author (Unicode Cookbook);
  - a numbered chapter on a title page kept;
  - the scope reset (ReStorying).

**#12.** No change is needed for this round's rules. See the open question on placement.

## Open questions

1. **Same-level headings the outline leaves out.** `olga` lets them close the listed
   section before them, which is what the agents' paths do: "Learning Objective" beside
   "Materials Needed", Java's "Special Topic" boxes beside their section. The span
   variant nests them and loses. Is the agents' choice the convention?
2. **#12 placement.** Should #12 put its heading at the outline destination's height, or
   promote the body line found there, instead of before the page's first block?
   OpenStax end matter shows the gap: with `band2`, 43 real losses. It may also explain
   ReStorying's 349 stale chunks.
3. **Unreviewed gold.** Programming Fundamentals (3 repairs in 947 chunks) and most of
   Physics carry the original paths. They cost every rule here.
   - Mark them unreviewed in the gold set, or exclude them from rule scoring.
4. **Title-page false positives.** Two cases:
   - A section named like the book on an early page (Message Processing, page 7).
   - An "INTRODUCTION" on the last title page (ReStorying).

   Stop the title pages at the first page with body text over 150 characters, or accept
   these losses?
5. **Front-matter ancestors in books without an outline.** The drop exposes them:
   "TABLE OF CONTENTS", "Acknowledgements". `backbone` could close front matter at the
   first chapter, as `olga` does.
6. **Running heads without a folio** just below the band (Papuan Malay's "1
   Introduction" at y = 0.069–0.086). `_additional_banners` seeds need the top 0.065,
   and widening that was not measured.
7. **One-page documents.** Should they keep their only heading as a path? The rule
   empties it.

## Reproduction

Local and ignored: `bench/parsers/reports/local/2026-09-24-outline-levels/`.

- **Rules and replay.**
  - `newrules.py` holds this round's rules: `olga2`, the variants, `r12`, `band`,
    `band2` and `troot`;
  - `rules.py` and `v8sim.py` are last round's v9 rules and the v8 simulation;
  - `odl_head/` is the snapshot at `92073e5f`;
  - `replay_levels.py` is the measure, and `gold.py` with `gold_eval.py` score the
    agents' paths (`--dump` for flips);
  - `make_gate_arm.py` builds gate arms.
- **Runs.** `run_final3.sh`, `run_final4.sh`, `run_olga2.sh` and `run_gate4.sh` /
  `run_gate7.sh`, which give each compare its own baseline copy.
- **Analysis.**
  - `flips_dump.py`, `flips_book.py`, `gold_numbering.py`;
  - `lost_outline.py`, `gate_summary.py`;
  - `band_audit.py`, `band_show.py`;
  - `troot_count.py`, `troot_gate.py`, `olg_stats.py`, `veto_check.py`.
- **Results.**
  - `final3_*.json` (variants, band, band2, #12), `final4_*.json` (`troot`, composition)
    and `olga2_*.json` (the recommended rule);
  - `band_audit.json`, `band2_audit.json`, `olg_stats.json`, `final5_troot.json`;
  - `gate/compare-base*-*.json`: the `olga` variants, #12, all rules, and the title-root
    arms;
  - `gate/compare-v9-v9band.json`, `gate/compare-v9-v9band2.json` and
    `gate/compare-v9-v9all2.json`: the bands, and `band2` with #12.

The measure imports `measure.py` read-only, run with `PYTHONDONTWRITEBYTECODE=1`.
