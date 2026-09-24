# Parser v7 fresh-parse gate

2026-09-24. Gate for parser `odl-2.5.7-refined-rapidocr-v7`, the gated parts of arm A
from the [ODL thin-image report](2026-09-23-odl-thin-images-and-accuracy.md) (decision
2026-09-24):

- table rows nested in list items and table cells (`adapter.node_text`);
- three pre-Java font repairs in `fonts.repair_fonts`: `ToUnicode` entries that
  contradict their glyph names, `negationslash` mapped to U+0338, and wide ranges split
  at byte boundaries;
- slash-and-relation composition after table recovery (`fonts.compose_negations`);
- the picture stage's sliver and repeat rules (`pictures.classify`).

Not in v7: the formula-picture rule, `[formula]` placeholders, `--content-safety-off
tiny` and the stencil-mask rewrite.

**Result: v7 meets arm A's bar.** It keeps every outline anchor, root and gold
witness, loses no heading ancestor, and loses no text apart from ODE's corrected
formula lines. Game Theory gains the one wrong-path chunk already accepted for arm A.
Its body text equals arm A's on all 66 documents once arm A's placeholders are
removed.

## Setup

- **Candidate.** The working tree's `parser/` (v7), mounted read-only over
  `/app/parser` in a throwaway container of `capy-kb-parser:pilot-v6`, as arm A ran.
  `requirements.txt` and the Dockerfile are unchanged since that image. The candidate
  used the builder container's env and limits (7 GiB, 4 CPUs, 1,800 s deadline), the
  source cap raised to 512 MiB for chemistry and biology, its own token, port 18096,
  and `RELEASE_SHA` set to HEAD `0d36a750` as a placeholder. Health reported
  `odl-2.5.7-refined-rapidocr-v7+0d36a750…`. The container was removed afterwards. The
  live builder container and the pilot Postgres were not touched.
