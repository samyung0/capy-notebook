# Browser OCR estimate against the parser

2026-09-28. The add-file dialog guesses, in the browser, which pages of an
upload the parser will send to OCR. This compares that guess with the pages the
parser actually routes, on every document the ingest host and the local
fixtures hold, and asks what the dialog could refuse before upload.

## Findings

No decision yet. Items for the developer are at the end of the next section.

**After the fix (same day).** The worker now loads CMaps and no longer has the
operator-list pass or its budgets. Rerun of the updated harness on the same 91
files: every PDF analyses. The browser counts 816 OCR pages against the
parser's 817 (5,573 of 5,574 pages agree; 0 browser-only, 1 parser-only, the
separator page `rag__zh__zh_TW_llm.pdf` p33). Office is unchanged (9 against 4,
the 5 `jp_llm2.pptx` master-footer slides). The findings below describe the
code before the fix.

- **Where both sides produce a result, they agree on 5,556 of 5,574 PDF pages
  (99.68%)**: 816 pages OCR on both sides, 4,740 text on both, 17 OCR only in the
  browser, 1 OCR only in the parser. Summed over documents, the browser counts
  833 OCR pages and the parser 817. All 17 browser-only pages are in one document; without
  it the browser counts 816 against 817.
- **Two causes explain every disagreement.**
  - *Missing CMaps (17 pages, browser says OCR, parser says text).* The worker
    opens PDFs without `cMapUrl`, so pdf.js cannot turn the CIDs of
    non-embedded CJK fonts (here `Ryumin`, `KozMin` and others, `Identity-H`,
    no `ToUnicode`) into characters. MuPDF has those tables built in. On
    `rag__ja__jp_llm.pdf` all 26 pages lose their Japanese text in the browser;
    17 fall under 40 characters and 9 stay above it only because of Latin
    punctuation and math symbols. With `cMapUrl` pointing at
    `pdfjs-dist/cmaps` the same pdf.js reads 1,459-3,748 characters per page and
    no page is textless, the same as the parser. Rerun over all 86 PDFs with
    CMaps: 5,573 of 5,574 pages agree, 0 browser-only, 1
    parser-only, 816 OCR pages against 817. The only other counts that moved
    went up (CJK text in the `ccl-*` footers, 9 characters a page).
  - *Separator counting (1 page, browser says text, parser says OCR).* The
    worker appends a space or newline after every text item
    (`sourceAnalysis.worker.ts:153`), and pdf.js emits empty end-of-line items
    and whitespace-only items too, each of which also gets a separator. MuPDF
    writes one newline per line. On `rag__zh__zh_TW_llm.pdf` page 33 the browser
    counts 52 and the parser 39, with the same 37 non-space characters. Non-space
    counts matched on every page under 100 characters outside the CMap
    document. On text pages the browser count is a median 1.02x the parser's
    (5th-95th percentile 1.00-1.14x, range 0.70-2.27x). Mostly the browser counts
    more, which pushes a page from OCR to text. It can also run the other way:
    on `japan-migration.pdf` page 7 MuPDF adds more whitespace (browser 49,
    parser 61, both 31 non-space), so a page just above 40 in the parser could
    read under 40 in the browser. That was not seen at the threshold here.
- **Ruled out:** font repair and the admission count. `repair_fonts` rebuilt
  fonts in 7 documents (81 pages) and changed the count on 37 of those pages,
  all of them with at least 1,248 characters, so no page changed its OCR decision.
  The admission count on the uploaded bytes (`parser/app.py:293`) equals the
  count on the repaired PDF for every PDF here (817 both). Invisible text
  (render mode 3), white text, text under a filled rectangle, 0.5 pt text and a
  rotated page count the same on both sides (probes). Text outside the media box
  or crop box is dropped by both: pdf.js 4.8 does not return it either.
- **Office: 116 of 121 pages agree.** The 5 disagreeing pages are all in
  `jp_llm2.pptx`, where the browser says OCR and the LibreOffice PDF has text.
  The OOXML probe reads only `ppt/slides/slideN.xml`
  (`sourceAnalysisCore.ts:394-398`); a licence footer on those slides comes from
  the slide layout or master, so it appears in the PDF (124-158 characters) but
  not in the slide XML (0-34). Page counts matched on all five sources, but the
  only DOCX and XLSX samples are one-page canaries, so DOCX and XLSX pagination
  is effectively untested. There is no LibreOffice on this Mac, and the host's
  copy runs only inside the parser container, so the Office PDFs are the ones
  the 2026-09-09 corpus preparation converted with the worker of that time, not
  today's parser image.
