# Canvas workspace plan

Status 2026-11-01: round 1. Nothing is decided yet.

**On hold (Epo, 2026-11-02):** canvas mode waits. Study and member performance tracking come first, in their own plan.

**Decided (Epo, 2026-11-02): S2, the icon rail plus a panel, with a label under each rail icon.** It is used for the workspace shell in `todo-study-tracking.md`.
- **Mocks:** the Design canvas at https://claude.ai/artifact/WnCKWfk4ooL5h2L7YsuT17. Artboard names (S1, E2, …) are used below.
- **Research:** one report per area in `todo-canvas-workspace/`, each claim with a URL or a file path:
  - `A-canvas.md`
  - `B-localfirst.md`
  - `C-files.md`
  - `D-presence.md`
  - `E-study.md`
  - `F-impact.md` (what the rework touches in Capy)
- **Builds on:** the BlockSuite work on branch `blocksuite-notes` (`todo-blocksuite-spike.md`).

Every suggestion below first says how other apps do it, as Epo asked.

## Epo's direction (2026-11-01, condensed)

1. **The canvas replaces notes.**
   - The canvas is a property of the workspace, not a file kind. The workspace side nav becomes Canvas, Files, Study and Agent.
   - The Canvas tab lists what is on the current canvas.
   - It is always edgeless: no switch between document and edgeless.
   - A click selects a block: a note, or a quiz taken out of the note embed, flashcards, a mindmap, and so on.
   - A double-click opens the block's editor, like the document editor, or perhaps goes straight into its text.
   - Epo noticed that AFFiNE has no connecting loader when you go into the canvas.
2. **Collaboration and presence.**
   - Carets, block selections and cursor positions glitch or disappear after a while.
   - Epo wants an activity area showing who is doing what: editing, selecting, presenting, in a quiz, uploading, generating.
3. **Files on the canvas.** A file card that only links to the file is not very useful. Epo wants a light, view-only render of part of a file, such as a PowerPoint's first slide. The whole canvas stays one editor and one room.
4. **Study.**
   - Drop read progress.
   - A study plan becomes a rich task list, for example "read @chapter1.pdf", where @ lists the files.
   - Tasks point at real files and at real quiz blocks.
   - Study is plan tasks plus review sessions.

## The suggestions at a glance

| # | Suggestion | Main precedent | Decision for Epo |
|---|---|---|---|
| 1.1 | One canvas per workspace. Frames are chapters. The data allows more pages later. | Kosmik (closest; it later added a feed); home boards in Milanote, Scrintal and Muse | One canvas, or pages? |
| 1.2 | Side nav S1: today's left panel, with Canvas, Files, Study and Agent views | AFFiNE sidebar, Figma UI3 left panel | S1, S2 or S3 |
| 1.3 | Canvas tab L1: chapters (frames) with their items, plus search | AFFiNE frame panel, Miro frames, Heptabase table of contents | L1, L2 or L3 |
| 1.4 | Click selects. Double-click edits text in place. Open (button or Space) shows a focus view. No setting. | BlockSuite, Obsidian, tldraw; Heptabase's view ladder | E1–E3 |
| 1.5 | No mode switch, but a focus view for long notes | AFFiNE page mode, Miro Docs focus, Milanote Documents | Agree? |
| 1.6 | Chapters become frames. Files groups files by the frame they sit in. | AFFiNE frames, Miro frames, Freeform scenes | K1, K2 or K3 |
| 1.8 | One editor and one connection over several documents: a small canvas doc, with each note, quiz and set still its own document | AFFiNE (many docs over one socket), Heptabase, Obsidian | What "one room" means |
| 1.9 | Open from a copy on the device, connect in the background | AFFiNE, Linear, Notion, Excalidraw | Note bodies on the device? |
| 1.10 | Phones: canvas read-only, Canvas list, items open in today's full-screen editors | AFFiNE, Miro, Figma | M1 + M2 |
| 2.1 | Fix presence first: background tabs, reconnects, BlockSuite notes | — (bugs) | Owner |
| 2.2 | Presence (active, idle or away) plus activity (verb, item, progress), live only, members only | tldraw, Excalidraw, Discord, Slack | P1, P2, P3 and privacy |
| 3 | Files: a preview card and a side panel now, a page picker next, no live Office | Every app compared, AFFiNE, Miro, Heptabase | F1–F3 |
| 4 | Study: tasks as records with done rules and a tick per person, plus a Review row and a Today list | Canvas LMS, Moodle, Classroom, RemNote | T1–T4 |

