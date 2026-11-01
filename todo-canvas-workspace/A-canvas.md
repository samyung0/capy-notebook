# Workspace canvas: how canvas tools structure a project, and select vs edit

Research for Capy Notebook's workspace canvas, 2026-11-01, branch `blocksuite-notes`
(checkout `/Users/sam/web/capy-notebook/.claude/worktrees/blocksuite-notes`). This was read-only:
nothing in the repo was edited, built, tested or installed.

**Tags.** [official] an official page that was fetched. [official-snippet] an official page seen
only through a search summary (help.miro.com and some Apple article bodies blocked direct fetch).
[source] source code: AFFiNE at `5f1925499760f6954c1e656711d9fb6ed3168179` (the commit we
vendored), tldraw, Excalidraw, or our `vendor/blocksuite`. [forum] community or Reddit posts.
[3p] press or a third-party blog. [unverified] memory or one weak source.
Every claim about another app has its URL in §12, listed by app. Vendored paths are relative
to `vendor/blocksuite/` unless they start with `src/`, `collaboration-rs/` or `todo-`.

**Gaps.**
- The shared web-search budget for this run (200 searches) ran out partway through.
- User complaints were gathered for Miro (and one Figma Slides post) only. None were gathered
  for AFFiNE, Heptabase or Obsidian.
- Phone editing is unverified for FigJam on phones, tldraw and Excalidraw on phone web, and
  Muse/Allume on iPhone.
- AFFiNE's public docs are thin, so most AFFiNE facts come from its source at our vendored
  commit.
- BlockSuite behaviour below comes from reading the code. None of it was run.

A follow-up message can resume the web searches.

---

## 1. Short answer

1. **No app among the 14 makes a single canvas the root of a project.** Every one allows
   several canvases (pages, boards, whiteboards, scenes) or nests boards inside boards. The one
   closest to "one canvas is the space", Kosmik's Universe, added a chronological feed in 2024
   because its canvas "lacked a home". Kosmik shut down on 2026-05-31; no cause is given.
2. **Card-first tools separate content from canvases.** Heptabase whiteboards "do not own cards",
   so one card can sit on many whiteboards. Obsidian canvases point at vault notes. Scrintal's
   Library reuses docs and boards. AFFiNE's canvas holds linked-doc and synced-doc cards.
3. **Element lists:** only Figma lists every element (a z-ordered tree). Whiteboards list
   frames or scenes, and reordering sets presentation order: AFFiNE's frame panel, Miro's frames
   panel, Freeform's scenes. Card tools list cards in a library (Heptabase), and Heptabase's
   whiteboard table of contents lists sections. Miro users complain that frames are the only
   navigation [forum].
4. **Select, then edit, is universal.** A click selects. A double-click (or Enter) edits in
   place or goes one level deeper. Esc backs out. **No app has a user setting for what
   double-click does.** The nearest is AFFiNE's `openDocMode` setting: it decides how a linked doc
   opens (active view, new view, new tab or center peek).
5. **Long writing always gets a non-canvas surface:**
   - AFFiNE page mode and center peek;
   - Heptabase card tabs, popup and Quick Look;
   - Milanote Documents;
   - Scrintal Doc Window and focus mode;
   - Miro Docs Focus mode;
   - Obsidian note files;
   - on phones, Whiteboard opens Loop components in Office.com.
6. **Phones are the weak spot.** AFFiNE's mobile app makes edgeless read-only unless an
   experimental flag is on, and the flag is off by default [source]. Miro opens boards view-only
   by default. Figma cannot edit design files on a phone. Microsoft retired its standalone
   Whiteboard apps on 2026-10-16. Heptabase, Obsidian, Milanote and Freeform do edit on phones.
7. **Our BlockSuite has every canvas piece:**
   - notes with `xywh`/`displayMode`, frames, mindmap and connector elements;
   - presentation mode with arrow-key frame navigation;
   - the frame and outline panels;
   - the gfx-block API for custom canvas blocks;
   - an edgeless-only mount, which works by construction.

   The peek view is only an interface; AFFiNE's modal is app code. Today the canvas code is
   bundled in the note editor's lazy chunk but not wired:
   - page scope only;
   - surface and frame views and schemas refused;
   - the Rust schema has no surface;
   - notes are seeded `displayMode: "doc"`, which the canvas does not draw.

---

## 2. Project structure (Q1)

| App | Canvas = project root, or a file inside one? | Canvases per project | Pages / sections / frames | Long documents vs the canvas |
|---|---|---|---|---|
| **AFFiNE** | File-like. A workspace holds many docs, and every doc has a Page Mode and an Edgeless Mode [official]. | One canvas per doc, any number of docs [official]. New docs can default to page, edgeless or "ask" (`newDocDefaultMode`, default page) [source]. | Frames and groups on the canvas; both can be inserted into Page Mode [official]. | Notes have a display mode: both, doc-only or edgeless-only [source]. Page Mode shows the doc-visible notes in reading order, and the canvas numbers them [official]. Notes drawn with the canvas note tool are edgeless-only [source]. Other docs sit on the canvas as linked-doc cards or synced-doc embeds, and "Turn into linked doc" makes a note its own doc [source]. |
| **Figma** | File inside a project: team → project → file → pages; a page is a canvas [official]. | Many pages per file. The Starter plan caps team design files at 3 pages [official-snippet]. | Sections hold any layer, including other sections. They are top level and cannot sit inside frames or groups [official]. | No long-document model found [unverified absence]. |
| **FigJam** | File inside a project [official]. | Pages per file, each its own board, on paid plans only. Launched around Config 2024 [official; date forum]. | Sections group objects (Shift+S) [official]. | Text objects only; no document mode. |
| **Miro** | The board is the unit. Spaces organise boards (they replaced Projects) and cannot nest [official-snippet; forum]. | One canvas per board, many boards per Space. | Frames on the board; Layers since 2024 (§3). | **Miro Docs** are a format placed on the board. They have a Focus mode and an 80,000-character cap, and a copy on another board does not sync [official-snippet]. |
| **tldraw** | File. tldraw.com added sign-in and a files sidebar in early 2025 [official]. | Pages per file, in a page menu [official]. The SDK can limit a file to one page (`maxPages: 1`) [official]. | Frames. | None. |
| **Excalidraw(+)** | Excalidraw+ keeps scenes in collections [official-snippet]. | One canvas per scene; no pages [unverified absence]. | Frames (tool F) [official]. | None; text wrapping was added in 2024 [official]. |
| **Microsoft Whiteboard** | File: boards are OneDrive `.whiteboard` files [official]. | One canvas per board. | No frames or element list found. | **Loop components** are live cards backed by `.loop` files: task list, table, voting table, progress tracker, checklist. They stay in sync when pasted into Teams or Outlook [official]. |
| **Apple Freeform** | File: boards sit in folders and subfolders [official]. | One canvas per board. | **Scenes** (iOS/iPadOS 18, 2024) are saved views that divide a board into labelled sections [official; date 3p]. | Text boxes are meant for "titles, labels, captions" [official]. |
| **Heptabase** | Neither: the content lives in the **Card Library**. Whiteboards are views that place cards; they "do not own cards" [official]. | Many whiteboards, nestable since 2022-05-27 [official]. Selected objects can be turned into a new whiteboard (2026-09-03) [official]. | Sections (2022-09-20; auto-grow 2023-08-28; tidy-up 2026-08-19); mindmaps (2023-05-25) [official]. | Cards open as full card tabs; there is also a journal [official]. One card can sit on several whiteboards, and its Info shows which [official]. |
| **Obsidian Canvas** | File: `.canvas` files inside the vault, in the JSON Canvas format [official]. | Any number. | Group nodes [official]. | Note cards point at vault notes, optionally narrowed to one heading or block (`#subpath`). A text card can be converted to a file [official]. JSON Canvas 1.0 dates from 2024-03-11; array order is z-order [official]. |
| **Kosmik** | Closest to "the canvas is the space": a **Universe** is one infinite canvas, and everything in it is a card [3p]. | One Universe. Cards can be included in other canvases [3p]. | Frames act as "visual folders" [official]. | Kosmik 3 (Nov 2024) added a non-spatial chronological **feed** as the home screen, because the canvas "lacked a home" and stored things were hard to find [official]. **Removed: Kosmik closed on 2026-05-31.** Sign-ups are closed and existing users can only export [official]. |
| **Muse → Allume** | Boards nest inside boards; one board holds ink, text, PDFs and files [official]. | Nested boards; no endless zoom [official]. | Breadcrumb trail (v4.0) [official]. | Canvas only. **Renamed Allume with v4.0 in 2026**, the month inconsistent across its own pages; still independent [official]. |
| **Milanote** | A private Home board works like a desktop, and boards nest. Sharing a parent shares its children [official]. | Nested boards. | Columns and boards. | **Documents** are a long-form element. On the board they show as an icon or a card preview, and a double-click opens them. Long notes are offered "Convert to Document". Documents hold no images and allow one editor at a time [official]. |
| **Scrintal** | One personal **Desk** per user, nestable **Boards**, and a **Library** of every doc and board [official]. | Many boards. | Boards nest. | **Docs** are linear documents. A doc on a board shows as Compact (title), Snippet (fixed height) or Full (grows with content) [official]. Docs and boards are reused across projects; how the reuse works is not stated [official]. |

