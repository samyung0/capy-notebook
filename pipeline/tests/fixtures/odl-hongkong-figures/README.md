# odl-hongkong-figures

Lab source `hongkong-figures` from the September 2026 parser lab, refined
variant (`/opt/capy-odl-third-pass-20260909/refined-final-r1/hongkong-figures`
on the ingest host). 53 pages, 14 source-geometry tables, 69 native tables,
eleven furniture texts, two of which ("Figures are as at the end of the year.",
"註釋： (1) Note : (1)") fall below the recurrence threshold once the tables
are replaced, so the frozen decision matters here.

- `source.pdf` — the parsed PDF (sha256 `c3490cc7c1664ce8e75edcce55898be58dc21fceade53b3c1cbfd7f30411f2d9`; no font repair).
- `content_list.json.gz` — the refined bundle's block list (sha256 of the
  uncompressed file `6d43218dc7794979122231ecc6ea5cd8e2ce0e9c1531efdf41246462f4b94967`).
- `refinement.json` — the bundle's frozen furniture, as the parser writes it.
- `chunks.json.gz` — the original lab's `pack_odl` output, retained as historical
  evidence (sha256 `ea18022643060807cd48bb4f084c22187bdf7fa126abb9c9e183540572c8ca0d`).
- `interior-chunks.json.gz` — 204 expected chunks frozen by the September 16
  recovery experiment before production implementation, copied from its
  `r2/hongkong-figures/interior_furniture-chunks.json`. All 76 restored body
  occurrences retain their original page/box. `test_packing.py` pins this output;
  uncompressed SHA256 `e22e8bc005d1286f473f6dfa9648f30af495ad84bce4b38a0692d016763ebbf0`.
  Fixture provenance is in `bench/parsers/reports/2026-09-16-odl-textbook-recovery.md`.
