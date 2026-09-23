# Parser v6: running heads, folios and section paths

2026-09-23. This covers the parser identity `odl-2.5.7-refined-rapidocr-v6`,
the replay evidence behind it, and the fresh-parse gate. `CHUNKER_VERSION`
stays v11. Nothing was deployed, ingested or published.

**The fresh-parse gate passes on the option A code.** The first gate, on v6 as
committed in `f062de40`, failed. Seven documents were worse than v5, because
the offset guard kept bottom-margin running footers that v5 removed. Option A
limits the guard to page-top groups, as the decision's wording says. A fresh
gate of that code has no document worse than v5, and every other check is at
least as good. See "Fresh-parse gate" and Q3 in `parser-fix-questions.md`.

## Why

The knowledge-base intake found wrong section paths in 1,521 of 3,957 chunks
across 17 reviewed books. The investigation traced part of them to running
heads and page numbers that stayed headings. They were missed for four
reasons:

- The banner rule needed the same title on three pages.
- The margin band was narrow.
- Folios were recognised only at the page bottom.
- ODL boxes shorter than their glyphs gave no span evidence.

The investigation and its scripts are local, in the ignored
`data/knowledge-base/opus-intake-2026-09-23/section-paths/` (`investigation.md`,
`measure.py`, `parser-fix-questions.md`). The decisions are the 2026-09-23
parser lines in `human/agentic-retrieval.md`.

## What v6 changes (`parser/odl/headings.py`, `parser/odl/furniture.py`)

- **Folio families.** Margin headings that carry a leading or trailing decimal
  or Roman folio are grouped regardless of their title text. The group key is
  folio kind, folio minus page index, top or bottom, band, font and size. The
  margin is top `y1 < 100` or bottom `y0 > 900`, applied only to headings that
  carry a folio.
  - A group becomes discarded running banners when it covers three or more
    pages and some title, with digits and Roman numerals stripped, repeats on
    two of them.
  - Bare folios join the rule with an empty title.
  - This replaces the old rule that bound banners to one title.
