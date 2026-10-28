# Background clone index copy, and Download

Status 2026-10-28: on `wip/mac-clone-download`. Built: passages, vectors and
summaries scoped through their content row (migration 0126), so a Move re-tags
the content row instead of copying the index. The background index copy for clones
(single file and workspace) is built (migration 0127, store/index_copy.go).
Download is built on every item menu (files, notes as Markdown/Word,
Preparing rows). D3 is built for files (a payer's lost-access rows get
Clone to… and Download). Left: lost-access notes, which need a payer-only
read of the note and its embedded items for export without opening it. Measurements:
`bench/clone/reports/2026-10-27-clone-cost.md`,
`bench/clone/reports/2026-10-28-index-copy-parts.md`.

Landing notes: 0126 is also `wip/mac-account-chat`'s number; whichever lands
second renumbers. Account chat's search (`search_account`, the
`_STANDALONE_OWNER` vector leg) drops its owner leg when it meets this: every
file in scope is a content id.

## Why

- A clone copies the file's index (chunks, 2560-d vectors, summary) inside
  the request: 0.4 s at 500 chunks, 2.9 s at 2,000, 10.7 s at 5,000, with the
  transaction open throughout. The row and the saved edits are cheap (about
  10 ms per MiB, 0.64 s for a 68 MiB Office log). Move copies the index the
  same way.
- Users want to download what is in Files, and nothing on an item menu
  downloads today. Downloads exist only inside an open file ("Download
  original" for previews the viewer lacks, "Download draft" while editing
  Office or text, note export to Markdown, DOCX or JSON).

## A. The index copy runs in the background

Move re-tags instead (Epo 2026-10-28, built): content only the moved file
holds keeps its row, which names the target; content another file or note
shares is copied in the request as before, the rare case.

Request (clone, single file or workspace): the file row, its saved edits and its thumbnail as
today, so the copy opens at once; the file is `status='processing'`,
`indexed=false`, and one `index_copy` job is queued. Chat and search see it
once the job finishes.

Job (Go background worker, beside the trash and batch workers):

- Copies the content in batches (about 250 chunks per transaction), so no
  transaction stays open for seconds. Chunk ids are derived from the new
  content id, so a repeated batch is a no-op.
- The last batch points the file at the copy and sets it `ready` and
  `indexed=true`, in one transaction.
- Progress goes out as the existing ingest event (`ingest:{workspace}`, or
  `notif:{owner}` with `type: "ingest"` for a standalone file), stage
  `copy_index` with a percentage, so the transfer panel and the file's row
  show it like an upload's processing.
- The source content must outlive the copy. A move drops the file's old
  alias at once (its key names the old workspace), so the job holds the
  content through a new `rag_content_holds (content_id, job_id)` row that
  `delete_unreferenced_rag_content` also checks, dropped when the job ends.
- Failure: retried like ingest work (this is copy work, not a user retry).
  If the source content is gone or the retries run out, the job queues the
  normal ingest instead, paid by the actor as a cross-space clone is.
- Account and file lifecycle: trash, purge, account deletion and workspace
  deletion of the copy end the job (`cancel_file_pipeline_jobs_for` and
  `cancel_user_async_work` learn the job type); the copy's charge is the
  file's, as today.

## B. Download

Item ⋮ menus: the Files page (files and blocks), the workspace file tree and
the open file's header. Lost-access items wait on the copy-out decision.

- **Files with nothing saved past their stored bytes** (PDF, image, audio,
  any file whose saved edits are published): the signed source link, as
  "Download original" uses. Instant.
- **Office and text files with saved edits not yet published:** see D1.
- **Blocks:** notes export with the editor's renderer from the stored
  document, with no editor open (`exportNoteDocument` takes the Plate value).
  See D2 for the formats and for quizzes and flashcards.
- Downloads that need work show in the transfer panel as "Preparing
  download", then save.

## Decisions (Epo 2026-10-27, recorded in human/)

- D1 (revised 2026-10-28): Office/text with unpublished saved edits download
  by merging base and editing state in the browser, with view mode's export
  worker (`exportCheckpoint`), tracked as Preparing download. No server
  export. Measured in `bench/editor/reports/2026-10-28-office-browser-export.md`
  (0.3–6.4 s on an M1 up to 30 MiB, up to about 1 GiB added; phones slower).
- D2: notes as Markdown and DOCX; quizzes and flashcards later (their embed
  has a primitive export to start from).
- D3: payers may Clone to… and Download lost-access items (latest version).
- D4 (revised 2026-10-28): the copy opens at once and editable, with its
  room; a publication of its edits waits until its index is copied.
