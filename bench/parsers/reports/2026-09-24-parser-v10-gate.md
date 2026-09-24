# Parser v10 fresh-parse gate

2026-09-24. Gate for parser `odl-2.5.7-refined-rapidocr-v10` and chunker v12: the three
rules of the [outline-levels report](2026-09-24-outline-levels-and-running-heads.md),
ported as its "What the implementer needs to port" section describes (decision
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
  `_source_role: book-title` and keep their level. Title pages end before the first page
  with more than 150 characters of body text (the developer's decision). The shared
  chunker (`chunk_content_list`, and `pack_blocks` for table stacks) closes the heading
  stack at that level without pushing the heading, and keeps its text in the chunk;
  `CHUNKER_VERSION` is `v12`. The gate's `stacks()` applies the same rule and leaves
  book-title headings out of anchors and roots.

`relevel` and `mark_book_titles` run in `refine.parse_pdf` where `backbone_levels` ran,
after `demote_fragments` and `demote_contents_lines` and before furniture is frozen.

**Result: the gate passes with the report's profile, and v10 is better than v9 on every
replay, with one cost from the 150-character stop.** Every outline anchor and root is
kept once book-title headings are left out; the 20 witnesses that change are the ones
the investigator's all-rules arm changes; 6 of 6 scope cases pass; the only missing body
units are the 82 banners the band removes; all 797 lost outline-confirmed ancestors are
duplicates, closed spans or unlisted titles, none a real loss. Wrong-path chunks fall
from 772 to 629 on the gate, from 2,744 to 2,056 on the section-path measure, and the
agents' paths go from 12,328 to 19,138 matching chunks (6,823 fixed, 13 worse). **The
stop keeps ReStorying Education's book-title root:** its title heading shares a page with
body text, so 527 measure chunks the prototype fixes stay wrong. See the open questions.

## Port fidelity

The port and the prototype (`newrules.py`, imported read-only) were applied to the same
blocks for 194 inputs: the 64 PDF gate documents and the four extra books as fresh v9
outputs, and 126 library books' saved parses after the working tree's role rules,
`demote_fragments` and `demote_contents_lines`. On all 194:

- `_listing` equals `listing` (usable, vetoed and matched entries alike);
- `_plan` equals `olg_plan(..., "ancestors2")` in levels and boundaries (154 inputs take
  outline levels, 40 the backbone);
- `mark_book_titles` with the stop switched off marks exactly the prototype's
  `title_roots`.

The stop is the only difference from the prototype. On these inputs it leaves 108
headings in 47 documents unmarked that the prototype marks, among them:

- the false positives it was chosen for: Message Processing's "MESSAGE PROCESSING" on
  page 7 and ReStorying's "INTRODUCTION";
- one-page and first-page titles with body text on the same page (w3c OpenOffice,
  prince-textbook, NIST FIPS 203, the OpenStax titles, forallx);
- title pages repeated after a page with body text: Language Science Press grammars
  (Papuan Malay, Palula, Pite Saami, Yakkha, Yauyos Quechua) and the Unicode Cookbook
  repeat title and author after the series page, and ReStorying's "ReStorying Education
  in the United States" opens its introduction page (page 7, 1,897 characters of body
  text), after the licence page (656 characters).

`relevel` takes up to 0.45 s and `mark_book_titles` up to 0.37 s per document (OpenStax
Biology).

## Setup

- **Candidate.** A snapshot of the working tree's `parser/` (`snapshots/parser-a`)
  mounted read-only over `/app/parser` in a throwaway container of the committed
  `capy-kb-parser:pilot-v9` image, with the builder container's env and limits (7 GiB,
  4 CPUs, 1,800 s deadline), the source cap raised to 512 MiB, its own token, port 18097
  and `RELEASE_SHA` set to v9's `10144955` as a placeholder. Health reported
  `odl-2.5.7-refined-rapidocr-v10+10144955…`. The container and its token were removed
  afterwards; the live parser and the pilot Postgres were not touched.
- **Baseline.** The final v9 gate arm (`v9b`, the committed v9, which is live).
- **Sources.** The same 66 documents, 16,924 pages, all parsed; and the four extra books.

## Gate against v9

| | v9 | v10 |
| --- | ---: | ---: |
| outline anchors kept | 4,882 | 4,882 of 4,882 (11 book-title anchors left out) |
| roots | 270 | 454: all 270 kept (8 v9 roots are book titles and left out) |
| gold witnesses changed | | 20 of 26, the same 20 as the investigator's arm |
| scope gold verdicts | | 6 of 6 pass |
| body blocks that lost an outline-confirmed ancestor | | 797: 578 duplicates, 208 closed spans, 11 unlisted, 0 open |
| v9 units missing from v10's chunks | | 82, all removed banners or folios |
| body blocks that lost a book-title component | | 13,196 |
| wrong-path chunks (23 intake books) | 772 | 629 |
| documents with more wrong-path chunks | | 0 |
| server parse time, all documents | 2,354 s | 2,406 s (see Timing) |

