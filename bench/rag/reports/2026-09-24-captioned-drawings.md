# Captioned vector drawings as one record

Decision 2026-09-24 (`human/agentic-retrieval.md`): a `Figure N:` caption with
no image block, on a page with a vector drawing, attaches to that drawing, and
no whole-page `caption_page_reference` record is made for it. This was measured
on a sample before the commit. Basic Analysis II (not yet dispatched) re-runs
figures and scopes after the change. Published books keep their records.

Code: `caption_pairs` and `drawing_records` in
`bench/rag/scripts/knowledge_base_pilot.py`. `parse` and `refresh-figures` both
run them. Test: `test_captioned_vector_drawing_is_one_record` in
`bench/rag/scripts/test_knowledge_base_pilot.py`. This follows the vector
records of `2026-09-23-vector-figures.md`, whose "Two records for one figure"
limit it removes.

## Rule

A caption record labels a drawing record on the same page when both hold:

- **Vertical.** The caption line's top is at most `CAPTION_GAP = 115` units
  below the drawing's bottom, or at most `CAPTION_OVERLAP = 30` units inside its
  box.
- **Horizontal.** The caption line overlaps the drawing horizontally. Or, as a
  short left-aligned line, it ends left of a drawing that spans the page's
  middle (x = 500).

Pairs are taken closest first (vertical gap, then ids). A caption labels one
drawing, and a drawing takes one caption.

The paired drawing record keeps its id, box and geometry kind. It takes the
caption record's `original_caption`, `caption_bbox`, `block_index`,
`section_path`, `excluded` and `exclusion_evidence`, and the caption record is
dropped. Unpaired captions keep their whole-page record, and unpaired drawings
stay plain `vector_drawing` records.

### Evidence

Candidates were measured over all 58 runs with `caption_page_reference`
records. Old records came from HEAD's `figure_records` plus `drawing_records`.

| Choice | Alternative | What the alternative does |
| --- | --- | --- |
| Caption below the drawing only | Also above | Only 5 candidates remain above an unpaired drawing (overlapping, gap up to 60). 4 of them are the next figure's drawing (Evidence-based SE pages 27, 240, 320; Operations Management page 49), and 1 is plausible (Java page 576). Taking the nearest in either direction also steals: Open Logic page 765 gives Figure 53.2 the drawing of 53.3 (8 units below it), and Evidence-based SE page 220 gives 7.60 the drawing of 7.61. |
| Horizontal overlap, or a short line left of a centred drawing | Overlap only | 356 pairs instead of 361. It loses 5 Basic Analysis captions: the parser's caption box stops at inline maths, or the caption is short ("Figure 8.2: Convexity.") and left-aligned under a centred drawing. All 5 were checked and are right. |
| | 60-unit horizontal tolerance | 362 pairs. The extra pairs cross columns: Electromagnetics 1 page 65 gives Figure 3.20 the left column's "(a) Potential" drawing, and Electromagnetics 2 page 154 moves Figure 8.5 onto the other column's drawing. With no bound, it pairs across columns on 7 more pages of the 10 gate books. |
| `CAPTION_GAP = 115` | 60 | Drops 21 pairs in Electromagnetics 1 and all 17 in Learning Statistics. Electromagnetics prints a credit line between drawing and caption. R plots set their axis labels as text, so the path box ends 91 to 107 units above the caption. |
| | 150 | Adds 4 pairs: 2 right figures whose drawing is only the top part (Pite Saami page 44, Integrated Infrastructure page 92), a stray arrow of a raster figure (Healthcare Compliance page 93), and a 38x50 fragment (Electromagnetics 1 page 214). Above 150 most candidates are one panel of a multi-panel figure, or another figure: Evidence-based SE page 128 would give Figure 4.63's caption the plot of 4.62, 386 units up. No candidate falls between 107 and 126. |
| `CAPTION_OVERLAP = 30` | 0 | Loses 8 pairs where a plot frame or a curve's path runs 1 to 25 units into the caption box. 7 are right. 1 is a hidden duplicate caption in Online Statistics (page 585) landing on one panel. The next candidate, at 48 units, is a hidden off-page caption over a non-figure (Online Statistics page 588). |

### Ids

A merged record keeps the drawing's id, `fig_<source14>_p<page>_<x0>_<y0>`:

- It is derived from the drawing box alone, so it is as deterministic as before.
- It cannot collide with the block-index ids `fig_<source14>_<block>`. The gate
  also checked that ids are unique in all 58 books.
- It does not depend on the pairing. Changing a threshold only adds or removes
  the caption record, and never renames the drawing.
- The record's geometry, which is the box a capture crops to, is still the
  drawing. `refresh-figures` carries notes over by id, so notes written for the
  drawing stay with it.

The alternative, the caption's block-index id, would name a drawing box after a
text block. That id would change whenever the pairing changed. Notes written on
a dropped caption record do not carry over. This matters only for a book
refreshed after its notes were written. Basic Analysis II has no notes and no
source repairs.

### Section path and block index

The record takes the caption's section path and block index rather than the
drawing's anchor (the last block that starts above it). On pages with at least
two numbered figure records including a merged one (111 record pairs), the
caption's block index put 9 pairs against figure-number order, on 6 pages. The
anchor put 15 pairs out of order, on 14 pages. The two paths differ for 51 of
the 361 records. With the caption's path, a merged record links exactly the
excerpts the old caption record linked. With the anchor's path, 43 records
would also link the excerpt of the block above the drawing.