- **Largest errors in the OCR page count:** PDF +17 pages out of 26
  (`rag__ja__jp_llm.pdf`, CMaps) and -1 out of 33 (`rag__zh__zh_TW_llm.pdf`,
  separators); Office +5 out of 84 (`jp_llm2.pptx`, master text). Page counts
  from pdf.js and MuPDF were equal on all 86 PDFs.
- **The browser's own limits stop 13 of the 86 PDFs, and that blocks upload.**
  A failed analysis keeps submit disabled (`sourceDetails.ts:19-39`, decision
  2026-09-11), and the row says "This file could not be analyzed". 10 of the 13
  are within the pro size limit and parse fine on the host: the 610-page Biology
  textbook (26 MiB, stops at page 43), `german-education.pdf` (32 pages,
  2.4 MiB, page 11), `scan-50.pdf` (page 11), the four `mixed-*` files, the
  LibreOffice PDF of `jp_llm2`, and `biology-610-noocr`. Two budgets fire: the
  running total of decoded image pixels (24 M, which is about eleven 150-dpi A4
  scans) and the memory estimate (128 MiB, which starts at the file size). Both
  come from `getOperatorList` (`sourceAnalysis.worker.ts:323-340`), whose only
  other output is `imageCoverage`, and nothing in the UI reads that value. The
  real worker in Chromium gave the same errors and the same per-page
  counts as the Node harness on the 14 files checked. Without the operator
  list, Chromium read the text of 1,220 pages in 6.3 s and of 610 pages in 3.1 s
  on this Mac.
- So today the dialog never gets an estimate for a scan past about ten pages or
  for a textbook-sized PDF. Neither parser limit can be checked early until
  that changes. The OCR split also does not change the credit estimate
  (digital and OCR pages both cost 1.0 credit), so it matters only for what the
  dialog shows and for the rule below.

## Proposed early rejection (not implemented)

Two frontend fixes come first. Without them the rules below are unsafe or never
run:

1. **Load CMaps**: `cMapUrl` plus `cMapPacked: true` (and
   `standardFontDataUrl`) from `pdfjs-dist` in the worker's `getDocument`
   (`sourceAnalysis.worker.ts:293-299`). This removes all 17 browser-only pages
   here. The cost is 1.6 MB of static files, fetched only when a PDF needs one.
   Without it, a CJK book with non-embedded fonts counts as fully scanned and
   an OCR block would wrongly refuse it.
2. **Stop the operator-list pass** (or keep it without its image, operator and
   memory budgets). The page, text and time limits stay. This removes all 13
   refusals in this corpus and keeps the 2026-09-11 rule that every fast-parse
   upload carries an estimate.

Then:

| Limit (parser) | Browser check | Block or warn | Evidence |
| --- | --- | --- | --- |
| More than 1,000 textless pages (`CAPY_PARSE_OCR_PAGE_CAP`, terminal `parse_too_many_scanned_pages`) | PDF only: `ocrPageCount` | Block above 105% of the cap (1,050); warn from 95% to 105% (950-1,050) | With CMaps loaded, the browser never counted more OCR pages than the parser on any document, and no document was off by more than 1 page. Only pages near 40 characters can flip, and a large scan is mostly pages with no text at all. But only 34 PDF pages here were within 20-79 characters, and the whitespace error can run both ways, so a 5% margin before blocking is cheap insurance: a false block would need 50 pages to flip towards OCR. Files in the band upload with a warning, and the parser refuses them at admission, before parsing, if they really are over. Office: show the count, never block; the probe over-counts OCR and the parser checks after LibreOffice anyway |
| Parse deadline, 600 s, terminal and quarantined per file (`parse_hard_timeout`) | Total pages, exact for PDF and PPTX. All pages go through Java and the repairs, not only text pages | Warn above 1,220 pages; block above a limit measured first | 1,220 native pages took 369 s (61%) in the v11 stress run. Nothing was measured between 1,220 and a timeout, and the stress report's 1,800-2,000 is an extrapolation in which refinement grows faster than the page count. Measure Biology x3 (1,830) and x4 (2,440) on the host before choosing the block. Until then the browser's existing 2,000-page analysis cap (`sourceAnalysisCore.ts:25`) blocks, but with the wrong message. DOCX and XLSX page counts are estimates: warn only |
| 100 MiB source cap (`CAPY_MAX_SOURCE_BYTES`) | None new | n/a | Plan limits are 10 MiB (free) and 30 MiB (pro) (`server/migrations/0001_init.sql:40-41`). The dialog already checks them (`sourceDetails.ts:62`), the API does too (`huma_sources.go:190`), and imports download with the same `maxBytes`. The parser cap matters only if a plan limit ever goes above 100 MiB; that check belongs in server config, not the browser |
| PDF with a user password | pdf.js `PasswordException` | Block (already blocked, generic message) | Both readers fail on the probe. A PDF with only an owner password opens in both and must stay allowed |

