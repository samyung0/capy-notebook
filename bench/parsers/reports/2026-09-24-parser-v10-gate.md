# Parser v10 fresh-parse gate

2026-09-24. Gate for parser `odl-2.5.7-refined-rapidocr-v10` and chunker v12: the three
rules of the [outline-levels report](2026-09-24-outline-levels-and-running-heads.md),
ported as its "What the implementer needs to port" section describes (decisions
2026-09-24):

- **Outline levels** (`parser/odl/outline_levels.py`, `relevel`): the prototype's `olga`
  in its `ancestors2` mode. One test picks the rule per book: a usable outline that
  `broken` does not veto takes outline levels, and every other book takes v9's
  `backbone_levels`, which no longer checks the outline itself.
- **Running-head band** (`parser/odl/headings.py`): the banner family scan and v8's
  margin paragraphs use the top and bottom fifth of the page. A banner found only
  through the wider band must cover 5 pages and a tenth of the book. The larger-folio
  variant (`band2`) is not included.
- **Book-title headings** (`outline_levels.mark_book_titles`): title-page headings get
  `_source_role: book-title` and keep their level. The title pages run from the first
  page to the last of the first ten that carries the book title. The shared chunker
  (`chunk_content_list`, and `pack_blocks` for table stacks) closes the heading stack at
  that level without pushing the heading, and keeps its text in the chunk;
  `CHUNKER_VERSION` is `v12`. The gate's `stacks()` applies the same rule and leaves
  book-title headings out of anchors and roots.

`relevel` and `mark_book_titles` run in `refine.parse_pdf` where `backbone_levels` ran,
after `demote_fragments` and `demote_contents_lines` and before furniture is frozen.

The first build (`d52e2963`) also ended the title pages before the first page with more
than 150 characters of body text. After its gate the developer dropped that stop
(decision 2026-09-24) and accepted its two false positives. This report gates the final
build, without the stop; "The dropped stop" below records the first build.

**Result: the gate passes with the investigator's profile, and v10 is better than v9 on
every replay.** Every outline anchor and root is kept once book-title headings are left
out (17 anchors and 14 roots, as the investigator measured); the 20 witnesses that change
are the ones the investigator's all-rules arm changes; 6 of 6 scope cases pass; the only
missing body units are the 82 banners the band removes; all 796 lost outline-confirmed
ancestors are duplicates, closed spans or unlisted titles, none a real loss. Wrong-path
chunks fall from 772 to 627 on the gate and from 2,744 to 1,528 on the section-path
measure, and the agents' paths go from 12,328 to 19,138 matching chunks (6,830 fixed, 20
worse). One side effect on the gate: Census Income 2024 prints its title again on its
introduction page, so that page's section headings are marked with it.

## Port fidelity

The port and the prototype (`newrules.py`, imported read-only) were applied to the same
blocks for 194 inputs: the 64 PDF gate documents and the four extra books as fresh v9
outputs, and 126 library books' saved parses after the working tree's role rules,
`demote_fragments` and `demote_contents_lines`. On all 194:

- `_listing` equals `listing` (usable, vetoed and matched entries alike);
- `_plan` equals `olg_plan(..., "ancestors2")` in levels and boundaries (154 inputs take
  outline levels, 40 the backbone);
- `mark_book_titles` marks exactly the prototype's `title_roots`: 300 headings in 138
  inputs.

`relevel` takes up to 0.45 s and `mark_book_titles` up to 0.32 s per document (OpenStax
Biology).

## Setup

- **Candidate.** A snapshot of the working tree's `parser/` (`snapshots/parser-b`)
  mounted read-only over `/app/parser` in a throwaway container of the first-build image
  `capy-kb-parser:pilot-v10`, with the builder container's env and limits (7 GiB, 4 CPUs,
  1,800 s deadline), the source cap raised to 512 MiB, its own token, port 18097 and
  `RELEASE_SHA` set to the first build's `d52e2963` as a placeholder. The container and
  its token were removed afterwards; the live parser and the pilot Postgres were not
  touched. The first build was gated the same way (`snapshots/parser-a`, arm `v10`).
- **Baseline.** The final v9 gate arm (`v9b`, the committed v9).
- **Sources.** The same 66 documents, 16,924 pages, all parsed; and the four extra books.

## Gate against v9

