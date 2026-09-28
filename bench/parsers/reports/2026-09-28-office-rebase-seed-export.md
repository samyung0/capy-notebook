# DOCX and PPTX publication rebases stored as their change over seed(export)

A publication that rebases edits saved after its capture now lands them on
seed(export) for DOCX and PPTX, as it already did for XLSX. The rebased state
is stored as its Yjs change over that seed, and no row stores a baseline
(migration 0043). Across the 12 DOCX and PPTX fixtures, the rebased rows went
from **1,074.8 KB** of compressed state plus baseline to **4.2 KB**. XLSX rows
are unchanged. [Raw measurements](2026-09-28-office-rebase-seed-export.json);
the "before" columns come from the
[stage 1 report](2026-09-28-office-state-diffs.md).

Sizes are decimal KB. "Row" is the `pg_column_size` of the stored state, plus
the stored baseline before this change (pglz, as PostgreSQL keeps them).
"Charge" is the row's quota beyond the source, pending effects included.
"Later save" is the change a save stores before the publication, which this
change leaves alone.

| File | Source | Rebased row, before | Rebased row, after | Rebased charge, before | Rebased charge, after | Later save |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| lesson.docx | 37.41 | 3.85 | 0.47 | 13.93 | 0.93 | 0.19 |
| grades.xlsx | 5.54 | 0.18 | 0.18 | 0.47 | 0.47 | 0.30 |
| lesson.pptx | 29.34 | 3.54 | 0.05 | 9.69 | 0.30 | 0.19 |
| exchange-plan.docx | 65.72 | 91.59 | 0.39 | 436.66 | 2.82 | 0.52 |
| course-guide.xlsx | 145.43 | 0.18 | 0.18 | 0.47 | 0.47 | 0.30 |
| lecture.pptx | 311.19 | 50.86 | 0.24 | 189.31 | 0.48 | 0.38 |
| feature-rich.docx | 39.17 | 14.22 | 0.54 | 59.38 | 1.10 | 0.22 |
| feature-rich.xlsx | 7.26 | 0.21 | 0.21 | 0.49 | 0.49 | 0.33 |
| feature-rich.pptx | 16.55 | 12.05 | 0.05 | 51.48 | 0.29 | 0.19 |
| book-30p.docx | 47.97 | 144.88 | 0.47 | 421.54 | 0.83 | 0.18 |
| images-10.docx | 4,190.86 | 39.53 | 0.47 | 116.56 | 3.46 | 0.18 |
| opaque-objects.docx | 59.24 | 26.02 | 0.47 | 66.99 | 1.83 | 0.18 |
| deck-50.pptx | 94.19 | 121.70 | 0.05 | 368.41 | 0.29 | 0.19 |
| cells-1k.xlsx | 14.64 | 0.17 | 0.17 | 0.47 | 0.47 | 0.29 |
| cells-10k.xlsx | 89.39 | 0.17 | 0.17 | 0.47 | 0.47 | 0.29 |
| cells-100k.xlsx | 836.42 | 0.17 | 0.17 | 0.47 | 0.47 | 0.29 |
| jp_llm2.pptx | 24,390.71 | 354.22 | 0.89 | 1,196.19 | 1.22 | 1.03 |
| zh_TW_llm.pptx | 8,756.52 | 212.38 | 0.13 | 767.08 | 0.36 | 0.27 |

A rebased row is now about as large as a later save, not as large as the
document. Before this change, a DOCX or PPTX row kept the whole state in its
old lineage, and the baseline mapped into it. The owner paid for both. Now the
owner pays for the change plus the pending effects.

DOCX rebased changes are about 0.4–0.5 KB, roughly twice the later save they
carry. They are about 20 bytes larger than with BetterOffice `6957d886`: text
typed into a run now inherits its complex-script theme font (`csTheme`), which
the export used to write as `w:csTheme`, a spelling seed(export) did not read
back. PPTX rebased changes are 0.05–0.89 KB. One save and a later save store
what they stored in stage 1, within 2 bytes (clients get random ids). The
per-fixture time, which includes seeding, both edits, the export and the
rebase, is the same or lower (jp_llm2.pptx: 10.1 s → 5.1 s).

## Method

`bench/parsers/scripts/office_storage.ts` on the same 18 fixtures as the stage
1 report, Capy `872a7546`, BetterOffice `a7fdc61a` (branch
`capy/office-rebase-seed-export`), PostgreSQL 16.15 (`pglz`) in a disposable
local container. Each fixture is seeded, gets the 20-byte probe edit and is
exported. It then gets the 18-byte later edit and is rebased onto the export.
Every rebased state is stored as its change over seed(export) through
`seedChange`, which checks that seed(export) plus the change rebuilds the state
exactly. The run also checks that the rebased state still carries the later
edit over the export. The script no longer writes `derived_baseline_bytes` or
the `baseline_*` fields, because nothing stores a baseline.
