# Rich-content Office fixtures

These files started as real documents and were edited at the package level, part
by part, so every feature the original authoring app wrote survives. They cannot
be regenerated from this repository. `exchange-plan.docx` is the developer's own
Chinese study-tour report, with committee member names replaced and its two
pie-chart screenshots rebuilt as native Word charts. `course-guide.xlsx` is a
Google Sheets export with a synthetic `Summary` sheet added. `lecture.pptx` keeps
the structure of a third-party talk (slides 1-18 and 20) with its text replaced by
same-length Latin filler; slide 19 is the developer's own. Photos and slide
pictures are labelled placeholder images with the original part names and aspect
ratios. Embedded fonts were removed, and document properties carry no author
names and fixed 2026-01-01 dates.

| File | Input facts | Action | Expected persisted result |
| --- | --- | --- | --- |
| exchange-plan.docx | 116 top-level body paragraphs of PMingLiU CJK text, including `主題：智能科技，精湛技術` and `人數：20人` (one run each); the last is exactly `UAT_RUN_MARKER`, which the runner owns. Table 1 (section 5 工作計劃) row 1: `陳大文主席`, `李小明外務副主席`, `何晴內務副主席`, `張志強宣傳幹事`; row 2: `工作`, `統籌`, `計劃設計`, `聯絡機構`, `宣傳工作`. Section 8 財務計劃 has one paragraph with two inline native pie charts (`rId9` → `charts/chart1.xml`, `rId10` → `charts/chart2.xml`, each with an embedded workbook). Chart `交流團預計支出`, series `港幣（每人）`: 機票 3000, 住宿 1500, and 300 each for 交通, 午膳, 宣傳費用, 迎新營 and 設施入場費 (50/25/5/5/5/5/5 %). Chart `交流團預計收入`: 報名費 4000, 工程學院資助 800, 國際青年交流資助計劃 500 (75.5/15.1/9.4 %), the report's per-person table values. Also six tables, three inline PNG pictures (`rId6`-`rId8`, labelled `Figure N placeholder: …`), a footer part holding one empty paragraph, footnote and endnote parts, five `w:br w:type="page"` breaks and six runs tagged `w:lang w:eastAsia="ja-JP"`. | Actor A changes `人數：20人` to `人數：24人`; actor B appends a sentence to `主題：智能科技，精湛技術`. Reopen, export and process changes. | Export and index contain `人數：24人` and the extended `主題` paragraph. The marker paragraph, the table cells, both chart drawings with their chart parts, embedded workbooks and cached values, the three picture hashes, the footer, page breaks and eastAsia tags survive. |
| course-guide.xlsx | Sheets `CC info`, `Faculty Database`, `Summary`; about 55k styled cells. `Summary!A1:D1` = `Area`, `Courses`, `Rated courses`, `Average workload`; `A2:A5` = `CCCH`, `CCGL`, `CCHU`, `CCST`. `B2` `=COUNTIF('CC info'!$A$3:$A$170,A2&"*")`, `C2` `=COUNTIFS('CC info'!$A$3:$A$170,A2&"*",'CC info'!$H$3:$H$170,">=0",'CC info'!$H$3:$H$170,"<=10")`, `D2` `=IFERROR(AVERAGEIFS('CC info'!$H$3:$H$170,'CC info'!$A$3:$A$170,A2&"*",'CC info'!$H$3:$H$170,">=0",'CC info'!$H$3:$H$170,"<=10"),"")`, filled to row 5 as one formula per cell, the way Excel writes cross-sheet fill-downs. `E1` = `Rated share`; `E2:E5` is the shared formula `C2/B2` (`<f t="shared" ref="E2:E5" si="0">`). Cached values, equal to Excel's after a full recalculation: `B2:B5` 35, 36, 50, 47; `C2:C5` 9, 7, 10, 18; `D2:D5` 4.077777777777778, 4.271428571428571, 5.2, 6.300000000000001; `E2:E5` 0.2571428571428571, 0.19444444444444445, 0.2, 0.3829787234042553. `CC info!H77`, `H107` and `H113` hold date serials (format `m. d`) that the `<=10` condition excludes. `Summary!A7` is the shared string `UAT_RUN_MARKER`. A clustered column chart titled `Average workload by area` (F2:M18) plots `Summary!$D$2:$D$5` by `$A$2:$A$5`. `CC info` has frozen panes at `C3`, merges `E1:H1`, `I1:L1`, `M1:P1`, a conditional format on `I1` and a hyperlink at `P32`. `Faculty Database` has merges from `A3:A7` and hyperlinks at `E9` and `E10`. | Actor A sets `CC info!H5` (CCHU9001, 2) to 4; actor B edits a `Faculty Database` cell. Reopen, export and process changes. | Export contains both values and the `Summary` formulas unchanged; `D4` evaluates to 5.4 (`C4` stays 10). Sheet names, merges, frozen panes, conditional format, hyperlinks and the `Summary` drawing-to-chart relationship survive. |
| lecture.pptx | 20 slides in 16:9, two masters, 22 layouts. Slide 1 title `Rich deck fixture` and one subtitle paragraph `UAT_RUN_MARKER`. Slide 3 first body paragraph `Owner sentence: The survey cart weighs 42 kilograms.`; slide 18 first body paragraph `Collaborator sentence: The field test starts in June.`; slide 2 speaker note `Speaker note: the rehearsal takes 12 minutes.` Slide 19 table: `Date`, `Restaurant`, `Menu`, `Price`, `Headcount` / `2026/09/22`, `Burger A`, `Beef burger`, `$20`, `4` / `2026/09/23`, `Burger B`, `Veggies burger`, `$12`, `2` / `2026/09/24`, `Burger C`, `Pasta`, `$90`, `1`. Two legacy comments by `Fixture Author` (`FA`) on slide 19: `this date can be wrong`, `too expensive`. 25 pictures use 22 media parts (21 PNG, one JPEG) labelled `Slide picture N`. Connectors on slides 8 and 12; external hyperlinks on slides 2, 5, 7, 8, 9, 12 and 15; 19 notes slides. | Actor A replaces the slide 3 owner sentence; actor B replaces the slide 18 collaborator sentence. Reopen, export and process changes. | Export and index contain both sentences. The slide 19 table cells and both comments, the slide 2 note, the media hashes, connectors and hyperlink targets survive. |

