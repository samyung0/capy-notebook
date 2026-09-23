# Parser v6: running heads, folios and section paths

2026-09-23. This covers the parser identity `odl-2.5.7-refined-rapidocr-v6` and
the replay evidence behind it. `CHUNKER_VERSION` stays v11. Nothing was
deployed, re-parsed or rebuilt. The fresh-parse gate has not run yet (see
"Not measured").

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
- **Offset guard (review findings M6 and R2-M1).** A group also needs its page
  offset shown elsewhere in the book, in one of two ways:
  - a margin block outside the group with the same folio kind and offset that
    is a bare page number or carries a title the group does not use;
  - group members on both the left and right halves of the page, as on facing
    pages.

  Exercise N, Question N and Step N headings rise with the page too. Another
  part of the same series proves nothing: a heading ODL typed as a paragraph,
  one without span evidence, or one split into a sibling group by band or font
  size. So a one-sided series stays a heading unless the book prints page
  numbers at the same offset. Because the match is by kind and offset, front
  matter numbered separately (Roman or Arabic) proves its own banners through
  its own page numbers.
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

## Not measured

- **Fresh parses.** Review finding M5 is still open. It covers the heading
  release and scope gold, body retention, outline anchors and a PPTX deck with
  numbered slide titles. It runs later on the rebuilt v6 image.
- **Banners v5 already removed.** The replay cannot re-evaluate them, and the
  saved outputs hold 12,592. On a fresh parse each one also gets a neutral
  boundary, which can drop ancestry below its level or make outline-root
  promotion abstain. Chemistry's 37 root promotions are safe: its boundaries
  sit at level 35 and its roots started at levels 3–4. The reviewer's check of
  the 23 intake books found only removed banner components among lost
  ancestors.
- **Lost ancestors.** `measure.py` counts a dropped ancestor as no issue, so
  "no book is worse" does not cover it on its own. The reviewer's check above
  fills that gap for the intake books only.

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
