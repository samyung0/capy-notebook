# Study and member tracking plan

Status 2026-11-03: chapters become topics, which replace folders (§1, §3). Round-by-round decisions are recorded inline.

- The canvas plan (`todo-canvas-workspace.md`) is on hold.
- Research: one report per area in `todo-study-tracking/`, each claim with a URL or a file path:
  - R1-tracking: how teachers see results
  - R2-modelling: strengths, weaknesses and follow-up
  - R3-extract-grade: extraction and grading
  - R4-assignments: practice vs graded work
  - R5-inventory: what Capy has today
- Mocks: the Design canvas at https://claude.ai/artifact/1TY5cpr5tDoQZTM2PvGZNd. Epo's other account for now (2026-11-04): a copy at https://claude.ai/artifact/AXkDAMWNXYfANHpEw4MPVC, built from the local sources with all 60 boards; comments and any hand edits made only on the original aren't in it. Artboard names (G1, A2, …) are used below.

Every suggestion first says how other apps do it, as Epo asked.

## Epo's direction (2026-11-02, condensed)

- **Canvas mode waits; study comes first.**
- **Questions from files.**
  - Upload files and extract the questions in them: pick pages, a DeepSeek model, question tool calls, and sample answers or worked solutions filled in where missing.
  - Or generate questions from existing files.
- **Member scores across the whole workspace.**
  - Track each member's scores across the whole workspace: who did what, and each member's strengths and weaknesses.
  - AI follows up with personalised quizzes, new ones or old items mixed in like a review session.
- **Quizzes are practice; tests and assignments are graded.** Graded work has a time limit and feeds a larger score calculation.
- **Grading.** Open answers are graded by a stronger model such as DeepSeek. Shared pages stop getting Jev grades.
- **Schools later.**
  - A workspace becomes a classroom and members become students.
  - Teachers see student profiles and track assignments.
  - For teaching, they drop in Word or PowerPoint files and present, which mostly exists already.
- **Decided 2026-11-02, changed 2026-11-03: chapters become topics,** one flat list that groups files and tags questions (§3). The earlier plan was one-level folders, "just as a rename".
- **Epo's main ask:** "dig more into how tracking members score/performance can work better."

## At a glance

| § | Suggestion | Main precedent | Decision for Epo |
|---|---|---|---|
| 1 | Chapters → folders, a full rename. Study stops grouping by them. | (decided) | — |
| 2 | Owners see assigned work in full, plus a per-topic summary of practice (no answers). Members are told when they join and can preview what the owner sees. | Canvas, Classroom and Moodle gradebooks; Moodle "View report as" | The visibility model |
| 3 | Topics: one flat list per workspace, one topic per question, tagged by AI and edited by owners | Classroom learning goals (AI suggests, teacher confirms); Formative, Gradescope | Topic rules |
| 4 | Views in this order: members grid (G1), quiz report (G3), member profile (G2), topic grid (G4) | Every LMS starts with a students × work grid | G1–G5 |
| 5 | Two separate numbers: a grade (points over released work) and per-topic mastery from a small rating model, plus FSRS recall for memory | Canvas gradebook vs mastery gradebook; Elo/Rasch in Lichess, Math Garden, Duolingo | Labels and thresholds |
| 6 | Follow-up practice: a topic session (70% focus, 30% interleaved), new variants only when the pool runs short | Sparx 60/40, IXL, Century, Kahoot's "from difficult questions" | Approval and credits |
| 7 | Assignments: a frozen copy of a quiz with a due date, a server timer, a "Draft only" switch and Assign to; AI marks wait for the owner's approval unless switched off | Canvas, Moodle, Classroom, Gradescope | Settings and roll-up |
| 8 | Extraction: click the pages to read, two pages at a time with tool calls, pair the mark scheme by label, review beside the page; no source stored | Formative, Microsoft Forms' flags, Gradescope regions | Limits and credits |
| 9 | Grading with DeepSeek only after a bench run. Marks must quote the answer. Shared pages self-mark open parts. | Gradescope, CoGrader, Markit (teacher in the loop); Save My Exams | Provider, charging |

---

## 1. Folders (superseded 2026-11-03: chapters become topics, §3)

Chapters are already one flat level, so the tree, drag and drop, and upload-into-a-folder stay as they are. Under no legacy data (no-legacy rule):
- The rename goes all the way: the `chapters` table and columns, API fields, agent tools (`create_chapter` → `create_folder`, `chapter_id` → `folder_id`) and the UI strings.
- **What stops depending on folders** (R5 §5):
  - review suggestion groups (`chapter`/`others` group kinds), which use topics instead (§3);
  - `WeakChapters` for the agent, which becomes weak topics;
  - the railway map, which goes with read progress (`todo-canvas-workspace.md` §4.1);
  - `attempts.chapters` and `scope_chapters`, which go.
- **What keeps using folders:** the Generate scope, only as a quick way to pick files.

## 2. Who sees whose results

**Today** (R5 §4): every attempt, progress and review read filters by the caller. The only shared number is the Statistics tab's average over everyone. The documented rule says progress is private to its user, so this section changes that rule.

**How others do it** (R1 §3, §5):
- **Course gradebooks** (Canvas, Classroom, Moodle, Teams) show the teacher graded work. Practice is visible but kept out of the grade.
- **Khan Academy and Quizlet class progress** also show unassigned practice.
- **Friend apps** share only by opt-in (Duolingo following; Kahoot Study Groups, where joining means sharing).
- **Peers never see each other's results.** At most they see aggregates, and leaderboards appear only in games or by opt-in. In a group of two, an average reveals the other person's score.
- **Release steps:** Canvas posts grades manually or on a schedule. Classroom keeps grades as drafts until it returns the work. Moodle has a review-options matrix.

**Options (R1 §9.1):**
- **A. Assigned work only.** Practice stays private.
- **B. Everything.** Feels like surveillance among friends.
- **C. Member opt-in.** Leaves gaps in a class grid.

**Suggestion: A plus a topic summary.**
- The owner sees tests and assignments in full.
- From practice, the owner sees only a per-topic summary (label, questions tried, last active), never the answers. Epo's "strengths and weaknesses" mostly come from practice, so A alone would hide them.
- Members are told once, when they join (and existing members once). "What the owner sees" previews their own page (G5).
  - **The join notice (Epo, 2026-11-03; V1):** "You are sharing the following data:" with the list of what is shared. It doesn't name the owner and has no "doesn't see" list.
- Peers see their own results only. Aggregates such as a question's percent correct need at least 5 members with results. Leaderboards are not built.
- Editors see what members see, until a teacher or co-owner role exists.
- **Hide study progress** keeps hiding the member's own view. It cannot hide data from the owner.
- **A member who leaves** keeps their results; the owner loses them.

**Schools later (R1 §5c):**
- US: FERPA, and COPPA for under-13s (amended January 2025, separate parental consent before third-party sharing).
- EU: GDPR digital consent at 13–16.
- So an age policy is needed before schools. Kahoot gates its groups at 13+ or 16+.

## 3. Topics: the unit of strength and weakness

**Today:** quiz questions have no topic field (R5 §1). Only the bank has topics, and "Copy to quiz" drops them.

**How others do it** (R1 §3, R2 §2):
- **Platform curricula:** Khan, IXL, Sparx, Century, Seneca.
- **Teacher tags:** Formative, Gradescope, Wayground, Canvas outcomes, Moodle.
- **AI suggestions a teacher confirms:** Google Classroom learning goals, with up to 10 goals per item and a warning that tags "may not be accurate".
- **Left alone, AI over-splits.** One study got 569 AI topics against experts' 101.

**Suggestion:**
- **Size:** one flat topic list per workspace, aiming for 5–20 topics, capped at 30. Each question has one topic.
- **Storage:** a side table `question_topics`, so the question format and live rooms don't change.
- **Tagging:**
  - At generation and extraction, `add_questions` gains a `topic` field (an existing id, or a new label) and an optional difficulty.
  - The server folds near-duplicates into existing topics and enforces the cap.
  - A background tagger covers hand-written and copied questions. Bank topics map onto workspace topics.
  - Owners and editors rename, merge and move topics. AI merges stay suggestions.
- **Until topics exist,** weaknesses show per question.

**Round 3 proposal (2026-11-03, page 8 of the mocks: T1–T3):**
- **Topics come from a source, not one by one (T1).** "Set up topics" offers three sources:
  - a syllabus or curriculum file, picked from Files or uploaded;
  - an exam's topic tree in the question bank;
  - this workspace's own files and quizzes.
  The AI proposes one flat list. Owners can still add, rename and merge topics by hand.
- **Review before saving (T2).** Each topic keeps one line from the syllabus, which helps the AI tag questions. Saving tags the questions already in the workspace, and new questions get a topic as they are extracted or written. The quiz editor shows each question's topic as a dropdown (X2).
- **Topics replace folders (T3).** Files groups by topic, and dragging a file to another topic moves it. A file has at most one topic. Past papers and admin files sit in "Other files", while their questions keep their own topics. Topics with no questions don't show in Topics or results.
  - This changes §1: chapters become **topics**, not folders.
  - Others: Google Classroom's Topics are the only grouping on Classwork (one per item, no mastery). Canvas keeps Modules for organising and Outcomes for mastery, as Moodle and Schoology do. Capy takes Classroom's single grouping for files and Canvas's per-question tags, from one list.
  - **Decided (Epo, 2026-11-03).**
