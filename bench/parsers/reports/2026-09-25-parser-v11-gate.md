# Parser v11 fresh-parse gate

2026-09-25. Gate for parser `odl-2.5.7-refined-rapidocr-v11` (chunker stays v12): the
rules the developer picked from the [heading-rules report](2026-09-25-heading-rules-after-v10.md)
(decisions 2026-09-25), ported as its "What the implementer needs to port" section
describes. No rule has a version gate or a legacy path (decision 2026-09-25).

- **Title narrowing, refined** (`outline_levels.mark_book_titles`). A page with more
  than 150 characters of body text is a body page. Past the first body page, a body
  page keeps the book-title mark only on headings that match a title source.
- **#12 at the outline destination** (`headings.insert_outline_headings`). The first
  block at or below the destination (minus 5) that is neither discarded nor a page
  number is promoted when it is the body line of the entry's title; otherwise the
  heading is inserted before it, or after the page's last block when no block is that
  low. A destination without a height keeps the place before the page's first block.
- **The line option** (same function). That body line also makes the heading without a
  running head, when `outline_levels._entries` keeps the entry and its parent entry
  points to another page. `_entries` is imported inside the function (outline_levels
  imports headings) and built once per document.
- **`band2`, additive** (`_folio_title_larger`; `_family_banners` and `_wide_only`
  return the union of both folio readings).
- **Titled running-head seeds with the quarter clause** (`_additional_banners`). Top
  candidates `y0 < 100`, seeds `y1 <= 100`. A seed below the old 0.065 edge counts only
  when every line repeats a larger body title printed earlier, or its text recurs on
  max(5, a quarter of the) pages.
- **Section-path measure references** from the outline entries `_entries` keeps
  (`data/knowledge-base/opus-intake-2026-09-23/section-paths/measure.py`, ignored by
  git). The measure as the v10 gate ran it is kept as
  `reports/local/2026-09-25-parser-v11-gate/scripts/measure_raw_outline.py`.

**Result: the gate passes with the report's profile, and v11 scores exactly as the
report's recommended set with the line option.** Every outline anchor (4,876) and root
(448) is kept, no gold witness changes, 6 of 6 scope cases pass, and all 522 lost
outline-confirmed ancestors are closed spans, unlisted titles, duplicates or next
sections starting above the block: none is a real loss. Wrong-path chunks go from 627
to 626 on the gate. On the replays, the section-path measure goes from 1,770 to 1,433
and the agents' paths from 19,785 to 21,363 of 34,617 (1,578 fixed, 0 worse). With the
new measure references the section-path measure reads 1,522 → 1,185 and the gate
390 → 389.

## Port fidelity

- **Emulated gate.** The working tree's chain (`correct_roles` to `mark_book_titles`,
  no variant) on the round's fresh v6 parses of the 64 gate PDFs equals the round's
  emulated `all` arm (the recommended set with the line option, `gate-emu/all`) block
  for block: 222,619 blocks, 0 different.
- **Replays.** Run on the working tree, v11 equals the `all` arm (rerun today on the
  committed v10 code) in every book: 37 of 37 on the measure under both reference
  forms, 48 of 48 on the agents' paths.
- **Fresh parse.** What changes from v10b to v11 on the gate matches what changes from
  the emulated v10 to `all`, class by class and document by document (book-title
  marks, promotions, inserted headings, new banners, level changes). The one
  difference is 12 Biology paragraph heads ("4.1 • Studying Cells 101") that the real
  v10b already removed and the emulated baseline did not. v11's Biology banners equal
  the emulation's: 2,142.

## Setup

- **Candidate.** A snapshot of the working tree's `parser/` (`snapshots/parser-v11`,
  the 32 tracked files) mounted read-only over `/app/parser` in a throwaway container
  of the builder's image `capy-kb-parser:pilot-v10`, with the builder container's env
  and limits (7 GiB, swap 14 GiB, 4 CPUs, 1,800 s deadline), the source cap raised to
  512 MiB, its own token, port 18098 and `RELEASE_SHA` set to `ebf5c584` as a
  placeholder. `/healthz` reported `odl-2.5.7-refined-rapidocr-v11`. The container and
  its token were removed afterwards. The live builder parser (stopped), the pilot
  Postgres, the library and the ingest host were not touched.
