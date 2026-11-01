# F: impact map (Explore agent, 2026-11-01), verbatim summary

Branch state: BlockSuite notes are page-mode only behind VITE_DOCUMENT_LAYOUT / COLLABORATION_DOCUMENT_LAYOUT; blocks crate projects to Plate JSON (value()); canvas packages vendored but never loaded.

Routes/shell: WorkspaceOpen.tsx left panel Chats/Files (+Study menu item), right rail Files/Chat stays mounted for chat streams; centre CenterContent.tsx driven by OpenItem (openItem.ts) needs a canvas target (note block id). Open: Agent page vs panel beside canvas (citations need both on screen).
FilesPanel.tsx mixes files+materials per chapter; routes/Files.tsx has Blocks tab (notes) + Embeds tab named by note. CreateFilePanel.tsx drop Note. Recent: item_opens (0120), recentMaterialKinds in huma_opens.go include notes; workspace landing recent grid gives way to canvas.
Standalone notes (MaterialOpen.tsx) have no canvas; account chat creates notes in No workspace -> delete or personal canvas?
Move files (store/file_move.go) must clear canvas cards + plan mentions. Notifications keep. Cmd+K Store.Search never searched notes.

Chapters: chapters table, files/materials.chapter_id, mixed position order, review_sessions group kinds chapter/others, scope_chapters (0001, 0071); tree DnD, upload/bank-copy chapter-by-name (upload_chapters.go), generate scope (GenerateSources.tsx); Study sections, Default Plan (chapter order), railway map (study/railMap/map.ts), suggested-review groups (review_sessions.go), Learning map; agent list_sources by chapter, chapter_id args, create_chapter (agent_chapter.go); anonymous summary outline; starter "Getting started" chapter. Open: folders in Files, frames on canvas, or gone; reviews need another grouping unit.

Kinds: note, mindmap, diagram (Plate Yjs rooms, Model::Note; mindmap/diagram = one Mermaid block), quiz (two item rooms: content + keys), flashcards (one). One material_yjs_documents row per material via materials.content (model.rs). Relational: attempts, review state, editor assets, comments. Files = rows + bucket, source rooms for Office/text.
ItemRoom users: flashcard/quiz editors+readers, MermaidMaterialEditor, blocksRoom.ts, liveNoteRead.ts, embedded items in a note seat. Plate uses RoomProvider (NoteEditorCore.tsx).
Plate ~24.7k lines + Rust notes crate ~12.8k deleted. BlockSuite editor (blocksuite/pageEditor.ts) needs edgeless root with many notes + surface (XL). blocks crate assumes fixed root/note ids (blocks/src/lib.rs). Perf risk: large note opens 24.7 s tuned BlockSuite vs 14.1 s Plate (agent's number; verify).

Embeds: material_ref quizzes/sets in notes (parent_material_id, store/embedded.go) deleted -> canvas cards to real rows. Charts/plots/graphs/HTML/Mermaid keep inside notes.

Agent tools (agent_tools.json, internal_documents.go, edits.rs): create_material, add_questions, inspect_document, read_document, edit_document (replace_text, replace_block, insert_markdown, remove_block) with Undo payload, decks with chapter, read_study_progress. Blocks rooms refuse server edits (BLOCKS_LAYOUT_REFUSED). New: target note block on canvas, placement rule, quiz = row + card.

RAG: rag_material_contents, dirty/pending columns, indexed_blocks, Rust scheduler, note_index.go; chunks carry top-level block ids (note_block_regions, retrieval/indexing.py); noteCitation.ts walks note root DOM to scroll/flash.

Share: only standalone items public (workspace materials forced private); Worker (workers/site/handler.ts) SSRs SharedNote.tsx from Plate JSON; BlockSuite cannot SSR; Q6 open. Export downloadItem.ts. Clone share.go from SQL copy of each doc, index_copy.go.

Quota: per-material bytes from content charged to creator (uploader pays); at limit payer's stuff view-only (canEditContent; access.rs); each material capped 2 MiB and 10,000 nodes. Permissions workspace-wide (owner/editor/viewer + share role), no per-material.

Study: delete study_progress + workspace_study (0051), read marks, Mark as read (study/studyItems.tsx), Continue, Hide study progress, railway map, Learning Progress tab (routes/Learning.tsx, store/learning_progress.go), finish toasts, quiz checks setting done. Plans (store/study_plans.go) = ordered file/material steps, done from read progress. Page editor with to-do + mentions could hold task lists. Open: plans private or shared ticks. Reviews keep (FSRS, ReviewSession.tsx, Quick review); plan reviews draw from mentioned quizzes/sets.

Starter: store/starter.go builds chapter, blank DOCX, welcome note with embedded questions/cards. Tour: guide/Tour.tsx (10 steps), tourStore.ts, tourSamples.ts.

Hard problems: (1) notes in canvas doc vs doc per note (room = unit of access, eviction, quota, drafts, indexing, clone, sharing; middle path = DB row per note with content in canvas); (2) indexing/citing per note vs per canvas; citation pans/zooms to block then flashes; (3) public share of one note (copy vs in-place token + block checks); (4) quota (split per creator block-by-block vs owner pays reversing 2026-10-18; 2 MiB cap; drag history -> write on drop); (5) agent edits placement, row + card receipts/Undo, contention; (6) clone needs SQL copy of canvas, re-key ids, drop skipped cards, subtree cut; (7) what a file is (~10 places treat content as files+materials; notes lose 30-day trash, deleted block only 24 h Undo); (8) per-note permissions impossible in one doc; (9) drafts per room (editDrafts.ts draftKey): refused update/discard/frozen payer replaces whole workspace doc; (10) one room's presence for whole workspace; a user can join at most 22 documents (quiz cards can't each join a room); comments keyed material+block, 500 cap per note; BlockSuite open/typing must improve.