**Takeaways for Capy.**
- "The canvas is a top-level property of the workspace" has a near precedent only in Kosmik and
  in the home-board designs: Milanote Home, the Scrintal Desk, Muse's root board. All three
  nest more boards inside it.
- Every other app treats canvases as many objects in a project.
- Epo's wording, "the elements on the *current* canvas", reads as if there may be more than one
  canvas. That needs settling.

---

## 3. Element list / outline panel (Q2)

| App | What it lists | Grouping, search, filter | What a click does | Thumbnails | Reordering |
|---|---|---|---|---|---|
| **AFFiNE frame panel** | Frames only, in presentation order [source]. | No search or filter in the code [source]. Header: a presentation button and settings (Fill Screen, Dark background, Hide toolbar) [source]. | Click selects the frame on the canvas. Double-click fits the viewport to it; from Page Mode it switches to edgeless first [source]. | Yes: a live, read-only preview editor per frame card [source]. | Dragging sets presentation order (`presentationIndex`) [source]. |
| **AFFiNE outline** | Notes in page order with their headings; edgeless-only notes under "Hidden Contents" [source]. | A "Show type icon" setting and a sorting toggle [source]. | In edgeless, clicking a note card selects the note and double-clicking zooms to it. Clicking a heading scrolls only in Page Mode [source]. | Text previews. | With sorting on, dragging reorders the notes' page order [source]. |
| AFFiNE sidebar | The right sidebar renders the chat (if AI is on), properties, journal, outline and frame tabs, with no mode check on the frame tab. A comment tab and an analytics tab are rendered under cloud and flag conditions [source]. | | | | |
| **Figma Layers** | Every layer on the page, as a nested tree [official]. | Hover highlights the layer on the canvas; search not verified. Right-click > Select layer lists the layers under the cursor [official]. | Click selects; Shift+click selects a range; Cmd/Ctrl+click adds. Double-clicking a section's icon navigates to it; double-clicking a name renames [official]. | Type icons only [unverified]. | Order is z-order [official]; dragging restacks [unverified]. |
| **FigJam** | No layers panel [official]; a page list. | | | | The page list is drag-reorderable [official]. |
| **Miro frames panel** | Frames only [official-snippet]. | Thumbnail view by default, or a list [official-snippet]. No search found. Layers (delivered 2024-10-14) are user-made visibility groups, not a tree [official-snippet; forum, staff]. | Click navigates to the frame [forum]. | Yes [official-snippet]. | Panel order sets presentation and PDF order. "Magic Organize" (2022) orders frames by position [official community]. |
| **tldraw.com** | Pages only: create, rename, duplicate, reorder [official]. | No layer list on tldraw.com [unverified absence]. The SDK has a layer-panel example that selects on click and hides with an eye icon [official]. | | | Pages reorder [official]. |
| **Excalidraw** | No layers panel [unverified absence]. "Find on canvas" groups results into Frames and Texts [source]. | Cmd/Ctrl+F text search [official-snippet]. Cross-scene search is on the roadmap [official-snippet]. | | | |
| **Whiteboard** | No element list found. | | | | |
| **Freeform** | The Scene list [official]. | Add, rename, replace, delete [official]. | Picks the scene [official]. | Not stated. | Drag to reorder [official]. |
| **Heptabase Card Library** | Every card [official]. | Filters: tags and whiteboards (2022), card type, "Created by AI" (2026-04-08), properties and dates (2026-09-14). Timeline mode; sort (2024) [official]. | Opens the card in the side panel; expanding opens a card tab. Cards drag onto a whiteboard [official]. | Not found. | Not found. |
| **Heptabase whiteboard** | A table of contents of sections, not of elements (2024-01-16; hierarchical 2026-10-19). A mini map (2026-09-23), hidden by default since 2026-10-09 [official]. | A card's "Whiteboard location" panel shows where it is placed [official]. | Not found. | | |
| **Obsidian Canvas** | No node list or outline in core [official]. The "Canvas: Jump to group" command lists groups [official]. | | | | |
| **Kosmik** | The feed, plus AI tagging and search [official]. | | | | |
| **Muse/Allume** | Find within boards and PDFs (3.5, 2025-11-30) [official]. | | | | |
| **Milanote** | No element list. Search covers the current board or all boards, sorted by last viewed or modified [official]. | | ⌘U goes to the parent board [official]. | | |
| **Scrintal** | The sidebar's Recents and Starred; Spotlight (Cmd+Shift+K) with "Add to Board" [official]. | | Drag from the sidebar onto a board [official]. | | |

**Takeaways.**
- A Canvas tab listing every element is a design-tool pattern (Figma).
- Whiteboards list chapters (frames, scenes, sections); card tools list cards.
- Reordering in a whiteboard list changes presentation order, not stacking.
- Clicking selects (AFFiNE, Figma) or navigates (Miro); zoom-to is on double-click in AFFiNE.

---

## 4. Select vs edit (Q3)

