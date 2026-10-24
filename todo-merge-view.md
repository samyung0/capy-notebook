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
- **Several documents at once.** Stored drafts are sent from any open Capy page
  (on page load, on coming back online, when a tab becomes visible), not only
  when a document's room opens. Several notes can therefore need the merge
  view while the user is on an unrelated page. Decide how to present that, for
  example one app-wide notice listing the documents with edits to review, each
  opening its document. Applying a piece needs the document open and synced.
