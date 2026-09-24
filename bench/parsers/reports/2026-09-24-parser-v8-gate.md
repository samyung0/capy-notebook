# Parser v8 fresh-parse gate

2026-09-24. Gate for parser `odl-2.5.7-refined-rapidocr-v8`, the structure fixes of
the [ODL thin-image report](2026-09-23-odl-thin-images-and-accuracy.md) that the
2026-09-24 v8 decision took. Each rule was replayed on saved parses first, then all
seven ran together through the 66-document fresh-parse gate against v7.

| # | Rule | Code |
| ---: | --- | --- |
| 5 | Banner rules also see margin-band paragraphs | `headings.correct_roles`, `_source_spans` |
| 9 | Furniture only when at most half its occurrences sit in the page interior | `furniture.repeated_across_pages` |
| 10 | Capitals headings | `headings.promote_capitals` |
| 11 | Sentence headings in the page's body font and size demoted | `headings.correct_roles` |
| 12 | Outline headings where only a running head prints the title | `headings.insert_outline_headings` |
| 13 | TeX fonts without ToUnicode mapped from their built-in encoding | `fonts.map_tex_fonts` |
| 14 | Spaces drawn inside a ligature glyph dropped | `source_text.join_split_ligatures` |

**Result: v8 meets v7's bar, with explained exceptions.** Every outline anchor, root
and scope witness is kept. One heading-release witness moves from a footer kept in the
text to the discarded banner its gold expects. No text is lost: every missing unit is
a running head, a folio or a line promoted to a heading. Five body blocks lose an
outline-confirmed ancestor, all where #12 replaces a stale section with the outline
entry that starts on that page. Two documents gain wrong-path chunks, from paths that
were already wrong.

## Setup

- **Candidate.** A snapshot of the working tree's `parser/` (`snapshots/parser-c`, the
  committed code) mounted read-only over `/app/parser` in a throwaway container of
  `capy-kb-parser:pilot-v7`, with the builder container's env and limits (7 GiB, 4
  CPUs, 1,800 s deadline), the source cap raised to 512 MiB, its own token, port 18097
  and `RELEASE_SHA` set to HEAD `92073e5f` as a placeholder. Health reported
  `odl-2.5.7-refined-rapidocr-v8+92073e5f…`. The container was removed afterwards; the
  live builder container and the pilot Postgres were not touched during the gate.
- **Baseline.** The `v7` arm of the 2026-09-24 v7 gate (fresh v7 outputs).
- **Sources.** The same 66 documents, 16,924 pages. All 66 parsed.
- **Four books outside the gate** (Conservation Techniques, College Research, Formal
  Logic, the GNU Octave tutorial) were parsed fresh by the pilot-v7 image as it is
  (committed v7) and by the final snapshot, one throwaway container at a time.
- **An earlier gate** (`v8b`) ran the six rules without #12, before the developer
  settled #12's level. Its results match the final gate except where #12 acts (Game
  Theory, English Composition) and for the Business Plan Guide's author line, which a
  later title-page fix keeps as text.

## Gate against v7

| | v7 | v8 |
| --- | ---: | ---: |
| documents, pages | 66, 16,924 | 66, 16,924 |
| outline anchors kept | 4,891 | 4,891 of 4,891 |
| roots | 270 | 271: all 270 kept, plus English Composition's inserted "Appendix" |
| heading-release gold witnesses changed | | 1 of 20 (case 07, now the expected banner) |
| scope gold verdicts | | 6 of 6 pass |
| body blocks that lost an outline-confirmed ancestor | | 5, all #12 corrections (below) |
| v7 banners kept as headings | | 0 |
| v7 units missing from v8's chunks | | 910 |
| of which real losses | | 0 |
| wrong-path chunks (23 intake books) | 1,603 | 1,575 |
| documents with more wrong-path chunks | | 2 (Animals Ethics 166 → 167, Science of Sleep 49 → 51) |
| chunks | 44,678 | 44,401 |
| server parse time, all documents | 2,284 s | 2,577 s (see Timing) |

**Missing units.** `classify_missing.py` sorts each of the 910:

