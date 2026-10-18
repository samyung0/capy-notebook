# Figure flattening: blind-set tuning (parser v18)

2026-10-17/18. Tunes the dense-figure flattening parser v17 introduced
(`2026-10-16-element-limit.md`, `todo-parser-flattening.md`) on the
knowledge-base books, without letting the code see the books that judge it.
Outcome: parser v18 (decisions 2026-10-18 in `human/agentic-retrieval.md`);
current behaviour in `openwiki/agentic-retrieval.md` ("flattened").

## Protocol

- **Books**: the 85 knowledge-base books v17 flattens at least one page of.
  A dev set of 25 (the six the todo names plus 19 drawn with a fixed seed)
  is open to the implementing agent; the other 60 are the blind pool.
- **Rounds**: the implementer builds candidates on the dev set. A separate
  tester draws a fresh seeded blind set of 40 for each round, parses it on
  v17 (and unflattened where the book parses unflattened) and on the
  candidate, and reports aggregates only, never book ids or pages. No blind
  set is reused as a tuning signal.
- **Where**: the ingest host, one parse at a time under a shared lock, in
  throwaway hardened containers in the production shape (1 GiB Java heap,
  2 GiB parse-child cap, 600 s deadline, no network). Dev timings that
  overlapped a UAT ingest deploy were rerun or dropped.
- **Metrics**: parse outcome, Java peak, time and full collections (GC log),
  flatten time, headings lost and added against an unflattened parse (or
  v17), headings that are figure labels, words leaving the text, figure and
  table counts, quiet and grown regions sampled by eye, render differences.

One dev book (1,568 pages) is refused by the 1,400-page cap in every
variant; dev figures are over the other 24.

## Output-neutral speed-ups (landed as v17, `ed6835b09..f7adc3a32`)

| Change | Dev (24 books, v17 → candidate) | Blind (40) |
| --- | --- | --- |
| One display list per flattened page renders every region and gives the words | flatten 130.6 → 96.2 s | identical output 40/40, flatten −17% to −19% |
| A 16 pt line grid for `scripts._lines_for_words` on pages of 500+ lines | scripts 288 → 173 s (one book 147 → 29 s) | scripts +1.6% to +7% (no gain) |
| Column repair's point-in-rect test in Python | columns 53.5 → 28.7 s | columns −39% to −41% |
| A path box that is not finite gets no cell | a synthetic NaN page no longer fails | no blind book affected |

Round 3 (all of them, object streams reverted): identical 40/40, whole parse
−3.0%, flatten −10%, the heap-limit book's full collections 50 → 50.

## Behaviour rounds

| Round | Candidate | Dev | Blind (40, against v17) |
| --- | --- | --- | --- |
| 4 | Headings beside a region under 3% of the page stay headings (C5) | 5 real headings back, 1 defect | 0 real headings restored, 7 labels made headings again (+10 label headings in 3 books, all beside a small part of a larger figure). Dropped. |
| 5 | Growth to the drawing cluster, label text only (C4, C4b), plus C5 (C45) | regions 2,599 → 2,452; headings −19/+7 (unflattened −15/+4); 8 tables lost | 7 fewer label headings; 1 real heading lost to growth; 146 tables lost (of 83 sampled 80 fake, 2 figure grids, 1 real); of 30 sampled changed regions 14 good, 6 neutral, 8 grown over formula or answer-table text, 1 into body text; full collections on the heap-limit book 53 → 18 |
| 6 | The v18 stack (C18) | below | below |
| 7 | C18 plus `[formula]` on quiet regions (C20) | below | pending at the time of writing |

The v18 stack on dev (24 books):

| | Regions | Headings vs v17 | vs unflattened | Label headings | Figures | Tables | Flatten s |
| --- | ---: | --- | --- | ---: | ---: | ---: | ---: |
| v17 | 2,599 | — | −8/+9 | — | 6,881 | 1,992 | 130.8 |
| C45b (C45 + centred-heading rule) | 2,452 | −18/+10 | −14/+7 | 9 | 6,727 | 1,984 | 133.0 |
| v18 | 1,158 | −23/+16 | −19/+13 | 3 | 5,191 | 1,990 | 131.5 |