| App | Single click | Double click | Enter | Esc | Depth | Where editing happens |
|---|---|---|---|---|---|---|
| **AFFiNE / BlockSuite** (code, not run) | Selects a note. A mask covers the note until editing, so the first click never places a caret [source]. | A click on an already-selected note enters text editing with the caret at the pointer, so a double-click edits in place [source]. Elsewhere: empty canvas adds a text element; a linked-doc card opens center peek when allowed, otherwise the doc in the active view; a group edits its title; in a read-only canvas it zooms to 100% or fit [source]. | Edits a connector label or a canvas text block; on a mindmap node it adds a sibling. Not a note [source]. | Clears the whole selection; I found no step back from editing to "note selected" [source]. | One level per click: the first click picks the outermost group; once a group is selected, the next click picks inside it [source]. | In place. Linked docs: center peek or navigation. A synced-doc embed renders the whole doc in a card [source]. |
| **Figma** | Selects the parent group or frame [official]; children of top-level frames select directly [unverified]. | One level deeper each time; edits text [official]. | Selects the child; Shift+Enter the parent; Tab/Shift+Tab siblings [official]. | Clears the selection [official]. | Cmd/Ctrl+click deep-selects any nested layer [official]. | In place. |
| **FigJam** | | Edits a sticky [unverified]. | | | | In place. |
| **Miro** | Selects. | On mobile, double-tap adds text; otherwise select and tap Edit [official-snippet]. | Edits the selected item [official-snippet]. | Deselects or stops editing [official-snippet]. | | In place; Docs in Focus mode [official-snippet]. |
| **tldraw** | Selects. | Inside an unfocused group: next level down. Otherwise the shape's own handler, then crop, then editing with all text selected. Empty canvas creates text (developer option) [source]. | Selects children if all selected are groups; edits one editable shape; otherwise crop [source]. | Leaves the focused group first, then clears [source]. | One level per double-click [source]. | In place. Embeds need a double-click to become interactive [official]. |
| **Excalidraw** | Selects. | Edits text, edits line points, or crops an image [source]. | Same as double-click [source]. | Finishes editing (also Cmd/Ctrl+Enter) [source]. | Cmd/Ctrl+click deep-selects; Cmd/Ctrl+drag deep box-selects [source]. | In place. Embeds show a "Click to interact" button [source]. |
| **Whiteboard + Loop** | | Double-tap on touch edits a Loop component in place [official]. | Enter or Space selects the focused object and opens a text object for editing [official-snippet]. | | | In place. On iOS/Android a Loop component opens in Office.com [official]. |
| **Freeform** | Tab moves between items; no keys for entering or leaving text editing are documented [official]. | Edits [unverified]. | | | | In place. |
| **Heptabase** | Selects [unverified for a click on a card's body]. | On empty canvas creates a card; Cmd+double-click creates a text element [official]. | Edits the selected object [official]. | Back to selection; a second Esc deselects [official]. | Arrow keys move the selection between objects [official]. | In place. Space toggles Quick Look; Cmd+click opens a popup; Cmd+Shift+click a card tab (full page); Alt+click adds to the side panel [official]. |
| **Obsidian Canvas** | Selects and brings to front [official]. | Edits a text or note card [official]. | Not found. | Stops editing, as does a click outside [official]. | Groups. | In place. You must select a card before you can scroll inside it [official]. |
| **Milanote** | | Opens a Document for writing [official]. | | Means "Deselect / Stop editing" [official]. | ⌘U goes to the parent board [official]. | Documents open for writing [official]. |
| **Scrintal** | | On the top of a doc, opens a Doc Window; Maximize switches to focus mode [official]. | | Closes the window or focus mode [official]. | | A doc in Full layout is edited in place on the board [official]. Cmd+click opens a sidebar doc in focus mode [official]. |
| **Kosmik** | Items open in a side panel [3p]. | Not found. | | | | |
| **Muse/Allume** | | Not found. | | | | Cmd+click opens a card in a new tab (3.2.9) [official]. |

### 4.1 Long-form text on a canvas

- **AFFiNE / BlockSuite** [source]
  - Notes default to 498 px wide; the minimum is 218 px.
  - Height is automatic by default: the note writes its own height into `xywh` as content
    grows.
  - "Customized height" folds the note at a fixed height, with a "more" button to unfold it.
  - Notes also have a per-note scale.
  - The reading view is the doc's Page Mode, entered with the mode switch (⌥S / Alt+S).
  - "Turn into linked doc" makes a note its own doc; the card then opens in center peek.
- **Heptabase.** A card tab gives a full page, with a table of contents on card pages. The side
  panel, popup and Quick Look are lighter views. An AI "Insight" summarises long cards
  (early testing) [official].
- **Scrintal.** A doc on a board is Compact, Snippet or Full. The Doc Window and focus mode give
  more room [official].
- **Milanote.** Documents, with a "Convert to Document" offer for long notes [official].
- **Miro.** Docs with Focus mode and an 80k-character cap. On mobile, Docs can be edited only in
  Focus mode [official-snippet].
- **Obsidian.** Note cards are files and open in a tab. Core cards do not size their height
  automatically; the Advanced Canvas community plugin adds it [official; source].
- **Freeform.** Text boxes for labels [official].
- **Whiteboard.** Long content goes into Loop [official].

### 4.2 A setting for what double-click does

None found in any of the 14 apps. The closest:
- **AFFiNE** has an `openDocMode` editor setting: `open-in-active-view` (default),
  `open-in-new-view`, `open-in-new-tab` or `open-in-center-peek` [source].
  - BlockSuite's linked-doc card reads which open modes are allowed. On double-click it opens
    center peek when that mode is allowed, otherwise the active view [source].
  - That is a choice of *where a doc opens*, not of edit-in-place vs open.
- **tldraw** has developer options only: `createTextOnCanvasDoubleClick` and the debug flag
  `editOnType` [source].
- **Heptabase** has a "mouse navigation mode" where the wheel zooms [official].
- **AFFiNE/BlockSuite** has `edgelessScrollZoom` [source]. That is the wheel, not the click.

---

## 5. Canvas-only vs dual mode (Q4)

| App | Document mode? | How long text is handled |
|---|---|---|
| **AFFiNE** | **Dual, per doc.** Every doc has both modes; ⌥S / Alt+S switches [official; source]. | Page Mode; per-note display mode; center peek for linked docs [source]. |
| **Figma** | Figma Slides is a separate file type with Grid view, Single slide view and a Design mode toggle. Open beta from 2024-06-26 [official]. Dev Mode is an inspection mode [official]. | Not a writing tool. |
| **FigJam, tldraw, Excalidraw, Freeform** | Canvas only. | Short text; Freeform says labels [official]. |
| **Miro** | Board plus Docs as a format on it. | Docs in Focus mode; mobile edits Docs only in Focus mode [official-snippet]. |
| **Whiteboard** | Board plus Loop components. | On phones a Loop component opens in Office.com [official]. |
| **Heptabase** | **Dual by object:** whiteboards plus card tabs and a journal [official]. | Card tab. |
| **Obsidian** | **Dual by construction:** notes are files with their own tabs [official]. | Note tab. |
| **Kosmik** | Canvas plus, from Nov 2024, a feed home [official]. Closed 2026-05-31. | Side panel [3p]. |
| **Muse/Allume** | Canvas only; bounded boards, no endless zoom [official]. | Not found. |
| **Milanote** | Canvas plus Documents [official]. | Documents. |
| **Scrintal** | Canvas plus Docs, the Doc Window and focus mode [official]. | Full layout in place, or Doc Window and focus mode. |

**Complaints** (all [forum] except Kosmik's own post):
- **Miro:** big boards are hard to navigate.
  - The frames panel is "limited to Frames only" (March 2026).
  - There is no outline and frames do not nest (2021 thread, last reply 2024).
  - Users still ask for a Figma-style layers panel (May 2025).
  - In presentation mode you cannot jump to a frame by keyboard (Dec 2022).
  - A later update made the arrow keys pan instead of advance the show.
- **Figma Slides:** switching between Slide and Grid view is hard (2024).
- **Kosmik's own post (official):** the canvas "lacked a home" and stored things were hard to
  find, so they built a feed.
- **Not gathered:** AFFiNE edgeless, Heptabase and Obsidian Canvas complaints (search budget).

---

## 6. Chapters, sections, presentation (Q5)

| App | Chapter unit | Presentation | Frame by frame |
|---|---|---|---|
| **AFFiNE / BlockSuite** | Frames: title, background, child ids and a presentation index. Groups too [source]. | The Present tool (`frameNavigator`) plays frames in panel order, fullscreen [source]. Options: fill or fit, dark background, hide toolbar [source]. Command palette: "Start presentation" [source]. | ← / → and toolbar previous/next; a frame-order menu while presenting [source]. |
| **Miro** | Frames. | Present plays frames in panel order [official-snippet]. | Arrow keys; no jump-to-frame by key (2022); a later change made arrows pan [forum]. |
| **Figma** | Sections and frames; prototypes; Figma Slides. | Prototype links to frames or sections; a section link returns you to the last frame visited there [official]. Slides adds speaker notes, transitions and co-presenting [official]. | Prototype or Slides navigation. |
| **FigJam** | Sections and pages. | "Spotlight me" brings viewers to your view; no presentation mode in the guide [official; absence unverified]. | Not found. |
| **tldraw** | Frames. | tldraw.com: none [unverified]. The **tldraw offline** desktop app (2026-07-22) has a presentation mode built from frames plus a slide menu [official]. The SDK has a slides example [official-snippet]. | Arrow keys move the camera in the SDK example [official-snippet]. |
| **Excalidraw+** | Frames. | Frames become slides automatically and are presented inside the scene. A laser pointer, phone control by QR code, and PDF or PPTX export (Plus only) [official]. | Slides. |
| **Whiteboard** | None found. | "Everyone follow me" [official-snippet]. | |
| **Freeform** | Scenes. | Present or print scenes in order [official]. | Back/forward buttons or pick from the list; arrow keys not documented [official]. |
| **Heptabase** | Sections and the table of contents. Shift+1 fits the board; Shift+2 fits the selection [official]. | Not found; the roadmap only lists "New Tutorial and Slides" (2023) [official]. | |
| **Obsidian** | Groups [official]. | Core: none. The Advanced Canvas plugin turns nodes joined by arrows into slides, read-only while presenting [source]. | Arrows or PageUp/PageDown (plugin) [source]. |
| **Kosmik** | Frames, which can form "slide-like sequences" [official]. | Navigation mode (Opt+F) [official]. | Arrow keys jump to the nearest item in that direction, not in a set order [official]. |
| **Milanote** | Boards and columns. | Presentation mode shows the whole board; focus mode highlights a clicked element; a "Prevent editing" option [official]. | No slide order [official]. |
| **Muse/Allume, Scrintal** | Boards. | Not found. | |

---

## 7. Phones (Q6)

Capy's smallest screen is 360 px.

| App | Phone canvas | Notes |
|---|---|---|
| **AFFiNE** | **Read-only by default.** Mobile edgeless is read-only unless `enable_mobile_edgeless_editing` is on. That flag is off by default and can be toggled only in mobile builds; its label is "Enable Edgeless Editing" [source]. | iOS and Android apps, per the download page's metadata and AFFiNE's mobile build code [official; source]. Mobile edgeless has an "immersive" mode that auto-hides the header [source]. BlockSuite's mobile scopes drop only the slash menu and the floating toolbar and change the code block's toolbar; there is also a mobile zoom ruler [source]. |
| **Figma** | View, zoom, comment, export and mirror; "not possible to edit" design files or Slides decks [official]. | iOS 16+ / Android 8+. FigJam editing is documented for iPad. Phone FigJam editing [unverified]. |
| **Miro** | Boards open view-only by default; tap Edit to edit. Frames, notes, search and the creation toolbar are limited. Templates, export, presentation mode and voting are missing. Editing in a mobile browser is unsupported, and frames cannot be reordered on touch [official-snippet]. | iOS 16+ / Android 7+. |
| **tldraw** | Mobile web; editing [unverified]. | The smallest named UI breakpoint is 389 px, so 360 px is below it [source]. |
| **Excalidraw** | Mobile web editing [unverified]. | Excalidraw+ uses a phone as a presentation remote [official]. |
| **Whiteboard** | **Removed: the standalone Windows, iOS and Android apps retired on 2026-10-16** [official]. A news report gave 2026-11-30 [3p]. | Web and Teams remain for work and school accounts. Loop on phones: view and edit, no create [official]. |
| **Freeform** | Editable on iPhone; the iPhone guide has full creation chapters [official]. | |
| **Heptabase** | **Editable.** Mobile v1 2023-03-08. Creating and editing cards and text on a whiteboard 2024-05-30; "Create, Edit, and Connect Everything" 2024-06-27. Mini map and in-whiteboard search on mobile 2026-09-23 [official]. | Android mainly on Google Play [official]. |
| **Obsidian** | **Editable:** tap selects, touch-and-hold opens menus, there is a toolbar; image export is missing on mobile [official]. | |
| **Kosmik** | None: macOS and Windows only; closed 2026-05-31 [official]. | |
| **Muse/Allume** | iPhone, iPad and Mac; whether a phone can edit boards: not found [official]. | No Android or web. |
| **Milanote** | **Editable with limits:** double-tap opens a board, long-press drags. Tables are view-only; no offline mode, no trash [official]. | |
| **Scrintal** | No phone app; macOS and Windows desktop [official]. | |

---

## 8. Our vendored BlockSuite (Q7)

Source: AFFiNE `canary` at `5f19254`, package 0.27.5, 70 packages, with the canvas packages
vendored per D4 (`vendor/blocksuite/README.md`). Paths below are under `vendor/blocksuite/`.

### 8.1 What exists

| Piece | Exists | Where | What it does |
|---|---|---|---|
| `affine:note` with `displayMode`, `xywh` | Yes | `affine/model/src/blocks/note/note-model.ts`; `affine/model/src/consts/note.ts` | `displayMode` is `both`, `doc` or `edgeless`; the schema default is `both`. Other props: `xywh`, `index` (z-order), `background`, `edgeless.style`, and `edgeless.collapse`/`collapsedHeight`/`scale`. The parent is the root. Default width 498 px, minimum 218 px. The deprecated `hidden` prop is replaced by `displayMode`. The canvas note tool creates `edgeless` notes (`affine/gfx/note/src/note-tool.ts:315`). |
| Edgeless note view | Yes | `affine/blocks/note/src/note-edgeless-block.ts` | Selection: the second click on a selected note enters editing at the pointer (`handleSelection`, about `:437-525`); collapse and "more" button. `renderGfxBlock` draws nothing for `doc` notes. |
| | | `affine/blocks/note/src/components/edgeless-note-mask.ts` | The mask takes the pointer until editing. Its ResizeObserver writes the note's height into `xywh` (auto height), except when the store is read-only. |
| | | `affine/blocks/note/src/configs/toolbar.ts` | Toolbar: "Display in Page" (`:63`), display-mode menu (behind a flag), Slicer, Auto/Customized height (`:167`), scale. |
| Frames | Yes | `affine/model/src/blocks/frame/frame-model.ts`; `affine/blocks/frame/src/` | `affine:frame` has `title`, `background`, `childElementIds` and `presentationIndex`, and sits under `affine:surface`. F frames the selection, or picks the frame tool when nothing is selected. Also: frame manager, highlight, toolbar, frame title widget (`affine/widgets/frame-title`). |
| Mindmap element | Yes | `affine/model/src/elements/mindmap/mindmap.ts`; `affine/gfx/mindmap/src/` | A surface element (`GfxGroupLikeElementModel`) whose nodes are shape elements. `layoutType` (right by default), `style`, `addNode`, `toggleCollapse`; canvas and DOM renderers, tool, toolbar, drag. Keys: Tab adds a child, Enter a sibling, and typing replaces a selected node's text (`affine/blocks/root/src/edgeless/edgeless-keyboard.ts`, `edgeless-root-block.ts` `bindHotKey`). |
| Connectors | Yes | `affine/model/src/elements/connector/{connector.ts,local-connector.ts}`; `affine/gfx/connector/src/`; `affine/widgets/edgeless-auto-connect/` | Tool C; label editor opened by Enter or double-click. Auto-connect shows the note order numbers. |
| Presentation / frame navigator | Yes | `affine/blocks/frame/src/present-tool.ts` | The tool is named `frameNavigator`. |
| | | `affine/blocks/frame/src/edgeless-toolbar/presentation-toolbar.ts` | ← / → (`:166-167`), previous/next buttons, fullscreen (`:267-280`). |
| | | `affine/blocks/frame/src/present/` | Order menu, settings, dark background. |
| | | `affine/blocks/frame/src/frame-manager.ts` | Navigator modes `fill`/`fit` (`:29`); frames sorted by `presentationIndex`. |
| Frame panel | Yes | `affine/fragments/frame-panel/src/` | Select (`body/frame-panel-body.ts:132-147`), drag reorder (`:173-226`), fit (`:228-246`). Click and double-click on a card (`card/frame-card.ts:206-207`). One `preview-edgeless` editor per frame card (`card/frame-preview.ts:94-95`). Settings (`header/frames-setting-menu.ts`). The host passes `host` and `fitPadding`. |
| Outline panel | Yes | `affine/fragments/outline/src/` | `body/outline-panel-body.ts`: page-visible notes, then "Hidden Contents"; selection in edgeless; drag sets page order. Also the floating TOC (`outline-viewer.ts`) and `mobile-outline-panel.ts`. Needs `editor` (an `EditorHost`) and `fitPadding`. Built around the page/edgeless duality. |
| Peek view | **Interface only** | `affine/components/src/peek/{service.ts,type.ts,peekable.ts,controller.ts}` | `PeekViewProvider`/`PeekViewExtension`, the `PeekViewService` interface, and the `@Peekable` decorator. Its default actions are double-click and shift-click. Peekable today: linked-doc, synced-doc, surface-ref, image (page and edgeless), attachment, the reference inline, footnote, database and data-view. **The modal is AFFiNE app code** (`packages/frontend/core/src/modules/peek-view`: `PeekViewService`, `PeekViewManagerModal`; types doc, image, attachment, AI chat block, template) [source]. Open modes: `affine/shared/src/services/open-doc-config.ts:6-10`. |
| Custom block on the canvas | Yes (API) | Model: `framework/std/src/gfx/model/gfx-block-model.ts` | `GfxCompatible`: `xywh`, `index`, `lockedBySelf`. |
| | | View: `framework/std/src/view/element/gfx-block-component.ts` | `toGfxBlockComponent`, `renderGfxBlock`, `getRenderingRect`. |
| | | Behaviour: `framework/std/src/gfx/interactivity/` | `GfxViewInteractionExtension(flavour, {handleSelection, handleResize, handleRotate, resizeConstraint})`; `InteractivityExtension` for click, dblclick and select suggestions. |
| | | Placement: `framework/std/src/gfx/grid.ts:385-392`; `layer.ts:552-561` | A gfx block is drawn only if its parent is the root or `affine:surface`. |
| | | `affine/blocks/surface/src/surface-model.ts:24-31` | The surface accepts only frame, image, bookmark, attachment, `affine:embed-*` and edgeless-text. The root has no children rule. |
| | | `affine/model/src/utils/helper.ts` | The embed helper `createEmbedBlockSchema` makes `affine:embed-<name>` with `xywh`, `index`, `rotate`. |
| | | `affine/blocks/embed/src/common/to-edgeless-embed-block.ts`; `affine/blocks/embed/src/common/embed-block-element.ts:45-50` | The canvas wrapper. Embeds keep an overlay over their iframe until selected, so a click first selects and only then reaches the content. |
| Edgeless-only editor | Yes, by construction | `affine/blocks/root/src/view.ts` | One root model, `affine:page`, rendered as `affine-page-root` or `affine-edgeless-root` depending on the scope. |
| | | `affine/ext-loader/src/view-provider.ts` | Scopes: `page`, `edgeless`, `preview-*`, `mobile-*`. |
| | | `affine/blocks/embed-doc/src/embed-synced-doc-block/embed-synced-doc-block.ts:200-222` | An edgeless editor is `new BlockStdScope({ store, extensions: manager.get('edgeless') }).render()` inside `.affine-edgeless-viewport`. The synced-doc block does exactly that. |
| | | `affine/shared/src/services/doc-mode-service.ts` | `DocModeProvider` defaults to `page` and `getEditorMode()` returns `null`; a host overrides it with `DocModeExtension`. |
| | | | The edgeless root needs an `affine:surface` child (`edgeless-root-block.ts` `surfaceBlockModel`). No editor preset element is vendored; the mount is ours. |
| Toolbar and widgets | Yes | `affine/widgets/edgeless-toolbar`; quick and senior tools under `affine/gfx/*/src/toolbar`, `affine/blocks/frame/src/edgeless-toolbar` | Quick tools: default, frame, connector, link. Senior tools: note, pen, shape, mindmap, template. Zoom toolbar plus a mobile zoom ruler, selected-rect, dragging area, note slicer, frame title, viewport overlay, remote selection. |
| Rendering and cost | | `affine/blocks/root/src/edgeless/edgeless-root-block.ts` (`renderBlock`) | `gfx-viewport` renders only the blocks in view (with overscan, at most 6 at a time). |
| | | `affine/shared/src/services/feature-flag-service.ts:46-47` | Surface elements use the canvas renderer. The DOM renderer and turbo (bitmap) renderer flags are off by default. |
| Edgeless keys | Yes | `affine/blocks/root/src/edgeless/edgeless-keyboard.ts` | V, T, C, H, N, P, Shift+P, E, K (slicer), F (frame), Esc (clears, `:326`), Enter (`:364`), Tab (mindmap), Mod+G, arrows. Double-click on empty canvas adds text (`affine/gfx/text/src/dblclick-add-edgeless-text.ts`). Read-only double-click zooms (`affine/blocks/surface/src/tool/default-tool.ts:227-241`). Groups: `affine/gfx/group/src/interaction-ext.ts`, `framework/std/src/gfx/selection.ts:358-370`. |

### 8.2 What our app has today

- **Mount:** `src/features/notes/blocksuite/BlockSuiteNote.tsx` lazy-loads
  `src/features/blocksuite/pageEditor.ts`, whose `mountNoteEditor` uses page scope only.
  `pageExtensions()` reads `viewManager.get('page')` and renders into `.affine-page-viewport`
  (`pageEditor.ts:64-111`).
  - Dev flag `VITE_DOCUMENT_LAYOUT=blocks`: `src/features/notes/blocksuite/flag.ts`,
    `src/features/notes/NoteEditor.tsx:176`.
  - Spike page `/dev/blocksuite`: `src/routes/DevBlockSuite.tsx`, `src/router.ts:154-161`.
- **Bundled, not wired:** `pageEditor.ts:57` builds its manager from `getInternalViewExtensions()`
  (`vendor/blocksuite/affine/all/src/extensions/view.ts`).
  - That list imports every gfx package, the edgeless widgets, and the frame-panel and outline
    fragments, so the canvas code ships in that lazy chunk (D4).
  - Each provider not turned off runs its `effect()` once. This defines custom elements, among
    them `affine-edgeless-root` (`affine/blocks/root/src/effects.ts:16`).
  - No edgeless scope is ever requested.
- **Turned off:**
  - The `OFF` set (`pageEditor.ts:34-52`) drops the Surface, Frame, EdgelessText, SurfaceRef,
    Embed, EmbedDoc, Attachment, Bookmark, DataView, Database, LinkedDoc and RemoteSelection
    views.
  - `REFUSED` (`src/features/blocksuite/roomStore.ts:41-52`) drops the same blocks' schemas,
    Surface and Frame included.
- **Server:** `collaboration-rs/crates/blocks/src/schema.rs` knows page, note, paragraph, list,
  code, divider, callout, latex, image, table and the `capy:*` flavours.
  - There is no surface, frame, edgeless-text or surface element.
  - Notes are seeded with `displayMode: "doc"` (`:320`), which the canvas would not draw.
  - The layout spec says the same: root → note, `displayMode "doc"`, no `affine:surface` in step 1
    (`todo-blocksuite-layout.md:75-84`).
- **Capy blocks:** in `src/features/blocksuite/capyBlocks.ts`, `capy:material-ref` may sit only
  under `affine:note` (`:36`).
  - `src/features/blocksuite/capyViews.ts` (`MaterialRefBlock`, `ISLAND_EVENTS` at `:38`) stops
    pointerdown, click, dblclick and key events at the island.
  - On a canvas that would swallow the canvas's own select and drag.
- **Already pointing at the canvas:**
  - D21, extended 2026-11-01: pixel widths for blocks that may be dragged onto the canvas
    (`todo-blocksuite-spike.md:862-877`).
  - The spike's note that dragging writes `xywh` on every step, so write on drop or throttle
    (`todo-blocksuite-spike.md:199-200`).
  - D4: canvas packages vendored in a lazy chunk (`todo-blocksuite-spike.md:84-86`, `:735`).

### 8.3 What an always-edgeless canvas would take

1. **Room and server.** This is the biggest piece.
   - Accept `affine:surface` and `affine:frame` (and `affine:edgeless-text` if canvas text is
     wanted). In the browser, take them out of `REFUSED`.
   - In the Rust blocks crate, add the surface block with its boxed `elements` `Y.Map`, and every
     element type kept (shape, connector, group, mindmap, text, brush), each with:
     - its props;
     - structural checks;
     - limits (element count, `xywh` bounds);
     - its seed (root + surface + notes with `displayMode: "edgeless"`).
   - Agent tools need to read and write these too.
2. **Mount.**
   - Add a canvas mount beside `mountNoteEditor` with `viewManager.get('edgeless')` and an
     `.affine-edgeless-viewport` container, in its own lazy chunk.
   - Revise `OFF`: keep Surface, Frame and EdgelessText.
   - Register `DocModeExtension` with a provider that always answers `edgeless` and ignores
     `setEditorMode`.
3. **No page mode.**
   - Override the note toolbar to drop "Display in Page" and the display-mode menu.
   - Create notes as `edgeless`.
   - Turn off the auto-connect order numbers, unless a reading order is kept on purpose.
   - The outline panel's page-order logic has nothing to do here.
4. **Capy cards on the canvas** (quiz, flashcards, note reference, file, mindmap):
   - Write one gfx flavour per kind, or one ref flavour with `GfxCompatible` props plus
     `materialId`/`refKind`.
   - Placement options:
     - `parent: ['@root']` like notes, with no vendor change;
     - under the surface, which needs a local change to `surface-model.ts:24-31`;
     - an `affine:embed-capy-*` name.
   - Its view comes from `toGfxBlockComponent`, hosting the React island.
   - Its `GfxViewInteractionExtension` makes the first click select. The island takes events only
     after the card is selected or entered, like BlockSuite's iframe overlay (and Excalidraw's
     "Click to interact").
   - Embed rooms already join only near the screen; `gfx-viewport`'s culling fits that.
5. **Open and peek.**
   - Implement `PeekViewService` (a React modal) and register `PeekViewExtension`.
   - Either mark the cards `@Peekable` (double-click and shift-click) or call peek from the
     card's own double-click handler.
6. **Canvas tab.**
   - `FramePanel` (frames with live previews) works as is. Each preview is a full read-only
     editor, which costs a lot with many frames.
   - The outline is page-shaped.
   - A React list read from the store fits the Canvas tab better: frames with their
     `childElementIds`, then loose notes and cards.
7. **Presentation.** It comes with `FrameViewExtension` in edgeless scope: frames as slides,
   arrows, fullscreen.
8. **Phones.**
   - `mobile-edgeless` exists but changes little.
   - AFFiNE itself ships phones read-only by default.
   - Plan a read-only canvas plus the Canvas tab list, opening items in their existing
     full-screen editors and study views.
9. **Write rate and presence.**
   - Drag writes, and the note mask's auto-height writes (each client measures with its own
     fonts and zoom, so two clients might each write a slightly different height). This is
     inferred from code and not measured; it needs a bench.
   - Canvas cursors: `RemoteSelectionViewExtension` is off today in favour of room presence, so
     the canvas needs model-coordinate cursors from presence.

