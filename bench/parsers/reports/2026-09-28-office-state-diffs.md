# Office editing state stored as its change over the seed

Since migration 0039 the collaboration service stores an Office state that grew
from seed(base) as its Yjs change over that seed, named by the seed's SHA-256,
and every Office row is charged its stored bytes (text keeps its growth-over-seed
charge). Across the 18 native fixtures one saved edit now stores
**4.7 KB** of compressed state instead of **559.0 KB**.
The state is the bulk of what each save rewrites in PostgreSQL (TOAST and WAL);
effects, the ledger row and locks stay as they were. [Raw measurements](2026-09-28-office-state-diffs.json).

Sizes are decimal KB. "Stored" is `pg_column_size` of the state (pglz, as
PostgreSQL keeps it); "charge" is the row's quota beyond the source.

| File | Source | One save, full state | One save, change | Later save, full state | Later save, change | Charge, old rule | Charge, new rule | Rebased row, old | Rebased row, new |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| lesson.docx | 37.41 | 2.16 | 0.15 | 2.20 | 0.18 | 0.59 | 0.61 | 3.85 | 3.85 |
| grades.xlsx | 5.54 | 1.11 | 0.25 | 1.15 | 0.30 | 0.52 | 0.52 | 1.05 | 0.18 |
| lesson.pptx | 29.34 | 1.48 | 0.15 | 1.51 | 0.19 | 0.39 | 0.39 | 3.54 | 3.54 |
| exchange-plan.docx | 65.72 | 47.86 | 0.49 | 47.90 | 0.53 | 2.52 | 2.88 | 91.59 | 91.59 |
| course-guide.xlsx | 145.43 | 5.79 | 0.25 | 5.83 | 0.30 | 0.53 | 0.53 | 5.74 | 0.18 |
| lecture.pptx | 311.19 | 25.30 | 0.33 | 25.34 | 0.38 | 0.35 | 0.54 | 50.86 | 50.86 |
| feature-rich.docx | 39.17 | 8.80 | 0.17 | 8.83 | 0.21 | 0.66 | 0.71 | 14.22 | 14.22 |
| feature-rich.xlsx | 7.26 | 3.21 | 0.28 | 3.25 | 0.33 | 0.57 | 0.57 | 3.15 | 0.21 |
| feature-rich.pptx | 16.55 | 4.71 | 0.15 | 4.74 | 0.19 | 0.35 | 0.35 | 12.05 | 12.05 |
| book-30p.docx | 47.97 | 72.45 | 0.14 | 72.49 | 0.18 | 0.48 | 0.49 | 144.88 | 144.88 |
| images-10.docx | 4,190.86 | 18.54 | 0.14 | 18.57 | 0.18 | 3.08 | 3.09 | 39.53 | 39.53 |
| opaque-objects.docx | 59.24 | 17.30 | 0.14 | 17.34 | 0.18 | 1.49 | 1.50 | 26.02 | 26.02 |
| deck-50.pptx | 94.19 | 47.11 | 0.15 | 47.15 | 0.19 | 0.39 | 0.39 | 121.70 | 121.70 |
| cells-1k.xlsx | 14.64 | 1.65 | 0.25 | 1.69 | 0.29 | 0.51 | 0.51 | 1.59 | 0.17 |
| cells-10k.xlsx | 89.39 | 1.65 | 0.24 | 1.69 | 0.29 | 0.51 | 0.51 | 1.59 | 0.17 |
| cells-100k.xlsx | 836.42 | 1.65 | 0.25 | 1.69 | 0.29 | 0.51 | 0.51 | 1.59 | 0.17 |
| jp_llm2.pptx | 24,390.71 | 186.42 | 0.98 | 186.46 | 1.03 | 0.45 | 1.28 | 354.22 | 354.22 |
| zh_TW_llm.pptx | 8,756.52 | 111.75 | 0.22 | 111.79 | 0.27 | 0.33 | 0.41 | 212.38 | 212.38 |

The charge stays within a few hundred bytes of the old rule: before, the owner
paid the state's growth beyond the seed; now the owner pays the stored change,
which is about the same size. A DOCX or PPTX state left by a publication that
rebased later saves keeps its old lineage and stored baseline, so it is stored
whole and its row size does not change; XLSX rebases onto seed(export) and
stores its change there. Rebasing DOCX and PPTX onto seed(export) the same way
was not approved in this round.

## Method

`bench/parsers/scripts/office_storage.ts` on the 18 fixtures of the September 28
report, BetterOffice `64bbde82`, PostgreSQL 16 (`pglz`) in a disposable local
container. Each fixture is seeded, gets the 20-byte probe edit, is exported,
gets the 18-byte later edit and is rebased onto the export. Every stored change
is checked to rebuild its state exactly (`seedChange` in
`collaboration/src/sourceDocuments.ts`). The full-state columns are the same
states stored whole with the earlier growth-over-seed charge. The live UAT
upload, parse and publication costs in the September 28 report are unchanged by
this storage change and were not rerun.
