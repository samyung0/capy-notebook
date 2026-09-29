# Table-of-contents fixture

This committed input contains no account or provider data. Regenerate it with
`python e2e/fixtures/files/generate_toc.py`. It needs the same Python libraries
as `generate_basic.py`, whose marker, fact and stable ZIP writer it reuses.

| Input | Content and intended check |
| --- | --- |
| report.docx | Workspace source, fast parsing. A title, a `Contents` heading, then a Word table of contents as Word writes it: one `TOC \o "1-3" \h \z \u` complex field whose begin, instruction and separator open the first entry's paragraph. Its result holds three entries (TOC1 `Field survey`, TOC2 `Sampling sites`, TOC1 `Findings`), each a hyperlink to its heading's `_Toc10000000N` bookmark with a tab and a `PAGEREF … \h` field caching page `1`, and the field ends in its own paragraph. The Heading 1/2 headings carry those bookmarks. The body holds the wetland fact, a sampling-site sentence and the run marker. The Office refusal journey edits a TOC link after a publication's capture, so the publication rebase refuses. It then checks that a fresh publication contains the edit. |

The runner replaces `UAT_RUN_MARKER` in an in-memory copy before uploading.
