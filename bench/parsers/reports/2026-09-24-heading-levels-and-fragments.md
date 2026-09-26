# Heading levels and formula fragments

2026-09-24. This covers the two section-path causes that had no parser fix yet:

- **(a) Stale ancestry from ODL style ranks** in books without a usable PDF outline.
- **(b) Formula fragments and labels typed as headings** in maths books.

Three rules are prototyped. Each was replayed on the saved parses and checked against the
agents' corrected paths and against the fresh-parse gate set. No production code was
changed and nothing was committed. The prototypes and every result file are in
`bench/parsers/reports/local/2026-09-24-heading-levels/`, which git ignores.

## Summary

- **Recommended for the implementer.** Three rules: `fragments` and `contents` for (b),
  and `backbone` for (a). They run after the v6 role rules and after the approved v8
  heading rules.
- **Wrong-path chunks** (37 intake books, section-path `measure.py`):
  - 4,124 → 2,814 (−32%), and no book gets worse.
  - Music 364 → 26, ODE 241 → 22, Animals 191 → 97, Technology Tools 83 → 0, Learn-It-All
    84 → 44, Basic Analysis II 122 → 7.
- **Agents' paths** (46 reviewed books, 28,844 chunks):
  - 10,219 → 11,741 chunk paths now match what the agents wrote.
  - 1,777 chunks fixed, 255 made worse. Most of the 255 are in books whose paths were
    never reviewed (below).
- **Gate** (66 documents):
  - All 4,889 outline anchors and 270 roots are kept, and the 6 scope-gold verdicts pass.
  - Two gold witnesses change, and both now match what the gold file expects.
  - The one "worse" signal is the intended one: 176 body blocks in Technology Tools no
    longer sit under "Contents".
  - Wrong-path chunks fall from 1,610 to 821.
- **The rules compose with v8.** With a simulation of the v8 heading rules as the
  baseline, they change the same things by the same amount (details below).
- **An outline rule for books that do have an outline is not recommended yet.** It
  scores much higher against the agents' paths (15,628 vs 11,741) but fails the gate.

## How it was measured

The v6 role rules (`correct_roles`, `mark_page_numbers`, from a `git archive` of HEAD's
`parser/odl`) were replayed on each book's saved parse, then the rules on top, as in
`replay_heading_roles.py`. Chunk starts stay fixed. Three views:

- **The section-path measure.** It flags stale ancestors and artefacts against the PDF
  outline or the hand-transcribed printed contents. Two of the counts named in the task
  are partly measurement artefacts:
  - Media Studies 101's 277: its outline lists an author tag ("mediatexthack") under
    every chapter.
  - ODE's 241: it has no outline, and its letter-spaced title root counts as body text.
    Most of the drop to 22 comes from `backbone` putting the chapters at the top, which
    removes that root. The developer already chose to repair the root by hand.
- **The agents' corrected paths.** For every reviewed chunk, the gold path is the
  corrected path if the agents repaired it, else the path they accepted.
  - Before comparing, a leading book-title component and components without letters
    are dropped. Agents kept or dropped both inconsistently from book to book.
  - Components match when equal, or when one title is a truncation of the other.
  - Letterless fragments ("∫", "=") are therefore invisible here, which understates rule
    (b). The measure shows it instead.
  - The intake is live, so the gold set grew slightly between runs. Every figure here
    comes from one final run of all arms together.
- **The fresh-parse gate.** The rules were applied to the gate's `v6afresh` content
  lists and compared with `gate_parser_fresh.py compare`.

## Rule 1: `fragments` (part b)

It demotes a native heading to body text when it is one of:

