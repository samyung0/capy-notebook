# Edits a publication captured are charged once

Two storage double charges are fixed (Capy `350fd1a4`, migration 0054):

- **Office, while a deferred publication waits for its rebuild.** The file is
  the published export, and the editing state still holds every edit the export
  holds. The state is now charged only beyond the published capture
  (`state - published_state`).
- **Text, after every publication.** Text keeps its Yjs state, so published
  text was charged in the file and again in the state, for good. A text
  publication now moves `seed_bytes` by the file's change in size, so only Yjs
  history and edits after the capture stay charged in the state.

On the local stack, a DOCX with a 1,044,963-byte PNG cost **2,505,239 bytes**
while its rebuild waited. It now costs **1,110,940 bytes**, the published file
alone. Three rounds of 1,000 bytes typed into a 2,006-byte Markdown file cost
**8,201 bytes** after the third publication. They now cost **5,201 bytes**: the
5,006-byte file plus 195 bytes of Yjs history. At every step of both runs, the
triggers booked exactly what reconciliation recounts.
[Raw numbers](2026-10-05-office-storage-charging.json).

Sizes are bytes. "Charge" is what the owner pays for the source:
`files.size_bytes + source_documents.storage_bytes`. On every row it equals the
change in the owner's booked total (`used_bytes` plus pending deltas).

## Local stack: store-only uploads, edited in the browser

Each fixture is uploaded store-only (never processed). The steps are:

1. Open the editor, make the fixture README's owner edit and save. The DOCX
   then gets the PNG through Insert › Image and saves again.
2. With the editor still open, make the edits due (`last_edited_at` backdated
   8 days) and let the scheduler publish them export-only.
3. Make the collaborator edit and save, still in the open editor.
4. Leave the file, so the room empties and the rebuild runs.
5. Backdate again for a second publication with nobody in the room.
6. Let the reaper drain `pending_blob_deletions` (`not_before` backdated).

### exchange-plan.docx (65,718 bytes, plus the 1,044,963-byte PNG)

| Step | File | State | Published state | Effects | Pending | Charge before | Charge after |
| --- | ---: | ---: | ---: | ---: | :---: | ---: | ---: |
| Edited | 65,718 | 497 / 478 | — | 161 | no | 66,376 | 66,357 |
| Image saved | 65,718 | 1,394,299 | — | 2,641 | no | 1,462,658 | 1,462,621 |
| Published, editor open | 1,110,940 | 1,394,299 | 1,394,299 | 0 | yes | **2,505,239** | **1,110,940** |
| Edited while pending | 1,110,940 | 1,394,345 / 1,394,318 | same | 2,607 | yes | **2,507,892** | **1,113,598** |
| Rebuilt (editor closed) | 1,110,940 | 412 | — | 2,595 | no | 1,113,947 | 1,113,946 |
| Republished, rebuilt | 1,110,977 / 1,110,972 | NULL | — | 0 | no | 1,110,977 | 1,110,972 |

Where a cell holds two values, the first is the before run and the second the
after run. They differ by a few bytes because Yjs gives every client a random
id.

The image is stored in the state as a base64 data URL (1,394,299 bytes, 1.33×
the PNG). The export holds it as the PNG. Before the fix, the window charged
both: 2.4× the image. Saving the image before any publication still charges the
data URL as stored. That is one copy, not a double charge, and this change
leaves it alone.

### lecture.pptx (311,193 bytes) and course-guide.xlsx (145,425 bytes)

| Step | PPTX before | PPTX after | XLSX before | XLSX after |
| --- | ---: | ---: | ---: | ---: |
| Edited | 312,261 | 312,261 | 145,902 | 145,902 |
| Published, editor open | 311,899 | 311,235 | 146,770 | 146,538 |
| Edited while pending | 312,685 | 312,021 | 147,172 | 146,940 |
| Rebuilt | 312,579 | 312,600 | 146,952 | 146,952 |
| Republished, rebuilt | 311,280 | 311,280 | 146,657 | 146,657 |

Typing double-counts only the captured change: 664 bytes for the PPTX edit and
232 for the XLSX edit.

