package sourceupload

// FilesEditable is the one switch for editing files (Epo 2026-11-28, Q852 A,
// Q853 A, Q854 A). Off, every file a user uploads or creates (DOCX, XLSX,
// PPTX, text, CSV) is view-only for everyone: no edit session or room token
// is issued and no room admits anyone, saves, edit-driven processing, Blank
// DOCX/XLSX and edit thumbnails are refused, chat edits no file and
// edit_office_document is not offered, and /api/me says so, so the browser
// opens every file in View. Materials (notes, quizzes, flashcards, canvas)
// are not files and stay editable. The edit code stays: reverting the commit
// that turned this off, and un-skipping the tests skipped with it, turns
// editing back on.
const FilesEditable = true
