# Source-confirmed overprint repair in native lists

The list adapter repairs 25 of 39 suspicious CJK list blocks across 13 documents
and 335 pages. It removes 530 extra painted characters while preserving every
list item, embedded newline, whitespace boundary and source box. Four of eight
new, visually frozen source-label checks improve; the other four remain
unrepaired. This is a benchmark-only extension of the frozen
[native-text experiment](2026-09-09-odl-native-text-experiment.md).

## Source checks and rule

The ten-document development and transfer corpus uses the selected native-text
outputs followed by [heading retention](2026-09-09-odl-heading-retention-experiment.md).
The three independent BERT, ResNet and NIST shot-classifier documents use the
same frozen rules. `sources.json` binds all inputs and parsed PDF copies to their
hashes. Eight Chinese section labels were visually checked against source pages
before implementing the adapter; their exact text and image hashes are frozen in
`checks-v1.json`.

The earlier glyph function only accepts native text blocks. This adapter joins
the items of a suspicious native list with explicit newline separators and calls
that unchanged function. The function requires full source-region text
correspondence and matching opaque overprinted glyphs before deleting copies.
The adapter then restores the original list shape through deletion-only
alignment. Each whitespace-delimited segment must retain the same character-run
sequence, and all whitespace must remain exact. Any ambiguous redistribution
across a word, line or item boundary is rejected. No source box, page, list type
or other metadata changes.

This guard matters for the children paper's page 16 list. Its heading ends in
`雷达图`, immediately followed by a figure caption beginning `图 9.`. Applying
the flat-text deletion result would move the caption's `图` across whitespace.
The adapter rejects that result. All 76 earlier accepted text-block repairs were
also audited with this boundary check and passed.

## Results

| Document | Repaired lists | Abstained lists |
| --- | ---: | ---: |
| CCL feedback | 7 | 5 |
| CCL chain of thought | 12 | 5 |
| CCL children | 6 | 4 |
| Other ten documents | 0 | 0 |

The 530 deleted copies comprise 512 CJK characters and 18 fullwidth colons. No
digits were deleted. All numbers in accepted lists are exact before and after.
Source fields, bounding boxes and non-list content remain exact. The ten
unaffected documents have identical raw content and final chunks. Every run is
idempotent and leaves caller input untouched.

The eight new indexed-text checks improve from 0/8 to 4/8: feedback pages 4 and
5, COT page 2, and children page 7 recover their selected section labels. The
feedback page 4 data-source title, two COT page 3 titles and children page 5 title
still fail. All 12 prior section-context checks, 16 native-text checks and 30
heading-retention checks continue to pass after rechunking and title retention.
The independent three-document outputs remain unchanged by this adapter.

These are selected source checks and conservation controls, not a complete
335-page accuracy score. Accepted repairs retain a source glyph proof in each
document's `decisions.json`.

## Remaining same-family defects

Thirteen lists fail strict full-region correspondence and one fails the boundary
guard. Twelve of the strict cases have native list boxes that cover the heading
width while their items also contain full-width paragraphs or tables. For
example, feedback page 4 native block 63 spans x=72–145.5 points, while its
included paragraph extends to x=525.5 points in the source. Source extraction
inside that inherited box consequently clips the paragraph. The adapter keeps
the original geometry and correctly abstains; these mismatches must not be
reported as proven source transcription errors. Wider source coverage may still
contain other ordering or text differences and has not been accepted here.

| Reason | Document: one-based page / zero-based native block |
| --- | --- |
| Insufficient native box width | Feedback: 4/63, 7/119, 7/123, 9/153, 10/168 |
| Insufficient native box width | COT: 3/31, 3/36, 5/65, 12/218, 14/256 |
| Insufficient native box width | Children: 8/116, 14/224 |
| Prime/subscript order differs | Children: 5/62 (`Di′2` versus source `D′i2`) |
| Character would cross whitespace boundary | Children: 16/251 |

The earlier feedback page 14 text-block abstention also remains: native
`GPT3.5` differs from source `GPT-3.5`, preventing full correspondence for its
trailing overprinted label. Mathematical ordering, interrupted independent
two-column continuations, graphic relationships and incorrect inherited list
citation coverage remain separate work. This arm neither widens boxes nor
changes scientific text to force a match.

## Timing, reproduction and evidence

The saved-output replay spends 1.286 seconds in list repair across all 335 pages
on local Windows 11, Python 3.12.9 and PyMuPDF 1.28.2. This single measurement
excludes imports, JSON reads/writes, chunking, heading retention and the second
idempotence pass. It is not ingest-VM parsing latency.

```sh
uv run --with pymupdf==1.28.2 python -X utf8 bench/parsers/scripts/experiment_odl_list_text.py --check
uv run --with pymupdf==1.28.2 python -X utf8 bench/parsers/scripts/experiment_odl_list_text.py bench/parsers/reports/local/2026-09-09-odl-list-text NEW_OUTPUT
```

The helper is `repair_lists(blocks, parsed_pdf)` in
[`experiment_odl_list_text.py`](../scripts/experiment_odl_list_text.py). It returns
copied blocks and source decisions. Apply it after frozen native-text repair,
then use the selected chunker and heading retention. Its frozen SHA-256 is
`ceb5d1308e2ad2b7d07f098531154e6ed101af637cbe2200a0671bdd3f323a4e`;
the imported glyph helper remains
`624b890fe28097cdbd4d02420f96f6e72621815e1a1a7d3e5388c2409be68004`.

Those hashes describe the original `r1` experiment. Independent review then
required a whitespace guard in the imported glyph helper, recorded in the
[native-text follow-up](2026-09-09-odl-native-text-experiment.md#independent-review-whitespace-guard).
The selected helper revision is
`853ba96c59dc3bc131e053ea930a1000c04fed159d8ab391800cb65a859f2c03`;
the list adapter's own source remains unchanged. `r2-whitespace-guard/` repeats
all 335 pages in 1.310 seconds of list repair and yields identical raw content
and final indexed chunks, with the same 25 repairs and 14 abstentions. The
children page 16 case now stops inside the helper before reaching the adapter's
boundary guard. Its unchanged text and original rejection proof are preserved.

Evidence lives in `local/2026-09-09-odl-list-text/`. `r1/<case>/` contains selected
content lists, actual indexed chunks and decisions; `verification.json` records
the previous checks and conservation controls; `boundary-review.json` records
the rejected caption case and previous text audit; `abstentions.json` includes
all remaining native indices, source text differences and geometry extents.
Source renders, frozen checks, script snapshots and an artifact hash manifest
retain the audit trail. Focused boundary checks and isolated Ruff checks passed.
