# Independent new-source heading release review

**Final guarded-candidate closure:** the original 20 cases now score **13 passes, 6 failures and 1 abstention**, matching the old baseline's witness outcomes. The two introduced scope exposures described below are removed by declining the unsafe root rewrites. This preserves the old errors rather than repairing them. The historical failed-candidate review follows unchanged; final evidence and limits are appended at the end.

The frozen 20 witnesses yield **14 passes, 5 failures and 1 abstention** across five completed fresh parses. Only three passing witnesses were corrected by the reviewed heading stage. Eleven passes preserve behavior already present at its input. The five failures also remain unchanged at that stage. These results do not establish a general heading fix.

**Paired-baseline follow-up: a new scope regression exists outside the frozen cases.** Promoting LibreOffice's Copyright root causes the following independent Contents section to inherit Copyright. The full paired run confirms all five frozen failures predate this change. Within the gold, only OECD Part A improves against old production: baseline 13 passes, 6 failures, 1 abstention; candidate 14 passes, 5 failures, 1 abstention. The earlier three stage corrections must not be presented as three newly fixed witnesses.

Sources and gold were selected before candidate outputs. The five official PDFs cover R/Texinfo, forall x/LaTeX, OECD Word/PDFsharp, LibreOffice and WeasyPrint. All result receipts match the frozen source hashes and page counts, covering 1,577 physical pages. The review checks the selected source regions and following prose ancestry, not every heading across those pages. No production code, source gold or KB content was changed.

| Frozen cases | Source witnesses | Verdict | Observed behavior |
| --- | --- | --- | --- |
| 01–03 | forall x parts I, II and IX, pages 11, 36, 378 | Fail, unchanged | Part labels remain level 4 under stale earlier sections. Full part titles remain body text. |
| 04 | forall x chapter 1, page 12 | Pass, preserved | Arguments remains a heading and anchors prose. Missing part ancestry is scored in case 01. |
| 05 | forall x running title, page 13 | Pass, corrected | Heading level 13 becomes running-banner; following prose remains under Arguments. |
| 06 | LibreOffice top-margin section, page 14 | Pass, preserved | Where to get more help remains a heading and anchors its explanatory prose. |
| 07 | LibreOffice odd footer, page 13 | Pass, preserved | Extensions and add-ons with folio 13 is already a paragraph, excluded from outline. |
| 08 | LibreOffice even footer, page 14 | Fail, unchanged | The footer remains heading level 15 and becomes an ancestor of following-page prose. |
| 09 | LibreOffice chapter root, page 23 | Pass, preserved | Complete chapter title remains root 1; installation prose has correct ancestry. |
| 10–11 | R chapter roots, pages 8 and 13 | Pass, preserved | Both chapters remain sibling level-2 headings under the retained book root; following subsection prose is correctly attached. |
| 12 | R running title, page 12 | Pass, corrected | Heading level 7 is removed. Its diagram-label marker is imprecise, but the banner is excluded from outline. |
| 13 | OECD executive root, page 21 | Pass, preserved | Executive summary remains root 1. A separate folio contamination remains, described below. |
| 14 | OECD Part A, page 44 | Pass, corrected | Complete three-line part title changes from level 2 to 1; following chapter A1 prose belongs to Part A. |
| 15 | OECD Part C, page 250 | Pass, preserved | Complete title remains root 1; subsequent Introduction prose belongs to Part C. |
| 16 | OECD chart ticks, page 46 | Abstain | Source ticks are image-only in native extraction. Their absence proves neither preservation nor repair. |
| 17–18 | WeasyPrint running titles, pages 4–5 | Pass, preserved | Both are already paragraph text, excluded from outline. |
| 19 | WeasyPrint multiline title, page 4 | Pass, preserved | Both lines form a heading; column prose retains that ancestry. |
| 20 | WeasyPrint offer price, page 6 | Fail, unchanged | Price remains a heading; subsequent offer prose is attached to the final price. |

The forall x failures affect navigation beyond the divider pages. Page 11 produces `forallx › Preface › PART I`; page 12 prose instead appears under `forallx › Arguments`, with no part ancestor. Part II is under `Other logical notions`, and following chapter 4 prose retains that stale ancestor. Part IX is under `Introducing modal logic`; page 379's disjunctive-normal-form prose inherits that incorrect parent. Complete embedded root inventories alone did not recover these visually confirmed parts.

LibreOffice's alternating pattern remains asymmetric. The odd-page footer is body text, but `14 | Preface` remains a heading. Page 15's Get Involved prose inherits `Preface › Where to get more help › Help system › Show Tip of the Day › 14 | Preface`. The true top-margin section itself survives correctly.

WeasyPrint page 6 has three offer prices promoted to sibling level-4 headings. The following text from all three columns lands under `Report example › Big title on the first right page › €200`. Case 20 scores the frozen first-price witness; the other prices and prose confirm the practical consequence, without adding cases to the denominator.

