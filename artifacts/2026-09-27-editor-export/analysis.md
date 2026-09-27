# Plate export implementation

Design A is implemented. The [original three mocks](./mocks.html?revision=4) remain for comparison. The user selected the study handout: questions followed by answers, marking schemes and worked solutions, with paired flashcard faces. Info callouts are blue, quote/divider borders are grey, answer keys have no background, and the online-video requirement caption is omitted.

The [actual Word document](./implemented.docx), [Word-rendered PDF](./implemented.pdf) and [portable Markdown package](./implemented.zip) come from the application export worker. They contain the real 51-node feature-matrix fixture plus one two-series chart for coverage. The original fixture does not contain uploaded image/audio/file or graph nodes. The [Markdown source](./implemented.md) references assets inside the ZIP.

## What changed

- Both formats resolve embedded quiz/card references and flatten all seven answer types, multiple parts, hints, units, marking schemes and rich solutions. Unreadable references or unsupported blocks stop the export with an error.
- Semantic export HTML replaces the generic Plate static render that passed Slate children into the void `hr` tag. The divider is now a valid `<hr/>`.
- Markdown uses standard headings, nested lists, tables and links; callouts become labeled quotes, columns are sequential, math retains LaTeX and Mermaid retains source plus caption. Rich tables retain HTML. Images/attachments are packaged with relative asset paths.
- DOCX preserves colored callouts and column proportions. Equations and diagrams are images with alternative text. Charts include their legend and a data table. Private audio/file links return to the note in view mode, preserving the workspace material selection.
- DOCX outlines are native Word TOCs covering heading levels 1–6, with indented entries, dot leaders and page-number fields. Word 16.0 recognized one TOC, calculated pages on opening, and refreshed it after a heading was renamed. Answer/solution labels stay outside the TOC. The original HTML mock predates this native TOC change; the actual Word document and PDF show the implemented result.
- Worker code handles flattening, serialization, image downloads/downsampling, and DOCX/ZIP packaging. The main thread handles authenticated reads, downloads and DOM-required figure rendering. Figures use isolated documents so rasterization does not clone the editor.

## YouTube in Word

The DOCX contains a poster with a play button, linked label and picture, plus Office's `wp15:webVideoPr` metadata and Word 2013 compatibility mode. Installed Word 16.0 opened it successfully and recognized InlineShape type 16, a native web-video object. There is no printed raw URL or connection-requirement caption. The video stays hosted by YouTube; viewer/provider support determines playback. Word for the web playback has not been verified.

Microsoft documents [online video in Word](https://support.microsoft.com/en-us/word/insert-an-online-video-in-word), [web-video metadata](https://learn.microsoft.com/en-us/openspecs/office_standards/ms-odrawxml/8f50d7ac-e317-42d4-bd12-23a65175f236), and the [native web-video shape type](https://learn.microsoft.com/en-us/office/vba/api/word.wdinlineshapetype). Word for the web's paste-to-embed feature is a separate path, so recognizing the desktop object does not prove that feature's behavior.

## Verification

[The implementation benchmark report](../../bench/editor/reports/2026-09-27-client-export-implementation.md) records large-document conversion and main-thread responsiveness, including 9,800 nodes, nearly 2 MiB of text, 1,300 mixed blocks and 100 unique formulas. Normal-CPU near-limit DOCX export took about one second with 15 ms page timer delay. DOM figures remain a limitation on throttled pages; the report includes those slower results.

All 437 unit tests, TypeScript checking and the real-editor download test passed. Actual Word output was rendered and visually inspected. Readable exports are intended for reading and sharing; they do not reconstruct interactive study tools on reimport. The existing JSON export is unchanged and retains references, so it is not a new offline backup format.
