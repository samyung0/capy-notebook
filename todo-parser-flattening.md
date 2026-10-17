# Parser figure flattening: blind-set tuning on the knowledge base

Open work on dense-figure flattening (`parser/odl/flatten.py`,
`pictures.flattened_figures`, parser v17, shipped 2026-10-16 in `9cacbe1e`).
Current behaviour: `openwiki/agentic-retrieval.md` (search "flattened").
Decisions: `human/agentic-retrieval.md` (2026-10-16). Evidence and every
number below: `bench/parsers/reports/2026-10-16-element-limit.md`, raw runs in
the ignored `bench/parsers/reports/local/2026-10-16-element-limit/`.
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
2. **Thresholds are prototype guesses**: 800 segments a page, 12 pt cells,
   15 segments a cell, 300 a region, 15% text share, half-page frames,
   150 dpi. Tune them blind.
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
6. **Picture count shrinks** where a flattened region holds several of ODL's
   pictures (biology textbook 2,531 → 1,592 image blocks): check that
   separate photos inside one region should become one figure.