The investigator's all-rules arm (band, #12, `olga2`, title drop without the stop, on a
simulated v9) showed 800 lost outline-confirmed ancestors, 85 missing banner units, the
same 20 witnesses and 810 → 643 wrong-path chunks.

**Every change, with its cause.**

- *Running-head band.* 252 new banners in 5 documents: bookdown 102, QMUL Probability 61,
  NIST AI RMF 42, scope-latex-author 27, ctan-axessibility 20 (running heads in QMUL and
  bookdown, page numbers in the others). They account for the 82 missing units; no
  witness changes because of them.
- *Outline levels.* 11,283 heading levels change in 35 documents. The lost
  outline-confirmed ancestors are classified as in the investigator's `lost_outline.py`:
  578 duplicates (the same title is still in the path: INSEE 293, Private Pilot 278),
  208 closed spans (the outline ends the heading's span before the body block: OpenStax
  Microeconomics 154), 11 unlisted titles (Healthcare 7, R intro 3, WeasyPrint 1), and
  no heading popped inside its own span. 184 new roots are chapters the outline lists at
  its top level.
- *Book titles.* 56 headings in 29 documents are marked, 1 to 4 per document: titles,
  subtitles, authors and series lines ("Classroom Companion: Business"). 13,196 body
  blocks lose that component from their path; the 11 anchors and 8 roots above are
  those headings.
- *Witnesses.* 18 lose the document's title root ("Report example", "LATEX for authors
  current version", "Lua 5.0 Reference Manual", "An Introduction to R", "forallx"),
  mostly because outline levels close it at the first top-level entry; WeasyPrint 17 also
  loses "Table of contents", and OECD 16 loses "Executive summary" as the parent of
  Part A. In OECD 14 only the level changes: "Part A" moves from 2 to 1. They are the
  investigator's 20, moving to the settled path form.

**The extra books.** Conservation Techniques is unchanged (no outline; the backbone gives
the same levels). College Research 67 → 65 wrong-path chunks (its title pages), Formal
Logic 303 → 116 and the GNU Octave tutorial 54 → 38 (outline levels; its 16 lost
outline-confirmed ancestors are all closed spans, "1.3.1" no longer under "1.2").

**The stop on the gate.** Two derived arms re-mark the v10 content lists without the stop
(`v10nostop`) and with body pages skipped instead of ending the title pages
(`v10skip`). Both pass the same way: wrong-path chunks 627 and 628, 17 and 12 book-title
anchors left out, 15,653 and 13,699 body blocks losing a title component.

## The investigator's replay

`replay_levels.py` (the section-path measure) and the agents' paths ran read-only from the
investigator's folder through a wrapper that adds production arms. v9 code comes from a
`git archive` of the v9 commit; v10 code is the working tree. v8's inserted outline
headings are dropped after the rules, because the replay keeps chunk starts fixed. A
book-title heading is replayed as a banner boundary at its level, which is the chunker's
rule for paths.

The agents' paths are scored in two parts. **Scored:** 47 books, 32,668 chunks.
**Unreviewed, reported apart:** Programming Fundamentals (947 chunks, 3 repairs) and the
Physics chunks without a `section_path` correction. The Physics backfill has since
corrected most of its scope, so only 6 of its 2,030 gold chunks are unreviewed.

| Arm | Wrong-path (37 books, 11,658 chunks) | Title components | Agents' paths (scored) | Fixed / worse vs v9p |
| --- | ---: | ---: | ---: | ---: |
| v9p (production v9) | 2,744 | 1,224 | 12,328 | |
| v9p + band | 2,744 | 1,224 | 13,016 | 689 / 1 |
| v9p + outline levels | 2,059 | 839 | 18,219 | 5,952 / 61 |
| v9p + book titles | 2,741 | 1,126 | 12,339 | 17 / 6 |
| **v10p (production v10)** | **2,056** | **769** | **19,138** | **6,823 / 13** |
| v10p without the stop | 1,528 | 99 | 19,138 | 6,830 / 20 |
| v10p, body pages skipped | 2,056 | 766 | 19,141 | 6,827 / 14 |
| investigator's arm (band, #12, `olga2`, titles) | 1,804 | 99 | 19,147 | 6,839 / 20 |

- No book gets worse on the measure in any arm. The largest gains: the Unicode Cookbook
  311 → 1, Formal Logic 302 → 113, Private Pilot 163 → 83, GNU Octave 87 → 57,
  Healthcare 31 → 5.
- The band alone fixes Java 512 and Compressible Flow 167 (the Java regressions of the
  v9 gate), and Learning Statistics with R 10; its 1 worse chunk is in Java.
- Outline levels alone make 61 Compressible Flow chunks worse: its outline is vetoed,
  so the backbone now runs there. With the band, v10p fixes 415 of its chunks and makes
  6 worse.