| | v9 | v10 |
| --- | ---: | ---: |
| outline anchors kept | 4,876 | 4,876 of 4,876 (17 book-title anchors left out) |
| roots | 264 | 448: all 264 kept (14 v9 roots are book titles and left out) |
| gold witnesses changed | | 20 of 26, the same 20 as the investigator's arm |
| scope gold verdicts | | 6 of 6 pass |
| body blocks that lost an outline-confirmed ancestor | | 796: 577 duplicates, 208 closed spans, 11 unlisted, 0 open |
| v9 units missing from v10's chunks | | 82, all removed banners or folios |
| body blocks that lost a book-title component | | 15,653 |
| wrong-path chunks (23 intake books) | 772 | 627 |
| documents with more wrong-path chunks | | 0 |
| server parse time, all documents | 2,354 s | 2,452 s (see Timing) |

The investigator's all-rules arm (band, #12, `olga2`, title drop, on a simulated v9)
showed 17 anchors and 14 roots removed as titles, 800 lost outline-confirmed ancestors,
85 missing banner units, the same 20 witnesses and 810 → 643 wrong-path chunks.

**Every change, with its cause.**

- *Running-head band.* 252 new banners in 5 documents: bookdown 102, QMUL Probability 61,
  NIST AI RMF 42, scope-latex-author 27, ctan-axessibility 20 (running heads in QMUL and
  bookdown, page numbers in the others). They account for the 82 missing units; no
  witness changes because of them.
- *Outline levels.* 11,283 heading levels change in 35 documents. The lost
  outline-confirmed ancestors are classified as in the investigator's `lost_outline.py`:
  577 duplicates (the same title is still in the path: INSEE 293, Private Pilot 278),
  208 closed spans (the outline ends the heading's span before the body block: OpenStax
  Microeconomics 154), 11 unlisted titles (Healthcare 7, R intro 3, WeasyPrint 1), and
  no heading popped inside its own span. 184 new roots are chapters the outline lists at
  its top level.
- *Book titles.* 94 headings in 40 documents are marked: titles, subtitles, authors,
  series and publisher lines ("Classroom Companion: Business"), and the headings beside
  a repeated title. 15,653 body blocks lose that component from their path; the 17
  anchors and 14 roots above are those headings: titles the outline lists, plus
  Technology Tools' "Contents".
- *Census Income 2024.* The report prints its title again at the top of its introduction
  page (page 7), so that page's "INTRODUCTION", "Highlights" and "HOUSEHOLD INCOME BY
  SELECTED CHARACTERISTICS" are marked with it, as are the front-matter headings between
  ("Acknowledgments", "Suggested Citation", "Contents TEXT"). All 507 of its body blocks
  lose those components (958 in all). The gate has no wrong-path reference for it, and
  its one outline anchor is kept. This is the class of ReStorying's accepted
  "INTRODUCTION", on a larger scale.
- *Witnesses.* 18 lose the document's title root ("Report example", "LATEX for authors
  current version", "Lua 5.0 Reference Manual", "An Introduction to R", "forallx"),
  mostly because outline levels close it at the first top-level entry; WeasyPrint 17 also
  loses "Table of contents", and OECD 16 loses "Executive summary" as the parent of
  Part A. In OECD 14 only the level changes: "Part A" moves from 2 to 1. They are the
  investigator's 20, moving to the settled path form.

**The extra books.** Conservation Techniques is unchanged (no outline; the backbone gives
the same levels). College Research 67 → 65 wrong-path chunks (its title pages), Formal
Logic 303 → 115 and the GNU Octave tutorial 54 → 38 (outline levels; its 16 lost
outline-confirmed ancestors are all closed spans, "1.3.1" no longer under "1.2").

## The investigator's replay

`replay_levels.py` (the section-path measure) and the agents' paths ran read-only from the
investigator's folder through a wrapper that adds production arms. v9 code comes from a
`git archive` of the v9 commit; v10 code is the working tree. v8's inserted outline
headings are dropped after the rules, because the replay keeps chunk starts fixed. A
book-title heading is replayed as a banner boundary at its level, which is the chunker's
rule for paths.

The agents' paths are scored in two parts. **Scored:** 47 books, 32,668 chunks at the
first run. **Unreviewed, reported apart:** Programming Fundamentals (947 chunks, 3
repairs) and the Physics chunks without a `section_path` correction (6 of its gold
chunks; the Physics backfill has corrected the rest).

