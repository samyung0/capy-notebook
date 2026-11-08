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
  - Opening a Marked assignment that allows uploads shows a new screen: do the
    quiz on the site, or upload files (mocks S4, S5).
  - The member never labels which page holds which question: "upload a single
    10 page pdf and nth else should be needed".
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
  - The owner's Members tab warns (T4).
  - This supersedes the Q693 storage refusal on assignment drawings; practice
    checks keep Q694.

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

O1. **Bounding the overshoot:** one uploaded paper an attempt, at most the
    member's source file cap in total (10 / 30 MiB) across its files; drawings
    stay bounded by their per-part caps. OK?

O2. **The member's side of "not graded":**
    - Should the member's results say "Not graded: you have no AI credits
      left" with a Top up link?
    - After topping up, may the member press Mark with AI themselves, or does
      only the owner?

O3. **Untimed assignments without uploads** open straight into the attempt,
    so they have no start dialog for the storage warning. Should a one-line
    strip show at the top of the attempt instead?

O4. **Frozen accounts** (`over_quota_frozen`, read-only everywhere): can they
    still attempt and submit assignments? Recommended: yes, since an
    assignment answer isn't a material they edit.

M. **Marking method:**
   - Recommended: map, then one read call for closed parts, then open parts
     4 to a call.
   - Or G1, one call for the whole paper.

   Are prompts P1 and P2 OK? The closed-part read prompt (P3) and the batch
   section are in `bench/grading/scripts/paper_batching.py` and
   `paper_marking.py` (`MC_READ`, `WHOLE`) and would be shown before building.

N. **Quiz size:** raise the 100-part cap (`fieldlimits.QuizParts`) for papers
   like 120 multiple-choice questions? This affects every quiz, not only
   uploads.

C. **Typed and uploaded mixed:** S4 makes it one or the other per attempt.
   Should a member who picked Upload still be able to type answers into the
   app?

D. **Limits:** 40 pages a submission; born-digital pages sent as text. Other
   numbers?

E. **Closed parts in an uploaded paper:** read the marked option off the page
   and mark it in code (recommended, benched for single-letter multiple
   choice). Multi-select, true/false and matching would be read the same way
   but are untested. OK?

F. **Credit estimate:** C1a (none) or C1b ("AI marking about N credits a
   member" in New assignment's footer)?

G. **Indexing:** none for now (section 3), with a later owner-only "Index
   submissions" once something uses it?

H. **Unmarked tasks:** Hand in with files, no AI and no marks (S3, T2). Should
   the owner be able to leave a comment on a hand-in?

I. **Storage:** the member pays for and keeps their uploads, as for drawings.
   Should the uploads also list on their Files page (a Submissions tab beside
   Canvas)?

J. **Time limits:** does a timed assignment's clock cover uploading too?

K. **File types:**
   - Marked: PDF and images (JPG, PNG, WebP; HEIC converted in the browser).
   - Unmarked: any type the normal upload accepts, stored and opened in the
     viewer.

L. **Own practice:** page answers in a member's own practice later, not in
   this round?