### The rebuild's delta

After the fix, the window charges the state's growth beyond the capture. The
rebuild then stores the later edit as its change over seed(published) and books
the difference, which is now small and positive: +348 bytes (DOCX), +579
(PPTX), +12 (XLSX). Before the fix, the rebuild booked a large negative delta
instead (−1,393,945 bytes for the DOCX). The second publication of PPTX was
caught inside its window: state and published state are both 951 bytes, so the
state is charged 0.

### notes.md (2,006 bytes): three rounds of 1,000 typed bytes and a publication

| Round | File | State | `seed_bytes` before → after | Charge edited, before / after | Charge published, before / after |
| --- | ---: | ---: | --- | ---: | ---: |
| 1 | 3,006 | 3,137 | 2,022 → 3,022 | 4,324 / 4,324 | 4,121 / **3,121** |
| 2 | 4,006 | 4,177 | 2,022 → 4,022 | 6,364 / 5,364 | 6,161 / **4,161** |
| 3 | 5,006 | 5,217 | 2,022 → 5,022 | 8,404 / 6,404 | 8,201 / **5,201** |

Before the fix, every published byte of text was charged twice, and the excess
grew with each round (1,000, 2,000, then 3,000 bytes). After the fix, the state
is charged 115, 155, then 195 bytes after each publication. That is Yjs
history: about 40 bytes per round of 25 separate inserts, plus the first
round's own overhead. The
first save recorded `seed_bytes` 2,022, which is seed(text) of the 2,006-byte
file (the text plus 16 bytes). This matches the size migration 0054 gives
existing text rows.

The parse and index of each text publication were stood in for by the run
itself: a ready content row, one job attempt, then the worker's publication
request through the gateway. No ingest worker runs on this stack, so nothing
reached the ingest host.

### The bucket and the reaper

The fake S3 bucket held these objects (identical in both arms):

- After the first publication: the old base A and the export B. The candidate's
  export becomes the file's blob, so B is stored once.
- After the rebuild: A is queued in `pending_blob_deletions`.
- After the second publication: B is queued too.
- After the reaper: only the current file is left.

The text file queues one blob per publication, and the reaper drained them.
None of these duplicates is charged in either arm. That matches the decision to
leave publication duplicates uncharged.

## Engine measurements (office_storage.ts)

`bench/parsers/scripts/office_storage.ts` ran at Capy `fd5ca7a8` (the fix plus
this measurement) and BetterOffice `7ec9b41b` (the current pin, built at that
commit). Database: PostgreSQL 16.15 (pglz). Fixtures: the 18 earlier ones plus
`long-handbook.docx` and `large-gradebook.xlsx`.

The script now also measures the deferred window. The state is the capture
plus the 18-byte later edit, its effects are measured against the capture, and
it is charged under 0054's rule.

| File | Window charge, 0043 rule | Window charge, 0054 |
| --- | ---: | ---: |
| lesson.docx | 647 | 504 |
| grades.xlsx | 584 | 337 |
| lesson.pptx | 436 | 294 |
| exchange-plan.docx | 3,067 | 2,582 |
| course-guide.xlsx | 588 | 340 |
| lecture.pptx | 621 | 293 |
| feature-rich.docx | 783 | 612 |
| feature-rich.xlsx | 613 | 333 |
| feature-rich.pptx | 429 | 287 |
| book-30p.docx | 536 | 402 |
| images-10.docx | 3,168 | 3,034 |
| opaque-objects.docx | 1,534 | 1,401 |
| deck-50.pptx | 433 | 291 |
| cells-1k.xlsx | 586 | 343 |
| cells-10k.xlsx | 586 | 343 |
| cells-100k.xlsx | 582 | 341 |
| jp_llm2.pptx | 1,357 | 377 |
| zh_TW_llm.pptx | 496 | 278 |
| long-handbook.docx | 20,609 | 19,153 |
| large-gradebook.xlsx | 587 | 344 |

With typed edits the window's double charge is small: the captured change, at
most 1 KB here. Most of what is left is the pending effects. Images are where
the double charge was large (the local DOCX above).

### Against 2026-09-28-office-rebase-seed-export