| Arm | Wrong-path (37 books, 11,658 chunks) | Title components | Agents' paths (scored) | Fixed / worse vs v9p |
| --- | ---: | ---: | ---: | ---: |
| v9p (production v9) | 2,744 | 1,224 | 12,328 | |
| v9p + band | 2,744 | 1,224 | 13,016 | 689 / 1 |
| v9p + outline levels | 2,059 | 839 | 18,219 | 5,952 / 61 |
| **v10p (production v10)** | **1,528** | **99** | **19,138** | **6,830 / 20** |
| investigator's arm (band, #12, `olga2`, titles) | 1,804 | 99 | 19,147 | 6,839 / 20 |

- No book gets worse on the measure in any arm. The largest gains: ReStorying 617 → 90,
  the Unicode Cookbook 311 → 1, Formal Logic 302 → 112, Private Pilot 163 → 83, GNU
  Octave 87 → 57, Healthcare 31 → 5.
- The band alone fixes Java 512 and Compressible Flow 167 (the Java regressions of the
  v9 gate), and Learning Statistics with R 10; its 1 worse chunk is in Java.
- Outline levels alone make 61 Compressible Flow chunks worse: its outline is vetoed,
  so the backbone now runs there. With the band, v10p fixes 415 of its chunks and makes
  6 worse.
- v10p's 20 worse: Compressible Flow 6, Message Processing 5 (chunks under the accepted
  "MESSAGE PROCESSING"), Liquidity 3 (title-page chunks whose accepted path is its
  series line), Java 2, and 1 each in Basic Analysis, Concepts of Biology, Formal Logic
  and Technology Tools ("Contents").
- **Rerun on the final build.** The measure gives 1,528 again. The gold had grown in the
  three books being backfilled (Java +127, Open Logic +351, Physics +226 chunks), so the
  agents' paths read 19,388 of 33,372 against v9p's 12,426 (6,982 fixed, the same 20
  worse). On the 45 books whose gold did not change, the final build scores exactly as
  the first run's no-stop arm.
