# Java extraction with selective recovery

Authorized September 8, 2026: investigate whether OpenDataLoader's Java-only
speed advantage can be retained while approaching MinerU's useful study-content
quality. The developer explicitly accepts testing image captions as an
alternative to OCR. This is an isolated benchmark, not a production parser change.

## Comparison

Reuse the frozen September 8 PDFs and native outputs. Keep the Java cluster-table
and MinerU baselines unchanged. Reuse the existing adapter, chunker, figure
selection, image prompt and current captioning model where applicable.

1. Inspect all 430 ordinary pages, the 610-page textbook and the 64-page screen.
   Measure inexpensive source-PDF signals for scan images, vector drawings,
   tables and missing native text. Record selection cost and the fraction of
   pages/regions requiring recovery. A selected region is not automatically a
   correct figure; inspect known graphs and false positives.
2. Test direct RapidOCR on scan images without the hybrid layout backend.
   Compare it with the current GLM-5.3-Flash caption prompt through DeepInfra.
   Include multilingual scans, native text beside a scan, tables and formulas.
3. Test captions on Java's existing images and on source-rendered recovery
   regions/pages. Compare the current 1,280-pixel encoding with higher resolution
   on dense examples. Record text omissions, wrong associations and invented
   values, not just output length or successful calls.
4. Assemble experimental content lists and run the actual Capy chunker.
   Keep exact source-page text/row checks distinct from semantically correct
   caption answers. Expand source-grounded checks for the known diagrams,
   equations, reading order and table failures. Inspect citation granularity.
5. Measure the viable combined path on intact inputs and representative repeated
   timing runs. Include detection, rendering, OCR, caption latency, provider
   token/cost receipts, physical image deduplication and artifact limits. Include
   MinerU's caption work in any comparison that claims complete pipeline cost.

Start caption experiments with a bounded selection of at most 200 requests;
expand only if the measured quality justifies an intact-document trial. Use the
existing DeepInfra credential without logging it. Send only authorized benchmark
image bytes and the image-only prompt. Never use application databases or caches.
No production image filtering, fallback policy or model selection is changed.

## Artifacts and cleanup

Scripts live in `bench/parsers/scripts/`; new checks in `fixtures/`; results in
`reports/local/2026-09-08-java-recovery/`. The VM working directory is
`/opt/capy-java-recovery-20260908`; the earlier experiment mounts read-only.
Only this experiment's new container may be changed. Preserve the prior archive,
models and outputs. Verify the final local archive before removing the new
container. Report measured recovery coverage, remaining quality gaps and whether
the speed advantage survives, without claiming a general accuracy guarantee.