Outside the frozen role checks, OECD page 21's opening paragraph inherits `Executive summary › [folio] 19`. The root is preserved, so case 13 passes its frozen expectation, but the extra folio ancestor is a residual error. R also retains some standalone folios as heading/body noise. Neither observation is evidence of a new regression without an old-production baseline on these same files.

“Corrected” and “unchanged” refer to the exported `heading-stage.json` before/after records. The records cover one stage, not a paired old-versus-new production run. No fix-introduced violation was observed in the frozen witnesses; the review cannot rule out regressions elsewhere or attribute all upstream behavior to the old production implementation. Text matching allowed normal whitespace and line joining, and a book parent above chapter roots, rather than requiring literal slash delimiters or an absolute level of 1.

The tranche covers alternating/changing single-line banners and multiline true titles. It does not contain a genuinely multiline recurring banner, and all sources are English. Do not count source pages, unchanged PDFs, absent native labels or abstentions as repair successes.

Reproduction artifacts:

- Sources: `bench/parsers/fixtures/heading-release-sources-2026-09-20.json`, SHA256 `87447bf832777f9f1c29a9588270acb20d9e96115a9607f4bfbd1ba282262a43`.
- Gold: `bench/parsers/fixtures/heading-release-gold-2026-09-20.json`, SHA256 `35d69a416c98a9be7ebf0e998ca779a5d4b92c6b6b85818c3f17ac93452c3e95`.
- Outputs: `bench/parsers/reports/local/2026-09-20-parser-repairs/<source-id>/{content_list,chunks,heading-stage,result}.json`.
- Individual verdicts and hashes of reviewed output artifacts: `bench/parsers/reports/local/2026-09-20-heading-release/release-score.json`.
- Source renders and audit: `bench/parsers/reports/local/2026-09-20-heading-release/`.

## Full paired-baseline follow-up

All five old-production parses completed with return code 0. A separate container ran an isolated 98-file Python snapshot. Six files were replaced with exact `git show HEAD:<path>` bytes from `a0a65cb02be1a9628c0efa50fbea4853910d5622`: `parser/app.py`, `parser/odl/headings.py`, `parser/odl/java.py`, `parser/odl/refine.py`, `pipeline/pipeline/retrieval/chunking.py`, and `pipeline/pipeline/retrieval/packing.py`. Other imported parser/pipeline Python files were copied without changes. No working-tree production files were altered. Baseline-versus-candidate `inputs.json` comparison shows exactly those six differing identities; the harness, source manifest and remaining recorded parser identities match.

| Source | Baseline wall seconds | Full paired result |
| --- | ---: | --- |
| R | 8.793 | Final blocks and complete chunk JSON exactly identical. |
| forall x | 66.742 | Final blocks and complete chunk JSON exactly identical. |
| OECD | 81.907 | 498 block-role/level changes; 745 chunk paths change. |
| LibreOffice | 53.566 | One root-level change; 24 chunk paths acquire an incorrect Copyright ancestor. |
| WeasyPrint | 10.762 | Final blocks and complete chunk JSON exactly identical. |

These are completion receipts, not comparative speed results. Both arms used the same dependency image with two CPUs and 6 GiB memory; baseline explicitly set `OMP_NUM_THREADS=2`, while candidate used image default 8. The image identity is `sha256:495258462aeb92d238512c26c33862fa762baba490651b2c53f4d75696530b67`.

### Introduced LibreOffice scope regression

Final content-list index 8, native ID 3, physical page 2, changes Copyright from heading 6 to heading 1. Index 23, native ID 19, physical page 3, remains Contents at heading 6. They were sibling headings before promotion. The source outline includes Copyright on page 2 with Contributors, Feedback and Publication date as children, then Preface on page 9. It omits Contents. Source pages 2 and 3 visibly use the same green heading style for separate Copyright and Contents sections.

The candidate turns 24 chunk paths on pages 3–9 from `Contents ...` into `Copyright › Contents ...`. This is a new incorrect ancestor. The promotion crosses an existing peer boundary that the PDF outline does not represent. Native blocks and normalized combined chunk text otherwise match. The source render `paired-libreoffice-copyright-contents.png` and `paired-heading-libreoffice-path-deltas.json` retain the evidence. This is outside frozen gold, so the gold denominator remains 20; it independently prevents a clean release assessment of the reviewed candidate.

### OECD changes beyond gold

There are 493 running-footer demotions, 489 with the 2024 copyright line and four with the source's 2023 variant. The five other changes promote complete embedded roots at pages 24, 44, 155, 463 and 489: SDG, Part A, Part B, Annexes and Contributors. All five source titles were visually checked, including four additional checks after candidate output discovery. These post-output checks are qualitative review, not additional frozen cases.