---

## 1. The workspace canvas

### 1.1 One canvas as the root of the workspace

**How others do it** (A-canvas §2):

| App | Canvas vs project |
|---|---|
| AFFiNE | A workspace holds many docs, and each doc is both a page and a canvas. |
| Figma, FigJam, tldraw | Files hold pages, and each page is a canvas. |
| Miro | One canvas per board, many boards in a Space. |
| Heptabase | Many whiteboards over one card library. Whiteboards "do not own cards". |
| Obsidian | `.canvas` files point at notes in the vault. |
| Milanote, Scrintal, Muse | One home board (Home, Desk, root board) with more boards nested inside. |
| Kosmik | One infinite canvas ("Universe"). It added a non-spatial feed as its home in Nov 2024 because the canvas "lacked a home". Kosmik closed on 2026-05-31; no reason was given. |

None of the 14 apps compared uses a single canvas as the root of a project.

**Suggestion:**
- Keep Epo's model: one canvas per workspace, with frames as chapters (§1.6).
- Give it ways in that are not spatial, which is Kosmik's lesson: the Canvas tab with search (§1.3), Files as the full inventory, and Study's task list.
- Store the canvas under its own id rather than the workspace id. Pages can then come later without a migration, if one canvas grows too big to find things in (Figma and tldraw pages).

**Against:** a single canvas grows without bound, both in what loads (§1.8 handles that) and in how hard things are to find. Miro users complain that big boards are hard to navigate.

### 1.2 Side nav: Canvas, Files, Study, Agent

**How others do it:**
- **AFFiNE:** a left sidebar for docs, collections and tags. Right-sidebar tabs hold chat, outline, frames and properties.
- **Figma UI3:** a left panel with File and Assets tabs, holding the layers.
- **Heptabase:** a left sidebar with Whiteboards, Card Library, Journal and Tags, and chat in a right panel.
- **NotebookLM:** three panels: Sources, Chat and Studio.
- **Miro and FigJam:** floating toolbars and panels over a full-bleed board.
- **Capy today:** the left panel's title menu switches Chats, Files and Study (`PanelTitleMenu`). The right rail is hidden by default.

**Mocks:** all three show the Canvas view of the same canvas, so they compare fairly.
- **S1, sidebar nav:** the left panel lists the four sections, with the open section's list below them. It is the closest to today's left panel.
- **S2, icon rail plus panel:** a 52 px rail with the four icons. The panel can fold down to the rail.
- **S3, floating:** a full-bleed canvas, with a floating workspace pill and a floating panel.
- **S1 shell, other views:** S1-Files shows the Files view, dragging a file onto the canvas. S1-Agent shows the Agent view, where a citation flies the canvas to the cited note.

**Suggestion:** S1. It keeps today's left panel and its width (340 px, Agent widened to 400), and changes only its views. The Agent lives in the left panel, so a citation can move the canvas beside it. Today's right rail goes: there is no file in the centre any more, and the centre is the canvas.

### 1.3 The Canvas tab

**How others do it** (A-canvas §3):
- **Figma Layers:** every element, as a tree in stacking order.
- **Whiteboards list chapters instead:**
  - AFFiNE's frame panel: live previews; dragging sets presentation order.
  - Miro's frames panel.
  - Freeform's scenes.
  - Heptabase's table of contents of sections.
- **Card tools:** Heptabase's Card Library lists every card, with filters.
- **Complaints:** Miro users find frames-only lists limiting and ask for an outline and search (forum).

**Mock (L):**
- **L1, chapters:** each frame with its items under it, then "Not in a chapter", with search and a kind filter.
- **L2, every element:** the Figma pattern.
- **L3, library:** every item, with filters and "on the canvas" marks.

