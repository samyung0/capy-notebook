# File uploads as assignment submissions

Epo's request (2026-11-08): an option at assignment creation for quiz (Marked)
and general (Unmarked) assignments to take uploaded files; whether AI marks
quizzes from uploads, and how to handle scanned PDFs; whether to chunk and index
submissions; and whether a normal scanned upload goes to the caption/VLM slot
while only Make a quiz uses the layout/OCR service.

Status: **phase 1.** No feature code.
- Decided: A, B, marking from all the pages together, the person attempting
  pays, and credits or storage never blocking a submission.
- Open: O1–O4, M, N and C–L.

Mocks: https://claude.ai/artifact/4ihgjU6i3BQn3q6ngQA9bQ
(`artifacts/2026-11-08-file-submissions-mocks.html`). Costs and the whole-paper
bench: `bench/grading/reports/2026-11-08-page-answer-costs.md`.

## Decisions so far (recorded in `human/study-progress.md`)

- **A (Epo 2026-11-08, "sure"):**
  - New assignment gets a switch, off by default, on Marked and Unmarked. It is
    named **"Allow submission with uploads"** (Epo's later message).
  - Shuffle questions moves into Advanced.
  - An Unmarked assignment's Files field sits below Due and Assign to.
  - Mocks C1 and C2 are updated.
- **B (Epo 2026-11-08, superseding the same day's S2):**
  - Opening a Marked assignment that allows uploads shows Before you start,
    the timed assignment's dialog, with its time limit when there is one and
    two buttons: Attempt online and Upload file (mock S4, Epo's later message;
    no separate choice screen). Upload file opens S5.
  - The member never labels which page holds which question: "upload a single
    10 page pdf and nth else should be needed". Mocks S1 and S2 are removed.
- **Show answers (Epo 2026-11-08, built 6bf29212d, names from Epo's later
  message):** a select beside Marking: After assignment close (default),
  After submission, Do not show.
- **Show grades (Epo 2026-11-08, mocks C4, S7, T5, built):** a select
  beside Show answers, Automatic or Manual; Manual holds marks until Release
  grades, with practice, reviews and topic labels waiting too.
- **T3 (Epo 2026-11-08, built):** the error badge reads No credits or Grade
  Error; no banner and no member names in an error summary. The member
  attempting pays for all AI marking of an assignment (built with it).
- **Marking (Epo 2026-11-08):**
  - The pages are marked together, since nobody says where each answer is: one
    call for the whole paper, or a map call then grading.
  - "3 page is very little": there is no per-question page cap.
- **Payer (Epo 2026-11-08, "all assignment markings"):**
  - All AI marking of an assignment is charged to the person attempting:
    typed, drawn and uploaded answers, the page map and the option read.
  - This supersedes the 2026-11-03 owner-pays line, now tagged in
    `human/observability-metering.md`.
- **Credits (Epo 2026-11-08):**
  - Running out never blocks a submission; answers reach the owner ungraded.
  - The owner sees "to approve" and "not graded" as separate counts, plus why
    answers weren't graded (mock T3).
- **Storage (Epo 2026-11-08):**
  - Running out never blocks attempting or submitting. Drawings and uploads
    save past the limit into the existing over-quota states.
  - A later attempt started while over the limit can't upload, and its start
    shows a warning when there are drawing parts (S6).
  - Built 2026-11-08: drawings save past the limit, and Before you start warns
    a member whose storage is full when the paper has drawing parts (S6).
  - The owner sees it on a members page, never on the assignment's pages
    (Epo, T4 updated); where is question U.
  - This supersedes the Q693 storage refusal on assignment drawings; practice
    checks keep Q694.

## Answers shown after submitting (Epo asked 2026-11-08)

**Today:**
- With Show answers on, which New assignment defaults to, a member gets keys,
  marking points and worked solutions the moment they submit, while the
  assignment is still open for others (`openwiki/study-progress.md:808`, 978;
  `gradedWithoutKeys` strips them only when it's off).
- Marks waiting for approval don't show.
- With more than one attempt, a member can use the keys on the next attempt
  (accepted 2026-11-05).
- So yes: one early submitter can share every answer.

**Other apps keep "when" apart from "what":**
- **Moodle:** each review item (right answer, whether correct, marks,
  feedback) has its own timing: during, immediately after, later while open,
  or after the quiz is closed.
  [St Olaf guide](https://stolafcarleton.teamdynamix.com/TDClient/1893/StOlaf/KB/ArticleDet?ID=147541),
  [VCC KB](https://vcc.teamdynamix.com/TDClient/50/Portal/KB/ArticleDet?ID=2989)
- **Canvas New Quizzes:** shows correct answers from a set date and can hide
  them again; teachers ask for "release at the due date".
  [Canvas idea](https://community.canvaslms.com/t5/Canvas-Ideas/New-Quizzes-Show-and-Hide-Quiz-Results-by-Date/m-p/510182),
  [UMN how-to](https://it.umn.edu/services-technologies/how-tos/canvas-showing-quiz-answers-students)
- **Google Forms:** releases grades immediately or "Later, after manual
  review". "Respondent can see" (missed questions, correct answers, point
  values) is set separately.
  [Google support](https://support.google.com/docs/answer/7032287?hl=en-IN)
- **Microsoft Forms:** one switch, "Show results automatically", or the
  teacher posts scores later.
  [Microsoft support](https://support.microsoft.com/en-us/education/display-answers-and-points-on-quiz-questions)
- **Sharing is the reason these options exist:** guides recommend showing
  right answers only after the quiz closes.

**Recommendation (question R, mock C3):**
- A Show answers dropdown, default After it closes. "Closes" means closed by
  hand, or at the due date when No late submissions is on.
- With late submissions allowed, answers wait until the owner closes it.
- Marks still show on submit.

## Releasing marks (Epo asked 2026-11-08)

Epo asked whether to have a separate show-score option, how to display an
assignment whose score isn't released, and whether topic mastery should wait.

**What a member sees today:**
- Closed parts' marks, and AI marks once approved (or at once with "AI grades,
  no approval needed"), from the moment they're decided. They show on the
  Submitted page ("Your mark so far"), on Results and on the Assignments row
  (`AssignmentsPage.tsx:503`).
- Topic labels on Learning read `answer_events`, which are written at submit for
  closed parts and when open parts are marked (`learning_overview.go:530`). So a
  label can move on a mark the owner hasn't released yet.
- Reviews (FSRS) are rated only when the assignment closes and its quiz becomes
  practice.
- No notification is sent when marks land.

**How other apps do it:**
- **Canvas:** an automatic or manual posting policy, per course or per
  assignment. Under manual, students see no grade, no comments and no
  notifications until Post grades. After posting, later regrades show at once.
- **Google Classroom:** grades are drafts that students can't see until the
  teacher presses Return.
- **Google Forms:** "Release grades" is either "Immediately after each
  submission" or "Later, after manual review".

**Decided:** Show grades, Automatic (default) or Manual (C4).

**Built (Epo 2026-11-08, "sure build it now, can tune later"):** as proposed
in S7 and T5. Practice also waits for the release, since its keys would give
the answers away early.

- **Not in this:** a bell notification at release (question T).

## Credits and storage never block an assignment: what changes

**Credits, today:**
- A part that can't be paid for, or whose call fails, is simply absent from
  the results: `gradeWithModel`, `server/internal/httpapi/quiz_grading.go:216`.
- It shows "Not marked", and no reason is stored.
- The owner's "N to approve" (`ApproveTab.tsx:119`) counts AI-marked answers
  waiting for approval and answers never graded together.

**Credits, to build:**
- Each ungraded part stores why: `credits` or `provider`.
- Counts split into "to approve" and "not graded" on the Assignments list row,
  the report header, Approve and the Members tab.
- A strip on Approve gives one line a reason (T3).
- Mark with AI stays the owner's button and charges each member's own
  credits. Nothing retries by itself (AGENTS.md).

**Storage, today:**
- An assignment drawing is refused at the limit: `CheckAssignmentDrawing` →
  `gateStorageTx`, `server/internal/store/drawings.go:127`.
- The Q693 review added that refusal.

**Storage, to build:**
- Assignment drawings and uploaded papers skip the refusal but are still
  charged, so the account goes over.
- An attempt started over the limit gets no Upload (S6 laptop), and a warning
  when it has drawing parts (S6 phone).
- The owner sees "Storage full" on the member's row (T4).

**Corrections to the numbers in Epo's message:**
- A quiz allows 100 parts and 100 AI-marked parts (`fieldlimits.QuizParts`,
  `QuizOpenParts`), not 40.
- A drawing part holds at most a 250 KB board plus a 300 KB marking image
  (`DrawingBoardBytes`, `DrawingImageBytes`).
- The marking image is dropped once its part is marked.
- **How far over the limit an attempt can go:**
  - Worst case: about 25 MB of boards across 100 drawing parts (images
    dropped after marking), plus the uploaded paper, at most the member's
    source file cap (10 / 30 MiB).
  - A typical paper with a few drawings adds well under 2 MB.

## 1. Parsing today (answer to Epo's last question)

**A scanned PDF from a normal upload goes to the captioning (VLM) slot. Yes.**
- The gateway routes PDFs to the OpenDataLoader parser on the ingest host
  (`openwiki/agentic-retrieval.md:315`). The parser has had no OCR model since
  2026-10-15 (`agentic-retrieval.md:386`, RapidOCR removed).
- A page with under 40 kept characters is text-less; the parser renders it as a
  grey 1,280 px JPEG (`parser/odl/textless.py:19-31`).
- The ingest worker reads each render with the captioning slot's model
  (`pipeline/pipeline/ingest/worker.py:1750` `_read_vlm_pages` →
  `pipeline/pipeline/retrieval/models.py:1143` `read_page`, which takes
  `registry.captioning_spec()`), prompt `VLM_PAGE_PROMPT`
  (`pipeline/pipeline/prompts/captioning.py:22`).
- That model is DeepSeek V4.1 Flash 1017 on OpenRouter, routed Wafer US →
  InferenceNet → Cloudflare (`openwiki/observability-metering.md:619`,
  `pipeline/pipeline/elitellm/client.py:53`). It is no longer GLM on Relace:
  that was 2026-10-15, and the pin moved to 1017 on 2026-10-19.
- Charge: 1.0 credit a read page (`vlm_ingest_page`), in place of the 0.4
  digital page rate.
- Exception: a scan whose scanner added a hidden OCR text layer has text, so it
  parses as digital pages and never reaches the VLM.

**The layout service is used only by Make a quiz, and it isn't OCR.**
- `pipeline/pipeline/retrieval/layout.py` is imported only by
  `retrieval/extraction.py:64`. It calls the layout service once a selected page
  (`extraction.py:1444` → `layout.py:247` `read_regions`).
- The service is PP-DocLayout_plus-L. It returns region boxes, which Make a quiz
  uses to crop figures, and reads no text. It is set up on UAT only
  (`human/deployment-runbook.md:138`); without `CAPY_LAYOUT_URL` every figure
  takes the box call.
- Make a quiz reads question papers and mark schemes itself, from page images
  on the extraction slot (1017). A born-digital paper also sends its indexed
  text; a scanned paper or answer file goes as page images
  (`agentic-retrieval.md:5772-5781`, 5816-5821).
- So nothing in the app runs OCR apart from the VLM page read at ingest. The
  question and mark-scheme files are read by the extraction model from images.

## 2. AI marking of uploads

**Yes, AI marks uploads, on the drawing path:** the vision grading slot, the
Marking dropdown (AI with approval / AI without / Manual), Not marked when
credits run out or a call fails, and Check again / Mark with AI later. The
payer waits on Q1.

**Measured cost per page** (1017, catalog rates; report above):

| Path | Per page | Notes |
|---|---|---|
| Text layer (born-digital PDF) | 0 model cost to read | Grading from text: 0.15–0.6 credits a part |
| OCR (ingest VLM page read) | 1.0 credit charged (0.27–0.41 in tokens) | The only "OCR" there is; then grade the text |
| Page image in a grading call | about 0.2 credits a page a call at 1,568 px (0.12 at 1,024) | Output sets most of a call's cost |
| Layout service | free | Boxes only; no use for marking |

One credit is $0.001 to the payer; Pro gets 10,000 a month, Free 200.

**Whole paper, nothing labelled: bench of a 10-page handwritten paper** (16
parts, 7 planted mistakes, an answer over two pages, one out of order, a graph,
a blank; two runs each):

| Method | Parts right | Credits a member | Wall time |
|---|---|---|---|
| G1 one call, all pages at 1,568 px | 15/16 both runs | 8.4 / 16.8 | 21 / 48 s |
| G1 one call, all pages at 1,024 px | 16/16 both runs | 19.3 / 5.0 | 49 / 12 s |
| **G2 map call (1,024 px), then one call per part with its pages (1,568 px)** | **16/16 both runs** | **10.4 / 5.7** | **11 / 8 s** |

- **Epo is right that one call can mark a whole 10-page paper.** G1 got 15–16
  of 16, but its cost swings 4× with how long it reasons.
- **G1 puts every part in one reply,** so a failure or a cut-off loses the
  whole paper, and a 40-part paper risks the output cap.
- **G2's map found every part's pages** in both runs, including the two-page
  answer, the out-of-order one and the blank.
- **G2 is steady and parallel.** A failure loses one part (Not marked, as
  today), and it reuses the per-part prompt.
- **Either way it costs about the same as the same parts typed** (about 0.8
  credits a part).

**Fewer calls (Epo asked: "a single exam can have like 120+ mc questions").**
Benched the same day:
- **Closed parts need no grading call:** one read call returns the marked
  option for every question, and code marks it against the key as today.
  - A 120-question bubble sheet on 2 pages of 60 read 120/120 in both runs
    (erased marks, double marks and blanks included), for about 1 credit and
    3 s.
  - 120 on one page read only 104/120, so a dense page needs splitting (a crop
    per column) or more pixels; neither was tested.
- **Open parts can go 4 to a call:** 16/16 in both runs with 5 calls instead
  of 17. Batches of 8, like one call for all, missed one part both times.
- **Calls don't drive the cost;** output tokens do. Batching cuts call count
  and time, not credits.

**Recommended (question M): map, then read closed parts, then grade open
parts in batches.**
- **Map call:** every page at 1,024 px, reasoning off, returns each part's
  pages, about 0.12 credits a page. A 40-page paper's map is about 20k input
  tokens.
- **Closed parts:** one read call over their pages, about 60 bubbles a page at
  1,568 px, then code marks against the key. A blank, a double mark or an
  unreadable mark reads as null and scores 0. The owner can change it in
  Approve.
- **Open and drawn parts:** batches of up to 4 parts, grouped by question,
  each with its mapped pages at 1,568 px and no page cap. A failed batch leaves
  only its parts Not marked.
- **A part the map finds on no page** earns nothing and makes no call.
- **Born-digital pages** go as their text (Make a quiz's `page_layer` test):
  cheaper, and quotes can be checked.
- **Approve** shows each part's mapped pages (T1), so a wrong map is visible.
- **Limit:** 40 pages a submission (Make a quiz's run cap), refused at upload.
- **Today's 100-part quiz cap** (`fieldlimits.QuizParts`) still stops a
  120-question paper; raising it is its own decision (question N).

**Prompts (need Epo's OK before they're built).**

P1, appended to today's grading prompt only when pages go with a part. The user
turn is today's question and items, then "Student's pages:", then "Page n:"
and each image in order:

```
Page answers: when the student's answer comes as page images instead of <student_answer> text, the pages are the student's written work and everything above applies to them.
- The pages may hold answers to other questions or parts; mark only the answer to the part in <question>.
- Read handwriting as written; anything you cannot read earns nothing.
- "quote" copies, in at most 12 words, the words or working on the page that earn the credit.
```

P2, the map call's system prompt. The user turn is "Question parts:" with one
line a part (label and question text), then "Pages:" and each page as
"Page n:" and its image:

```
You see every page of one student's handwritten answer paper, in order, and the list of question parts. For each part, give the page numbers where the student writes its answer. Answers may run over several pages or come out of order; a part the student did not answer gets []. Reply with JSON only, such as {"1a": [1], "6": [5, 6]}.
```

**Storage** follows the drawing decisions (2026-11-06):
- The member pays for their uploads, and the files go with the assignment.
- A member who leaves keeps, and pays for, files whose parts aren't marked yet.
- Uploads are attempt files, not workspace files: no ingest job, no file tree
  entry, no parse charge.
- A PDF takes the member's source file cap (10 / 30 MiB). Photos are
  compressed to the 2 MiB image cap in the browser.

## 3. Chunk and index submissions: recommendation, no (for now)

- **Cost:**
  - Digital pages cost 0.4 credits a page to parse, scanned pages 1.0 a page,
    and embedding adds next to nothing.
  - A class of 30 handing in 8 scanned pages each is about 240 credits.
  - Ingest charges the uploader, the member, which now matches the person
    attempting paying for marking.
- **What it would enable:**
  - search across submissions;
  - the chat agent citing a member's work ("who misread water potential?");
  - similarity checks between members.
  None of these is built or planned, and marking doesn't need the index: pages
  go to the model directly.
- **Who could see it:**
  - The workspace index serves every member's search and chat, and a material
    has no "uploader plus staff" visibility (`authorization-permissions-lifecycles.md`).
  - "Hidden from members" would hide a member's work from the member too.
  - Indexing safely needs a new visibility rule in retrieval first.
- **Later, when a use is built:** an owner-only "Index submissions", charged to
  the owner and visible to owners and editors only.

## 4. Mocks

https://claude.ai/artifact/4ihgjU6i3BQn3q6ngQA9bQ (laptop and 360 px for each
board):
- **C1:** New assignment, Marked, with the "Allow submission with uploads" switch.
  - C1a has no estimate.
  - C1b adds a credit estimate in the footer.
- **C2:** New assignment, Unmarked, with the same switch.
- **S4:** the new choice screen, Answer here or Upload your paper.
- **S5:** the upload screen.
  - One place for the whole paper; pages show in order.
  - No labelling.
  - View questions opens the paper read only.
  - Submit.
- **S3:** Member, Unmarked: a Your work section with Add files, and Hand in in
  place of Mark as done.
- **T1:** Owner, Approve AI marks, showing the mapped page in place of the typed
  answer, with Open file.
- **T2:** Owner, Unmarked task's Members tab: handed-in date and files.
- **T3:** Owner, "to approve" and "not graded" counts, with the reasons on
  Approve.
- **T4:** Owner, Members tab "Storage full" on a member's row.
- **S6:** Member over storage: Upload turned off on the choice screen; the
  warning in Before you start.
- **S1 and S2** are kept on the page, marked as not picked or superseded.

## 5a. Upload build design (2026-11-08, after "sure" on S5/F1/F2)

Epo: "how does the create quiz upload handle? it should be the same upload
pipeline right? then do the same thing". So a paper's files are ordinary
standalone uploads (no workspace) through the normal source upload, linked to
the attempt, and supersede "attempt files, no ingest, no parse charge" above:
- **Data (migration 0161):** `assignments.allow_uploads`; `attempts.paper`
  ('upload' while attempting by upload, 'reading' once submitted until the
  read lands, 'read' after); `files.attempt_id` (ON DELETE CASCADE: the files
  go with the attempt and its assignment) and `files.attempt_position`; a check
  that a paper file has no workspace.
- **Upload:** the source upload ticket and upload take `attemptId`: the
  member's own running upload-mode attempt, before its deadline. Storage saves
  past the limit (an upload attempt could only start while not full, S6);
  the credit estimate check is skipped (credits never block a submission).
  The ingest job runs as for any upload, charged to the member.
- **Kept out of** the Files list, search, Recent, move, clone and trash;
  listed only in Files › Submissions, deleted there under the close rule.
- **Marking:** at submit an upload attempt's parts all wait and nothing is
  logged; `paper='reading'`. Marking waits for the files' ingest to settle,
  then one pipeline call `/paper` (R at 1,024 px, then P1 + B four open parts
  a call at 1,568 px) returns each part's pages, closed answers and open
  grades. Go turns closed answers into each type's answer shape (letters to
  option indices / texts), drops an answer with no pages, regrades the
  attempt with them, logs answers, stores `pages` on each part, then saves
  the open grades as AI marks and failures as No credits / Grade Error.
  Office and text files go as their indexed text, one page each, as Make a
  quiz does. A later Mark with AI regrades only the open parts on their pages.
- **Order:** an upload attempt's matching options and ordering items are
  shuffled with the attempt as seed, so the letters on paper match the read.
- **Staff view:** `GET /api/assignments/attempts/{id}/paper` lists the files
  (and a page render route) for staff of the workspace and the member; no
  change to general file access.
- **Page cap:** 15 pages a paper for now (Epo's figure, held; to confirm).

**Built 2026-11-08** (ec78b1621, d239fc362 and after): all of the above, plus
Files › Canvas waiting for close and release, the quiz part cap at 150 (N),
the Grades released bell (T), frozen accounts attempting and submitting with
drawings and papers (O4), and a paper's upload batch settling with no bell.
Verified: Go store/httpapi suites, pipeline `test_paper.py`, vitest, e2e
`assignment-paper.spec.ts` with the other assignment specs, screens against
C1, S4, S5, T1, F1 at laptop and 360 px.
**Built 2026-11-09:** Unmarked hand-ins (C2, S3, T2, migration 0162): the
switch on Unmarked below Files, Your work with Add files and Hand in / Undo
hand in, the Members tab's Handed in and Work columns with a file viewer, and
hand-in files in Files › Submissions once the assignment closes. A hand-in
takes files past its due date (Late on T2) until it closes. Unmarked
assignments follow the Marked late rules (Epo 2026-11-09, "same rules"): No
late submissions on Unmarked too, closing only by hand or under it.
Verified: Go store suites with `TestHandInIsHandedInAndDeleted`, vitest,
e2e `assignment-hand-in.spec.ts`, screens against C2, S3, T2 at laptop and
360 px. Not built: a page count on Your work's rows (files are not parsed, so
it shows the size alone). Approve's page view is two pages a row rather than
T1's full-width strip, since pages are no longer cropped.

## 5. Build outline (phase 2, after the decisions)

- **Data:**
  - `assignments.allow_uploads`;
  - an attempt's mode (site or upload);
  - submission files on the attempt (blob key, name, type, bytes, pages,
    payer);
  - the map's pages a part;
  - storage charged through `gateStorageTx` as drawings are.
- **Upload:** presigned B2 upload outside the workspace file tree. The browser
  counts and draws pages with the PDF viewer already in the app.
- **Marking:**
  - The map call, then `quiz_grading.go` sends each part its mapped pages.
  - The pipeline renders PDF pages with `capture.render_file` and sends
    born-digital pages as text.
  - `grading.py` gets P1, and a new map prompt gets P2.
- **UI:** C1/C2, S4, S5, S3, T1, T2, as approved.
- **Docs and tests:** openwiki question-bank, study-progress, storage-quota and
  test-catalog; Go store and grading tests; vitest; the grading bench gets real
  scans (the report's "Not tested").

## Questions for Epo

O1. **Decided (Epo 2026-11-08, "sure on all"): bounding the overshoot:** one uploaded paper an attempt, at most the
    member's source file cap in total (10 / 30 MiB) across its files; drawings
    stay bounded by their per-part caps. OK?

O2. **Settled (Epo 2026-11-08, "no need unless its practice"):** on an
    assignment only the owner presses Mark with AI; a member re-checks only in
    their own practice. This is unchanged from today, so nothing is recorded.

R. **Built (Epo 2026-11-08, "its only a select right? otherwise just build
   first and lets see"):** the switch is now a Show answers select, After it
   closes (default) / Right after submitting / Never (migration 0159). Marks
   and per-part right/wrong still show on submit; whether right/wrong should
   wait too is for Epo to judge on the build.

S. **Built 2026-11-08** (Show grades, Release grades, S7).

T. **Decided: yes (Epo 2026-11-08, "sure on all").** Notify at release? A bell notification "Grades released: Past paper 2025
   P1" to each member. No marks notification exists today.

U. **Settled 2026-11-08:** Study → Members, built from the 3 Nov mocks with the
   Storage full chip on `claude/study-members` (343178998, 12da95d19), not
   pushed.

O3. **Decided: no strip (Epo 2026-11-08, "sure on all").** Untimed assignments without uploads open straight into the attempt,
    so they have no start dialog for the storage warning. Should a one-line
    strip show at the top of the attempt instead?

O4. **Decided: yes (Epo 2026-11-08, "sure on all").** Frozen accounts (`over_quota_frozen`, read-only everywhere): can they
    still attempt and submit assignments? Recommended: yes, since an
    assignment answer isn't a material they edit.

M. **Approved word for word (Epo 2026-11-08, "sure on all", after a cheap run of each: `bench/grading/reports/2026-11-08-paper-prompts.md`). The build drops a read answer whose pages are `[]` (R guessed the unanswered choice part 3 times in 8).** Marking an uploaded paper: two steps, three prompts.
   1. **Read** (new call, reasoning off, every page at 1,024 px): each part's
      pages, and the answer for closed types, marked in code against the key.
   2. **Grade** open, long and drawn parts 4 to a call, each batch with the
      union of its pages at 1,568 px: today's `SYSTEM_PROMPT` +
      `DRAWN_SECTION`, then P1 and the batch section B.

   **R, the read prompt** (system message; the user message lists each part
   as `id (type): question`, choice options lettered A, B, …, matching items
   numbered and their options lettered, ordering items lettered, then the
   pages as `Page n:` images):

   ```
   You see every page of one student's answer paper, in order, then the list of question parts. For each part give:
   - "pages": the pages where the student answers it, in order. Answers may run over several pages or come out of order; a part the student did not answer gets [].
   - "answer": the student's final answer, in the shape its type asks for below. Leave it out for open and drawing parts, and when the part is unanswered or you cannot read it.
     - choice: the letters the student marked, such as ["B"] or ["A", "D"]. A crossed-out or erased mark does not count.
     - true/false: true or false.
     - short: the final answer as written.
     - gaps: one entry per numbered gap, in order; "" for a gap left empty.
     - matching: each numbered item's letter, such as {"1": "C", "2": "A"}.
     - ordering: the item letters in the order the student puts them.
   Copy what the student wrote; never correct it. Reply with JSON only, such as {"parts": [{"part": "1a", "pages": [1], "answer": ["B"]}]}.
   ```

   **P1, added after `DRAWN_SECTION`:**

   ```
   Page answers: when the student's answer comes as page images instead of <student_answer> text, the pages are the student's written work and everything above applies to them.
   - The pages may hold answers to other questions or parts; mark only the answer to the part in <question>.
   - Read handwriting as written; anything you cannot read earns nothing.
   - "quote" copies, in at most 12 words, the words or working on the page that earn the credit.
   ```

   **B, the batch section after P1** (the user message wraps each part as
   `<part id="…"><question>…</question><marking_items>…</marking_items></part>`
   inside `<parts>`):

   ```
   Several parts: this time you mark every part listed in <parts> at once. Everything above applies to each part on its own.
   - Find each part's answer anywhere in the pages given; it may run over several pages or come out of order. A part with no answer earns "none" on every item.
   - Mark only what the student wrote for that part.
   Reply with JSON only, one entry per part in the given order: {"parts": [{"part": "1a", "steps": [], "vocabulary_only": false, "injection_suspected": false, "comment": "", "items": [{"id": "m0", "quote": "", "reason": "", "choice": "full"}]}]}
   ```

   Benched: R's pages and short answers (six runs, `paper_transcribe.py`),
   P1 + B at 4 a call (`paper_batching.py`). Not benched by choice (Epo
   2026-11-08: "testing early on doesnt help too much, i can test it myself
   with some messy answers"): the other closed types and real photos.

N. **Decided: raise to 150 (Epo 2026-11-08, "sure on all").** Quiz size: raise the 100-part cap (`fieldlimits.QuizParts`) for papers
   like 120 multiple-choice questions? This affects every quiz, not only
   uploads.

C. **Decided: no mixing (Epo 2026-11-08, "sure on all").** Typed and uploaded mixed: S4 makes it one or the other per attempt.
   Should a member who picked Upload still be able to type answers into the
   app?

D. **Limits:** Epo floated 15 pages (all pages go in one call) but is holding
   it until grading is settled. Born-digital pages sent as text.

E. **How an uploaded paper is graded (bench 2026-11-08, "One read call"):**
   - One call over every page returns each part's pages, and for closed types
     (multiple choice, fill in the blanks, ordering, matching, true/false,
     short) the answer as written, put into that type's answer shape and
     marked in code against the key. Pages 16/16 and short answers 5/5 in six
     runs, about 1–2 credits for 10 pages.
   - Open, long and drawn parts: no crop, since the model's boxes clip the
     answer too often. They are graded from their whole mapped pages, and Approve
     shows the marker those pages (T1), the whole paper a click away.
   - Still to bench: reading matching, ordering, fill-in-the-blank and
     multi-select; real phone photos.

V. **Multiple choice, one answer or several.** Epo merged "multiple answers"
   into mcq on 2026-10-15 (`human/question-bank.md`, commit 4519a67cc); IELTS
   "Choose TWO" in the bank prompt and Make a quiz extraction rely on it.
   - C (recommended): keep one type; a key with one correct option takes a
     radio, one with several says "Choose 2" with checkboxes.
   - A: split again into single mcq and a separate multi type.
   - B: as A, with a mark per correct letter (IELTS scoring).

W. **Decided (Epo 2026-11-08, "sure on all"); S5 is redrawn so before it is built.** Where the upload sits. The mode is picked first, in Before you start
   (S4). Upload file opens the questions read-only with the clock running and
   "Your paper" with Submit at the end (S5 to be redrawn so). OK?

F. **Decided: C1a, none (Epo 2026-11-08, "sure on all").** Credit estimate: C1a (none) or C1b ("AI marking about N credits a
   member" in New assignment's footer)?

G. **Decided: none for now (Epo 2026-11-08, "sure on all").** Indexing: none for now (section 3), with a later owner-only "Index
   submissions" once something uses it?

H. **Decided: no hand-in comment this round (Epo 2026-11-08, "sure on all").** Unmarked tasks: Hand in with files, no AI and no marks (S3, T2). Should
   the owner be able to leave a comment on a hand-in?

I. **Decided (Epo 2026-11-08): yes, a Submissions tab after Canvas so members delete a paper once it is marked, marks kept; mocks F1 (member) and F2 (owner after a delete) for Epo to look at.** Storage: the member pays for and keeps their uploads, as for drawings.
   Should the uploads also list on their Files page (a Submissions tab beside
   Canvas)?

J. **Decided (Epo 2026-11-08):** the clock covers uploading too.

K. **Decided (Epo 2026-11-08):** every file type the normal upload and Make a
   quiz accept, Marked and Unmarked.

L. **Decided: later (Epo 2026-11-08, "sure on all").** Own practice: page answers in a member's own practice later, not in
   this round?
