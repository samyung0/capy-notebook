# Untouched heading scope release check

All six frozen source witnesses pass in the final guarded parser outputs. Both fresh full-PDF results match the frozen source hashes and page counts. This is a narrow scope-preservation result on two English TeX manuals, not a broad parser accuracy result.

The paired old-production runs confirm **six unchanged passes, zero new repairs and zero regressions** in these witnesses. Both documents' complete final content-list and chunk JSON are exactly identical between old production and the guarded candidate, including the residual folio ancestor noted below.

| Case | Source and physical page | Result |
| --- | --- | --- |
| 01 | Lua Introduction, page 7 | Heading 2 under the manual title; introductory prose belongs to Introduction. |
| 02 | Lua The Language, page 7 | Independent heading 2; its prose and Lexical Conventions exclude Introduction ancestry. |
| 03 | Lua Application Program Interface, page 28 | Independent heading 2; C API prose and States exclude earlier Language ancestry. |
| 04 | LaTeX Contents, page 1 | Heading 2 under the book title; contents entries remain in that section. |
| 05 | LaTeX Introduction, page 2 | Independent heading 2; explanatory prose excludes Contents ancestry. |
| 06 | LaTeX Creating document commands and environments, page 2 | Complete multiline title remains heading 2; Overview prose excludes Contents and Introduction ancestry. |

The LaTeX continued contents on page 2 has a separate folio `1` ancestor. This lies outside the six selected scope checks and is not hidden by their passing score. No source gold or production code was changed during review.

Gold: `bench/parsers/fixtures/heading-scope-release-gold-2026-09-20.json`, SHA256 `ba393e2bc21d8d9bf5c2a51a0010408bdfa3895edbdf15eee783ca6dfaf0191a`. Sources: `bench/parsers/fixtures/heading-scope-release-sources-2026-09-20.json`, SHA256 `a359204a411525de6d12494d0f923b54e183a2006ee43892563b11165131d0e4`. The six cases were source-rendered before parser outputs were inspected. Individual verdicts and reviewed artifact hashes are in `bench/parsers/reports/local/2026-09-20-heading-scope-release/final-score.json`.

Final outputs are under `bench/parsers/reports/local/2026-09-20-parser-repairs/final/{scope-lua50,scope-latex-author}`. Selected roots all appear in the embedded source outline. These cases supplement the LibreOffice omitted-Contents control; they do not replace it. Passing cases should not count as repairs without paired evidence.

Paired baseline outputs are under `bench/parsers/reports/local/2026-09-20-parser-repairs/baseline-scope`. The parent ran `capy-parser-baseline-scope` using the same saved 98-file old-HEAD snapshot described in the heading-release review, with image-default OMP matching the final arm. Both workers returned 0, with baseline wall-time receipts of 15.004 seconds for Lua and 4.834 seconds for LaTeX. The reviewer compared all exported final blocks and chunks, not just the six witnesses. Equality results are retained in `bench/parsers/reports/local/2026-09-20-heading-scope-release/paired-score.json`.
