# Parser figure flattening: blind-set tuning on the knowledge base

Open work on dense-figure flattening (`parser/odl/flatten.py`,
`pictures.flattened_figures`, parser v17 shipped 2026-10-16 in `9cacbe1e`,
tuned as parser v18 on 2026-10-18). Current behaviour:
`openwiki/agentic-retrieval.md` (search "flattened"). Decisions:
`human/agentic-retrieval.md` (2026-10-16, 2026-10-18). Evidence:
`bench/parsers/reports/2026-10-16-element-limit.md` (v17) and
`bench/parsers/reports/2026-10-18-flatten-tuning.md` (the blind-set rounds
and v18), raw runs in the ignored `bench/parsers/reports/local/2026-10-16-element-limit/`.
Any behaviour change needs a developer decision recorded in `human/` before
it is built (`human` skill), and a parser version bump.

## Goal

Tune and speed up flattening against the knowledge-base books without
overfitting: the agent that changes the code never sees the books that
judge it.

## Protocol (blind sets)

- **Corpus**: the knowledge-base sources (288 books on 2026-10-16, more to
  come) plus the bench corpus. Only books with at least one flattened page
  matter (85 of 288, 81 of 381 on the Mac); the dry run finds them in
  minutes (`flatten_probe.py`, about 1 ms a page).
- **Split**: a tester subagent draws a random blind set (seeded, e.g. 40
  touched books) and keeps the ids to itself. The main agent gets a
  separate dev set to look at and improve on. The blind ids never reach the
  main agent, a report or a commit. A fresh blind set is drawn for each
  round, so one blind set is never reused as a tuning signal.
- **Rounds**: the main agent changes the code on the dev set, then hands the
  tester the commit. The tester parses its blind set on the baseline (v17)
  and on the candidate and reports aggregates only: no ids, no page
  examples. The main agent keeps a change only if the blind aggregates
  improve, or hold, on every metric.
- **Where**: blind and dev parses run on the ingest host in throwaway
  hardened containers, in the production shape (1 GiB Java heap, 2 GiB child
  cap, 600 s deadline), one book at a time. Coordinate host use with the Rust
  harness session; clean up only what the run created (never
  `docker builder prune` or other host-wide cleanup without Epo).

## Metrics (per book, aggregated over the set)

- Parses on v17 and on the candidate; Java peak and time; flatten time.
- Headings lost and added against an unflattened parse, where the book
  parses unflattened, or against v17 otherwise. Added headings that are
  figure labels count as defects.
- Words leaving the text (labels count as text), body text blocks, figure
  and table counts.
- False regions: ruled tables, text boxes, page-sized regions (sample-render
  regions with a high text share or area share).
- Pages and regions touched.

## Known items to work on

1. **Regions cover only a chart's dense core.** Titles and axis labels sit
   20–143 pt from it (statistics-using-technology p184–187: "Pregnancy
   Length" ×4 became headings), so they miss the 30 pt label reach. 15
   label headings remain in 11 books. Try growing each region to the full
   drawing cluster (the vector-figure grid in `pictures.Drawings`) before
   rendering, so titles, axes and sparse points are inside.
   **Done 2026-10-18 (v18):** a core grows to the drawing clusters it meets,
   stopping at the outermost rectangle drawn around it and at text (a whole
   line of 8 or more words, a lettered line of that length it cuts across,
   or 30 words); a heading above or below a region joins it only when
   centred on it. Blind (40 books, v17 → v18): 13 fewer label headings, real
   headings lost against an unflattened parse 94 → 91, 21 of 24 sampled
   grown regions good. A rule keeping headings beside small regions was
   tried and dropped: blind, it restored no real heading and made 7 labels
   headings again.
2. **Thresholds are prototype guesses**: 800 segments a page, 12 pt cells,
   15 segments a cell, 300 a region, 15% text share, half-page frames,
   150 dpi. Tune them blind.
   **Done 2026-10-18 (v18, thresholds kept):** the false regions were
   answer blanks (1,333 of 2,599 dev regions, in two books) and formulas
   drawn as outlines (255 in one book), not threshold noise. Runs of
   answer-blank ticks are now merged into rectangles before regions are
   looked for (dev: 742 and 591 regions → 1 each; path segments left for
   Java 745k → 184k and 503k → 126k) and outline formulas are flattened
   without a figure, carrying `[formula]` (blind: 56 quiet regions, none a
   chart). 15 segments a cell stays: 30 removed most formula regions but on
   dev added 4 label headings and lost 3 real ones.
3. **Speed**: flatten takes 0.5–25 s a book on the host (EBSE 25 s, a
   biology textbook 10 s), split across finding regions (`get_cdrawings` on
   every page), rendering, image insertion and the save. Skip pages the
   cheap per-page counts (`elements.py`) show as light before
   `get_cdrawings`.
   **Done 2026-10-18 (output-neutral, no version change):** each flattened
   page renders all its regions and reads its words from one display list,
   so flatten is 10–19% faster on blind sets of 40 books. Skipping light
   pages was measured and dropped: annotation appearances, tiling patterns,
   soft masks and Type3 fonts draw paths outside the page content, so only a
   third of the light pages can be skipped safely, and the bound that proves
   it costs 48.5 s to save 5.4 s on the dev set. Saving the parse copy with
   object streams was tried and dropped: it made every later open 3.4–3.7×
   slower and tipped a book at the 1 GiB heap into 400 full GCs.
4. **EBSE spends 184 s in the repair stages** (262 s parse; the
   no-vector variant took 190 s, so the cause is text, not flattening).
   Profile per stage (`_stages`) and find the slow repair.
   **Done 2026-10-18 (output-neutral):** `scripts._lines_for_words`
   compared every line with every line on a page; pages of R plot markers
   set as text hold up to 24,366 lines. A line grid on pages of 500 or more
   lines takes the stage from 147 to 29 s (EBSE parses in 149 s instead of
   272). The column repair's per-glyph pymupdf calls are now one Python test
   (39–41% faster on blind sets). A path box that is not finite no longer
   fails the parse.
5. **Rotated pages are skipped** (none in the corpus so far).
   **Done 2026-10-18 (v18):** a rotated page is flattened at rotation 0
   and restored, its regions reported as the page shows them. Synthetic
   renders match at 90, 180 and 270 degrees (mean pixel difference about
   0.33); rotated copies of three dev books parse with the same regions.
6. **Picture count shrinks** where a flattened region holds several of ODL's
   pictures (biology textbook 2,531 → 1,592 image blocks): check that
   separate photos inside one region should become one figure.
   **Done 2026-10-18 (no change):** on a blind set, 8 of 8 regions holding
   several of ODL's pictures were one figure in pieces.

## Open (v18)

From blind round 6 (40 books) and the dev set:

- Growth into an example text box and over half a ruled table (2 of 24
  sampled grown regions).
- Merged regions spanning a ruled periodic table and a formula line (with
  the text box, 3 of 8 sampled merged regions).
- A core whose growth is blocked can be a fragment of its chart (dev
  9d4f16ca p295): its picture lacks the frame and axes.
- Logos and a simple diagram's labels drawn as outlines are quiet and
  carry `[formula]` (5 logos on dev; 3 logos and 3 labels quiet blind),
  accepted as v12's logos were. A rule giving no placeholder on a book's
  first two and last two pages would cover the dev logos; it is untested.
- A formula drawn as several outline pieces gets one `[formula]` per quiet
  region, so a line can read `[formula] [formula] [formula]` (16 of 53
  formula lines in blind round 7 carry 2 or 3). Joining the regions of one
  text line into one placeholder would fix it.
