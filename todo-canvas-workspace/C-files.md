# Files on the workspace canvas: what other apps do, what Capy can render cheaply

Research for Epo's planned workspace canvas: one always-edgeless BlockSuite
canvas per workspace, one editor, one room. Question: what happens when a
user puts a PDF, PPTX, DOCX, XLSX, video or image on it, and how much of a
file Capy can show there without breaking the budget.

Method. Read-only. Web research by three parallel research passes (help
centres, changelogs, engineering blogs, official example code), plus my own
spot checks (marked V*). AFFiNE was read from source: the BlockSuite copy
vendored here (AFFiNE canary `5f19254`, `vendor/blocksuite/README.md`) and the
AFFiNE app on GitHub canary `8cef09e1` (2026-10-27), fetched read-only with
`gh api`. Capy was read from this worktree. Nothing was built, run or
installed. The only measurements are `gzip -9` sizes of WASM and pdf.js files
that already exist locally.

Markers: `†` = unverified (memory, a single weak source, or inferred). `–` =
not applicable. Source tags: `A*`, `B*`, `C*` and `V*` are in §6. Code is cited
by path.

---

## 0. Short answer

- **No app in the comparison draws a live Office document on the board.**
  Office files become a file card (Freeform, Milanote, Notion, Kosmik,
  AFFiNE), get converted into native objects (Miro, Canva, Figma Slides,
  Heptabase DOCX), or become images (Miro "Add as file" pages, Whiteboard's
  page picker). Obsidian draws them only through a community plugin.
- **Live in-canvas viewers exist only for PDFs, and only behind strict
  gates.** Kosmik flipped PDF pages on the canvas; its site set a sunset for
  2026-05-31 [V3]. Obsidian unloads PDFs when you zoom out unless you
  interacted with them [V6]. AFFiNE draws one PDFium page at a time, only
  while visible, and releases it out of view (§2.2; workers shut down out of
  view per [C22]). FigJam allows "only one active at a time" for interactive
  embeds [V5].
- **The common patterns are:**
  - a static page-1 preview (Heptabase, Muse, Miro);
  - picking pages that land as images (Miro "Extract pages", Whiteboard's
    page picker, tldraw's PDF example, Google Docs linked slides with an
    Update button);
  - reading in a side panel or peek (Heptabase, Kosmik, AFFiNE, Freeform
    Quick Look).
- **Capy already has most of what the cheap tiers need:**
  - page-1 WebP thumbnails (200 px) on every list row, re-captured in the
    browser after Office edits;
  - preview JSON for text, CSV and every material;
  - the `ThumbnailPanel`/`PreviewCard` that draw them;
  - viewers for every kind;
  - an Office runtime that can raster any slide or page to PNG;
  - the `capy:material-ref` island pattern for a reference block.
- **Recommendation:**
  - First: one file block that shows the existing preview, falling back to
    the icon card (tiers b + a), plus a peek or side panel that opens the
    file's own viewer or editor (tier e).
  - Second: a page and slide picker that places snapshots as image blocks
    (tier c), starting with PDF and PPTX, with an Update action when the file
    changes.
  - Skip live Office mini viewers (tier d). Revisit a PDF-only page flipper
    later, with one active at a time.
  - A canvas affords **one live interactive viewer at a time**, plus hundreds
    of static cards.

---

## 1. How other apps handle files (Q1)

### 1.1 Patterns across apps