**Suggestion:** L1.
- Clicking an item selects it and moves the canvas to it. Double-clicking opens it (§1.4).
- Dragging a chapter sets the presentation order.
- Draw items from stored previews, not live editors. AFFiNE's panel mounts one read-only editor per frame, which costs too much with many frames.

### 1.4 Select, edit, open

**How others do it** (A-canvas §4):
- **Click selects everywhere.**
- **Double-click or Enter edits in place, one level deeper:** BlockSuite, Figma, tldraw, Excalidraw, Obsidian. BlockSuite's second click on a selected note puts the caret at the pointer.
- **Long documents open on double-click instead:** Milanote Documents, Scrintal's Doc Window, AFFiNE's linked docs, which open in a centre peek.
- **Heptabase's view ladder:** Enter edits, Space opens Quick Look, Cmd+click a popup, Cmd+Shift+click a full page.
- **Embeds are inert until selected:** BlockSuite's iframe overlay, Excalidraw's "Click to interact", FigJam's one live embed at a time.
- **A setting for what double-click does:** none in any of the 14 apps. AFFiNE's `openDocMode` only picks where a doc opens.

**Mock:**
- **E1:** a selected note with its toolbar: Open, colour, width, ⋮.
- **E2:** double-click edits in place.
- **E3:** Open shows the focus view.
- **E4:** quiz and flashcard cards that work once selected.

**Suggestion:** a default per kind, and no setting.

| Kind | Click | Double-click | Open (toolbar, Space) |
|---|---|---|---|
| Note, text | Select | Edit in place, caret at the pointer | Focus view (§1.5) |
| Quiz, flashcards | Select; then its buttons work | Editor in the focus view | Quiz or set view |
| File | Select | Side panel viewer (§3) | Side panel |
| Frame (chapter) | Select | Rename | Present from this frame |

Esc steps back one level (editing → selected → nothing), as Heptabase does. BlockSuite clears everything on the first Esc.

### 1.5 Always a canvas, but with a focus view

**How others do it** (A-canvas §5):
- Every app that hosts long writing keeps a document view: AFFiNE (page mode), Heptabase (card tabs), Obsidian (note files).
- Canvas-only apps added one later: Milanote Documents, Miro Docs with Focus mode (80,000-character cap), Scrintal's Doc Window.
- FigJam, tldraw, Excalidraw and Freeform keep text short.

**Suggestion:**
- Drop the mode switch, as Epo wants, but keep a focus view. Open shows one note at reading width, over the dimmed canvas (E3).
- The focus view is also what phones, printing and sharing use.
- BlockSuite already has the pieces: a note's auto height, folding at a set height, and scale.

### 1.6 Chapters

**Today:** chapters group files and materials, and drive several other features (F-impact):
- the Files tree, upload and bank copy;
- the Study sections and the Default Plan;
- the railway map;
- review suggestion groups;
- the generate scope;
- the agent's `list_sources` and `create_chapter`.

**How others do it:** frames, sections or scenes are the chapter unit on every canvas: AFFiNE frames (title, children, presentation index), Miro, Freeform scenes, Heptabase sections. Presentation plays the frames in panel order (AFFiNE, Miro, Freeform, Excalidraw+).

**Options:**
- **K1: chapters become frames.**
  - Files lists files grouped by the frame they sit in, plus a "Not on the canvas" group.
  - Review suggestions group by frame. Generate scope picks frames or files.
  - The chapters table goes.
- **K2: chapters stay as folders in Files.** Frames are canvas-only. Two kinds of grouping.
- **K3: chapter = frame = folder, kept in step.** Moving a file in the tree moves its card into the frame.

**Suggestion:** K1. The canvas becomes the one place where things are organised, and Files becomes the inventory. A file placed in two frames shows in both, since cards are references.

### 1.7 Blocks on the canvas