Nothing else in this corpus fails for certain. The parser keeps enforcing every
limit itself: the admission count on the uploaded bytes, the exact count after
font repair or LibreOffice, and the deadline.

**Getting the numbers.** The upload policy already has
`parseModes[].maxPages` (`server/internal/httpapi/apimodel/apimodel.go:187`, in
`openapi.yaml` and the generated types), and the dialog already disables fast
parsing when the analysed page count is above it (`sourceUpload.ts:56-61`). The
server never sets it (`huma_sources.go:88-97`). Setting `maxPages` and adding a
sibling `maxOcrPages` (plus warn thresholds, if wanted) keeps the numbers out
of the frontend. The values live in the ingest host's env
(`CAPY_PARSE_OCR_PAGE_CAP`, `CAPY_PARSE_DOCUMENT_TIMEOUT`), and the API cannot
read that env. Either mirror them as API env vars through `deploy/env-manifest.json`,
or keep them as Go constants next to `sourceupload.ParseExtensions`. The existing
`over N pages` text is hardcoded English and should move to Paraglide.

**What the dialog could say:**

- OCR block: "About 1,240 pages in this PDF have no text we can read, and we can
  scan at most 1,000 pages per file. Split the PDF, or add it without parsing."
- OCR warning: "About 980 pages in this PDF have no text we can read. The limit
  is 1,000 and our count can be off by a few pages, so this file might be
  refused after upload."
- Page block: "This PDF has 2,400 pages. Files this long take longer than our
  10-minute reading limit. Split it into parts, or add it without parsing."
- Page warning: "This PDF has 1,500 pages. Very long files can run past our
  10-minute reading limit, and a file that does can't be retried."
- Password: "This PDF is password-protected. Remove the password and add it
  again."

**Decisions needed:**

1. Load CMaps in the analysis worker (fix 1)?
2. Drop the operator-list pass and its budgets (fix 2), and with it
   `imageCoverage`?
3. OCR rule: block above 1,050, warn from 950 to 1,050 (or a different
   margin)? Office estimate shown only, never blocking?
4. Deadline rule: measure 1,830 and 2,440 pages first, then pick the warning and
   block thresholds?
5. Where the limits come from: API env mirrored from the ingest host, or Go
   constants?

## Corpus

91 files, unique by sha256: 86 PDFs and 5 Office sources.

- Local `fixtures/docs/`: 6 files, 5 of them also on the host.
  `2604.03051v1.pdf` is local only.
- Ingest host, copied read-only with `scp` into the ignored
  `reports/local/2026-09-28-ocr-estimate/host/`: the six directories named in
  the brief (`capy-parser-eval-20260908/inputs`,
  `capy-java-new-documents-20260909/inputs` and `/prepared`,
  `capy-odl-third-regression-20260909/prepared`,
  `capy-odl-independent-20260909/prepared`,
  `capy-odl-font-transfer-20260909/inputs`, `capy-parser-stress-20260928/inputs`)
  plus `capy-odl-third-pass-20260909/prepared`,
  `capy-ingest/app-nonprod/bench/rag/fixtures/local/2026-09-09-odl-agentic/pdfs`,
  `capy-ingest/stress-spool/sources`, `capy-rag-curated-20260905/corpus/sources`
  and `capy-parser-bench/input`, and the two PPTX files from
  `capy-parser-eval-20260908/inputs/rag`. A macOS `._` resource-fork file was
  skipped.
- The corpus repeats itself. `digital-*`, `mixed-*`, `mostly-ocr-*`,
  `overlap-*`, `biology-*` and `scan-*` are all built from the Biology
  textbook (the ones with text share its page 2; `scan-*` are its pages
  rasterised), and `screen__*` and `raster__*` are page subsets and rasterised
  copies of other files here. The only real scans are `newspaper_scan` (2 pages)
  and the 26-page `ocr-*` files, which match the host's one real 26-page scan
  in page count. Generated scans have no text layer at all, so they
  never come near the threshold. Only 41 PDF pages (34 with CMaps loaded) had
  either count within 20-79 characters.
- The five `office-canary__*`, `rag__ja__jp_llm2` and `rag__zh__zh_TW_llm` PDFs
  are LibreOffice outputs. They count once as PDFs and again as the parser side
  of their Office source.

## Method