---

## 9. Options for Capy

### 9.1 Where note content lives

| Option | Precedent | For | Against |
|---|---|---|---|
| **A. The canvas owns its notes:** one canvas room holding root, surface, notes, frames, connectors, mindmap elements and refs to quiz/flashcard rows. | AFFiNE (a doc is page and canvas); boards owning their content in Miro, FigJam, Freeform, Milanote. | One editor; native in-place editing; connectors and frames between notes; one undo stack; the shortest BlockSuite path. | All of a workspace's notes go into one room. That affects its size limits and open time, agent edits, indexing, citations, share pages, clone and trash, which are all keyed per material today. Per-note sharing goes. Every collaborator is in one hot room. |
| **B. The canvas references materials:** the canvas room holds positions, card refs, frames, connectors and short canvas text; notes stay materials with their rooms. | Heptabase (cards in a library, whiteboards "do not own cards"); Obsidian (canvas → vault notes); Scrintal Library; AFFiNE linked and synced doc cards. | The per-material model stays (rooms, limits, sharing, indexing, Study). One note can sit on several canvases. The canvas room stays small. Phones can list cards and open today's editors. | Editing a note *on* the canvas means mounting its editor in the card (AFFiNE's synced-doc nests an editor per card, which is heavy) or opening peek or focus. Previews are needed (Capy already has `preview` JSON). Connectors attach to cards, not to blocks inside notes. |
| **C. Hybrid:** short canvas text (stickies or small notes) lives in the canvas room; long notes, quizzes, flashcards, mindmaps and files are referenced. A "Make it a note" action promotes canvas text. | AFFiNE "Turn into linked doc"; Milanote "Convert to Document"; Miro stickies + Docs; Scrintal blocks + docs. | Matches what nearly every app does for long text. Quick thinking in place, writing in a document view. | Two kinds of text object to explain, a promotion flow, and two editing surfaces. |