| Class | Units | What they are |
| --- | ---: | --- |
| removed | 819 | running heads, bare folios and repeated footers now discarded (#5) |
| heading | 86 | capitals lines promoted to headings (#10): Business Plan Guide 48, Message Processing 27, Keys to the Middle East 4, How to Learn 4, three others 1 each |
| changed in place | 5 | heading-r-intro lines whose TeX glyphs are now mapped (#13) |
| real | 0 | |

**Removal classes, with evidence.** All 2,324 new `running-banner` blocks in 51
documents are margin blocks of four kinds: title-and-folio running heads ("24 | 2.1
Introduction", "8.3 • Entry and Exit Decisions in the Long Run 205"), bare folios
(slide numbers in both decks, "vi", "43"), repeated footers ("Business Plan
Development Guide") and document-title heads ("FIPS 203"). Bare folios that v7 marked
`page_number` are now banners instead (1,448 → 3 `page_number` blocks); both types are
furniture, so chunk text is the same. A 60-block sample of the replay's paragraph
banners was 60 of 60 running heads, folios or footers.

**Gold case 07.** LibreOffice's "Extensions and add-ons | 13" footer, which the gold
expects to be discarded, was a paragraph in v7 and in chunk text; v8 discards it.

**The five lost outline-confirmed ancestors.** All sit on a page where #12 inserts a
heading. The gate counts the previous section as confirmed there because its outline
span ends on that shared page:

- Game Theory, page 23: four blocks under v7's stale "2.1 Introduction to Two-Person
  Zero-Sum Games" (the pre-existing error noted in the v7 gate) now sit under
  "Finding Strategies", the outline's next section, inserted at its siblings' level 5.
  Its 48 blocks on later pages move the same way; wrong-path chunks 43 → 24.
- English Composition, page 99: the appendix placeholder text moves from "5.3 Citing
  Sources" to the inserted "Appendix" (level 1, which also makes it a new root).

**The two worse documents.**

- *Animals Ethics* gains one chunk: "Of course, always feel free to raise any other
  questions…", a closing line printed at the page foot and in the interior, which #9
  restores. The book's paths were already wrong (166 of 185 chunks sit under stale
  front matter), and the restored line inherits that path.
- *The Science of Sleep* gains two chunk starts on pages 91 and 93 inside "How and
  Where Dreams Are Created" and "Interpretation of Dreams", whose paths the measure
  already called stale in v7 (the page 91 chunk beside them is wrong in both arms).
  Removing the page's running head from chunk text and joining its ligatures moved the
  packer's boundaries, as the payoff tables did for Game Theory in v7.

**Improvements.** Game Theory 43 → 24, Human Anatomy Lab 10 → 5, English Composition
9 → 4, Liquidity 103 → 102, Media Studies 272 → 271 wrong-path chunks.

## Rule by rule

Replays ran HEAD (v7) and the working tree on the same saved parses: every distinct
library book's saved `content_list.json` (126 books) and, for the 40 gate documents
that are not library books, their fresh v7 outputs. Wrong-path chunks use the
section-path `measure.py` on the 37 intake books with chunk starts fixed, as in the v6
report.

### #5 Margin-paragraph banners

- Library: **1,140 paragraph banners in 69 books** (the ODL report's 1,106 in 68, plus
  34 in Open Research); 26 heading banners in 11 books join because their paragraph
  siblings complete a family. Gate documents: 353 in 14.
- Sample of 60: 60 running heads, folios or repeated footers.
- Wrong-path chunks, rule alone: 4,124 → 4,114 (Message Processing 9 → 0, Liquidity
  108 → 107). College Research's 114 running heads leave chunk text, not paths.
- **A regression the replay caught and the code now avoids.** Adding paragraphs to a
  folio family took away the proof v7 used: in Open Research the even pages' heads are
  headings and the odd pages' heads are paragraphs, all page-wide, so only the other
  side's heads showed the page offset. Once they joined the family, no member could
  prove it, and 34 v7 banners came back as headings. A family's headings are now
  judged as before, with paragraphs outside able to prove the offset, and its
  paragraphs join an accepted family; judged together, no member proves its own family.
  Replayed again: 0 v7 banners lost, and the Exercise-series guard holds (its tests
  pass).

### #9 Furniture mostly in the margins

- Library: **1,653 blocks (29,395 characters) restored in 76 books**, the ODL report's
  figures. Gate documents: 626 blocks in 21. Largest: Evidence-Based Software
  Engineering 593, Online Statistics 258, Electromagnetics I 70.
- Frozen keys fall from 4,478 to 282 across all 166 documents: most keys repeat mostly
  inside pages (formulas, labels), where the chunker kept them anyway. Every text
  repeated only in the margins stays furniture.
- Restored text sampled: citations, licence lines, table captions at a page edge,
  equation fragments and plot labels near the margin.

### #10 Capitals headings

- Library: **203 promotions in 17 books** (Conservation Techniques 93, Business Plan
  Guide 49, Message Processing 27, Learning in the Digital Age 13, Keys to the Middle
  East 5, How to Learn 4). Gate documents: 2.
- Conservation Techniques: 93 of its 101 capital section titles, all at level 3 under
  the chapter titles (level 2); in the fresh parse 1,054 body blocks gain their section.
- Sample of 45 outside Conservation: 37 section headings; 5 chapter bylines in Learning
  in the Digital Age ("TAMMY WISE, OKLAHOMA STATE UNIVERSITY"); 2 callout labels
  ("LISTEN & DISCUSS", "DESCRIPTION FOR FIGURE"); 1 page-top running head without a
  folio ("UNDERSTANDING MUSIC ABOUT THE AUTHORS"). 82%, near the report's 84%.
- Two definitions the decision leaves to the code:
  - *Folio.* Digits at either end, as in the investigator's replay, plus a Roman
    folio in the margin band. Without it, College Research's front-matter running
    heads ("TITLE PAGE | XI") were promoted.
  - *Title page.* Pages up to the first native heading and its leading repeats. The
    first fresh gate promoted the Business Plan Guide's "LEE A. SWANSON": its title
    heading is on a half-title page 1 and again on page 3, the title page. The rule now
    stops at the last leading repeat; replayed, it drops that line and "ANA CAROLINA
    RODRIGUEZ AND TAYLOR CAVALLO" and nothing else.
- Wrong-path chunks, rule alone: unchanged (4,124). The measure scores path errors, and
  the promoted titles are new, correct path components.

### #11 Body-style demotion

- Library: **434 demotions in 79 books**; gate documents 294 in 21 (OpenStax
  Precalculus 117: "For the following exercises, …" instructions typed as headings).
- Sample of 60: all body text. Paragraph carry-overs at a page top, exercise
  statements, verse lines, speaker labels in plays ("HAM."), references, and two run-in
  headings with their paragraph ("Problem 5.2: Non-Standard Sampling Using …").
- Wrong-path chunks, rule alone: 4,124 → 4,070 (Octave 124 → 87, College Research
  73 → 69, Human Anatomy Lab 11 → 8, Applied Human Anatomy 4 → 0, five others −1 or
  −2).
- College Research: 14 demoted, 14 correct (the licence paragraph, the carried-over
  lines on pages 21 and 35, paragraphs, glossary definitions).

### #12 Outline headings

An outline entry that no heading on its destination page matches (also as a title
split over two heading blocks) gets a heading when a running head on that page, which
the banner rules discarded, carries the same title once its folio is removed. The
developer settled the level on 2026-09-24: the most common level of the entry's matched
siblings under the same parent entry, else one below the parent entry's heading, else
1. The heading goes before the page's first block with the running head's box, and a
body paragraph repeating the title stays. It runs after the outline roots and before
the capitals rule, so capitals headings sit below an inserted chapter.

- Replay (`outline_replay.py`, saved parses re-packed, since #12 adds blocks): **105
  headings in 7 documents**: College Research 90 (89 chapters at level 2 under their
  parts, "Glossary" at 1), Restorying Education 6 (level 1), Evidence-Based Software
  Engineering 5 (level 5, its sections' level), Game Theory 1 (level 5), "Appendix" in
  three books (level 1).
- College Research now runs part › chapter › section, for example "THE AGE OF
  ALGORITHMS › What are Algorithms? › Overview". In the fresh parse 747 body blocks
  gain their chapter.
- Wrong-path chunks without and with #12: Game Theory 44 → 27, Restorying 618 → 402,
  English Composition 4 → 4, College Research 58 → 67.
- **`measure.py` overstates College Research.** The inserted headings carry the running
  heads' boxes in the top margin, and the measure calls a path component in that strip
  whose text repeats there a running head. College Research repeats chapter titles
  ("Conclusion" 8 times, "Critical Thinking", "Chapter Scenario", "Practice"), so 42
  chunks are flagged for that alone. Its stale-ancestor chunks fall from 52 to 14;
  without the 42 artefacts the count is 58 → 25. The fresh parse shows the same: 66 → 67
  by the measure, 42 of them artefacts, stale ancestors 56 → 14.
- Restorying repeats 5 of its 6 titles as a body paragraph, so they appear in both the
  path and the text, as decided.

### #13 TeX maps

The ODL jar ran with a visible `--replace-invalid-chars` marker on each book's v7 and
v8 `repair_fonts` copy (`marker_run.py`):

| Book | Unmapped v7 | Unmapped v8 | What came back |
| --- | ---: | ---: | --- |
| Formal Logic | 321 | 1 | 69 negation slashes, 57 ⊢, 84 big brackets, 38 ⋆, 17 ▷, 8 ⟨⟩, 3 ↺, 1 ◯, 1 ⋁ |
| GNU Octave tutorial | 290 | 23 | bracket pieces as ⎡⎣⎤⎦ (not private use), 42 ∫, 34 ‖, 22 ⟨⟩, 17 ′, 5 ∑ |
| Java, Java, Java | 874 | 839 | 33 ′, 2 slashes |
| Evidence-Based Software Engineering | 26,523 | 26,446 | 54 brackets, 10 √, 4 ♯ |
| Compressible Fluid Mechanics | 3,636 | 3,633 | 3 ′ (its gaps are in other font types, as the report found) |
| Philosophical Ethics | 2 | 1 | 1 ◯ |
| heading-r-intro (gate) | 11 | 0 | 5 ◯, 2 ℓ, brackets |

- **The checked list.** Glyph names whose pypdf value is not what TeX draws were
  checked by rendering the embedded fonts: `turnstileleft` is ⊢ (pypdf ⊣),
  `circlecopyrt` the big circle ◯ (pypdf ©), CMMI `triangleright` ▷ (pypdf ⊿), CMMI
  `phi` the stroked ϕ and `phi1` the loopy φ (pypdf the reverse), `lscript` ℓ, MSAM
  `anticlockwise` ↺, and Greek Δ and Ω for CMR's `Delta` and `Omega` (pypdf ∆ and the
  Ohm sign). CMMI's `epsilon` is ε, as pypdf has it. The mirror names
  (`turnstileright`, `clockwise`) and CMSY's white suits, `triangle`, `dotlessj` and
  the old-style figures follow the same tables.
- **Scope.** Only fonts named after the Computer Modern and AMS families (`CM*`,
  `MSAM`, `MSBM`). LaTeX's picture fonts (LINE10, LCIRCLE10, whose names pypdf would
  turn into control characters) and the Washington Cyrillic fonts (Latin-letter names
  for Cyrillic glyphs) are left alone.
- **Text that changes rather than returns.** Formal Logic's 30 Ω and Octave's 7 Δ
  switch from the Ohm and increment signs to the Greek letters; Octave's 14 φ become ϕ,
  and heading-r-intro's 4 ϕ become φ, matching the glyphs.
- Fresh parse of Formal Logic: 78 units changed in place, 2 banners. Its wrong-path
  count goes 302 → 304 because the restored symbols lengthen sections and the packer
  cuts 3 more chunks; all 302 v7 chunks already had wrong paths.
- Fresh parse of Octave: in one paragraph (page 148) the restored ∫∫ makes ODL split
  "If z = f(x,y) is nonnegative on D, then" into its own block after the rest of the
  sentence. The text is kept; the reading order of that line is not.

### #14 Split ligatures

- The Science of Sleep: **556 → 1** in the replay and in the fresh gate (555 spaces
  dropped). The one left ("signiﬁ cant", page 59) has no proving glyph in its box.
- Nothing else changes. In the gate, the Entrepreneurship Toolkit's 10 "ﬀ " sequences
  are real word ends ("staﬀ needed", "oﬀ the") with no space inside the glyph; in the
  replay, the other 107 sequences in 8 books have no proof either.
- It runs before furniture is frozen, so a repeated line keeps one text key.

## Outside the gate: fresh v7 and v8

| Book | Wrong-path v7 → v8 | What changed |
| --- | ---: | --- |
| Conservation Techniques | 0 → 0 | 93 capitals headings, 1,054 body blocks gain their section; 202 margin paragraphs discarded as banners |
| College Research | 66 → 67 (25 without the measure's 42 margin-title artefacts) | 90 chapter headings from the outline, 747 body blocks gain their chapter; 113 running heads out of chunk text; 14 demotions |
| Formal Logic | 302 → 304 | TeX maps (above); 2 banners |
| GNU Octave tutorial | 103 → 55 | 75 demotions, 30 banners and the TeX maps |

## Timing

The final gate took 2,577 s of server parse time against v7's 2,284 s (+13%), on a
machine shared with knowledge-base backfill workers. A sample every minute during the
gate read host CPU at 67% on average (28-100%, 16 logical CPUs), with a median of 7
Python processes on the host (up to 26); the gate container itself used 1 to 4 CPUs.
The OCR-heavy Business Plan Guide accounts for 107 s of the difference (307 → 414 s)
and OpenStax Chemistry for 50 s. Replayed alone, role correction costs 0.2 s to 1 s
more per document (the margin-band spans) and the ligature pass under 0.1 s, so most
of the difference is load. The earlier six-rule gate, run beside two replays, took
2,808 s.

## Reproduction

Raw outputs, scripts and logs are in the ignored `reports/local/2026-09-24-parser-v8-gate/`:

- `v7/` (copied from the v7 gate), `v8c/`, `snapshots/parser-c/`, `compare-v7-v8c.json`,
  `summary-v8c.txt`, `missing-v7-v8c.json`, `load-v8c.log`; the six-rule gate in `v8b/`
  with `compare-v7-v8b.json`; `v8a/` is an abandoned first run;
- `roles-b.json` (`role_replay.py`), `path-variants-b.json` (`path_variants.py`),
  `text.json` (`text_replay.py`), `capitals-recount.json`, `outline-replay.json`
  (`outline_replay.py`), `marker.log` (`marker_run.py`), `questions.md`;
- `extras/` with `x7/`, `x8c/` and `compare-x7-x8c.json`.

```sh
GATE=bench/parsers/reports/local/2026-09-24-parser-v8-gate
S=$GATE/scripts
docker run -d --name capy-kb-parser-v8-gate -p 127.0.0.1:18097:8090 \
  --memory 7g --memory-swap 14g --cpus 4 -e PARSER_TOKEN \
  -e CAPY_MAX_SOURCE_BYTES=536870912 [the builder container's other CAPY_* env] \
  --mount type=bind,source=$GATE/snapshots/parser-c,target=/app/parser,readonly \
  capy-kb-parser:pilot-v7
PARSER_TOKEN_V8C=... uv run --project pipeline python bench/parsers/scripts/gate_parser_fresh.py \
  parse --manifest $GATE/gate.json --arm v8c=http://127.0.0.1:18097 --output $GATE
uv run --project pipeline python bench/parsers/scripts/gate_parser_fresh.py compare \
  --manifest $GATE/gate.json --output $GATE --arms v7 v8c \
  --gold bench/parsers/fixtures/heading-release-gold-2026-09-20.json \
         bench/parsers/fixtures/heading-scope-release-gold-2026-09-20.json \
  --measure-dir data/knowledge-base/opus-intake-2026-09-23/section-paths
python bench/parsers/reports/local/2026-09-23-odl-thin-images-gate/scripts/gate_summary.py \
  $GATE/compare-v7-v8c.json
uv run --project pipeline python $S/classify_missing.py $GATE v7 v8c
uv run --project pipeline python $S/role_replay.py $GATE/roles-b.json
uv run --project pipeline python $S/path_variants.py $GATE/path-variants-b.json
uv run --project pipeline python $S/outline_replay.py $GATE/outline-replay.json
uv run --project pipeline python $S/text_replay.py $GATE/text.json
uv run --project pipeline python $S/marker_run.py $GATE/marker JAR name=PDF ...
```