- **Browser** (`scripts/ocr_estimate_browser.ts`, run with `tsx`): pdfjs-dist
  4.8.69, the app's copy, with the worker's `getDocument` options and the
  worker's item join. These are copied because the worker module needs a
  browser (`self`, a `?url` import). The page decision is the real
  `classifySourcePage`, imported from `sourceAnalysisCore.ts`, and the Office
  sources go through the real `analyzeOoxmlBuffer`. The first run used the
  worker as it was before the fix: no CMaps, plus the operator-list budgets,
  whose errors were recorded with their page while the rest of the document was
  still read. The script now mirrors the fixed worker (CMaps loaded from the
  same `pdfjs-dist/cmaps` files, no budgets), and it does not apply the
  policy's page cap. The before-fix numbers come from that first version of the
  script. Fidelity check (before the fix): the actual worker, loaded from a Vite dev server in Chromium, produced identical per-page
  counts and the same errors on 14 files (`rag__ja__jp_llm`,
  `rag__zh__zh_TW_llm`, `lecture_plus_scan`, `ocr-1`, `hongkong-figures`,
  `spain-figures`, two probes; errors on `german-education`, `scan-50`,
  Biology, `biology-610-noocr`, `mixed-1`, `rag__ja__jp_llm2`). The text-only
  Chromium timings came from pdf.js run by hand in the same page, not from a
  saved script; Node timings are not used.
- **Parser** (`scripts/ocr_estimate_compare.py backend`, with PyMuPDF 1.28.2 and
  pypdf 6.18.0 as pinned in `parser/requirements.txt`): per page,
  `len(page.get_text().strip())`, the test in `parser/odl/ocr.py:33-38`, on the
  uploaded bytes (the admission count) and on the output of the real
  `parser/odl/fonts.repair_fonts` (what `parser/odl/refine.py:71` and `:153-156`
  route).
- **Probes** (`ocr_estimate_compare.py probes`): one-page PDFs for 39 and 40
  characters, split labels, stacked labels, text outside the media box and
  crop box, invisible, white, covered and 0.5 pt text, a non-embedded CJK font,
  a rotated page, and user- and owner-password encryption.

## Per-document results

Parser OCR is the count on the font-repaired PDF. The count on the uploaded
bytes (admission) was identical on every PDF, so it is not repeated. "Near"
counts pages where either side has 20-79 characters. "Browser analysis stops"
is where the dialog would give up and block submit today.

