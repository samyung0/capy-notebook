# Java recovery on new documents and Beijing OCR

Update: after three HTTP 403 entitlement failures, the developer paused Beijing
endpoint tests pending regional business validation. Native parser experiments
and offline artifact review continue. The temporary credential was removed.

The developer authorized sourcing new documents, testing the recommended Java
recovery improvements, and using the supplied Alibaba Beijing workspace. An
Astra high subagent owns the separate Qwen3.5-OCR evaluation for transcription
and captioning. Production services, parser routing, caches and data remain
unchanged. The shared benchmark host is `159.195.61.195`; the supplied
`159.195.250.206` address did not contain the benchmark archives.

## Evidence and comparisons

Download public documents from their publishers, keeping URLs, access dates,
source hashes, page counts and any license statements. Source a varied set of
previously unused scientific/educational and statistical documents with tables,
graphs, formulas and multilingual prose. Preserve intact PDFs. Freeze source
page judgments before reading candidate output. Synthetic raster controls are
explicitly separate from original scans and from unseen-document evidence.

Retain the existing Java configuration with cluster tables and headers, direct
OCR, source-confirmed encoding repair, structural selection and typed recovery
as the control. Evaluate selected and unselected pages, complete relationships,
omissions, conflicting copies and actual chunk support. Do not call sparse
anchor matches a general accuracy score. Keep tuning pages separate from final
validation documents and do not put answer labels into provider prompts.

Test the smallest table representation change that preserves merged cells, and
compare figure recovery with the earlier image prompt on matched pages. Use
saved responses for packing and duplicate/conflict analysis. Broader complete
execution follows only if source review supports it; record timing boundaries
and failures regardless of outcome.

The OCR subagent checks official model/API documentation, runs matched source
images through Qwen3.5-OCR and Qwen3.8 Flash, and evaluates document parsing,
literal transcription and figure interpretation separately. Record unsupported
parameters and first-attempt errors rather than concealing them with retries.
An optional native PDF API probe is a separate arm, not a matched image timing.

## Limits and artifacts

Initial ceiling: 280 new provider requests, at most 200 owned by the main
experiment and 80 by the OCR subagent. Use concurrency four or lower, explicit
output limits, Flash thinking disabled and no automatic retries. Expand only
with a recorded evidence-based reason inside the authorized experiment. Save
all attempts with model identity, request options, source/image/prompt/response
hashes, usage and elapsed time. Estimate cost using verified Beijing rates,
not the historical Frankfurt rates.

Runnable helpers belong in `bench/parsers/scripts/`, prompts/manifests in
`bench/parsers/fixtures/`, raw artifacts in the ignored
`bench/parsers/reports/local/2026-09-09-java-new-documents/` and
`bench/parsers/reports/local/2026-09-09-beijing-ocr/`, and findings in dated
reports. The credential stays in a mode-0600 temporary file outside the
repository and is removed after all requests finish. No credentials go into
remote shell arguments, model manifests, archives or logs.

Inspect host workloads before starting an isolated benchmark container. Use
explicit CPU/memory bounds; do not restart or stop existing services. Preserve
raw artifacts and verify their manifest before cleaning up experiment-owned
containers and temporary credentials. Run focused checks, Python formatting,
and independent review of changed benchmark code and source judgments.
