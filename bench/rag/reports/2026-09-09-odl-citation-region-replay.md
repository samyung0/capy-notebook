# Citation overflow replay

The production `Passage.as_citation()` in
`pipeline/pipeline/retrieval/search.py` exports only `regions[:12]`. The
development traces confirm that this can discard source support already present
in indexed chunks. The benchmark helper
[`odl_citation_regions.py`](../scripts/odl_citation_regions.py) tests a deterministic
geometry annotation change. It does not run an agent, modify an answer, assign a
new attempt ID, alter a scorer condition, or change production behavior.

## Rule and safeguards

Match each answer citation to its recorded `calls[].passages` using both file ID
and chunk ID. Require repeated matching passages to agree on geometry and page
span, and require the emitted citation to equal the expected first-12 prefix.
Validate positive integer pages, the declared coordinate space, finite ordered
bounding boxes with visible page intersection, and region membership in the
unchanged citation page span. Raw coordinates are retained; the viewer already
clamps coordinates to 0–1000.

Keep at most 12 regions exactly unchanged. For overflow, replace the full indexed
regions with their bounding union on each page, in first-observed page order.
Require every original indexed region to be contained on the same page. More
than 12 distinct pages, missing/conflicting passages and invalid geometry produce
an explicit flagged entry with no candidate geometry. The helper never changes
file, chunk or page identity and never requests source material outside the
recorded passage. It does not independently establish workspace authorization or
PDF correctness; those remain properties of the immutable source run and its
source review.

## Development evidence

Only immutable development baseline parts 001 and 002 were processed: 19 existing
turns, 225 citations. Of these, 216 remain exact no-ops and nine are merged, six
of which are attached to final answers. Every indexed region is contained by its
candidate geometry. No citation was flagged in this sample. A separate synthetic
13-page case is explicitly flagged rather than losing its thirteenth page.

| Existing attempt | Citation | Indexed / emitted regions | Replay | Source inspection |
| --- | --- | --- | --- | --- |
| 023 ODL, `eval_4c6b2244efba4c7fa62d64ecfa6730d2` | 19, chunk 63 | 25 / 12 | Two page unions, pages 9–10 | Source page 10 has the ablation d-value column outside the emitted highlights. The union restores it. |
| 023 MinerU, `eval_82752299a03540e7a148b7e5e821c91f` | All | No overflow | Exact no-op | Control; the cap is not implicated in this attempt. |
| 039 MinerU, `eval_c96de4ef572f4d0685f93e870a90dbb1` | 4, chunk 225 | 19 / 12 | One page union, page 32 | Source institution names and the commissioning statement occur in the seven omitted regions. The union restores them. |

The 039 MinerU attempt also has an overflowing, unattached citation 5. Other
changed development citations are retained in the full replay for independent
review; no answer-quality gain is inferred merely from their geometric coverage.

Larger highlights are a real precision cost. The ODL page-10 union includes the
running header and part of the adjacent references column because those indexed
regions share its page. The German page-32 union includes substantial blank space
and logos between the prose and institution list. This is source geometry
preservation, not finer localization. Source support still requires reviewing the
specific answer statement and source pixels; the original factual and seen-evidence
judgments do not change.

## Reproduction and artifacts

```powershell
python bench/rag/scripts/odl_citation_regions.py --check
python bench/rag/scripts/odl_citation_regions.py --answers bench/rag/reports/local/2026-09-09-odl-agentic/snapshots/development-baseline/part-001/answers.jsonl bench/rag/reports/local/2026-09-09-odl-agentic/snapshots/development-baseline/part-002/answers.jsonl --output bench/rag/reports/local/2026-09-09-odl-agentic/citation-replay/development-baseline-001-002.json
```

The output is created exclusively and will refuse to overwrite an existing file.
It records the original turn ID, input path/SHA/line, call/passage locators, full
indexed regions, emitted regions, candidate regions and contained-region indices.
Original replay script SHA256: `4bf183a1ef48f67ac20e9575a8d957a7829bf87e014ab590fe492b8b6274ec6b`.

Raw evidence is under
`local/2026-09-09-odl-agentic/citation-replay/`: the replay JSON, `validation.json`,
and four original-PDF overlays showing original and candidate highlights for the
two reviewed pages. Both source PDFs were matched to their frozen coordinate-PDF
SHA256s before rendering. Replay SHA256:
`b98509622c141fd1f54c41c4b534e57b6ac93e580d12cda2ffcf95dd520d0378`.
Focused no-op, overflow, multiple-page, invalid-geometry, identity and input
immutability checks passed, as did scoped Ruff checks. No provider calls were made.

## Invalid-geometry serialization correction

Independent review found that nonfinite coordinates were correctly flagged in
memory, but their retained raw payload then caused strict JSON serialization to
fail. The helper now preserves an unserializable geometry field as a clearly named
`original_regions_invalid_repr` or `full_regions_invalid_repr` string. The flagged
entry has no candidate geometry and retains the original input path, SHA256 and
line; no coordinate is silently replaced or accepted.

Current helper SHA256:
`e2f93850b94f09715a7266d8e0a3a67d80efaf15085f9d03c79346dc80e9dc10`.
The self-check now invokes the CLI with a nonfinite coordinate and verifies a
serializable flagged result, preserved invalid payload and input locator. All
19 finite development replay rows remain exactly equal to the original artifact;
that artifact and its recorded hash remain unchanged. Scoped Ruff and the complete
self-check pass. This correction does not change any answer judgment.