The 745 changed paths remove stale earlier root ancestors or the recurring footer ancestor. Two paths within Part D specifically lose the footer child. Seven chunk texts/region collections change through repacking and overlap redistribution; three page ends and confidence values also change. Concatenated text therefore differs in repeated reference material, but the set of normalized paragraphs is identical across arms. No unique paragraph is lost or added. A subsequent independent guard review found a new incorrect Contributors ancestor on back-cover page 498, described below. No final block text, page or box changes occur.

### Isolation and reproduction

Snapshot construction copied `parser/*.py`, `parser/odl/**/*.py`, `pipeline/pipeline/**/*.py` and the validation harness at its ordinary relative path. Each of the six old files was obtained with `subprocess.check_output(['git', 'show', 'HEAD:' + path])`, avoiding PowerShell text re-encoding. The ignored snapshot is `bench/parsers/reports/local/2026-09-20-heading-release/baseline-code`; file hashes and HEAD provenance are in `baseline-code-receipt.json`.

```powershell
docker run --detach --name capy-parser-heading-baseline-20260920 --network none --cpus 2 --memory 6g --user 0 -e CAPY_RAPIDOCR_MODEL_DIR=/models/rapidocr -e OMP_NUM_THREADS=2 --mount type=bind,source=C:/WEB/capy-notebook/bench/parsers/reports/local/2026-09-20-heading-release/baseline-code,target=/repo,readonly --mount type=bind,source=C:/WEB/capy-notebook/bench/parsers/fixtures,target=/repo/bench/parsers/fixtures,readonly --mount type=volume,source=capy-parser-release-validation-20260920,target=/output capy-kb-parser:pilot-v4 python /repo/bench/parsers/scripts/validate_parser_repairs.py --manifest /repo/bench/parsers/fixtures/heading-release-sources-2026-09-20.json --output /output/baseline-new-sources --timeout 600
docker cp capy-parser-heading-baseline-20260920:/output/baseline-new-sources bench/parsers/reports/local/2026-09-20-heading-release/baseline-new-sources
```

The harness bounds each full worker at 600 seconds and checks code/source identities before and after parsing. Full baseline outputs, worker logs, inputs and summaries remain under the exported `baseline-new-sources`. `paired-run-receipt.json` retains container configuration and baseline artifact hashes; `paired-summary.json` and per-source path deltas retain comparisons. The container exited successfully and was left intact. No service, ingest, network access or KB operation was performed.

### Additional OECD boundary adjudication

The heading guard reviewer flagged the back cover after the initial paired review. Source page 498 visibly starts an independent publication title and descriptive blurb. Candidate block 6086 on page 489 promotes Contributors from level 7 to 1; back-cover block 6125 remains level 6 and is omitted from the embedded outline. Chunk 1475 therefore gains `Contributors to this publication` above the back-cover title and OECD Indicators. The source does not support this relationship.

The baseline was already wrong here: `Part D › Annexes › Annex 2. Reference statistics › Education at a Glance 2024 › OECD Indicators`. The candidate replaces those stale ancestors with a new incorrect Contributors ancestor. Unlike LibreOffice Contents, this is not a previously correct path becoming incorrect, but it is another root-promotion scope exposure and requires the same boundary control. The earlier absence-of-analogous-error statement was too broad and has been corrected. The retained source image is `paired-oecd-back-cover.png`. Frozen gold scores stay unchanged.

## Final guarded-candidate closure

The final reruns under `bench/parsers/reports/local/2026-09-20-parser-repairs/final` were checked only against the frozen 20 witnesses and the two reviewed scope exposures. All five source hashes and page counts still match the paired baseline. No source gold changed.

Final outcome: **13 passes, 6 failures, 1 abstention**. Cases 01, 02, 03, 08 and 20 retain their old failures. Case 14, OECD Part A, now also fails because the guard declines the root-level rewrite: Part A remains level 2, and following chapter A1 prose remains beneath Executive summary. Case 16 remains unmeasured because the chart ticks lack native text. All remaining cases pass as preserved baseline behavior. There are zero newly repaired frozen witnesses and zero new frozen-witness regressions relative to old production.

The LibreOffice Copyright-to-Contents regression is removed. Complete final chunk JSON equals the old baseline, so the 24 incorrect Copyright prefixes are gone. Contents again starts its own scope. The old alternating-footer failure remains.

The OECD Contributors-to-back-cover exposure is also removed. The page 498 chunk path exactly matches old baseline and no longer contains Contributors. Its old Part D, Annexes and Annex 2 contamination remains. This is a successful guard against a new incorrect ancestor, not a repair of the back-cover hierarchy.

The independent untouched six-case tranche separately passed unchanged with complete block/chunk equality against its two old-production baselines; see `2026-09-20-heading-scope-release-review.md`. These bounded checks close the two reviewed scope issues without claiming that document hierarchy is generally correct. Final per-case verdicts, output hashes and closure assertions are retained in `bench/parsers/reports/local/2026-09-20-heading-release/final-release-score.json`. The earlier failed-candidate artifacts and paired comparisons remain preserved.