| Block | Where its content lives | Precedent |
|---|---|---|
| Frame (chapter), connector, shape, text, mindmap | The canvas doc. These are BlockSuite surface elements, already vendored; the native mindmap replaces the mindmap kind (as the spike planned). | AFFiNE, Miro |
| Note | Its own document, shown as a note card (§1.8) | AFFiNE linked and synced docs, Heptabase cards |
| Quiz, flashcards | Their own rows and rooms. Quiz keys must stay separate anyway. | AFFiNE embeds, Loop components |
| File | A file row. The card shows its preview (§3). | Freeform, Milanote, Heptabase |
| Image, YouTube, Mermaid, chart, plot, graph | The canvas doc. Their widths are in pixels already (D21). | AFFiNE |
| Study plan | Plan records, shown live (§4) | Loop task list |

Cards are gfx blocks under the root (`toGfxBlockComponent`). The first click selects; the card's own buttons work once it is selected. The `capy:material-ref` island blocks events today (`capyViews.ts:38`) and would swallow canvas select and drag (A-canvas §8.2).

### 1.8 One editor and one room

**What it costs** (B-localfirst §3.3, §4.7). One near-limit note room holds 13.3 MiB of heap in the blocks layout, against 7.0 on Plate (matrix). On the production box an idle one costs 29 MiB of server RSS, against 12 on Plate (`bench/collaboration/reports/2026-11-01-layout-cost.md`). The server keeps that RSS after the room unloads (glibc), so the memory figures below, which are heap, are about half of what the box holds.

| | A. One Y.Doc for the whole canvas | B. Small canvas doc plus a document per note, quiz and set, joined inside the canvas's connection |
|---|---|---|
| Who does it | AFFiNE inside one doc; Miro, FigJam and Freeform boards | AFFiNE across docs (one socket for every doc, shared by tabs); Heptabase; Obsidian; Capy's embedded quizzes today (`NoteSeat`, joined only near the screen, outside the 22-room cap) |
| Server memory per open canvas | The sum of every note: about 130 MiB for 10 near-limit notes, 650 MiB for 50 | The canvas plus the documents open now. With previews for everything else and at most 3 live: canvas + ≤39 MiB |
| First open | The whole canvas: about 5.6 s cold for 10 near-limit notes, 28 s for 50 | The canvas, then the focused card |
| Limits, quota, drafts, trash, clone, sharing, indexing, citations, agent edits, permissions | All are per material today. Each would have to move to work per block. | Kept as they are, per document |
| Undo across notes | One history | Per document; a cross-card undo needs a coordinator |
| Connectors | Between blocks inside notes | Between cards |

**Suggestion: B.**
- To the user it is one editor and one connection. The canvas doc holds layout, frames, connectors, mindmaps and short text.
- Each note stays its own document: a card shows its preview, and joins its room only while someone reads or edits it, up to a cap.
- **Already built:** `NoteSeat` joins embeds through one connection only near the screen, and the preview JSON exists.
- **New:**
  - batch tokens;
  - the canvas schema in the Rust blocks crate (surface, frames, elements, seed, limits);
  - an edgeless mount;
  - cards that edit in place by mounting the note's editor while focused, as AFFiNE's synced doc does.
- **Against:** A is the shortest BlockSuite path and gives connectors and undo across notes. But it makes a workspace's every note one room. The 2 MiB material bound then holds a single near-limit note's worth for the whole canvas, and about ten open 50-note canvases fill the production box.

### 1.9 Opening without "Connecting"

**Epo's question, answered from AFFiNE's source** (B-localfirst §1). AFFiNE always connects and joins, even when you are alone, and sends awareness that the server relays to nobody. It shows no loader because:
- each doc renders from its copy on the device (IndexedDB, or SQLite on desktop);
- one socket per server opens with the workspace and syncs in the background;
- the server keeps no document in memory.

AFFiNE waits only on a device with no local copy, and for non-admin members' first permission check.

**How others do it:** Linear, Notion, Excalidraw (solo) and Figma's open files all paint from a local copy. tldraw sync shows a connecting state.

**Capy today:**
- The BlockSuite note waits for me, then the token (one Go request), then the drafts read, the socket and JOIN, and the server's full answer, before it mounts. The client joins with an empty Y.Doc.
- Only unsaved drafts are kept on the device (`capy-edit-drafts`).