- **Offset guard (review findings M6, R2-M1 and the gate's Q3).** A page-top
  group also needs its page offset shown elsewhere in the book, in one of two
  ways:
  - a margin block outside the group with the same folio kind and offset that
    is a bare page number or carries a title the group does not use;
  - group members on both the left and right halves of the page, as on facing
    pages.

  Page-top Exercise N, Question N and Step N headings rise with the page too.
  Another part of the same series proves nothing: a heading ODL typed as a
  paragraph, one without span evidence, or one split into a sibling group by
  band or font size. So a one-sided page-top series stays a heading unless the
  book prints page numbers at the same offset. Because the match is by kind and
  offset, front matter numbered separately (Roman or Arabic) proves its own
  banners through its own page numbers.

  Bottom-margin groups need no such proof. The decision covers "a numbered
  page-top heading", and centred or full-width footers are often a book's only
  page numbering (Q3; the committed `f062de40` applied the guard to them too).
- **Scope boundary.** Every removed banner keeps its former heading level as a
  neutral scope boundary (the 2026-09-20 BOJ lesson). Before, only alternating
  banners kept it.
- **Top-margin folios.** `mark_page_numbers` also accepts folios in the top
  margin that sit above every other line.
- **Bullet headings.** Headings that start with a bullet glyph become body
  text, with role `bullet-item`. The rule needs source evidence and respects
  outline protection.
- **Thin-box evidence.** Span evidence tries the centre test first. Only when
  that finds no literal match does it retry with spans whose horizontal centre
  lies in the box and whose vertical overlap covers half the smaller height.

The plan also proposed two things that were not adopted:

- Restoring heading word spaces from the text layer was dropped. On the
  regression set it rewrote 798 headings, most for the worse: `72. A` became
  `72 . A`, `accessioncountries` became `accessio n countries`, and dot
  leaders were spaced out.
- Demoting headings that hold no letters was not approved.

## Method

[`replay_heading_roles.py`](../scripts/replay_heading_roles.py) runs
`correct_roles` and then `mark_page_numbers` from the working tree and from a
baseline revision (`git archive HEAD parser/odl`). Both run on the same saved
`content_list.json` and PDF. The Java stage does not run, so only the role
rules are compared.

- **Books mode** counts wrong-path chunks with the investigation's
  `measure.py`. A chunk is wrong when a path component is a stale or
  front-matter ancestor, a running head, a folio, a contents line or body
  text, judged against the PDF outline or the transcribed printed contents.
  Chunk starts stay fixed.
- **Regression mode** counts four things:
  - headings the working tree removes as banners or folios;
  - bullet demotions;
  - other block changes;
  - body blocks whose heading path gains a component, using the chunker's
    heading stack.
- **`--strict`** hides the text of blocks the saved run had already discarded
  or marked as page numbers, so they cannot vouch for a folio offset. This is a
  lower bound for the offset guard.

Replay sets, all local and ignored:

- 17 books reviewed in the Opus intake, as measured in the investigation, and
  the 6 books admitted after it. Each has saved `parsed/content_list.json` and
  `corpus.json` under `data/knowledge-base/runs/`.
- 40 distinct regression documents:
  - `reports/local/2026-09-20-unseen-pdf-validation/native-alt-r2/`;
  - `reports/local/2026-09-20-parser-repairs/final/`, which overrides the
    first set for BOJ, Chemistry and J-STAGE;
  - the PDFs under `fixtures/local/`.

## Results

These are replay results on saved outputs. The fresh-parse gate below
supersedes their "no document is worse" for the seven documents it names.

Baseline is the v5 rules replayed on the saved output. The lenient and
`--strict` runs give identical results. The first offset guard (M6) changed no
document in any set. Its sibling fix (R2-M1) changes one document, census (see
below).

Technology-tools' saved corpus was rewritten by a path-cleanup republish
between the first and last runs. Its saved paths now score 0, and its replayed
count moved from 81 to 83 in both columns. With the earlier data, the 17-book
totals were 1,521 → 1,063.

### Knowledge-base books (wrong-path chunks, final run)

| Book | v5 | v6 |
| --- | ---: | ---: |
| media-society-culture-and-you | 261 | 0 |
| the-science-of-sleep | 120 | 53 |
| introduction-to-game-theory | 97 | 47 |
| transitions-to-professional-nursing | 43 | 8 |
| english-composition | 31 | 9 |
| web-writing | 18 | 6 |
| keys-to-understanding-the-middle-east | 17 | 6 |
| ten other report books | 936 | 936 |
| **17 report books** | **1,523** | **1,065** |
| liquidity-markets-and-trading-in-action | 112 | 108 |
| five other later books | 566 | 566 |
| **6 later books** | **678** | **674** |

No book is worse. The remaining errors are mostly stale ancestry from ODL
style ranks in books without a usable outline (music 366, media-studies-101
278, ODE 285, animals 191, private pilot 163). Review agents correct those
paths.

The thin-box retry alone accounts for media's 261 → 0. Without it the 17-book
total is 1,324. The plan's "half the span's area" wording admits none of
media's boxes: each span overlaps its box by 45% of its own area. Used on its
own instead of as a fallback, the thin test would have lost 254 of MIT
Strang's removals.

### Regression documents

| Document | Banners/folios removed | Bullets demoted | Other changes | Body blocks gaining an ancestor |
| --- | ---: | ---: | ---: | ---: |
| mit-strang-calculus | 515 | 0 | 0 | 0 |
| heading-oecd | 493 | 0 | 0 | 0 |
| heading-libreoffice | 454 | 0 | 0 | 0 |
| openstax-biology-2e | 275 | 0 | 0 | 0 |
| ntnu-linear-algebra | 214 | 3 | 0 | 1 |
| openstax-astronomy-2e | 154 | 0 | 0 | 0 |
| openstax-principles-microeconomics-3e | 115 | 0 | 0 | 0 |
| openstax-introductory-statistics-2e | 104 | 2 | 0 | 2 |
| openstax-chemistry-2e | 90 | 0 | 0 | 0 |
| openstax-psychology-2e | 74 | 0 | 0 | 0 |
| bccampus-accessibility | 24 | 1 | 0 | 1 |
| openstax-precalculus-2e | 18 | 4 | 0 | 4 |
| openstax-introduction-computer-science | 12 | 1 | 0 | 1 |
| heading-r-intro | 11 | 0 | 13 | 0 |
| dmoi4 | 10 | 3 | 0 | 43 |
| heading-forallx | 10 | 0 | 0 | 0 |
| prince-textbook | 4 | 0 | 0 | 0 |
| jstage-1949-statistics | 3 | 0 | 0 | 0 |
| snu-admissions | 0 | 6 | 0 | 12 |
| **40 documents** | **2,580** | **20** | **13** | **64** |

These 21 documents are unchanged: BOJ, ECB, WeasyPrint, both scope controls
(LaTeX, Lua), ACL, bookdown, census, CTAN, INSEE, both Lille documents,
mu-calculus, both NIST documents, Prince Icelandic and math, QMUL and the
three W3C documents.

- The removed headings are running heads and folios: OpenStax section heads
  (`1.3 • The Laws of Nature 15`), MIT Strang, NTNU, LibreOffice
  `Getting Started 7.5 | 3`, OECD folios and dmoi4 `xiv Contents`.
- The 13 other changes are R-intro top-margin folios (`i`, `iii`, `7`, `13`)
  that were body text and are now page numbers.
- Every new ancestor comes from a bullet demotion. The real heading above now
  covers the item instead of the item heading itself: a QED `■` after
  `Example 3.6.6`, SNU `• 미술대학` lines, precalculus `• Press[MODE]`.

### Offset guard

Among the 35 folio families accepted in these sets:

- 14 are proven only by another margin block;
- 17 are proven both that way and by facing sides;
- 4 are proven only by facing sides:
  - animals-ethics (113 top folios), OECD (493) and prince-textbook (4), each
    the book's only page numbering;
  - technology-tools (41 `Chapter 1 | 3` footers), whose other proof was two
    footers of its own series.

Census is the one change from the sibling fix. Its running footer (`12 Income
in the United States: 2024 U.S. Census Bureau`) spans the full width on both
left and right pages, so the facing-pages test cannot see it. Its only other
proof was its own series: footers v5 had already removed in a neighbouring
band, and two footers without span evidence. The fix therefore keeps its 21
footers as headings, which is exactly its v5 state: not worse, but the gain is
lost. A proof from the folio switching ends (leading on left pages, trailing
on right) would recover it. That was not implemented, since it goes beyond the
approved rule.

Unit probes cover the rest:

- Exercise N at y≈76 (the case v6 briefly lost because the band widened), Step
  N and bare page-top numbers stay headings unless a printed folio shows the
  same offset. A folio with a different offset does not help.
- An Exercise series still stays a heading in four cases the first guard
  missed:
  - one member typed as a paragraph;
  - one member without span evidence;
  - members split across two bands;
  - members split across two font sizes.
- Roman and Arabic front matter numbered apart from the body keeps its
  banners.
- Real folio running heads on facing pages, a thin-box running head and the
  BOJ chart-label scope still behave as intended.
- The reviewer accepted one residual: a one-per-page series that alternates
  page halves (two columns) looks like facing-page heads and is removed.

## What the replay cannot see

- **Banners v5 already removed.** The replay cannot re-evaluate them (12,592
  in the saved outputs). On a fresh parse, v6 judges each one again. It may
  give it a neutral boundary, or keep it as a heading if the offset guard
  refuses its group. The fresh-parse gate measures both effects.
- **Lost ancestors.** `measure.py` counts a dropped ancestor as no issue, so
  "no book is worse" does not cover it on its own. The gate's ancestry check
  covers it.

## Fresh-parse gate (review M5)

### Setup

- **Arms.** Both run the parser service over the multipart `/file_parse`
  route with the builder container's env and limits (7 GiB, 4 CPUs,
  1,800-second deadline):
  - v6: the builder container, image `capy-kb-parser:pilot-v6`, code
    `f062de40`, port 18091;
  - v5: a temporary copy of the kept v5 container, image
    `capy-kb-parser:pilot-v5`, port 18092, removed afterwards.

  Chemistry and biology exceed the 200 MiB source cap. Both arms parsed them in
  temporary copies with only the cap raised to 512 MiB, one container at a
  time.
