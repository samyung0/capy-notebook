# Parser v9 fresh-parse gate

2026-09-24. Gate for parser `odl-2.5.7-refined-rapidocr-v9`: the three rules of the
[heading-levels report](2026-09-24-heading-levels-and-fragments.md), ported into
`parser/odl/levels.py` (decision 2026-09-24):

- `demote_fragments`: formula fragments, run-in labels, numbered callout series, page
  footers and bare numbers typed as headings become body text; a bare number or chapter
  label above its title becomes the title's `_chapter_label`;
- `demote_contents_lines`: headings on printed contents pages become body text;
- `backbone_levels`: a book without a usable outline is re-levelled from its chapter
  chain and section numbering.

They run in `refine.parse_pdf` after `mark_page_numbers` and the v8 heading rules, and
before furniture is frozen. The investigator's `outline` rule and `v8sim.py` are not
ported.

**Result: the gate shows the report's profile, and the replays reproduce its numbers.**
Every outline anchor, root and scope witness is kept; the two gold witnesses that change
move to what their gold expects; the only lost outline-confirmed ancestry is Technology
Tools' "Contents", and the only missing body text is Animals' 7 promoted chapter titles
plus three exercise-number lines in OpenStax Precalculus (below). Wrong-path chunks fall
from 1,575 to 772. **One regression outside the gate:** Conservation Techniques, which
waits for a re-parse, gets 5 of its 13 chapters nested under the chapter before them
(234 of 548 chunks). The live swap is held for that question.

## Port fidelity

The port and the prototype (`rules.py`, imported read-only) were applied to the same
blocks for 194 inputs: the 64 PDF gate documents and the four extra books as fresh v8
outputs, and 126 library books' saved parses after v8's role rules. They agree block for
block on all 194 (150 of which the rules change). The prototype's outline key match is
kept rather than v6's `_outline_match`, so the results are identical by construction.
One quirk carried over: a heading whose outline key is empty ("%") is protected when any
outline entry on its page also has an empty key ("!").

## Setup

- **Candidate.** A snapshot of the working tree's `parser/` (`snapshots/parser-a`)
  mounted read-only over `/app/parser` in a throwaway container of
  `capy-kb-parser:pilot-v8`, with the builder container's env and limits (7 GiB, 4 CPUs,
  1,800 s deadline), the source cap raised to 512 MiB, its own token, port 18097 and
  `RELEASE_SHA` set to v8's `c0a7233a` as a placeholder. Health reported
  `odl-2.5.7-refined-rapidocr-v9+c0a7233a…`. The container was removed afterwards; the
  live parser and the pilot Postgres were not touched.
- **Baseline.** The final v8 gate arm (`v8c`, the committed v8 code, which is live).
- **Sources.** The same 66 documents, 16,924 pages, all parsed; and the four extra books
  of the v8 gate (Conservation Techniques, College Research, Formal Logic, GNU Octave).

## Gate against v8

| | v8 | v9 |
| --- | ---: | ---: |
| outline anchors kept | 4,893 | 4,893 of 4,893 |
| roots | 271 | 278: all 271 kept, plus Music 1 and bookdown 6 chapters now at level 1 |
| heading-release gold witnesses changed | | 2 of 20, both toward the gold |
| scope gold verdicts | | 6 of 6 pass |
| body blocks that lost an outline-confirmed ancestor | | 174, Technology Tools' "Contents" only |
| v8 units missing from v9's chunks | | 10 (7 Animals titles now headings, 3 Precalculus number lines) |
| wrong-path chunks (23 intake books) | 1,575 | 772 |
| documents with more wrong-path chunks | | 0 |
| server parse time, all documents | 2,577 s | 3,020 s (see Timing) |

**The expected changes.**

- *Technology Tools.* Its outline holds only "Contents", so the gate counts the removed
  "Contents" ancestor of 174 body blocks as outline ancestry lost (the investigator's
  simulation: 176). The agents removed it from all of that book's repaired paths.
  Wrong-path chunks 61 → 0.
