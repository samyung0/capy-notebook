# ECB PDF reader repair experiment

A PyMuPDF save with explicit encryption preservation makes the current ODL
parser accept a derived copy of the ECB Annual Report 2024. Every page's
extracted text and 72 dpi pixels matches
the original. This is a post-holdout development experiment. The original ECB
failure remains in the 34-PDF holdout, and production code is unchanged.

## Source and isolated run

The source is the [ECB Annual Report 2024](https://www.ecb.europa.eu/pub/pdf/annrep/ecb.ar2024~8402d8191f.en.pdf),
200 pages and 4,170,011 bytes. An independent download into memory from that
exact URL returned the same bytes and SHA-256. The earlier Windows rename lock
did not leave a truncated or modified test source.

| Identity | SHA-256 |
| --- | --- |
| Original | `9b1fa8402e6a50c318dba51c8158a14a54319dab92b3f25e0dfbc4a0e4ab43cc` |
| Derived | `4f65c00aa381bd2f8094bbfdf866d1ab6a59c6bdb477e3ba6a2806d47eea2cf8` |

Two save settings were tested with PyMuPDF 1.28.2. The initial arm used
`tobytes(garbage=0, deflate=False, no_new_id=True)`. After the encrypted scan
control exposed encryption removal, the second arm explicitly preserved it:

```python
derived = document.tobytes(
    garbage=0, deflate=False, no_new_id=True,
    encryption=pymupdf.PDF_ENCRYPT_KEEP,
)
```

The initial save took 0.259 seconds; the revised save took 0.215 seconds.
Both produced the same 4,342,092 ECB bytes. ODL 2.5.7 and the full
current `odl.refine.parse_pdf` ran in `capy-kb-parser:pilot-v4`, using that image
only for dependencies. Imports came from the read-only current `/repo/parser`
and `/repo/pipeline`. The isolated container had no network, two CPUs, 4 GiB
memory, a 2 GiB Java heap, and local `/tmp` scratch. It never contacted the
shared parser service. The Java timeout was 240 seconds.

Current parser file hashes matched the original holdout's `parse/frozen-inputs.json`
before and after parsing. All original PDF hashes remained unchanged.

## Result and fidelity

Fresh Java extraction of the original failed again with 297 `Incorrect xref
section` warnings followed by `unknown type of page tree node`. The derived
copy completed the full current parser in 25.050 seconds, including 8.511 seconds
in Java and 10.392 seconds in selective OCR. It returned all 200 pages, 1,826
blocks, 57 tables and 77 images. OCR ran on the cover only. Font repair changed
zero fonts; the exact derived PDF reached Java and the later parser stages.
The revised arm repeated the full run in 25.129 seconds, with 8.015 seconds in
Java. It produced identical native JSON and the entire same `content_list.json`.

| Comparison on ECB | Result |
| --- | --- |
| Native extracted text SHA-256, every page | 200/200 identical |
| RGB pixel SHA-256 at 72 dpi, annotations enabled | 200/200 identical |
| MediaBox, CropBox, displayed rectangle, rotation and raster size | 200/200 identical |
| Full outline entries and destinations | All 96 identical |
| Page links | Every page identical |
| Metadata, XMP and page labels | Identical |
| Catalog key/value map and structure-tree root reference | Identical |

The raw catalog serialization changes dictionary key order. Its textual
inequality in `fidelity.json` therefore does not indicate a changed catalog
value. The later `stream-structure.json` records the key/value comparison.

## What caused acceptance to change

The publisher's file has six `startxref` revisions and two `/XRefStm` pointers,
so it uses incremental updates and hybrid cross-reference information. One
hybrid stream's index lists objects such as 1043 and 1045 whose classic xref
entries are marked free; the Java warnings occur around these sections. PyMuPDF
opens the original with `is_repaired=False` and resolves its pages and tags.

Saving flattens the incremental history into one classic xref table, preserves
the 6,049-slot object numbering space and expands object streams. The only 18
decoded stream objects that disappear are 16 `/ObjStm` containers and two
`/XRef` containers. Other decoded streams compare equal. This supports a reader
incompatibility with this file's incremental hybrid cross-reference structure.
It does not establish which individual Java reader rule is wrong or certify
the original against the PDF specification.

## Additional source controls

Both save settings were applied to derived bytes from eight other frozen corpus
sources. These are post-holdout control checks; none adds an unseen parser pass.
Java was not repeated because these originals already parsed successfully.

| Control | Pages | Text, pixels, geometry, outline and links |
| --- | ---: | --- |
| Prince mathematical article | 13 | All identical |
| BCcampus accessibility textbook, Pressbooks | 101 | All identical |
| CTAN axessibility, LaTeX | 20 | All identical |
| W3C complex tagged table | 1 | All identical |
| W3C OpenOffice columns | 1 | All identical |
| SNU admissions, Korean | 76 | All identical |
| MU calculus, Arabic | 6 | All identical |
| J-STAGE 1949 statistics scan | 12 | All identical |

All 230 control pages match. Catalog key/value maps, XMP and page labels also
match for all eight sources. The initial arm exposed one meaningful difference:
the J-STAGE source has `Standard V1 R2 40-bit RC4` encryption, while the default
save writes an unencrypted derivative. That behavior is not acceptable as a
generic conversion. Its receipts are retained separately from the revised arm.

With `PDF_ENCRYPT_KEEP`, the J-STAGE derivative preserves its encryption,
encryption dictionary, permission bits `-44`, and existing open-without-password
behavior. All metadata now matches for all eight controls. The other seven
derived control PDFs are byte-identical between arms. All 430 pages across ECB
and the controls again pass text, pixel, geometry, outline and link checks.
The original PDFs remain unchanged. This experiment does not authorize applying
the save to every uploaded PDF.

## Limits and reproduction

This demonstrates reader acceptance and the measured fidelity checks, not
correctness of all 1,826 extracted blocks. Pixel equality uses one renderer at
72 dpi. It does not verify signatures, interactive form behavior, all
accessibility semantics or every possible viewer. Incremental history is
flattened. Encryption preservation was checked on this one RC4 source; other
encryption and authentication cases remain untested. No production retry or
upload normalization was implemented.

The runnable script is
[`experiment_unseen_ecb_repair.py`](../scripts/experiment_unseen_ecb_repair.py).
Run it in a fresh isolated container with the resource limits above and a
read-only repository mounted at `/repo`:

```sh
python /repo/bench/parsers/scripts/experiment_unseen_ecb_repair.py \
  --output /tmp/ecb-repair --timeout 240 --keep-encryption
python /repo/bench/parsers/scripts/experiment_unseen_ecb_repair.py \
  --output /tmp/ecb-controls --timeout 240 --controls --keep-encryption
```

Use `--initial-save` instead of `--keep-encryption` only to reproduce the initial
experimental setting. The command requires an explicit arm choice.

Structured local evidence lives in
[`local/2026-09-20-unseen-pdf-validation/ecb-repair/`](local/2026-09-20-unseen-pdf-validation/ecb-repair/):
`experiment.json`, `fidelity.json`, `original-java.json`, `refetch.json`,
`source-structure.json`, `root-cause.json`, `stream-structure.json`,
`controls/controls.json` and `controls-metadata-diff.json`. Revised receipts are
under `r2/`, including the repeated ECB run, all eight controls and
`encryption-check.json`. Per-page hashes, parsed blocks and image hashes are
retained there. Only structured artifacts were exported; experiment containers
and their derivative PDFs were removed after verification.