| Document | Pages | Browser OCR | Parser OCR | Both OCR | Both text | Browser-only | Parser-only | Near (20-79) | Fonts repaired / flips | Browser analysis stops |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| 2604.03051v1.pdf | 19 | 0 | 0 | 0 | 19 | 0 | 0 | 0 | 0/0 |  |
| Biology_for_the_IB_Diploma.pdf | 610 | 2 | 2 | 2 | 608 | 0 | 0 | 1 | 0/0 | p43: images > 24 M px |
| attention.pdf | 15 | 0 | 0 | 0 | 15 | 0 | 0 | 0 | 0/0 |  |
| bert.pdf | 16 | 0 | 0 | 0 | 16 | 0 | 0 | 0 | 18/0 |  |
| biology-610-noocr.pdf | 608 | 0 | 0 | 0 | 608 | 0 | 0 | 0 | 0/0 | p48: memory estimate > 128 MiB |
| biology-accuracy-sample.pdf | 16 | 0 | 0 | 0 | 16 | 0 | 0 | 0 | 0/0 |  |
| biology-x2-noocr.pdf | 1216 | 0 | 0 | 0 | 1216 | 0 | 0 | 0 | 0/0 | p31: memory estimate > 128 MiB |
| biology-x2.pdf | 1220 | 4 | 4 | 4 | 1216 | 0 | 0 | 2 | 0/0 | p32: memory estimate > 128 MiB |
| ccl-children.pdf | 21 | 0 | 0 | 0 | 21 | 0 | 0 | 0 | 0/0 |  |
| ccl-cot.pdf | 24 | 0 | 0 | 0 | 24 | 0 | 0 | 0 | 1/0 |  |
| ccl-feedback.pdf | 16 | 0 | 0 | 0 | 16 | 0 | 0 | 0 | 1/0 |  |
| digital-1.pdf | 26 | 2 | 2 | 2 | 24 | 0 | 0 | 1 | 0/0 |  |
| digital-2.pdf | 26 | 2 | 2 | 2 | 24 | 0 | 0 | 1 | 0/0 |  |
| digital-3.pdf | 26 | 2 | 2 | 2 | 24 | 0 | 0 | 1 | 0/0 |  |
| digital-4.pdf | 26 | 2 | 2 | 2 | 24 | 0 | 0 | 1 | 0/0 |  |
| german-education.pdf | 32 | 1 | 1 | 1 | 31 | 0 | 0 | 0 | 0/0 | p11: images > 24 M px |
| hongkong-figures.pdf | 53 | 1 | 1 | 1 | 52 | 0 | 0 | 0 | 0/0 |  |
| instrument-log-1.pdf | 1 | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 0/0 |  |
| instrument-log-2.pdf | 1 | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 0/0 |  |
| japan-migration.pdf | 54 | 1 | 1 | 1 | 53 | 0 | 0 | 1 | 0/0 |  |
| lecture_deck.pdf | 40 | 0 | 0 | 0 | 40 | 0 | 0 | 0 | 0/0 |  |
| lecture_plus_scan.pdf | 42 | 2 | 2 | 2 | 40 | 0 | 0 | 0 | 0/0 |  |
| mixed-1.pdf | 26 | 15 | 15 | 15 | 11 | 0 | 0 | 1 | 0/0 | p16: images > 24 M px |
| mixed-2.pdf | 26 | 15 | 15 | 15 | 11 | 0 | 0 | 1 | 0/0 | p16: images > 24 M px |
| mixed-3.pdf | 26 | 15 | 15 | 15 | 11 | 0 | 0 | 1 | 0/0 | p16: images > 24 M px |
| mixed-4.pdf | 26 | 15 | 15 | 15 | 11 | 0 | 0 | 1 | 0/0 | p16: images > 24 M px |
| mostly-ocr-1.pdf | 26 | 26 | 26 | 26 | 0 | 0 | 0 | 1 | 0/0 |  |
| mostly-ocr-2.pdf | 26 | 26 | 26 | 26 | 0 | 0 | 0 | 1 | 0/0 |  |
| mostly-ocr-3.pdf | 26 | 26 | 26 | 26 | 0 | 0 | 0 | 1 | 0/0 |  |
| mostly-ocr-4.pdf | 26 | 26 | 26 | 26 | 0 | 0 | 0 | 1 | 0/0 |  |
| newspaper_scan.pdf | 2 | 2 | 2 | 2 | 0 | 0 | 0 | 0 | 0/0 |  |
| nist-accelerometers.pdf | 11 | 0 | 0 | 0 | 11 | 0 | 0 | 0 | 0/0 |  |
| nist-shot.pdf | 8 | 0 | 0 | 0 | 8 | 0 | 0 | 0 | 0/0 |  |
| ocr-1.pdf | 26 | 26 | 26 | 26 | 0 | 0 | 0 | 0 | 0/0 |  |
| ocr-2.pdf | 26 | 26 | 26 | 26 | 0 | 0 | 0 | 0 | 0/0 |  |
| ocr-3.pdf | 26 | 26 | 26 | 26 | 0 | 0 | 0 | 0 | 0/0 |  |
| ocr-4.pdf | 26 | 26 | 26 | 26 | 0 | 0 | 0 | 0 | 0/0 |  |
| office-canary__docx.pdf | 1 | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 0/0 |  |
| office-canary__pptx.pdf | 2 | 0 | 0 | 0 | 2 | 0 | 0 | 1 | 0/0 |  |
| office-canary__xlsx.pdf | 1 | 0 | 0 | 0 | 1 | 0 | 0 | 1 | 0/0 |  |
| overlap-measured-20260831-1236-1.pdf | 26 | 2 | 2 | 2 | 24 | 0 | 0 | 1 | 0/0 |  |
| overlap-measured-20260831-1236-2.pdf | 26 | 2 | 2 | 2 | 24 | 0 | 0 | 1 | 0/0 |  |
| overlap-measured-20260831-1236-3.pdf | 26 | 2 | 2 | 2 | 24 | 0 | 0 | 1 | 0/0 |  |
| overlap-measured-20260831-1236-4.pdf | 26 | 2 | 2 | 2 | 24 | 0 | 0 | 1 | 0/0 |  |
| overlap-warm-final-20260831-1223.pdf | 26 | 2 | 2 | 2 | 24 | 0 | 0 | 1 | 0/0 |  |
| overlap-warm-measured-20260831-1236.pdf | 26 | 2 | 2 | 2 | 24 | 0 | 0 | 1 | 0/0 |  |
| rag__de__grosse-sprachmodelle.pdf | 34 | 0 | 0 | 0 | 34 | 0 | 0 | 0 | 0/0 |  |
| rag__de__putnam-einleitung.pdf | 21 | 0 | 0 | 0 | 21 | 0 | 0 | 0 | 0/0 |  |
| rag__en__biology-ib-chapter-1.pdf | 11 | 0 | 0 | 0 | 11 | 0 | 0 | 0 | 0/0 |  |
| rag__en__biology-ib-convergent-targets.pdf | 2 | 0 | 0 | 0 | 2 | 0 | 0 | 0 | 0/0 |  |
| rag__en__biology-ib-sample-16-pages.pdf | 16 | 0 | 0 | 0 | 16 | 0 | 0 | 0 | 0/0 |  |
| rag__en__newspaper_scan.pdf | 2 | 2 | 2 | 2 | 0 | 0 | 0 | 0 | 0/0 |  |
| rag__es__sesgo-linguistico-digital.pdf | 25 | 0 | 0 | 0 | 25 | 0 | 0 | 0 | 0/0 |  |
| rag__es__variedades-espanol.pdf | 10 | 0 | 0 | 0 | 10 | 0 | 0 | 0 | 0/0 |  |
| rag__fr__camembert-taln.pdf | 12 | 0 | 0 | 0 | 12 | 0 | 0 | 0 | 0/0 |  |
| rag__fr__wikiner-fr-gold.pdf | 6 | 0 | 0 | 0 | 6 | 0 | 0 | 0 | 0/0 |  |
| rag__ja__jp_llm.pdf | 26 | 17 | 0 | 0 | 9 | 17 | 0 | 7 | 0/0 |  |
| rag__ja__jp_llm2.pdf | 84 | 0 | 0 | 0 | 84 | 0 | 0 | 0 | 0/0 | p26: images > 24 M px |
| rag__zh__mixed_zh_en.pdf | 20 | 0 | 0 | 0 | 20 | 0 | 0 | 0 | 0/0 |  |
| rag__zh__zh-CN.pdf | 11 | 0 | 0 | 0 | 11 | 0 | 0 | 0 | 0/0 |  |
| rag__zh__zh_HK.pdf | 15 | 0 | 0 | 0 | 15 | 0 | 0 | 0 | 0/0 |  |
| rag__zh__zh_TW_llm.pdf | 33 | 3 | 4 | 3 | 29 | 0 | 1 | 9 | 0/0 |  |
| raster__attention.pdf | 1 | 1 | 1 | 1 | 0 | 0 | 0 | 0 | 0/0 |  |
| raster__ccl-feedback.pdf | 2 | 2 | 2 | 2 | 0 | 0 | 0 | 0 | 0/0 |  |
| raster__german-education.pdf | 1 | 1 | 1 | 1 | 0 | 0 | 0 | 0 | 0/0 |  |
| raster__hongkong-figures.pdf | 1 | 1 | 1 | 1 | 0 | 0 | 0 | 0 | 0/0 |  |
| raster__japan-migration.pdf | 1 | 1 | 1 | 1 | 0 | 0 | 0 | 0 | 0/0 |  |
| raster__spain-figures.pdf | 1 | 1 | 1 | 1 | 0 | 0 | 0 | 0 | 0/0 |  |
| raster__taln-complexity.pdf | 1 | 1 | 1 | 1 | 0 | 0 | 0 | 0 | 0/0 |  |
| resnet.pdf | 12 | 0 | 0 | 0 | 12 | 0 | 0 | 0 | 12/0 |  |
| scan-150.pdf | 150 | 150 | 150 | 150 | 0 | 0 | 0 | 0 | 0/0 | p11: images > 24 M px |
| scan-300.pdf | 300 | 300 | 300 | 300 | 0 | 0 | 0 | 0 | 0/0 | p8: memory estimate > 128 MiB |
| scan-50.pdf | 50 | 50 | 50 | 50 | 0 | 0 | 0 | 0 | 0/0 | p11: images > 24 M px |
| screen__attention.pdf | 5 | 0 | 0 | 0 | 5 | 0 | 0 | 0 | 0/0 |  |
| screen__bert.pdf | 4 | 0 | 0 | 0 | 4 | 0 | 0 | 0 | 14/0 |  |
| screen__ccl-feedback.pdf | 5 | 0 | 0 | 0 | 5 | 0 | 0 | 0 | 1/0 |  |
| screen__german-education.pdf | 5 | 0 | 0 | 0 | 5 | 0 | 0 | 0 | 0/0 |  |
| screen__hongkong-figures.pdf | 5 | 0 | 0 | 0 | 5 | 0 | 0 | 0 | 0/0 |  |
| screen__japan-migration.pdf | 5 | 0 | 0 | 0 | 5 | 0 | 0 | 0 | 0/0 |  |
| screen__nist-accelerometers.pdf | 5 | 0 | 0 | 0 | 5 | 0 | 0 | 0 | 0/0 |  |
| screen__nist-shot.pdf | 4 | 0 | 0 | 0 | 4 | 0 | 0 | 0 | 0/0 |  |
| screen__resnet.pdf | 4 | 0 | 0 | 0 | 4 | 0 | 0 | 0 | 10/0 |  |
| screen__spain-figures.pdf | 5 | 0 | 0 | 0 | 5 | 0 | 0 | 0 | 0/0 |  |
| screen__taln-complexity.pdf | 5 | 0 | 0 | 0 | 5 | 0 | 0 | 0 | 0/0 |  |
| spain-figures.pdf | 60 | 2 | 2 | 2 | 58 | 0 | 0 | 1 | 0/0 |  |
| taln-complexity.pdf | 13 | 0 | 0 | 0 | 13 | 0 | 0 | 0 | 0/0 |  |

