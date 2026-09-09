# Structural recovery follow-up

The developer authorized improving recovery-page selection, table headers and
figure relationships after the September 8 Qwen comparison. Subsequent caption
calls use Qwen3.8 Flash. This remains a benchmark experiment; production parser,
chunker, model settings, caches and databases are unchanged.

Start with saved native artifacts and Qwen captions. Measure source-text gaps
and table-layout signals on the frozen 64-page screen and 430-page intact
corpora. Existing source questions remain unchanged. Record every selected page
and reason, including additional pages with no saved caption.

Test deterministic preservation of explicit table spans and headers, table-row
boundaries and caption section boundaries against the current 400-token Capy
chunker. Preserve original text and provenance; do not infer missing headings
or claim that repacking corrects a caption's factual errors. Report any token,
chunk-count or duplicate-text cost alongside preserved relationships.

Where saved text cannot resolve the source, test a generic structure-preserving
caption prompt on the original page. No source answers or per-document fixes
enter the prompt or selection code. Initial new-call ceiling is 80 requests,
at concurrency four, with thinking disabled, no automatic retries and explicit
failure counts. Inspect the source pixels for changed claims. Additional calls
require a recorded evidence-based expansion within the authorized experiment.

Use focused offline checks and the existing executable probes, plus source and
single-chunk judgments. Include screens and intact documents, retain failed
attempts, and distinguish known-page debugging from unseen-document accuracy.
After implementation, obtain independent review, verify retained artifacts and
remove any temporary credential copies and isolated benchmark containers.