The runner replaces `UAT_RUN_MARKER` inside the XML part that holds it (DOCX
`word/document.xml`, XLSX `xl/sharedStrings.xml`, PPTX `ppt/slides/slide1.xml`).

## Current engine results

Checked on 2026-09-25 with the pinned runtime (`vendor/betteroffice` at
`dfa3f05e`, local `shared/office-checkpoint.mjs` build of 2026-09-18):
`seedOffice`, `inspectOffice`, then `exportOffice` with no edits.

- All three files seed and export. `inspectOffice` finds the marker in the last
  DOCX body paragraph, `Summary!A7` and the slide 1 subtitle. It lists 55,089 XLSX
  entries and 115 PPTX entries, none of them speaker notes.
- DOCX export loses both chart drawings from `word/document.xml`. The chart parts,
  embedded workbooks and `rId9`/`rId10` relationships stay behind unreferenced.
  The five page-break paragraphs become empty paragraphs with `w:pageBreakBefore`
  on the next one. The six eastAsia language tags and the section's `w:pgNumType`
  and `w:cols` are dropped. The export adds empty comment parts. Pictures (same
  bytes, new `docPr` ids), tables, footer and marker survive.
- XLSX export keeps the `Summary` sheet, its drawing and chart byte-identical
  (formulas including the shared `E2:E5`, cached values and marker) and sets
  `fullCalcOnLoad="1"` on `calcPr`. The two original sheets are rewritten with
  their 1,355 shared-string cells as inline strings; merges, frozen panes,
  conditional formatting, hyperlinks and drawing references survive.
- PPTX export returns every part byte-identical, including the table, comments,
  notes and pictures.