| Office source | Pages (frontend / LibreOffice PDF) | Browser OCR | Parser OCR | Both OCR | Both text | Browser-only | Parser-only | Near (20-79) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| jp_llm2.pptx | 84 | 5 | 0 | 0 | 79 | 5 | 0 | 2 |
| office-canary.docx | 1 | 0 | 0 | 0 | 1 | 0 | 0 | 0 |
| office-canary.pptx | 2 | 0 | 0 | 0 | 2 | 0 | 0 | 1 |
| office-canary.xlsx | 1 | 0 | 0 | 0 | 1 | 0 | 0 | 1 |
| zh_TW_llm.pptx | 33 | 4 | 4 | 4 | 29 | 0 | 0 | 9 |

Office rows compare the frontend's OOXML estimate with the LibreOffice PDF
(`office-canary__docx.pdf`, `office-canary__pptx.pdf`,
`office-canary__xlsx.pdf`, `rag__ja__jp_llm2.pdf`, `rag__zh__zh_TW_llm.pdf`).
The parser's admission count for an Office source is always 0; its real count
comes after LibreOffice.

## Disagreeing PDF pages

Counts after `trim()` / `strip()`, with non-space characters in brackets.

| Document | Page | Browser chars (non-space) | Parser chars (non-space) | Browser text | Parser text |
| --- | ---: | ---: | ---: | --- | --- |
| rag__ja__jp_llm.pdf | 1 | 0 (0) | 1390 (1312) | "" | "" |
| rag__ja__jp_llm.pdf | 2 | 7 (3) | 1673 (1525) | "(   ) √" | "" |
| rag__ja__jp_llm.pdf | 4 | 29 (11) | 1539 (1396) | "’ \n’’   ’   ’ \n’’   ’’ \n∈   ℕ" | "" |
| rag__ja__jp_llm.pdf | 5 | 22 (7) | 1560 (1439) | "· \n∑   ˆ \n∈ \nˆ   ∑   ∈" | "" |
| rag__ja__jp_llm.pdf | 8 | 0 (0) | 1834 (1713) | "" | "" |
| rag__ja__jp_llm.pdf | 10 | 1 (1) | 1597 (1511) | "’" | "" |
| rag__ja__jp_llm.pdf | 11 | 0 (0) | 1602 (1528) | "" | "" |
| rag__ja__jp_llm.pdf | 12 | 0 (0) | 1642 (1535) | "" | "" |
| rag__ja__jp_llm.pdf | 13 | 0 (0) | 1787 (1624) | "" | "" |
| rag__ja__jp_llm.pdf | 14 | 0 (0) | 2160 (1908) | "" | "" |
| rag__ja__jp_llm.pdf | 15 | 1 (1) | 1681 (1586) | "’" | "" |
| rag__ja__jp_llm.pdf | 16 | 17 (6) | 1487 (1370) | "“ \n” \n“   ” \n“ \n”" | "" |
| rag__ja__jp_llm.pdf | 17 | 0 (0) | 1660 (1566) | "" | "" |
| rag__ja__jp_llm.pdf | 18 | 0 (0) | 311 (276) | "" | "" |
| rag__ja__jp_llm.pdf | 19 | 0 (0) | 1574 (1502) | "" | "" |
| rag__ja__jp_llm.pdf | 20 | 0 (0) | 1576 (1488) | "" | "" |
| rag__ja__jp_llm.pdf | 21 | 0 (0) | 1472 (1385) | "" | "" |
| rag__zh__zh_TW_llm.pdf | 33 | 52 (37) | 39 (37) | "增強式學習的待 解議 題 \n•   人類自 己 都 無 法判斷好壞的 狀況 ？ 或 是人的判斷根本是錯的" | "增強式學習的待解議題\n• 人類自己都無法判斷好壞的狀況？或是人的判斷根本是錯的" |

