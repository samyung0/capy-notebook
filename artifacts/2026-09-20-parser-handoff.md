# Parser handoff: math outside the text layer, and why the tests never saw it

Date: 2026-09-20. For Epo, who will do the parser-side fixes (decision 2026-09-19:
parser fixes deferred to the developer). Evidence comes from the Opus parser review
of 2026-09-19 (`review-parser-state.md` in the session scratchpad), the physics run
`data/knowledge-base/runs/physics/`, and the checks below, all reproducible on this
PC. Nothing in the library builder depends on these fixes: the builder now recovers
text from page images (decision 2026-09-20), which is why the fixes can wait.

## What runs today

Parser `odl-2.5.7-refined-rapidocr-v4` (`parser/app.py:46-53`), chunker v10
(`pipeline/pipeline/retrieval/chunking.py:53`). PDF to chunks: font repair, Java ODL
2.5.7 (`--table-method cluster --include-header-footer`), block flattening
(`parser/odl/adapter.py`), order and heading repairs (`parser/odl/headings.py`),
context, lists, exponents, columns, furniture freeze, table recovery, RapidOCR only on
pages with fewer than 40 text-layer characters (`parser/odl/ocr.py:20-21,99`); then
the ingest worker packs blocks into chunks and scores each chunk's confidence
(`pipeline/pipeline/retrieval/confidence.py`).

Confidence is a recall: the share of the chunk's word tokens (`\w` runs after NFKC and
lowercase, `confidence.py:33-39`) that occur anywhere on the chunk's cited pages in
the PDF text layer (`confidence.py:42-46,70-71`). Operators, `$`, `=`, fraction bars,
sub- and superscript positions and word order are discarded before the comparison.
A "differs from the source text layer" reason appears below 0.85; the chat capture
rule fires below 0.9; the builder used to flag below 0.8.

## The failure

**Mechanism (a): math that is not in the PDF text layer.** OpenStax web PDFs are
produced by Prince (`producer: Prince 16.2`, checked with PyMuPDF on the physics
source). Prince draws inline math, numbers inside formulas and equation lines as
vector paths. Page 99 of physics has 70 vector drawings and its text layer literally
reads `Distance is  and displacement is .`; the numbers 35, 43, 79 are not in the
layer at all. The parser therefore emits text with holes, the chunk agrees with the
layer word for word, and confidence is 1.0 with no reason. The parser produced zero
`equation` blocks across the 875-page book; only 8 chunks contain a `$`.

Examples, all confidence 1.0 in `data/knowledge-base/runs/physics/books/physics/corpus.json`
(see `recovery.original_text` next to the corrected `text` where a correction was applied):

| Chunk | Page | Text layer gives | Printed page has |
| --- | --- | --- | --- |
| `chk_120e05cfeb2eaf_350` | 99 | `walks  to the left,  to the right` | 35 meters, 18 meters, 26 meters; 79 m, -43 m |
| `chk_120e05cfeb2eaf_344` | 97 | `average velocity for only the first four seconds` with the answer values missing | 1 m/s, 0 m/s, 2 m/s |
| `chk_120e05cfeb2eaf_347` | 98 | answer options with `v` only | four `v_avg,L = ... v_avg,R` formulas |
| `chk_120e05cfeb2eaf_365` | 103 | `with a displacement of .` | 14 cm, 63π cm, 7 cm |
| page 262 | 262 | `Cancel m and substitute.` | the `g = GM/r^2` worked line, 6.67 |
| page 616 | 616 | `To store  on this capacitor, what voltage battery` | the charge and voltage values |

Prevalence: the review's random audit found 32 of 93 unflagged physics chunks
unfaithful (34%); a textual hole proxy (a preposition followed by punctuation, empty
answer letters, double spaces inside prose) marks 727 physics chunks (23%), and 176,
161 and 163 chunks in the three statistics books (12-15%), of which confidence flags
1, 5, 7 and 0. The Qwen page-transcription run on 2026-09-20 will give the exact
count for physics (aligned versus original text).

**Mechanism (b): math that is in the layer but destructured by ODL.** Known since
2026-09-16 (`bench/parsers/reports/2026-09-16-odl-textbook-quality-review.md` s.2,
`2026-09-16-odl-broad-spectrum-output-review.md` "Physics"): OS4 p431 `27/212` read
as `21227`, the CMEX radical glyph as `q`, Bayes numerator and denominator as separate
misordered blocks, `K = 1/2 m v^2` as `1 / 2 / mv2 [kinetic energy]. / K =`, table
powers `103`, `10-2`. Scores 0.946 to 1.0, no reasons, because the tokens are all
present in the layer and order is ignored.

**Two other physics-specific defects**, lower impact, same root (rules tuned on the
statistics books):

- `Access for free at openstax.org` is a level-25 heading on 434 pages and sits in
  477 chunk section paths (15%). The running-banner rule (`parser/odl/headings.py:88-109`)
  only groups a banner that carries a folio, and headings are excluded from the
  repeated-text furniture check (`chunking.py:633`).