The 18 shared fixtures were compared field by field:

- Six match exactly: lesson.docx, lesson.pptx, course-guide.xlsx,
  feature-rich.pptx, opaque-objects.docx and cells-10k.xlsx.
- Ten differ by 1–4 bytes in state sizes, which is the random-client-id noise
  the earlier report saw: grades.xlsx, lecture.pptx, feature-rich.xlsx,
  book-30p.docx, images-10.docx, deck-50.pptx, cells-1k.xlsx, cells-100k.xlsx,
  jp_llm2.pptx and zh_TW_llm.pptx. images-10.docx's export is also 3 bytes
  smaller.
- Two DOCX fixtures changed for real, both from the DOCX engine in the 20 pin
  bumps since `a7fdc61a`:

  - **exchange-plan.docx:** seed +233 bytes (312,981 → 313,214), export +9,
    and the one-edit effects +110 (2,394 → 2,504). The charge for one edit
    therefore rose 2,875 → 2,989, and for a rebased later edit 2,820 → 2,934.
  - **feature-rich.docx:** seed +354 bytes (42,282 → 42,636) and export +155.
    It has a complex field, and most DOCX commits in the range change how field
    results are seeded and written (for example `04e1f522`, which seeds a
    continued field's result tail as text after the field).

  exchange-plan.docx has no field, and I did not bisect which commit grew its
  seed.

The XLSX and PPTX engines rebuilt (new runtime hashes), but their seeds and
exports are byte-identical. Per-file times are 1.3–7.5× the earlier run's
because this run shared the machine with Docker image builds, so they are not
comparable.

## Why text moves its seed size instead of compacting

There were two ways to keep Yjs history charged once the published text leaves
the state's charge:

- **(a) Compact at publication.** Rebuild the text state from the published
  text and reset `seed_bytes` to it. This is a lineage change, so the epoch has
  to move, and every open editor reopens.
- **(b) Reset only the content part.** Move `seed_bytes` by the file's change
  in size. This is one SQL term in the publication, and no editor notices.

(b) is the one shipped. Yjs stores text as its UTF-8 bytes, so the file's
change in size is exactly the content the state no longer needs to pay for.
History stays charged, as it is stored. It is bounded by the 100 MiB state
cap, and the measurement above found about 40 bytes per 25 inserts.

(a) would reclaim the history, but it needs a behaviour decision first. With
auto-process on, a text file publishes about every 15 seconds while someone
types. Each epoch move would reopen everyone's editor. Edits saved after the
capture would also have to be rebased onto the fresh state, or be lost.

Options if you want (a):

1. Compact only when the history passes a threshold (like material compaction:
   `state >= max(256 KiB, 4 × text)`), and only when the room is empty, as the
   Office rebuild waits.
2. Compact at publication and reopen open editors, with unsaved text going to
   recovery (the 3ea570d8 path).
3. Leave it. History stays charged and bounded by the state cap.

## Method

- **Worktree:** `/Users/sam/web/capy-docx-worktrees/storage-charging`, detached
  from `875ab14d`. BetterOffice was cloned at the pin `7ec9b41b` and built with
  the `office:prepare` steps. The main checkout's build was from `7d6a3bf2` (a
  stale PPTX engine).
- **Local stack:** `bench/parsers/scripts/office_storage_charging.config.ts`
  with `office_storage_charging.spec.ts`. These are the e2e compose stack, the
  collaboration stress test's fake S3 (its port published for object sizes),
  Vite and Chromium. Prebuilt images:
  `capy-storage-charging-server:before` (server tree of `875ab14d`),
  `capy-storage-charging-server:after` (`350fd1a4`), and one collaboration
  image for both arms. Each arm ran on a fresh stack. Nothing ran against the
  ingest host, UAT or production.
- **Owner charge:** `used_bytes + sum(user_storage_deltas)`, checked against
  reconciliation's recount (`storageRecountSQL`) at every step.
- **Candidate size:** read while the candidate row existed. For the DOCX it
  was 1,110,940 bytes, the export that became the file. The PPTX and XLSX
  candidates published before a 100 ms poll saw them.