**Suggestion:**
- Keep a copy of the canvas doc and of recently opened notes on the device. Follow the Office file cache's rules: oldest out first, one account, wiped at sign-out.
- Paint from that copy, then join in the background; the server answers only the difference.
- On a device with no copy, paint the stored previews first.
- This needs Epo's sign-off: note bodies would be stored on the device. It also needs a choice: can a user edit before the token arrives (keep the last client id) or only read?

### 1.10 Phones (360 px)

**How others do it:**
- **Read-only by default:** AFFiNE (edgeless editing is behind an off flag), Miro (tap Edit to edit), Figma (no editing of design files on phones). Microsoft retired its mobile Whiteboard apps on 2026-10-16.
- **Editable:** Heptabase, Obsidian, Milanote and Freeform.

**Suggestion:**
- **M1:** a read-only canvas you can pan and zoom.
- **M2:** the Canvas list as the phone's way around. Items open in today's full-screen editors and study views, so notes stay editable on phones.
- It follows the 2026-10-15 phone decisions: the name ▾ popover, the chat button, no bottom tab bar.

---

## 2. Presence and activity

### 2.1 Fix presence first

Ranked causes (D-presence §2.2, read from code, not reproduced):
1. **Background tabs blink.**
   - Presence is renewed only by y-protocols' 3 s timer, and dropped after 30 s. Chrome runs timers once a minute in tabs hidden for 5 minutes.
   - So a co-editor in another tab shows for 30 s, vanishes for 30 s, and repeats.
   - Neither Capy nor the server refreshes or expires entries.
2. **Invisible after a reconnect.**
   - The server publishes a removal one clock higher, and the rejoined tab resends at its old clock (`room.rs:2942-2953`, `roomProvider.ts:754-758`). So peers ignore it for 30–36 s.
   - This happens after routine drops: the 60-minute idle close, a failed refresh of the 5-minute token.
3. **Pointers flicker:** any scroll anywhere, or a window blur, clears the pointer (`notePresence.ts:292-294`).
4. **The local caret snaps back:** a peer's caret re-renders slate.
5. **Colours change after a reconnect,** and outlines drift on nested scrolls.
6. **BlockSuite notes show no remote presence at all.**
   - The widget is off, and the server's field list drops every `selectionV2` state.
   - There is also a latent crash: BlockSuite throws on a state without `selectionV2`, the exception escapes the socket loop, and it drops the rest of the frame, the ACK included.

These belong to the presence work in `todo-presence.md`, which the PC sessions build. Causes 1, 2 and 6 must be fixed before an activity panel, or the panel blinks too. The BlockSuite crash is this branch's, so it should be fixed here.

### 2.2 The activity area

