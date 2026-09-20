# Capture exact visual facts with high-confidence extraction

The updated production `CAPTURE_RULE` was exercised with GLM-5.3-Flash through
Tencent TokenHub on three PDFs in the 34-document holdout. All three cases
captured the source page, delivered its image in the next model request and
returned the expected fact despite a supplied passage confidence of 1.0.

| Source and PDF page | Expected fact | Successful captures | Model requests |
| --- | --- | --- | --- |
| OpenStax Precalculus 2e, 21 | `f(March) = 31` | 1, full page | 4 |
| NIST FIPS 203, 14 | `3329 = 2^8 * 13 + 1` | 1, cropped symbol definitions | 4 |
| W3C complex table, 1 | Blind: 1 completed ballot; accuracy 34.5%, n=1 | 1, full page | 4 |

Each case first attempted capture before retrieving a passage. The production
capture guard refused it. The model then searched, received the deterministic
passage, captured again, and answered with citation `[1]`. The refused attempt
is included in each four-request total. The NIST case selected a crop
`[0, 100, 1000, 400]`, preserving the relevant symbol definition.

The runner uses the current production agent loop, prompt, tool definitions,
capture guard and PyMuPDF renderer. Database retrieval and source download are
replaced with deterministic local passages and holdout PDF paths. The passages
come from PyMuPDF text extraction, including its missing visual mathematics,
and are assigned confidence 1.0. The provider request uses the production Z.ai
request builder with the GLM-5.3-Flash pin, low reasoning, temperature 0 and a
3,000-token output bound. Responses use a bounded non-streaming HTTP transport
and are adapted into the production agent loop. No application database,
knowledge-base ingest or parser service is used.

Reproduce from the repository root:

```powershell
uv run --project pipeline python bench/rag/scripts/capture_visual_probe.py
uv run --project pipeline python bench/rag/scripts/capture_visual_probe.py --live
```

The live command reads the existing `.env.local` `TOKENHUB` credential without
logging it. It makes at most five requests per case and has a 55-second HTTP
timeout per request. Only the three named public holdout PDFs are used.

Raw results, source SHA-256 values, the exact prompt, calls, image dimensions
and final answers are in the ignored
`bench/rag/reports/local/2026-09-20-capture-visual-probe/live.json`.
`offline.json` is a separate scripted wiring check. Its scripted answers do not
measure model compliance. Both checks passed all three cases. Preliminary
setup calls with missing read capability offered no tools and are excluded;
the harness now asserts that `capture_page` is offered before executing.

This is a small targeted feasibility check, not a reliability estimate or an
old-versus-new prompt comparison. Page hints and deterministic retrieval remove
document discovery difficulty. It does not measure real ODL retrieval quality,
knowledge-library capture, material creation, provider streaming, or failure
handling for illegible images. The result supports keeping visual verification
at answer time, while preserving parser structure and page discovery quality.
