# Table-of-contents fixture

This committed input contains no account or provider data. Regenerate it with
`python e2e/fixtures/files/generate_toc.py` (standard library only). Its
document part has the shape of the BetterOffice field worker's
`toc-tab-lead.docx`, with this set's texts. The package holds only the
document part and its relationships.

| Input | Content and intended check |
| --- | --- |
| report.docx | Workspace source, fast parsing. A title, then a Word table of contents. The first TOC paragraph opens with one run holding `Contents` and a tab, then the `TOC \o "1-3" \h \z \u` field (begin, instruction, separator) and its first entry: a link to bookmark `_Toc1` holding `Introduction`, a tab and a `PAGEREF _Toc1 \h` field caching `1`. The second TOC paragraph holds the `Details` entry (`_Toc2`) and the field's end. Then come the two Heading 1 headings with those bookmarks, the wetland fact and the run marker. The export writes the leading run as two runs, so seed(export) numbers the TOC field otherwise than the editor's session. One character typed after `Intro` in the first entry after a publication's capture therefore refuses the rebuild's rebase (`Office rebase: a field result's child would not export in its field`), and the automatic republication of the latest state contains `IntroZduction` and rebuilds. Typing at the entry's start, Backspace, Delete and Enter land instead. |

The runner replaces `UAT_RUN_MARKER` in an in-memory copy before uploading.