- **Baseline.** The final v10 gate arm (`v10b`, copied from the v10 gate folder).
- **Sources.** The same 66 documents, 16,924 pages, all parsed; and the four extra
  books.

## Gate against v10

| | v10b | v11 | the report (emulated, set + line option) |
| --- | ---: | ---: | ---: |
| outline anchors kept | 4,876 | 4,876 of 4,876 | kept |
| roots | 448 | 448, all kept | kept |
| gold witnesses changed | | 0 of 26 | 0 |
| scope gold verdicts | | 6 of 6 pass | 6 of 6 |
| body blocks that lost an outline-confirmed ancestor | | 522: 350 closed, 115 unlisted, 31 duplicates, 26 open | 522: the same classes |
| … open losses that are real (`open_check.py`) | | 0 (26 next sections starting above the block) | 0 |
| v10b units missing from v11's chunks | | 155 removed banners, 95 other | 167 banners, 95 other |
| wrong-path chunks, v10 references (23 intake books) | 627 | 626 | 642 → 641 |
| wrong-path chunks, `_entries` references | 390 | 389 | |
| documents with more wrong-path chunks | | 0 | |
| server parse time, all documents | 2,452 s | 2,550 s (see Timing) | |

The report's gate numbers were taken against an emulated v10 (`v10e`), which is why its
wrong-path baseline is 642 and not 627.

**Every change, with its cause** (16 of 66 documents change).

- *Title narrowing.* Census Income 2024 loses 9 marks and NIST FIPS 203 1 (its page-4
  publication line), the report's 9 and 1. Census's 26 body blocks regain 37 path
  components on pages 4-8 and NIST's 2 regain 2. No anchor, root or witness moves.
