# Parser audit: raw v18 against the reviewed text

Date: 2026-10-18, on the Windows PC. Question (Epo, from the 2026-10-14 parser
handoff): with the current parser, does raw parser text come close enough to
the reviewed library text to change intake or justify re-parsing the 182
published books? Run data sits in the ignored
`bench/rag/reports/local/2026-10-intake-eval/` (`raw-v18-run/`, the audit
packets and `*.raw_v18-reviewed.verdict.json` under `audit/`).

## Summary

- **Raw v18 is far behind the reviewed text on formula books and close to it
  on prose and statistics.** Across the 62 pages: 117 of 179 raw blocks are
  faithful (65%), against 137 of 180 reviewed blocks (76%). The judge found
  72 silent errors (wrong or missing) in the raw text on 25 pages, against
  22 on 19 pages in the reviewed text.
- **Two books carry 61 of the 72 raw silent errors.** Brief Calculus (31)
  and Fundamentals of Electrical Engineering I (30) print formulas as
  pictures. The raw text leaves a `[formula]` placeholder for many of them
  (42 judged issues; 1,895 placeholders in 333 of Brief Calculus's 547
  chunks, 486 in 260 of EE I's 690). Others vanish with no placeholder,
  such as "For any real numbers , , and , if , then ." on Brief Calculus
  p45. The reviewed text has no placeholder left on any audited page: review
  typed the formulas.
- **On the three statistics books, raw and reviewed tie on silent errors**
  (11 against 12). The raw text is still worse there: flattened fractions
  ("Z = x−SDmean" for Z = (x − mean)/SD), so 20 garbled issues against 12,
  and more figure text lifted into prose. Learning Statistics with jamovi is
  equal (44 of 46 against 45 of 47, no silent errors on either side).
- **Recommendation:** do not re-parse the 182 published books. Their text is
  the reviewed side; a re-parse would replace it with raw text that is worse
  on formulas, so it has to be reviewed again. Keep full review for new
  books. Reviewing only pages the parser flags is not safe yet, because
  formulas that vanish without a placeholder raise no flag.

## Method

- **Parser:** the builder parser container rebuilt from main at `66824fa92`
  (`odl-2.5.7-refined-vlm-v18`) with `CAPY_MAX_SOURCE_BYTES=209715200`,
  `CAPY_PARSE_WORKERS=1` and `CAPY_PARSE_MAX_PAGES=100000`, plus
  `MALLOC_ARENA_MAX=2`, a 1,800 s document deadline and a 3 GiB JVM heap as on
  the v16 builder. The five books were parsed through the pilot's parse stage
  (`knowledge_base_pilot.py parse`), so each chunk is the production chunker's
  output with no transcription, review or tagging. The parser no longer reads
  scanned pages, but every audited page has a text layer.
- **Sample:** the 62 pages of `bench/rag/intake/fixtures/audit-pages.json`
  (3% per book, seed 20261006): ahss4 15, brief-calculus 7, EE I 11, lsj 15,
  os4 14. The reviewed side is the live library text as captured for the
  2026-10-07 audit.
- **Judge:** the frozen prompt `audit-judge-prompt.txt` and schema, Claude
  Opus 5.5 at medium effort, texts labelled A and B in the same seeded
  per-page order, one call per page. The 10-07 verdicts ran through the
  Claude Code CLI; this run used the Anthropic API directly (380k input and
  51k output tokens for 62 calls, about 10 minutes).
- **Pages seen before:** none of the five books is in a named v13/v14
  development set or in v18's flattening dev set. Two gaps remain: v14's
  "19 earlier books" are not listed anywhere, and os4 is in v18's blind
  flattening pool, which reported totals only. Three audit pages were looked
  at in September's v12 work (os4 p54, brief-calculus p227, EE I p59), so
  the totals are also given without them. Raw v18 differs from raw v16 on 5
  pages (ahss4 223, 356, 434; os4 426, 458), all in figure text that v18's
  flattening now keeps with its figure.

## Results (62 pages)

| Text | Blocks | Faithful | Wrong | Missing | Garbled | Extra | Pages with silent errors |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Reviewed (10-07 run, against MinerU) | 180 | 134 (74%) | 13 | 5 | 19 | 29 | 14 |
| MinerU 4.0 standard, no review (10-07) | 190 | 133 (70%) | 26 | 12 | 24 | 31 | 20 |
| Reviewed (this run, against raw v18) | 180 | 137 (76%) | 16 | 6 | 13 | 25 | 19 |
| Raw ODL v18, no review | 179 | 117 (65%) | 5 | 67 | 35 | 33 | 25 |

The reviewed text was judged twice, against MinerU and against raw v18: 134
then 137 faithful blocks, 18 then 22 silent errors. Differences of that size
are judge noise.

Without the three pages seen in September: raw v18 115 of 171 faithful
(67%), 59 silent errors on 22 pages; reviewed 136 of 173 (79%), 18 on 16.

By book (faithful of blocks, silent errors), reviewed against raw v18:

| Book | Reviewed | Raw v18 |
| --- | --- | --- |
| Advanced High School Statistics (ahss4) | 40/53, 6 | 31/48, 6 |
| Brief Calculus | 10/19, 3 | 6/21, 31 |
| Fundamentals of Electrical Engineering I | 12/20, 7 | 12/25, 30 |
| Learning Statistics with jamovi (lsj) | 45/47, 0 | 44/46, 0 |
| OpenIntro Statistics (os4) | 30/41, 6 | 24/39, 5 |

## What the raw errors are

- **Formula pictures.** In Brief Calculus and EE I nearly every raw silent
  error is a formula missing from the text, either as `[formula]` or as an
  empty gap: display equations dropped whole (EE I p19's RMS formula, p154's
  Fourier series), inline symbols dropped from sentences (Brief Calculus
  p45, p135). This is the case the 2026-09-25 placeholder decision leaves to
  the review: workers type the formula from the page image.
- **Flattened fractions and stacked notation** on the statistics books:
  numerators and denominators run together ("x¯ = n1 ∑xi", "P(A∣B)=
  PP(A(B∩B) )"). The judge counts these as garbled rather than silent. They
  still mislead a reader, and the review rewrites them.
- **Figure and table text** lifted into prose (extra), on both sides.

## Receipts

- Scripts: `bench/rag/intake/scripts/audit_packets.py` (`--run-side
  NAME=DIR` adds a builder run's corpus as a side and keeps the judged MinerU
  side), `audit_judge.py` (`--sides A,B`, Anthropic API transport, pages with
  silent errors in `summary`), and the pilot's `vlm_pages` import fix in
  `bench/rag/scripts/knowledge_base_pilot.py`.
- Commands: `audit_packets.py --run-side raw_v18=<run dir>`, then
  `audit_judge.py run --sides raw_v18,reviewed` and `summary --sides
  raw_v18,reviewed`; re-tallying the 10-07 verdicts with `--sides
  mineru,reviewed` reproduces the 2026-10-07 table exactly.
- Local: `raw-v18-run/<book>/` (manifest, parse log, corpus), and the
  earlier `raw-v15-run/` and `raw-v16-run/`.