- **Where topics live (Epo, 2026-11-03).** Topics live in Files: set up, add, rename and remove happen there, and topic rows in the Files panel are plain group rows, with no tag icon. There are no merge suggestions, and no action menu on the topic title; rename works by editing the title.
  - **Uploading asks for the topic** (T4), starting from the topic that is open; nothing is filed automatically. Dragging a file to another topic in the tree moves it.
  - **The upload dialog looks like T4 (Epo, 2026-11-03):**
    - one Topic dropdown for the whole upload;
    - a plain file list (name, size, ×);
    - no per-file parse settings, so every file uses the default parsing.
    - When the payer is out of AI credits, a hint line says files won't be processed and some features may not work.
  - **Files rows look like T3 (Epo):** 30px rows with no progress mark; the open file shows by its row highlight.
  - **No topic page (Epo, 2026-11-03).** A topic row only opens and closes in the tree, and the main area shows the open file (T3). Results by topic stay in Study: Members, Show: By topic.
    - Others: Drive, OneDrive and Dropbox show a folder's contents because their tree only navigates; Notion, Obsidian and VS Code have no folder page. Classroom's topics filter Classwork, and a Canvas module is just its item list. Results by topic sit with grades (Canvas's Learning Mastery Gradebook). Capy's tree already lists every file, so it follows Notion.
  - Study keeps only results. The Topics page is gone, and its members × topics grid is now a view of Members ("Show: Summary" or "Show: By topic", G4). This follows Canvas, where Modules organise content and mastery is a view of the gradebook (Learning Mastery Gradebook).

## 4. Views

**How others do it** (R1 §1, §9.2):
- The first teacher view is always a students × work grid, with a status and a score in each cell.
- Next comes a per-assignment report: percent correct per question and answer frequencies. Item-quality statistics such as discrimination need many takers, so in small groups they are noise.
- Profiles show scores over time and mastery by skill.
- The newest layer is insight cards with a plain reason and an AI draft: Google Classroom with Gemini (2025), Khan (2026).
- **Work is grouped by kind, never mixed** (R1 §2, R4 §4.1):
  - Canvas groups gradebook columns into assignment groups, each with its own total, then a course total.
  - Moodle's grader report puts grade items under category columns that collapse to their totals.
  - Classroom, Teams and Schoology use grade categories, and the overall is total points or weighted by category.
- **Many columns:** gradebooks pin the student and total columns and scroll the rest sideways, filtered by grading period (Canvas, Classroom, Moodle).

**Workspace shell (Epo, 2026-11-02): S2 from the canvas mocks.** The labelled icon rail is picked over a single sidebar.
- **Rail:** the workspace badge, then Dashboard, Files, Agent and Study, each icon with its label below. Your avatar sits at the bottom.
- **Panel:** beside the rail, it lists the current section's own pages.
  - Study lists Members, Assignments, Practice and My results for owners, and My results, Assignments and Practice for members (Topics moved to Files and Practice added, 2026-11-03). These replace the tabs.
  - Files shows the folder tree, and Agent the chats. Dashboard has no panel.
- **The rail stays on every workspace page (Epo, 2026-11-02),** focused pages included: page picking, the quiz editor, the report, grading, the timed assignment, Submitted and topic practice. Dialogs open over a page that still shows it.
- **The Study panel stays open too (Epo, 2026-11-03).** Opening an assignment, its report, its open answers, the timed assignment, Submitted, results or a topic session keeps Members/Assignments/Topics/My results beside the page, with the matching item highlighted.
- **Every screen links to the next one in its flow (Epo, 2026-11-03).**
  - The assignment report has three tabs: Questions, Members and **Approve AI marks**. The marking screen is that tab, with a question dropdown above the member list, not a separate page. "Check the AI's marks" under a question goes to the same tab.
  - Submitted links to Home and to **See results**.
  - My results gives every topic a **Practise** button (Epo, 2026-11-03; it was only Needs practice ones), which opens the topic session.
  - My results shows the same topic labels the owner sees on the member's profile.
- **Getting back to the app (Epo, 2026-11-02): N1.**
  - A Home item with a back arrow sits at the top of the rail on every workspace page.
- **Names (Epo, 2026-11-03):** the app's front page is **Home** (it was Dashboard: sidebar item, `/`, `nav_dashboard`), and a workspace's front page is **Dashboard** (it was Home), with Hugeicons' `DashboardSquare01Icon` in the rail. "Home" now always means the app's own home.
  - Top-level navigation is never hidden in a menu (Epo: "do not hide top level navigation inside some random popups"). The workspace badge only shows which workspace you are in.
  - Others: Canvas LMS keeps its global rail visible beside the course sidebar; Teams has an app bar. Capy today: a back arrow in the file header goes to Workspaces.

Earlier note, superseded: a single sidebar with Home, Files, Agent, Study, then the folder tree.
- Canvas LMS has a course sidebar with Home first. Moodle and Schoology also keep a course sidebar; Classroom uses top tabs.
- Mocks:
  - G1 shows the sidebar with Study's pages as tabs;
  - SB2 puts Study's pages in the sidebar instead;
  - H1 is the workspace Home.

**Round 2 (Epo, 2026-11-02): the Members tab is a summary, and work has two words.**
- **Two words** (a third, "task", was folded into assignments on 2026-11-03; see below).
  - **Assignment:** quiz work the owner sets, with a due date, an optional time limit and set attempts. AI marks wait for the owner's approval unless that is switched off. It counts in Overall.
  - **Practice:** any quiz done any time, marked at once, not counted.
  - **Every quiz members can see is practice (Epo, 2026-11-03);** hidden quizzes aren't (assignment sources, drafts). A quiz is just a file. Assigning it makes an assignment from a frozen copy; showing it to members makes it practice.
  - **Practice page (P1, P2).** Study gets a Practice page beside Assignments. Plain tasks stay on the Dashboard.
    - The owner sees every practice quiz with its topic, question count, how many members tried it, and the group average, but never anyone's practice answers. Add practice shows a hidden quiz to members, for example an assignment's quiz after its due date. A row opens the quiz's question-by-question results.
    - Members see the same list with their best score and Practise. Topic sessions still start from My results.
    - Others: Canvas has an Assignments page and a separate Quizzes page whose quizzes can be practice quizzes (ungraded, outside the gradebook). Wayground lets any quiz be assigned or played as practice. Classroom's Classwork mixes everything under topics. **No time limit (Epo, 2026-11-03),** as quizzes work today; a topic session shows only an estimate ("about 12 minutes"). Only assignments have time limits.
  - **Icons (Epo, 2026-11-03):** practice keeps the quiz's Catppuccin bolt (`stackblitz`, blue). An assignment uses Hugeicons' `QuillWrite01Icon` (the app's UI icon set), tinted Catppuccin teal where file icons are coloured. It shows on assignment chips in Tasks and in activity rows.
  - "Test" and "Homework" are no longer kinds. A timed assignment is still an assignment. Categories with weights can come later if owners ask (Classroom, Canvas, Teams).
- **What each Study tab shows:**

  | Tab | Owner | Member |
  |---|---|---|
  | Members | One line per member: Overall on assignments, x of y done, missing, practice this week, focus topics. A row opens the member's profile (no accordion, Epo 2026-11-03: it only repeated part of the profile). Rows are 52 px; the By topic grid has 64 px rows. | (not shown) |
  | Assignments | Every assignment with its due date and submitted count; drafts are labelled. Each opens its report, and its open answers for changing marks. | Their own: to do and results. |
  | Members → By topic | How the group does per topic (members × topics), with a pinned "All members" row of counts at the top, like Classroom's Class average row (Epo, 2026-11-03). Topics are edited in Files. | Their own labels sit in My results. |
  | My results | Their own study, if they study too. | To do, results, practice, topics, and "What the owner sees". |

- **The mocks are now user flows,** one canvas page each:
  1. owner: from a past paper to an assignment;
  2. member: doing an assignment;
  3. owner: grading and releasing;
  4. owner: tracking and follow-up;
  5. member: practising weak topics;
  6. joining, shared pages and phones.
- The full gradebook (G1c, grouped like Canvas assignment groups) is kept under "Earlier versions". It could return inside the Assignments tab if owners ask for it.

**Workspace Dashboard (was Home; Epo, 2026-11-02): To do (was Tasks), then Recent files and Activity.**
- **Build (Epo, 2026-11-03):** the Dashboard is built from the mocks (H1, H2, H2b) on `claude/study-shell`, using today's data where assignments and approvals don't exist yet. Page header actions that wrap onto their own line sit at the left. The painted page frame now defaults to none.
- **Tasks** is the plan task list Epo described earlier: one line per task, with @ chips linking files and quizzes (`todo-canvas-workspace.md` §4.3).
  - Shown as a table: Task, Due, and either members done (owner) or a tick (member).
  - An assignment appears as a task and ticks itself on submit. Other tasks are ticked by hand, by each member for themselves.
  - Owners add tasks under the table.
- **Anything empty is not shown.** No tasks means no Tasks section.
- **Tasks fold into assignments (Epo, 2026-11-03).** Other apps have no separate task: Classroom uses an assignment with no points, Canvas a page with a to-do date, and Moodle "Mark as done". So Capy has three words: a **quiz** is a file, an **assignment** is anything the owner gives with a due date, and **practice** is quizzes members use on their own.
  - **New assignment starts with Kind** (A1c, A1d; renamed Epo 2026-11-03). **Marked** (was Quiz): pick a quiz or make one from a file; members submit, it's marked and it counts. **Unmarked** (was General, and before that To do): a title plus an optional Files field (picked from Files or uploaded), not @ links in the text. Members mark it done, and it's never marked. From the quiz editor the kind is Quiz and the quiz is filled in (A1). Only owners (and editors) create assignments.
  - **Making the quiz on the spot (Epo, 2026-11-03; A1c, A1e).** The quiz picker in New assignment (and in Add practice) lists the existing quizzes, then New quiz (a blank quiz in the editor), Make a quiz from a file, and Generate questions (from topics or files: count and question types). A new quiz opens in the editor to check, then comes back picked. This matches Classroom's "Quiz assignment" and Teams' "New Forms quiz", while keeping the quiz a file, as in Wayground and Kahoot's library.
  - **Topics on Assignments and Practice (Epo, 2026-11-03; W2, P1, P2).** There's no grouping into sections, because a quiz often spans topics. Each row shows its main topic (most questions) with "+n" for the rest, and a "Topic" filter keeps any row with questions on that topic. A general assignment takes its files' topics. Others: Classroom files each item under one topic (teachers make catch-alls like "Revision"); Canvas lets one item sit in several modules; Wayground tags quizzes and filters by tag; Khan groups by unit and lists a unit test under its unit.
  - **What the owner sees of practice:** counts only. That's "Practice this week: 24 questions" on Members and "Organelles practice · 10 questions" in a profile's activity, never practice scores per member. Practice quizzes show group averages.
  - **Flow 5 is complete (F1b):** My results → Practise → the session list → Start → one question at a time, marked as she answers, with why → Next → Session done. Practice's own Practise starts the same kind of session on that quiz.
  - **Practise on a topic is a review of that topic (Epo, 2026-11-03; F1).** It's the existing review-session engine scoped to the topic: questions already in the workspace, missed and fading ones ranked as today, plus some not seen yet. It has no AI-written, "mixed in" or "challenge" items. New questions come only from Make my own practice (and the owner's Generate questions), whose "Mix in questions I've answered" switch is off by default.
  - **Sessions live under Practice (Epo, 2026-11-03; F1b, F4).** A practice session, even one started from My results, shows the Practice tab as active. Session done links back to Practice. Each topic review is kept in her Practice list as a private row ("Only you") to redo.
  - **Suggested practice (P2).** The member's Practice page opens with Suggested: up to three picks (topics or quizzes) with the reason, from the same engine and wording as today's suggested reviews (missed before, missed twice, fading, last practised). Then All practice: the class's practice quizzes plus her own sessions marked "Only you", with her best score and a Topic filter. My results stays results only. Others: Khan Academy's "Up next", IXL's recommendations and Duolingo's practice hub all suggest what to practise next.
  - **Members make their own practice (Epo, 2026-11-03; P2, P3).** "Make my own practice" on the member's Practice page generates a session from topics or the workspace's files (count and question types). It's private ("Only you"), isn't saved as a file in the class (so it uses none of the owner's storage), stays in her Practice list to redo, and feeds her topic labels like any practice; the owner sees only counts. Quizzes she wants to keep belong in her own workspace (a "Copy to my workspace" is a later idea), and an owner setting to share member practice with the class is left out for now. Others: Khan Academy and IXL let students practise any skill; Quizlet and Kahoot let students make their own sets and kahoots; school LMSs (Classroom, Canvas, Teams) don't let students add to a class.
  - **A closed assignment becomes practice (Epo, 2026-11-03).** Once an assignment closes (its due date passes), its quiz shows up in Practice by itself; Practice notes "Assignment, closed 24 Oct". It happens at closing, not when each member submits, so nobody sees it early. The owner can hide it again.
  - **Study → Assignments is a table (Epo, 2026-11-03; W1, W2):** Assignment, Kind, Posted, Due, Progress and Average, with open ones sorted by due date. Closed ones (past due) hide behind "Show closed". There's no ⋮ per row; a row opens the assignment.
  - **Members' Assignments (W3) and an assignment's page (W4):** members see what's assigned to them (Posted, Due, then Start or Mark done), with "Show done" bringing back finished ones and their marks. A row, or a To do row on the Dashboard, opens the assignment's page. A general assignment shows its files and Mark as done; a quiz goes to Before you start, and after submitting to its Results.
  - **My results is results only (Epo, 2026-11-03):** the overall on marked assignments and topics. The "What the owner sees / doesn't see" card went with the join notice change. The To do and Done lists moved to Assignments, as Canvas and Classroom list assigned work on their assignments pages. Results go back to Assignments.
  - Earlier wording: Assignments listed both kinds, A member's "x of y done" counts both; only quizzes count toward their score.
  - **The Dashboard's list is "To do".** For a member, it holds everything assigned to them: quizzes have Start, and to-dos have a tick box. For the owner, it holds only what is for her (approvals, anything she assigned herself), with New assignment at its top right. What she gave members lives in Study → Assignments, so there is no "Show: Set for members". Personal to-dos belong on the app-level Tasks page.
- (Superseded 2026-11-03: "Add a task" with Task or Assignment became New assignment with a Kind.)
- **Ticks (Epo, 2026-11-03).**
  - Members mark plain tasks ("Read …", "Make notes on …") done themselves. Nothing tries to detect reading: read progress is gone, and opening a file proves little (Canvas's "view" rule only means the page was opened).
  - Assignment tasks have no tick box: they complete when the member submits.
  - Ticks feed the owner's "x of 6 done".
- **Done tasks show no status.** No check icon and no "Submitted" label: they drop out of the list. A "Show done" button (no count) at the top right of the section brings them back at the bottom, crossed out (H2 and H2b).
- **Quizzes carry no check icon anywhere (Epo, 2026-11-03).** A quiz in the task list, done or not, shows no icon: its chip is text only, and the row's icon column is blank. Elsewhere (file trees, editor headers, pickers) the quiz file icon is a question mark in a square, so a check mark never reads as "done".
- **Layout (Epo, 2026-11-02):** a list without a header row. The section title "Tasks" sat right above a "Task" column header, which looked like a stutter. Each row reads "Do [Past paper 2025 P1] 60 min · Due Fri 7 Nov · 5 of 6 done". "Add a task" sits at the top right of the section, as actions do on other pages.
- **Mocks follow a smaller global type and tighter lists** (Epo is reducing the app's global font size):
  - body 14 px (was 14.8);
  - meta 12.5 px;
  - section titles 15 px and page titles 26 px;
  - table rows 40 px with 12.5 px muted headers;
  - list rows about 20% shorter.
- **No cards that repeat Study.** To review and Needs attention were removed. Practise next and Coming up were folded into Tasks or left to My results.
- **The Continue card is removed.** It resumed reading position, which is read progress, and that is gone.
- **Read-progress UI goes everywhere (Epo, 2026-11-03).** That covers Mark as read/unread, Stop/Start tracking, the header's read button, read marks, and done counts that come only from reading, Learning's included. Branch `claude/study-shell`. Whatever the review pool still reads from `study_progress` stays, and is listed.

**Mock (in build order):**
- **Members tab (Main):** the summary described above, sorted by who needs attention, with rows that open.
- **G3, quiz or assignment report:**
  - per question: percent correct and answer frequencies;
  - per marking point: how often it was awarded. Jev's stored item marks make this possible; most apps can't show it.
  - the open answers waiting for review.
- **G2, member profile:**
  - the grade so far;
  - topics with their labels and evidence ("3 of 4 right");
  - recent work and the questions still missed;
  - "Draft a follow-up quiz".
- **G4, members × topics grid,** once topics exist.
- **G5, the member's own page,** with "What the owner sees".

## 5. How performance is computed: grade and mastery are separate

**How others do it:**
- **Two separate numbers.** Canvas has a gradebook and a separate Learning Mastery Gradebook. Schoology and Pear Assessment also keep mastery apart from grades.
- **Mastery leans on recent results.**
  - The most common default is a decaying average weighting the latest result 65% (Canvas, Google, Pear); Schoology uses 75%.
  - Canvas's own interface warns that a plain average is a poor fit.
  - Khan levels and IXL's SmartScore can fall as well as rise.
- **Flags wait for a small, stated amount of evidence** (R1 §3):
  - IXL: 3 misses in one skill, or 3 of the last 5 wrong;
  - Sparx: "seek help" after 6 failed attempts;
  - Kahoot: a question is "difficult" below 35% correct.
- **Models that need lots of data don't fit 1–50 members** with under 10 answers per question (R2 §1):
  - 2PL IRT needs hundreds of answers per item; Rasch about 30.
  - BKT has to be fitted per skill.
  - Deep knowledge tracing needs large logs.
- **What fits is a rating model with priors,** updated after each answer: Lichess puzzles, Math Garden, Duolingo's first Birdbrain.

**Suggestion:**
- **Grade.** Marks awarded over marks possible across submitted assignments, excluding excused work. Work still being graded is left out. Practice never counts. Practice shows separately, with its own average and "not counted". Categories with weights (Classroom, Canvas, Teams) wait until owners ask.
- **Mastery per topic.** A Rasch-type rating with priors, updated after every graded part (R2 §5):
  - **Formula:** `P = c + (1−c)·σ(a_member + d_member,topic − b_question)`.
  - **Partial credit:** `awarded/marks` enters directly.
  - **Weight per answer** `w = r_repeat × r_parts × r_source` (R2 §5):
    - `r_repeat`: 1 for a first answer, 0.5 for a repeat a day or more later, 0 for a repeat the same day after seeing the key.
    - `r_parts = min(1, 3 / parts)`, so a long multi-part question counts like at most 3 parts.
    - `r_source` (Epo, 2026-11-03): 0.5 for questions written for one member (Make my own practice), because nobody else answers them, so their difficulty can't be pooled. Otherwise 1.
    - **No AI-marking discount (Epo, 2026-11-03).** R2's 0.8 came from Jev's measured agreement (87.5%) and is dropped: approval covers assignments, and no app found discounts AI marks in mastery. An answer counts 0 while the member has reported the question.
  - **Excluded:** wholly blank questions, as in today's reviews. An explicit "I don't know" counts as 0.
  - **Guessing floor:** 1/k for a single-answer MCQ, 0.5 for true/false.
  - **Older evidence fades:** uncertainty grows 0.01 logit² a day, the counterpart of the reviews' 0.9^k weighting of the last 8 answers.
  - **Question difficulty** is pooled across members, starting from features (answer type, level, generator difficulty, marks).
  - **Why not a plain percentage:** once follow-up adapts, weaker members get easier items, and percentages drift to the target rate. In a synthetic check, raw percent found 71% of truly weak topics and the model found 92%. The data was model-generated, so this shows the mechanism, not real-world accuracy.
- **Labels, shown with counts ("1 of 4 right"), never a raw number (Epo, 2026-11-03):** Khan Academy's names, except that "Needs practice" stays.

| Label | When |
|---|---|
| Not started | No answers yet |
| Attempted | Fewer than 3 different questions answered (was "Too early to tell") |
| Needs practice | 80% sure success is under 60%; clears only below 50%, so it doesn't flicker |
| Familiar | Between Needs practice and Proficient (was "Getting there") |
| Proficient | 80% sure success is over 70% (was "Strong") |
| Mastered | Proficient, and still right on a later check (a question days afterwards) |

  - Colours: Attempted outlined, Needs practice amber, Familiar blue, Proficient green tint, Mastered solid green. Practise buttons and the Members "Needs practice" column follow Needs practice.
- **Memory** stays FSRS recall, shown apart from mastery. Self-rated flashcards feed memory only.
- **Tables:**
  - `workspace_topics`, `question_topics`;
  - an append-only `answer_events` log, which keeps partial credit (`review_log` drops it);
  - `member_abilities`, `skill_states`, `item_stats`.
- Rows update in the same transaction as each graded answer. A replay rebuilds a workspace after a retag or regrade.
- **Start logging `answer_events` now,** whatever else is decided. There is no learner data to tune on yet: the bank pilot holds only AI blind-solve results.

## 6. Personalised follow-up

**How others do it** (R2 §4, R1 §9.6):
- **Sparx:** homework is 60% new topics and 40% consolidation from about 3 and 10 weeks earlier.
- **Labels that drive the next step:** IXL's five recommendation labels, and Century's "Focus for Improvement" with a symbol saying why each item was added.
- **Teacher review:** Wayground teachers review AI changes before publishing. Khanmigo suggests assignments for the teacher.
- **Kahoot** builds a quiz from difficult questions.
- **Target difficulty:** Math Garden lets children choose about 60, 75 or 90% expected success.
- **Interleaving** helps maths but not vocabulary.

**Suggestion:**
- **A topic review session** on top of today's review sessions:
  - 70% on one or two focus topics, 30% on one interleaved topic.
  - Within focus topics, half are practised items ranked by today's FSRS score. The other half are unattempted items near 75% predicted success, with at most 20% harder "challenge" items.
  - Skip items whose key the member saw in the last 24 hours.
- **When the pool runs short,** the agent writes 3–5 variants in the background after a session, into a hidden per-member practice quiz.
  - Checks before saving: overlap with the original, reused answers, item-writing flaws, and a blind solve without the key.
  - A variant is never served twice to the same member within 30 days.
  - Items reserved for an open test stay out until it closes.
- **Approval:** none for a member's own practice. Owners approve class-wide follow-ups and anything graded.
- **Mock:** F1 (focus card and session start).

## 7. Practice quizzes vs assignments

**How others do it** (R4 §1–3):
- **Two ways to split practice from graded work:**
  - a separate mode or type: Wayground's Practice/Testing modes, Microsoft Forms practice mode, Classroom practice sets;
  - settings on the same quiz: Moodle's deferred feedback, Canvas New Quizzes, Gradescope.
- **What the split means:** practice gives instant feedback and retries. Graded work holds feedback back, limits attempts, has dates, and has a release step.
- **The timer, almost everywhere:**
  - Each student's clock starts at Start and never pauses.
  - Time-out submits what is saved.
  - A close date cuts the clock short.
  - The server has to close attempts itself, because a closed tab can't submit.
- **Two release gates elsewhere:** what the review shows, and when the grade reaches the student (Canvas posting, Classroom Return). Capy has neither (Epo, 2026-11-02): marks show on submit.
- **Anti-cheating on the web is signals, not prevention.** Exam.net and Wayground report tab exits; Canvas says its logs don't prove cheating.

**Suggestion (MVP; later items in R4 §2):**
- **No exam kind.** "Before you start" appears only because an assignment has a time limit: starting starts the timer. Untimed assignments open straight away. The dialog shows just the time limit, large with a clock, and "12 questions · 40 marks". Attempts, due date, saving and marks are left out because they don't help at that moment.
- **Written answers** on the timed page use today's quiz style: ruled lines, as on exam paper (`ruled-lines`), not a boxed textarea.
- **"Bookmark"** (Epo, 2026-11-03; it was "Come back later", and before that "Flag", which read like reporting a question) only marks a question for the member to return to. It's shown on the question's square and isn't recorded anywhere else.
- **Submitted** shows the mark so far ("Your mark so far: 27 / 30") and how many answers marked by AI wait for the owner, with links to Home and See results. **Results** keeps the mark at the top right. Below the title, after a gap, one row has the right/partly/wrong counts on the left and "Practise again" on the right.
- **Roles stay owner, editor and viewer.**
  - Members who only study are viewers: no Upload and no Make a quiz from a file.
  - Editors get the same Upload and extraction as the owner.
  - In a classroom, students are viewers.
- **Two states only, Draft or published (Epo, 2026-11-02).**
  - "New assignment" (A1) has a **"Draft only"** switch, off by default (Epo, 2026-11-03), so the assignment can be submitted as soon as it is created. With the switch on it is a draft.
- **Quizzes for assignments are hidden from members (Epo, 2026-11-03).** A quiz made from files, and the mark scheme and answer files uploaded with it, start **Hidden from members**: only owners and editors see them. Members meet only the assignment's frozen copy, during their attempt and in their results. The owner can show the quiz to members later, for example as practice after the due date.
  - Shown as a "Hidden from members" chip in the quiz editor (X2), a footnote in the Make a quiz dialog (X0b), and an eye-off mark on the owner's file cards. Members' Dashboards don't list hidden files.
  - Others: Canvas quizzes stay unpublished and question banks are teacher-only; Moodle activities stay hidden until opened; Classroom's Forms quizzes belong to the teacher until assigned.
  - **Needs an authorization change:** today a workspace material has no visibility of its own and follows the workspace (`authorization-permissions-lifecycles.md`). This adds one per-material flag that hides it from viewer members.
- **Assign to (Epo, 2026-11-03; A1, A1b).** New assignment has an Assign to field, beside Attempts.
  - **All members** is the default, and it includes anyone who joins later (as Classroom's "All students" and Teams' "All students" do). It covers viewers only; editors aren't assigned.
  - **Picking names** fixes the list. The task and the notice reach only those members, and "x of y done" and the report count only them.
  - **Owners and editors are left out** unless they tick themselves ("You" at the bottom of the list). The same goes for plain tasks.
- **The owner's To do shows what is for her (Epo, 2026-11-03; H1, H3):** approvals and anything she assigned herself. Like Classroom's To review and Canvas's teacher To Do, a teacher's own list holds review work, not the class's work.
- **Profile lists share one grid (Epo, 2026-11-03):** Assignments and Topics on a member's profile are flush left, with the same row height and columns.
- **Section titles vs column headers (Epo, 2026-11-03).** When a table sits right under a section title that repeats its first column ("Assignments" over "Assignment"), drop the header row and let the cells say what they are ("14 / 20", "Submitted 28 Oct"), as on Cara's profile (G2). Gmail, Linear and the Notion list view have no header row at all. Where the columns need names, the first column header can be dropped or made generic.
- **The report's Members tab (G3m).** One row per member the assignment went to: when they submitted, how long they took, their mark, and how many marks still wait for approval. Members who haven't submitted say Missing. A row opens that member's answers, laid out like their Results, where the owner can change any mark.
  - Lists show no status for published assignments, only a "Draft" label on drafts. There is no Scheduled, Open, To review or Released status, and no separate "Open for submissions" step: A6 is removed.
  - Rows carry plain facts ("Due Fri 7 Nov", "5 of 6 submitted", "4 open answers to review") and actions (Review).
  - The Study header button is "New assignment".
- **An assignment** is a frozen copy of a quiz, with:
  - assignees (every member) and opens, due and close dates;
  - an optional time limit enforced by the server, and one attempt;
  - optional question shuffle;
  - no feedback during the attempt;
  - marks shown on submit, plus a "show answers after submitting" switch.
- **Per student:** extra time and moved dates; excused.
- **Late and missing:** late is only a flag. Missing counts 0 after the due date, if Epo agrees.
- **Grading:** a queue for open answers, where the teacher can override any part with a comment. Regrade one question for everyone after a key fix.
- **The frozen copy matters** because students can reach a workspace quiz's keys today. Checking returns the key, viewers can clone and keep keys, and editors can open the editor. A test is served only from its frozen copy.
- **Data:**
  - `assignments`, and `assignment_overrides`;
  - `attempts` gains `assignment_id`, a server deadline, a submit time, auto-submitted and a status (in progress, grading, needs review, graded);
  - `attempts` also gains `workspace_id`, which it lacks today.
- **The gradebook** is computed on read.
- **Mock:**
  - A1, the Assign dialog;
  - A2, taking a timed test;
  - A3, the report's Approve AI marks tab, where the owner approves or changes AI marks.

## 8. Questions from uploaded files

**How others do it** (R3 §1):
- **Extraction works on pages, not regions:**
  - Formative unticks pages, then rebuilds them with a vision model, up to 20 or 25 pages.
  - Microsoft Forms and Pear Assessment take whole files.
  - Only Gradescope and Pear SnapQuiz use regions, and both are drawn by hand.
- **Complex types get downgraded:** Forms turns matching into open text, and Pear extracts only MCQ and true/false. Nobody documents multi-part questions.
- **Nobody pairs a separate mark-scheme file automatically.** Exam platforms curate schemes by hand. Mindjoy reads one only from the same file.
- **The best review pattern** is Microsoft's three flag groups (missing content, uncertain conversion, unsupported type), each with "Resolved".

**Suggestion (R3 §2):**
0. **The Make a quiz dialog (Epo, 2026-11-03; X0a, X0b).**
   - **Question paper:** picked from the workspace's files or uploaded new. An upload takes the normal upload and reading path and is saved to Files. The page picker opens once its pages are ready.
   - **Mark scheme or answers (optional):** any number of files, from Files or uploaded the same way. They aren't page-picked.
1. **Page picker (Epo, 2026-11-02).** Pages are shown large. One click selects a page for extraction, and pages left unclicked are skipped. There are no per-page tags or buttons. The extra files chosen in the dialog show as one chip ("With a mark scheme and an answers file"). The footer shows the page count and the credit cost. The number of selected pages per run is capped (see "Context and the page cap" below). PDF and Office files, the latter through captured page images.
2. **Outline** from the already indexed text. The expected question labels give a completeness check.
3. **Extract** with a vision model and tool calls (`record_question`, `continue_question`) over windows of up to two pages.
   - The Go validator checks each call straight away, and problems go back to the model.
   - Printed option order is kept.
   - Figures snap to the parser's image boxes and become crops.
4. **Pair the mark scheme and answer files by question label in code;** the model only parses their lines. They fill correct answers, marking points and worked solutions.
5. **Blind-solve** to write worked solutions only where the paper has none. These are labelled AI-written.
6. **Saved straight away as a quiz (Epo, 2026-11-02).** There is no separate review screen. Extraction ends by opening the new quiz in its editor (X2). The editor is today's question edit dialog laid out as a page, with a plain question list on the left, and has no source panel. Problems show as the quiz's normal issues (`IssueSummary` / `IssueIcon`, e.g. "Image: choose an image file"), never as extraction flags.
7. **No source is stored (Epo, 2026-11-02).** A saved question keeps no link to its file, page, region or mark-scheme page, and generated questions keep no "written from" file. The page is shown only while reviewing, read from the uploaded file. This drops R3's "save with provenance" and R2's `question_origins` table.

**Context and the page cap (Epo, 2026-11-03: cap the selected pages, and plan for the context window):**
- **Each model call sees a small window,** not the whole selection: two pages as images, the outline (expected question labels from the indexed text), the question it is in the middle of (for questions that run across pages, `continue_question`), and the tool schema. With page images at a few thousand tokens each, a window stays far under the context limit however many pages are selected.
- **What grows with the page count** is time, cost and the carried state: the outline and the list of questions recorded so far. Questions are saved as they come, so the state carried into each window is labels and the open question only, never the earlier pages.
- **Mark schemes and answer files don't go through the windows.** They are parsed on their own as text and paired with questions by label in code (step 4), so they never sit in the same context as the pages.
- **So the cap is about one run's time and cost.** A past paper is usually 12–32 pages. **Decided (Epo, 2026-11-03): up to 40 selected pages per run,** roughly 3–6 minutes as a background job. A longer file is done in another run into the same quiz, and the page picker shows the count against the cap.
- **Office files:** windows use the page images captured on the server (or rendered by the client, if DOCX pagination can't match). Saved edits go in as text, the same way.

**Page sources by file type (2026-11-03).** Source files can be 10 MiB (Free) or 30 MiB (Pro), and images 2 MiB, so text files need a length cap as well as a file cap.

| File | What the picker shows | What a selected item sends |
|---|---|---|
| PDF | Its pages | The page image and the page's indexed text |
| Images (photos, scans) | One page per image; several images can make one paper | The image |
| PPTX | Slides | The slide image and its text |
| DOCX | Pages as BetterOffice lays them out in the browser | The page's content range (first and last paragraph) plus a page image (see below) |
| Markdown, text, Capy notes | Sections by heading, or about every 3,000 characters without headings (Epo agreed) | The section's text only, no image (cheaper) |
| XLSX, CSV | Not offered at first | — |

- Every page, slide, image or section counts as one toward the 40 per run.
- **Files per run: up to 10 (Epo, 2026-11-03).** A paper can be several images (a photographed worksheet). Mark schemes and answer files sit outside the 40.
- **Why Word pages can differ:** a DOCX file stores flowing text, not pages. Page breaks are worked out when it is displayed, from fonts, line breaking, tables and section settings, so Word, LibreOffice and BetterOffice can break pages differently, and so can the same engine with different fonts installed. PDF pages and PPTX slides are fixed. If the backend lays the document out differently from the browser, "page 7" can point at different text.
- **The fix:** the browser sends each selected page as a content range (its first and last paragraph), which doesn't depend on pagination. For the image, the backend uses BetterOffice's own layout and rasteriser (`betteroffice-docx`, the same Rust core as the browser) with the same bundled fonts; if that still drifts, the browser uploads the page images it already drew.

**Cost and time:**
- **Estimates:** about 90–180 credits for a 12-page paper with an 8-page scheme, and about 140 for a 3-page worksheet that needs solving.
- **Plan credits:** the Free plan has 200 a month, so its users can extract one or two papers a month.
- **Speed:** 1.5–3 minutes, so it runs as a background job.

**New pieces:**
- an extraction tool shape (`add_questions` is single-part and shuffles options);
- figure crops, draft storage and the review screen;
- an extraction bench.

**Formats Capy can't hold yet:** level-based marking, "any n of m", and method/accuracy marks.

**Mock:** X0a and X0b (the dialog), X1 (pick pages), X2 (the saved quiz in its editor).

**After the first cut (Epo, 2026-11-03; branch `claude/study-extraction`, bench `bench/extraction/reports/2026-11-03-first-cut.md`):**
1. **AI-marked parts:** the cap of 20 open parts a quiz goes up to 100, and the UI calls them "AI-marked parts". The quiz editor shows the count while questions are added or edited, for example "34 of 100 AI-marked parts", so a full past paper fits in one quiz.
2. **One prompt gets the questions and their answer keys.**
   - The page-window call records every part's correct answer and a worked solution: copied when printed, otherwise worked out and marked as AI-written.
   - A mark scheme or answer file, when given, still replaces worked-out keys by label.
   - No question is left out for lack of a key.
   - The full prompt and the proposed change are in `todo-study-tracking/R6-extraction-prompt.md`.
3. **Hidden from members** is decided (see §7 and mocks X0b and X2) and gets built now. The extracted quiz and its source files start hidden.
4. **Model:** extraction and grading use the pinned DeepSeek V4 Flash 0731 through OpenRouter (`deepseek/deepseek-v4-flash-0731`), the cheaper 07xx model. They don't use the chat's direct DeepSeek (`deepseek-flash`), which costs more. Extraction gets its own model slot. Check that the 0731 pin takes page images.
5. **Failures, billing and caps:**
   - The server retries a failed step once, silently, through the existing job queue. The user sees only progress, and a final error if it still fails.
   - Billed as Generate.
   - Answer files count toward the 10-file cap.

**Round 2 result (2026-11-03; `claude/study-extraction` 88eafcda7, f3965ce54, 8da4c2ad1; `bench/extraction/reports/2026-11-03-keys-in-one-prompt.md`):**
- **Built:**
  - AI-marked parts are capped at 100, with the count shown under the editor title.
  - Hidden from members: lists, opening, live rooms, retrieval and clone all respect it, the ⋮ menu toggles it, and the chip shows in the item header.
  - One prompt records questions and their keys, one call per question.
  - One silent retry, in-process, because the retrieval service has no job queue.
- **0731 can't read images:** OpenRouter lists it as text-only, and an image request returns 404. So extraction stays on the direct `deepseek-flash` until Epo picks a vision model. The 1017 pin reads images but forces reasoning off.
- **Keys worked out by the model:** Paper 2 MCQ 175/180 (97%) match the official keys. Paper 1 final answers match in 107/108 (checked by hand). Part marks match in 99/108. Every label is found and every question saved.
- **Cost:** mid thinking costs 2–3× the first cut. Paper 2 is 108–145 credits and 200–280 s; a 40-page run is about 250–350 credits, about a Free month (300 since 2026-10-30).
- **Open for Epo:**
  - Pre-existing files used in a run get hidden too. The plan said only files uploaded with the quiz. **Decided (Epo, 2026-11-04):** only files uploaded in the Make a quiz dialog start hidden; a picked workspace file keeps its setting; the quiz still starts hidden. Being built on `claude/study-extraction`.
  - 1-mark parts are typed short (auto-marked) where the paper's gold has open. **Fine (Epo, 2026-11-04).**
  - An editor's clone copies hidden items as visible.
  - A full 100-part submission makes 100 grading calls, 5 at a time.
  - Migration renumbering and figure crops are still to do.

**Content check (2026-11-04).** The bench scored labels, keys and marks, not the content itself. Reading the 1017 outputs:
- **Formulas** come out as LaTeX between $ signs and read right in the samples, but nothing has compared them with the page.
- **Figures** are found (10/10 gold figure questions on 2022 P2, 2/2 on 2021 P1) but never cropped, so a saved question says "In the figure…" with no figure.
- **Options twice:** 7 of 45 MCQs in one 2022 P2 run repeat their options as an "A. … B. …" text block as well as the option boxes.
- **Tables** become table blocks, but none of the three papers has one.
- **Being built on `claude/study-extraction`:** figure crops saved as the question's image, a check of box accuracy on every crop, a text check of stems, options and schemes against the page's text layer, a paper with a table, and options removed from the text in code. Report: `bench/extraction/reports/2026-11-04-figures-and-fidelity.md`.

**Figure boxes from ingest (Epo, 2026-11-04: plan it; a couple of figures dropped here or there is fine).** Make a quiz is a normal upload: parsed, chunked and indexed, then extracted, and extraction refuses a file not yet indexed. Today the figures come from the model alone: the batch call names each figure, then a call per page with figures, seeing that page alone, returns the boxes, and code pads and crops them.
- **Born-digital PDFs and Office files:** the parser already reports every picture and chart with its box on the same 0–1000 grid, but ingest throws the list away. Chunks keep a figure's box only when the figure has caption or label text, and not which box is the figure.
  1. **Ingest** keeps each figure the parser reports, with or without text: page, box, picture or chart, and caption and label text, in a small per-file list. This is the PC's area under the machine split.
  2. **Extraction** gives each batch call the numbered figures on its pages. The model names the figure a question uses, and code crops the parser's box: no box call, and exact for embedded pictures.
  3. **Fallback:** pages with no parser figures keep today's box call.
  - **Check first:** how the parser boxes diagrams drawn as vector paths (Cambridge and other digital papers), on one or two such papers.
- **Tested before building (Epo, 2026-11-04): the box call works on born-digital pages too.** On 26 figures from three Cambridge IGCSE specimen papers (maths, physics, biology; vector drawings and photographs), it gave 22 and 21 of 26 whole after the pad, none missed, nothing from the next question, at $0.0006 a paper. Every miss is a label outside the drawn lines. So keeping the parser's boxes at ingest isn't needed; a layout model is being benched on the ingest host against the same figures (`claude/bench-layout-figures`).
- **Layout model wins (2026-11-04, `claude/bench-layout-figures` f278ae3ca, `bench/extraction/reports/2026-11-04-layout-models.md`).** Run on the ingest host in a throwaway container, removed afterwards.
  - **PP-DocLayout_plus-L** (Apache-2.0 weights, PaddlePaddle's ONNX export under onnxruntime) found all 40 gold figures. 1017 picks the right numbered box: 26 of 28 on scans and 26 of 26 born-digital, with reasoning off, at about $0.009 for 128 calls.
  - **Crops:** 76 of 80 whole and 72 tight, against the box call's 64 and 42. The one wrong pick is Q14, where the outer box with the options was chosen over the tight one.
  - **Cost to run:** 0.22 s a page at 8 threads, 0.55 s at 2; 540 MB peak memory; about 165 MB of runtime plus a 130 MB model.
  - **Captions:** every model leaves a chart title or a "Figure 1" caption outside its box; taking in an adjacent caption box fixes it.
  - **Proposal:** run it at extraction time on the pages with named figures, inside retrieval, with the box call as fallback.
  - **Open for Epo:** where it runs (retrieval or ingest), the memory in UAT's 1.5 GiB retrieval limit, and keeping captions in crops.
  - **Where it runs (Epo, 2026-11-04):** on the ingest host, one pool with one queue for UAT and production together, no split between them (UAT's use should be minimal). Two instances if the capacity test supports it (`bench/extraction/reports/2026-11-04-layout-capacity.md`, in progress). Not built; the ingest host is the PC's area.
    - **How parsing queues today:** the queue is the `parse` rows in each environment's own database. Coordinator children claim them and wait on the parser. The parser is the only shared limit: past its depth it answers 429, and the coordinator returns the job to `pending` and tries again after 2 s. UAT and local share one parser; production has its own project.
    - **Proposal, the same pattern:** a small stateless service on the ingest host's WireGuard address (page image in, boxes out, nothing stored), outside both Compose projects so both environments reach one pool, with a depth limit and no queue of its own. It answers 429 when full, and the extraction run that sent the page waits and tries again. Each request is one page, so runs interleave page by page.
  - **Q14's wrong pick (checked 2026-11-04):** the model labels both boxes `image`, the outer at 0.62 and the tight one at 0.56, and it also labels the four options inside the outer box as `text`. Proposed rule: drop a picture box that holds a smaller picture box plus text regions of its own. On the 59 pages it drops only that one box; the two figures whose labels are read as `text` have no box inside them, so they stay. Small sample, not built.
  - **Matching figures to questions without a call (checked 2026-11-04 on saved results):** when a page has as many picture boxes as named figures, take them in reading order. That gave 38 of 40 figures, none wrong, on 30 of 32 pages; the other 2 pages have more boxes than figures and would ask DeepSeek. This used the gold figure lists in place of the window call's own names, so it needs a real run. Proposal: order first, the picking call only when the counts differ, the box call when there's no box.
  - **Layout first (Epo, 2026-11-04; being tested):** run the layout model on every selected page before extraction, and give each batch call that window's numbered boxes, so it extracts the questions and selects each figure's box in one call. No separate naming, locating, picking or matching. The model decides from the question and figure together, so count traps don't apply. Each batch call gets the clean page images plus the boxes as JSON (number, page, 0-1000 coordinates, label, score), with nothing drawn on the page (Epo). Report: `bench/extraction/reports/2026-11-04-figure-matching.md` (`claude/bench-hosted-figure-boxes` 5700f09fd).
    - **Result:** best on whole and tight, with no extra call. Whole / tight / both of 80: window pick 76 / 73 / 70; order matching 73 / 70 / 67; always picking on the same names 73 / 68 / 65; today's box call 62 / 42 / 37. It picked the right box for 148 of 149 named figures, and 70 named crops on 26 new pages were right and whole by eye. Reading didn't change measurably: labels identical in all 42 runs, none lost. Slightly cheaper than today ($0.172 against $0.182 for the 10 papers). No run went through the gateway, and all papers are English and one-column.
    - **Order matching isn't the choice:** real runs never gave a wrong box, but a replaced or reordered name goes wrong with nothing to flag it.
    - **Decided (Epo, 2026-11-04):** build it, with a 1% pad plus an adjacent caption on these crops; `FIGURE_PAD` stays for the box call only. Being built and tried on `claude/study-extraction`.
    - **Prompt (Epo, 2026-11-04):** keep exactly the version this test ran with (`figure_windows.py` at 5700f09fd), including "a few page images", `lead_in`, the `\$` rule, the MCQ line, the page headings and the box-call prompt. No prompt change without telling Epo first.
    - **Paper map, then parallel batches (Epo, 2026-11-04; being tested, `bench/extraction/reports/2026-11-04-paper-map-parallel.md`):** a first call X reads the whole paper and answers a plain-text map; X's reasoning and answer stay in the thread; batches y1, y2, y3 are X plus "record these questions", sent in parallel so they share X's cached prefix. Each whole question goes to one batch, so there's no `continue_question`. Open: whether Epo wants it built.
      - **Result (`claude/bench-hosted-figure-boxes` 25190f9fb):** ten papers, two runs each, at 8 questions a batch against the window pick: 935 s against 1,912 s, $0.188 against $0.172, figures 72 / 70 / 66 of 80 against 76 / 73 / 70 (74 / 72 / 68 with left-out figures filled from the map). At 39 pages: 218 s against 595 s, $0.0656 against $0.0484. The cache hit at 98.8% or more on every first round, in parallel, with no staging; a y on another provider got none. The map was right on all 2,491 rows checked.
      - **Costs:** each y re-sends the whole paper: 1.65 MB a call at 16 pages, 5.97 MB at 39; 102-108 MB uploaded a run at 39 pages; process peak 408 MB. OpenRouter refused a 59 MB body. Up to 8 calls in flight per run.
      - **Building it needs:** figures a batch leaves out filled from the map, 12 rounds a batch, the new label wording, a check for gaps in question numbers with a repair batch (not tested). 2022 P2 Q34's lost zero isn't fixed; a planted missed question is lost unless the gap check catches it.
    - **A second depth in the quiz (Epo asked, 2026-11-04):** today a question is a stem and a flat list of parts, and about 20 source files in Go, TypeScript and Rust plus the shared fixtures read that list. Real nesting touches validators, scoring, grading, live quizzes, attempts and review items. Proposal: parts stay the flat unit for answers, marks and review, and a part may name a group that holds its printed label and text, so only the validators, the view, the editor and the live quiz change. No legacy data. **Decided (Epo, 2026-11-04):** grouped parts, stay flat, no nesting. A group has a label and text but no answer or marks; one level only. Look (Epo, 2026-11-04): G1 on board U2, canvas page 10, with sub-parts a small step in (16px) on larger screens and no indent on phones. Built on `claude/study-grouped-parts` (2fd3e297b, from `study-ui-pieces`): `groups` on the question and `group` on a part, in all three validators, live rooms, view, editor, index text and review hash. CI still has to confirm the Go DB tests and e2e. Extraction's part changes the prompt, so that wording goes to Epo first.
    - **Differs from board U2, awaiting Epo:** the results rows keep the existing answer review; the editor keeps the real outline-and-preview dialog; the question number stays "12." instead of "Question 3"; rows are 24px apart; sub-part text stays in the parent's column.
    - **Told to Epo:** the grading text gains "Shared context:" for grouped parts, and `inspect_document` shows a grouped question to the agent as stored JSON; ungrouped questions send the same as before.
    - **Built on `claude/study-extraction` (b2c52c5a2, `bench/extraction/reports/2026-11-04-layout-first-trial.md`), not deployed and not run through the gateway:** on the ten papers, 37 / 36 / 34 of 40 crops against the test's 38 / 36.5 / 35; failure paths finish with nothing lost. `trailing_text` fixes the sentence at a batch edge (9 of 9 right, against the old prompt's invented part in 8 of 9). The "digit for digit" line doesn't fix Q34; the misread is in the page read. Open for Epo: `continue_question` accepting any question from its own window, removing the held text from the open question, removing the digit line.
    - **Defects:** a re-record erasing parts, and options repeated as unlettered lines, are being fixed in code. The field for a sentence lost at a batch edge and the "copy options as printed" line change the prompt, so they wait for Epo.
  - **Hosted models compared (2026-11-04, `claude/bench-hosted-figure-boxes` 90587d521, `bench/extraction/reports/2026-11-04-hosted-figure-boxes.md`):** no hosted model beats the layout model by more than noise. Whole / tight / both, of 80: layout model 76 / 72 / 68; Qwen3-VL-30B with ink growth 78 / 73 / 71; GLM-4.5V with ink growth 73 / 78 / 71; DeepSeek box call with today's pad 63 / 40 / 36, and with ink growth 68 / 64 / 56.
    - **Model Studio, after Epo's key change (c37a8c95d):** `qwen3-vl-plus` with ink growth 71 / 76 / 67; `qwen-vl-ocr` boxes the whole question, not the figure (78 / 10 / 10); Qwen3-VL-30B with `advanced_recognition` text lines 80 / 68 / 68, at two calls a page. None beats the layout model on both.
    - **Not tested:** Gemini (OpenRouter answers 403, "violation of provider Terms Of Service", on every Google model). Azure Layout needs a key.
    - **Mistral OCR through OpenRouter:** returns crops without coordinates, splits figures and drops captions.
- **Decided (Epo, 2026-11-04):** a failed box call or a full quota saves the quiz without those figures, named in the report (`figuresLeftOut`). The top pad stays, and wide figures stay clipped for now (`claude/study-extraction` 34de172f4).
- **Scans** have no parser figures: every page is one picture, and the page read returns text only. All four bench papers are scans. They keep the box call.
- **Scans, the options:**
  - **S1 (today):** the box call, one per page with figures: the same model, that page alone, reasoning off, the box padded. 12 of 14 bench figures came out whole. No new parts.
  - **S2:** a layout-detection model on the ingest host finds figure regions on text-less pages during the normal ingest and stores them in the same per-file list, so scans and digital files work the same. Exact boxes and no model cost, but it's a new model on the shared ingest host (the PC's area), to bench against the 14 gold boxes first.
  - **S3:** the page read at ingest also returns figure boxes in the same call. No extra call, but boxes asked beside other work were worse (the batch call's own boxes missed 3 of 10), and every scanned page's read prompt changes.
  - **Recommendation:** S1 now, since a few drops are fine. S2 if drops turn out frequent on real uploads.

**Batch size (2026-11-04, `claude/study-extraction` 0bf07a705, `bench/extraction/reports/2026-11-04-window-size.md`):** 48 runs at 1, 2, 3, 4, 6 and all pages per call, plus 14 on a paper whose questions cross pages, for $0.84.
- **Result:** one call reliably records 12 questions (largest reply 14,931 of 24,000 output tokens). 13-17 is unmeasured, and an 18-question reply reached 90% of the cap. The real limit is tokens: reasoning is about half the output.
- **Recommendation:** keep 2 pages a call. Keys and marks don't move with size, and cost is flat from 2 to 6 pages. 6 pages lost three questions in one run; one window with all pages named no figures in 1 of 2 runs.
- **Found, not fixed:** options repeated as plain unlettered lines; a sentence before a sub-part on the next page lost at a window edge; a re-record inside one window silently replacing earlier parts (one run lost Q1's a(i) and a(ii)); one question split in two; printed options rewritten to fit a misread number (2022 P2 Q34).
- **Needs Epo's sign-off, built without a recorded decision:** repeated-stem removal, the `lead_in` field, `schemeRepeats`, the `\$` rule, the locate call replacing window boxes, and the side and bottom values of `FIGURE_PAD`.

**Upload: everyone or hidden from members (Epo, 2026-11-04; canvas page 10, board U1).**
- **Scope:** owners and editors choose, when uploading, whether members see the file. Hidden works as the ⋮ menu's Hide from members does: viewers don't see the file in Files, search, the agent, Activity or any notification; owners and editors see it with the eye mark.
- **Default:** everyone, as today. Uploads inside Make a quiz start hidden.
- **Picked V1 (Epo, 2026-11-04):** a "Who can see it" dropdown under Topic, "Everyone in the workspace" or "Hidden from members" (V2 two buttons and V3 a footer switch not chosen). The file row is created hidden, one upload flag shared with Make a quiz. Being built on `claude/study-extraction`.
- **Leak paths checked:**
  - The Dashboard's Activity query (`store/dashboard.go` on `claude/study-shell`) doesn't filter hidden items yet. The shell branch predates the `hidden` column, so whichever branch lands second adds `workspace_item_visible` there.
  - There are no upload notifications today (only invites, role changes and removals). Assignment notifications, when added, skip hidden items.
  - Tree events carry no names. Ingest events carry the file id to every member's stream, which is harmless because the list refetch filters it.


## 9. Grading open answers

**Today** (R5 §2, R3 §4):
- Jev (typesafe.ai, pinned jev-1.13.0) makes one call per open part and marks each marking item zero, partial or full.
- It matches 93.8% of items exactly, costs about $0.00005 a part and takes 0.66 s.
- It is not deterministic: 5 of 116 decisions changed on a repeat.
- Usage is recorded but never charged.

**How others do it** (R3 §3):
- **School grading tools keep a teacher in the loop:** CoGrader, Brisk, Teams and Markit need approval before students see a mark. Gradescope adds regrade requests. Markit ties each mark to a scheme line and puts low-confidence ones first.
- **Save My Exams' instant marking** avoids calculation questions.
- **Prompt injection measurably raises LLM grades** in published studies.

**Suggestion:**
- **Bench before switching:** add a DeepSeek adapter to `bench/grading` and rerun the Jev contract fixtures, plus held-out, injection and Traditional Chinese answers (about $1–7). Jev's contract says to change it only after a new bench run.
- **The grader's design:**
  - JSON output where each partial or full mark must quote words that appear in the answer, checked in code, so "give me full marks" earns nothing;
  - marks computed on the server;
  - temperature 0 without thinking first;
  - cached per answer;
  - two extra samples only on borderline items.
- **Cost:** about 8–70× Jev, $0.0004–0.003 per part, so charging or caps must be decided first.
- **Risks to weigh:**
  - DeepSeek exposes only alias model ids.
  - It refuses some politically sensitive content, which matters for HKDSE History and Citizenship.
  - Answers from minors would go to a China-based provider.
- **Grading (Epo, 2026-11-02; approval brought back 2026-11-03): DeepSeek marks open answers on submit.**
  - **Practice:** members see AI marks at once.
  - **Assignments:** an AI mark reaches the member only after the owner approves it. Questions with one right answer are still marked at once, so Submitted shows the mark so far, and results show "Waiting for Ms Wong" on the held answers.
  - **Where approval lives:** Study → Assignments → the assignment → the **Approve AI marks** tab (A3). The Assignments list row says "5 AI marks to approve" (W2), and "Check the AI's marks" under each question in the report opens the tab.
  - **Links (Epo, 2026-11-03).** Every view of a report has a link:
    - `/workspaces/{workspace}/study/assignments/{assignment}`: the report, Questions tab;
    - `?tab=members`: the Members tab;
    - `?tab=approve`: Approve AI marks, at the first waiting answer;
    - `?tab=approve&question={question}`: one question's answers;
    - `?tab=approve&question={question}&member={member}`: one answer;
    - `?tab=approve&member={member}`: that member's first waiting answer. Approve then steps through their waiting answers, switching question as needed. The Members tab's "2 to approve" opens this.
    - **One layout for all of these (Epo, 2026-11-03):** A3, the question dropdown with the member list. There is no separate by-member design.
    - Unknown ids fall back to the first waiting answer, as `parseWorkspaceOpenSearch` clears bad keys today. Approve on Home, on the Dashboard task and in notifications all use these links.
  - **In the tab:** pick the question, then go through the members. Rows waiting show "AI 3 / 6"; approved rows show just the mark. Approve moves to the next one, Approve all clears the question, and changing a mark approves it too.
  - **Words (Epo, 2026-11-03):** the tab is named for what the owner does there, **"Approve AI marks"** (it was "Open answers", then "Marked by AI"). "Open answer" stays only as a question type.
  - **Switch (Epo, 2026-11-03):** New assignment has "Approve AI marks before members see them", on by default, under Published (A1). Turned off, AI marks reach members at once, as in practice, and the assignment never shows marks to approve.
  - **Reminders (Epo, 2026-11-03, D1 and H3 on page 3):** besides the Assignments row, waiting marks show in three places, each only while something waits:
    - the app's Home gets a **To approve** list across workspaces, one row per assignment with Approve (Canvas lists "Grade …" in the To Do on its Dashboard; Classroom has a To review list across classes);
    - the workspace Dashboard's Tasks start with an owner-only task, "Approve AI marks on [assignment]", that ticks itself once nothing waits;
    - the bell gets one notification per assignment, not one per answer (Teams posts submissions to the activity feed).
### Grading prompt, round 2 (2026-11-03, after the DeepSeek bench)

**Bench round 1** (`claude/bench-deepseek-grading-4a344d`, `bench/grading/reports/2026-11-03-deepseek-grading.md`). Share of 1,946 items marked right:
- Jev: 88.9%
- 0731: 91.6%
- direct Flash: 93.7%, or 95.0% with a thinking second sample on flagged parts.

0731 is too lenient: 88 unearned marks against Flash's 49.5. That comes mostly from maths (right answers with wrong working), DSE Chinese (answers that only quote the passage) and IELTS (pasted paragraphs).

**What round 1 sent:** the question text, the marking-scheme lines with their marks, and the answer, with no reasoning before the choice. Today's Jev request sends the same. Neither sends the part's correct answers (`accepted`) or its worked solution.

**What others do:**
- RefGrader builds rubrics from reference solutions and grades in several steps; its single-step grading flagged wrong answers but couldn't calibrate partial credit.
- Handwritten-maths pipelines use solution keys, several scoring passes, consistency checks and a final human check.
- Graide learns each teacher's marking and checks the working line by line, not just the final answer.
- Gradescope's AI only groups similar answers for the teacher.
- Step-error research: models struggle to find a student's first wrong step even with a reference solution. Comparing step by step against a solution that follows the student's own route helps most.
- Exam boards: M marks for method, A marks for accuracy that need their M mark ("M0 A1 is impossible"), B marks on their own, and follow-through (ft). HKEAA uses M, A and ft.

**Round 2 prompt changes:**
1. **Send the reference:** the part's correct answers and its worked solution, labelled "for the marker; a different valid method earns the same credit".
2. **Maths and working:**
   - Check every step of the working, not only the final answer.
   - Find the first wrong step. Items before it stand, and later steps done correctly from a wrong value earn method marks but not accuracy marks, unless the scheme says ft.
   - An accuracy item needs its method item.
   - A right final answer with missing or wrong working earns no method marks.
   - A valid different method is checked on its own mathematics.
   - Maths parts always get thinking on (low), not only in the second sample.
3. **Reading:** an "explain" item is not earned by copying the passage without explaining it (DSE 只抄原文不給分). Copied or pasted text earns nothing where the scheme asks for own words.
4. **Keep:** quoted evidence, now matched tolerantly so LaTeX and punctuation differences don't zero right answers; the injection rules; one item at a time.
5. **Later:** an owner's approved or adjusted marks become examples for the same question.

**Bench round 2:** the same sets on 0731 and Flash, with and without thinking on maths, against round 1. Then pick the model.

**Bench round 2 result (2026-11-03; `bench/grading/reports/2026-11-03-deepseek-grading-round2.md`, commit 5166e1d9d).** Items right out of 1,946, then unearned marks:

| Setup | Flash | 0731 |
|---|---|---|
| Round 1 | 1,824 (93.7%), +49.5 | 1,782 (91.6%), +88 |
| Round 2 | 1,859 (95.5%), +28.5 | 1,824 (93.7%), +60.5 |
| Round 2 with the second sample | 1,870 (96.1%), +28.5 | 1,859 (95.5%), +49 |

Jev scored 1,730 (88.9%), +89.
- **Cost per part:** Flash $0.00063, 0731 $0.00024, Jev $0.000064.
- **Maths:** maths parts with thinking take 5–7 s at the median and 30–43 s at p95. Check needs about 60 s, and the thinking token limit should go up to about 16k.
- **What moved what:**
  - The working rules and thinking fixed maths: alternative methods now lose 1.5–2 marks instead of 10–15, and wrong working with a right answer gains 0–1 instead of about 10.
  - The quote-only rule halved DSE Chinese over-credit.
  - The reference block (correct answers and worked solution) made no measurable difference.
  - The tolerant quote match recovered every LaTeX item.
- **0731's remaining gap** is mostly pasted IELTS paragraphs (7 marks) and DSE Chinese and contract answers.
- **Tweaks before switching:**
  - limit the "explain" rule to items asking for explanation or own words;
  - limit the step rules to calculation and proof working;
  - drop the reference block unless it's free;
  - raise the thinking limit.
- **Recommendation (bench):** direct Flash with the round-2 prompt, thinking on maths and the second sample, with 0731 as the fallback when DeepSeek's API fails (needs Epo's sign-off).

**Bench round 3 (2026-11-04, `bench/grading/reports/2026-11-03-deepseek-grading-round3.md`, 404933989).** Answer rules ran as their own section: copying checked in code, own-words judged by the model.
- **Scores (items right of 1,946, unearned marks, cost per part):**
  - **V4.1 Flash on OpenRouter:** 1,877, +21.5, $0.00022, p50 1.1 s. That beats direct Flash round 2 (1,870, +28.5, $0.00063).
  - **0731:** 1,857 even with the second pass, still the most lenient, +47.
- **Copy check:**
  - Pasted IELTS paragraphs now score 0 for both models.
  - 12 of 15 DSE quote-only answers score 0 before any model call.
  - "Don't copy whole paragraphs" needs passage coverage; "don't just copy" needs the share of the answer copied. Thresholds need fresh answers before production.
- **Recommendation:** V4.1 Flash with the round-3 prompt, thinking on maths, no second pass. Confirm on the dated 1017 pin (running), so grading, extraction and captions share one model. Allow about 60–70 s for a maths check.
- **1017 confirmation (5d4c9b3e7).** On contract, maths, IELTS and DSE Chinese (1,149 items), the dated pin through InferenceNet scored 1,104 items with +16.5 unearned marks. That equals V4.1 on Wafer (1,104, +15) and beats direct Flash (1,083, +22) at $0.00032 a part.
  - **The cost is maths latency:** p50 11 s and p95 57 s, slowest 156 s, against Wafer's 5 s and 33 s.
  - **Decided (Epo, 2026-11-04):** 1017 is the one model for grading, extraction and captions, routed Wafer (`wafer/us`) → InferenceNet → Cloudflare with no other fallbacks. Never DeepInfra, except the Qwen embedding pin. Never direct DeepSeek.
  - **Then (Epo, 2026-11-04):** extraction gets its own route, InferenceNet → Cloudflare → `wafer/us`. In the Wafer check, extraction with thinking was worse on Wafer and one run ran away to 17× the cost. Captions, page reads and ghost text keep Wafer first; grading waits on the concurrency test. The credits price for 1017 is 200 / 20 / 1200 (input / cached / output micros per token, the highest of the three providers) for every use. Extraction also gets a guard against runaway output.
  - **UAT (2026-11-04):** the rate is live as `model_configs` version 4 of the 1017 row (version 3 at 160 / 16 / 1100 disabled; the registry version bumped, so the catalog picks it up within 10 minutes). The provider routes are code and reach UAT with the branch's deploy; the extraction slot needs migration 0138 first.

### Built-in grading rules (Epo, 2026-11-04; supersedes the per-question answer rules below)

No per-question rules section. Built-in rules apply to every open answer, and a word or character limit is a cap on the answer box (set on the part, enforced as the learner types), not a grading rule.

**Proposed built-in rules.** "Code" means checked before any model call; the rest go in the grading prompt.
1. **Copying (code):** an answer that is mostly the passage or question text, copied without selecting or explaining, earns nothing. Round 3: passage coverage for pasted paragraphs, the share of the answer copied for quote-only.
2. **First N answers (new):** when a part asks for N things ("give two reasons"), only the first N are marked. Extra answers neither add marks nor cancel a wrong one. This is the usual exam convention and stops listing everything.
3. **Contradiction (in the prompt today):** a point contradicted elsewhere in the answer earns nothing for that point.
4. **Restating (in the prompt today):** restating the question, or the result in a "show that", earns nothing.
5. **Bare lists (in the prompt today):** a list of terms with no statement earns nothing.
6. **Hedging (new):** offering alternatives for one point ("A or B") earns nothing for that point.
7. **Working (in the prompt today):** no method marks without working, and no accuracy mark without its method mark.
8. **Language (new):** in language subjects (English, Chinese reading) the answer must be in that language. Elsewhere any language is accepted, as today.
9. **Spelling (new):** minor misspellings are fine when the meaning is clear, unless the item tests spelling or vocabulary.
10. **Instructions to the marker (in the prompt today):** text asking for marks earns nothing and is flagged.

**Decided (Epo, 2026-11-04):**
- **All four new rules go in:** first N answers, hedging, answer language, spelling.
- **Wording:** a rule that applies is written as the AI's comment in plain words, e.g. "Copied whole sentences from the passage.". No "Rule broken" prefix, and no "Checked by code" (the answer is already labelled Marked by AI).
- **Editing it:** owners and editors edit or remove that comment while approving, like any comment (board R2), and adjust the marks. Members see it with their marks.

**Grading time:** each open part is one call. Parts run 5 at a time today (`gradeOpenParts`, `SetLimit(5)`). One maths part with thinking takes about 5 s typically and up to about 33 s at p95 on Wafer (11 s / 57 s on InferenceNet). So 10 open maths parts take about 10–20 s typically and up to a minute; 40 take about 40–90 s. Raising the per-submission limit cuts that. Epo, 2026-11-04: a grading progress status ("Marking 12 of 40 answers…") is fine.

**Capacity without per-use caps (Epo, 2026-11-04):** don't split a model's capacity by use. If one use has more requests, it simply gets more. Every caller waits in the model's line and is served in turn, as chat turns already are: each model call, including each turn after a tool call, is one request.
- **Today:**
  - The gate is per model (`model_capacities`), shared by every use. The one split is the interactive reserve, which background ingest can't use.
  - Chat waits in the model's line in arrival order (`limits.ModelQueue`). Generate, the editor's AI and other calls fail at once with `provider_busy` when the gate is full.
- **Proposal:**
  - Size each model's total to what its providers measurably take.
  - Put every caller in the same line, served round-robin by requester (user or job), so one big ingest or 40-part grading can't crowd out a single ghost-text call.
  - Drop the interactive reserve once round-robin is in. This touches retrieval limits and the Go gates, so it needs its own change.
- **Per-submission grading limit, measured (2026-11-04; `claude/bench-deepseek-grading-4a344d` fb1d1fe61, `bench/grading/reports/2026-11-04-grading-concurrency.md`).** Simulated 40-part papers (20 HKDSE maths with working, 20 reading and short open parts) on 1017, routed Wafer → InferenceNet → Cloudflare.
  - **One submission:** 5, 10, 20 or 40 parts at once all take 28–86 s. The slowest maths part sets the wall time, and sending more at once only slows each call (call p50 2 s at 5, 8 s at 40).
  - **Several submissions, 20 parts each:** 3 at once (60 calls) take 72–103 s, 5 (100 calls) 87–139 s, and 10 (200 calls) 111–156 s, with 5 calls getting no answer within 180 s. Wafer served everything up to 100 in flight; at 200, InferenceNet took 22%. Cloudflare never served, and no 429 reached us.
  - **Accuracy** held at every level (97–100% agreement with round 3). Non-maths parts stayed fast (p95 2–7 s even at 200 in flight).
  - **Cost:** about $0.016 a 40-part submission, about 32 credits. A Free month (300) covers about nine.
  - **Malformed replies:** 5 left out a rule's `id`, all on IELTS own-words parts. Matching rules by position would accept them.
  - **Today's code would fail them:** a 30 s timeout, and one failed part failing the whole check, would fail 28 of the 30 test submissions.
- **Proposal from the measurement:**
  - 10 parts at once per submission.
  - A 120 s timeout for maths parts; other parts keep 30 s.
  - Keep each part's result and re-grade only failed parts, instead of failing the check.
  - Grade assignment submissions in the background with the progress status. Thirty students handing in one paper together take about 15 minutes on Wafer alone.
  - **Total for 1017:** Wafer's latency doubles from about 60 calls in flight, and it starts handing calls on between 100 and 200. The bench suggested a separate 40-call grading limit, but that is a per-use cap, which Epo ruled out. In line with Epo's round-robin rule, raise 1017's one gate from 40 to about 100 instead, with every caller round-robin in the same line, so a grading burst can't starve ghost text or captions. **Approved (Epo, 2026-11-04):** one line per model, round-robin by requester, every caller waits (bounded as chat is) instead of failing at once, no interactive reserve, 1017 at 100, grading 10 parts at once per submission. Being built on `claude/model-queue-round-robin` from main. Timeouts, per-part re-grading and background grading come with the grading switch (§10 step 8).
  - **Built (2026-11-04, `claude/model-queue-round-robin` 683231f11, migration 0136_model_line):** waiting calls are rows in Postgres beside the existing capacity leases, turned round-robin by requester (`user:<id>`, `job:<session>`) under the per-model lock. Interactive calls wait up to chat's 60 s, then `provider_busy`. `interactive_reserve` is gone everywhere. 1017 is at 100, and grading runs 10 parts at once (grading joins the line only after the switch off Jev; today it calls Jev from Go).
  - **Decided (Epo, 2026-11-04):**
    - 1017's account split: production 84, UAT 16, local not counted.
    - `vlm_page` folds into 1017's line, so page reads have no gate of their own.
    - The Go pipeline client timeout is 90 s. Nothing retries on a timeout; the only automatic retry stays the quick one on a provider's busy answer.
    - Waiting calls retake their process slot with a bounded wait.
    - The app, the ingest host and Ops deploy together after the migration.

**Batch size (Epo, 2026-11-04):** test how many questions one page window extracts at 1, 2, 3, 4 and 6 pages a call (2 today), with cut-offs, losses at window edges, keys, figures, time and credits. Queued on `claude/study-extraction`; report `bench/extraction/reports/2026-11-04-window-size.md`.

**1017 capacity:** ghost text has run on 1017 since 2026-10-28; 0731 is the ingest descriptor model. The 40-in-flight gate (20 reserved for interactive calls) is our own setting from 2026-10-29, not a provider limit. InferenceNet answered 128 page reads at once and Cloudflare 64 without errors, but Wafer took 100 grading calls at once without an error (2026-11-04, above).

### Answer rules apart from the marking points (superseded 2026-11-04 by built-in rules; proposal, Epo 2026-11-03; canvas page 11, board R1)

**Why:** 0731 credited a pasted IELTS paragraph that the question forbade ("copying out whole paragraphs earns no marks"). The passage was in the request, but the instruction sat inside the question text.

**Proposal:** each part gets **Answer rules**, its own section under the marking points.
- **A rule has three things:** what it is (don't copy whole sentences from the passage, a word limit, own words, show working, or custom text), how it's checked, and what breaking it costs (no marks, or deduct N marks).
- **Checked in code, never reaching the AI:** word or character limits, and copying from the passage (the share of the answer found word for word in the stem).
- **Judged by AI:** other rules, in their own `<answer_rules>` block before the marking points. The model reports each rule as kept or broken, with a quote.
- **Learners see them** as chips under the question.
- **Results** say which rule was broken and how it was checked. "No marks" skips the marking points; a deduction applies after them.
- **Extraction** fills rules from printed instructions ("NO MORE THAN TWO WORDS", "in your own words").

**Needs:**
- the rule list in the question format, with the Go validator, TS types and bank format;
- the editor section;
- the copy check, scoring against the stem's passage text;
- the grading prompt block;
- bench round 3 on 0731 and v4.1 Flash with the rules block and copy check.

**Extraction model, decided by test (Epo: not direct DeepSeek; `claude/study-extraction` ddd560f26):** extraction has its own `extraction` slot, pinned to `deepseek/deepseek-v4.1-flash-1017` on OpenRouter (InferenceNet then Cloudflare), the same pin as captions. It runs with reasoning at medium; the old "reasoning off" was our own setting.
- **Quality against direct Flash:** MCQ 87/90 (direct 175/180). Paper 1 final answers 69/72 (direct 107/108); the misses are open proof parts without a model answer. Part marks 66/72 (direct 99/108).
- **Cost and time:** about half the credits (2022 Paper 2: 52–53 against 108–145), but slower (about 300 s against 200–280 s).
- **Open:**
  - The 1017 price row is 1000 on UAT against 1100 listed now.
  - Extraction shares 1017's 40-call concurrency with captions and ghost text.
  - The backup provider, Cloudflare, was rate-limited during the test.

**Captioning:** image captions already use the 1017 pin (`deepseek/deepseek-v4.1-flash-1017` via OpenRouter, providers InferenceNet and Cloudflare). If the extraction test picks 1017, extraction and captioning share one image model.

### Switching from Jev

- **Bench:** add DeepSeek adapters to `bench/grading` (the cheaper 07xx model and the larger one). Rerun the Jev contract fixtures, plus held-out, prompt-injection and Traditional Chinese answers. Compare item agreement, cost and latency with Jev.
- **Grader:** JSON per marking item (none, partial, full) with a quote that must appear in the answer, checked in code. Temperature 0, cached per answer and scheme, a second sample only on borderline items, marks computed on the server (`itemAwards` kept).
- **Wiring:** replace the Jev call in `quiz_grading.go`. DeepSeek is OpenAI-compatible and already used through the pipeline's model registry (`deepseek-flash` is the chat default), so either call it from Go directly or through that registry.
- **Approval:** new AI marks on assignments start as waiting; "Mark with AI" covers failures and empty credits.
- **Metering:** a usage event per graded part, charged to the owner for assignments and the member for their own practice, with the monthly cap.
- **Removals (Epo, 2026-11-03):** only quiz grading moves off Jev. The Jev client and its contract stay in the code for later use; the editor's "needs a calculation" check can stay on Jev until replaced. Public open grading on shared pages, Turnstile and the anonymous caps go.
- **Docs and tests:** question-bank.md, observability-metering.md, test-catalog.md.

- **Shared pages (Epo, 2026-11-03):** nothing on a shared page counts. Questions with one right answer are marked automatically. Open answers stay unmarked: a "Not marked" chip, with the marking points and worked solution to compare (F2). There's no self-marking and no AI marking there, so the anonymous grading caps and their table go.

---

**Open choices from the build (2026-11-03, canvas page 10, boards Q1–Q4).** The toast, card and quiz-option branch (`claude/study-ui-pieces`, 24a1f8e03) settled these one way; Epo picks one option per row:
- **Toasts (Q1):**
  - T: dark mode;
  - E: an open error and the next toast;
  - A: where the action goes on a two-line toast;
  - I: the plain toast's icon;
  - S: working spinner, ring or the app's leapfrog dots;
  - P: phone position.
- **Icons and cards (Q2):**
  - Z: 16px icons in the toast × and card ⋮, or the 18px minimum;
  - V: the card ⋮ always shown or on hover;
  - N: a workspace with no cover;
  - L: long names.
- **Quiz options (Q3):**
  - D: marks shown twice on one-part questions;
  - B: true/false alignment;
  - O: how a checked ordering looks;
  - R: right choices in a wrong all-or-nothing part.
- **AI icon (Q4, Epo 2026-11-03):** not the chat bubble but a curvy four-point star. The options are an outline star, a filled star, or a star with a small one. The shell branch uses the outline star until Epo picks.
- **Picked (Epo, 2026-11-03):**
  - **AI icon:** AI2, the filled curved star.
  - **Toasts:**
    - T2 in dark mode.
    - E2: a new toast shows above an open error.
    - A1, with more horizontal space around the action (board Q5).
    - I1 and S1.
    - On phones the toast stays centred and sits above the chat button.
  - **Icons and cards:** Z1, V2, N1. L wasn't picked, so it stays as built (one line).
  - **Quiz options:**
    - D1 for now.
    - True/false: B2, left-aligned, with True and False on separate rows.
    - Checked ordering (O4) and a wrong multi-answer part (R4): your answer on top, keeping its right/wrong marks, then the correct answer as its own list below, as before the change. Shown on Q5 for confirmation.

### Drawing answers (agreed, Epo 2026-11-03; canvas boards K6–K8)

Epo asked whether to allow drawings as answers, for graphs and diagrams, and as a path toward scanned answers.

**Agreed:** a `drawing` answer type beside `open`. Drawing happens on a full-screen board that copies BlockSuite/AFFiNE's edgeless mode (Epo): the dotted canvas, the floating toolbar with the pen and eraser that rise when picked, the pen menu (pen or highlighter, line widths, colours), straight line, text, undo and redo, and zoom in the corner. The answer is the sheet in the middle, the question stays pinned at the top left, and Done returns to the question with a preview and "Edit drawing". On phones the same board fills the screen.
- **Background:** the part sets it to blank, squared grid, axes (with x and y ranges) or a figure from the question to label.
- **Tools (Epo, 2026-11-03), in AFFiNE's order from the playground:** one select/hand toggle (one button, as in BlockSuite), the curve connector left of the pen, then the illustrated tools: note (text, heading and link cards), pen, eraser and AFFiNE's filled shapes. Capy's presets for formulas and graphs come right after the shapes. Undo and redo sit at the end on desktop; on phones the illustrated tools scroll behind AFFiNE's arrow. The pen menu is AFFiNE's one-row tab on top of the toolbar (pen or highlighter, line widths, colours), never wider than the toolbar, scrolling with its round arrow buttons. Reuse the vendored BlockSuite edgeless tools where that helps.
- **Storage:** the answer is stored as strokes and rendered to an image for marking.
- **Marking:** the same marking points as an open answer, marked by a vision model. It goes through the same owner approval and credits rules, and stays "Not marked" when credits are empty. Shared pages can't mark it.

**Why:** the "picture checked against marking points" path is the one scanned submissions need later.

**Others:**
- Formative has drawing responses.
- Desmos Classroom has sketch responses.
- Pear Assessment has drawing and graphing question types.
- Google and Microsoft Forms only take file uploads.

**Needs:**
- the answer type in the shared format (Go validator, TS types, bank format);
- a canvas with pen input that works on phones;
- a vision grader: DeepSeek reads images (Epo), so the same model marks drawings, with drawing items in its bench;
- a few drawing items in the grading bench.

**Later, if needed:** exact graph answers using Capy's graph editor, checked in code.

**Text and headings on the board (Epo wants them):** the note tool is BlockSuite's note block, a rich-text editor on the canvas. It is bigger work and needs its own planning round together with the AFFiNE canvas (below), since both use the same edgeless editor.

## 10. Order of work

1. **Decisions:** §11.
2. **Chapters → topics,** with the chapter-driven study pieces removed. Files groups by topic, and the `chapters` table becomes `topics`.
3. **Record:**
   - `attempts.workspace_id`;
   - an `answer_events` log on every graded part (done: branch `claude/study-answer-events-91b7cd`). Events outlive their quiz, as attempts do (Epo, 2026-11-03), so once topics land each event also stores its question's topic, or a deleted quiz's events can't count toward one;
   - the topic tables;
   - `topic` in `add_questions`;
   - the background tagger.
4. **Views:** G1 grid, G3 report and G2 profile, behind the visibility rules (§2), with the join notice and G5.
5. **Assignments:** frozen copy, server timer, submit, mark changes by the owner, gradebook.
6. **Mastery model and follow-up sessions,** after a simulator under `bench/learner-model/`.
7. **Extraction,** PDF first, plus its bench.
8. **Grading switch,** after the DeepSeek bench; self-marking on shared pages.

Steps 2, 3 and 7 can run side by side.

**UI matches the mocks (Epo, 2026-11-03).** Built screens copy the mock boards exactly, including where they differ from today's components. Anything a mock doesn't settle goes back to Epo as visual options on the canvas, not a call made in code. Shared pieces change to the mocks' design (canvas page 9, "Toasts and cards"):
- **Toast:** the centred black pill for every kind, taking a second line when needed. It fades in and out with the app's existing motion tokens, with no expanding animation (Epo, 2026-11-03). One at a time (S1, Epo); the same toast again counts up (×2, ×3) and restarts its timer instead of queueing.
- **Workspace cards:** the half banner from the Home mock (D1), H2 (Epo, 2026-11-03): the icon on the banner's edge, ⋮ on the banner, topics in the line under the name, then access and tags. File cards stay as they are; they're thumbnails.
- **Quiz options:** full boxes as in the mocks (F1b) instead of today's underlined rows, for options, true/false and ordering items; open answers keep their ruled lines (Epo, 2026-11-03). A right choice fills green with a tick and "Right"; a wrong choice fills red with "Your answer". Once checked, a label above the options says Right or Wrong with the marks, as in Results (A5); a skipped question says "Not answered" and counts as wrong. The correct answer you didn't choose gets a green outline with no fill and "Correct answer" (M1, Epo, 2026-11-03), so green fill only ever means you chose it and it's right.

**Class or personal workspaces (Epo, 2026-11-04; canvas page 12, board U3, approved with C1, being built on `claude/study-shell`).** One hint line under the switch: "Practice and grade tracking for yourself." or "Give out assignments. Only members get grade tracking." An editor shows as Teaching assistant in a class and stays Editor in a personal workspace, in the UI only. The owner picks when creating a workspace. Class: Assignments and Practice, and the owner has no My results and no Suggested or Practise. Personal: Practice only, no assignments, with My results and Suggested. The map on U3 fills in the rest: editors act like owners; a personal workspace can invite people, each seeing only their own results; Personal is the default; it can be changed in settings; a member's clone of a class becomes Personal. Assignments wait for this.

**Other decisions (Epo, 2026-11-04):**
- A clone keeps each item's hidden flag; a viewer's clone still leaves hidden items out.
- The box-call fallback uses ink growth instead of `FIGURE_PAD`, the better result in the tests.
- Study plans are dropped end to end.
- Undo and redo are hidden on phones in the file and material top bar.
- The first list is done on `claude/study-shell` (902e2635d): plans dropped (migration 0137), topic sessions at 10, the AI star, Activity rows opening. CI still has to confirm the Go DB tests and e2e. The read-state rows stay for now: the agent's `read_study_progress` result and `reviewableWorkspaces` still read them, and removing them is a prompt change that waits for Epo.
- Built as recommended on `claude/study-shell`, with screenshots for Epo to change: topic sessions at 10 questions, the AI star on New chat, file processing and the callout tip, Activity rows opening their file, no empty sections on the Dashboard, the dead move-files warning removed, the leftover read states dropped if nothing reads them, Add file's tabs and the topic ⋮ menu kept as built.

**Hidden until AI analysis of study progress is decided (Epo, 2026-11-04):** the chat agent's `read_study_progress` tool goes, along with the leftover read-state rows, and the app's Learning page is hidden from the sidebar, phone nav and Home. Its code stays. Inside a workspace, review means Practice's Suggested and topic practice. Settings → Study stays at 20 for now, to be adjusted when review sessions are looked at again.

**Combined preview (Epo, 2026-11-04):** `claude/study-all` merges every study branch so Epo can see it locally. It's not landing; migrations are renumbered there.

**Next after this rework's mocks (Epo, 2026-11-03): the AFFiNE canvas** (`todo-canvas-workspace.md`, on hold since 2026-11-02). Drawing answers and the note tool build on the same BlockSuite edgeless editor, so they are planned with it.

**Later (Epo, 2026-11-03): the app-wide Learning page.** The workspace's centre Study page goes (the Study tab's pages replace it). The app's Learning page stays in the sidebar for now and is redesigned later, perhaps to show the AI suggestions across workspaces.

**Later (Epo, 2026-11-03): AI insights.** Labels and rule-based reasons ("Missed 3 of 4 questions on osmosis", the report's common wrong answers) come first. A short AI summary waits until there is real data and the DeepSeek bench: most likely a weekly class snapshot on Members with links to the evidence, plus a member summary on the profile. Others: Khan Academy's Class Snapshot (a 7-day summary of learning time, assignments and mastery, with suggested follow-up questions); Google Classroom's Analytics tab (flags for missing work and changing grades) and Gemini summaries of who submitted and where students need support; Canvas's paid Intelligent Insights ("Students in need of attention") and IgniteAI discussion insights.

**Later (Epo, 2026-11-03): scanned submissions.** Members submit an assignment as a scan or photos of handwritten answers. This needs its own design round: capture on phone and desktop, matching pages to questions, reading handwriting (the GLM page read exists), AI marks with the owner's approval, and what Results shows for paper answers.

## 11. Questions for Epo

Updated 2026-11-03. Decided this round, no longer open: the join notice (not an opt-in); later joiners get open assignments ("All members"); members see their overall; shared pages mark only automatic questions; topics replace folders and come from a syllabus; approval of AI marks; Marked/Unmarked assignments.

**Answered by Epo, 2026-11-03**

1. **Editors** act like owners: they create assignments, see member results and approve AI marks.
2. **Credits:** whoever starts a job pays; AI marking of an assignment's answers is the owner's, with a monthly cap.
   - **Running out never blocks a member.** Submissions always go through. Open answers stay "Not marked", and the owner gets "Mark with AI" on the assignment to run them once credits are back. There's no automatic retry.
   - **Only open parts ever use AI.** Multiple choice, short answers, quantities and gap fills stay deterministic Go grading, as today (`/api/quizzes/{id}/check`: closed parts in Go, open parts by the model).
   - **Model:** bench the cheaper DeepSeek model (the 07xx one) beside the larger one, and pick on the bench.
3. **The DeepSeek switch** needs the steps under §9 "Switching from Jev". Only quiz grading leaves Jev; Jev itself stays in the code (Epo). Whether minors' answers may go to a China-based provider stays open until schools.
4. **Mastery thresholds** as in §5, including half weight for self-made questions.
5. **Missing and late work:** missing counts 0 in Overall after the due date; late submissions are accepted, labelled Late, until the owner closes the assignment; Attempts defaults to 1.
6. **Reviews:** marked-assignment questions join FSRS reviews once the assignment closes (when they also become practice). Flashcards stay out of mastery.
7. **Topics** replace chapters in suggested reviews, sessions and the agent's `read_study_progress`. Caps: 10 topics per workspace on Free, 20 on Pro.
8. **Aggregates** need at least 5 members. No leaderboards.
9. **Extraction caps the selected pages at 40 per run (Epo, 2026-11-03),** not the file. See §8 "Context and the page cap" and "Page sources by file type".
   - **Office files too.** The client sends the selected page numbers, and the backend captures those pages without a full publish. Saved edits go in as text in the prompt; whether that helps is checked later.
   - **Check first:** PPTX slides are stable pages, but DOCX pagination depends on the renderer. The pages the backend captures must match what the member saw in the browser (BetterOffice). If they can't, the client sends its rendered page images instead.
10. **Shared pages:** Turnstile and the anonymous grading caps go, since open answers aren't marked there.

**Can wait**

11. Before schools: an age policy, and what happens to results when a member leaves.
12. Later work, already queued: scanned submissions, AI insights (class snapshot, member summary), "Copy to my workspace" for self-made practice, letting members share practice with the class, and **gamification** such as a topic map on My results reusing the question bank's TrailMap (Epo, 2026-11-03: think about it after this).
