# Drawing answers: saving and marking, for Epo's decision

Proposal from the drawing-answers session (2026-11-06). Nothing below is built. The mocks are on the canvas at https://claude.ai/artifact/PeD5MMznkkTTdc2cEJb9zj, with questions Q1–Q5 on its sticky.

## Saving (S1–S5)

How it would work:
- **Each Done uploads one drawing:** the board document (undo history stripped, refused past your 250 KB cap) and its capture (WebP through the shared compressor). It goes to a new `drawings` row whose payer is set at upload. The answer value for the part is the drawing's id.
- **Payer:** the workspace owner for an assignment, the member for their own practice.
- **Storage:** charged through the same storage gate as frozen assignment images.
- **Cleanup:** the blobs go when their row goes. The row goes with its attempt (`attempt_id … ON DELETE CASCADE`, so an assignment's deletion and an account purge take it), and through the same blob-reference triggers as editor assets.
- **Where the board lives:** the browser keeps the board on the device as the member draws (your decision), until the answer is checked or submitted.

Questions:

- **S1, practice has no attempt until Check.** A practice attempt is created by its first Check, and no practice answer of any type reaches the server before that. A drawing uploaded on Done therefore has no attempt yet. My plan: the upload is a draft, still charged to the member, and Check ties it to the attempt. Is it OK that "server on Done" means an unattached upload in practice?
- **S2, drafts nobody checks.** I'd remove a draft no Check claimed after 24 hours. The device still holds the board, so a Check after that uploads it again without the member noticing. Is 24 hours OK?
- **S3, an owner's storage is full.** In an assignment the drawing is charged to the owner, so a full owner means a member's Done is refused. Proposed toast: "This drawing can't be saved: the workspace owner's storage is full." The board stays open with nothing lost. OK, or should drawings in assignments bypass the owner's limit?
- **S4, question bank and quizzes inside notes.** Neither keeps answers today (the bank keeps a score, a note's quiz keeps nothing). Proposed: a drawing there is uploaded as a draft, marked on Check, and removed by the S2 rule, as nothing else from that check is kept. OK?
- **S5, images pasted onto the board.** These need the board's blob hook (canvas-enrich is adding it), with the image stored under the drawing and counted in its capacity, as you decided. I'd land saving without them first: pasting a picture onto an answer board stays off until the hook is in. OK?

- **S7, practice images and unapproved marks:** an assignment's marking image is deleted once the assignment is closed and that drawing's marks are approved (Epo 2026-11-06). The board stays for teachers to open. Two cases this doesn't cover:
  - With Approve AI marks off, or a part an owner marked by hand, I'd treat the marks as approved when they land.
  - Practice never closes, and a Not marked practice part keeps "Check again", which needs the image. I'd keep a practice image with its attempt.

  OK on both?
- **S6, answered (Epo 2026-11-06):** a drawing reaches the server on Done, with its image made then, capped at 300 KB. A time limit running out with the board open submits it as it stands. A drawing never sent with Done counts as unanswered when an assignment closes.

## Marking (M1–M4)

Same path as an open part: Go reserves credits (the member's in practice, the owner's in an assignment), calls the pipeline's `/grade` and computes the marks. An assignment's AI marks wait on Approve when that's on. With no credits left the part stays Not marked; shared pages never mark it. The grading slot's model (`deepseek/deepseek-v4.1-flash-1017` through OpenRouter, routed Wafer → InferenceNet → Cloudflare, no fallbacks) already reads images. The current open-answer prompt is unchanged.

- **M1, the prompt below:** today's open-answer prompt word for word, plus a four-line section only drawing calls get. OK?
- **M2, call settings:** the open answer's own rule, unchanged: thinking on when the question or its items show working (16,000 tokens, 180 s), otherwise reasoning off, temperature 0, 2,000 tokens, 90 s. Before marking ships I'd add about five drawings to the grading bench to check it.
- **M3, answered (Epo 2026-11-06):** the board's image is shrunk to at most 1,568 px on its longest side before it's sent; a measurement of how readable boards stay at that size is running.
- **M4, the grading slot requires vision:** the ops dashboard's slot check would refuse a grading model without the `vision` capability. Migration 0153 says the slot "needs no vision" today. OK to require it?

### The prompt: today's open-answer prompt, unchanged, plus one section

A drawing call sends the open-answer `SYSTEM_PROMPT` (`pipeline/pipeline/retrieval/grading.py`) word for word, with this section appended. Open-answer calls don't change at all.

```text

Drawn answers: when the student's answer is an image instead of <student_answer> text, the image is the student's work and everything above applies to it.
- Judge what is drawn and written: lines, curves, points, shapes, arrows, labels and any text or numbers. Accept freehand drawing; a point or value read from a grid or axes is right within half of the smallest grid square.
- A sample answer image, when one comes before the student's image, shows one correct answer the scheme accepts, not the only one.
- "quote" names, in at most 12 words, the part of the drawing that earns the credit, such as "the straight line from the origin to (6, 4)".
```

### The user message

The same `<question>` and `<marking_items>` text as today. In place of `<student_answer>…</student_answer>` come image parts, the way page reads send theirs:
- When the part has a drawn sample answer (your Q3 decision): the text `Sample answer:` and its image, then the text `Student's drawing:` and the student's image.
- Otherwise: the student's image alone.

Each image is `{"type": "image_url", "image_url": {"url": "data:image/webp;base64,…"}}`.

### What code does around it

- Same JSON reply and decoding as open answers, except the quote check: a drawing has no text to find the quote in, so the quote is kept for the bench but never checked.
- No copy check for drawings.
- The thinking rule (on when the question or items show working) and the settings stay as they are; M2 asks whether drawings should always use one setting.
- An empty board is never sent: Done on an empty board leaves the part unanswered.
- `injection_suspected` gives the fixed comment and the `instructions` flag, as today.