- *#12.* 157 outline headings in 14 documents: 129 promoted title lines and 28
  inserted, the report's 129 and 28 (v10 had 2, English Composition and Game Theory,
  which stay). OECD 46 promotions, Chemistry 18, Introductory Statistics 15, Astronomy
  11, Biology 10, Physics 9. Of the 28 inserted, 2 open their page (v10's two), 5 sit
  inside it, and 21 follow the page's last block, because that block starts above the
  destination and nothing starts below it (Microeconomics 10, Psychology 8,
  Introductory Statistics 3; 18 of those blocks are lists, 2 images, 1 a table). OECD's
  promotions also move 91 heading and 200 banner boundary levels through the outline
  levels.
- *`band2`.* 828 new banners in 9 documents, all OpenStax "N • Title NNN" heads: Physics
  113, Introductory Statistics 179, Chemistry 107, Biology 106, Astronomy 94,
  Computer Science 71, Psychology 55, Precalculus 55, Microeconomics 48. None is lost.
- *Running-head seeds.* Liquidity's "Preface" head (3 blocks): 4 body blocks lose it,
  wrong-path chunks 84 → 83. Nothing else changes on the gate, as the report measured.
- *Lost outline-confirmed ancestors.* 350 closed spans (the next section's new heading
  ends the span, Biology's "11.2 Sexual Reproduction" before its Key Terms), 115
  unlisted, 31 duplicates. The 26 open ones (Physics 13, Astronomy 13) are the new
  "Chapter Review" or "Summary" heading at the top of the page where the outline
  points, where v10 had held "Key Equations" or "Key Terms" over the page.
- *Missing units.* The 155 are removed banners. The 95 others are 73 promoted title
  lines ("Key Equations", "Box 1 …", "Definitions", "Media Attributions"), which move
  from chunk text to the path, and 22 banners whose box an inserted heading shares
  (the compare looks blocks up by box). The report's 167 banners include the 12
  Biology heads v10b already removed.

**The extra books.** College Research's 90 outline headings keep their levels; 79 now
follow the page's discarded running head instead of preceding it, and no path changes
(65 → 65 wrong-path chunks). Conservation Techniques, Formal Logic (115) and the GNU
Octave tutorial (38) are unchanged.

## The measure's references

The measure now builds its references from `_entries(doc)` (level, title, page,
destination height) instead of the raw outline. Message Processing's re-levelling of
its outline stays. What moves:

| | v10 references | `_entries` references |
| --- | ---: | ---: |
| measure (37 books), v10 → v11 | 1,770 → 1,433 | 1,522 → 1,185 |
| Media Studies | 260 | 13 |
| Fundamental Methods of Logic | 6 | 5 |
| gate wrong-path chunks, v10b → v11 | 627 → 626 | 390 → 389 |
| Media Studies on the gate | 250 | 13 |

Media Studies is the author-tag case the decision names. Fundamental Methods of Logic's
one chunk comes from `_entries`' wrapper rule: its "Table of Contents" bookmark has
children, so they move up a level. No other book moves.

## The investigator's replay

The round's `score.py` and `measure_x.py`, imported read-only through
`scripts/replay_v11.py`. v11 runs on the working tree; v10 and `all` run on
`snapshots/parser-v10` (a `git archive` of `ebf5c584`). Frozen gold
`gold-2026-09-25.json`, content mapping.

| Arm | Measure, v10 refs | Measure, `_entries` refs | Title components | Agents' paths (34,617 scored) | Fixed / worse vs v10 | Unreviewed (953) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| v10 | 1,770 | 1,522 | 97 | 19,785 | | 655 |
| `all` (the report's set + line option) | 1,433 | 1,185 | 104 | 21,363 | 1,578 / 0 | 649 |
| **v11** | **1,433** | **1,185** | **104** | **21,363** | **1,578 / 0** | **649** |

- Agents' paths by book: Accounting Principles 416 → 1,293, Papuan Malay 744 → 1,173,
  the Unicode Cookbook 106 → 258, The Impact of Open Source Software +38, Business
  Ethics +26, Business Processes +18, Concepts of Biology +17, Educational Psychology
  +14, Physics +5, Liquidity +2.
- Measure: only ReStorying Education moves, 402 → 65. Its 7 extra title components are
  the subtitle the narrowing unmarks, as the report said.
- Unreviewed: Programming Fundamentals 649 → 643, the 6 chunks whose gold lacks a listed
  subsection or is broken (the report's 6).

## Tests

- New, next to the existing ODL tests: the three title-narrowing tests
  (`test_odl_outline_levels.py`: Census/ReStorying reprinted title, Papuan Malay
  repeated title page, NIST FIPS 203 title page with body text), and in
  `test_odl_role_recovery.py` the destination placement (promoted line, insert at the
  height, named destination), the line option (ReStorying chapter promoted, Media
  Studies tag and a same-page byline refused), `band2` (Chapter Review, Media Studies
  101) and the seeds (Papuan Malay, "Example", a licence line on a quarter of the
  pages).
- Changed: ReStorying's "INTRODUCTION" is no longer marked; College Research's inserted
  heading now follows the running head; the #12 level test finds the heading by role.
- Each new test fails on the v10 code or on the rejected variant it guards (the worded
  and inclusive narrowing, the line option without its guards, the naive `band2`,
  seeds without the title test).
- `pnpm run test:pipeline:offline`: ODL tests 188 passed. The full offline suite on this
  Windows machine: 837 passed, 4 failed outside the parser (a Windows console for
  prompt_toolkit, a path separator, an encoding, a model registry default), with five
  modules that import `fcntl` and `test_parser_app.py` (its child-process tests hang on
  Windows) left out.

## Timing

v11 took 2,550 s of server parse time against v10b's 2,452 s (+4%); the extras 113 s
against 114 s. A sample every minute read host CPU at 62% on average (28-91%, 16 logical
CPUs) with a median of 5 Python processes (up to 18): the two replay chains, the
fidelity check and the pipeline test runs ran beside the parse. The v10 gate ran at 55%
with a median of 2. The new rules run inside `correct_roles`; the difference is load.

## Deployment

The developer approved the commit and the deploy. v11 is committed as `ab1a39fd` (not
pushed). The builder parser was swapped: the new `capy-kb-parser-v4-pilot` container is
created from `capy-kb-parser:pilot-v11` and left stopped, and v10 is kept as
`capy-kb-parser-v10-e46eea6a-backup`. `CHUNKER_VERSION` stays `v12`. As with v10, the
parser identity changes, so donor reuse starts again for PDFs; published books keep
their chunks. ReStorying Education's re-parse stays held (decision 2026-09-25).

## Reproduction

Raw outputs, scripts and logs are in the ignored
`reports/local/2026-09-25-parser-v11-gate/`: `v10b/` (copied), `v11/`, `extras/`
(`x10b/`, `x11/`), `snapshots/parser-v10/` and `parser-v11/`, `compare-v10b-v11.json`,
`summary-v11.txt`, `lost-v11.log`, `open-v11.log`, `measure-both.json`,
`roles-v10b-v11.json`, `roles-emu-v10-all.json`, `fidelity-emu.json`, `load-v11.log`,
`replay/` (`measure-*`, `gold-*`).

```sh
GATE=bench/parsers/reports/local/2026-09-25-parser-v11-gate
S=$GATE/scripts
V10=bench/parsers/reports/local/2026-09-24-parser-v10-gate
H=bench/parsers/reports/local/2026-09-25-heading-rules/scripts
docker run -d --name capy-kb-parser-v11-gate -p 127.0.0.1:18098:8090 \
  --memory 7g --memory-swap 14g --cpus 4 -e PARSER_TOKEN \
  -e CAPY_MAX_SOURCE_BYTES=536870912 [the builder container's other CAPY_* env] \
  --mount type=bind,source=$GATE/snapshots/parser-v11,target=/app/parser,readonly \
  capy-kb-parser:pilot-v10
PARSER_TOKEN_V11=... uv run --project pipeline python bench/parsers/scripts/gate_parser_fresh.py \
  parse --manifest $GATE/gate.json --arm v11=http://127.0.0.1:18098 --output $GATE
uv run --project pipeline python bench/parsers/scripts/gate_parser_fresh.py compare \
  --manifest $GATE/gate.json --output $GATE --arms v10b v11 \
  --gold bench/parsers/fixtures/heading-release-gold-2026-09-20.json \
         bench/parsers/fixtures/heading-scope-release-gold-2026-09-20.json \
  --measure-dir data/knowledge-base/opus-intake-2026-09-23/section-paths
uv run --project pipeline python $V10/scripts/gate_summary.py $GATE/compare-v10b-v11.json
uv run --project pipeline python $V10/scripts/classify_lost.py $GATE v10b v11 --examples 3
uv run --project pipeline python $H/open_check.py $GATE v10b v11
uv run --project pipeline python $S/measure_both.py $GATE $GATE/measure-both.json v10b v11
uv run --project pipeline python $S/role_changes.py $GATE v10b v11
uv run --project pipeline python $S/fidelity_emu.py $GATE/fidelity-emu.json
export PYTHONDONTWRITEBYTECODE=1
uv run --project pipeline python $S/replay_v11.py v11 raw measure $GATE/replay/measure-v11-raw.json v11
uv run --project pipeline python $S/replay_v11.py v11 entries measure $GATE/replay/measure-v11-entries.json v11
uv run --project pipeline python $S/replay_v11.py v11 raw gold $GATE/replay/gold-v11.json v11
uv run --project pipeline python $S/replay_v11.py v10 raw measure $GATE/replay/measure-v10-raw.json v10 all
uv run --project pipeline python $S/replay_v11.py v10 entries measure $GATE/replay/measure-v10-entries.json v10 all
uv run --project pipeline python $S/replay_v11.py v10 raw gold $GATE/replay/gold-v10.json v10 all
```