- **Sources.** 66 per arm, 16,924 pages:
  - the 40 regression documents, which include both gold sets;
  - physics (outline roots);
  - the 23 intake books;
  - `fixtures/docs/jp_llm2.pptx`, a real 84-slide lecture deck with slide
    numbers and titles that repeat across slides;
  - a numbered-title variant of that deck. Every title gains a section number
    that advances when the title changes, and three consecutive titles end in
    `Step 1..3`.
- **Measures.** [`gate_parser_fresh.py`](../scripts/gate_parser_fresh.py)
  packs both arms with the production chunker, then reports:
  - body retention;
  - outline anchors and roots;
  - v5 banners that v6 keeps as headings;
  - the gold witnesses;
  - an ancestry diff over every body block both arms emit;
  - wrong-path chunks for the intake books, using `measure.py`.
- **Caveat.** The multipart route returns no font-repaired `parsed.pdf`, so
  both arms measure against the original PDF.

### Results (v5 → v6 as committed in `f062de40`, fresh)

| Check | Result |
| --- | --- |
| Body retention | 0 unexplained losses; 83 missing units, all banners or page numbers v6 removed |
| Outline anchors | 4,889 / 4,889 retained |
| Outline-root promotions | 270 / 270 retained, no new abstention: chemistry 25, biology 50, physics 25, BCcampus 14, LibreOffice 16, OECD 6 |
| Heading-release gold (20) | v5 13 pass / 6 fail / 1 abstain (matches its record) → v6 14 / 5 / 1: case 08, LibreOffice `14 \| Preface`, fixed |
| Heading-scope gold (6) | 6 / 6 in both arms |
| Lost ancestry | 143,592 body blocks compared, no outline-confirmed ancestor lost; 20,610 lost components are removed banners, and the 502 other lost headings sampled are running heads v6 still leaves as headings, chart titles (the BOJ pattern), a table row and a promoted sentence |
| Guard decks | all slide titles survive in both decks, numbered and Step N included |
| v5 banners kept as headings | **681, all bottom-margin footers, in 7 documents** |
| Wrong-path chunks, 17 report books | 1,521 → 1,366 |
| Wrong-path chunks, all 23 books | **2,199 → 2,388** |

