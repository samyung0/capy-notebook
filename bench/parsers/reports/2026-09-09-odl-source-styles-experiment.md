# Native table-cell background recovery

The French factor table's 15 yellow cells can be recovered from PDF drawing
rectangles without OCR or captioning. All 49 signed values remain exact, including
the 34 cells without yellow. The complete table, all column labels and the printed
explanation of yellow significance remain together in one production chunk.
No production code, source PDF or model setting changed.

## Source and candidate

The original `taln-complexity.pdf`, source page 8, was rendered and reviewed before
the candidate ran. Its SHA-256 is
`bf082a428310d35390cc83cb475094f143642dd8cfc1c165a2144cca85215294`.
The [frozen checks](../fixtures/odl-source-style-checks.json) record every numeric
row and yellow column. These are AI source judgments on a known development
document, not independent population labels.

OpenDataLoader's native JSON already contains cell rectangles and exact values.
Its cell text color describes the black glyphs, but the yellow is separate PDF
drawing data. The candidate uses [PyMuPDF drawing extraction](https://pymupdf.readthedocs.io/en/latest/page.html#Page.get_drawings)
to match an opaque rectangular yellow fill to a native table cell. It requires
at least 80% overlap in both directions and exact agreement between the cell
text and source words. A later overlapping fill rejects the match. It appends
the literal annotation `[yellow background]` to that cell's text. The exact RGB,
rectangle, drawing sequence, native cell ID and source text are retained.

It does not assign statistical meaning to color. That meaning is supplied by
the document's original caption, which survives in the same chunk. The pilot
only names yellow, using red and green at least 0.85 and blue at most 0.6.
Other colors, raster highlights, rotated/cropped pages and ambiguous matches
are outside this candidate. The guard is not a complete PDF visibility engine;
image overlays, clipping and transparency groups need separate validation.

## Results

| Check | Baseline | Candidate |
| --- | ---: | ---: |
| Exact signed values | 49/49 | 49/49 |
| Source-yellow cells represented | 0/15 | 15/15 |
| Incorrect yellow labels on the other numeric cells | 0/34 | 0/34 |
| Complete annotated source rows with headers in one chunk | 0/7 | 7/7 |
| Full French document production chunks | 42 | 42 |

The baseline already retains numeric rows and headers. The last quality row
requires the previously missing color annotations. It must not be interpreted
as zero baseline numeric-row accuracy. The earlier MinerU source review also
reported missing yellow-cell assignments; no new MinerU execution ran in this
lane.

The same rule was applied to all eight original PDFs, 254 pages, against their
saved Java JSON. It modified only these 15 cells in the French document. The
other seven native documents remained identical. This is a useful unchanged
control result, not evidence that all important colors in those documents were
found. Some have no native table object to annotate.

The existing strict structured chunker rejects a malformed native table in the
intact Chinese document in both baseline and candidate. The runner records that
error explicitly and still saves the successful production chunks. It does not
replace the failed structured result or count it as a successful empty result.

## Cost

Final runs used the idle ingest VM, one CPU and a 1 GiB container limit, with
network disabled and source inputs mounted read-only. Image identity was
`sha256:bdb714909ad328793818bdf5d3432cd483be5af357fe5a491687d24359ba0ce5`.
PyMuPDF is 1.28.2. These are added processing costs on saved parser output.
They include opening the PDF, copying native JSON and inspecting source cells;
they exclude Java, chunking, imports, captions and indexing.

Three final French-document observations were 0.1607, 0.1529 and 0.1622 seconds,
with a 0.1607-second median. Across the eight intact documents, the sum of one
observation per document was 1.2144 seconds. This is not a measured combined
ingest time or a percentile estimate. Filesystem caches were available.

An earlier implementation spent 4.5114 seconds inspecting cells even on pages
without yellow drawings. Checking for yellow drawings before extracting source
words reduced that to 1.2144 seconds with identical annotations and output
content. Both attempts are retained. This optimization changes eligibility
work, not the accepted cell matches.

## Reproduction and evidence

The [runner](../scripts/experiment_odl_source_styles.py) has a focused check for
yellow versus white/blue backgrounds, later opaque occlusion and unchanged input:

```sh
uv run --with pymupdf==1.28.2 python bench/parsers/scripts/experiment_odl_source_styles.py --check
```

Run the experiment with explicit `--pdf`, `--native`, `--output` and optional
`--checks` paths. The output directory must be new. The check fixture must match
the source PDF hash. Output includes native candidate JSON, cell receipts,
production/structured content and chunks, source/dependency hashes and timings.

Raw evidence is in `reports/local/2026-09-09-odl-source-styles/`. Final VM outputs
and executed sources are in `vm-results-v3.tar.gz` and its extracted `vm-v3/`
directory. The earlier `vm-results-v2.tar.gz`, local `run-r1` and `run-r2` preserve
development observations. Source-image and exact final row/color checks are
recorded in `verification.json`. All final output hashes and the independent
review are retained with the overall experiment's evidence manifest.

This supports a narrow native annotation step for already recognized tables.
It does not solve unrecognized table geometry, grouped headers, formula notation
or model-generated graph descriptions.
