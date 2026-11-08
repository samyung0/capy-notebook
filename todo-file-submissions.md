# File uploads as assignment submissions

Epo's request (2026-11-08): an "Allow file uploads" option at assignment
creation for quiz (Marked) and general (Unmarked) assignments; whether AI marks
quizzes from uploaded files, and how to limit scanned PDFs; whether to chunk and
index submissions; and whether a normal scanned upload goes to the caption/VLM
slot while only Make a quiz uses the layout/OCR service.

Status: **phase 1, waiting on Epo's answers (questions at the end).** No
feature code. Mocks: https://claude.ai/artifact/4ihgjU6i3BQn3q6ngQA9bQ
(`artifacts/2026-11-08-file-submissions-mocks.html`). Costs:
`bench/grading/reports/2026-11-08-page-answer-costs.md`.

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

## 2. AI marking of uploads: recommendation

**Yes, AI marks uploads.** Build it on the drawing path: same grading slot
(vision, required since M4), same Marking dropdown (AI with approval / AI
without / Manual), owner pays for assignments, Not marked when credits run out
or the call fails, and Check again / Mark with AI later.

**Measured cost per page** (1017, catalog rates; report above):

| Path | Per page | Notes |
|---|---|---|
| Text layer (born-digital PDF) | 0 model cost to read | Grading from text: 0.15–0.6 credits a part |
| OCR (ingest VLM page read) | 1.0 credit charged (0.27–0.41 in tokens) | The only "OCR" there is; then grade the text |
| Page image sent to the grading model | about 0.2 credits a page a call (1,000 tokens at 1,568 px) | Output still sets most of the cost: 0.6–1.0 credits a part with one page |
| Layout service | free | Boxes only; no use for marking |

All page-image grading calls in the test found and marked the right part on a
page with other answers. One credit is $0.001 to the payer; Pro gets 10,000 a
month, Free 200.

**Per member, a typical paper** (20 open or drawn parts over 10 questions, 8
pages, about 1.5 pages a question):

| How each part's call sees the pages | Credits a member | Class of 30 |
|---|---:|---:|
| Typed answers today (about 0.8 a part) | 16 | 480 |
| **Only its question's pages (recommended)** | **18** | **540** |
| Read every page once with the VLM, then grade text | 17 | 510 |
| The whole submission in every call | 44 | 1,320 |

The cost to limit is pages × calls, not pages alone. So:

- **R1: members pick the questions each page answers** (mock S1, or mock S2's
  photos per question). Each part's call gets only its question's pages, as
  1,568 px images: the drawing image size Epo already set.
- **R2: at most 3 pages a question go to the model.** A question with more is
  left Not marked for hand marking, as a drawing saved under Manual is today
  (Q695). Worst case is about 1.2 credits a part, or 48 credits for a 40-part
  paper.
- **R3: at most 20 pages and 10 files a submission,** refused at upload.
- **R4: born-digital pages go as their text** (the `page_layer` test Make a
  quiz uses). That is cheaper, and quotes can then be checked as for typed
  answers.
- **R5 (optional, mock C1b): New assignment shows the owner an estimate**,
  "AI marking about N credits a member", from the quiz's open and drawn parts.
- **Not recommended:** the owner choosing which pages or parts the AI marks.
  The Marking dropdown (Manual) and Mark with AI per member already cover it.
  A pass that auto-matches pages to questions could come later: one call over
  all pages at 1,024 px is about 0.15 credits a page.

**Prompt (needs Epo's OK before it's built, P1).** Today's prompt word for
word, plus this section, sent only when pages go with a part:

```
Page answers: when the student's answer comes as page images instead of <student_answer> text, the pages are the student's written work and everything above applies to them.
- The pages may hold answers to other questions or parts; mark only the answer to the part in <question>.
- Read handwriting as written; anything you cannot read earns nothing.
- "quote" copies, in at most 12 words, the words or working on the page that earn the credit.
```

The user turn is today's question and items. If the member also typed an
answer, `<student_answer>` follows. Then "Student's pages:" and the images in
page order. As for drawings, quotes from images are not checked.

**Storage** follows the drawing decisions (2026-11-06):
- The member pays for their uploads.
- The files go with the assignment.
- A member who leaves keeps, and pays for, the files of parts not marked yet.
- Uploads are attempt files, not workspace files: no ingest job, no file tree
  entry, no parse charge.
