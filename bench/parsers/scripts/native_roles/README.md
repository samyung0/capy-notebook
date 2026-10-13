# Native line-role model (experiment, 2026-10-13)

Classifies every pymupdf text line of a PDF page into a role (body, heading,
list, caption, footnote, code, furniture, display formula, figure label, table
cell) from native primitives only: geometry, fonts, glyph classes, gaps,
drawings, images and whole-book repetition. No page is rendered at inference.
Labels come from the PDF outline, whole-book repetition and two pixel teachers
(PP-DocLayoutV3 and Docling Egret-medium) where they agree. Findings:
`bench/parsers/reports/2026-10-13-native-role-model.md`.

Frozen inputs: `fixtures/native-roles-books-2026-10-13.json` (books, splits,
sampled pages, seed) and `fixtures/native-roles-classmap-2026-10-13.json`
(teacher classes onto our roles). Raw data lands in the ignored
`reports/local/2026-10-13-native-roles/` (override with `NATIVE_ROLES_OUT`).

## Environment

One venv with `pymupdf numpy lightgbm onnxruntime rapid-layout opencv-python-headless torch transformers boto3`.
`parse_v13.py` runs with the parser's own venv (`parser/` requirements plus
Java) and `CAPY_RAPIDOCR_MODEL_DIR`. The teachers need:

- `NATIVE_ROLES_MODELS`: a directory holding `pp_doc_layoutv3.onnx`;
- `HF_HOME` with `docling-project/docling-layout-egret-medium` cached, and `HF_HUB_OFFLINE=1`.

Run everything from this directory.

## Steps

| Step | Command | Cost on the M1 (8 GB) |
| --- | --- | --- |
| Download the library books inside the upload limits (credentials from `.env.local`) | `python fetch_pool.py` | ~12 min, 1.1 GB |
| Freeze books and pages | `python select_books.py` | seconds |
| Extract pages, book stats | `python labels.py extract` | ~2 min |
| Teachers, one after the other (V3 first; Egret labels only the pages V3 did) | `python teacher.py v3 4` then `python teacher.py egret 4` | 1.4–2.8 s + 0.5–0.8 s per page, 2,382 pages ≈ 1.7 h |
| Labels and label statistics | `python labels.py build` | 1 min |
| Grouped CV + final model | `python train.py` | ~3 min (features cached after the first run) |
| Shipped parser on held-out books | `<parser venv>/bin/python parse_v13.py` | ~2 min per book |
| Evaluation | `python evaluate.py roles`, `figures`, `latency` | minutes |
| Rule-based heading recall (`parser/odl/layout_headings.py`), no model: parse with the parser to compare (`PARSER_DIR` picks a frozen copy), then score | `<parser venv>/bin/python eval_layout_headings.py parse [BOOK...]`, then `python eval_layout_headings.py train` (line rule vs training labels), `heldout` (parser vs parser + rule) or `heldout train` (the parsed training books) | parse as above; scoring minutes |

`teacher.py` is resumable; the other steps cache their outputs (`pages/`,
`features.pkl`) and are deleted to recompute.

Tag trees were not used as a label source: most training books carry none, and
mapping marked content to pymupdf lines needs a content-stream walker the
experiment did not justify.
