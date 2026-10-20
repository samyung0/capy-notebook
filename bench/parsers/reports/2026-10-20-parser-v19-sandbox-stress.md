# Parser v19 with the decoder sandbox: concurrent parses on the ingest host

2026-10-20/21. DRAFT, numbers pending.

## Output against v16

The `Parser budget` workflow keeps the SHA-256 of every fixture's
`content_list.json`. Across its runs from v16 (`0cecfcd85`) to v19 with the
decoder sandbox (`5eb6ca89c`), one fixture at a time on the 4-CPU runner:

| Fixture | v16 → v19 + sandbox | Changed at |
| --- | --- | --- |
| paper-2col, mixed-scan, newspaper-scan, legal-prose, vector-drawings, inline-images, math-worked, scan-120p, xlsx-gradebook, pptx-84-slides | identical | — |
| textbook-26mib (Biology, 610 pages) | 26,216 → 25,112 blocks; text −845 of 1,536,753 characters | v17 (flattening, 25,303 blocks) and v18 (flatten tuning) |
| logic-1016p | 12,853 → 12,854 blocks; −50 characters | v17 and v18 |
| limit-1400p | 15,853 → 15,854 blocks; −50 characters | v17 and v18 |
| docx-handbook | same blocks and text, different hash | between runs of one version too (v17: `9cacbe1ec` vs `f7adc3a32`; v19: `8d0b32282` vs `5eb6ca89c`) |

v19 changed only the VLM page prompt (a donor-key bump), and the sandbox
changed no PDF or Office output: v19 without and with it give the same
hashes, the DOCX aside.

## Setup (parses)

- **Image**: the UAT ingest deploy's parser image of `5eb6ca89c`
  (`capy-ingest-nonprod-parser:<sha>`, the production Dockerfile; health
  reports `odl-2.5.7-refined-vlm-v19+5eb6ca89c…`).
- **Container**: one throwaway container per pass (`capacity_pass.sh`), as
  `deploy/docker-compose.ingest-host.yml` runs the production parser:
  read-only root, `cap_drop ALL`, `no-new-privileges`, the 64 MiB HOME tmpfs,
  no `/tmp` mount (the image's `/tmp` is read-only to the parser user), its
  own spool and work volumes; 14 GiB, 18 GiB with swap, 8 CPUs, 512 pids;
  `APP_ENV=production`, a throwaway `PARSER_TOKEN`, `CAPY_PARSE_WORKERS` 7
  (8 in pass D), `CAPY_PARSE_QUEUE_DEPTH` 8, `CAPY_PARSE_DOCUMENT_TIMEOUT` 600,
  the 1,400-page and 500 text-less page caps, the 1g heap,
  `MALLOC_ARENA_MAX=2`, the 180 s Office timeout and the bundle limits.
  Published on loopback only; container and volumes removed after each pass.
- **Host**: 8 vCPUs, 15.6 GiB RAM, 24 GiB swap, kernel 6.12 (Landlock ABI 6),
  shared with the UAT ingest stack (parser 6 GiB/2 CPUs, coordinator,
  workers) and a lab database, idle during the passes.
- **Driver**: `stress_parser.py burst` (every document sent 0.5 s apart
  through the production artifact route, unique fingerprints), sampling every
  250 ms. A watchdog kills the pass if host swap grows by 1 GiB or any other
  container restarts.
- **Inputs**: the 2026-09-28 stress inputs (the Biology textbook without its
  text-less pages, concatenated to 1,400 pages; a clean 150-page scan) and
  the parser budget's Office fixtures (the 72-page handbook DOCX, the
  224k-cell gradebook XLSX, the 84-slide PPTX).