The parser-side text of the `jp_llm` pages is longer than the 160-character
snippet the harness keeps, so it is blank above.

## Probes

| Document | Page | Browser chars (non-space) | Parser chars (non-space) | Browser text | Parser text |
| --- | ---: | ---: | ---: | --- | --- |
| probe-39-chars.pdf | 1 | 39 (32) | 39 (32) | "The quick brown fox jumps over the lazy" | "The quick brown fox jumps over the lazy" |
| probe-40-chars.pdf | 1 | 40 (33) | 40 (33) | "The quick brown fox jumps over the lazy!" | "The quick brown fox jumps over the lazy!" |
| probe-axis-labels.pdf | 1 | 47 (25) | 36 (25) | "0 \n10 \n20 \n30 \n40 \n50 \n60 \n70 \n80 \n90 \n100 \n110" | "0\n10\n20\n30\n40\n50\n60\n70\n80\n90\n100\n110" |
| probe-cjk-cmap.pdf | 1 | 0 (0) | 45 (45) | "" | "文字識別文字識別文字識別文字識別文字識別文字識別文字識別文字識別文字識別文字識別文字識別文" |
| probe-covered.pdf | 1 | 49 (40) | 49 (40) | "The quick brown fox jumps over the lazy dog again" | "The quick brown fox jumps over the lazy dog again" |
| probe-encrypted-owner.pdf | 1 | 49 (40) | 49 (40) | "The quick brown fox jumps over the lazy dog again" | "The quick brown fox jumps over the lazy dog again" |
| probe-invisible.pdf | 1 | 49 (40) | 49 (40) | "The quick brown fox jumps over the lazy dog again" | "The quick brown fox jumps over the lazy dog again" |
| probe-outside-cropbox.pdf | 1 | 0 (0) | 0 (0) | "" | "" |
| probe-outside-mediabox.pdf | 1 | 0 (0) | 0 (0) | "" | "" |
| probe-rotated.pdf | 1 | 49 (40) | 49 (40) | "The quick brown fox jumps over the lazy dog again" | "The quick brown fox jumps over the lazy dog again" |
| probe-split-labels.pdf | 1 | 93 (24) | 47 (24) | "A   B   C   D   E   F   G   H   I   J   K   L   M   N   O   " | "A\nB\nC\nD\nE\nF\nG\nH\nI\nJ\nK\nL\nM\nN\nO\nP\nQ\nR\nS\nT\nU\nV\nW\nX" |
| probe-tiny.pdf | 1 | 49 (40) | 49 (40) | "The quick brown fox jumps over the lazy dog again" | "The quick brown fox jumps over the lazy dog again" |
| probe-white.pdf | 1 | 49 (40) | 49 (40) | "The quick brown fox jumps over the lazy dog again" | "The quick brown fox jumps over the lazy dog again" |

