# Graded quizzes, assignments and item banks

Epo's request (2026-11-14): New assignment always wanting a quiz made elsewhere
is annoying. Epo decided the assignment holds its questions (a **graded quiz**)
and that reuse comes from a question bank. Rule for this plan (Epo): **copy
Canvas, do not invent.** Every line below is either what Canvas does (with its
source) or a point where Canvas has no answer for something we have and Canvas
doesn't. Those are listed under "Left for Epo".

Status: **plan, no feature code.** Mock redrawn 2026-11-14 (version 9) at
https://claude.ai/artifact/YXjzjjdKRRMdhJhNYaK8sx: the New menu (Assignment,
Graded quiz), New assignment with Points, the graded quiz's Questions and
Settings steps, From the bank (workspace bank / My bank, tags, Select all),
the workspace bank as a Study tab (A, picked over a separate Quiz page B), My bank as a Study page tab, and Add
to bank on a question's ⋮.

## What Canvas does

### Assignments

- A quiz is a kind of assignment: making a quiz makes an assignment behind it,
  and the Assignments page lists assignments, quizzes and graded discussions
  together.
- The non-quiz kind is just "assignment". Two settings shape it:
  - **Submission type:** No submission; Online (text entry, website URL, media
    recording, file upload, student annotation); On paper; External tool.
  - **Display grade as:** points, percentage, letter grade, GPA scale,
    complete/incomplete, or not graded. A Not graded assignment is still an
    assignment and stays out of the gradebook.
- Pages and discussions can carry a to-do date, which puts them on the
  student's To Do list without being an assignment.

### Item banks (New Quizzes)

- **Owner.** A bank lives in the account of the teacher who made it, and they
  can use it in any course where they can make quizzes. A bank made on the
  Item Banks page can also be shared with the course at creation (a checkbox);
  one made from inside a quiz isn't.
- **Sharing.** With a user or a course, as Can view or Can edit. View can add
  the questions to quizzes and duplicate the bank, but not change it. Edit can
  change and delete items and the bank, and the change reaches everyone using
  it. Sharing with a course gives its teachers and TAs that permission. Admins
  can share a bank with the whole account or a sub-account.
- **The list.** Reached from the course's Item Banks link and from inside any
  quiz's builder. Filters: This course (the default: banks shared with this
  course), Shared with me (made by or shared with you), and banks shared with
  your courses. Search by bank name.
- **Ways in.** On the Item Banks page: make a bank, then add items to it. In a
  quiz's builder: a question's Item Banking section has Add to bank (an
  existing bank or a new one). Questions are never banked automatically.
- **Organising.** Many named banks (guides suggest one per topic or outcome).
  Items carry tags, and inside a bank you filter by tag and search question
  titles, stems and answer choices.
- **Using a bank in a quiz.** Add single items, or add a bank with All/Random:
  every item in random order, or **N random items per student**, each worth the
  same points (the bank's own points are ignored).
- **Linked, not copied.** Editing a bank item changes it in every quiz using
  it, and Canvas keeps no versions. Guides warn to copy the question once
  students have taken the quiz. Content edits happen in the bank; the quiz can
  change only points and a few options.
- **Course copy.** Copying a course that uses a bank shares the bank with the
  new course.

### Practice vs graded (Classic Quizzes)

- One quiz object with a type: Graded quiz, Practice quiz, Graded survey,
  Ungraded survey. Switching type is a setting, not a copy. Students never
  make quizzes.

## How this maps onto Capy

- **Graded quiz.** Today's Marked assignment, holding its own questions. The
  Assignments page's New offers the kinds; a graded quiz is made in one dialog
  (Add quiz's ways of getting questions, then today's assignment settings).
- **The non-quiz kind.** Today's Unmarked assignment: Mark as done ≈ No
  submission, Hand in with uploads ≈ file upload. Canvas's other submission
  types (text entry, URL, media, annotation, on paper) and complete/incomplete
  are not in this plan.
- **Item banks.** A personal bank and a workspace bank (see Decided); Add to
  bank on a question in the quiz editor; tags and search inside a bank;
  adding picked items or a whole bank to a quiz, copied.
- **Not copied for now:** account and sub-account sharing (we have no school
  accounts yet), item analysis.
- **Storage:** question images are charged like any upload, to the uploader
  (`authorization-permissions-lifecycles.md`). Our own rule, not Canvas's.

## Decided (Epo 2026-11-14)

- **Keep our practice quizzes.** Study's practice quizzes stay as they are (a
  class member's own is private to them, "Only you"); a graded quiz is owned by
  its assignment.
- **Names.** In a class the non-quiz kind is **Assignment** (today's Unmarked
  assignment, still unmarked), beside **Graded quiz**. A personal workspace
  keeps **Task**.
- **No random draws.** Everyone gets the same paper. From Canvas we copy only
  adding picked items or a whole bank.

- **Copied, not linked.** Picking a bank question copies it into the quiz; a
  later bank edit never reaches that quiz. (Differs from Canvas on purpose.)
- **Where banks sit** (mock A picked): the workspace bank is a fourth tab on
  the workspace's Study (Overview, Topics, Practice, Question bank), with New
  question as the header button; no switch inside Practice (no tabs inside
  tabs). My bank is a third tab on the sidebar's Study page (`/learning`,
  after Overview and History), laid out the same.