- *Animals & Ethics 101.* Its chapter labels 2 to 8 ("CHAPTER 3: IN DEFENSE OF ANIMALS:
  SOME MORAL ARGUMENTS"), body text in v8, open their pages and are promoted
  (`chapter-opener`); their text moves from the chunks into the path. Wrong-path chunks
  167 → 81.

**The gold witnesses.** WeasyPrint's "€135" becomes body text (`formula-fragment`), as
its gold case expects ("price in a coloured offer card, not a section heading"). forallx's
"CHAPTER 1" becomes the label of "Arguments", which stays the heading.

**Every other gate change, with its cause.**

- *Precalculus: three exercise-number lines* ("13. 14. 15.", "39. 40.", "67.") leave
  the chunks. Fragments demotes number-only headings ("12. 13.", "67.") elsewhere in the
  book; as body text they now count toward the furniture key, which is frozen after the
  rules, and the copies at a page edge are dropped as repeated furniture. Across the gate
  this drops 18 number-only blocks (15 of them demoted headings; also a deck's "4.0"
  licence fragment on three slides) and restores 87 edge copies of demoted callouts
  ("EXAMPLE 3") whose keys now sit mostly inside pages. No block with a word is lost.
- *New roots.* Music (1) and bookdown (6): backbone puts chapters that the outline lists
  at level 1 at level 1.
- *Other ancestry changes* (41,479 body blocks) are the re-levelling itself: stale ODL
  ancestors dropped (48,978 lost components that are still headings, none
  outline-confirmed outside Technology Tools), demoted fragments and callouts leaving
  paths, and book-title roots gone where chapters are now level 1. The per-document
  profile (anchors, roots, lost outline ancestry, gold, missing text) equals the
  investigator's simulated gate except Technology Tools (176 → 174) and the Precalculus
  lines above.
- *Wrong-path chunks differ from the simulation* only through the v8 baseline: Game
  Theory 24 → 13 (simulated 41 → 30), The Science of Sleep 51 → 32 (49 → 30), ODE 228 → 1
  (236 → 19, v7's font repairs), Media Studies 271 → 264, Liquidity 102 → 102 (103 → 101),
  English Composition 4 → 4 (9 → 9).

## The investigator's replay

`run_final.sh`'s three replays (`replay_levels.py`, `gold_eval.py`, `gold_flips_all.py`)
ran read-only from the investigator's folder through a wrapper that adds production arms:
`v8p` (the working tree's `correct_roles` and `mark_page_numbers`) and `v9p` (then the
three `levels.py` rules). v8's outline headings are inserted and the v9 rules see them, as
in production; the inserted blocks are then dropped, because the replay keeps chunk
starts fixed.

| Arm | Wrong-path chunks (37 books) | Chunks matching the agents (48 books, 30,460 chunks) |
| --- | ---: | ---: |
| investigator's base (v6 roles) | 4,124 | 10,716 |
| investigator's recommended arm | 2,814 | 12,164 |
| v8p (production v8) | 4,060 | 10,715 |
| v8p + fragments | 3,551 | 11,383 |
| v8p + fragments + contents | 3,543 | 11,604 |
| **v9p (production v9)** | **2,744** | **12,165** |

- No book gets worse on the measure. The largest gains: Music 364 → 26, ODE 241 → 22,
  Marine Ecology 458 → 242, Alternatives to Agonism 341 → 172, Basic Analysis II
  121 → 7, Animals 191 → 97, Technology Tools 83 → 0, Learn-It-All 84 → 38, The Science of
  Sleep 54 → 35.
- Per-book flips against the agents' paths, v8p → v9p: 1,779 chunks fixed and 329 made
  worse. The worse ones are the report's known cases, now over a larger gold set:
  Programming Fundamentals 155 (unreviewed paths that keep contents lines) and Java,
  Java, Java 151 (its running heads at y = 0.107, below the banner band, are exposed when
  dingbat headings are demoted; the developer has asked the investigator for a band
  rule), then Learning Statistics with R 10, Basic Analysis II 5, ODE 3 and 1 or 2 in
  four books. The investigator's recommended arm scores the same books the same way.
- The gold set grew since the report (46 → 48 books), so the report's 77 Java
  regressions are 151 here in both arms.

## Composition with v8's outline headings

All seven books where v8 inserts outline headings (College Research, Restorying
Education, Evidence-Based Software Engineering, Game Theory and three "Appendix" books)
have a usable outline with those headings, so backbone leaves them alone. College
Research and Restorying would not without them: v8's inserted chapters are what makes
their outlines usable. A test covers the case.

## Outside the gate: Conservation Techniques

| Book | Wrong-path v8 → v9 | What changed |
| --- | ---: | --- |
| Conservation Techniques | 0 → 0 | chapters at level 1, book-title root gone; **5 chapters nested under the one before** |
| College Research | 67 → 67 | nothing (usable outline) |
| Formal Logic | 304 → 303 | fragments |
| GNU Octave tutorial | 55 → 54 | fragments (usable outline) |

Conservation Techniques has no outline, so backbone runs. ODL merged the part tab with
the chapter title for chapters 8, 9, 11, 12 and 13 ("Habitat-Focused Techniques Chapter 8
- Restoration"). A chapter label must open the heading, so those five are not in the
chain; the book has no numbered sections, so no chapter style is set, and they nest under
chapters 7 and 10 as unnumbered headings. 234 of its 548 chunks get the wrong chapter.
`measure.py` shows 0 → 0 because it has no reference structure for this book, and the
agents have not reviewed it.

Two changes were measured on the fresh v8 outputs of the 64 PDF gate documents and the
four extra books, neither built:

- **B.** Accept a chapter label that follows up to four words of a merged title in the
  same heading. It fixes all five chapters and changes no other block in the 68
  documents.
- **C.** Treat a heading in the chapter chain's ODL style as a chapter sibling even
  without numbered sections. It also fixes them, but moves the five part tabs to chapter
  rank and changes 59 blocks in Animals.

The question, with the recommendation of B, is in the local `questions.md`.

## Timing

v9 took 3,020 s of server parse time against v8's 2,577 s (+17%). The machine was busier
than in the v8 gate: a sample every minute read host CPU at 81% on average (40-100%, 16
logical CPUs) with a median of 10 Python processes (up to 34), because the three replays
above ran during the first 40 minutes beside the backfill workers. The three rules take
0.04 to 0.7 s per document on the largest gate documents (MIT Strang, OpenStax Biology),
so the difference is load. Per document it ranges from −50 s (OpenStax Chemistry) to
+114 s (the OCR-heavy Business Plan Guide).

## Reproduction

Raw outputs, scripts and logs are in the ignored `reports/local/2026-09-24-parser-v9-gate/`:
`v8c/` and `v9/`, `snapshots/parser-a/`, `compare-v8c-v9.json`, `summary-v9.txt`,
`missing-v8c-v9.json`, `load-v9.log`; `fidelity.json` (`fidelity.py`); `measure.json`,
`gold.json` and `flips.json` (`replay_v9.py`); `extras/` with `x8c/`, `x9/` and
`compare-x8c-x9.json`; `options.py` for B and C; `questions.md`.

```sh
GATE=bench/parsers/reports/local/2026-09-24-parser-v9-gate
S=$GATE/scripts
docker run -d --name capy-kb-parser-v9-gate -p 127.0.0.1:18097:8090 \
  --memory 7g --memory-swap 14g --cpus 4 -e PARSER_TOKEN \
  -e CAPY_MAX_SOURCE_BYTES=536870912 [the builder container's other CAPY_* env] \
  --mount type=bind,source=$GATE/snapshots/parser-a,target=/app/parser,readonly \
  capy-kb-parser:pilot-v8
PARSER_TOKEN_V9=... uv run --project pipeline python bench/parsers/scripts/gate_parser_fresh.py \
  parse --manifest $GATE/gate.json --arm v9=http://127.0.0.1:18097 --output $GATE
uv run --project pipeline python bench/parsers/scripts/gate_parser_fresh.py compare \
  --manifest $GATE/gate.json --output $GATE --arms v8c v9 \
  --gold bench/parsers/fixtures/heading-release-gold-2026-09-20.json \
         bench/parsers/fixtures/heading-scope-release-gold-2026-09-20.json \
  --measure-dir data/knowledge-base/opus-intake-2026-09-23/section-paths
export PYTHONDONTWRITEBYTECODE=1
ARMS="base fragments+contents+backbone v8p v8p+fragments v8p+fragments+contents v9p"
uv run --project pipeline python $S/replay_v9.py measure $GATE/measure.json $ARMS
uv run --project pipeline python $S/replay_v9.py gold $GATE/gold.json $ARMS
uv run --project pipeline python $S/replay_v9.py flips $GATE/flips.json v8p v9p
uv run --project pipeline python $S/fidelity.py $GATE/fidelity.json
```
