# Blind page review rubric

You compare two PDF parsers, **A** and **B**, on single pages. The labels are shuffled per page;
do not try to guess which parser is which. The page image is ground truth. Read it first
(zoom in by reading the PNG again if needed) and enumerate the elements yourself before
looking at the parser output.

For every page write one JSON object. Elements:

- `formulas`: every display formula and every inline expression that carries mathematical
  structure (fraction, root, exponent, subscript, operator like ×, π, Σ, ≤). Plain numbers in
  prose ("26 gallons") are not formulas. A worked calculation line like
  `Volume = 0.785 × (3 ft)² × 1,500 ft = 10,597.5 ft³` is one formula.
- `tables`: every real table (grid of cells). Not a two-column layout of prose.
- `figures`: every photo, chart, diagram, screenshot. Include its caption if the page has one.
- `headings`: every true section/subsection heading (not running headers/footers, not page numbers).

Grade each element for each parser:

| Element | `good` | `partial` | `bad` |
| --- | --- | --- | --- |
| formula | A reader of the text alone could reconstruct the formula unambiguously: values, operators (×, π, √, fraction bar scope, exponents) all present and in a recoverable order. LaTeX, Unicode or clean linear text all count. | Numbers survive but structure is damaged: missing operator/π, flattened fraction where numerator/denominator are ambiguous, exponent detached, pieces split across blocks out of order. | Missing, garbled beyond recovery, wrong digits, or turned into a heading. |
| table | Every cell present and row/column association preserved. | Cells present but some association lost (merged/shifted cells, header misattached), or the table is flattened to text but still readable row by row. | Most cells missing, or shredded so rows cannot be recovered. A non-table emitted as a table counts in `false_tables`. |
| figure | Emitted as an image/figure block, caption attached or immediately adjacent. | Emitted as figure but caption missing/detached, or figure split into fragments. | Not emitted, or its internal labels dumped into body text as noise with no figure block. |
| heading | Emitted as a heading; level plausible relative to the other headings on the page. | Emitted as heading but wrong/implausible level, or split into fragments, or text garbled. | Emitted as plain text (missed) or dropped. |

Also record per parser:

- `false_headings`: number of blocks emitted as a heading that are NOT real headings
  (formula lines, figure labels, table cells, running headers, list items). Give short examples.
- `false_tables`: number of non-table regions emitted as tables.
- `section_path`: look at the "indexed chunks touching this page". Using the page image (and
  the chapter/section context you can infer from the book title, the running header and
  the headings on this page), grade the section paths of those chunks:
  `good` = every chunk path names the right enclosing section chain (missing a top ancestor is OK);
  `partial` = right section but polluted (a false heading in the chain, an extra stale ancestor,
  a truncated/garbled element) on some chunks;
  `bad` = wrong section, or the chain is dominated by junk (formula/label text as headings) on most chunks;
  `none` = no section path at all although the page has an enclosing section.
  Give the worst path you saw verbatim (shortened) as `section_path_example`.
- `text`: `good` / `partial` / `bad` for the ordinary prose: reading order, dropped lines,
  garbled characters (e.g. private-use glyphs, missing symbols), hyphenation junk.
- `notes`: one or two sentences on the most important difference.

Use `n/a` nowhere: if a page has no formulas, `formulas` is an empty list.

Output shape (one object per page, collected into a JSON array):

```json
{
  "page": 295,
  "formulas": [{"desc": "tank wall area = L × W = 87.92 ft × 50 ft", "A": "partial", "B": "good"}],
  "tables": [{"desc": "...", "A": "...", "B": "..."}],
  "figures": [{"desc": "...", "A": "...", "B": "..."}],
  "headings": [{"desc": "Practice Problems 2.3", "A": "bad", "B": "good"}],
  "A": {"false_headings": 1, "false_heading_examples": ["Pipe Volume = 0.785 ..."], "false_tables": 1,
        "section_path": "bad", "section_path_example": "...", "text": "partial"},
  "B": {"false_headings": 0, "false_heading_examples": [], "false_tables": 0,
        "section_path": "good", "section_path_example": "...", "text": "good"},
  "notes": "..."
}
```

Notes on the packets:

- Characters in the Unicode private-use area (U+F000–U+F0FF, often shown as ``, ``
  or as an invisible gap) are unreadable glyphs: count them as missing symbols.
- `[dropped as page furniture]` blocks are intentionally excluded from the index; that is correct
  for running headers/page numbers and wrong for real content.
- A parser's `code` blocks may be absent from its chunk list (an adapter artifact): judge element
  quality from the raw blocks; use the chunk list only for section paths.
- Judge only what is on this page. Be strict and consistent; do not reward verbosity.
