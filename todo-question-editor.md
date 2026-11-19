# Question editor redesign

Epo's request (2026-11-15): make question editing easier, like Google Forms,
both in page and in the dialog; matching should look like Google Forms'
multiple choice grid; a graded quiz's tabs become Questions / Responses /
Settings as Google Forms and Canvas (Build, Moderate, Reports, Settings) do.

Mock (Design canvas): https://claude.ai/artifact/Gyj7hBmGVJ3bRqoxNttQVQ, its
boards as files in
`/private/tmp/claude-501/-Users-sam-web-capy-notebook/910061c6-eb62-4800-bce8-ae0487172011/scratchpad/qedit-mock/project/*.dc.html`.
Built UI copies the boards with the app's existing components; anything the
boards do not settle is reported, not invented.

Status: **decided 2026-11-15, building.**

## Decided (Epo 2026-11-15, "sure and build the mock")

- **Cards.** A quiz's questions are a column of cards beside the numbers
  rail. The open card edits in place: question text with its formatting
  toolbar under it, Add image, and the answer type menu at its right; answers
  below with the correct one marked by the radio or checkbox beside it (as
  Canvas); a footer with Solution, Topic, Marks, Duplicate, Delete and ⋮.
  Other cards show the question as members see it, the correct answer marked
  "Correct". A floating toolbar beside the open card adds a question or opens
  From the bank (built 2026-11-15: the bank picker in a dialog, copies from
  `POST /api/quizzes/{id}/bank-questions` inserted after the open card). Parts show inside one card, the open part outlined
  (board Parts).
- **Answer types** (boards Types1, Types2, Matching): the menu lists Multiple
  choice, Multiple answer, True / False | Short answer, Long answer, Fill in the
  blanks | Matching, Ordering, Drawing, with icons.
- **Multiple answer** is its own type: `multiple: true` on an mcq answer
  (shared question format, TS/Go/Rust) shows checkboxes even with one correct
  option. Several correct options without the flag stay checkboxes, so model
  output is read as before; the writing prompt does not change.
- **Matching** edits as Rows and Columns, then a Correct answers grid with one
  cell per row; members answer on the same grid (one pick per row); on a phone
  the grid scrolls sideways with the row names fixed.
- **The dialog** (question bank, /qb) is the same card in a dialog with
  Topic, Tags, Cancel and Save. The quiz's "Edit all details" goes: the card
  edits everything in place.
- **Graded quiz page:** tabs Questions | Responses | Settings (a draft:
  Questions | Settings); Preview is a header button. Questions edits the
  graded quiz's quiz in place; after publishing, edits reach members on
  Republish (Settings), as today. Responses holds a View dropdown (By member:
  today's Members; By question: today's Questions table) and Approve AI grades
  (Mark answers when marking is manual) as a button at its top right.
- **Practice quiz:** no tabs; a Preview button beside Study. Responses for
  practice quizzes waits (no endpoint lists members' practice attempts).
- Tasks (unmarked assignments) keep their tabs.
- **Bold, italic, underline** (Epo 2026-11-15): markers in the text string as
  Discord writes them, `**bold**`, `*italic*`, `__underline__`; tight pairs only;
  B / I / U in the text toolbar; no format, room or prompt change.

## Decided after the build (Epo 2026-11-15, Canvas / Google Forms / Moodle compared)

- **Bank tags in the dialog.** On the bank page (class bank, My bank) the Edit
  question dialog, and New question, have Tags under Topic, saved with the
  question; the row ⋮'s Edit tags and its dialog went. Built:
  `src/features/itemBanks/BankTagsField.tsx`, `QuestionDialog` `tags`.
- **Shuffle options with locks.** `shuffle: true` and `locked: number[]` on an
  mcq answer through every layer; learners get `order` (answers stay authored
  indices, so grading is unchanged); the card's ⋮ has Shuffle options and each
  option row a lock button while it is on. Built.
- **Sample answer in Solution.** The card's sample answer is the Solution's
  first block again (the 2026-11-13 pick); the footer's Solution offers Text
  or Sample answer for long answers and drawings. Built.
- **Matching rows and columns drag whole** with an accent drop line, as the
  ordering items; Alt+Arrow moves rows and columns. Built.
- **Question list while editing: Canvas's rail** (Epo 2026-11-15, "A, Canvas
  rail"; boards ListA, ListA2). The editor's 300px list became a 60px rail of
  numbers (open one dark, issues dotted) whose ≡ opens the outline; answering
  and studying keep the list. Built: `src/features/quizzes/QuestionRail.tsx`.

## Work

1. Format: `multiple` on mcq answers through validation, learner projection,
   Rust items/notes and parity fixtures.
2. Card editor: QuizEditor/QuestionPane/editorFields/QuestionDialog to the
   cards, the type menu, matching rows/columns + correct grid
   (`src/features/questions/MatchingGrid.tsx`, shared with 3).
3. Members' matching grid in QuestionRunner and result views.
4. Graded quiz page tabs and Preview; practice quiz Preview.
5. Review by a reviewer subagent; browser check at desktop and phone widths.