- Plan caps: the member's source file cap for a PDF (10 / 30 MiB). Photos are
  compressed to the 2 MiB image cap in the browser, with the insert compressor.

## 3. Chunk and index submissions: recommendation, no (for now)

- **Cost:**
  - Digital pages cost 0.4 credits a page to parse, scanned pages 1.0 a page,
    and embedding adds next to nothing.
  - A class of 30 handing in 8 scanned pages each is about 240 credits.
  - Ingest charges the uploader, which is the member, against "the owner pays
    for assignments".
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
- **C1:** New assignment, Marked, with the Allow file uploads switch.
  - C1a has no estimate.
  - C1b adds the credit estimate in the footer.
- **C2:** New assignment, Unmarked, with the same switch.
- **S1:** Member, Marked, whole-paper upload (U2).
  - "Your pages" ends the question list.
  - Each page gets a Questions dropdown.
  - Picked pages show on the question rows.
  - A page with no question is flagged.
  - The phone adds Take photo.
- **S2:** Member, Marked, photos attached to each question (U1). This is the
  alternative to S1.
- **S3:** Member, Unmarked: a Your work section with Add files, and Hand in in
  place of Mark as done.
- **T1:** Owner, Approve AI marks.
  - Shows the picked page in place of the typed answer, with Open file.
  - A question over the page cap is Not marked.
- **T2:** Owner, Unmarked task's Members tab: handed-in date and files.

## 5. Build outline (phase 2, after the decisions)

- **Data:**
  - `assignments.allow_uploads`;
  - submission files on the attempt (blob key, name, type, bytes, pages, payer);
  - each page's question ids;
  - charged through `gateStorageTx` as drawings are.
- **Upload:** presigned B2 upload outside the workspace file tree. The browser
  counts and draws pages with the PDF viewer already in the app.
- **Marking:**
  - `quiz_grading.go` sends each part its question's pages.
  - The pipeline renders PDF pages with `capture.render_file` at 1,568 px and
    sends born-digital pages as text.
  - `grading.py` gets the P1 section.
- **UI:** C1/C2 switch, S1 or S2, S3, T1, T2, as approved.
- **Docs and tests:** openwiki question-bank, study-progress, storage-quota and
  test-catalog; Go store and grading tests; vitest; the grading bench gets real
  scans (see the report's "Not tested").

## Questions for Epo

A. **Scope:** an "Allow file uploads" switch on both Marked and Unmarked
   assignments, off by default (C1, C2)?

B. **How members give pages to questions:**
   - S1 (U2): one upload for the whole paper, then a Questions dropdown on each
     page. Recommended: it fits both a scanned PDF and phone photos.
   - S2 (U1): photos added on each question.

C. **AI marks uploads on Marked assignments:**
   - each part's call gets only its question's pages, as 1,568 px images;
   - with the P1 prompt section above;
   - typed text, if any, goes with the pages.

   OK to build, and is the P1 wording OK?

D. **Limits:** 20 pages and 10 files a submission; at most 3 pages a question
   sent to the model, more left Not marked for hand marking; born-digital pages
   sent as text. Other numbers?

E. **Closed parts** (multiple choice, true/false, matching) are answered in
   the app as today, and pages don't mark them. Or should the AI read choices
   off the pages?

F. **Credit estimate:** C1a (none) or C1b ("AI marking about N credits a
   member" in New assignment's footer)?

G. **Indexing:** none for now (section 3), with a later owner-only "Index
   submissions" once something uses it?

H. **Unmarked tasks:** Hand in with files, no AI and no marks (S3, T2). Should
   the owner be able to leave a comment on a hand-in?

I. **Storage:**
   - The member pays for and keeps their uploads, as for drawings.
   - The uploads are deleted with the assignment.
   - A leaving member keeps files with unmarked parts.

   Should they also list on the payer's Files page (a Submissions tab beside
   Canvas)?

J. **Time limits:** the clock covers uploading, with no extra upload window
   after time runs out; an owner who wants one sets a longer limit. OK?

K. **File types:**
   - Marked: PDF and images (JPG, PNG, WebP; HEIC converted in the browser).
   - Unmarked: any type the normal upload accepts, stored and opened in the
     viewer.

L. **Own practice:** page answers in a member's own practice (they pay) later,
   not in this round?