`probe-encrypted-user.pdf` (user password): pdf.js throws "No password
given", and PyMuPDF reports "document closed or encrypted".
`probe-axis-labels` is the separator effect in isolation: 12 stacked numbers,
47 characters in the browser against 36 in the parser. `probe-split-labels`
shows it can double a count (93 against 47).

## Reproduction

Inputs and raw JSON are in the ignored `reports/local/2026-09-28-ocr-estimate/`
(`host/`, `probes/`, `files.txt`, `browser.json`, `backend.json`, `report.md`).

```sh
# Copy host inputs read-only (one scp per unique sha256; list in files.txt)
scp -i ~/.ssh/id_ed25519_capy_ingest root@159.195.61.195:/opt/<path> bench/parsers/reports/local/2026-09-28-ocr-estimate/host/

R=bench/parsers/reports/local/2026-09-28-ocr-estimate
uv run --no-project --with pymupdf==1.28.2 --with pypdf==6.18.0 \
  python bench/parsers/scripts/ocr_estimate_compare.py probes $R/probes
grep '\.pdf$' $R/files.txt | xargs uv run --no-project --with pymupdf==1.28.2 --with pypdf==6.18.0 \
  python bench/parsers/scripts/ocr_estimate_compare.py backend $R/backend.json
xargs pnpm exec tsx bench/parsers/scripts/ocr_estimate_browser.ts $R/browser-after.json < $R/files.txt
python3 bench/parsers/scripts/ocr_estimate_compare.py report $R/browser-after.json $R/backend.json > $R/report-after.md
```

The browser script now reproduces the after-fix numbers (`browser-after.json`,
`report-after.md`). The before-fix `browser.json`, `browser-cmaps.json` and
their reports stay in the local folder.

`files.txt` holds the 91 local paths (fixtures first, then host copies,
duplicates by sha256 removed). Probes go through the same `backend`, browser
and `report` steps with their own JSON files.
