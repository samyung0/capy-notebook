# OpenDataLoader versus Capy's MinerU parser

Authorized September 8, 2026: evaluate OpenDataLoader configurations against
MinerU using existing repository and idle ingest-host datasets. Rebuild isolated
benchmark containers as needed. Standalone Docling, Marker, and MarkItDown are
excluded. OpenDataLoader's bundled Docling backend is part of the candidate.
This is an experiment, not authorization to replace the production parser.

## Frozen scope

- Host: `159.195.61.195`, 8 AMD EPYC vCPUs, 15 GiB visible RAM, no GPU.
- Baseline: installed MinerU 3.4.5 CPU pipeline, current repository adapter,
  tables/formulas enabled, 26-page slices, `auto`; explicit `txt`/`ocr` controls.
- Candidate: OpenDataLoader 2.5.7, bundled hybrid backend with Docling 2.126.0.
  Compare Java-only, hybrid auto with OCR off, language-aware EasyOCR and
  RapidOCR, full-route forced OCR, and formula enrichment where relevant.
- No third-party inference calls, database jobs, or application deployment.
- Task files live at `/opt/capy-parser-eval-20260908` on the VM. Existing sources,
  model caches, results, images, and volumes remain intact.

## Evidence

Inventory and hash the 16-file multilingual RAG corpus, parser fixtures, Office
canaries, the selected biology accuracy pages, and the 610-page biology book.
Normalize Office inputs once through Capy's LibreOffice path and give each
parser the exact same resulting PDF. Label derived scans and selected pages.
Do not treat old parser outputs as ground truth.

Run a representative configuration screen before the full corpus. Include
native text, mixed native/scanned pages, image-only pages, CJK and European
languages, tables, equations, figures, and Office previews. Keep raw Markdown,
structured JSON, image outputs, timing, logs, versions, source hashes, and
cgroup memory/swap samples.

Quality checks distinguish known-answer recovery from diagnostics. Check exact
canaries and table facts against source pages; visually review reading order,
equations, figure coverage, and citation geometry. Text length or agreement with
another parser is not an accuracy score. Measure whether the same answer
evidence remains available after Capy's chunking. Do not infer end-to-end RAG
quality without running retrieval.

Compare warm and cold behavior separately. Repeat representative timing runs,
then test long-document handling and one/four concurrent slices for viable
configurations. Run competing parsers sequentially on this shared CPU. Use
explicit time and memory limits and record failures instead of silently
falling back to another engine. Test VLM feasibility only if it can run on the
existing CPU host; do not rent GPU infrastructure.

## Deliverables

A reproducible harness under `bench/parsers/scripts/`, source-grounded quality
checks under `fixtures/`, a dated findings report, and local raw artifacts under
`reports/local/2026-09-08-opendataloader/`. State which configurations meet Capy's
requirements, their latency/resource costs, any content or geometry failures,
and the limits of the dataset. Remove this experiment's containers when done.