- `Contents › PREFACE ›` prefixes 99% of physics `indexed_text`: the level-1 `Contents`
  heading from the front matter is never popped, so every chunk's embedding input
  starts with it. Workspace uploads of the same PDF get the same prefix.

## Why the tests and experiments never caught mechanism (a)

1. **Every fixture PDF has its math in the text layer.** The three pilot books are
   LaTeX products (`os4.pdf` and `ahss4.pdf`: creator `LaTeX with hyperref`, producer
   Quartz; `lsj.pdf`: `LaTeX via pandoc`, xdvipdfmx). LaTeX embeds math as glyphs
   from Computer Modern fonts, so the layer holds every symbol, and the failures seen
   were destructuring, mechanism (b). The broad-spectrum sources
   (`bench/parsers/fixtures/odl-broad-spectrum-sources.json`: an OSU cell-biology text,
   a Lyryx microeconomics text, Crowell's Simple Nature) and the earlier ODL agentic
   corpus (`bench/rag/fixtures/local/2026-09-09-odl-agentic`) are likewise LaTeX,
   Word or InDesign exports with glyph math. No fixture is a Prince or browser-printed
   PDF, which is what OpenStax, LibreTexts and most web-first open textbooks ship.
2. **The frozen checks are source-bound to the text layer.** `textbook-recovery.json`,
   `odl-broad-spectrum-controls.json` and the structure witnesses assert headings,
   table associations and retained text that a reviewer read from the rendered page,
   but every check was authored on a book where the layer was complete, so "text that
   is not in the layer" was never a check category. The selective-recovery cases
   (`selective-recovery-cases.json`, 16 crops) target formulas and tables the parser
   destructured, not text it never received.
3. **`test_confidence.py` tests the function's own contract.** Its cases are agreement,
   drift, ragged tables, page coverage, OCR pages and font-repaired PDFs
   (`pipeline/tests/test_confidence.py:16-190`). All of them build the expectation from
   a text layer; a chunk that matches a hole-ridden layer is, by that contract, a
   correct 1.0. Nothing asserts "the page shows more than the layer says".
4. **Page coverage runs the wrong way.** `confidence.py:121-125` asks how much of the
   layer's text the chunks cover; it cannot ask how much of the printed page the layer
   covers, because it has no source of truth other than the layer.

So the tests were faithful to their design: they measure the parser against the text
layer, and this failure is the layer itself being incomplete.

## How to reproduce in ten minutes

```bash
uv run --project pipeline python - <<'EOF'
import pymupdf
d = pymupdf.open("data/knowledge-base/sources/a3f75487411ef13d0270c65fc801ceff2b28e6b339afed9b407fe477f7e8453e.pdf")
p = d[98]  # page 99, one-based
print(d.metadata["producer"], "| drawings:", len(p.get_drawings()))
print([l for l in p.get_text().splitlines() if "Distance is" in l or "walks" in l])
EOF
```

Then compare with `data/knowledge-base/runs/physics/pages/99.jpg` (rendered by the
builder) or open the PDF at that page.

## Options the review costed

- **A3, detect math outside the layer** (medium): where a text line has a gap that
  coincides with vector drawings or an inline image, emit a `[math]` placeholder and a
  confidence reason `math not in text layer`. Does not recover the math, but makes the
  loss visible to confidence, to the chat capture rule and to any selector. PyMuPDF
  drawings are already read in `parser/odl/exponents.py`.
- **A1, folio-less banner** (small): a margin heading with identical text on 3 or more
  pages becomes `discarded`; extends `headings.correct_roles`; the shared-fix harness
  already checks banners.
- **A2, front-matter ancestry** (medium): a level-1 or level-2 heading such as
  `Contents` or `PREFACE` that precedes the PDF outline's first chapter must not parent
  the book; the rule must not drop real chapters.
- **A5, CMEX and radical glyph mapping** (small): `fonts.py` extension for LaTeX books;
  recovers roots and stretched parentheses, not fraction scope.
- **A4, column-aware boundaries on numbered exercise pages**: rejected globally on
  2026-09-13 for retrieval regressions; a narrow rule is unmeasured, higher risk.

None of A1-A5 restores the dropped physics numbers; that is what the builder's page
transcription does. Any of them changes the parser or chunker identity, which
invalidates parse donors for workspace uploads and needs a rebuild of the parser
container on the ingest host (runbook 7).

## What to add to the tests when you fix it

- One Prince-produced fixture page (physics p99 is CC BY 4.0 and can be committed as a
  single-page extract) with a frozen check that the chunk text contains `35 meters`
  after the fix, or at least a `math not in text layer` reason before it.
- A confidence test where the layer is a strict subset of the printed words, asserting
  a reason rather than 1.0, once A3 exists.
- A banner check for a folio-less running header, and a section-path check that no
  chunk path starts with `Contents ›` on a book with a PDF outline.