- **Unreviewed gold.** Programming Fundamentals: v9p 777 → v10p 653 of 947, 6 fixed and
  130 worse, all from outline levels and the same in the investigator's arm (its paths
  are numerically impossible, "1.1 › 1.1.2 › 1.2.3.3"). Physics' 6: 6 → 6. Both stay as
  they are (decision 2026-09-24), as do one-page documents, which lose their only heading
  from the path (w3c-complex-table's "Example table", lille-probability's "TD1 -
  Evénements et tribus").

## The dropped stop

The first build ended the title pages before the first page with more than 150
characters of body text. It marked 192 headings in 114 of the fidelity inputs instead
of 300 in 138, and 56 in 29 gate documents instead of 94 in 40. It removed two false
positives: Message Processing's "MESSAGE PROCESSING" on page 7 (5 chunks) and
ReStorying's "INTRODUCTION". It also kept ReStorying's title as the root of the book,
because the title is printed again on the introduction page (1,897 characters of body
text) after the licence page (656 characters). The first build measured:

| | first build (stop) | final (no stop) |
| --- | ---: | ---: |
| wrong-path chunks, measure | 2,056 | 1,528 |
| ReStorying on the measure | 617 | 90 |
| agents' paths, fixed / worse vs v9p | 6,823 / 13 | 6,830 / 20 |
| gate wrong-path chunks | 629 | 627 |
| gate anchors / roots left out as titles | 11 / 8 | 17 / 14 |

The final build's gate outputs differ from the first build's only in `_source_role` on
38 headings in 17 documents. A variant that skipped body pages without ending the title
pages was also measured (2,056 on the measure) and not built.

## Chunker v12

`CHUNKER_VERSION` is part of `rag_contents.pipeline_identity`
(`plan-v{version}:{route}:{parser implementation}:{CHUNKER_VERSION}`, and
`plan-v{version}:{direct route}:{CHUNKER_VERSION}` for text, tabular, image and audio).
What the bump triggers:

- **Existing app materials keep their chunks.** Nothing re-chunks automatically, and
  workspace shares copy the existing `rag_contents` rows with their old identity.
- **Donor reuse starts again.** A donor is a ready `rag_contents` row with the same
  `(source_sha256, pipeline_identity)`; none matches the new identity. The first ingest
  of any source after the deploy runs the full pipeline (parse, chunk, embed, summary),
  and later copies reuse it. The parser bump to v10 already does this for PDFs; the
  chunker bump also does it for the direct routes, so a re-uploaded image is captioned
  again and audio transcribed again once.
- **A re-ingested material** (a new source revision) re-parses under v10 and chunks under
  v12, and its paths lose the book-title headings.
- **Knowledge library.** Each book version records `chunker_version`; published books
  keep their chunks. `knowledge_base_pilot.py` refuses to reuse a run directory whose
  cached corpus has another chunker version or release SHA, which the parser swap already
  requires.
- **Retrieval fixtures.** `bench/rag/fixtures` label `(file, chunk_idx)`; a re-chunk moves
  indices where a book title was a heading that flushed a chunk. Per `bench/README.md`
  they are relabelled after a re-chunk.
- No test pins the version string. The chunking tests pass, including a new one for
  both entrypoints (a book title between contents and chapter 1 closes "Contents", stays
  out of the path and keeps its text).

## Timing

The final build took 2,452 s of server parse time against v9's 2,354 s (+4%). A sample
every minute read host CPU at 55% on average (20-79%, 16 logical CPUs) with a median of 2
Python processes (up to 9), beside the backfill workers and, in its first 8 minutes, the
two replays run one after the other; the v9 gate ran at 59% with a median of 2. The first
build took 2,406 s at 61%. The two new stages take under 0.5 s each on the largest
documents, so the differences are load.

## Deployment

After this commit `capy-kb-parser:pilot-v10` is rebuilt from a clean export of the commit
with its SHA and swapped in when the live parser is idle: the first-build container is
kept stopped as `capy-kb-parser-v10-backup` (v9 stays stopped as
`capy-kb-parser-v9-backup`), and the new container reuses its name, env, port, limits and
spool bind. `/healthz` then reports `odl-2.5.7-refined-rapidocr-v10` plus the release
SHA.

## Reproduction

Raw outputs, scripts and logs are in the ignored
`reports/local/2026-09-24-parser-v10-gate/`: `v9b/`, `v10/` (first build) and `v10b/`
(final), `snapshots/parser-a/` and `parser-b/`, `compare-v9b-v10.json`,
`compare-v9b-v10b.json`, `summary-v10.txt`, `summary-v10b.txt`, `lost-v10.log`,
`lost-v10b.log`, `load-v10.log`, `load-v10b.log`; `fidelity.json` (first build) and
`fidelity-b.json` (`fidelity.py`); `measure.json`, `gold.json` (first build, all arms) and
`measure-b.json`, `gold-b.json` (final) from `replay_v10.py`; the stop variants' gate arms
`v10nostop/` and `v10skip/`; `extras/` with `x9b/`, `x10/`, `x10b/` and their compares.

```sh
GATE=bench/parsers/reports/local/2026-09-24-parser-v10-gate
S=$GATE/scripts
docker run -d --name capy-kb-parser-v10-gate -p 127.0.0.1:18097:8090 \
  --memory 7g --memory-swap 14g --cpus 4 -e PARSER_TOKEN \
  -e CAPY_MAX_SOURCE_BYTES=536870912 [the builder container's other CAPY_* env] \
  --mount type=bind,source=$GATE/snapshots/parser-b,target=/app/parser,readonly \
  capy-kb-parser:pilot-v10
PARSER_TOKEN_V10B=... uv run --project pipeline python bench/parsers/scripts/gate_parser_fresh.py \
  parse --manifest $GATE/gate.json --arm v10b=http://127.0.0.1:18097 --output $GATE
uv run --project pipeline python bench/parsers/scripts/gate_parser_fresh.py compare \
  --manifest $GATE/gate.json --output $GATE --arms v9b v10b \
  --gold bench/parsers/fixtures/heading-release-gold-2026-09-20.json \
         bench/parsers/fixtures/heading-scope-release-gold-2026-09-20.json \
  --measure-dir data/knowledge-base/opus-intake-2026-09-23/section-paths
uv run --project pipeline python $S/classify_lost.py $GATE v9b v10b
export PYTHONDONTWRITEBYTECODE=1
uv run --project pipeline python $S/replay_v10.py measure $GATE/measure-b.json v9p v10p
uv run --project pipeline python $S/replay_v10.py gold $GATE/gold-b.json v9p v10p
uv run --project pipeline python $S/fidelity.py $GATE/fidelity-b.json
```