- **Other gold changes.** OECD case 13 also loses its residual
  `Executive summary › 19` folio child. Case 12 (the R running title) is now a
  running banner rather than a diagram label, still a pass.
- **Deck bullet demotions.** The only deck changes are bullet demotions: six
  list items, plus one real slide title, `■MoE を含む言語モデルにおけるスケール則`.
  That title is demoted because of the `■`, the accepted review finding m10.

### The failure (v6 as committed)

Seven documents are worse than v5.

| Document | Footers kept | Wrong chunks v5 → v6 | Footer |
| --- | ---: | ---: | --- |
| business-plan-development-guide | 133 | 1 → 214 | same title with page number |
| entrepreneurship-and-innovation-toolkit | 88 | 0 → 215 | `Entrepreneurship and Innovation Toolkit 4` |
| public-policy-origins-practice-and-analysis | 137 | 2 → 197 | same title with page number |
| overview-of-healthcare-compliance | 124 | 31 → 168 | `Page \| 1`, centred |
| private-pilot-for-airplane-category | 79 | 163 → 181 | `Private Pilot … ACS (FAA-S-ACS-6C) 1`, full width |
| ecb-annual2024 | 109 | – (402 body blocks gain a footer ancestor) | full width |
| census-income2024 | 11 | – (46 body blocks gain a footer ancestor) | full width, alternating ends |

v5's title-bound rule removed each of these. The v6 offset guard keeps them
for two reasons. First, a centred or full-width box never shows left and right
sides. Second, the footer is the book's only page numbering, so no other
margin block shows the offset.

### Options measured

Each option was measured by re-running role correction on the fresh v6 output
from a scratch copy of the parser. A control run of the unchanged v6 rules
differs from the true fresh parse in three documents (business plan, forallx,
INSEE), so these numbers are close to, but not exactly, fresh parses.

| Option | Footers kept | Documents worse than v5 | Wrong chunks, 17 books | Wrong chunks, 23 books |
| --- | ---: | ---: | ---: | ---: |
| v6 as committed | 681 | 7 | 1,366 | 2,388 |
| A: offset guard on page-top groups only | 0 | 0 | 996 | 1,610 |
| C: also prove by the folio switching ends | 449 | 4 | 1,151 | 1,960 |