- The two answer-blank books go from 742 and 591 regions to 1 each; Java
  reads 184k and 126k path segments instead of 745k and 503k.
- 256 regions are quiet: 240 and 7 formulas in two books, 4 in the refused
  book, 5 outline logos; no chart. Tick merges change 0.008–0.056 of 255 per
  pixel channel on average.
- The moments-of-inertia table a C45 region had flattened is back.
- Hand-checked heading changes against C45b: real gains (three numbered
  sections and several others), real losses (one "Exercises" heading and
  two headings ODL had run into their first sentence), one new defect.
- A core whose growth is blocked can be a fragment of its chart; nothing
  goes into the body.
- With `[formula]` (C20): 252 placeholders (241 display blocks, 4 after a
  table, 2 spliced inline, 5 unplaced inline blocks); all but the 5 logos
  are real formulas or numeric answer choices. 18 of 24 books are
  byte-identical to C18, the other 6 identical without placeholders.

Blind round 6, C18, 40 books (the heap-limit book in), outside every deploy
window; all 40 parse:

- Headings against an unflattened parse: real headings lost 94 → 91 (4
  restored, 1 new loss); labels removed from headings 24 → 37; 13 fewer
  label headings than v17.
- Text: 386 characters out (v17: 179), 214 of them duplicate fake-table text
  on the heap-limit book and 27 a running head; 1,809 more words into labels,
  212 back in the body.
- Tables lost 148: of 126 viewed, 124 fake, 2 figure grids, 0 real.
- Quiet regions 56: 50 outline formulas, 3 logos, 3 outline labels of a
  simple diagram; no chart. Tick merges on 113 pages change at most 0.042%
  of pixels.
- Regions 1,748 → 1,293. Grown sample 21 of 24 good, 2 bad (an example text
  box, half a ruled table); merged sample 4 of 8 good, 3 bad (the same box,
  a ruled periodic table, a formula line).
- Java: path segments 3.01M → 2.65M (−12%; 19 books fewer, none more); peak
  4 better, 33 same, 3 worse; full collections on the heap-limit book
  53 → 19; Java time 261 → 239 s; whole parse 1,689 → 1,536 s (−9%).

## Dropped, and why

- **Object streams in the parse copy** (C1c): blind, the heap-limit book
  went from about 50 to over 400 full collections with Java time tripled,
  thumbnails 45–61% and VLM renders 20–36% slower; every later open of the
  copy was 3.4–3.7× slower locally. Reverted (C2r).
- **Skipping light pages before `get_cdrawings`**: annotation appearances,
  tiling patterns, soft masks and Type3 fonts draw paths outside the page
  content, so only 4,152 of 12,792 light dev pages can be skipped safely;
  the bound that proves it costs 48.5 s to save 5.4 s.
- **Counting intersecting words in the text share** (C3): 4 real headings
  back, but 14 real charts in one dev book went vector.
- **Headings beside small regions stay headings** (C5): blind round 4
  above. Its dev wins sat beside answer blanks and outline formulas, which
  v18 merges away or quiets; on v18's dev regions the only heading it still
  kept was a chart panel's title.
- **15 → 30 segments a cell** (C7): removed most formula regions, but added
  4 label headings and lost 3 real headings on dev; its real gains come with
  the quiet rule.
- **The quiet rule's answer-dash branch** (axis-aligned one-segment dashes
  on at most 24 lines): judged on cores, it claimed no answer blank once the
  tick merge ran, and 7 chart cores of + markers on dev.
- **Ticks end to end along one line**: written for answer boxes whose ticks
  survived the merge; the cause was overlapping redactions (MuPDF removed
  the paths under one of two overlapping redaction boxes only), now merged
  before they are added. With that fix the extra grouping changed nothing.