| Pattern | Who | What it costs them | Notes |
| --- | --- | --- | --- |
| File card or icon, open elsewhere | Milanote (Office) [B39], Freeform (file item, Quick Look) [C1][C2], Notion file block [C27], Kosmik (Office "only be hosted") [B14], AFFiNE attachment card (§2), tldraw custom asset example [C15] | Nothing | Epo finds this "not too useful"; every app still uses it as the fallback for types it cannot draw |
| Static page-1 preview | Heptabase PDF card previews [B3], Muse snapshot + tile cache [B34], Miro paged file object (static pages, re-rendered sharper on zoom) [A1][A10], Google Drive "scaled-down version" [C32] | Server or one-time raster, cached | The most common board view of a PDF |
| Convert to native objects | Miro (slides, docs, tables) [A4][A5][A6], Canva (PDF and PPTX become editable designs) [A38][A39], Figma Slides (PPTX) [A26], Heptabase (DOCX to note, Dec 2025) [B6], FigJam (competitors' PDF exports) [A17][A18] | A converter per format; fidelity loss is documented [A26][A39] | The file stops being the file. Out of scope for Capy, which keeps the original as the document |
| Pick pages, place images | Miro "Extract pages" (all or chosen) [A1][V2], Whiteboard page picker [A31], FigJam PDF to images [A19], tldraw PDF example (all pages once) [C16][C17][V7], Google Docs linked slides (chosen slides, snapshot + Update) [C31] | One raster per page, stored | Miro's extracted pages each carry the whole PDF and slow boards (user report) [A9] |
| Fragments that link back | Kosmik area capture back to its page [B13], Muse excerpts with Source Peek [B33], Heptabase highlight cards [B1] | Small images or text plus a link | The study-friendly variant: pieces of a file become cards |
| Live viewer on the board | Kosmik (page flip; sunset 2026-05-31) [B13][V3], Obsidian (pdf.js, unloads when zoomed out unless interacted) [B26][V6], AFFiNE (PDFium page + pager, §2), Scrintal (after a double-click) [B46], tldraw and FigJam iframe embeds (explicit activation; FigJam one at a time) [C14][A22][V5] | Worker or iframe per item; gated | PDFs and web embeds only. No live Office anywhere |
| Read or edit off the board | Heptabase right side panel [B10], Kosmik side-panel reader [B13], AFFiNE centre peek (§2), Freeform Quick Look [C1], Miro Docs focus mode [A5], Muse zoom into the card [B33], FigJam maximize [A22] | One viewer at a time | Universal |

Performance tricks seen:

- **Just-in-time rendering.**
  - Miro shows a spinner and re-renders PDFs and images at higher resolution
    when you zoom in [A10].
  - tldraw's asset `resolve` gets the on-screen scale stepped to powers of
    two [C9][C10].
  - BlockSuite swaps big images for a 256 px thumbnail at zoom ≤ 0.4 (§2.3).
- **Size caps.** Figma downsizes past 4096 px [A24]. Miro allows 32 MP and
  8192×4096 [A1].
- **Unloading off screen or zoomed out.**
  - Obsidian unloads PDFs and iframes [B26][V6].
  - AFFiNE releases its PDF worker out of view (§2.2).
  - tldraw hides culled shapes with `display:none` [C11].
  - Canva hides elements when zoomed far out [A40].
- **One active at a time.** FigJam: one GIF, one interactive embed
  [A16][A22][V5].
- **Playback per viewer.** Video is not synced in Miro, Whiteboard or FigJam
  [A3][A32][A22].
- **Workers and wasm.**
  - AFFiNE uses PDFium wasm in one worker per PDF (§2.2).
  - Figma uses C++ compiled to wasm on WebGL, now WebGPU, and runs the same
    renderer natively on its server [A27][A28].
- **Pre-rendered tiles.** Muse keeps an on-disk tile cache with a size cap
  [B34].

### 1.2 Per app

Columns: 1 drop result · 2 static or live · 3 what renders · 4 flip or scroll
on the board · 5 open fully · 6 edit · 7 annotate · 8 performance and limits.

**Miro**

| | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PDF | Paged file object. "Extract pages" places all or chosen pages under it. Or "Turn into slides" [A1][A4][V2] | Static; sharper re-render on zoom-in [A10] | One page at a time; extract picks pages [A1] | Turn pages, no scroll [A1][V2] | Not documented | No; links in the PDF not clickable [A1] | Comments. Objects sit over every page until extracted [A1][A11] | 30 MB [A1][V2]. Complex PDFs may fail; convert to PNG/JPEG [A1][V2]. Each extracted page keeps the whole PDF [A9]. No PDF upload on mobile [A1] |
| PPTX | "Convert to slides" (editable, ≤50 MB) or "Add as file" (view-only, ≤30 MB) [A4][V1] | Slides native, file static | File behaves like a PDF, with extract [A1] | Turn pages [A1] | † | Slides yes [A4] | As PDF | Load time grows with image size [A4] |
| DOCX | "Convert to doc" makes a Miro Doc; or add as file [A5][A8] | Doc native | – | – | Doc opens in full-screen Focus mode [A5] | Doc ≤80,000 chars [A5] | Inline comments, suggestions [A5] | Conversion failing in Feb 2026 (community) [A8] |
| XLSX | "Convert to table" (≤500×30), grid, or add as file [A6] | Table native; file view-only [A7] | – | – | – | Table yes | Comments | ≤250 structured widgets per board [A6] |
| Video | Upload ≤150 MB MP4/MOV/WebM; YouTube/Vimeo embeds [A1][A3] | Live after Play [A3] | – | ±10 s skip [A3] | Full screen [A3] | No | – | Plays per viewer, not synced [A3] |
| Image | Image object [A7] | Static | – | – | – | Crop | On top | 30 MB, 32 MP, 8192×4096 [A1]. Full resolution only once zoomed in (moderator, 2020) [A10] |

**FigJam**

| | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PDF | Generic PDF becomes "static images or text" (staff, 2024) [A19]. Miro, Mural and Lucid exports become native objects [A17][A18] | Static | Every page into the file (Lucid) [A18] | No page viewer | – | The objects are editable [A17][A18] | FigJam tools on top | No viewer or splitter; plugins fill the gap [A20] |
| PPTX, DOCX, XLSX | Can't be imported; CSV becomes a table [A15][A21] | – | – | – | – | – | – | – |
| Video | MP4/MOV/WebM, ≤100 MB, paid teams [A15][A23] | † | – | – | – | – | – | – |
| Image | PNG/JPG/GIF/TIFF/WEBP/HEIC; crop, rotate [A16] | Static. GIFs animate only on click, one at a time [A16] | – | – | – | Crop | On top | One GIF at a time [A16] |
| Link | Static bookmark, or an interactive embed (YouTube, Figma, Loom, Miro…) [A22] | Live after a click; "only have one active at a time" [A22][V5] | – | Inside the embed | Maximize or new tab [A22] | Inside the embed | – | Activation is per user [A22] |

**Figma (Design, Slides)**

- PDF:
  - Not in Design's import docs [A24][A25].
  - Generic PDF import is documented for FigJam only; Design relies on
    plugins† [A19].
- PPTX: Figma Slides imports a deck as an editable Slides file, with all
  slides and presenter notes. Fonts become Inter; videos, tables, diagrams and
  object animations are dropped [A25][A26].
- DOCX and XLSX: can't be imported [A25].
- Video: a fill on a layer, paid plans, ≤100 MB [A23][A24].
- Image: a fill; SVG becomes vectors; images past 4096 px are downscaled
  [A24].
- Renderer:
  - C++ compiled to wasm on a tile-based WebGL engine [A27]. Moving to wasm
    cut load time 3× in 2017 [A29].
  - WebGPU since 2025-09-18, with a WebGL fallback mid-session. The same
    renderer runs natively on the server [A28].

**Microsoft Whiteboard**

| | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PDF | Create › Documents, from the device, OneDrive or recent files. Page picker or Select All; pages placed and resizable [A31] | Static (pages as images †) | Chosen pages [A31] | † | The context menu has no Open [A35] | No | Comments anchor to objects (documents not named) [A36]; ink over pages † | Needs "Optional Connected Experiences" [A31], which suggests cloud processing†. Sensitivity labels can block [A31] |
| PPTX | Same flow [A31] | Static | Chosen slides [A31] | † | No Open [A35] | No | † | Same |
| DOCX, XLSX | Not in current docs [A31]. Loop tables are live, editable components [A34] | – | – | – | – | – | – | – |
| Video | Online links only (YouTube, Vimeo, Stream…) [A32] | Live; plays only for whoever started it [A32] | – | – | – | – | – | Per viewer [A32] |
| Image | Device or Bing Images [A31] | Static | – | – | – | – | – | – |

**Canva whiteboards**

- PDF: imported as an editable design (text and images split into elements;
  scanned PDFs become one flat image), ≤500 pages, ≤300 MB and ≤1,400
  elements. Large files "may import incompletely" [A38].
- PPTX: editable conversion (beta, desktop browser), ≤300 slides; charts,
  SmartArt, 3D and WordArt are ignored [A39].
- DOCX: imported with comments [A37].
- XLSX: ≤100 MB, 500×52 [A37].
- Video: ≤1 GB, 4K stored at 1080p [A37].
- Image: ≤50 MB [A37].
- Every import opens as its own design in the editor [A38][A39]. A whiteboard
  is a page with "Expand to whiteboard" applied. Elements are hidden when
  zoomed far out [A40].

**Heptabase**

| | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PDF | PDF card on a whiteboard or in the Card Library [B1][B2] | Static preview on the board; 2026 fixes to "PDF card previews" [B3] | Preview page † | Not on the board †; arrow keys flip pages in the side panel [B3] | Right side panel or a card tab; Space opens quick look [B3][B9][B10] | No | Text highlights (Dec 2022) and area highlights (Jan 2023) become highlight cards you drag onto the board, embed in notes or use in mindmaps [B1][B4] | 2 GB per file. Parsing (OCR) ≤350 MiB and 3,000 pages [B4][B5] |
| PPTX, XLSX | No card type or import listed [B4][B6]; a file block inside a note † | – | – | – | – | – | – | 2 GB [B5] |
| DOCX | Converted into a note card (v1.81.2, Dec 2025) [B4][B6] | Live native note | Whole text | Scrolls like a note | Side panel or tab [B10] | The copy | Note tools | Formatting not guaranteed [B6] |
| Video | Video element (Oct 2023) [B8] | Live † | – | Play † | Video tab for YouTube [B10] | No | Transcript and insights linked to timestamps [B1] | – |
| Image | Image element, multi-drop [B7] | Static | – | – | Viewer with zoom and pan (2026) [B3] | Resize [B7] | Connect [B7] | Image loading optimisation (2023) [B4] |

**Kosmik** (sunset on 2026-05-31 [V3])

| | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PDF | PDF element [B13] | Live | One page at a time [B13] | The edit dock's arrows flip pages on the canvas [B13] | Side-panel reader (Shift+Space) with page counter and contents [B13] | No | Area capture becomes an image fragment linking back to its page, auto-tagged [B13]. Pen strokes sit over it as objects [B17] | Free tier: 50 MB files, 500 elements (2023) [B18] |
| PPTX, DOCX, XLSX | Accepted but "only be hosted" [B14] | – | – | – | External app † | No | – | – |
| Video | Player "runs directly on the canvas" [B15] | Live | – | Scrub, loop, custom thumbnail [B15] | Canvas | No | Key-frame capture with a time-code back-link [B15] | MP4/WebM/3GP/OGG [B15] |
| Image | Image [B16] | Static | – | – | Canvas | Rotate, crop [B16] | Draw over [B17] | Auto-tagging [B12] |

**Obsidian Canvas**

| | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PDF | Media card from the file explorer, another app or "Add media from vault" [B20] | Live PDF.js viewer [B25][B31] | All pages, scrollable † | Scroll after selecting the card [B20] | Tab † | No | None in core; the PDF++ plugin adds highlights and links [B25] | Zoomed out, PDFs and iframes unload unless interacted with (1.1.4) [B26][V6]. Off-screen nodes unload (forum) [B28] |
| PPTX, DOCX, XLSX | Can be dropped [B20] but are not accepted formats [B24]. Community Office Viewer renders DOCX and PPTX read-only (docx-preview) [B29] | – | – | – | Default app † [B30] | No | – | – |
| Video | Media card: mkv, mov, mp4, ogv, webm [B24] | Live | – | Plays inline | Tab † | No | – | Codecs per device [B24] |
| Image | Media card [B20] | Static | – | – | Tab † | No | – | Grey box when zoomed out until 1.1.5 [B27] |

The open JSON Canvas spec's file node is a path plus an optional `subpath`
(a heading or block), with no page field [B21][B22]. Notes can target a page
with `![[x.pdf#page=3]]` [B23].

**Muse, now Allume** (renamed with v4.0, summer 2026 [B32][V4])

| | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PDF | PDF card [B33][B35] | Static snapshot and thumbnail on the board [B34] | First page on the card face † | Zoom in to read; page keys (2025) [B33][B34] | Zoom into the card in place; QuickLook [B33][B34] | No | Ink (Mac 3.0) [B36]. Excerpts become cards with a "Source Peek" back-link [B33] | Board and PDF snapshots stored as tiles in an on-disk cache with a size cap (4.0) [B34] |
| PPTX, DOCX, XLSX | "Any other files" become a file card [B34][B35] | Icon † | – | – | QuickLook † | No | – | – |
| Video | Video card [B33] | Live | – | Scrub (3.5.2) [B34] | Zoom in | No | Excerpts [B33] | YouTube paste makes a thumbnail card [B34] |
| Image | Image card [B33] | Static | – | Pinch zoom [B37] | Zoom in | No | Ink, excerpts [B34] | Image rendering performance passes (2024) [B34] |

**Milanote**

- PDF and Office files (pptx, key, docx, xlsx, numbers, csv, …) become file
  cards [B39]. Previews are not documented†.
- Video: a playable card; YouTube and Vimeo links embed [B42].
- Image: an image card; draw, crop and rotate; opens in a new tab [B43].
- Milanote's own Document cards switch between an icon and "Card View"
  [B41].
- Limits: Free 10 files of ≤50 MB; Pro ≤5 GB per file [B40].

**Scrintal**

- PDF: an embed block that shows "directly on the canvas" after a
  double-click [B46]. Opens in the doc window [B51].
- Office files: plain file blocks [B47].
- Video: YouTube or Vimeo embeds, or uploads, watchable on the canvas
  [B47][B50].
- Image: JPG and PNG blocks [B47][B48].
- Uploads ≤200 MB [B47].
- Since 2024-10-08 any doc block can sit on a board [B48].
- Docs are thin and partly marked outdated [B46].

**Apple Freeform**

- PDF and Office files are file items; the guide names "multipage PDF files"
  [C1].
- No page flipping on the board is documented [C1][C2].
- Double-click or Preview opens Quick Look, where its arrows move between
  files, not pages, and markup happens [C1][C2].
- Edit: Replace only [C1].
- Video and image are native items: video gets a play button; images get
  mask and remove background [C3].
- A preview-vs-icon toggle is not documented in macOS 14 to 27 guides, so the
  toggle mentioned in the brief is †.

**tldraw (SDK and tldraw.com)**

| | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PDF | Default: "File type is not allowed" [C7]. The custom asset example draws a file card (name, size, link) [C15]. The PDF editor example makes each page a locked image shape [C16] | Static raster [C17][V7] | All pages, stacked [C17] | Pan; camera held to the pages [C16] | Card link [C15] | No | Draw on top; export stamps it onto the PDF with pdf-lib [C16] | pdf.js loaded on demand. Every page rendered once, up front, at DPR × 1.5 to PNG data URLs; no zoom re-render [C17][V7] |
| PPTX | Rejected [C7]; a Google Slides URL becomes an iframe embed [C14] | Live iframe | Whole deck | Inside it after double-click or Enter [C14] | – | As the embed allows | No | Embeds export to SVG as blanks [C14] |
| DOCX, XLSX | Rejected; custom file card [C7][C15] | Static | Name, size | No | Link | No | No | – |
| Video | Video shape [C6][C13] | Live; autoplays unless reduced motion [C13] | – | Controls | – | Replace [C6] | – | 10 MB default asset cap [C8]; off-screen shapes culled [C11] |
| Image | Image shape, temporary preview while uploading [C6][C7] | Static | Whole or crop [C13] | – | – | Crop, flip [C13] | Draw on top | Resolution by zoom through `resolve` [C9][C10]; Cloudflare image transforms on tldraw.com (2024) [C12] |

**AFFiNE** (user-facing; source in §2)

- Release history:
  - Image peek view: v0.15 (Jun 2024) [C18].
  - Attachment viewer and PDF preview: v0.18 (Nov 2024) [C19][C20].
  - PDF embed view: v0.19 (Dec 2024), lazily loaded, workers shut down out of
    view [C21][C22][C23].
  - Edgeless media entry: v0.20 [C24].
  - Iframe embed block: v0.21 [C25].
- Office files stay attachment cards, and their peek says no preview, with
  Download (§2.1, §2.5).

**Notion** (non-canvas comparison)

- PDF: a file block or a PDF embed block, resizable; inline viewing and
  scrolling are † [C27][C28].
- Office files: file blocks with download; not in the previewable list
  [C27].
- Video: Notion's own player, or streaming embeds [C27].
- Images: crop and mask; open in full screen or a new tab [C27].
- Embeds: 1,900+ domains via Iframely [C28]. Link previews are live, synced
  cards for Figma, OneDrive, SharePoint and about 20 apps; Google Drive is not
  on that list [C29].
- Limits: Free 5 MB per file; the paid limits on the page contradict each
  other [C27].

**Google Docs smart chips and linked objects** (non-canvas comparison)

- Any Drive file can be an @ file chip [C30]. What the hover card shows is
  undocumented† [C30]. Drive previews Office files as a "scaled-down version"
  [C32] and edits them through Compatibility Mode or conversion [C33].
- Linked slides, charts and tables are the closest analog to placing a
  snapshot [C31]:
  - only the slides or objects you copied;
  - a frozen snapshot with an Update button, or Tools › Linked objects ›
    Update all;
  - one-way: an update overwrites local edits;
  - viewers see them without access to the source.

---

## 2. AFFiNE in detail, from source (Q2)

Paths starting with `vendor/blocksuite/` are local (AFFiNE canary `5f19254`).
Paths starting with `packages/frontend/core/` are on GitHub at
`https://github.com/toeverything/AFFiNE/blob/8cef09e1dd62b47a3cbc9f352aa10b3a90c75d34/<path>`.

### 2.1 Attachment block: card view and embed view

- **Model.** `vendor/blocksuite/affine/model/src/blocks/attachment/attachment-model.ts`:
  - Props: `name`, `size`, MIME `type`, `sourceId` (blob id), `embed`,
    `style` (`cubeThick`, `horizontalThin`, `pdf`, `citation`), `caption`,
    `xywh`.
  - The blob lives in blob storage, not in the doc.
- **Drop on edgeless.** `addAttachments` in
  `vendor/blocksuite/affine/blocks/attachment/src/utils.ts` (L170-215) turns
  every non-image file into an `affine:attachment` card: style `cubeThick`,
  170×132, cascaded 32 px apart. Images become image blocks
  (`blocks/image/src/image-service.ts`). Card sizes are in
  `vendor/blocksuite/affine/shared/src/consts/index.ts` (`EMBED_CARD_WIDTH`
  and `EMBED_CARD_HEIGHT`: pdf 563×831, video 752×544).
- **Card view.** Icon, name and size, in a vertical (`cubeThick`) or
  horizontal style: `renderCardView` in `blocks/attachment/src/attachment-block.ts`.
  - Edgeless draws the card at its style's fixed size and scales it with a
    CSS transform to the block's bounds.
  - Resizing keeps the ratio and rotation is off (`attachment-edgeless-block.ts`).
- **Embed view.** `embed: true`, drawn by the first `AttachmentEmbedConfig`
  that matches (`blocks/attachment/src/embed.ts`):
  - image: converted into an image block;
  - pdf: resized to the `pdf` card and drawn as
    `<iframe src="blob…#toolbar=0" loading="lazy" credentialless>`, the
    browser's own PDF viewer, under an event mask;
  - video: `<video controls>`;
  - audio: `<audio controls>`.
  - Embedding requires the file to fit `maxFileSize`, 2 GiB by default
    (`shared/src/services/file-size-limit-service.ts`).
- **Toolbar** (`blocks/attachment/src/configs/toolbar.ts`): Card view or
  Embed view, replace, download, caption, rename, copy, duplicate, reload,
  delete, card style.
- **Open.** `open()` is `window.open(blobUrl)` in a new tab. Only PDFs are
  `@Peekable` (`attachment-block.ts` top).

### 2.2 PDF embed in the AFFiNE app: PDFium wasm in a worker (verified)

- **Override.** `packages/frontend/core/src/blocksuite/view-extensions/pdf/pdf-view.tsx`
  replaces BlockSuite's iframe config for `pdf` with `AttachmentEmbedPreview`
  (React through `reactToLit`) when `enablePDFEmbedPreview` is on
  (`…/view-extensions/pdf/index.ts`).
- **Embedded viewer.** `packages/frontend/core/src/blocksuite/attachment-viewer/pdf/pdf-viewer-embedded.tsx`:
  - One page at a time: Prev, Next and a centre-peek button, and a footer
    with the name and `page / count`.
  - It loads only while visible (IntersectionObserver, debounced 377 ms) and
    releases the page and the PDF entity when it leaves the view.
  - The page is drawn at the PDF's own page size × `devicePixelRatio`. It
    does not follow canvas zoom† (inferred from the code).
- **Worker.** `packages/frontend/core/src/modules/pdf/renderer/pdf.worker.ts`:
  - `createPDFium()` from `@toeverything/pdf-viewer`, then
    `new Viewer(new Runtime(pdfium))`.
  - `open` reads page sizes.
  - `render` draws into a PDFium bitmap, converts it to `ImageData` and an
    `ImageBitmap`, and transfers it.
- **One worker per PDF.**
  - `packages/frontend/core/src/modules/pdf/services/pdf.ts` says "One PDF
    document one worker": a refcounted pool keyed by blob id.
  - `packages/frontend/core/src/modules/shared/worker-op-renderer.ts` makes
    `new Worker(...)` per renderer and terminates it on dispose.
- **Cache.** `packages/frontend/core/src/modules/pdf/cache/bitmap-cache.ts`
  keeps an in-memory LRU of 64 page renders as WebP at quality 0.72. A
  cached render up to 1.3× smaller than needed is reused.
- **Engine.** `@toeverything/pdf-viewer@0.1.1` depends on
  `@toeverything/pdfium@0.1.1`, "PDFium WASM vendored", about 3.95 MB
  unpacked, from `github.com/toeverything/pdfium-builder` (npm registry
  metadata, read 2026-11-01).
- **Full viewer** (peek or split view):
  - `…/attachment-viewer/pdf/pdf-viewer.tsx`: react-virtuoso virtualises the
    pages and a collapsible thumbnail rail.
  - `…/modules/pdf/views/page-renderer.tsx`: visible pages only, cache first.

### 2.3 Image, bookmark and embed-iframe blocks

- **Image.** Level of detail in `vendor/blocksuite/affine/blocks/image/src/image-edgeless-block.ts`:
  - An image of ≥1 MiB or ≥1920×1080 is swapped, at zoom ≤ 0.4, for a 256 px
    thumbnail the browser makes on first need
    (`LOD_MIN_IMAGE_BYTES`, `LOD_MAX_ZOOM`, `LOD_THUMBNAIL_MAX_EDGE`).
  - The turbo painter for images draws only a placeholder rectangle so far
    (`blocks/image/src/turbo/image-painter.worker.ts`).
  - Peek: AFFiNE's image preview with zoom
    (`packages/frontend/core/src/modules/peek-view/view/image-preview/`).
- **Bookmark.** A card from link-preview data fetched through
  `LinkPreviewServiceIdentifier` (`vendor/blocksuite/affine/blocks/bookmark/src/utils.ts`,
  `bookmark-block.ts`), with an edgeless variant
  (`bookmark-edgeless-block.ts`).
- **Embed iframe** (`vendor/blocksuite/affine/blocks/embed/src/embed-iframe-block/`):
  - Providers: Google Docs, Google Drive (640×480 on the surface), Miro,
    Excalidraw, Spotify, Bilibili and a generic one (`configs/providers/`).
  - Trusted sandbox `allow-same-origin allow-scripts allow-forms allow-presentation`,
    untrusted `allow-scripts` (`embed-iframe-block.ts` L48-50).
  - An overlay keeps the iframe from taking pointer events until selected
    (L73).

### 2.4 Linked-doc card vs synced doc on the canvas

- **Linked doc** (a card).
  `vendor/blocksuite/affine/blocks/embed-doc/src/common/render-linked-doc.ts`
  renders the linked doc's first notes through a nested `BlockStdScope` with
  the read-only `preview-page` spec, cut to the card's height.
  - Double-click opens it in centre peek when allowed, otherwise in a new tab
    or view (`embed-linked-doc-block/embed-linked-doc-block.ts` L267-292).
  - `convertToEmbed` turns it into a synced doc.
- **Synced doc** (embedded content). `embed-synced-doc-block/embed-synced-doc-block.ts`:
  - It renders the other doc in a nested editor host
    (`new BlockStdScope({ store: syncedDoc, … }).render()`, L201-226), in page
    or edgeless mode, fitted to its content on the canvas (L62-104).
  - In this commit the store is opened `readonly: true` (L415-419).
    Editing goes through peek.
  - `embed-edgeless-synced-doc-block.ts` converts it back to a card.
- Both read another doc's Y.Doc, a sub-document of the same workspace. In
  Capy that other doc is another room. "One canvas room" therefore rules out
  synced docs unless they are drawn from stored content.

### 2.5 Peek view

- `packages/frontend/core/src/modules/peek-view/entities/peek-view.ts`:
  - Types: `doc` (linked, synced, reference, surface-ref), `image`,
    `attachment`, `ai-chat-block`, `template`, `image-list`.
  - Modes: `full`, `fit`, `max`. Animations: fade, fadeBottom, zoom, none.
  - Opening a peek over a doc peek navigates to the first doc.
- **Attachment peek.** `…/peek-view/view/attachment-preview/index.tsx` uses
  `AttachmentViewer` (`…/blocksuite/attachment-viewer/index.tsx`): PDF gets
  `PDFViewer`; any other type gets `AttachmentFallback`, a "can't preview"
  title with Download (`…/attachment-viewer/error.tsx`).
- BlockSuite itself ships only the `@Peekable` decorator and the service
  interface (`vendor/blocksuite/affine/components/src/peek/`). The modal and
  the viewers are AFFiNE app code we do not have. The sibling report
  `plan/A-canvas.md` §8.1 says the same.

### 2.6 Edgeless performance machinery (vendored `std`)

- **Idle blocks.** Off-screen blocks go to `transformState` `idle`:
  `visibility: hidden`, still mounted
  (`vendor/blocksuite/framework/std/src/gfx/viewport-element.ts` L194-200;
  `_hideOutsideAndNoSelectedBlock` L305-370). An iframe or worker inside an
  idle block keeps running unless the block unloads it.
- **Parking.** During low-zoom gestures, idle blocks' DOM moves into a
  DocumentFragment (L238-300). This happens only when
  `SKIP_REFRESH_DURING_GESTURE` and `LOW_ZOOM_GESTURE_ACTIVE_BLOCK_LIMIT` are
  set; the defaults are `false` and `0` (`viewport.ts` L43, L100), and AFFiNE
  sets them on mobile†. A browser reloads an iframe moved out of the document,
  so a live Office frame would reload on each parking (browser behaviour; not
  tested here).
- **Z-order and transforms.** Z-order is `style.zIndex`, with no DOM
  reordering, and each block has its own CSS transform
  (`framework/std/src/view/element/gfx-block-component.ts`).
- **Turbo renderer.** During zoom and pan it paints block layouts into a
  bitmap in a worker, and falls back to the DOM at zoom ≥ 1. Bitmap rendering
  is off by default (`affine/gfx/turbo-renderer/src/turbo-renderer.ts`,
  `defaultOptions`).
- **Surface children.** The surface accepts only frame, image, bookmark,
  attachment, `affine:embed-*` and edgeless-text
  (`vendor/blocksuite/affine/blocks/surface/src/surface-model.ts` L24-31). A
  Capy file block either sits under `@root`, needs a local change there, or
  takes an `affine:embed-capy-*` name (also noted in `plan/A-canvas.md` §8.3).

---

## 3. Capy's building blocks (Q3)

### 3.1 Thumbnails and preview JSON

Source: `openwiki/thumbnails.md`.

- **Who renders what.**
  - PDF and Office: the parse job renders page 1 of the PDF it holds (an
    Office file's LibreOffice conversion; PPTX hidden slides included) at
    200 px wide, cut at 400 px. This is `page_thumbnail` in
    `parser/odl/capture.py`. Ingest encodes it as WebP in its sandboxed
    decode helper (`pipeline/pipeline/ingest/thumbnail.py`).
  - Images: Pillow makes the first frame, 200 px wide.
  - Text and CSV: no image; `files.preview = {text}`, the first 600
    characters.
  - Store-only files and audio: none (thumbnails.md table, L112-117).
  - Video: uploaded videos are store-only. `FileKind` has no video
    (`src/features/files/fileKindMapping.ts`), so they get nothing.
- **Format and size.**
  - WebP at quality 60, 200 px wide, ≤400 px tall, about 1-8 KB.
  - Key: `thumbs/{file id}/{sha256}.webp`, a counted blob reference, not
    charged to quota (thumbnails.md L23-63, `server/migrations/0073_thumbnails.sql`).
- **When.**
  - After each successful ingest.
  - After Office edits, from the browser: an edit frame redraws page 1
    (DOCX), slide 1 (PPTX) or the first sheet's top-left 800×550 at a
    quarter scale (XLSX). It posts to `POST /api/files/{id}/thumbnail`:
    editors only, ≤64 KB, one capture per 60 s per file, 60 per hour per user
    (thumbnails.md L267-435; `src/features/files/thumbnailCapture.ts`,
    `src/office-runtime/thumbnail.ts`, `server/internal/httpapi/huma_thumbnails.go`).
  - Safari encodes no WebP, so it captures nothing (L311-313).
  - An editor opening a file whose card is older than its saved state
    re-captures it (`thumbnailStale`, L338-358).
- **Cost.** Parse-side render 3.4-37 ms. Browser capture on the main thread:
  PPTX 2-3 ms (Japanese text 19-23 ms), DOCX 14-39 ms, XLSX about 1 ms plus
  about 350 ms in its worker (L155-162, L411-420).
- **Links.**
  - List rows carry `thumbnailUrl`: an hour-stable presigned GET, valid two
    hours from the hour, so the bytes come from the browser cache within the
    hour. Single-file responses carry none (L71-100).
  - `GET /api/workspaces/{id}/files` returns every file row unpaged, with
    `thumbnailUrl` and `preview` (`openapi.yaml`, `listWorkspaceFiles`).
- **Material previews.** `materials.preview` is written with every content
  write. It is answer-free and about 1 KB at most:
  - note: 8 blocks and 600 characters;
  - quiz: first question;
  - flashcards: first front;
  - mindmap and diagram: Mermaid source cut to 1 KB.
  - Sources: `server/internal/materialdoc/preview.go`, thumbnails.md
    L164-212.
- **Editor images** (note, quiz and flashcard assets) get a 200 px JPEG thumb
  made in Go (`server/internal/assetthumb/assetthumb.go`, thumbnails.md
  L214-265). Snapshots stored as editor images would get a low-zoom version
  for free.
- **No server renders other pages.**
  - Epo decided on 2026-10-14 that no server draws Office pages after edits
    (thumbnails.md L18-21).
  - The parse bundle keeps no Office PDF ("Office bundles contain no PDF",
    `pipeline/pipeline/parse/parser_client.py` L9; `parser/app.py`
    L1147-1155).
  - The retrieval service's `capture_page` renders PDF pages with PyMuPDF,
    for the model only, and refuses Office files
    (`openwiki/agentic-retrieval.md` L4077).

### 3.2 Cards that draw them

- `src/components/app/ThumbnailPanel.tsx`:
  - An image renders lazy and async. Slides use `object-contain`, pages crop
    from the top, photos from the centre, and pages dim in dark mode.
  - Text and CSV render as live text or table HTML (`TableLive`, `TextLive`).
  - Note, quiz and flashcards render from their preview JSON (`NoteLive`,
    `QuizLive`, `CardsLive` in `src/features/materials/preview/LivePreview.tsx`).
  - Mermaid draws through a light parser for six diagram types. It never
    loads Mermaid (`src/features/materials/preview/MermaidPreview.tsx`,
    `mermaidModel.ts`).
  - It falls back to the kind icon.
- `src/components/app/PreviewCard.tsx` wraps it for the Create tab and Recent
  Files. Create-tab templates pass fixed example previews or bundled SVG
  pages (`src/features/workspace/templatePreviews.ts`).

### 3.3 PDF reader

- **Library and location.** `react-pdf` ^9.1.1 over `pdfjs-dist` 4.8.69
  (`package.json`), in `src/features/files/PdfView.tsx`, loaded as a lazy
  chunk (`FileViewer.tsx` L59). The worker is bundled same-origin
  (`pdf.worker.min.mjs?url`).
- **Behaviour.**
  - Page wrappers keep the scroll layout; canvases and text layers mount only
    near the viewport (`PAGE_OVERSCAN_PX` 1200), plus page 1 and cited pages.
  - Private annotations exist (highlights, pen, text, shapes, in normalised
    page coordinates), but the tools are hidden for now (`ANNOTATION_TOOLS =
    false`; `openwiki/frontend/office-files.md` L3139-3171).
- **Startup cost.** No measured open time in the repo†.
  - Bundle: `pdf.min.mjs` 337 KB (94 KB gzip) and `pdf.worker.min.mjs`
    1.37 MB (399 KB gzip), measured locally.
  - The whole file streams into the worker; range reads are off because read
    links live 5 minutes (office-files.md L3164-3171). The plan cap bounds the
    bytes: 10 MiB Free, 30 MiB Pro.
  - Each `<Document>` gets its own pdf.js worker. `PdfView` sets only
    `workerSrc` (L31, L472), and pdf.js `getDocument` creates a `PDFWorker`
    per document unless one is passed
    (`node_modules/.pnpm/pdfjs-dist@4.8.69/.../build/pdf.mjs`, `getDocument`).
    Several PDF minis on a canvas would mean several workers unless they
    share one.

### 3.4 BetterOffice

Sources: `openwiki/frontend/office-files.md`, `src/office-runtime/`.

- **How the frame loads.**
  - `office-runtime.html` is a second Vite entry served from a separate,
    cookie-less origin (`VITE_OFFICE_RUNTIME_ORIGIN`), in an iframe with
    sandbox `allow-same-origin allow-scripts`
    (`src/features/files/officeRuntimeConfig.ts`). Production refuses to run
    it on the app origin (L2103-2122).
  - The app fetches the bytes and transfers the `ArrayBuffer`. Bytes are
    cached in Cache Storage by SHA-256, about 200 MB (L107-198,
    `src/lib/sourceCache.ts`).
  - The frame URL fixes format and mode for the frame's life (L148-157). At
    boot the frame prewarms its viewer module and engine
    (`src/office-runtime/prewarm.ts`).
- **WASM sizes** (local build of 2026-10-26, near the current pin, raw / gzip -9):

  | Engine | File | Raw | Gzip |
  | --- | --- | --- | --- |
  | DOCX viewer | `packages/docx/src/wasm/generated/viewer/docx_view_wasm_bg.wasm` | 8.37 MB | 3.01 MB |
  | PPTX viewer | `packages/pptx/src/wasm/generated/viewer/pptx_view_wasm_bg.wasm` | 2.17 MB | 0.96 MB |
  | XLSX viewer | `packages/xlsx/src/wasm/generated/viewer/xlsx_view_wasm_bg.wasm` | 0.82 MB | 0.37 MB |
  | DOCX editor | `docx_edit_bg.wasm` | 11.42 MB | – |
  | PPTX editor | `pptx_wasm_bg.wasm` | 3.96 MB | 1.61 MB |
  | XLSX editor | `xlsx_wasm_bg.wasm` | 5.23 MB | – |

  (All under `vendor/betteroffice/`.) Fonts:
  - The PPTX viewer always loads Liberation Sans regular and bold, about
    0.41 MB each (`src/office-runtime/pptxFonts.ts`).
  - CJK faces are 4.5-11.6 MB each, loaded on demand (L2053-2068).
  - A deck's own fonts can cost up to 64 MiB (L2070-2101).
  - Linear memory grows in steps of up to 64 MiB and never shrinks in an
    instance (L225-239).
- **Open time.** `pnpm bench:office` medians, open click to first paint, CI
  EPYC runners, 2026-10-04 (`bench/editor/scripts/runtime.office.ts`
  L84-122). MSW adds about 1.1 s per call, so the frame's own share is
  smaller†:

  | File | Open to first paint |
  | --- | --- |
  | PPTX, 20 slides, 311 KB | 3,183 ms |
  | PPTX, 84 slides, 24 MB | 5,728 ms |
  | DOCX, 15 pages | 5,289 ms |
  | DOCX, 62 pages | 7,954 ms |
  | XLSX, small | 3,148 ms |
  | XLSX, large | 3,732 ms |

  Heap per frame is recorded but report-only and not committed, so memory per
  view frame is unmeasured† (`openwiki/editor-perf.md` L139-169, L272-278).
  The DOCX engine worker in Edit held about 0.8 GB at 62 pages (2026-10-06
  survey, editor-perf.md L158-159).
- **Viewers are read-only and lighter.**
  - The XLSX and PPTX viewer WASM omits editing, collaboration, undo and
    save.
  - DOCX lowering runs in a disposable worker that terminates after posting
    its display list (L215-224; `src/office-runtime/DocxViewer.worker.ts`).
  - View is not live: it shows the saved state at open. When the saved state
    is ahead of the indexed one, the runtime applies the checkpoint with the
    editor engines in a disposable export worker first (L357-377). Viewing an
    edited DOCX therefore also loads the 11 MB editor engine, briefly.
- **DOCX reading view.** In a frame under 768 px, the viewer lays the
  document out again as one 16 px-padded column: no headers or footers,
  eased type sizes, tables fitted (L1174-1197).
- **PPTX rail.** A strip of 126 px slide thumbnails sits left of the fitted
  slide. Under 1024 px (or a frame under 640 px) it becomes a row of 96 px
  thumbnails under the slide; there is no pager (L1710-1725).
  - At open, `PptxViewer.tsx` lays out every slide ("eager layout of the
    whole deck", L86-90, L195-200) and paints every strip thumbnail on its
    own canvas (L359-387, L493-519).
- **Rendering one slide or page.**
  - PPTX: yes, structurally. `openPresentation(bytes)`, then
    `layoutSlide(i)`, then `paintSlide(ctx, frame, dpr, scale)` at any scale
    (`PptxViewer.tsx` L185-200, L270-304). `renderSlides(handle, indices)`
    already rasters chosen slides to PNG at 2× (`src/office-runtime/pptxRender.ts`).
    Parsing still opens the whole package, and fonts must be registered in
    the painting realm.
  - DOCX: the viewer lays out the whole document before posting. A page-1
    path needs fork work† (it builds eight pages at a time, L221-224).
    `renderPages` rasters pages for Print and can stop after page 1
    (`thumbnail.ts` `pageThumbnail`).
  - XLSX: the thumbnail worker paints a region from a display list
    (`thumbnail.worker.ts`). `xlsxRender.ts` paints PNG and Print.
  - A `render` message (`print`, `png`, `thumbnail`) answers with PNG pages
    (`src/features/files/officeProtocol.ts` L238-244; office-files.md
    L1088-1108).
  - Verdict: drawing a single slide **as an image** is cheap once a frame has
    the deck open. Keeping a frame alive per file to show one slide is not:
    an iframe realm, 0.8-8.4 MB of viewer WASM, fonts, the bytes, and 3-8 s
    to first paint.

### 3.5 CSV, Mermaid, image and video

- **CSV and TSV.**
  - Viewer: a worker fetch, bounded to 30 MiB, previews 500 rows × 50
    columns (`src/features/files/CsvView.worker.ts`, `csvPreviewCore.ts`).
  - Card: 8 rows × 5 columns from the 600-character preview (thumbnails.md
    L116).
- **Mermaid.**
  - Cards use the light SVG parser above.
  - Full diagrams render in a Web Worker (`openwiki/editor-perf.md` L295-300;
    `bench/editor/reports/2026-10-22-mermaid-worker.md`).
  - Mindmap and diagram materials preview from their 1 KB source.
- **Images.**
  - `src/features/files/ImageViewer.tsx` shows the original from a presigned
    link (`GET /api/files/{id}/links`, one per file, expiring).
  - Cards use the 200 px WebP.
- **Video.**
  - Uploaded video files are store-only (`UnsupportedPreview` in
    `FileViewer.tsx` L519-546).
  - Notes embed YouTube only (`capy:video`, provider and id). The poster
    loads the player only on click (`src/features/materials/YouTubeEmbed.tsx`,
    `i.ytimg.com/.../hqdefault.jpg`).

### 3.6 Rooms, seats and lazy joins

- A user may join at most 22 documents at once, about 7 per device on 3
  devices. Joining past that closes the oldest channel
  (`collaboration-rs/crates/server/src/seats.rs` L25-29).
- An embedded quiz or set joins inside its note's channel, at most 64 per
  note (`collaboration-rs/crates/server/src/socket.rs` L81).
- Embeds join only near the screen: about one viewport of margin, staying
  joined 30 s after leaving (`src/features/collaboration/useNearScreen.ts`;
  `noteSeat.ts`).
- Office **View** joins no room: it is a lock-free read of
  `source-session?view=true` (office-files.md L357-366). Only Edit takes a
  source room.

### 3.7 BlockSuite pieces in Capy

- `capy:material-ref` is a reference block (`materialId`, `refKind`) whose
  view publishes a DOM island. The note's single React tree portals the app's
  embed into it, so one React root serves every block
  (`src/features/blocksuite/capyBlocks.ts`, `capyViews.ts`,
  `src/features/notes/blocksuite/islands.ts`). This is the pattern a
  `capy:file-ref` card would follow.
- Notes register no `affine:attachment`, `affine:bookmark`, `embed-*` or
  database, and notes embed images and audio only (PE:192,
  `todo-blocksuite-decisions.md` L176-177). A canvas file block is therefore
  a new decision.
- The canvas packages are vendored in a lazy chunk (D4). Dragging rewrites
  `xywh` on every step, so writes should happen on drop or throttled
  (`todo-blocksuite-spike.md` L84-86, L199-200).

---

## 4. Feasibility tiers (Q4)

"One canvas room" holds for tiers a, b and c. The canvas holds a reference
block (a file id, `xywh`, maybe a page) or an image block naming an editor
asset. File bytes stay in B2, Office state in the file's source room, and
snapshot bytes in editor assets. Tier e opens the file's own room only in
Edit. Tier d opens no rooms in View but needs one iframe or worker per item.

Work common to every tier:

- a `capy:file-ref` flavour, where to put it (`@root`, a surface change, or
  an `affine:embed-capy-*` name, §2.6), and its row in the layout spec, room
  admission, `value()` and the TS converter;
- drag from the Files tree and drop from the desktop (upload into the
  workspace, then place);
- refusing BlockSuite's own `affine:attachment` path, which stores blobs;
- states for a trashed, deleted or moved file, reusing `lostAccess.tsx` and
  `fileMoved.ts`;
- remapping file ids when a workspace is cloned.

### (a) Link card

- **Others:** Milanote, Notion, Freeform, Kosmik (Office), AFFiNE
  `cubeThick` cards (§1.1, §2.1).
- **Built:** the workspace file list (name, kind, size); `FileIcon`;
  `/files/:id`; the island pattern.
- **New:** only the common work above.
- **Cost:**
  - CPU: none.
  - Memory: one small DOM node per card.
  - Bundle: none.
  - Server: none.
- **Risks:** low value (Epo's own view). Reference integrity costs the same
  as in the other tiers.

### (b) Static preview card from existing thumbnails and preview JSON

- **Others:** Heptabase PDF previews, Muse snapshots, Miro's static paged
  object, Google Drive's scaled-down preview, Milanote "Card View".
- **Built:**
  - everything `ThumbnailPanel` draws: page 1, slide 1 or the sheet corner
    as WebP; text and CSV previews; all material previews; Mermaid drawings;
  - browser re-capture after Office edits, and the tree event that refetches
    lists.
- **New:**
  - a canvas-sized card reusing `ThumbnailPanel`;
  - refreshing `thumbnailUrl` before its 2 h window ends;
  - optional sharper source. 200 px is already upscaled on a 2× screen and
    blurry when zoomed in. Either accept that, with an Open affordance
    (Miro's spinner-and-re-render is the alternative), or add a second,
    larger ingest render (for example 800 px) for PDF, Office and images.
    The render is cheap at parse time (3-37 ms) and the bytes small. A larger
    browser capture would need the 64 KB endpoint cap raised, and Safari
    still sends none.
- **Cost:**
  - CPU: negligible.
  - Memory: about 0.32 MB decoded per 200×400 thumbnail, so about 32 MB for
    100 visible cards (computed). BlockSuite keeps idle cards mounted but
    hidden.
  - Bundle: none new.
  - Server: none, or one extra render and key per file for the sharp
    option.
- **Risks:**
  - page 1 only;
  - blur when zoomed in;
  - stale cards for Safari-only editors;
  - videos, audio and store-only files keep the icon.

### (c) Page or slide picker placing snapshots

- **Others:**
  - Miro "Extract pages", all or chosen, placed under the original;
  - Whiteboard's page picker before insert;
  - FigJam PDF to images;
  - tldraw's example, rasterising every page once;
  - Google Docs linked slides, a snapshot with Update, one-way;
  - Kosmik and Muse fragments that link back.
- **Built:**
  - PDF pages render client-side through pdf.js (`PdfView`).
  - PPTX: `renderSlides(handle, indices)`.
  - DOCX: `renderPages`, which can stop early.
  - XLSX: `xlsxRender.ts`.
  - The `render` protocol.
  - The editor-asset image path (uploader pays, 2 MiB cap, one browser
    compressor, `todo-blocksuite-decisions.md` L184) with Go-made 200 px
    thumbs.
  - `affine:image` with its zoom level of detail.
- **New:**
  - a picker: the PPTX viewer already has a slide strip; PDF needs a page
    strip;
  - a `render` request naming pages and width. This changes the Office
    protocol, so the pin-bump checklist's client-protocol bump applies
    (office-files.md L66-72);
  - encoding (WebP, or JPEG on Safari) and upload as an editor image;
  - `source {fileId, page, revision}` props on the image: an image-props
    change in the layout spec;
  - a "source changed, Update" check against the file's `revision`;
  - decisions on payer and quota, and on whether a snapshot outlives a
    trashed source.
- **Cost:**
  - Per placement: one viewer open (3-8 s for Office in the bench; PDF
    unmeasured), then about 2-40 ms of raster per page plus encoding.
  - Storage: roughly 100-400 KB per 1280-1600 px snapshot (estimate, within
    the 2 MiB cap).
  - On the canvas: plain images with a 200 px version for low zoom.
- **Risks:**
  - Office snapshots go stale; PDFs are immutable, so they never do;
  - storage growth for the uploader;
  - large decks: picking needs every slide's thumbnail, which today means
    the eager layout.

### (d) Live view-only mini viewer inside the canvas

- **Others:**
  - Kosmik live page flip (sunset 2026-05-31);
  - Obsidian's pdf.js cards, unloaded when zoomed out unless used;
  - AFFiNE's PDFium page with a pager, only when visible;
  - Scrintal after a double-click;
  - tldraw and FigJam iframes behind explicit activation, FigJam one at a
    time.
  - Nobody does live Office minis.
- **Built:** `PdfView`; the three Office viewers; DOCX reading layout; PPTX
  `layoutSlide` and `paintSlide`; prewarm; the source-bytes cache.
- **New for PDF:**
  - a one-page card with a pager;
  - one `PDFWorker` shared by all cards;
  - render scale that follows zoom;
  - explicit unload when idle, because BlockSuite keeps idle blocks mounted;
  - activation gating and a pointer mask (AFFiNE's event mask, §2.1).
- **New for Office:**
  - a mini runtime mode: no strip, menus or header;
  - lazy per-slide layout;
  - a DOCX first-page layout in the fork;
  - one cross-origin iframe per mini, required by security;
  - handling iframes inside CSS-transformed blocks, and reloads when
    BlockSuite parks DOM (§2.6).
- **Cost per live PDF:**
  - a worker thread, unless shared;
  - the whole file in memory, up to 30 MiB;
  - about 3-8 MB per page bitmap at DPR 2. A letter page drawn AFFiNE-style
    at points × DPR is 1224×1584×4 B ≈ 7.8 MB (computed).
- **Cost per live Office mini:**
  - an iframe realm;
  - 0.8-8.4 MB of viewer WASM, compiled per realm;
  - about 0.8 MB of fonts (CJK 4.5-11.6 MB per script);
  - the file bytes;
  - 3-8 s to first paint;
  - for edited files, an editor engine in the export worker;
  - unmeasured memory per frame. A 1280×720 slide canvas at DPR 2 alone is
    about 14.7 MB (computed).
- **Risks:**
  - Office View is not live anyway (state at open), so a mini gains nothing
    over a snapshot but page flipping;
  - phones and the 8 GB budget;
  - pointer and focus conflicts;
  - reloads on DOM moves.

### (e) Peek or side panel with the full viewer or editor (file's own room)

- **Others:** AFFiNE centre peek (PDF viewer, Office fallback), Heptabase
  side panel, Kosmik side-panel reader, Freeform Quick Look, Miro Docs focus
  mode, Muse zoom into the card, FigJam maximize.
- **Built:**
  - `FileViewer` for every kind, with View and Edit, saves, presence and the
    file's source room;
  - `/files/:id`;
  - the header mode control;
  - the rule that the viewer stays under one parent, since moving an iframe
    reloads it (office-files.md L389-405);
  - the `@Peekable` decorator. AFFiNE's peek service is not vendored, so we
    write our own modal (`plan/A-canvas.md` §8.1).
- **New:**
  - a peek or side-panel host over the canvas;
  - a deep link;
  - focus that returns to the canvas;
  - a full-screen sheet on phones;
  - the canvas staying mounted underneath.
- **Cost:**
  - the same as opening the file today, one at a time;
  - no server work;
  - Edit adds one source room, one of the user's 22.
- **Risks:**
  - canvas and Office editor memory at the same time (the DOCX editor
    worker held about 0.8 GB at 62 pages);
  - keyboard shortcuts clashing between canvas and frame;
  - the panel host must not re-parent the frame.

### Ranking and recommendation

Feasibility, best first: **(a) > (b) > (e) > (c) > (d) PDF > (d) Office.**

1. **Now: (b) with (a) as its fallback, plus (e).** One `capy:file-ref`
   block draws the file's existing preview (`ThumbnailPanel` at canvas size)
   and falls back to the icon card. Double-click or Open shows the file in a
   peek or side panel with its normal viewer and editor.
   - Nearly everything is built: the new work is the block, the panel and
     reference integrity.
   - It matches what Heptabase, Muse, AFFiNE and Freeform do.
   - It keeps file content out of the canvas room.
2. **Next: (c).** "Place pages…" for PDF (client-side pdf.js) and PPTX
   (`renderSlides`), later DOCX and XLSX. Snapshots are image blocks with a
   back-link and an Update action, the Google Docs linked-slides pattern.
   - This is what makes a canvas useful for study: pages and slides can be
     arranged, connected and drawn on.
   - It costs one raster per page, once.
3. **Not now: (d).** No comparable app renders live Office on a board.
   Capy's Office View is a snapshot of the saved state anyway, and each live
   mini needs a cross-origin iframe with several MB of WASM and seconds to
   open. If a page flipper is wanted later, make it PDF-only in AFFiNE's
   style: one page, visible only, a shared worker, one active at a time.
4. **"First slide, view-only, no toolbars, as light as possible."** That is
   the 200 px WebP Capy already stores and re-captures after edits. The next
   step up is a larger stored capture (ingest render, or the runtime's
   `renderSlides` once). A live frame draws the same pixels at a far higher
   cost.

### How many live viewers a canvas can afford

| Kind | Budget | Why |
| --- | --- | --- |
| Interactive live viewer (any type) | **1 at a time** | FigJam's "only one active at a time" [A22][V5]; Obsidian keeps only touched PDFs loaded [V6]; tier e is that one |
| Live PDF page minis, if built | 1 active; at most about 3 painted at once on desktop, sharing one worker (estimate†, measure first) | Per item: the file in memory (≤30 MiB) plus about 3-8 MB per page bitmap |
| Live Office minis | **0 on the canvas**: open in the panel instead | iframe realm, 0.8-8.4 MB of WASM, fonts and 3-8 s each; View is not live |
| Static preview cards | Hundreds | About 0.32 MB decoded each; BlockSuite hides off-screen cards |
| Snapshot images (c) | Dozens visible | 200 px thumb at low zoom; a full 1280 px image is about 3.7 MB decoded |
| Rooms | Canvas 1, plus 1 source room in Edit, plus embedded quizzes or sets inside the canvas channel (64) | Server caps: 22 joined documents per user |

---

## 5. Decisions for Epo

1. **A file block on the canvas.** Notes refuse file blocks (PE:192). The
   canvas would hold a reference block for workspace files, with no bytes of
   its own. Sign-off needed.
2. **Default look of a dropped file.** Preview card (b, recommended) or icon
   card (a). Setting a default needs sign-off per AGENTS.md.
3. **Dropping a file from the desktop.** Upload it into the workspace (which
   chapter?) and then place it, or refuse and ask for Files?
4. **Sharpness.** Accept the 200 px card when zoomed in, or add a larger
   ingest render under a second `thumbs/` key?
5. **Snapshots (c).**
   - Who pays (the uploader, as editor images)?
   - Do they survive the source file's trash?
   - Should "Update" appear when the file's revision moves?
6. **A PDF page flipper (d).** Wanted at all, and only after (b), (c) and
   (e)?

---

## 6. Sources

**A: Miro, FigJam, Figma, Microsoft Whiteboard, Canva**

- A1 https://help.miro.com/hc/en-us/articles/360017731013
- A2 https://help.miro.com/hc/en-us/articles/360017731613
- A3 https://help.miro.com/hc/en-us/articles/30316193985170
- A4 https://help.miro.com/hc/en-us/articles/25542531289234
- A5 https://help.miro.com/hc/en-us/articles/20164660410898
- A6 https://help.miro.com/hc/en-us/articles/22760922335506
- A7 https://help.miro.com/hc/en-us/articles/360017731233
- A8 https://community.miro.com/ask-the-community-45/issue-uploading-doc-docx-files-convert-to-document-not-working-27643
- A9 https://community.miro.com/ideas/pdf-extract-pages-feature-improve-miro-performance-10955
- A10 https://community.miro.com/ask-the-community-45/pdf-regeneration-time-2127
- A11 https://community.miro.com/ask-the-community-45/editing-marking-up-multi-page-pdfs-812
- A12 https://community.miro.com/ask-the-community-45/board-size-impacting-performance-4783
- A13 https://developers.miro.com/docs/websdk-reference-embed
- A14 https://miro.com/careers/vacancy/7425039002 (weak)
- A15 https://help.figma.com/hc/en-us/articles/1500007927941
- A16 https://help.figma.com/hc/en-us/articles/1500004290881
- A17 https://help.figma.com/hc/en-us/articles/6227676527255
- A18 https://help.figma.com/hc/en-us/articles/24170628689047
- A19 https://forum.figma.com/suggest-a-feature-11/enable-pdf-import-on-figma-7707
- A20 https://forum.figma.com/suggest-a-feature-11/figjam-files-32350
- A21 https://forum.figma.com/suggest-a-feature-11/allow-importing-of-commonly-used-file-types-25178
- A22 https://help.figma.com/hc/en-us/articles/4414079911575
- A23 https://developers.figma.com/docs/plugins/api/properties/figma-createvideoasync
- A24 https://help.figma.com/hc/en-us/articles/360040028034
- A25 https://help.figma.com/hc/en-us/articles/360041003114
- A26 https://help.figma.com/hc/en-us/articles/30601628883607
- A27 https://www.figma.com/blog/building-a-professional-design-tool-on-the-web/
- A28 https://www.figma.com/blog/figma-rendering-powered-by-webgpu/
- A29 https://www.figma.com/blog/webassembly-cut-figmas-load-time-by-3x/
- A31 https://support.microsoft.com/en-us/whiteboard/insert-pictures-and-documents-in-whiteboard
- A32 https://support.microsoft.com/en-us/whiteboard/insert-online-videos-onto-a-whiteboard
- A33 https://support.microsoft.com/en-us/whiteboard/insert-links-on-a-whiteboard
- A34 https://support.microsoft.com/en-us/topic/c5f08f54-995e-473e-be6e-7f92555da347
- A35 https://support.microsoft.com/en-us/whiteboard/whiteboard-context-menu
- A36 https://support.microsoft.com/en-us/whiteboard/commenting-in-whiteboard
- A37 https://www.canva.com/help/upload-formats-requirements/
- A38 https://www.canva.com/help/import-and-edit-pdfs-canva/
- A39 https://www.canva.com/help/powerpoint-import/
- A40 https://www.canva.com/help/expand-to-whiteboard/
- A41 https://www.canva.com/help/upload-media/

**B: Heptabase, Kosmik, Obsidian, Muse/Allume, Milanote, Scrintal**

- B1 https://wiki.heptabase.com/pdf-annotation
- B2 https://wiki.heptabase.com/fundamental-elements
- B3 https://wiki.heptabase.com/changelog
- B4 https://wiki.heptabase.com/roadmap
- B5 https://support.heptabase.com/en/articles/10447030-what-s-the-size-limit-for-uploading-files
- B6 https://support.heptabase.com/en/articles/10447948-import-notes-from-other-apps
- B7 https://wiki.heptabase.com/newsletters/2023-10-05
- B8 https://wiki.heptabase.com/newsletters/2023-10-19
- B9 https://wiki.heptabase.com/newsletters/2023-09-28
- B10 https://wiki.heptabase.com/user-interface-logic
- B12 https://www.kosmik.app/
- B13 https://www.kosmik.app/faq/pdf-files-and-pdf-reader
- B14 https://www.kosmik.app/faq/other-types-of-files
- B15 https://www.kosmik.app/faq/videos
- B16 https://www.kosmik.app/faq/images
- B17 https://www.kosmik.app/blog/kosmik-drawing-tools
- B18 https://techcrunch.com/2023/12/21/meet-kosmik-a-visual-canvas-with-an-in-built-pdf-reader-and-a-web-browser
- B19 https://www.kosmik.app/faq/browser-and-built-in-web-capture
- B20 https://obsidian.md/help/plugins/canvas
- B21 https://jsoncanvas.org/spec/1.0/
- B22 https://raw.githubusercontent.com/obsidianmd/obsidian-api/master/canvas.d.ts
- B23 https://obsidian.md/help/embeds
- B24 https://obsidian.md/help/file-formats
- B25 https://github.com/RyotaUshio/obsidian-pdf-plus
- B26 https://obsidian.md/changelog/2022-12-12-desktop-v1.1.4/
- B27 https://obsidian.md/changelog/2022-12-14-desktop-v1.1.5/
- B28 https://forum.obsidian.md/t/canvas-sluggish-performance-issue-when-multiple-nodes-enter-exit-the-view/68609
- B29 https://community.obsidian.md/plugins/office-viewer
- B30 https://forum.obsidian.md/t/insert-embed-other-file-formats-like-xlsx-and-docx-but-not-limited-to-in-addition-to-pdf-and-images/3418
- B31 https://obsidian.md/changelog/2023-05-09-desktop-v1.3
- B32 https://allume.com/allume-faq
- B33 https://allume.com/memos/2022-03-muse-for-mac/
- B34 https://allume.com/updates/
- B35 https://apps.apple.com/us/app/muse-canvas-for-thinking/id1501563902
- B36 https://allume.com/memos/2023-09-muse-3-collaboration/
- B37 https://allume.com/memos/2026-03-09-muse-v3.5-new-tools/
- B38 https://talk.macpowerusers.com/t/new-thinking-app-for-the-ipad-muse/17536 (weak)
- B39 https://help.milanote.com/en/articles/1159010-what-kind-of-files-can-i-upload
- B40 https://help.milanote.com/en/articles/1722107-how-do-file-upload-limits-differ-between-free-and-pro-plans
- B41 https://help.milanote.com/en/articles/10458661-documents
- B42 https://help.milanote.com/en/articles/10478926-videos
- B43 https://help.milanote.com/en/articles/359381-images
- B45 https://help.milanote.com/en/articles/1722065-links
- B46 https://scrintal.com/features/cards (marked outdated by Scrintal)
- B47 https://scrintal.gitbook.io/scrintal-support-docs/working-in-the-text-editor.md
- B48 https://scrintal.gitbook.io/scrintal-support-docs/scrintal-concepts.md
- B49 https://scrintal.com/pricing
- B50 https://scrintal.com/
- B51 https://scrintal.gitbook.io/scrintal-support-docs/working-with-docs.md

**C: Apple Freeform, tldraw, AFFiNE (user-facing), Notion, Google**

- C1 https://support.apple.com/guide/freeform/frfm870e38cd/mac
- C2 https://support.apple.com/en-us/guide/freeform/add-other-files-frfm870e38cd/2.0/mac/14.0
- C3 https://support.apple.com/en-euro/guide/freeform/frfma66848a4/3.0/mac/15.0
- C5 https://support.apple.com/en-euro/guide/freeform/frfm6e3d132d2/3.0/mac/15.0
- C6 https://tldraw.dev/sdk-features/external-content
- C7 https://raw.githubusercontent.com/tldraw/tldraw/main/packages/tldraw/src/lib/defaultExternalContentHandlers.ts
- C8 https://tldraw.dev/reference/tldraw/TldrawBaseProps
- C9 https://tldraw.dev/sdk-features/assets
- C10 https://tldraw.dev/sdk-features/performance
- C11 https://tldraw.dev/sdk-features/culling
- C12 https://github.com/tldraw/tldraw/pull/3764
- C13 https://tldraw.dev/sdk-features/default-shapes
- C14 https://tldraw.dev/sdk-features/embed-shape
- C15 https://tldraw.dev/examples/custom-asset-type
- C16 https://tldraw.dev/examples/pdf-editor
- C17 https://raw.githubusercontent.com/tldraw/tldraw/main/apps/examples/src/examples/use-cases/pdf-editor/PdfPicker.tsx
- C18 https://github.com/toeverything/AFFiNE/releases/tag/v0.15.0
- C19 https://github.com/toeverything/AFFiNE/releases/tag/v0.18.0
- C20 https://github.com/toeverything/AFFiNE/pull/8569
- C21 https://github.com/toeverything/AFFiNE/releases/tag/v0.19.0
- C22 https://github.com/toeverything/AFFiNE/pull/8671
- C23 https://github.com/toeverything/AFFiNE/pull/9307
- C24 https://github.com/toeverything/AFFiNE/releases/tag/v0.20.0
- C25 https://github.com/toeverything/AFFiNE/releases/tag/v0.21.0
- C26 https://github.com/toeverything/AFFiNE/issues/7830
- C27 https://www.notion.com/help/images-files-and-media
- C28 https://www.notion.com/help/embed-and-connect-other-apps
- C29 https://www.notion.com/help/link-previews
- C30 https://support.google.com/docs/answer/10710316
- C31 https://support.google.com/docs/answer/7009814
- C32 https://support.google.com/drive/answer/37603
- C33 https://support.google.com/docs/answer/6055139

**V: my spot checks (2026-11-01)**

- V1 Miro help API for A4 (`/api/v2/help_center/en-us/articles/25542531289234.json`): "Add as file" loads "as view-only reference", 30 MB.
- V2 Miro help API for A1 (`…/360017731013.json`): turn and extract pages; 30 MB; complex PDFs may fail.
- V3 https://www.kosmik.app/: "Kosmik will sunset on May 31st 2026".
- V4 https://allume.com/allume-faq: Muse is changing its name to Allume, with v4.0 in summer 2026.
- V5 Figma help API for A22 (`…/4414079911575.json`): interactive previews, "only have one active at a time".
- V6 https://obsidian.md/changelog/2022-12-12-desktop-v1.1.4/: interacted-with PDFs and iframes stay loaded when zoomed out.
- V7 `gh api repos/tldraw/tldraw/contents/apps/examples/src/examples/use-cases/pdf-editor/PdfPicker.tsx`: `visualScale = 1.5`, DPR scale, `toDataURL()` per page, every page.

**AFFiNE source (GitHub canary `8cef09e1`, 2026-10-27)**, paths as cited in §2, under
`https://github.com/toeverything/AFFiNE/blob/8cef09e1dd62b47a3cbc9f352aa10b3a90c75d34/`.
npm metadata: `https://registry.npmjs.org/@toeverything/pdf-viewer/latest`,
`https://registry.npmjs.org/@toeverything/pdfium/latest`.
