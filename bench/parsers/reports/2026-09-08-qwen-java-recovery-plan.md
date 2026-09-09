# Qwen image recovery for Java extraction

Authorized September 8, 2026: continue the Java recovery experiments and test
Alibaba's Qwen3.8 Flash through the supplied Frankfurt workspace endpoint.
Keep the production parser, caption model, caches and databases unchanged.
Reuse the frozen PDFs, Java/MinerU results, image bytes, prompts and source
checks from the completed experiments. Record model identity and actual request
options. Keep the supplied credential outside repository artifacts and remove
its temporary copies when finished.

## Comparisons

1. Replay the existing 83 Java/MinerU image jobs and 20 region jobs at the same
   1,280-pixel cap, JPEG settings, image prompt and concurrency four. Explicitly
   disable Qwen thinking for this latency-oriented arm. Prior GLM results are
   retained controls, not contemporaneous randomized model measurements.
2. Enable bounded thinking on the difficult graphs, tables, formulas and scans.
   Keep outputs and failures separate from the primary arm. Compare source
   relationships and contradictions rather than treating longer text as better.
3. Test source-page context in place of isolated visual fragments. Select
   non-scan pages using the existing figure/table/drawing evidence, render the
   original page, and compare the frozen caption prompt with a literal
   transcription prompt. This is an experimental selection rule, not a new
   production image filter. Keep scans on direct OCR in the composed variant.
4. Inspect the remaining DOCX, French and Japanese table rows, Hong Kong text,
   formulas and known diagram errors. Run the actual Capy chunker, existing
   page/row probes and source-grounded relational review. Keep prose recovery
   distinct from structured-table recovery and manually selected controls
   distinct from automatic selection.
5. If quality and caption latency justify expansion, run the selected path on
   intact inputs. Measure the full extraction/recovery path separately from
   indexing, and preserve all skipped/failed work in the denominator. A routing
   heuristic is not validated merely because it handles known examples.

Start with at most 240 caption requests, including controls and repetitions.
Expand only if the results justify an intact-document trial. Use no automatic
retries. Preserve model responses, token usage, input/encoded-image/prompt hashes,
timing and errors. Estimate Alibaba cost using the developer's supplied USD
rates per million tokens: uncached input 0.113, implicit-cache input 0.014,
output 0.382. Count reported cache use explicitly; do not infer cache hits from
speed. Provider receipts and a local cost calculation are not an invoice.

## Artifacts and cleanup

Use `bench/parsers/reports/local/2026-09-08-qwen-java-recovery/` for raw records
and `bench/parsers/scripts/` for runnable code. Preserve earlier experiments.
If the ingest VM is needed, inspect its current state first and create only a
new isolated benchmark container and directory. Verify the final local archive
before removing that container. Remove temporary credential files without
printing their contents. No commit or PR is requested.