**How others do it** (D-presence §1):
- **Two layers.** Availability (active, idle, away) is worked out on the device: tldraw idles after 3 s and hides after 60 s; Excalidraw marks a hidden tab "away" and draws it at 30%; Slack goes away after 10 minutes. Activity is a verb plus an item: Discord "Playing", Teams "Presenting".
- **One entry per person,** however many tabs.
- **Follow** is personal and ends on your own input (tldraw, Excalidraw, Slides). **Spotlight** is a broadcast with "Not now" (Figma, Miro's "Bring everyone to me").
- **Peers see standing, the host sees answers:** Kahoot's top 5; Wayground's teacher-only panel.
- **Live presence is never stored.** History is a separate surface with opt-outs: Docs view history, Notion analytics. Study apps socialise finished work instead (Strava, Duolingo).

**Mock:**
- **P1:** a facepile with a ring for each status. Clicking a person shows what they are doing, with Go to and Follow.
- **P2:** an activity panel: "Now" rows, plus an optional "Earlier today" list of finished work.
- **P3:** on the canvas: named cursors, labelled selections, a "2 in this quiz" badge, and a presenter bar with Follow.

**Suggestion:**
- P1 always; P3 on the canvas; P2 as an option.
- Each row: who; active, idle or away; which item; doing what; since when. The "doing" can be:
  - editing or selecting n blocks;
  - presenting slide or frame k;
  - quiz k of n, never right or wrong;
  - uploading n files;
  - generating.
- **Architecture** (D-presence §3.3): presence fields in the canvas room's awareness (option A), plus gateway events for uploads, ingest and generation (option C).
  - The canvas room is open whenever someone is in the workspace, so it doubles as the workspace's presence channel.
  - Nothing is stored. The finished-work feed is opt-in and kept for a short time.
- **Privacy:** members only, never link or public visitors. A per-workspace "Share my activity" switch, with study detail coarse by default.

---

## 3. Files on the canvas

**How others do it** (C-files §1):
- **No app draws a live Office document on its board.** Office files become:
  - a card that opens elsewhere (Freeform Quick Look, Milanote, Notion, AFFiNE);
  - native objects (Miro, Canva, Figma Slides, Heptabase's DOCX-to-note);
  - page images (Miro's Extract pages, Whiteboard's page picker).
- **Live viewers exist only for PDFs and web embeds, always gated:**
  - AFFiNE draws one PDFium page at a time, in a worker, only while the card is on screen.
  - Obsidian unloads PDFs when you zoom out.
  - FigJam allows one live embed at a time.
- **The useful patterns:**
  - a page-1 preview (Heptabase, Muse, Miro);
  - picked pages placed as images that link back (Miro; Google Docs linked slides, with an Update button);
  - reading in a side panel or peek (Heptabase, Kosmik, AFFiNE).

**What Capy already has:**
- Every file row carries a 200 px WebP of page 1, slide 1, a sheet's corner or the photo. Office files are re-captured in the browser after edits.
- Text and CSV have preview text. Materials have about 1 KB of preview JSON.
- `PreviewCard` draws all of these.
- The Office runtime can draw any PPTX slide to an image (`renderSlides`).

A live Office viewer costs:
- its own iframe, which security requires;
- 0.8 to 8.4 MB of WASM;
- 3 to 8 s to open;
- and it shows the saved state, not a live one.

**Suggestion:**

| Tier | What | When |
|---|---|---|
| (b) + (a) | A file card that draws the stored preview, and falls back to the icon card. About 0.3 MB per card. | Now (F1) |
| (e) | Double-click opens the file's own viewer or editor in a side panel beside the canvas, in its own room. The cost is the same as opening the file today. | Now (F2) |
| (c) | A page and slide picker that places chosen pages as image blocks. Each links back and offers Update when the file changes. PDF and PPTX first. | Next (F3) |
| (d) | Live mini viewers | Skip Office. Maybe a PDF page flipper later, one live at a time. |

For Epo's "first slide, view-only, no toolbars": the lightest version is the image Capy already stores. A sharper capture at ingest is the next step up. A live frame draws the same pixels at far higher cost.

**Decisions:**
- Notes deliberately refuse file blocks today (PE:192). The canvas reverses that.
- Does a file dropped from the desktop upload into the workspace?
- Sharper thumbnails?
- Who pays for snapshots, and do they survive the file's trash?

---

## 4. Study: plan tasks plus review

### 4.1 What goes and what stays

E-study §3.5.
- **Goes: read progress.**
  - `study_progress`, `workspace_study`, Mark as read and Stop tracking;
  - the code that marks items done after quizzes;
  - Continue, the railway map (about 2,500 lines), Learning → Progress and the finish toasts;
  - the move-file prompt.
  - Also the dormant personal planner (`tasks`, `events`, `labels`, `/tasks`, `/schedule`), which sits behind off flags.
- **Rewire:** three review pieces read `study_progress`: which workspaces Learning → Review lists, the suggestion fade, and the "stopped tracking" filters.
- **Stays:** FSRS state and log, review sessions, suggestions, Quick review, Past reviews and attempts.

### 4.2 How tasks are stored

**How others do it** (E-study §4.1):
- **Records:** every app that completes a task by itself, or shows who finished, stores the task as a record. It has a done rule and a done state per person: Canvas LMS, Moodle, Classroom, Khan, Quizlet, Knowt, Brilliant, Linear.
- **Document to-dos** (Notion, RemNote, Heptabase) are ticked by hand, and one tick counts for everyone. Notion itself moves tasks into a database once they need an assignee or reminders.
- **Done rules:** Canvas and Moodle let the author pick one per item: viewed, marked done, submitted, or score ≥ X.
- **Review** is never turned into checklist items. RemNote shows "due reviews" as its own block for the day.
- **One Today list across courses** is the most used surface: Classroom To-do, Canvas List View, Khan's Daily Mission, Things and Todoist Today, My Day.

### 4.3 Suggestion: tasks with done rules, a Review row, and Today

This is E-study's shape 2.
- **The plan** belongs to a workspace and is private or shared. On a shared plan everyone ticks their own copy, and friends' avatars sit on the tasks they finished.
- **A task** is one line with @ chips for a file, quiz, flashcard set, note or chapter. Optionally it has a heading, a "do on" date and a rule.
  - BlockSuite's @ menu is vendored but switched off; the text field can reuse it.
- **Rules:**
  - a manual tick, always there;
  - "every question checked";
  - "score ≥ X%", read from attempts;
  - "every card rated".
  - "Opened" only suggests a tick, from `item_opens`; it never ticks by itself.
- **The Review row** is pinned at the top of the plan and of Today. It runs the existing plan review over the quizzes and sets the tasks mention, with no due counts, as today.
- **Today** lists every plan's dated and undated tasks across workspaces, on Learning. Missed tasks stay until done.
- **On the canvas,** a plan can sit as a live card (T4).
- **Data sketch:**
  - `study_plans` gains a visibility;
  - `plan_tasks` holds the text with mention ids, the position, the heading, `do_on` and the rule;
  - `plan_task_targets` links each task to its files and materials by foreign key, so a quiz check finds its tasks, and a move or delete clears the chips;
  - `task_completions` holds the task, user, `done_at` and what ticked it.

**Mock:**
- **T1:** the plan in the Study view.
- **T2:** the @ picker.
- **T3:** Today on Learning.
- **T4:** the plan card on the canvas.

**Later, needs sign-off:** an exam date that spreads tasks over study days (RemNote, Knowt, StudySmarter). It runs into "no due dates or counts" for review, and into the ROADMAP's parking of calendars and tasks.

### 4.4 Other things worth borrowing

From E-study §4.7, ordered by how well they fit friends and the school platform:
1. **Ticks per person on a shared plan,** with friends' avatars (Classroom, Canvas).
2. **Shared goals instead of leaderboards:** Duolingo's Friends Quests and Friend Streaks. Duolingo reports learners with a Friend Streak are 22% more likely to do the daily lesson.
3. **Publish a plan to members** with a grid of who finished (Classroom, Canvas View Progress). A workspace then works as a class.
4. **Branching on a score:** "under 60% on @Quiz 2 adds Re-read @Chapter 2" (Canvas Mastery Paths, Khan). This targets what a student struggles with, the gap AGENTS.md names.
5. **Make a plan from @syllabus.pdf,** with a preview first (Todoist Task Capture, MyStudyLife).
6. **A morning pick instead of auto-scheduling** (My Day, Sunsama).
7. **Forgiving streaks,** if streaks come at all (Todoist vacation, Brilliant streak charges).
8. **Later:** message those who haven't finished, with an AI draft (Canvas, Classroom); a copy of a worksheet for each student (Classroom); live class games on Capy quizzes (Quizlet Live, Knowt Play).

---

## 5. What changes across the app

From F-impact. Effort runs S/M/L/XL, smallest to largest.

| Area | Under the plan |
|---|---|
| Workspace shell (`WorkspaceOpen.tsx`, `CenterContent.tsx`, `openItem.ts`) | Change (L). The centre is the canvas; `OpenItem` gains a canvas target. |
| Files panel and Files page | Change (M). Notes leave the lists. Files groups by frame (K1). |
| Create tab | Change (S). Note goes; new things are placed on the canvas. |
| Chapters (table, tree, Study, review groups, generate scope, agent tools, starter) | Change or delete (L) |
| Note kind, Plate (about 24.7k lines + Rust notes crate about 12.8k) | Plate goes at the cut. BlockSuite needs an edgeless root (XL). |
| Embedded quizzes and sets in notes (`material_ref`, `parent_material_id`) | Delete. Canvas cards replace them. |
| Agent tools (`create_material`, `edit_document`, decks, `list_sources`) | Change (XL). Targets become a note card or a canvas placement; a quiz is a row plus a card. |
| RAG and citations | Keep per note under §1.8 B. A citation moves the canvas to the card, then flashes. |
| Share pages, export, clone | Keep per note under B. Clone copies the canvas doc, re-keyed. |
| Quota, permissions, drafts, trash | Kept per document under B. Under A each would have to work per block. |
| Read progress, railway map, Learning → Progress | Delete (§4.1) |
| Plans | Replace with tasks (§4.3) |
| Starter workspace, welcome tour | Change (M) |
| Standalone notes (no workspace), account chat notes | Open question: delete them, or give each account a personal canvas? |

---

## 6. Order of work (proposal)

1. **Decisions:** §7.
2. **Presence fixes**, separate from the rest:
   - causes 1, 2 and 6, in the PC sessions' presence work;
   - the BlockSuite crash, here.
3. **Canvas foundation:**
   - the canvas schema in the Rust blocks crate: surface, frames, elements, seed with edgeless notes, limits, position written on drop;
   - the edgeless mount, with the mode always edgeless;
   - the canvas room per workspace;
   - cards (note, quiz, set, file) with select-then-interact;
   - the focus view and the side panel;
   - the Canvas tab (L1);
   - phones (M1 + M2).
4. **Notes move onto the canvas:**
   - note cards that edit in place;
   - batch tokens;
   - agent tools retargeted;
   - citations moving the canvas;
   - chapters become frames;
   - Files changes.
   This lines up with the Plate cut in `todo-blocksuite-spike.md`.
5. **Study:**
   - tasks, rules, the Review row, Today and the plan card;
   - delete read progress.
6. **Activity:** P1, P3 and optionally P2; follow and present.
7. **The device copy and open without a loader;** the page picker.

Steps 2, 3 and 5 can run side by side.

## 7. Questions for Epo

**Canvas**
1. One canvas per workspace, or pages or nested canvases? ("The current canvas" suggests more than one.)
2. What does "one room" mean:
   - one editor and connection for the user, which suggests B;
   - or one Y.Doc in storage, which is A?
   Can one note sit on two canvases?
3. Side nav S1, S2 or S3? Canvas tab L1, L2 or L3?
4. Double-click edits text in place, and Open shows the focus view (E1–E3)? Or should double-click open the focus view?
5. Quiz and flashcard cards: answerable on the canvas once selected (E4), or only through Study?
6. Chapters: K1 (frames), K2 (folders) or K3 (both, kept in step)?
7. Phones: read-only canvas plus the list (M1 + M2)?
8. Is presentation mode (frames as slides) wanted for studying chapter by chapter?
9. Standalone notes and account-chat notes: delete them, or give each account a personal canvas?

**Offline**

10. May note bodies be stored on the device, wiped at sign-out? Which of these goes offline: what is open, recent and pinned items, or the whole workspace?
11. Before the token arrives, may the user edit, or only read?

**Presence**

12. Who sees activity (members only)? Is sharing opt-in or opt-out, per workspace? How much study detail: "in a quiz", "7 of 20", or nothing?
13. Live only, or also a short feed of finished work?
14. Follow model: a personal follow, or a presenter spotlight with "Not now"? Does the followed person see who follows them?

**Files**

15. Does a file dropped from the desktop upload into the workspace? Sharper thumbnails? Who pays for snapshots?

**Study**

16. Plans private, shared, or both? Ticks per person?
17. Which done rules? Is there a default pass mark? (AGENTS.md: no defaults without sign-off.)
18. Do tasks get "do on" dates? Exam dates later? Does "no due dates or counts" for review stay?
19. Today on Learning, on the Dashboard, or both?
20. Hide study progress: keep it as "Hide study", or remove it? Is the railway map reused as a plan view or deleted?
21. May the chat agent create or edit tasks?