- v10p's 13 worse: Compressible Flow 6, Liquidity 3 (title-page chunks whose accepted
  path is its series line), Java 2, Basic Analysis 1, Concepts of Biology 1.
- Without the stop, 7 more are fixed and 7 more made worse: Message Processing's 5
  chunks under "MESSAGE PROCESSING", Technology Tools' "Contents" and one in Formal
  Logic. On the measure, ReStorying goes from 617 to 90.
- **Unreviewed gold.** Programming Fundamentals: v9p 777 → v10p 653 of 947, 6 fixed and
  130 worse, all from outline levels and the same in the investigator's arm (its paths
  are numerically impossible, "1.1 › 1.1.2 › 1.2.3.3"). Physics' 6: 6 → 6.

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

v10 took 2,406 s of server parse time against v9's 2,354 s (+2%). A sample every minute
read host CPU at 61% on average (22-87%, 16 logical CPUs) with a median of 6 Python
processes (up to 10), beside the backfill workers and, in its first half, the pipeline
test suite and the fidelity check; the v9 gate ran at 59% with a median of 2. Per document the difference runs
from −8 s (Business Plan Guide) to +19 s (OpenStax Biology). The two new stages take
under 0.5 s each on the largest documents.

## Deployment

After this commit `capy-kb-parser:pilot-v10` is built from a clean export of the commit
with its SHA and swapped in when the live parser is idle: the v9 container is kept
stopped as `capy-kb-parser-v9-backup`, and the new container reuses its name, env, port,
limits and spool bind. `/healthz` then reports `odl-2.5.7-refined-rapidocr-v10` plus the
release SHA.

## Open questions

1. **The 150-character stop.** It removes the two false positives it was chosen for, but
   ends the title pages before any title page that follows a page with body text. The
   cost is ReStorying (617 wrong-path chunks on the measure instead of 90) and the
   repeated title pages of the Language Science Press grammars and the Unicode Cookbook;
   on the agents' paths it is neutral (7 fixed and 7 worse either way). Skipping body
   pages instead of ending the title pages does not help ReStorying, whose title and
   "INTRODUCTION" share a page. Keep the stop, drop it, or make the test per heading?
2. **One-page documents** lose their only heading from the path (w3c-complex-table's
   "Example table", lille-probability's "TD1 - Evénements et tribus"), as the investigator
   noted.
3. **Programming Fundamentals** still carries unreviewed paths; outline levels make 130 of
   them worse by that gold.

## Reproduction

Raw outputs, scripts and logs are in the ignored
`reports/local/2026-09-24-parser-v10-gate/`: `v9b/` and `v10/`, `snapshots/parser-a/`,
`compare-v9b-v10.json`, `summary-v10.txt`, `lost-v10.log`, `load-v10.log`;
`fidelity.json` (`fidelity.py`); `measure.json` and `gold.json` (`replay_v10.py`);
`v10nostop/`, `v10skip/` and their compares (`make_title_arm.py`); `extras/` with `x9b/`,
`x10/` and `compare-x10.log`.

```sh
GATE=bench/parsers/reports/local/2026-09-24-parser-v10-gate
S=$GATE/scripts
docker run -d --name capy-kb-parser-v10-gate -p 127.0.0.1:18097:8090 \
  --memory 7g --memory-swap 14g --cpus 4 -e PARSER_TOKEN \
  -e CAPY_MAX_SOURCE_BYTES=536870912 [the builder container's other CAPY_* env] \
  --mount type=bind,source=$GATE/snapshots/parser-a,target=/app/parser,readonly \
  capy-kb-parser:pilot-v9
PARSER_TOKEN_V10=... uv run --project pipeline python bench/parsers/scripts/gate_parser_fresh.py \
  parse --manifest $GATE/gate.json --arm v10=http://127.0.0.1:18097 --output $GATE
uv run --project pipeline python bench/parsers/scripts/gate_parser_fresh.py compare \
  --manifest $GATE/gate.json --output $GATE --arms v9b v10 \
  --gold bench/parsers/fixtures/heading-release-gold-2026-09-20.json \
         bench/parsers/fixtures/heading-scope-release-gold-2026-09-20.json \
  --measure-dir data/knowledge-base/opus-intake-2026-09-23/section-paths
uv run --project pipeline python $S/classify_lost.py $GATE v9b v10
export PYTHONDONTWRITEBYTECODE=1
ARMS="v9p v9p+band v9p+olga v9p+troot v10p v10p-nostop v10p-skip v9bandr12+olga2+troot"
uv run --project pipeline python $S/replay_v10.py measure $GATE/measure.json $ARMS
uv run --project pipeline python $S/replay_v10.py gold $GATE/gold.json $ARMS
uv run --project pipeline python $S/fidelity.py $GATE/fidelity.json
```