### Exclusions

`intake.py exclude-figures` writes `bbox = caption_bbox or bbox`, which is the
caption box for a merged record. On a refresh the record takes the caption
record's excluded flag, which `figure_records` derives from the same box. No
run has an exclusion naming a `vector_drawing` record. An exclusion written
against a plain drawing's box would stop matching once that drawing gains a
caption, and intake.py would then disagree in the same way.

## Gate

Old records come from HEAD's `figure_records` plus `drawing_records`. New
records come from the working tree. Both ran in memory over each run's
`parsed/content_list.json`, the stored corpus and the source PDF, and nothing
under `data/` was written. The last column counts pages holding a caption
record and a drawing record without a caption: the duplicate pairs that remain.

| Book | Records | Caption records | Drawing records | Merged | Unpaired captions | Unpaired drawings | Caption + uncaptioned drawing pages |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Basic Analysis II | 106 → 67 | 51 | 53 | 39 | 12 | 14 | 35 → 0 |
| Learning Statistics with R | 164 → 147 | 32 | 132 | 17 | 15 | 115 | 19 → 2 |
| Ordinary Differential Equations | 66 → 66 | 12 | 54 | 0 | 12 | 54 | 12 → 12 |
| Electromagnetics Volume 1 | 321 → 254 | 109 | 87 | 67 | 42 | 20 | 62 → 5 |
| Introduction to GNU Octave | 128 → 127 | 63 | 1 | 1 | 62 | 0 | 1 → 0 |
| Electromagnetics Volume 2 | 245 → 181 | 94 | 93 | 64 | 30 | 29 | 60 → 4 |
| Online Statistics Education | 465 → 432 | 128 | 91 | 33 | 95 | 58 | 28 → 1 |
| Open Logic Project | 132 → 96 | 51 | 70 | 36 | 15 | 34 | 32 → 0 |
| Java Java Java | 1,132 → 1,120 | 337 | 83 | 12 | 325 | 71 | 53 → 44 |
| Evidence-based Software Engineering | 594 → 528 | 131 | 454 | 66 | 65 | 388 | 76 → 19 |
| 6 other books with merges | 738 → 712 | 174 | 70 | 26 | 148 | 44 | 31 → 8 |
| 42 books without merges | 12,236 → 12,236 | 1,352 | 32 | 0 | 1,352 | 32 | 4 → 4 |
| **All 58** | 16,327 → 15,966 | 2,534 | 1,220 | 361 | 2,173 | 859 | 413 → 99 |

The 6 other books are Komnzo 6, Pite Saami 2, Yakkha 6, Integrated
Infrastructure 5, Intermediate Financial Accounting 2 and Healthcare Compliance
5.

In all 58 books:

- Every record other than the merged ones is byte-identical to the old record,
  and the order is kept.
- Every removed record is a caption record whose six fields sit on exactly one
  drawing, and the drawing's other fields are unchanged.
- The `build_excerpts` links of every other record are unchanged.
- All 361 merged records link to the excerpt whose regions hold their caption.
  None is unlinked.
- Exclusion round trip: every merged record and every fifth other record was
  excluded by intake.py's rule and the figures were recomputed. The pilot's
  excluded flags equal intake.py's flags. The only extra flags are records
  sharing a picked record's page and box: Online Statistics has two identical
  parser image blocks, which that rule already flags together.

Pairing adds no measurable time. `drawing_records` still takes 2.4 s on Basic
Analysis II and 122 s on Evidence-based SE.

### Visual check

Crops with the drawing box in red and the caption box in blue were rendered to
the session scratchpad (not committed).

- **All 39 Basic Analysis II pairs:** every caption sits on its own figure. For
  6 two- or three-panel figures, the caption sits on one panel: pages 47, 130,
  154, 163 and 195, where the other panels stay plain drawing records, and page
  128, whose left panel has no record.
- **Random 45 of the other 322** (seed 20260924; 10 books): 44 captions sit on
  their own figure, 5 of them on one panel of a multi-panel figure (Online
  Statistics pages 280 and 589, Learning Statistics page 403 on one row of the
  sampling balls, Evidence-based SE pages 194 and 332).
- **Wrong pairing: 1 of 84.** On Online Statistics page 588, a caption from
  the book's hidden text layer ("Figure 6: Graphs related to the Arizona...")
  was paired with a cluster around the section title, which is not a figure.
  Both old records were already junk, and the merge leaves one junk record
  instead of two.

## Limits

- **Side captions** stay unpaired. ODE (all 12 captions) and most of Java Java
  Java set the caption in the margin beside the drawing, which leaves 12 and 44
  duplicate pages. Both are published and keep their records.
- **Multi-panel figures.** One caption labels one panel. The other panels stay
  plain `vector_drawing` records with no caption.
- **Captions above figures** are not paired.
- **Figures with no drawing record.** Their captions keep the whole-page
  record. These are raster charts the parser missed, or charts the text-frame
  rule drops. Within 115 units, a nearer drawing belonging to another figure
  could still take such a caption, but none did in the check.
- **Hidden text layers** (Online Statistics) give duplicate caption records.
  One of them may pair and the rest stay whole-page records.