Under A, anchors, roots and body text are unchanged, and no outline-confirmed
ancestor is lost. Option A matches the decision's wording ("a numbered page-top
heading").

### Option A, gated fresh

The parent adopted A (Q3). `parser/odl/headings.py` now treats a bottom-margin
folio group as proven, and page-top groups keep the guard. Tests add a centred
and a full-width bottom footer that are a book's only page numbering (both
removed), and `Question N` joins the page-top probes (still headings).

The gated code is exactly the code to be committed:

- **Build.** The image `capy-kb-parser:scratch-v6a` was built from the working
  tree's parser files with `RELEASE_SHA` set to HEAD `bac9dbc3` as a
  placeholder. Its `headings.py`, `furniture.py` and `app.py` match the working
  tree byte for byte, line endings aside.
- **Run.** The image ran on port 18093 with the builder container's env and
  limits, plus the 512 MiB source cap. It fresh-parsed all 66 sources, which
  were compared with the fresh v5 arm above.
- **Cleanup.** Container and image were removed afterwards.

| Check | v5 | v6 as committed | v6 option A |
| --- | --- | --- | --- |
| Documents worse than v5 | – | 7 | **0** |
| v5 footers kept as headings | – | 681 | **0** |
| Unexplained body losses | – | 0 | 0 |
| Outline anchors | 4,889 | 4,889 | 4,889 |
| Outline-root promotions | 270 | 270 | 270 |
| Outline-confirmed ancestors lost | – | 0 | 0 |
| Heading-release gold | 13 / 6 / 1 | 14 / 5 / 1 | 14 / 5 / 1 |
| Scope gold | 6 / 6 | 6 / 6 | 6 / 6 |
| Wrong chunks, 17 report books | 1,521 | 1,366 | **996** |
| Wrong chunks, 6 later books | 678 | 1,022 | **614** |

- **Footer documents.** The seven regressed documents are back to v5 or better:
  entrepreneurship 0, business plan 1, public policy 2, healthcare 31 and
  private pilot 163 wrong chunks. ECB and census keep no footer.
- **Everything else.** Gold witness states, both guard decks and all other
  documents match the first v6 run.
- **Fresh numbers match the scratch measurement.** The fresh result equals the
  estimate made on re-run v6 output (996 and 1,610 wrong chunks for the 17 and
  23 books).
- **Result: pass.**

## Reproduction

```sh
uv run --project pipeline python bench/parsers/scripts/replay_heading_roles.py regression \
  --outputs bench/parsers/reports/local/2026-09-20-unseen-pdf-validation/native-alt-r2 \
            bench/parsers/reports/local/2026-09-20-parser-repairs/final \
  --output regression.json [--strict]
uv run --project pipeline python bench/parsers/scripts/replay_heading_roles.py books \
  --measure-dir data/knowledge-base/opus-intake-2026-09-23/section-paths \
  --output books.json [--strict]
```

The span-rule and re-spacing comparisons were one-off variants of the same
replay; their numbers are recorded in `parser-fix-questions.md`.

The gate, with raw outputs under the ignored
`reports/local/2026-09-23-parser-v6-gate/`:

```sh
uv run --project pipeline python bench/parsers/scripts/gate_parser_fresh.py deck \
  bench/parsers/fixtures/docs/jp_llm2.pptx GATE/decks/jp_llm2-numbered.pptx
PARSER_TOKEN_V5=... PARSER_TOKEN_V6=... uv run --project pipeline python \
  bench/parsers/scripts/gate_parser_fresh.py parse --manifest GATE/gate.json \
  --arm v5=http://127.0.0.1:18092 --arm v6=http://127.0.0.1:18091 --output GATE
uv run --project pipeline python bench/parsers/scripts/gate_parser_fresh.py compare \
  --manifest GATE/gate.json --output GATE --arms v5 v6 \
  --gold bench/parsers/fixtures/heading-release-gold-2026-09-20.json \
         bench/parsers/fixtures/heading-scope-release-gold-2026-09-20.json \
  --measure-dir data/knowledge-base/opus-intake-2026-09-23/section-paths
```

The option trees `v6A`, `v6C` and the control `v6R` were produced by a scratch
script that swaps the guard expression in a copy of `parser/odl`. Compare them
with `--arms v5 v6A` and so on.