- **A formula fragment.** No run of three ordinary letters, and one of the following:
  - no ordinary letter at all;
  - a maths symbol, a maths-alphanumeric or Greek letter, or a private-use glyph;
  - two or more tokens of at most two characters each.

  Examples: "∫ b", "= ∫ 2π", "ℝ𝑛 ℝ𝑛", "0 B @", "x˙ = a(t)x + b(t), x 2 R.". Exempt: a
  single letter (index or dictionary sections) and a dotted section number ("10.1.1 di
  'at, in'").
- **A run-in label.** Theorem, lemma, proposition, corollary, definition, example,
  exercise, remark, proof, claim, problem, question, solution, activity, step and similar,
  plus a number and at most one more word. For example "Example 9.1.2: Let" and
  "Proposition 8.2.8.". "Proof." alone also counts.
- **A numbered callout series.** One label with three or more numbers that are dotted
  (EXAMPLE 12.1), restart in each chapter (Figure 1 again), or track the page number (a
  running head such as "WORLD MUSIC 57"). Structural words are excluded (chapter, part,
  unit, lesson, section, appendix, week and similar). A clean once-each run such as
  Problem Set 1…10 is left alone.
- **A page footer** ("Page 31 of 179").
- **A bare number or chapter label** ("5.", "CHAPTER 3") set above its title. It becomes
  the title's `_chapter_label` and its own block is discarded. A bare number with no
  title after it is demoted.

**Outline guard.** A heading the PDF outline lists on its page is never demoted. This
kept R's operator sections ("!", "%", "&"), ECB's "G20", OpenStax's "Practice Test 1" and
bccampus's "Definition 1".

**Effect.**

- Basic Analysis II: wrong-path chunks 122 → 7, and 357 → 458 of 529 chunks now match the
  agents' paths. The agents corrected 285 paths in its five scopes, mostly for these
  fragments.
- Across the 37 books: 4,124 → 3,615 wrong-path chunks.
- On the 66-document gate set it demotes 1,015 formula fragments, 2,180 callout-series
  headings (OpenStax "EXAMPLE 12.1", "Figure 20"), 280 bare numbers, 42 page footers and
  27 run-in labels, and attaches 123 chapter labels to their titles. No outline anchor
  is lost.

**False positives,** judged by whether the agents kept the demoted heading as a path
component anywhere in the book:

- formula fragments: 15 of 1,997 kept. They are the operator strings of the unreviewed
  Programming Fundamentals and one agent miss, "= 𝜖. □".
- run-in labels: 4 of 16 kept, all Business Ethics "Exercise 1b" callouts;
- callout series: 68 of 372 kept, mostly Business Ethics' titled exercises
  ("Exercise 3: Develop a Solution List");
- bare numbers: 1 of 819 kept;
- page footers: 0 of 172 kept.

On the gate, "€135" is demoted, which is what its gold case expects ("price in a coloured
offer card, not a section heading").

Known misses:

- formulas that contain a three-letter run are kept ("(pµ,0) : 2pµ 0");
- tokens like "3D" and "G20" are kept by design.

## Rule 2: `contents` (part b, contents lines)

It demotes every heading on printed-contents pages except the contents title and titles
such as "List of Figures". Contents pages are:

- a run of pages starting at a contents title within the first fifth of the book;
- each with at least 4 blocks, at least half of them entries ending in a page number or
  a dot leader.

The contents titles include 目次, 目录 and 목차. The outline guard applies here too.

Effect: 227 contents lines on the gate set ("5 Radiation and Spectra 139"). It is small
on the intake books, but it keeps contents entries out of the backbone's chapter chain.

## Rule 3: `backbone` (part a)

It runs only when the PDF outline is not usable: fewer than 5 entries, or under 30% of
them found as headings on their page. Such books keep their v6 levels here. The rule
re-levels headings from what the book prints:

1. **Chapter chain.** The longest run of chapter numbers that rises by 1 to 3.
   - Chapter labels ("Chapter 3", "CHAPTER TWO", "Area of Operation IV", "Bonus Essay 1")
     are tried first, then bare depth-1 numbers ("3 Word-formation").
   - Candidates that open a page are tried first, then each ODL style on its own.
   - The chain must start at chapter 1 or 2, skip few numbers, spread over at least 20%
     of the pages and hold at least 3 chapters. Otherwise the book is left alone.
   - A label whose title repeats under different numbers ("Chapter 3 Key Takeaways") is
     a callout, not a chapter.
   - A chapter label ODL left as body text at the top of its page is promoted. This
     covers Animals' chapters 2 to 8.
2. **Levels.**
   - Chapters are level 1.
   - Parts are level 1 and chapters level 2, but only when the parts rise in number and
     are set at least as big as the chapters. That excludes "Part Four: Solution
     Implementation" inside a Business Ethics case.
   - A numbered section is chapter level + depth − 1, and only if it continues the
     chapter in force: 8.1 inside chapter 8.
3. **Front and back matter.**
   - Headings before the first chapter never parent it. Those at least as big as the
     deepest style that opens a front page rank with chapters; smaller ones nest under
     the last of those.
   - Preface, foreword, acknowledgements, bibliography, index, glossary, appendices and
     similar rank with chapters anywhere.
   - Introduction, conclusion, summary, references and notes rank with chapters only
     outside the chapters.
   - Contents, lists of figures and dated cover lines ("November 2023") rank with
     chapters before the first chapter, and inside the book only label their own pages.
4. **Other headings.**
   - An unnumbered heading styled like numbered headings of depth d becomes a depth-d
     sibling, unless it is a sentence.
   - Any other unnumbered heading nests under the section in force and keeps its style
     order.
   - Removed-banner scope boundaries (`_heading_boundary_level`) are rescaled the same
     way. Without that, Euclidean's banners popped real sections.

**Effect** on the task's named books:

| Book | Wrong-path chunks | Chunks matching the agents |
| --- | --- | --- |
| Music: Its Language, History, and Culture | 364 → 26 | 3 → 232 of 370 |
| ODE | 241 → 22 | 95 → 147 of 242 |
| Animals & Ethics 101 | 191 → 97 | 22 → 116 of 211 |
| Private Pilot ACS | 163 → 163 (not run: it has an outline) | 1 → 1 |
| Media Studies 101 | 277 → 277 (not run: it has an outline) | 246 → 245 |

Others:

- Technology Tools 83 → 0;
- The Learn-It-All Educator 84 → 44;
- The Science of Sleep 54 → 35;
- Human Anatomy Self-Assessment 14 → 144 of 147 matching.

What remains in Music and Animals is mostly headings ODL never typed as headings: Music's
era subheadings "Renaissance (ca. 1450–1600)" are bold body-size lines.

## Combined effect and regressions

Wrong-path chunks (37 books):

| Arm | Wrong-path chunks |
| --- | ---: |
| v6 roles (baseline) | 4,124 |
| + fragments | 3,615 |
| + contents | 3,607 |
| + backbone (recommended) | 2,814 |
| simulated v8 | 4,059 |
| simulated v8 + recommended | 2,743 |

Chunks matching the agents' paths (46 books, 28,844 chunks):

| Arm | Chunks |
| --- | ---: |
| v6 roles (baseline) | 10,219 |
| + fragments | 10,959 |
| + contents | 11,180 |
| + backbone (recommended) | 11,741 |
| simulated v8 | 10,151 |
| simulated v8 + recommended | 11,675 |

The biggest gains: Educational Psychology 778 → 1,322, Alternatives to Agonism 153 → 384,
Music 3 → 232, Human Anatomy Self-Assessment 14 → 144, Basic Analysis II 357 → 458,
Animals 22 → 116.

The 255 chunks made worse:

- **Programming Fundamentals, 155.** Its paths were never reviewed: 3 corrections in 947
  chunks. Its accepted paths still hold contents lines ("Contents › Chapter 3 Data &
  Operators ....."), which rule 2 removes.
- **Java, Java, Java, 77.** ODL typed its running heads ("184 CHAPTER 4 • Input/Output…")
  as headings at y = 0.107, just below the v6 margin band. Dingbat headings ("☛ ✟") used
  to close them. Rule 1 demotes the dingbats, which exposes the running heads. This is a
  banner-band gap, not a fault of the rule.
- Learning Statistics with R 10 (a footnote typed as a heading, exposed the same way),
  Basic Analysis II 5, ODE 3, and 1 or 2 each in four more books.

## Gate

| | Recommended | Simulated v8 → v8 + recommended | With the outline rule |
| --- | --- | --- | --- |
| outline anchors kept | 4,889 / 4,889 | 4,889 / 4,889 | 4,889 / 4,889 |
| roots kept | 270 / 270 | 270 / 270 | 267 / 270 |
| gold witnesses changed | 2 (both toward the gold expectation) | 2 | 21 |
| scope gold | 6/6 pass | 6/6 pass | 6/6 pass |
| outline-confirmed ancestors lost | 176, Technology Tools only | 176 | 14,646 in 29 documents |
| body units missing | 7 | 7 | 7 |
| wrong-path chunks | 1,610 → 821 | 1,604 → 810 | 1,610 → 685 |

The two witness changes:

- weasyprint "€135" becomes body text, as its gold case expects.
- forallx "CHAPTER 1 / Arguments" keeps "Arguments" as the heading and its label moves
  onto it.

Technology Tools' outline holds only "Contents", so the gate counts the removed
"Contents" ancestor as an outline heading lost. The agents removed it from all 84 of
that book's repaired paths. The 7 missing body units are Animals' promoted chapter
titles, which now appear in the path instead of the chunk text.

## Composition with v8

The v8 simulation has three parts:

- banner rules that also see margin paragraphs (#5);
- body-style headings ending in sentence punctuation demoted (#11);
- one-line capitals headings promoted one level below the heading in force (#10).

The outline-heading rule (#12) inserts blocks the replay cannot add, so it is not
simulated. Furniture (#9), ToUnicode (#13) and ligatures (#14) do not touch headings.

On that baseline the recommended rules change the same books in the same way:

- measure 4,059 → 2,743;
- agents' paths 10,151 → 11,675;
- the same gate profile.

The simulation is rough: physics drops from 78 to 12 matching chunks under the simulated
v8 alone.

**Order.**

1. `correct_roles` (with #5), then `mark_page_numbers`.
2. #11, #10, #12.
3. `fragments`, `contents`, `backbone`.

**Interactions.**

- `backbone` sees #10's promoted capitals headings as unnumbered headings and levels them
  by style.
- #11's demotions remove body-style headings before `backbone` reads styles.
- A book where #12 inserts outline headings has a usable outline, so `backbone` does not
  run on it.

## Not recommended yet: an outline rule

For books with a usable outline, the prototype `outline` rule gives each listed heading
its outline level, in page order with titles normalised. It also:

- ranks a missed numbered heading with listed headings of its depth;
- nests other headings under the listed heading in force;
- skips outline tags repeated under every chapter;
- stops front-matter outline entries from parenting chapters;
- drops margin copies of top-level titles.

**The upside.** Chunks matching the agents rise to 15,628 (+5,409), with gains in:

- Papuan Malay 0 → 825;
- Intermediate Financial Accounting 2 → 799;
- Business Processes 137 → 859;
- Concepts of Biology 215 → 622;
- Formal Logic 1 → 235;
- Unicode Cookbook 3 → 230.

**Why it is held back.** It fails the gate:

- 21 gold witnesses change;
- outline-confirmed ancestors change in 29 documents;
- 3 roots are lost;
- the measure gets worse in Business Plan (2 → 9), the Entrepreneurship Toolkit (1 → 23)
  and Philosophical Ethics (30 → 32).

Some of its "losses" are the agents' own convention: English Composition's and Keys to
the Middle East's accepted paths leave out chapter titles the outline lists.

It needs its own design pass: re-level only where the v6 path contradicts the outline,
and settle with the developer whether chapter titles belong in paths.

## What the implementer needs to port

- **Code.** A new module, for example `parser/odl/levels.py` (about 580 lines as
  prototyped, with helpers and docstrings), with three functions:
  - `demote_fragments(blocks, document)`;
  - `demote_contents_lines(blocks, document)`;
  - `backbone_levels(blocks, document)`.

  The prototype is `rules.py` in the local folder: `fragments`, `contents`, `backbone`
  and their helpers. The `outline` rule and `v8sim.py` are not part of the port.
- **Call site.** In `refine.parse_pdf`, after `furniture.mark_page_numbers(...)` and before
  `furniture.repeated_across_pages(...)`, after the v8 heading rules. That is where the
  replay applied them: heading text is final (source-text repairs done) and roles are
  settled.
- **Block contract.**
  - Block order is unchanged and no block is added.
  - The rules change `text_level`, `type` (a chapter label becomes `discarded`) and
    `_heading_boundary_level` (rescaled).
  - They set `_source_role`: `formula-fragment`, `run-in-label`, `callout-series`,
    `page-footer`, `bare-number`, `chapter-label`, `contents-line` or `chapter-opener`.
  - They set `_chapter_label` on a title.
  - The chunker is unchanged, and so is `CHUNKER_VERSION`.
- **The document.** Only `document.get_toc()` is used, for the outline guard and the
  usable-outline test. The v6 `_outline_match` could replace the prototype's key match.
- **Tests.** One focused test per behaviour:
  - fragment and label examples, and the exemptions;
  - callout series: dotted, restarting, page-tracking, and a clean run;
  - contents-page detection;
  - chain selection: contents entries before the body, "Key Takeaways" callouts,
    per-style fallback, a two-part book;
  - front matter, parts, style siblings, boundary rescaling, outline gating.
- **Gates.**
  - The heading gate on a fresh parse, since these are heading rules.
  - This replay: `run_final.sh` reruns the measure, the agents'-path score, per-book flips
    and the gate compares.
  - Expect Technology Tools' "Contents" ancestry change and Animals' 7 promoted chapter
    titles.

## Open questions

1. **Outline rule.** Take the outline rule to a follow-up, given its +5,409 upside and its
   gate failures? And should paths include a chapter title the outline lists when the
   agents' accepted path left it out?
2. **Unnumbered callout titles** ("Retrieval Practice", "Student Learning Objectives",
   "Technology Insight" without numbers) stay path components. Agents removed them in some
   books and kept "Discussion Questions" in Animals. Removing them needs a rule on
   repeated identical headings, which was not built.
3. **Missing headings** are a detection problem this does not touch:
   - ODL swallows "8.3.1 The derivative" into a list block;
   - Learn-It-All's numbered sections were never typed as headings;
   - Music's era titles are bold body-size lines.
4. **Running heads just below the margin band** (Java at y = 0.107) are headings the v6
   banner rules miss. The v8 banner extension covers margin paragraphs only. Widening
   the band for folio families would remove Java's 77 regressions.
5. **Book-title roots and chapter numbers as components** are kept or dropped
   inconsistently in the agents' paths. A convention would make the gold sharper.

## Reproduction

Local and ignored: `bench/parsers/reports/local/2026-09-24-heading-levels/`.

- **Rules and replay.**
  - `rules.py` (the prototypes) and `v8sim.py` (the v8 simulation);
  - `odl_head/`, a snapshot of HEAD's `parser/odl` at `0d36a750`;
  - `replay_levels.py` (the measure per arm) and `gold.py` with `gold_eval.py` (the
    agents' paths);
  - `gold_flips_all.py` (per-book fixes and regressions) and `demotion_precision.py`;
  - `make_gate_arm.py` (gate arms from `v6afresh`) and `run_final.sh` (everything above).
- **Diagnostics.** `show_heads.py`, `first_heads.py`, `wrong_examples.py`, `gold_diff.py`,
  `gold_flip.py`, `gold_census.py`, `outline_stats.py`, `issue_counts.py`.
- **Results.**
  - `measure_final.json`, `gold_final.json`, `gold_flips_rec.json`, `gold_flips_out.json`,
    `demotion_precision.json`, `gold_census.json`;
  - `gate/compare-v6afresh-hl.json`, `gate/compare-v6afresh-hlo.json`,
    `gate/compare-v8s-v8hl.json`.

The measure imports the section-path investigation's `measure.py` read-only, run with
`PYTHONDONTWRITEBYTECODE=1`.
