# ODL thin image records and extraction accuracy

2026-09-23. Research into two questions about the knowledge-base builder's parser,
`odl-2.5.7-refined-rapidocr-v6+eaedb32c`, whose `parser/` code is unchanged at HEAD
`c9b317a7`:

- why OpenDataLoader (ODL) emits formula bars as image records;
- where extraction accuracy can improve.

No production code, live container or library data was changed; the candidate code
ran in throwaway containers. Nothing was committed, deployed, ingested or published.

## Summary

- **The thin records are TeX rules drawn as images.** dvips paints rules with a
  one-pixel `imagemask`, and Ghostscript 10.01.2 kept each one as a 1x1 inline stencil
  image. veraPDF makes an image chunk of every inline image, ODL writes all of them,
  and our adapter passes them on.
- **No ODL option filters images.** The fix belongs in our refinement, with an optional
  rewrite of the masks as fills before Java. It is also worth reporting upstream.
- **It is one case of a larger problem.** 63% of the library's 25,145 parser image
  records are not figures:
  - 12,916 repeated badges and icons;
  - 477 more slivers;
  - 2,530 formulas set as pictures.
- **Where extraction loses content.** The 15,511 repair records point to maths, tables
  and diagrams. Of the five maths mechanisms, two are not fixable here (formulas set as
  pictures; script letters set in a text font). Three can be fixed before or inside
  ODL:
  - contradictory ToUnicode maps from Quartz re-saves (the NULs in ODE and Online
    Statistics);
  - ODL's tiny-text filter dropping thin glyphs (777 minus signs in First Course in
    ECE);
  - glyphs veraPDF cannot map, which ODL blanks: mPDF's ToUnicode ranges (the lost ﬁ
    ligatures), TeX fonts without ToUnicode, and TeX's `\not` slash. The slash turns ≠,
    ∉, ∌ and ≢ into =, ∈, ∋ and ≡ in Euclidean Plane and Formal Logic, which reverses
    their statements.
- **Our adapter drops every table nested in a list item:** 8,819 characters in 15
  books, including Game Theory's payoff matrices.
- **A candidate parser measured on real books.** It combines a picture stage, the
  nested-table fix, pre-Java font repairs and negation composition. On the 66-document
  fresh-parse gate:
  - it keeps all 4,889 outline anchors, 270 roots and 26 gold witnesses;
  - it loses no heading ancestor and no text, apart from ODE's formula lines, which it
    corrects;
  - Game Theory gains one wrong-path chunk, from a path error that was already there.
- **The formula detector needs work.** It is 93% precise on the library but only 39% on
  the regression set, where it takes logos, key caps, chart pieces and 27 real figures
  for formulas. Six cheap tests raise that to 76% there and 98% on the library.
- **Two of College Research's four losses are ours.**
  - Our furniture rule drops repeated citations at page edges.
  - Our banner rules ignore running heads that ODL typed as paragraphs: 1,106 such heads
    in 68 books.
  - ODL types body paragraphs as headings, including lines carried over to the top of a
    page.
  - The chapter titles are printed only in running heads and the outline.
- **No fork.** Every measured gain is reachable without forking ODL.

## Question 1: why formula bars become image records

### Root cause

**The PDF draws the bars as images.** Euclidean Plane was made with LaTeX, dvips and
Ghostscript 10.01.2 (`producer: GPL Ghostscript 10.01.2`, `creator: LaTeX with
hyperref`). dvips paints every TeX rule through its prologue procedure `V`: fraction
bars, radical vinculums, overlines, `\hrule` and `\vrule`. `@rigin` binds `V` to `RV`
when the page matrix passes a resolution check, and to `QV` otherwise
(`texk/dvipsk/tex.lpro`):

- `RV` scales a one-pixel bitmap to the rule and paints it with `imagemask` (`Rx Ry
  scale 1 1 false RMat {BDot} imagemask`);
- `QV` fills a path.

