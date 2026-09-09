# Rejected in-line hyphen relaxation

The proposed relaxation cannot repair the three remaining hyphen-blocked CCL
overprint cases. Source pixels show that every missing hyphen occurs at a
physical line end, which the proposed rule explicitly excludes. No candidate
was implemented, and all accepted helpers and outputs remain unchanged.

The intended proof required a visible hyphen between characters on one PDF
line, exact correspondence for every other character, and the existing source
glyph multiplicity and geometry proof for any overprint deletion. It allowed
neither fuzzy matching nor reconstruction of discretionary line-end hyphens.

| Source | Existing native output | Visible source lines | Decision |
| --- | --- | --- | --- |
| CCL feedback p14, native text 438 | `GPT3.5` | `GPT-` followed by `3.5` on the next line | Excluded line-end hyphen |
| CCL chain of thought p14, native list 639 | `lowquality` | `low-` followed by `quality` on the next line | Excluded line-end hyphen |
| CCL children p8, native list 142 | `Gemini-1.0pro` | `Gemini-1.0-` followed by `pro` on the next line | Excluded line-end hyphen |

All three original-PDF crops were visually reviewed. Feedback text coordinates
were located using the previously validated font-rebuilt PDF, but the displayed
pixels came from the original PDF. The same omitted forms remain in actual
indexed body chunks 68, 61 and 33 respectively, using zero-based chunk indices
in `2026-09-09-odl-third-pass/refined-cluster-r1`.

This source-first feasibility rejection does not require a 765-page candidate
replay: no accepted transformation exists under the proposed condition, and no
candidate output or performance result is claimed. Extending the rule to these
cases would require an additional justification for line-end hyphen semantics;
that was outside this bounded experiment. Existing strict overprint abstentions
remain explicit.

Evidence is under `local/2026-09-09-odl-inline-hyphen/`:
`source-audit-initial.json` records source lines and coordinates;
`source-verdicts.json` binds original PDF, source crop, strongest existing raw
output and actual chunks by SHA-256. The directory also contains the source
crops and an artifact manifest. No runnable script was added for a rejected
source condition.