- **Graded assignment** (asked, scope below): an Assignment can be graded on
  points, as Canvas's can.

## Graded assignment (non-quiz)

Canvas grades a non-quiz assignment by points (among other displays), with the
teacher entering each student's grade. Today an unmarked assignment has no
marks anywhere: every score, standing, the report, Show grades and the late
penalty read quiz attempts (migration 0147 ties `kind = 'marked'` to
`questions`). Adding points means:

1. An assignment's **Points** (out of), set in the form; none = not graded.
2. A **grade per member** on their hand-in (a column on `assignment_done` or a
   small table), entered by staff from the member's row, where the hand-in's
   files already open.
3. The report, Members standings and the member's To do row reading that
   grade beside quiz marks; Show grades and the late penalty applying to it
   (the late-policy check widens from `kind = 'marked'`).

- **Two kinds of bank.** A **personal bank**, only its owner's (the Study
  page tab). A **workspace bank**, owned by the workspace (its Study →
  Practice page): its owner and editor members (teaching assistants) see and
  edit it, viewer members never do. Unlike Canvas, which has only personal
  banks shared to courses. Question images follow the uploader-pays rule.

## Left for Epo (first round, kept for the record)

Canvas doesn't answer these, or answers them in a way that hits something we
built differently:

1. **Practice quiz vs graded quiz.** Canvas has one quiz with a type, and
   students never make quizzes. We have Study's practice quizzes as workspace
   files that members make too. Either keep our split (practice in Study,
   graded owned by its assignment, a copy between them) or follow Canvas (one
   quiz, graded/practice is a setting).
2. **The non-quiz kind's name.** Canvas: "Assignment" (the page is
   Assignments too). Ours today: Unmarked assignment in a class, "task" in a
   personal workspace's To do.
3. **Random draws.** Canvas gives each student N random items. Our report,
   Approve and score comparison assume everyone has the same paper, so copying
   this means reworking those.
4. **Linked items.** Canvas changes a bank item everywhere it's used, with no
   versions. Our grading and report read the quiz's questions after
   submission, so a linked edit would change already-marked papers. Copy the
   link (and Canvas's "copy it after students take it" rule) or copy on pick.
5. **Who gets a bank.** Canvas: anyone who can make quizzes in a course, which
   is staff only. Ours: members make practice quizzes and personal workspaces
   have no staff. Staff only, or everyone who can make a quiz.
6. **Where the bank page sits.** Canvas reaches it from inside a course (its
   navigation, and the quiz builder). Ours would be the workspace's sidebar
   plus the Add quiz dialog. A personal workspace or someone with no
   workspace has no "course" to reach it from, which ties to point 5.

## Order (once those are in)

1. Graded quiz ownership, the New menu, and Add quiz with settings for graded
   quizzes.
2. Item banks: storage, sharing, the bank page, Add to bank.
3. From the bank in Add quiz (All/Random per point 3).
4. Later: account sharing, item analysis.

No production data, so no shims (`no-legacy-data`): an existing Marked
assignment's quiz becomes owned in the same migration.

## Sources

- Canvas Community: How do I manage item banks in New Quizzes?
  https://community.instructure.com/en/kb/articles/661075-how-do-i-manage-item-banks-in-new-quizzes
- GMU: https://its.gmu.edu/knowledge-base/item-banks-in-new-quizzes/
- MSU Denver: https://ready.msudenver.edu/self-help-tutorials/new-quizzes/share-an-item-bank-in-new-quizzes/
- Texas State: https://services.txst.edu/TDClient/39/ITAC/KB/PrintArticle?ID=597
- Fullerton (random set): https://canvashelp.fullerton.edu/m/Making_the_Most_of_Canvas/l/1866553-how-do-i-add-a-random-set-of-questions-from-an-item-bank-in-new-quizzes
- Lane CC (no versions): https://support.lanecc.edu/canvas/new-quizzes-item-banks-guide
- Humboldt (not banked automatically): https://humboldt.edu/ctl/how-use-item-banks-new-quizzes
- Canvas admin guide (account sharing): https://community.canvaslms.com/t5/Admin-Guide/How-do-I-share-a-New-Quizzes-item-bank-from-a-course-with-an/ta-p/469502
- Sub-account sharing: https://community.canvaslms.com/t5/The-Product-Blog/Sub-account-Item-Bank-Sharing-and-Outcomes-Alignment/bc-p/604906
