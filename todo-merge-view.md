# Merge view: open work

The merge view covers notes only (`human/frontend/error-handling.md`, Q251,
Q252, Q258). Current behaviour lives in `openwiki/frontend/error-handling.md`
(Recovery) and `openwiki/frontend/plate-editor.md` (offline editing and
drafts). Queued for later, nothing below decided yet:

- **Other documents.** Quizzes, flashcard sets and other item rooms, Office
  files and text files keep copy-only recovery. Give them a merge view,
  including hidden typing for item rooms.
- **Conflicts shown in the editor.** Mark what conflicts directly in the Plate
  and Office editors (highlighting, or an error icon on the conflicting block)
  instead of only listing it in a separate sheet.
- **Several documents at once** (decided, Q296 in
  `human/frontend/error-handling.md`). Stored drafts are sent from any open
  Capy page, and most land without anyone noticing. Drafts the server cannot
  apply wait on the device. Show one app-wide banner saying how many notes
  have edits to review and that drafts expire 7 days after their last edit,
  linking to each note; opening a note downloads it and runs the merge view
  there, under the usual room limits. A dismissed banner leaves a warning icon
  on those notes in the file list until they are resolved or expire. Offline,
  the banner says there are unsynced edits to sync once online. Nothing is
  downloaded before a note opens.
