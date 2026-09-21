# Source-backed extraction repair

The developer authorized Sol to repair recoverable extraction defects, including
those recorded by earlier annotation-only assignments. This permission overrides
an older assignment's instruction to leave recoverable source text unchanged.
Canonical data and frozen input snapshots remain read-only to scope workers.
Write a separate candidate; the parent serializes import and publication.

Review the saved unresolved items and affected excerpts against their exact PDF
pages. Recover readable missing text, formulas, table cells, code and diagram
labels or relationships. Preserve source notation and distinguish an extraction
error from an error or omission printed in the book. A visible diagram may have
a clearly labelled `[Diagram description: ...]` grounded only in what is visible.
Do not describe such prose as a verbatim quotation from the book. Preserve exact
formulas and labels; record uncertain elements instead of guessing.

Read same-book context before declaring a dependency unavailable. Use conditional
context links for content printed elsewhere, preserving the existing excerpt and
chunk boundaries. External links, animations, clipped or illegible source regions,
and author placeholders may remain unresolved. Do not invent a replacement lesson
or silently correct a source-authored mathematical or programming mistake.

Remove repeated text only when the inspected page establishes that extraction
duplicated it. Repeated examples across books or intentionally repeated source
material are outside this repair task.

Use the normal review artifact with full replacement tags for the assigned IDs,
plus `base_corpus_sha256`, `source_pdf_path` and `source_repairs`. The corpus hash
binds the exact original `corpus.json` bytes. Each repair names one existing chunk
owned by an assigned excerpt. Hash the chunk's original UTF-8 text. Replace its
complete text, keeping all unrelated content. Keep IDs, ordering, pages, regions,
section paths, figure IDs and chunk membership unchanged. Split corrections over
their actual source chunks instead of moving an entire multi-page excerpt into
one chunk. Every changed chunk needs exact supporting page inspections.

```json
{
  "base_corpus_sha256": "SHA256 of original corpus.json bytes",
  "source_pdf_path": "absolute/path/to/original.pdf",
  "source_repairs": [
    {
      "excerpt_id": "existing-excerpt-id",
      "chunk_id": "existing-chunk-id",
      "original_text_sha256": "SHA256 of original chunk text encoded as UTF-8",
      "text": "Complete corrected chunk text, including unchanged content.",
      "kind": "transcription",
      "reason": "The inspected source prints a division slash where extraction inserted 1.",
      "pdf_pages": [12]
    }
  ],
  "inspection_records": [
    {
      "pdf_page": 12,
      "rendered_page_path": "absolute/path/to/page-012.png",
      "rendered_page_sha256": "SHA256 of that saved image",
      "observation": "Exact source observation supporting the repaired notation."
    }
  ]
}
```

Repair kinds are `transcription`, `diagram_description`, or `extraction_duplicate`.
The JSON above illustrates added fields, not a complete review. Include the usual
book/source/base-tag hashes, full tags, provenance, reviewed IDs and receipts.
Add a hash to the actual inspection record for every supporting page; retaining
other older inspection records without that extra field is allowed. Reopen the
saved image when making a new recovery judgment and record actual provenance.

Update affected full notes, evidence, roles and retrieval scope to match the
repaired source. Remove obsolete missing-content warnings only for content
actually recovered. Preserve unrelated notes and the immutable original-note
baseline. Keep source-authored errors and still-missing context explicit. Use
`repair_assessment` to record `repaired`, `source_unavailable`, `source_authored`,
`context_linked`, or `no_repair_needed` with IDs, exact pages and a concrete reason
for every earlier unresolved item. Do not mark a metadata warning as a repair.
Use `excerpt_ids`, `pdf_pages`, `status` and `reason` in each assessment.
Global operational limitations belong in the result or validation receipts,
rather than an assessment with empty IDs/pages. Declare `source_repairs: []`
when the issue assessment produces no source edits; source bindings still apply.

`enrich.py` validates source repairs together with annotations. It rebuilds excerpt
and index text plus the content hash from corrected chunks using the existing
transcription helper. Validation alone changes no canonical files. The parent
applies the candidate, preserves original corpus/tags/notes, indexes and verifies
a replacement publication. Packets include the projected repaired source and the
original note baseline. For split-book final packets, `--source-review` supplies
the assembled whole-book repair artifact so linked source text is current too.
The packet carries compact correction and disposition provenance for its assigned
and linked repaired passages. It does not ask Qwen to repeat page verification.

Apply saves a complete write plan before changing canonical corpus, tags or notes.
If interrupted, inspect the existing backup and checkpoint. The parent may use
`enrich.py --run <run> --artifact <same-artifact> --apply --resume` to finish that
exact plan. It first verifies every file is still at its saved original or expected
hash and refuses unrelated changes. Do not create a new artifact or overwrite
the backup to bypass an interrupted import.

For a repair follow-up, keep the original review and packet intact. Write the new
review, packet and result in the separately assigned repair directory. Preserve
every repaired/unresolved outcome in the result. No Qwen calls, uploads, external
model calls or independent canonical changes belong to this task.