- **Baseline.** The `v6afresh` arm of the 2026-09-23 gate (today's committed v6 code).
  Arm A's outputs are compared as well.
- **Sources.** The same 66 documents, 16,924 pages. All 66 parsed; none failed.
- **Eight books outside the gate** (Euclidean, Brief Calculus, EE I, Java, Online
  Statistics, First Course in ECE, Moloko, Educational Psychology) ran through
  `refine.parse_pdf` in a second throwaway container of the same image. They are
  compared with the investigator's runs of v6 code and arm A.
- **mPDF glyphs.** The ODL jar ran with `--replace-invalid-chars ¤` on each mPDF book
  and on its `repair_fonts` copy.

## Gate against the v6 baseline

| | Baseline | Arm A | v7 |
| --- | ---: | ---: | ---: |
| documents, pages | 66, 16,924 | 66, 16,924 | 66, 16,924 |
| outline anchors kept | 4,889 of 4,889 | 4,889 of 4,889 | 4,889 of 4,889 |
| roots | 270 | 270 | 270 |
| gold witnesses changed | | 0 of 26 | 0 of 26 |
| scope gold verdicts | | 6 of 6 pass | 6 of 6 pass |
| body blocks that lost a heading ancestor | | 0 | 0 |
| baseline units missing from the candidate's chunks | | 1,486 | 1,479 |
| of which real losses | | 17 | 17 |
| wrong-path chunks | 1,610 | 1,603 | 1,603 |
| documents with more wrong-path chunks | | 1 (Game Theory, 42 → 43) | 1 (Game Theory, 42 → 43) |
| server parse time, all documents | 2,289 s | 2,495 s | 2,284 s |

- **Missing units.** Of the 1,479, 1,449 are kept or changed in place
  (`retention_check.py`), and 13 have no letter or digit. The 17 real losses are ODE
  lines whose garbled symbols were corrected. They are the same units arm A lost, and
  v7's ODE text equals arm A's.
- **Ancestry.** The same 7,226 body blocks show a changed ancestor as in arm A, in the
  same three books: the Business Plan Guide (5,764) and the Entrepreneurship Toolkit
  (778), whose headings got their dashes back, and ODE (684). No lost component is
  still a heading.
- **Game Theory.** The same pre-existing wrong path as arm A: its payoff matrices came
  back and the packer split that section into three chunks instead of two.

## Where v7 differs from arm A

- **No formula retyping.** Arm A's 207 formula pictures stay image blocks, and no text
  carries `[formula]`. That is the whole difference in the gate set.
  - The 7 fewer missing units are the paragraphs arm A spliced placeholders into: ACL
    1, BOJ 1, LibreOffice 3 and introductory statistics 2.
  - Arm A's display placeholders added one chunk each to introductory statistics,
    computer science and chemistry; v7 has the baseline's chunk counts there.
- **Body text.** Characters were compared as multisets, placeholders removed and
  whitespace ignored. v7 equals arm A on all 66 documents: 7,011 characters added and
  1,771 removed against the baseline.
- **Repeated pictures.** v7 makes every picture repeated on 5 or more pages furniture.
  Arm A kept a glyph-sized repeat among varied words as a formula; that exception
  belonged to the formula rule, which v7 does not take. The gate set does not show
  the difference: both arms discard the same 466 pictures. Brief Calculus does. There,
  592 of arm A's formula pictures (591 inline, 1 display) are `discarded` in v7, not
  `equation`. Neither has a caption, and both kinds are skipped by the chunker and the
  figure stage, so chunk text and figure records match arm A. When the formula rule
  lands, it must run before the repeat rule, as it did in arm A.

## Measured effects

| Effect | v6 | v7 |
| --- | ---: | ---: |
| Euclidean image blocks | 1,196 | 1 |
| Euclidean ≠ / ∉ / ∌ / ≢ | 0 / 0 / 0 / 0 | 99 / 3 / 3 / 3 |
| ODE NULs in parser text | 633 | 0 |
| ODE − / ∈ / ≠ | 0 / 0 / 0 | 592 / 166 / 12 |
| Online Statistics NULs | 242 | 0 |
| Game Theory list items carrying table rows | 0 | 28 |
| Game Theory minus signs | 357 | 414 |
| Entrepreneurship Toolkit unmapped glyphs (jar) | 1,325 | 0 (ﬁ 505, – 168, ’ 127) |
| Business Plan Guide unmapped glyphs (jar) | 345 | 0 (– 113, ’ 76) |
| Gate image blocks | 10,120 | 9,653, with 466 repeats `discarded` and 1 sliver dropped |
| Java, Java, Java image blocks | 712 | 104, with 559 repeats `discarded` and 49 slivers dropped |
| Brief Calculus image blocks | 2,397 | 1,552, with 843 repeats `discarded` and 2 slivers dropped |
| EE I image blocks | 1,364 | 1,191, with 172 repeats `discarded` and 1 sliver dropped |

- **Game Theory.** Table 1.2.5 now reads "(100,−100) | (−10,10)" inside its list item.
  The book gains 680 characters and 4 composed ≠.
- **Composition elsewhere in the gate.** 3 ≰ in DMOI and 1 ≠ in Lille, as in arm A.
- **Euclidean.** One U+0338 stays uncomposed. The report's other 22 ∉ print as "∈"
  plus a separate "/" glyph, which v7 does not touch.
- **No change** in First Course in ECE or Moloko; their gains need the tiny-text flag,
  which stays on.

## Reproduction

Raw outputs are in the ignored `reports/local/2026-09-24-parser-v7-gate/`:

- `v7/`, with copies of `v6afresh/`, `candA/` and `gate.json` from the
  2026-09-23 gate;
- `compare-v6afresh-v7.json` and `compare-v7.log`;
- `summary-v7.txt`, `retention-v7.log`, `effects-v7.json`;
- `refine-v7/` and `extras-v7.log` for the eight books;
- `marker.log` for the mPDF books.

```sh
GATE=bench/parsers/reports/local/2026-09-24-parser-v7-gate
OLD=bench/parsers/reports/local/2026-09-23-odl-thin-images-gate
docker run -d --name capy-kb-parser-v7-gate -p 127.0.0.1:18096:8090 \
  --memory 7g --memory-swap 14g --cpus 4 -e PARSER_TOKEN \
  -e CAPY_MAX_SOURCE_BYTES=536870912 [the builder container's other CAPY_* env] \
  --mount type=bind,source=$PWD/parser,target=/app/parser,readonly \
  capy-kb-parser:pilot-v6
PARSER_TOKEN_V7=... uv run python bench/parsers/scripts/gate_parser_fresh.py parse \
  --manifest $GATE/gate.json --arm v7=http://127.0.0.1:18096 --output $GATE
uv run python bench/parsers/scripts/gate_parser_fresh.py compare \
  --manifest $GATE/gate.json --output $GATE --arms v6afresh v7 \
  --gold bench/parsers/fixtures/heading-release-gold-2026-09-20.json \
         bench/parsers/fixtures/heading-scope-release-gold-2026-09-20.json \
  --measure-dir data/knowledge-base/opus-intake-2026-09-23/section-paths
python $OLD/scripts/gate_summary.py $GATE/compare-v6afresh-v7.json
uv run python $OLD/scripts/retention_check.py $GATE v6afresh v7
python $GATE/v7_effects.py $GATE $GATE/effects-v7.json
uv run python $GATE/marker_run.py $GATE/marker JAR name=PDF ...
```
