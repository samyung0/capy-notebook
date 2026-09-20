# Delegated physics recovery and tagging

Status: repair complete; Physics v2 published and source/dashboard verified; v1 retired. This is a targeted repair of the held ledger, not
an evaluation of every page or every automatically accepted chunk.

The Physics run has 3,106 chunks. Qwen returned all 858 requested page
transcriptions. Local alignment held 283 chunks across 243 pages and 257
excerpts: 253 below 90% word coverage, 27 above the 2.5 length ratio and three
below 0.7. The book remains unpublished as version 2 during repair.

## Source findings

- Tables on PDF pages 33 and 46 were captured in Qwen's `figures` descriptions,
  but not its `text`; aligning only against `text` loses the tables.
- On page 51, alignment drops the final `cm²` unit even though it is present
  in the page transcription.
- On page 764, alignment drops the final X-ray calculation even though the
  transcription contains it. Equations 22.20–22.23 belong to the Solution;
  equation 22.19 belongs to the preceding Strategy.
- Several parser chunks contain separate column fragments. A contiguous span
  from the first to last match can import unrelated questions and still omit
  an original fragment. Replacement text being visible somewhere on a page
  does not establish that it belongs to this chunk.
- The uncertainty glyph on page 50 is damaged in the PDF itself. Replacing it
  with delta would be an inference. The source marker is retained.

## Terra high trial

`gpt-5.6-terra`, high, recovered chunk 113's metric-prefix table and chunk
2773's X-ray solution. Parent inspection confirmed the source content. The
first tagging input rewrote neighboring chunks while assembling an excerpt;
it was returned for correction. The final input exactly joins corpus chunks
with the assigned replacements, and both tags pass schema and verbatim-quote
checks.

A larger trial proposed a replacement for chunk 449 that dropped exercise 16
and imported questions 12–13. Another replaced chunk 546's questions with a
summary passage. Neither proposal was applied. A page-129 repair also needed
parent correction from guessed `Δt` to printed `Δv`.

Terra's reported 21 minutes was an estimate, not a measured end-to-end time.
Do not use it to project full-book throughput.

## Sol medium trial

The developer switched the delegated model to `gpt-5.6-sol`, medium. Its first
trial used chunks 449 and 546, the mixed-column cases above. Both proposals
preserved all original fragments and avoided importing the intervening
questions. Parent inspection checked pages 128 and 154. Tags use the exact
corrected excerpt texts and pass schema and verbatim-quote checks.

The recorded 59.662-second interval covers saving and validation only;
inspection began earlier. It is not an end-to-end timing comparison.

The remaining repair is divided by excerpt into three non-overlapping
packets. Following the developer's subsequent instruction, agents complete
their assigned scope autonomously, save checkpoints without progress reports,
and deliver finished artifacts for one final consistency/import pass. Original
corpus, tags and held ledger are backed up before edits.

## Current conclusion

Delegation can recover useful content, but these trials do not justify
removing validation. Keep checks for original content preservation, chunk and
excerpt identity, page references, schema, verbatim evidence and source
accuracy. Fixes may exceed the old length/coverage rules when the page itself
supports them; model confidence alone is insufficient.

The five-minute `knowledge-builder-intake` heartbeat is configured for Sol
medium and automatic admission of eligible downloads only after Physics v2
is published and its source/dashboard verification is recorded. It must
coordinate with the existing queue, avoid concurrent Alibaba processing, save
progress, and remain quiet while the prerequisite is unmet. Full-book
throughput and recovery after interruption have not yet been demonstrated.

## Local artifacts

- `data/knowledge-base/runs/physics/terra-trial/results.json`
- `data/knowledge-base/runs/physics/sol-trial/results.json`
- `data/knowledge-base/runs/physics/manual-repair-2026-09-20/before/`
- `data/knowledge-base/runs/physics/manual-repair-2026-09-20/parent-edits.json`
- `data/knowledge-base/runs/physics/manual-repair-2026-09-20/packet-*-sol-results.json`

Run artifacts are ignored local data. No parser implementation, default model
routing, or automatic recovery threshold was changed for this experiment.

## Completed repair

All 283 held chunks are decided: 167 accepted corrections and 116 retained
originals. One neighboring chunk was repaired to restore an exercise boundary,
so the durable decision ledger contains 284 entries and zero undecided items.
The three Sol packets covered 257 excerpts; their tags passed schema and
verbatim evidence checks against the merged corpus. Two complete excerpts
were shorter than five words and retained exact short quotes. A rejected table
proposal was normalized back to original whitespace during import preparation.
Source printing errors remain recorded rather than guessed.

Parallel packet elapsed times were approximately 23.2, 13.3 and 16.8 minutes.
These are held-chunk review timings, not full-book parsing or recovery timings.
Canonical files and source-review provenance were saved, then the existing
index command completed successfully: 165 missing embeddings generated and
3,106 Physics chunks indexed locally. The shared VM version has not yet been
published by this repair pass. Intake remains gated on version 2 publication
and its source/dashboard verification.

Import receipt: `data/knowledge-base/runs/physics/manual-repair-2026-09-20/import-receipt.json`.
Final checks: `data/knowledge-base/runs/physics/manual-repair-2026-09-20/final-consistency-check.json`.

Publication completed on 2026-09-20. VM verification matched all 3,106 chunk texts and the 257 repaired tags. The live dashboard showed published v2 and zero undecided chunks. Version 1 was then retired. The gate receipt is `data/knowledge-base/runs/physics/physics-v2-verified.json`. No new downloaded books were available at this check.