### 9.2 How many canvases

| Option | Precedent | For / against |
|---|---|---|
| One canvas per workspace, frames as chapters (Epo's direction). | Kosmik Universe (which later added a feed, then closed). | The simplest navigation. But it grows without bound, both for speed and for finding things; the Canvas tab carries all navigation. |
| One root canvas with nested canvases. | Milanote Home, Muse/Allume, Heptabase nesting, the Scrintal Desk. | Keeps "Canvas" as one tab while bounding each canvas; breadcrumbs needed. |
| Several canvases per workspace. | Figma/FigJam/tldraw pages, Heptabase whiteboards, Obsidian canvases, Freeform boards. | The common pattern; needs a canvas switcher in the tab. |

### 9.3 Select vs edit

| Option | Precedent | Fit |
|---|---|---|
| Click selects; double-click (or click on the selected) edits in place; Esc exits. | BlockSuite default, Obsidian, Excalidraw, tldraw. | Good for short text. For long notes it means writing in a 498 px card at canvas zoom. |
| Click selects; Enter edits in place; Space peeks; a modifier opens a popup, side panel or full page. | Heptabase. | A full ladder of views; needs keyboard learning. |
| Double-click opens the block's editor (focus, peek or full page). | Scrintal Doc Window, Milanote Documents, AFFiNE linked docs → center peek, Miro Docs Focus mode. | Good for long notes and quizzes. Short text then needs a second step. |
| A user setting for double-click. | **None found.** The nearest is AFFiNE's `openDocMode`, which is about where a doc opens. | Unprecedented. It would be a mode users must remember; better replaced by per-type defaults plus a modifier and an "Open" toolbar button. |

Quizzes and flashcards on the canvas behave like interactive embeds:
- BlockSuite keeps an overlay until the card is selected, and Excalidraw shows "Click to interact".
- tldraw needs a double-click into an embed; Loop components are edited by clicking the part to
  change.

So a quiz card selects on the first click and its own buttons work once it is selected.
"Study" or "Edit" opens the full view.

BlockSuite's Esc clears the selection entirely. Heptabase's two-step Esc (back to selection,
then deselect) is the friendlier precedent if Capy wants it.

### 9.4 Canvas tab

| Option | Precedent | Fit |
|---|---|---|
| Chapters: frames with their elements under them, then loose items. Click selects and zooms; dragging a frame sets presentation order. | AFFiNE frame panel and outline, Miro frames panel, Heptabase table of contents, Freeform scenes. | The usual whiteboard pattern. Add search, since Miro users complain about frames-only navigation [forum]. |
| Every element as a tree. | Figma Layers. | A design-tool pattern; noisy for study material. |
| A library of everything with an "on this canvas" filter. | Heptabase Card Library. | Overlaps with Files. |

Thumbnails: AFFiNE renders a live preview editor per frame. Static previews would be cheaper.
On phones, the Canvas tab list can be the canvas.

### 9.5 Phones (360 px)

| Option | Precedent | Fit |
|---|---|---|
| Read-only canvas (pan and zoom) plus the Canvas tab list, opening items in today's full-screen editors and study views. | AFFiNE (edgeless read-only by default), Miro (view-only by default), Figma (no editing). | The lowest risk. |
| An editable phone canvas. | Heptabase, Obsidian, Milanote, Freeform. | More work, and the BlockSuite edgeless toolbar is not built for 360 px. |

---

## 10. What argues against Epo's direction

1. **A single canvas as the workspace root has no direct precedent.** All 14 apps allow several
   canvases or nest boards. Kosmik came closest; it added a feed because the canvas "lacked a
   home" and closed in May 2026. I found nothing saying the canvas caused the closure.
2. **"Always edgeless, no document mode" goes against every app that hosts long writing.**
   AFFiNE, the app being copied, keeps Page Mode in every doc. The canvas-only apps added a
   document surface:
   - Milanote: Documents;
   - Miro: Docs with Focus mode;
   - Scrintal: Doc Window and focus mode;
   - Heptabase: card tabs.

   The direction holds only if double-click (or an Open action) leads to a document-style editor.
   That means removing the *mode switch*, not the *document view*.
3. **No app has a double-click setting.** It would be new and is not backed by any precedent.
4. **Phones get worse.** The large canvas vendors fall back to view-only on phones (AFFiNE,
   Miro, Figma), and Microsoft retired its mobile Whiteboard apps on 2026-10-16. Capy notes edit
   on phones today. A canvas-first workspace needs a phone list or document fallback, or phone
   users lose note editing.
5. **"The Canvas tab shows the elements" should not mean every element.** Whiteboards list
   frames or sections. Even so, Miro users complain that frames-only navigation is limiting and
   ask for more (outline, search).
6. **Capy-internal, not from other apps.** "The canvas replaces notes" decides whether note
   content moves into one canvas room (§9.1 A). If it does, every per-note path changes:
   - rooms and limits;
   - share pages;
   - clone and trash;
   - indexing and citations;
   - agent edits;
   - embed seats (up to 64 embed rooms per note seat).

   Heptabase's model (B or C) keeps the note as an object and replaces only the notes *list* with
   the canvas.

---

## 11. Questions for Epo

1. One canvas per workspace, or one root canvas with nested canvases or pages? ("Current
   canvas" suggests more than one.)
2. Does a note live inside the canvas room (A), or does the canvas reference notes (B/C)? Can one
   note appear on two canvases?
3. Is there a document-style view for long notes (peek, focus or full page)? Double-click opens
   it, Enter edits in place?
4. Quizzes and flashcards on the canvas: interactive once selected, or only through "Study"?
5. Phones: a read-only canvas plus the list, or an editable canvas?
6. Is presentation mode (frames as slides, arrow keys) wanted as chapter-by-chapter study?
7. Does the Canvas tab list chapters (frames) with their items, or every element? With search?

---

## 12. Sources

### AFFiNE
- Docs:
  - https://docs.affine.pro/core-concepts/elements-of-affine/page-mode
  - https://docs.affine.pro/core-concepts/elements-of-affine/frames-and-groups
  - https://docs.affine.pro/core-concepts/elements-of-affine/workspaces
  - https://docs.affine.pro/core-concepts/elements-of-affine
- Source at the vendored commit, all under
  `https://raw.githubusercontent.com/toeverything/AFFiNE/5f1925499760f6954c1e656711d9fb6ed3168179/packages/frontend/`:
  - Settings (`newDocDefaultMode`, `openDocMode`, `edgelessDefaultTheme`):
    `core/src/modules/editor-setting/schema.ts`
  - Mobile read-only edgeless: `core/src/mobile/pages/workspace/detail/mobile-detail-page.tsx`
  - `enable_mobile_edgeless_editing` defaults: `core/src/modules/feature-flag/constant.ts`
  - The peek modal is app code: `core/src/modules/peek-view/index.ts`,
    `core/src/modules/peek-view/entities/peek-view.ts`
  - ⌥S switch, V/T/N tools, ⌥1/⌥2: `core/src/components/hooks/affine/use-shortcuts.ts`
  - Right-sidebar tabs: `core/src/desktop/pages/workspace/detail-page/detail-page.tsx`,
    `core/src/desktop/pages/workspace/detail-page/tabs/frame.tsx`
  - "Open in center peek", "Start presentation", "Enable Edgeless Editing":
    `i18n/src/resources/en.json`
- Vendored BlockSuite: paths in §8.

### Figma, FigJam
- https://help.figma.com/hc/en-us/articles/360040449873 (Layers, selection, keys)
- https://help.figma.com/hc/en-us/articles/9771500257687 (sections)
- https://developers.figma.com/docs/plugins/api/properties/nodes-children/ (z-order)
- https://www.figma.com/blog/about-figmas-new-starter-plan/ (3 pages, snippet)
- https://www.figma.com/blog/introducing-figma-slides/ (Slides, 2024-06-26)
- https://forum.figma.com/suggest-a-feature-11/quick-figma-slides-review-19502 (forum)
- https://help.figma.com/hc/en-us/articles/1500007537281 (mobile app)
- https://help.figma.com/hc/en-us/articles/24005082123159 (FigJam pages)
- https://forum.figma.com/suggest-a-feature-11/launched-during-config-2024-pages-for-figjam-files-27937 (forum)
- https://help.figma.com/hc/en-us/articles/1500004362321 (FigJam guide: sections, no layers
  panel, Spotlight)

### Miro
- Help centre (snippets):
  - https://help.miro.com/hc/articles/21040490154898 (Spaces)
  - https://help.miro.com/hc/en-us/articles/20164660410898 (Docs, Focus mode, 80k cap)
  - https://help.miro.com/hc/articles/360018261813 (frames panel, presentation order)
  - https://help.miro.com/hc/articles/20258488000786 (Layers)
  - https://help.miro.com/hc/articles/360017731033 (shortcuts)
  - https://help.miro.com/hc/articles/360021113559 (mobile)
- Official community:
  - https://community.miro.com/product-news-31/creating-presentations-in-miro-is-now-even-easier-10080
    (Magic Organize, 2022)
- Forum:
  - https://community.miro.com/ideas/layers-93
  - https://community.miro.com/ideas/a-layers-panel-like-figma-s-23815
  - https://community.miro.com/ask-the-community-45/would-a-universal-board-navigation-panel-be-useful-27865
  - https://community.miro.com/ask-the-community-45/how-to-using-outline-to-navigate-quickly-to-specific-sections-6432
  - https://community.miro.com/ask-the-community-45/order-of-frames-in-presentation-mode-4167
  - https://community.miro.com/ask-the-community-45/did-frames-sidebar-navigation-just-change-8098
  - https://community.miro.com/ask-the-community-45/jumping-to-specific-frame-in-presentation-mode-with-keyboard-input-only-10828
  - https://community.miro.com/ask-the-community-45/arrow-keys-in-presentation-mode-now-shift-the-frame-not-advance-the-show-breaks-a-few-of-our-remotes-12272
  - https://community.miro.com/ask-the-community-45/is-it-possible-to-organize-spaces-within-other-parent-spaces-20247

### tldraw
- https://tldraw.dev/blog/whats-new-2025
- https://tldraw.dev/blog/release-notes-20230310 (snippet)
- https://tldraw.dev/llms-examples.txt
- https://tldraw.dev/blog/building-with-tldraw-offline
- https://tldraw.dev/examples/layer-panel
- https://tldraw.dev/examples/slides (snippet)
- https://raw.githubusercontent.com/tldraw/tldraw/main/packages/tldraw/src/lib/tools/SelectTool/childStates/Idle.ts
- https://raw.githubusercontent.com/tldraw/tldraw/main/packages/tldraw/src/lib/ui/constants.ts

### Excalidraw
- Official:
  - https://plus.excalidraw.com/use-cases/presentations
  - https://plus.excalidraw.com/blog/excalidraw-in-2024
- Snippets:
  - https://plus.excalidraw.com/plus
  - https://plus.excalidraw.com/docs/api
  - https://plus.excalidraw.com/changelog/2
  - https://plus.excalidraw.com/roadmap
- Source:
  - https://raw.githubusercontent.com/excalidraw/excalidraw/master/packages/excalidraw/locales/en.json
  - https://raw.githubusercontent.com/excalidraw/excalidraw/master/packages/excalidraw/components/HelpDialog.tsx

### Microsoft Whiteboard and Loop
- https://support.microsoft.com/en-us/whiteboard/retirement-standalone-microsoft-whiteboard-apps
  (retirement 2026-10-16)
- https://support.microsoft.com/en-us/loop/loop-components-in-whiteboard
- https://support.microsoft.com/en-US/whiteboard/whiteboard-keyboard-shortcuts (snippet)
- https://support.microsoft.com/en-us/whiteboard/guide-participants-through-a-whiteboard-with-follow
  (snippet)
- https://www.neowin.net/amp/microsoft-delays-whiteboard-migration-and-retirement-deadlines/ (3p)

### Apple Freeform
- https://support.apple.com/guide/freeform/organize-your-freeform-boards-in-folders-frfm9474646org/5.0/mac/27
- https://support.apple.com/guide/freeform/frfm7cc55b64/mac (scenes)
- https://support.apple.com/guide/freeform/add-text-frfm8d145c1b/5.0/mac/27
- https://support.apple.com/guide/freeform/keyboard-shortcuts-and-gestures-frfm46c25187e/5.0/mac/27
- https://support.apple.com/en-gw/guide/iphone/iphe7f70fba4/ios
- https://9to5mac.com/2024/07/11/ipados-18-adds-one-new-feature-to-freeform-worth-trying-video/ (3p)

### Heptabase
- https://wiki.heptabase.com/fundamental-elements
- https://wiki.heptabase.com/user-interface-logic
- https://wiki.heptabase.com/keyboard-shortcuts
- https://wiki.heptabase.com/roadmap
- https://wiki.heptabase.com/changelog
- https://support.heptabase.com/en/articles/10441619
- https://support.heptabase.com/en/articles/10447264
- https://support.heptabase.com/en/articles/15410871

### Obsidian
- https://obsidian.md/help/plugins/canvas
- https://jsoncanvas.org/spec/1.0/
- https://obsidian.md/blog/json-canvas/
- https://github.com/Developer-Mike/obsidian-advanced-canvas (community plugin)

### Kosmik
- https://www.kosmik.app/ (sunset 2026-05-31)
- https://kosmikapp.substack.com/p/hello-again (Kosmik 3, 2024-10-18)
- https://kosmikapp.substack.com/p/fighting-the-empty-board-syndrome (feed)
- https://www.kosmik.app/faq/organize-your-universe-with-frames
- https://www.kosmik.app/faq/present-with-kosmik-navigation-mode
- https://www.kosmik.app/tutorials
- https://www.macstories.net/?p=70619 (3p)
- https://tech.slashdot.org/story/23/12/22/2139201 (3p)

### Muse / Allume
- https://allume.com/
- https://allume.com/updates
- https://allume.com/memos/2026-07-allume-v4/

### Milanote
- https://help.milanote.com/en/articles/9860073-nesting-boards
- https://help.milanote.com/en/articles/10458661-documents
- https://help.milanote.com/en/articles/1116205-search
- https://help.milanote.com/en/articles/111393-keyboard-shortcuts
- https://help.milanote.com/en/articles/6815489-presentation-mode
- https://help.milanote.com/en/articles/2966365-milanote-iphone-android-apps

### Scrintal
- https://scrintal.com/
- https://scrintal.gitbook.io/scrintal-support-docs/scrintal-concepts.md
- https://scrintal.gitbook.io/scrintal-support-docs/working-with-boards-and-the-desk.md
- https://scrintal.gitbook.io/scrintal-support-docs/working-with-docs.md
- https://scrintal.gitbook.io/scrintal-support-docs/keyboard-shortcuts.md
- https://scrintal.gitbook.io/scrintal-support-docs/what-is-gobu.md