Ghostscript's pdfwrite keeps the `imagemask` as a 1x1 inline stencil image. Page 11's
d2 formula (inside the page's `0.1 0 0 0.1 0 0 cm`):

```
q 1088.4 0 0 -4.8 2211.48 4150.68 cm
BI /IM true /W 1 /H 1 /BPC 1 ID <00> EI Q
```

That is a 108.84 x 0.48 pt black bar at (221.15, 233.41): the square-root vinculum,
exactly the record [512,359,764,360]. The PyMuPDF checks miss it because `get_images()`
lists only XObject images and `get_drawings()` only paths. `get_image_info()` includes
inline images and finds 1,196 placed images in the book:

- 1,195 1x1 stencil masks: 1,184 at 0.48 pt and 11 at 0.36 pt, consistent with dvips
  rounding rules to 4 and 3 device pixels at 600 dpi;
- one real raster figure, the hyperbolic tiling on page 89.

The same toolchain does not always do this. Electromagnetics Volume 1 (`dvips + GPL
Ghostscript 9.22`) has 44 `re f` rule paths and no 1x1 image on pages 41-60; its `V`
resolved to `QV`.

**veraPDF makes an image chunk of every image.** ODL reads content streams with
veraPDF's `ChunkParser` (validation-model 1.31.169). Its `BI` case and its image-XObject
`Do` case both build `new ImageChunk(parseImageBoundingBox())`. Neither checks for a
stencil mask, a 1x1 sample or a degenerate size.

**ODL keeps them.** Three places in 2.5.7 could drop them, and none does (constants
read from the jar):

- `TextProcessor.removeTextDecorationImages` drops only an image aligned with the
  preceding text chunk: top within 0.3 of its height, bottom within 0.1. That catches a
  highlight behind text; a 0.48 pt bar under a 10 pt line fails. `filterTinyText`
  applies to text only.
- `CaptionProcessor.isImageSubtle` calls an image "subtle" when its short side is under
  1% of its long side, but uses that only when attaching captions.
- `JsonWriter` writes every object except `LineArtChunk`, and each image is cropped
  from a 144 dpi page render. Page 11's crop is a 218 x 1 pixel PNG, all white.

**Our refinement passes them on.** `adapter.odl_content_list` maps every `image` node
to an `image` block, `refine._check_images` copies the files, and no stage looks at
image geometry. The figure stage then made a record per block.

### Side effects

- **Stolen captions.** Short bars are not "subtle" (a 20 pt fraction bar has aspect
  0.024), so they claim the next line as their caption. With the bars rewritten as fills
  (option B below), Euclidean's caption nodes fall from 72 to 7.
- **Time.** Rendering 1,196 PNGs takes the Java stage from 5.8 s to 13.2 s. The text is
  identical either way (307,597 characters).
- **Reading order.** `order.repair_page` abstains on any page holding a non-text block,
  so a fake image on a two-column page blocks the column-order repair.
- **Retrieval text: none.** The production chunker skips images without captions.

### The other thin records

Matched with `get_image_info()`, every record in `thin-figure-records-2026-09-23.json`,
plus Euclidean:

| Book | Records | What the PDF draws |
| --- | ---: | --- |
| Euclidean Plane | 1,195 | dvips rules, 1x1 stencil masks |
| Compressible Fluid Mechanics | 1 | a √ bar inside an embedded figure made by dvips |
| Brief Calculus, EE I, Intro to Logic | 2, 1, 1 | 1x1-pixel image XObjects drawn 1.3 x 0.9 units: invisible spacer pixels (Prince) |
| Electromagnetics Vol. 1 | 14 + 1 | 13x13-pixel ⊙ markers inside a vector diagram, and a 33x10 mask |
| Electromagnetics Vol. 2 | 6 | 5-pixel strips of a figure the PDF slices into 15 raster strips |
| Liquidity, Markets and Trading | 1 | a 1x727-pixel gold rule on the cover |

None is a figure. The figure stage's 2-unit rule (`c9b317a7`) drops all 1,222 thin
records in the library and no real figure.

### Most parser image records are not figures

Replayed over every saved parse (25,145 image blocks, 116 distinct books), counting
each block once in this order:

| Kind | Blocks | Books | Examples |
| --- | ---: | ---: | --- |
| Same picture on 5 or more pages | 12,916 | 59 | the 88x31 CC licence badge closing each module of the opentextbooks.org.hk (Prince) exports; Java's 113x113 icon on 187 pages and its 49 decorative 2025x17-pixel chapter bars; 730 of Euclidean's rule crops |
| Slivers: short side under 1 pt | 477 | 7 | the rest of Euclidean's rules, the spacer pixels, EM2's strips |
| Formula pictures on or between text lines | 2,530 | 34 | 1,520 inline, 1,010 display: Brief Calculus, business statistics, EE I |
| Everything else | 9,222 | | figures, photographs, icons |

That is 15,923 of 25,145 records, 63%, which are not figures. The 2-unit rule catches
1,222 of them.

**Detector precision: good on the library, poor on the regression set.** I labelled two
sets by eye:

- a per-book sample of 150 library detections from 35 books. 102 are formulas.
  Weighted by each book's detections, 93% of the library's detections are formulas,
  because Brief Calculus and EE I dominate. The misses are figure strips sliced into
  line-high pictures (Compact Anthology), number lines, music notation, UI screenshots,
  a thermometer photo and licence badges.
- all 207 pictures the gate arm retyped as formulas. Only 81 are formulas: chemistry
  structures and ion formulas, precalculus working, formula-editor icons. The other 126
  are calculator key caps (46), fragments of BOJ charts and blank title backgrounds (39),
  logos, badges and icons (14), and real figures (27): number lines, toolbar
  screenshots, circuit symbols and three MIT Strang figures.

**Six cheap tests fix most of it.** Each runs on a detected picture only: a small render
and a word lookup. A picture is rejected when:

- a caption line ("Figure 3", "Fig. 2.19") sits just below it;
- most of its ink is coloured;
- it is blank;
- a side is under 3 pt;
- words are drawn on top of it;
- more than 45% of it is mid-tone (key caps, badges).

| | Gate precision | Real figures retyped (gate) | Library precision, weighted | Brief Calculus kept | EE I kept |
| --- | ---: | ---: | ---: | ---: | ---: |
| detector as run | 39% | 27 | 93% | 1,722 | 409 |
| with the six tests | 76% | 4 | 98% | 1,708 | 403 |

The tests cost 2 of the gate set's 81 formulas (the caption test) and about 5 of the 102
formulas in the library sample (coloured formulas in the networking book). What stays
wrong in the gate set is:

- 9 Rice logos, one per OpenStax book on its copyright page;
- 10 key caps;
- 2 chart pieces;
- 4 figures: a thermometer photo, two orbital drawings and a triangle.

The tests were measured on these labels offline. The gate arm below ran the detector
without them.

**Tall "lines".** The first detector also took whole figures for inline formulas: 164
in MIT Strang's calculus. MuPDF merges a diagram's scattered labels into one tall
"line", and the relative-height test passed. The detector now ignores lines taller than
two body lines and pictures taller than 2.5 of them. That brought MIT Strang from 166
detections to 3, and BOJ only from 41 to 39. BOJ's pictures are 2 pt chart tiles and
blank backgrounds, which the six tests remove.

**A source-based test would not be safe.** Testing for a 1x1-pixel picture fails on
Marine Ecology, which stretches 1x1 white images behind two vector diagrams (page 33,
the chlorophyll structure). Those blocks are the diagrams' only regions.

### Where the fix belongs

- **ODL options: none.** 2.5.7 has no image size or repetition filter. `--image-output
  off` drops every image, and none of `--content-safety-off`'s values filters images by
  size.
- **Our refinement: yes.** The evidence is on the page, and the refinement already
  handles furniture text and dedupes image bytes. See option A.
- **Upstream: worth filing.** ODL computes `isImageSubtle` but still writes those
  images. veraPDF could treat a 1x1 stencil mask as the filled rectangle it paints.

## Fix options for the image records

### A. A picture stage in the refinement (prototype)

`pictures.py` runs right after adaptation, before image files enter the bundle. Each
image block gets the first rule that applies:

1. **Sliver.** Short side under 1 pt, or ODL's own subtle test. The block is dropped.
2. **Formula picture.** Never taller than 2.5 body lines.
   - Inline: overlaps a text line of body height (at most two body lines) that has text
     beside the picture, and is no taller than 1.8 times that line.
   - Display: alone between two body text lines.

   Either becomes an `equation` block. A display formula carries `[formula]` as its
   text. An inline one gets `[formula]` spliced into its paragraph between the words on
   either side, when that pair occurs once in the block. The prototype has no precision
   tests yet. A production version needs the six above.
3. **Repeat.** The same rendered picture on 5 or more pages becomes page furniture
   (`discarded`). A repeat stays a formula only when it is glyph-sized: at most 1.6
   times the page's median font size, and surrounded by different words in its
   placements. The licence badge always follows the same licence sentence; a reused
   `x` picture sits among different words each time.
4. Everything else stays an image.

The chunker skips `discarded` blocks and `equation` blocks without text, and the figure
stage reads only `image` and `chart` blocks, so no downstream code changes. A figure
wrongly retyped as a formula loses its figure record, which is why the precision tests
matter. Placeholders are the one change to retrieval text, and they need a decision
(open question 1).

Fresh parses of Brief Calculus, current code against the candidate:

| | Current | Candidate |
| --- | ---: | ---: |
| image blocks | 2,397 | 422 |
| repeats to furniture | – | 251 (the badge 250 times) |
| formula pictures | – | 1,722 (1,577 inline, 145 display) |
| inline placeholders placed | – | 1,305 of 1,577 (83%) |
| pictures in the 62 still-unrepaired chunks recognised as formulas | – | 289 of 299 |

Twelve sampled placements all read correctly ("the derivative of [formula] is
[formula]."). An unplaced picture has no single host block, or its neighbouring words
repeat in the block.

Other books in the same run:

- EE I: 1,364 → 782 image blocks (172 badges, 409 display formulas);
- Java, Java, Java: 712 → 104 (559 repeated icons and bars);
- Online Statistics: 246 → 162;
- Euclidean: 1,196 → 1.

### B. Rewrite stencil-mask rules as fills before Java

`fonts.repair_fonts` already writes a working copy for font repairs. Replacing `BI /IM
true /W 1 /H 1 /BPC 1 ID <00> EI` with `0 0 1 1 re f` under the same matrix paints the
same rectangle, and ODL then reads line art. On Euclidean:

- the text is identical;
- 1 image instead of 1,196, and 7 caption nodes instead of 72;
- Java takes 5.8 s instead of 13.2 s;
- renders match apart from anti-aliasing;
- one empty table that ODL built from diagram lines (page 172) disappears.

B fixes only dvips books, so it adds to A rather than replacing it.

## Question 2: where extraction loses content

### Repair census

Sources, all read only:

- the Opus intake's 57 scope `review.json` files;
- the Codex/Sol backfill's `review.json` files, skipping `superseded/`, `archive*/` and
  `before-*` copies;
- the `source_repairs` of every published corpus, which keep `original_text`.

**Deduplication and originals.** Records were deduplicated on book, chunk, kind and
`original_text_sha256`: 15,511 repairs in 106 books. For 9,395 of them the original
chunk text was recovered, from a corpus `original_text`, or from the corpus chunk when
its SHA-256 matches (books not yet imported).

**Cause buckets.** Each text repair gets one bucket. Measured evidence comes first: the
change in maths symbols (LaTeX mapped to Unicode), control characters, letter spacing,
pipe rows and word order. The agent's stated reason is only a fallback.

| Bucket | Repairs | Books | Parser? |
| --- | ---: | ---: | --- |
| Section path | 5,737 | 29 | yes; the v6 report's subject |
| Maths symbols | 2,139 | 51 | yes |
| NUL-garbled maths (ODE) | 150 | 1 | yes |
| Diagram content | 1,453 | 86 | partly: ODL writes no vector drawing |
| Table structure | 827 | 73 | yes |
| Truth tables | 23 | 2 | yes |
| Other dropped text | 426 | 43 | mixed |
| List structure | 201 | 18 | yes |
| Page furniture in text | 95 | 23 | yes |
| Code listings | 35 | 13 | yes |
| Reading order | 33 | 12 | yes |
| Letter-spaced text | 19 | 7 | yes |
| Formula pictures named in the reason | 16 | 1 | yes (most such repairs land in maths symbols) |
| Duplicated text | 8 | 8 | yes |
| Minor: ligatures, quotes, spacing, hyphens | 1,307 | 80 | mostly |
| Chunk overlap removed as "duplicate" | 1,398 | 33 | no |
| Chunk overlap restored again | 1,644 | 70 | no |

**Parser defects inside the "minor" and "dropped text" buckets.** Two of them are
measured below:

- in the Entrepreneurship Toolkit and Business Plan Guide, 303 of the 359 transcription
  repairs are about ligatures, dashes, quotes or letters;
- in The Science of Sleep, 276 repairs mostly rejoin split ligatures ("beneﬁ ts") and
  remove spaces after dashes.

**Overlap churn.** The two overlap rows are not parser work. One pass removed the
packer's 50-token overlap as "extraction duplicates", and a later pass restored it:
"Restored the chunk packer's intentional leading retrieval overlap".

**Maths subclasses**, counted by the symbols each repair adds:

- sub- and superscripts 1,460;
- Greek 843;
- minus 542;
- relations 284;
- fractions and roots 262;
- logic symbols 210;
- sums and integrals 163;
- script letters 136;
- ×, ⋅ and ± 132;
- accents 91;
- matrices 44;
- primes 26.

### Maths: five mechanisms

The same missing symbol has different causes in different books. For each maths repair
I read the MuPDF text layer inside the chunk's regions and asked whether the symbols
the agent added are already there:

| Book | Producer | Restored symbols in the text layer | Mechanism |
| --- | --- | --- | --- |
| Brief Calculus | Prince 9 | 0 of 622 | formula pictures |
| EE I, two business statistics books, operations management, finance | Prince 9/10 | 3 of 2,111 | formula pictures |
| Ordinary Differential Equations | Quartz 10.12 re-save | minus 206 of 231, Greek 4 of 967 | contradictory ToUnicode |
| Online Statistics | Quartz 10.15 re-save | Greek 34 of 216 | contradictory ToUnicode; formula pictures |
| First Course in ECE | calibre 6.4 | minus 265 of 321 | ODL tiny-text filter |
| Formal Logic | pdfTeX 1.40.17 | logic 69 of 93, script letters 0 of 1,193 | unmapped glyph names; script letters in a text font |
| Game Theory | xdvipdfmx | minus 59 of 64 | tables nested in list items, dropped by our adapter |

**1. Contradictory ToUnicode maps (ODE, Online Statistics).** Both books are TeX output
re-saved by macOS Quartz. Quartz kept correct `/Differences` glyph names but wrote
ToUnicode maps built from the old TeX code points. ODE's CMSY10:

- `/minus` and `/greaterequal` map to U+0000;
- `/element` maps to "2";
- `/equivalence` maps to "⌘";
- `/lessequal` maps to U+F8FF;
- `/negationslash` maps to "6".

Its Greek font maps `/delta` to "d" and `/alpha` to "a". veraPDF follows the ToUnicode
map, so ODL writes `d2 \u0000 8 \u0000 0` for "δ² − 8 ≥ 0". MuPDF skips entries mapped to
U+0000 and falls back to the glyph name, so its text has the minus and ≥ but still
reads δ as "d". These entries are the 776 NULs in the ODE corpus and the 542 in Online
Statistics. The parser output holds 633 and 242; the rest are copies in repair records.

Candidate fix, before Java, next to the existing CJK repair in `fonts.py`: rebuild the
ToUnicode entries that contradict the font's own glyph names.

- An entry is contradicted when a named glyph maps to a control character, a
  private-use code point or U+FFFD, or when a maths or Greek glyph maps to plain ASCII.
- A font needs two contradicted entries, or one mapped to a control character.
- Quotes and dashes mapped to ASCII stay as they are.
- CMEX bracket pieces map to U+239B-U+23AD rather than pypdf's private-use values.

With the jar on repaired copies:

| | ODE before | ODE after | Online Statistics before | after |
| --- | ---: | ---: | ---: | ---: |
| NUL | 633 | 0 | 242 | 0 |
| minus | 0 | 592 | 358 | 420 |
| Greek | 40 | 657 | 509 | 677 |
| ∈ | 0 | 166 | 0 | 0 |
| √ | 4 | 92 | 0 | 4 |
| private use | 12 | 0 | 2 | 2 |

Scored against ODE's 224 repairs (the parser blocks inside each repaired chunk's regions
against the agent's text), the candidate supplies:

- 566 of the 618 minus signs the agents added (92%);
- 218 of 291 relations (75%);
- 65 of 66 arrows and logic symbols;
- 111 of 174 big operators and roots (64%);
- 688 of 980 Greek letters (70%).

NULs in those regions fall from 698 to 0. ODE's `/negationslash` ("6") is also fixed:
with the slash mapped to U+0338 and composed (item 3), ODE gets 12 ≠.

Online Statistics' repairs mostly target
formula pictures, so they score poorly. Its 265 changed text spans were checked by
sample instead, and 14 of 14 were right: "coe\u0000cient" → "coeﬃcient", "deviation
\u0000" → "σ", "\u00000 + \u00001x1" → "β0 + β1x1". A dry run over all 182 library and
regression PDFs changes 6: ODE, Online Statistics, and the CMEX bracket pieces of three
TeX books.

**2. The tiny-text filter drops thin glyphs (First Course in ECE, Moloko).** ODL drops
any text chunk 1 pt tall or less (`TextProcessor.filterTinyText`, `TEXT_MIN_HEIGHT =
1.0`). For a Type3 font, veraPDF takes a chunk's height from the glyph program's `d1`
box. First Course's calibre export sets its maths in Type3 fonts. The minus glyph's box
is 0.04 em tall, about 0.6 pt at the 15.6 pt size used. Its ToUnicode maps code C3 to
U+2212 correctly, yet ODL writes "( 1)n" for "(−1)n". With `--content-safety-off tiny`,
all six minus signs on page 17 return.

Library-wide, 116 books with and without the flag: 6 books change, 884 characters are
added and none removed.

- First Course gains 777 minus signs, 5 en dashes and 5 underscores. In the refined
  parse the candidate supplies 377 of the 418 minus signs the agents added by hand.
- Moloko gains 70 tone marks (combining acute, grave and macron). But they come back at
  the end of their line, not over their vowels ("‘donkey’̄ ̀́ ́ ́"), so they are not
  usable as they stand.
- Compressible Fluid Mechanics gains 20 decimal points, Palula 2 dots below, EM1 4
  dingbats and EE I one arrow.

The risk is hidden text. `tiny` is one of ODL's content-safety filters against text used
for prompt injection. But 2.5.7 already leaves its hidden-text filter off by default
(`FilterConfig.filterHiddenText = false`), so white or covered text reaches us today.
Tiny text would be one more channel of the same kind. A fork could avoid the trade-off
by testing the font size instead of the box height.

**3. Unmapped glyphs become spaces (19 books).** When veraPDF cannot map a glyph it
yields U+FFFD, and ODL's `--replace-invalid-chars` default turns that into a space. A run
with a visible marker counted 66,198 such glyphs, in four groups.

- **mPDF's wide ToUnicode ranges** (Entrepreneurship Toolkit 1,325, Business Plan Guide
  345).
  - mPDF writes a single `bfrange <0000> <FFFF> <0000>`. The PDF specification lets only
    the last byte vary within a range. veraPDF reads it strictly and maps nothing above
    U+00FF; MuPDF reads it leniently.
  - The toolkit loses every ﬁ ligature and typographic dash and quote: "who were
    nancially independent", and 7 "bene ts" and 21 "de ne" in the published parse.
  - Splitting such ranges at byte boundaries before Java takes it from 1,325 unmapped
    glyphs to 0 (ﬁ 505, – 168, ’ 127 …).
  - Across all 182 PDFs, the split touches only these two books, and MuPDF's text of
    every page stays identical.
- **TeX fonts without ToUnicode** (Formal Logic 321, Compressible 3,636, EM2 2,917, EM1
  1,635, Open Logic 527, Octave 290).
  - pdfTeX and dvips output made without `glyphtounicode` uses glyph names veraPDF does
    not know. The `\not` slash, the next item, is the most harmful of them.
  - MuPDF does no better on most of these books; its text has control characters
    there.
  - A ToUnicode built from the embedded font's own encoding array takes Formal Logic
    from 321 unmapped glyphs to 1. That restores 69 negation slashes, which can then be
    composed with "=" into ≠, 38 ⋆ and 84 big brackets.
  - pypdf's glyph list maps `turnstileleft` to ⊣ where TeX means ⊢, so a production
    version needs a checked TeX glyph list.
  - Compressible barely changes; its unmapped glyphs are in other font types.
- **The `\not` slash reverses statements** (Euclidean, Formal Logic, both EM volumes,
  Compressible, Octave, Open Logic).
  - TeX draws ≠, ∉, ∌ and ≢ as a zero-width `negationslash` glyph placed before the
    relation.
  - The slash is lost in two ways. Euclidean's Ghostscript-written CMSY10 map has no
    entry for code 54, which `/Differences` names `/negationslash`. Formal Logic has no
    ToUnicode at all. Either way veraPDF blanks the slash, and the relation reads
    un-negated: "Note that ∡XOY = 0" where page 64 prints "∡XOY ≠ 0".
  - The marker run finds 1,302 unmapped glyphs just before a relation, in 12 books; 659
    of them are Online Statistics' shadow text.
  - Fix: map `negationslash` to U+0338, adding the ToUnicode entry where it is missing.
    After the text repairs, compose slash and relation into the precomposed negated form
    (TeX puts the slash first).
  - On Euclidean this recovers 110 slashes and composes 99 ≠, 3 ∉, 3 ∌ and 3 ≢. In the
    chunks they reviewed, agents restored 65 ≠, 25 ∉, 3 ∌ and 3 ≢.
  - The other 22 of Euclidean's ∉, and 227 in Open Logic, print as "∈" plus a separate
    "/" glyph ("x ∈/ A"). Telling those apart from a real slash needs a geometric
    overlap check, not done here.
- **Shadow text** (Online Statistics 53,664). Page 367 carries offset duplicates of its
  visible lines in a font veraPDF cannot map: "Diet and Health (DH) case study" appears
  again as 31 markers. Blanking them is right here. So no blanket "restore every
  unmapped glyph from the text layer" rule should run.

**4. Formula pictures (Prince exports).** There is no text to recover. The formulas
exist only as pictures, and these PDFs have no structure tree, `/Alt` or `/ActualText`.
The picture stage can mark them instead of filing them as figures.

**5. Script letters set in a text font (Formal Logic).** The metavariables 𝒜 and ℬ are
URW Chancery capitals (1,092 one-letter spans) named `A` and `B`, so every extractor
reads plain letters. Agents restored 1,193 script letters in this book. A rule mapping
one-letter spans of a chancery font to Mathematical Script capitals would fix it. It is
book-specific and would also convert decorative initials.

### Tables

- **Tables inside list items: dropped by our adapter.**
  - `adapter.node_text` walks `kids`, `list items` and `toc items`, never a table's
    `rows` and `cells`. A table that ODL nests in a list item, or a table in a table
    cell, loses every cell.
  - Against the native JSON page by page, 640 strings (8,819 characters) in 15 books
    are missing: financial statements in both accounting books, Game Theory's payoff
    matrices, Octave data tables, Java class boxes and a Formal Logic truth-table column.
  - Adding table rows to `node_text` (one line per row, cells split by `|`) restores Game
    Theory's Table 1.2.5 as "(100,−100) | (−10,10) / (0,0) | (−1,1)". The book's minus
    count rises from 357 to 414.
- **Truth tables read column by column.**
  - Formal Logic's truth tables have a header rule and column rules but no rules between
    rows. ODL's border detection builds one body row, so each cell holds a whole column
    ("1 1 1 1 0 0 0 0").
  - Splitting such rows at the text baselines the cells share would fix it. Native tables
    whose body rows stack three or more lines in every cell: up to 328 in 40 books. That
    is an upper bound, since cells of prose also match.
  - Not prototyped.
- **Borderless paradigms** (the grammars) and **rotated spreadsheet pictures** (Business
  Plan Guide, read column by column by OCR) need table detection without rules. That is
  larger work.

### Headings set only in capitals (Conservation Techniques)

Conservation Techniques is a 215-page LibreOffice 6.0 Writer PDF.

**The problem.**

- Its section headings use the body font at the body size: LiberationSerif 12 pt, not
  bold. Page 100's "LIMITATIONS OF HABITAT SUITABILITY MAPPING" is one.
- Only three things mark them: capitals, a line of their own, and a blank line above
  and below (27-28 pt gaps against a 14 pt pitch).
- ODL ranks headings by font size and weight, so it sees ordinary paragraphs.
- The parse has 101 such capital paragraphs and no heading among them; only the book
  title and the 27 chapter titles are headings.
- `build_excerpts` groups chunks by section path, so each chapter becomes one excerpt
  of 22 to 56 chunks.

No ODL option or style-ranking change in a fork would help, because the style is
identical.

**A replayed refinement rule.** I replayed one over 163 saved parses: 116 library books
and 47 other regression documents. It promotes a text block that is:

- all capitals: at least 2 words and 10 letters, with no final full stop;
- one line, with a gap of at least 0.8 of its height above and below;
- followed by body text: a lower-case letter within the next block's first 40
  characters;
- free of a folio, and not repeated on 3 or more pages. Callout labels such as "LINK TO
  LEARNING" repeat.
- not the capitals form of an existing heading or outline title. Running heads such as
  Open Logic's "74.3. STRONG INDUCTION" repeat "74.3 Strong Induction".

**Result.** 196 promotions in 18 documents:

- Conservation Techniques gets 93 of its 101 headings.
- The Business Plan Guide gets 50 ("DUE DILIGENCE", "TREND ANALYSIS").
- Message Processing gets 27 ("DEFINING CODES").
- No other document gets more than 5.

In a sample of 45 promotions outside Conservation, about 38 are real section headings.
The rest are:

- title-page author lines ("LEE A. SWANSON");
- placeholder text ("ID XXXX YYYY ZZZZ", twice);
- a formula set in capitals ("PV = (PMT, I/Y, N, FV)");
- two figure labels.

**Before adoption.** It is a heading rule, so it needs the full heading gate on a fresh
parse, as v6 had. Most library parses in the replay are v5 and keep running heads that
v6 removes. Excluding title pages and lines containing "=" would remove most misses. The
promoted level should sit one below the lowest heading in force.

### Four structure losses in Introduction to College Research

This is a 231-page Pressbooks export (Prince 14.3), admitted on 2026-09-24. Its
scope-001 review corrected 71 of 73 section paths and restored five lines. I traced four
separate causes in the saved v6 parse and a native ODL run. All counts are from saved
parses, and no fix below is built.

**1. Chapter titles exist only in running heads and the outline.**

- The book runs part › chapter › section. A chapter's first page opens with a picture.
  Its title is printed only in the running head ("COLLEGE RESEARCH AND INFORMATION
  LITERACY | 3") and in the PDF outline at level 2.
- ODL has no line to make a heading from, and the refinement never creates one. Every
  section therefore sits directly under its part.
- Library-wide, 185 outline entries in 23 books appear on their pages only in running
  heads. 61 of them are this book's.
- Fix: when no heading on an outline entry's destination page matches it, insert a
  heading from the entry at the top of that page. It needs the full heading gate.

**2. Our furniture rule drops repeated body lines at page edges.**

- `furniture.repeated_across_pages` freezes the text of any non-heading block that
  occurs on 3 or more pages, wherever it sits.
- The chunker's `_is_furniture` then drops each occurrence whose box is outside the
  interior (x 50-950, y 100-900).
- The Head, Fister and MacMillan citation is in 7 chapter source lists. The 4 in
  mid-page survive. The 3 at page edges are dropped: at the top of pages 22 and 46
  (y 73) and at the bottom of page 53.
- The "Rainbow Frequency" credit is printed 11 times and dropped once, at the bottom of
  page 47 (y 920).
- ODL and the parse keep all these lines. Only the chunker drops them.
- Library-wide, 703 furniture keys also occur in the interior, and their 2,317 edge
  occurrences are dropped (43,321 characters). Most are boilerplate that also recurs in
  the interior, such as a licence line kept 570 times. Citations, table headers and
  recurring labels are among them too.
- Fix: count a text as furniture only when at most half of its occurrences are in the
  interior. That restores 1,653 blocks (29,395 characters) in 76 books, and every repeat
  confined to the margins stays furniture. It changes chunk text, so it needs the
  body-retention gate.

**3. ODL types body paragraphs as headings.**

- ODL's own JSON has 21 level-11 headings in this book. All are body paragraphs in the
  body font and size (EB Garamond 12 pt, two of them italic).
  - Three continue a paragraph at the top of a page (pages 21, 35 and 201).
  - The rest are paragraphs such as page 37's, video notes and glossary definitions.
- No refinement rule demotes a native heading for being in the body style, so the text
  becomes a section title and exists only in the path.
- Library-wide, 568 native headings are 80 or more characters long and end with
  sentence punctuation. Of the first 60 in book order, 54 are paragraphs, quotations,
  footnotes, list items or exercises; 6 are real or run-in headings.
- Fix: demote a native heading set in the page's body font and size that ends with
  sentence punctuation. It needs the heading gate.

**4. Half the running heads stay body text.**

- ODL typed 103 of the book's 216 running heads as level-14 headings. The banner rules
  in `correct_roles` discard 102 of them.
- It typed 113 as plain paragraphs, which those rules never see: `_source_spans` only
  collects blocks ODL called headings. The 113 go into chunk text ("WHAT ARE
  ALGORITHMS? | 11").
- Replaying `correct_roles` on the saved parses with margin-band text blocks added to
  its candidates finds 1,106 more banners in 68 books, 114 of them in this book. All 60
  sampled are running heads, folios or repeated footers.
- Fix: that one change to the candidates. Banners also reset heading scope, so it needs
  the heading gate.

### Diagrams

ODL's `JsonWriter` skips every `LineArtChunk`, so no vector drawing reaches the parse.
The figure-stage commit `c9b317a7` now adds records for clustered vector drawings.
The labels inside those drawings still arrive as loose lines in prose chunks. That is
most of the diagram-content bucket (1,453 repairs in 86 books), which agents fill with
written descriptions. A parser stage using the same clusters could group the labels
with their drawing. Not measured.

### Smaller classes

- **Split ligatures in The Science of Sleep** (556 cases; 607 in 5 books). The PDF's own
  text layer has a space glyph drawn inside each ligature's box: ﬁ spans 406.7-414.0,
  the space 410.4-412.7. A refinement rule that drops a space lying inside the previous
  glyph's box would fix it. `--space-ratio` does not: raising it from 0.17 to 0.25 or
  0.33 leaves all 556 and joins 797 to 909 runs of words ("Combinethiswiththe…"),
  because this PDF has no space characters between words.
- **Letter-spaced text** (19 repairs). ODL inserts a space whenever a glyph gap exceeds
  0.17 em, which tracked headings do. The 2026-09-23 decision leaves the parser
  unchanged.
- **Page numbers in text** (95). Mostly handled by v6's folio rules.

## Candidate parser and its gate

One candidate combines the changes that need no product decision. Arm B adds the two
that change what ODL reads.

- **Arm A** (`candidate-parser.patch`):
  - the picture stage as prototyped: without the six precision tests, with placeholders
    on;
  - table rows in `adapter.node_text`;
  - three pre-Java font repairs in `fonts.repair_fonts`: ToUnicode entries that
    contradict their glyph names, `negationslash` mapped to U+0338, and wide ranges
    split at byte boundaries;
  - slash-and-relation composition after the text repairs;
  - ODL flags unchanged.
- **Arm B:** arm A plus `--content-safety-off tiny` and the stencil-mask rules rewritten
  as fills.

Both ran as the builder's parser service in a throwaway container of the pilot-v6
image. The patched `parser/` was mounted over `/app/parser`, with the builder
container's env and limits. The baseline is the `v6afresh` arm of the 2026-09-23 gate,
which is today's parser code.

Eight books outside the gate set went through `parse_pdf` in the same image, for the
current code and for each arm: First Course, Online Statistics, Brief Calculus, EE I,
Euclidean, Moloko, Java and Educational Psychology.

**A bug the gate caught.** The first version of the range split also read array-form
entries (`<09A9> <09B3> [<65E5> <5927> …]`) as ranges and dropped them. On BOJ page 48
that blanked kanji such as 金融 and 環境変化. The fix parses each entry whole and
rewrites a block only when its entries account for all of it. Checked on all 182 PDFs,
the fixed split touches only the two mPDF books, and MuPDF's text of every page is
unchanged by it. All of arm A was parsed again with the fix. The figures below are for
the fixed code.

**Reading the gate's body check.** `compare_body` counts a baseline block as missing
when its exact text no longer appears in the candidate's chunks. Any fix that changes
characters trips it: a NUL that became −, a blank that became ﬁ, table rows inserted
into a list item. `retention_check.py` sorts each missing unit into one of three kinds:

- kept: at least 95% of its letters and digits appear in order on the same page;
- changed in place: a block at the same position is at least 75% similar;
- real loss: everything else, which is then read by hand.

### Arm A

| | Baseline | Arm A |
| --- | ---: | ---: |
| documents, pages | 66, 16,924 | 66, 16,924 |
| outline anchors kept | 4,889 of 4,889 | 4,889 of 4,889 |
| roots | 270 | 270 |
| gold witnesses changed | | 0 of 26 |
| scope gold verdicts | | 6 of 6 pass |
| body blocks that lost a heading ancestor | | 0 |
| baseline units missing from the candidate's chunks | | 1,486 |
| of which real losses | | 17 |
| wrong-path chunks | 1,610 | 1,603 |
| documents with more wrong-path chunks | | 1 (Game Theory, 42 → 43) |

- **Missing units.**
  - 1,456 are kept or changed in place, and 13 have no letter or digit.
  - The 17 real losses are all ODE lines whose garbled symbols were corrected. Read by
    hand, each is the same formula with the right symbols.
- **Ancestry.** 7,226 body blocks show a changed ancestor, all in three books whose
  heading text changed:
  - the Business Plan Guide (5,764) and the Entrepreneurship Toolkit (778), whose
    headings got their dashes back. "CHAPTER 1 – DEVELOPING A BUSINESS PLAN" now also
    matches its outline entry.
  - ODE (684), where a formula that ODL takes for a heading lost its NULs.
- **Wrong-path chunks.** ODE's fall from 236 to 228.

**Game Theory, the one worse document.** Its payoff matrices on pages 30 and 31 came
back: 656 characters. The packer then split that section into three chunks instead of
two. The path was already wrong in the baseline: "2.1 Introduction to Two-Person
Zero-Sum Games" sits above "2.2.4 Check Your Understanding". No block's heading ancestry
changed (the ancestry check finds 0 in the book). So the bar fails by one chunk, from a
pre-existing wrong path that now covers more text.

**Text.** The arm adds 7,011 characters and removes 1,771.

- Every removed character is either one of ODE's contradicted mappings replaced in
  place, or half of a slash-and-relation pair composed into one character:
  - ODE: NUL 633, "2" for ∈ 166, "l" for λ 133, "q" for θ 102, "d" for δ 87, and so
    on;
  - composition: 4 ≠ in Game Theory, 3 ≰ in DMOI and 1 ≠ in Lille.
- The additions:
  - 649 minus signs, 505 ﬁ, 287 en dashes, 203 ’ and 177 ﬀ;
  - 3,509 characters of nested tables in 11 documents: mu-calculus's Arabic, the Korean
    of SNU Admissions, Game Theory's payoffs, DMOI's truth values, the rest of MIT
    Strang's contents;
  - 166 ∈, 133 λ, 94 θ and 88 δ in ODE;
  - 105 □ in the Business Plan Guide, whose checklist now parses as 13 more lists.

**Pictures.** Image blocks fall from 10,120 to 9,446:

- 207 retyped as formulas, at the 39% precision described in Question 1;
- 466 repeats made furniture. They are 26 distinct pictures, all decorative: chapter
  banners and icons in The Science of Sleep, deck logos, the LibreOffice logo, key caps
  and a blank answer grid;
- 1 sliver, Liquidity's cover rule.

### Arm B

Arm B's output equals arm A's, block for block, on 65 of the 66 documents. The
exception is MIT Strang, where 203 garbled formula lines gain or lose spaces and no
other character changes. No gate document has sub-1 pt glyphs or dvips stencil rules,
so the gate cannot tell the arms apart. Its checks match arm A's:

- the same anchors, roots and gold;
- no lost heading ancestor;
- the same 1,486 missing units, 17 of them real;
- the same Game Theory chunk.

Arm B's gains show only on books outside the gate:

- First Course in ECE: 777 minus signs. The candidate then supplies 377 of the 418 minus
  signs the agents added by hand.
- Moloko: 70 tone marks, placed at the end of their lines rather than on their vowels.
- Euclidean: with the masks rewritten, 7 caption nodes instead of 72, and Java takes
  5.8 s instead of 13.2 s. Arm A's sliver rule already removes the 1,195 records.

The arm B parse was interrupted after 29 documents when Docker Desktop stopped. It was
resumed after the restart. The gate script writes each document only after a complete
response, so no partial document entered the comparison.

### Verdict

Both arms keep every outline anchor, root and gold witness, and lose no heading ancestor.
They lose no text either: the 17 "real" losses are ODE's corrected formulas. Both miss the
letter of the bar on one document, Game Theory, by one chunk that carries a pre-existing
wrong path. The weak part is the picture stage's formula detector, 39% precise on this
set. It should not ship as run.

## Forking OpenDataLoader

A minimal fork would change these, set against the workaround measured here:

| Change inside ODL | Workaround outside ODL | What the fork adds |
| --- | --- | --- |
| Tiny-text filter tests font size, not glyph box (`TextProcessor.filterTinyText`) | `--content-safety-off tiny` | keeps the tiny-text guard, for the same 884 characters |
| Stop writing subtle and degenerate images (`ContentFilterProcessor`, `JsonWriter`) | picture stage (A) | nothing for slivers; repeats and formula pictures still need A |
| Lenient ToUnicode ranges, a TeX glyph list | pre-Java CMap repairs in `fonts.py` | nothing measured; the change is in veraPDF, a second repository |
| Emit vector drawings | figure-stage vector records (`c9b317a7`) | labels grouped with their drawing, for production too |
| Split rule-less table rows at baselines | a refinement stage | nothing; neither is built |

Cost:

- **Release pace.** ODL shipped 11 releases between 14 July and 22 September (2.5.0 to
  2.5.11), 4 of them in September. 2.5.8-2.5.11 change hybrid mode, dependencies and
  autotagging, and touch none of the issues here.
- **Churn in the files a fork would patch**, commits since March:
  - `TextProcessor.java` 4;
  - `ContentFilterProcessor.java` 7;
  - `JsonWriter.java` 5;
  - `CaptionProcessor.java` 3;
  - veraPDF's `ChunkParser.java` 15.
- **Packaging.** The parser installs `opendataloader-pdf==2.5.7` from PyPI with pinned
  hashes, and the jar ships inside the wheel. A fork needs a Maven build (2.5.7 was
  built with JDK 21), a vendored or published jar and a Dockerfile change, repeated at
  every rebase.

Every gain measured in this report is reachable without a fork: pre-Java PDF repairs,
the refinement, and one ODL flag. The one thing a fork adds is keeping the tiny-text
guard while restoring thin glyphs. That is better filed upstream, with First Course
page 17 as the reproduction.

## Prioritised improvements

Ordered by measured gain against risk and cost. Every change also needs the fresh-parse
gate.

| # | Change | Evidence | Cause | Measured gain | Cost | Extra check before shipping |
| ---: | --- | --- | --- | --- | --- | --- |
| 1 | Table rows in `adapter.node_text` | tables: 850 repairs in 73 books; 8,819 characters lost in 15 books | the adapter never walks table rows | Game Theory's payoff tables back, minus 357 → 414; gate: 3,509 characters back in 11 documents, nothing lost | ~8 lines | none |
| 2 | ToUnicode entries that contradict glyph names (pre-Java) | ODE's 211 maths repairs (150 with NULs); Online Statistics | Quartz re-saves; veraPDF trusts the map | ODE NUL 633 → 0; 92% of minus signs, 70% of Greek, 75% of relations | ~120 lines in `fonts.py` | dry run: 6 of 182 PDFs change |
| 2b | `negationslash` → U+0338 (pre-Java) and slash + relation composed (post-pass) | Euclidean and Formal Logic negation repairs; 1,302 unmapped glyphs before relations in 12 books | the slash has no mapping veraPDF knows | Euclidean: 99 ≠, 3 ∉, 3 ∌, 3 ≢ restored; gate: 8 more in Game Theory, DMOI and Lille | ~50 lines | part of 2's dry run |
| 3 | Split wide ToUnicode ranges (pre-Java) | 303 ligature and punctuation repairs in 2 mPDF books | mPDF's `<0000> <FFFF>` range; veraPDF reads it strictly | 1,325 → 0 unmapped glyphs in the toolkit; 345 characters and 13 checklists in the Business Plan Guide | ~50 lines | MuPDF text identical on all 182 PDFs |
| 4 | Picture stage: slivers and repeats | 63% of 25,145 image records are not figures; 1,222 thin records | veraPDF and ODL write every image; our adapter keeps them | Euclidean 1,196 → 1 image blocks, Java 712 → 104; gate: 466 repeats, all decorative | ~100 lines, no dependency | none beyond the gate |
| 5 | Banner rules also see margin paragraphs | College Research: 113 running heads in chunk text | `_source_spans` collects only blocks ODL called headings | 1,106 more banners in 68 books; 60 of 60 sampled are furniture (replay) | a few lines in `headings.py` | heading gate |
| 6 | Picture stage: formula pictures, with the six tests | Brief Calculus: 1,722 pictures filed as figures; 2,530 in 34 books | formulas exist only as pictures | precision 98% library, 76% gate (39% without the tests); Brief Calculus 1,708 kept | ~100 lines more | the six tests, then a book-sample review |
| 7 | `--content-safety-off tiny` | 542 minus repairs, 172 of them in First Course | glyph-box heights of Type3 and combining glyphs | +884 characters in 6 books, none removed; 90% of First Course's agent minus signs | one flag | decide the tiny-text trade-off |
| 8 | Formula placeholders | 62 unrepaired Brief Calculus chunks | formulas exist only as pictures | 83% of inline pictures placed; 97% of pictures in the unrepaired chunks recognised | part of 6 | decide the token and its effect on search |
| 9 | Furniture only when mostly in the margins | College Research: 3 dropped lines; 2,317 edge copies of 703 repeated texts | recurrence counted anywhere, copies dropped only at page edges | 1,653 blocks restored in 76 books (replay) | a few lines in `furniture.py` | body retention |
| 10 | Capitals-heading rule | Conservation Techniques: 101 missing headings, 28 excerpts for 536 chunks | style-free headings | 93 of 101 found; about 84% precision elsewhere | ~60 lines in `headings.py` | full heading gate |
| 11 | Demote body-style native headings | College Research pages 21 and 35; 568 sentence-like headings in the library | ODL's heading classifier | about 90% of the 568 are body text; not built | ~30 lines in `headings.py` | full heading gate |
| 12 | Headings from outline entries missing on their page | College Research: 71 of 73 paths lack the chapter; 185 entries in 23 books | the title is printed only in running heads | College Research's chapter level; not built | a heading-insertion step | full heading gate |
| 13 | TeX ToUnicode from the embedded encoding (pre-Java) | Formal Logic ≠ (16 repairs), ⋆, brackets; 9,326 unmapped glyphs in 6 books | pdfTeX or dvips without `glyphtounicode` | Formal Logic 321 → 1 unmapped glyphs | a checked TeX glyph list | per-book glyph review |
| 14 | Drop spaces drawn inside a ligature's box | The Science of Sleep's 276 ligature repairs | the PDF text layer itself | 556 splits in that book; not built | ~40 lines, source-proven | body retention |
| 15 | Split rule-less table rows at baselines | Formal Logic's 23 truth-table repairs | ODL's single body row | not built | a refinement stage | table gold |
| 16 | Stencil-mask rules as fills (pre-Java) | Euclidean | dvips `RV` rules | captions 72 → 7; Java 13.2 → 5.8 s | ~30 lines | dvips books only |
| 17 | Group labels with their vector drawings | 1,453 diagram repairs in 86 books | ODL writes no line art | not built | a cluster stage | figure gate |

Not recommended:

- the script-letter font rule (one book);
- a blanket "restore unmapped glyphs from the text layer" rule, which would restore
  Online Statistics' shadow duplicates;
- raising `--space-ratio`;
- an ODL fork.

## Recommendation

1. **Take the parts of arm A that need no product decision into the parser as v7.** They
   passed the gate above as part of arm A:
   - table rows in `adapter.node_text`;
   - the three pre-Java font repairs and the slash composition;
   - the picture stage's sliver and repeat rules.

   Game Theory's one extra chunk comes from an existing path error, not a new one. Keep
   the figure stage's 2-unit rule: it covers parses already made, and it does nothing on
   a v7 parse.
2. **Hold the formula-picture rule** until it has the six tests. Then re-run this gate and
   review a sample of books. Placeholders wait for open question 1.
3. **Fix the banner rules next.** Adding margin paragraphs to `correct_roles`' candidates
   takes 1,106 running heads out of chunk text in 68 books, and all 60 sampled were
   right. It needs the heading gate.
4. **Decide the tiny-text flag (arm B)** with open question 2. It changes nothing in the
   gate set. It is worth 777 minus signs in First Course. Moloko's 70 tone marks come
   back misplaced. If hidden text matters more, file the font-size test upstream instead.
5. **Next round, one gate each:**
   - furniture counted only when mostly in the margins;
   - demoting native headings set in the body style;
   - headings from outline entries missing on their page (College Research's chapters);
   - the capitals-heading rule, which Conservation Techniques is waiting for;
   - a TeX ToUnicode from the embedded encoding, with a checked glyph list (Formal
     Logic's ≠, ⋆ and brackets);
   - dropping spaces drawn inside a ligature (The Science of Sleep);
   - splitting rule-less table rows at baselines (truth tables).
6. **File upstream and keep ODL unforked:**
   - ODL writes images it already calls subtle;
   - `filterTinyText` measures glyph boxes;
   - `JsonWriter` drops all line art;
   - ODL types body-style lines as headings (College Research pages 21 and 35);
   - veraPDF reads wide ToUnicode ranges strictly and turns 1x1 stencil masks into
     images.
7. **Books.** New and unreviewed books parse with v7. Published books keep their parse
   under the v6 rule unless the developer chooses to re-parse the books the fixes change
   (open question 4). The review instructions could stop treating the packer's overlap
   as duplicates.

## Open questions

1. **Placeholders.** Should chunk text carry `[formula]` where a formula picture sits?
   It shows a reader and the chat agent that something is missing and which page to
   capture. It also adds the token "formula" to about 2,500 library chunks. The picture
   stage is useful without it. A neutral token such as `[picture]` would also suit the
   key caps and icons that pass the six tests.
2. **Tiny text.** Are 777 minus signs worth letting sub-1 pt text through, when hidden
   white text already passes? If not, the upstream font-size test gives both. Moloko's
   tone marks would also need their positions fixed.
3. **Transcribing formula pictures.** The PDF holds no text for them. The options are:
   - a formula-recognition model in the parser, a CPU cost against the 600 s document
     deadline (Brief Calculus alone has 1,722 formula pictures);
   - a builder stage, since Qwen already reads page images;
   - answer-time capture, as now.
4. **Re-parsing published books.** The fixes change text in ODE, Online Statistics, the
   Entrepreneurship Toolkit, the Business Plan Guide, First Course in ECE, Moloko,
   Euclidean, and the 15 books whose nested tables return. The v6 rule (keep published
   parses, patch by repair) would keep the agents' hand repairs. A re-parse would change
   chunk text and need a republish.
5. **Repeated pictures as furniture.** Every repeat sampled was decorative, and the
   stage keeps the block as `discarded` rather than deleting it. Should the ops Library
   show them?
6. **Evidence-Based Software Engineering.** Its 1.5 million vector paths exhausted a
   2 GiB heap in ODL's table-border merging locally; production took 488 s of Java at
   3 GiB. Any similar upload is a timeout risk.
7. **Review churn.** 3,042 records removed, then restored, the packer's designed
   overlap. The review instructions could say that the overlap is expected.
8. **Outline-backed headings.** Inserting a heading that the page does not print
   changes what a reader sees in the path. It is right for College Research, whose
   titles live in running heads. Is it acceptable in general, or only when a running
   head carries the same title?

## Reproduction

Kept locally (ignored) in `bench/parsers/reports/local/2026-09-23-odl-thin-images-gate/`:

- **Candidate:** `candidate-parser.patch`, against `parser/odl` at `c9b317a7`. It
  touches the adapter, fonts, java and refine, and adds `pictures.py` and
  `negation.py`. Arm B also sets
  `CAPY_SCRATCH_MASK_RULES=1` and `CAPY_SCRATCH_ODL_FLAGS='["--content-safety-off",
  "tiny"]'`.
- **Repair census:** `scripts/repair_census.py`, `repair_classes.py`,
  `cause_buckets.py`. `textlayer_recoverable.py` checks the MuPDF text layer.
- **Image census:** `scripts/thin_census.py`, `image_kinds_census.py`,
  `image_rules.py`, `repeated_images.py`, `inline_pictures.py`, `contact_sheet.py`.
- **Native runs:** `scripts/native_batch.py` runs the jar over every library PDF, one
  tag per flag set; `native_diff.py`, `adapter_loss.py`, `invalid_align.py` and
  `stacked_rows.py` analyse them.
- **Prototypes:** `tounicode_fix.py`, `split_bfrange.py`, `tex_tounicode.py`,
  `negation_fix.py`, `mask_rules.py`, `caps_headings.py`, and the checks
  `tounicode_dryrun.py`,
  `wide_bfrange.py`, `split_verify.py`.
- **Candidate runs:** `run_refine.py` (inside the parser image), `compare_arms.py`,
  `score_repairs.py`, `arm_textdiff.py`, `retention_check.py`, and `wrong_diff.py` for
  the chunks the section-path measure calls wrong in each arm.
- **Formula precision:**
  - `eq_grid.py` and `lib_grid.py` draw the review sheets;
  - `formula_features.py` computes the six tests' inputs;
  - `formula_eval.py` scores them against the labels (`formula_filters.py` holds the
    gate labels);
  - `labels/lib_sample_formula.json` is the library sample.
- **College Research:** `icr_checks.py`, `outline_banner_only.py`, `edge_rule.py` and
  `banner_replay.py`. All four replay saved parses read-only.

The arms ran as the parser service in throwaway containers of
`capy-kb-parser:pilot-v6`:

- the patched `parser/` mounted read-only over `/app/parser`;
- the builder container's env and limits (7 GiB, 4 CPUs, 1,800 s deadline);
- the source cap raised to 512 MiB for chemistry and biology.

The baseline is the `v6afresh` arm of the 2026-09-23 gate, the same parser code as
HEAD. No image was built. Docker Desktop stopped once during arm B; the parse resumed
after the restart. The containers were removed afterwards.

```sh
PARSER_TOKEN_CANDA=... uv run --project pipeline python bench/parsers/scripts/gate_parser_fresh.py \
  parse --manifest GATE/gate.json --arm candA=http://127.0.0.1:18095 --output GATE
uv run --project pipeline python bench/parsers/scripts/gate_parser_fresh.py compare \
  --manifest GATE/gate.json --output GATE --arms v6afresh candA \
  --gold bench/parsers/fixtures/heading-release-gold-2026-09-20.json \
         bench/parsers/fixtures/heading-scope-release-gold-2026-09-20.json \
  --measure-dir data/knowledge-base/opus-intake-2026-09-23/section-paths
uv run --project pipeline python GATE/scripts/retention_check.py GATE v6afresh candA
```
