# Study and member tracking plan

Status 2026-11-03: chapters become topics, which replace folders (§1, §3). Round-by-round decisions are recorded inline.

- The canvas plan (`todo-canvas-workspace.md`) is on hold.
- Research: one report per area in `todo-study-tracking/`, each claim with a URL or a file path:
  - R1-tracking: how teachers see results
  - R2-modelling: strengths, weaknesses and follow-up
  - R3-extract-grade: extraction and grading
  - R4-assignments: practice vs graded work
  - R5-inventory: what Capy has today
- Mocks: the Design canvas at https://claude.ai/artifact/1TY5cpr5tDoQZTM2PvGZNd. Artboard names (G1, A2, …) are used below.

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

### Drawing answers (proposal, 2026-11-03, canvas board K6)

Epo asked whether to allow drawings as answers, for graphs and diagrams, and as a path toward scanned answers.

**Proposal:** a `drawing` answer type beside `open`.
- **Background:** the part sets it to blank, squared grid, axes (with x and y ranges) or a figure from the question to label.
- **Tools:** pen, straight line, text, eraser, three colours, undo and redo.
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
- a vision grader: whether `deepseek-flash` takes images is still to be checked, and GLM-5.3-Flash is the fallback;
- a few drawing items in the grading bench.

**Later, if needed:** exact graph answers using Capy's graph editor, checked in code.

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
- **Toast:** the centred black pill for every kind, taking a second line when needed. It fades in and out with the app's existing motion tokens, with no expanding animation (Epo, 2026-11-03). Pick S1 or S2 for several at once.
- **Workspace cards:** the half banner from the Home mock (D1), H2 (Epo, 2026-11-03): the icon on the banner's edge, ⋮ on the banner, topics in the line under the name, then access and tags. File cards stay as they are; they're thumbnails.
- **Quiz options:** full boxes as in the mocks (F1b) instead of today's underlined rows, for options, true/false and ordering items; open answers keep their ruled lines (Epo, 2026-11-03). A right choice fills green with a tick and "Right"; a wrong choice fills red with "Your answer". Once checked, a label above the options says Right or Wrong with the marks, as in Results (A5); a skipped question says "Not answered" and counts as wrong. The correct answer you didn't choose gets a green outline with no fill and "Correct answer" (M1, Epo, 2026-11-03), so green fill only ever means you chose it and it's right.

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
