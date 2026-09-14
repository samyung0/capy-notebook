# Basic synthetic file fixtures

These committed inputs contain no account or provider data. Regenerate with
`python e2e/fixtures/files/generate_basic.py` using Python with python-docx,
openpyxl, python-pptx and reportlab. Codex's bundled Python provides these libraries.

| Input | Content and intended check |
| --- | --- |
| lesson.docx | Two independent paragraphs, launch code LARCH-17, wetland fact, run marker, table containing Wetland/42, header. Browser edits change the code and append a collaborator sentence; export preserves the table/header. |
| grades.xlsx | Grades and Notes sheets, Grades!B2=42, B3=17, C2 formula B2*2, long text and run marker. Browser edits B2/B3, then a fresh client edits Notes!A1. Export checks exact cells and formula. |
| lesson.pptx | Two blank-layout slides with independent simple text boxes, launch/survey facts and a run marker. Browser paragraph replacement on each slide and fresh-client typing must survive publication. |
| digital.pdf | One text-layer page with wetland fact and launch code. Tests browser upload and API annotation ownership; visual rendering/annotation gestures are not asserted. Bytes remain unchanged. |
| notes.txt | UTF-8 source with wetland fact, launch code and marker. Browser edit must reach Y.Text and automatic publication with exact UTF-8 bytes. |
| grades.csv | UTF-8 CSV with header, scores, quoted fact and marker. Available for local import fixtures; the initial UAT suite does not claim positive CSV editing coverage. |
| delimiter-limit.csv | Run marker followed by 100,000 commas. Intended terminal direct-ingest error is `delimited table exceeds the cell limit`, telemetry code `terminalerror`. No parser or model content should publish. |

The runner replaces run markers in temporary in-memory copies of Office/text
inputs. PDF bytes stay fixed; that case permits exact-source reuse and does not
claim a fresh conversion. The suite does not yet cover scans, mixed-page PDFs,
image/audio codecs, legacy formats, private annotation pointer gestures,
Office structural editing, or native-highlight paint. Those remain explicit
coverage gaps in the wider plan.
