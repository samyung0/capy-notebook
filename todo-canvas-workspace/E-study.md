# E: Study as plan tasks + review sessions

Research for Epo's 2026-11-01 direction: drop read progress, and make Study a
rich task list per plan (tasks link to files and quizzes through @) plus review
sessions. This was read-only work: nothing in the repo was edited, built or
run.

- Checkout: `.claude/worktrees/blocksuite-notes` at `f2ad7b79f`. Paths below are relative to it.
- Sibling report: `F-impact.md` in this folder.

## 0. In short

- **Records, not documents.** Apps that complete a task by themselves (every LMS, the study apps, Linear) store tasks as records with a completion rule and keep a done state for each person. Apps that keep to-dos inside documents (Notion, RemNote, Heptabase) have only a manual tick, and that tick belongs to the document, so it is shared by everyone.
- **Review is never a checklist item.** No app turns spaced-repetition reviews into tasks.
  - Anki, Quizlet and Knowt keep reviewing as a mode of its own.
  - The closest is RemNote's exam plan, whose Today shows "due reviews" and "learn new" as two separate blocks.
- **Back-planning from an exam date exists only in study apps:** RemNote, Knowt, StudySmarter, and MyStudyLife's AI. General task apps instead separate the day you plan to do a task from its deadline (Todoist, Things, Akiflow, Moodle).
- **Teacher features share one pattern.** One assignment, a done state per student, and a grid of who finished: Classroom, Canvas, Moodle, Khan, Quizlet, Knowt, Brilliant.
- **The most useful surface is a cross-course Today.** Students rarely browse plans; they ask "what do I do now?". Classroom To-do, Canvas List View, Khan's Daily Mission, Things and Todoist Today, and Microsoft To Do's My Day all answer that across every course or list.
- **What happens to Capy's pieces:**
  - **Remove (read progress):** `study_progress`, `workspace_study`, Mark as read, Continue, the railway map, Learning → Progress, the workspace finish toasts.
  - **Keep (review):** FSRS state, the review log, review sessions, Quick review, attempts.
  - **Replace:** plans and steps become tasks.
  - **Rewire:** three review pieces read `study_progress` today and need a new source.
- **Shapes:**
  1. A checklist card on the canvas.
  2. A task list with completion rules and a review block (my pick for the base).
  3. A plan to a date (a later, optional layer on 2).

## 1. Method

- **Sources.** Four research agents covered the 19 apps from official help centres, docs and changelogs. They read some pages through the vendors' help-centre APIs when the HTML refused (Quizlet, Khan), and some in a browser (Canvas). Their shared web-search budget ran out partway, so later checks fetched official pages directly.
- **Spot checks.** I re-checked four load-bearing claims myself:
  - RemNote's exam plan blocks: confirmed (article updated 2026-08-21).
  - Knowt's Learn exam date: confirmed.
  - Duolingo Friend Streaks (up to 5 friends, nudges, +22%, 2024-08-05): confirmed.
  - Canvas completion requirements: the page needs JavaScript and would not render. The claim matches long-standing Canvas behaviour and the agent's browser read.
- **Unverified claims.** "Unverified" marks a claim that rests on memory, on a single weak source, or on not finding a feature in the pages read.
- **Quotes** are a few words at most.
- **Capy facts** come from the code and docs at the checkout, cited by path and line.

## 2. How other apps do it

### 2.1 Patterns by aspect

#### Linking tasks to materials

| Pattern | Apps |
| --- | --- |
| Inline @ chips that open the target | Notion: `@`, `[[` or `+` links a page, renames follow, backlinks appear (https://www.notion.com/help/comments-mentions-and-reminders). Linear: `@` people, issues, projects, docs, PRs; a linked PR shows reviewers and status (https://linear.app/docs/editor, https://linear.app/docs/github). Heptabase: `@` card mentions with block backlinks (https://wiki.heptabase.com/fundamental-elements). AFFiNE/BlockSuite: an `@` / `[[` linked-doc menu, already vendored in Capy (§3.4). |
| A link or file in a field of the task | Todoist: files in comments; click behaviour not documented (https://www.todoist.com/help/todoist/features/add-comments-or-files-to-tasks-in-todoist-CwiA50). Microsoft To Do: files up to 25 MB, Microsoft 365 files as links, flagged email with "Open in Outlook" (https://support.microsoft.com/en-us/ToDo/add-files-to-your-tasks). Things: links in Markdown notes, no attachments (https://culturedcode.com/things/support/articles/4438545/). Akiflow: a Links field opened with `O`, previews (https://akiflow.featurebase.app/en/help/articles/0006630-task-features). Sunsama: an imported item embeds its source, `G` opens it (https://help.sunsama.com/docs/integrations/asana). |
| The assignment carries the material | Classroom: Drive, YouTube, link, upload or practice set; view only, shared edit, or "Make a copy for each student" (https://support.google.com/edu/classroom/answer/6020265). Canvas: module items with Next/Previous through the module (https://community.instructure.com/en/kb/articles/661313-how-do-i-view-modules-as-a-student). Moodle: activities on the course page show their conditions (https://docs.moodle.org/503/en/Activity_completion_settings). Quizlet: one set plus one mode (https://help.quizlet.com/hc/en-us/articles/39836814088845-Using-Assignments). Knowt: a list with Mastery, Grade and Due columns (https://help.knowt.com/en/articles/16905158-how-to-join-a-class-and-find-your-assignments). Khan: its own content only; teachers attaching their own files was not found (unverified) (https://support.khanacademy.org/hc/en-us/articles/18564282990861-What-types-of-content-can-I-assign-to-my-students). |
| Plan items generated from the material | StudySmarter: uploaded notes become chapters, lessons and questions (https://apps.apple.com/mo/app/studysmarter-study-revision/id1439949520?l=en-GB). RemNote: the exam week broken down by source document (https://help.remnote.com/en/articles/16081995-exam-study-plan). Knowt: exam plan topics with linked resources (https://knowt.com/exam-predictor-and-plan). Todoist Task Capture (beta, 2026-04-21): PDF or photo to tasks, preview first (https://www.todoist.com/help/todoist/product-updates/scan-notes-photos-and-files-for-tasks-task-capture-beta-apr-21-2026-S5GOh7A0e). |

**For Capy:** a chip should open its item, or pan the canvas to it, and survive renames. Mentions should be stored by id with a stored label as fallback, as Capy's member mentions already are (`openwiki/frontend/plate-editor.md:116-121`).

#### What completes a task

| Pattern | Apps |
| --- | --- |
| Manual only | Notion: to-do, checkbox or a Status with an in-progress group; automations push Complete *down* to sub-items (https://www.notion.com/help/database-properties, https://www.notion.com/help/database-automations). Todoist: completing a parent completes its sub-tasks (https://www.todoist.com/help/todoist/features/create-an-uncompletable-task-in-todoist-QxQosZuF). Things: check or cancel, kept in the Logbook (https://culturedcode.com/things/support/articles/4001304/). Microsoft To Do: the task plus a step counter. Sunsama: unfinished tasks roll over with a day counter (https://help.sunsama.com/docs/getting-started/basics/task-basics). Also MyStudyLife (with a % and subtasks), Power Planner, Heptabase and RemNote to-dos (https://help.remnote.com/en/articles/6752161-managing-tasks-with-todos). |
| Evidence completes it | Linear: an open PR moves the issue to In Progress, a merge to Done; optionally a parent closes when its sub-issues do (https://linear.app/docs/github, https://linear.app/docs/parent-and-sub-issues). Khan: automatic only, best score; a Unit Mission is done when every skill is Proficient (https://support.khanacademy.org/hc/en-us/articles/360031122951-How-do-I-use-the-Assignments-report). Brilliant: automatic; teachers see Completed / In progress / Not started (https://brilliant.org/help/schools-and-educators/assignment-and-progress-reporting-guide/). Quizlet: terms sort into Not studied / Still learning / Mastered (https://help.quizlet.com/hc/en-us/articles/360048803491-Using-Progress-for-targeted-studying). Knowt: four mastery levels from Learn, tests, Match and spaced repetition, not plain flashcards (https://help.knowt.com/en/articles/10298109-what-does-the-mastery-score-mean). |
| The author picks a rule per item | Canvas: view, mark as done, contribute, submit, or score at least X; a module needs all or one, optionally in order; a score rule waits for a posted grade (page dated 2026-08-20) (https://community.instructure.com/en/kb/articles/660897-how-do-i-add-requirements-to-a-module). Moodle: manual Mark as done, or automatic on view, any grade, passing grade or submission; settings lock after the first completion; teachers can override (https://docs.moodle.org/503/en/Activity_completion_settings, https://docs.moodle.org/503/en/Activity_completion_report). |
| Two verbs | Classroom: *Mark as done* when nothing is handed in, *Turn in* to submit; unsubmit is allowed; the teacher can mark complete or excuse (https://support.google.com/edu/classroom/answer/6020285, https://support.google.com/edu/classroom/answer/6020294). |
| Partial states | Linear counts started issues at 25% in a cycle's score (https://linear.app/docs/cycle-graph). Canvas: an orange dash for unmet or overdue, a green check for met, blue for submitted but not graded, a lock. Moodle: a red cross once an item can no longer be completed. Khan: a "4 of 16" counter, and skill levels can drop (https://support.khanacademy.org/hc/en-us/articles/115002552631-What-are-Course-and-Unit-Mastery). |

**For Capy:**
- Reading stays a manual tick: opening a file is weak evidence. Even Canvas's "view" rule only means the page was opened.
- Quizzes and flashcard sets can complete from evidence Capy already stores: attempts and ratings.

#### Scheduling

- **The day you'll do it vs its deadline:**
  - Todoist: dates vs deadlines; deadlines need Pro and one-time tasks (page updated 2026-09-01). https://www.todoist.com/help/todoist/features/introduction-to-deadlines-in-todoist-uMqbSLM6U
  - Things: When vs Deadline; reminders go only on When; the docs suggest starting a few days before the deadline. https://culturedcode.com/things/support/articles/2803579/
  - Akiflow: a plan date plus a deadline, with alerts when a deadline is at risk. https://akiflow.featurebase.app/en/help/articles/2317287-deadline-alerts
  - Moodle: a soft "Set reminder in Timeline" date, then the due date and a cut-off. https://docs.moodle.org/503/en/Activity_completion_settings
- **Back-planning from an exam:**
  - RemNote Exam Scheduler:
    - You enter the date, new cards per week and study days.
    - It runs in phases: catch-up, learning, then a final review.
    - An optional "Ensure Mastery" asks for two correct answers in a row.
    - If you fall behind, it suggests a new goal.
    - https://help.remnote.com/en/articles/9101991-preparing-for-an-exam
  - RemNote's Today splits Due Reviews from Learn New Exam Content, shows an on-track indicator and a "Learn More Today" warning, and has an Edit button. https://help.remnote.com/en/articles/16081995-exam-study-plan (spot-checked)
  - Knowt: Learn paces rounds toward an exam date, 7 cards per round by default (https://help.knowt.com/en/articles/10714631-how-do-i-use-learn-mode, spot-checked). Its exam plan has no dates and puts the weakest units first (https://help.knowt.com/en/articles/17737403-how-to-follow-your-exam-study-plan).
  - StudySmarter: exam dates give a plan with reminders, and an exam date can sit on a study set. https://www.studysmarter.co.uk/features/study-plan, https://www.studysmarter.co.uk/features/study-sets/
  - MyStudyLife: Scout AI splits an exam into revision sessions. https://mystudylife.com/tour/
  - Quizlet: planning toward a test date dates from 2017; today's help mentions only a goal, so it may be gone. https://campustechnology.com/articles/2017/03/09/quizlet-debuts-study-feature-that-helps-students-study-efficiently.aspx?p=1
  - Canvas Course Pacing paces forward from enrolment, not back from an exam (still a preview). https://community.instructure.com/en/kb/articles/660752-how-do-i-use-course-pacing
  - Notion's dependencies shift later dates when one slips. https://www.notion.com/help/tasks-and-dependencies
  - **No general task app plans backwards.**
- **Recurring work:**
  - Todoist: typed recurrence; `every` counts from the scheduled date, `every!` from completion. https://www.todoist.com/help/todoist/features/introduction-to-recurring-dates-YUYVJJAV
  - Things: complete a repeat early and choose exception vs rule (3.23, 2026-08-19). https://culturedcode.com/things/blog/2026/08/repeating-to-dos-refined/
  - Microsoft To Do, Notion templates, Linear, Sunsama: yes.
  - Akiflow: by date only.
  - Recurring assignments in Canvas and Classroom: none found (unverified).
- **Daily queue:**
  - Todoist Today; a board grouped by priority since September 2026. https://www.todoist.com/help/todoist/product-updates/september-2026-decide-whats-urgent-and-let-the-rest-wait-ewUpBiZOm
  - Things: Today plus This Evening.
  - Microsoft To Do: My Day clears every night and suggests tasks to pull back. https://support.microsoft.com/en-us/ToDo/my-day-and-suggestions
  - Sunsama: Today plus a planning ritual that warns when you overcommit. https://help.sunsama.com/docs/usage-guides/daily-planning/legacy
  - Akiflow: Today with red "2d ago" labels. https://akiflow.featurebase.app/en/help/articles/0741055-today-page
  - Khan: a Daily, then Weekly Mission built automatically from due dates; overdue work stays until done. https://support.khanacademy.org/hc/en-us/articles/46938861004685-Where-can-I-find-my-assignments-in-Khan-Academy-Reimagined
  - Classroom: To-do with Assigned / Missing / Done, and a homepage "Due soon" of up to 5 items. https://support.google.com/edu/classroom/answer/6020284, https://support.google.com/edu/classroom/answer/17231999
  - Canvas List View: Today, Missing/Late/Redo labels, and students' own to-dos. https://community.instructure.com/en/kb/articles/662819-how-do-i-use-the-to-do-list-for-all-my-courses-in-the-list-view-dashboard-as-a-student
  - Moodle Timeline: dated items, with overdue ones up to two weeks back. https://docs.moodle.org/503/en/Timeline_block
  - RemNote daily goal: spread the week's reviews evenly, all due, or a cap. https://help.remnote.com/en/articles/7950933-goals-and-streaks
  - Anki: New/Learning/To Review counts, daily limits and a "Today only" override. https://docs.ankiweb.net/deck-options.html
  - Duolingo: a daily XP goal; one lesson keeps the streak. https://blog.duolingo.com/improving-the-streak/
  - Notion and Linear: no Today. Notion has My Tasks and Home; Linear has My Issues.
- **Time blocking:**
  - Todoist durations and a calendar layout.
  - Sunsama timeboxing, with `X` auto-scheduling into free slots.
  - Akiflow Time Slots.
  - Microsoft To Do into Outlook's calendar.
  - Notion Calendar.
  - Things: none.

#### Review and spaced repetition beside tasks

- **Task apps:**
  - None: Notion, Things, Microsoft To Do, Linear, Sunsama, Akiflow and Power Planner have no spaced repetition.
  - Todoist has only morning-overview and evening-review prompts. https://www.todoist.com/help/todoist/features/manage-your-notifications-in-todoist-QxQGXkMu
  - MyStudyLife's "Revision" is just a task type tied to an exam, with no algorithm (help-centre snippet; the site failed TLS).
  - Heptabase AI Tutor lessons end with a review part, kept apart from to-dos (2026-03-31). https://heptabase.com/ai-tutor
- **LMS:**
  - Classroom: practice sets (instant check, hints, retry) and Gemini study tools; spaced repetition not found (unverified). https://support.google.com/edu/classroom/answer/13457451
  - Canvas: Mastery Paths release follow-ups by score range; outcomes can use a decaying average; IgniteAI study tools (2026-09-14). https://community.instructure.com/en/kb/articles/660914-how-do-i-use-mastery-paths-in-course-modules
  - Moodle: attempt limits, delays between attempts, reopen until passed; the flashcard plugin is outdated. https://docs.moodle.org/503/en/Quiz_settings
  - Khan: levels drop after a failed check; classic Mastery Challenges; Readiness Missions practise earlier skills first. https://support.khanacademy.org/hc/en-us/articles/47777820626573-What-are-Readiness-Missions-and-Readiness-exercises
- **Study apps:**
  - RemNote: the queue runs Exam, then Currently Studying, then Maintaining (https://help.remnote.com/en/articles/7950982-setting-priorities-and-disabling-flashcards). Its exam Today shows reviews and new cards as two blocks.
  - Anki: filtered decks for cramming, with a warning against reviewing ahead often (https://docs.ankiweb.net/filtered-decks.html). The FSRS Helper add-on's "Advance" pulls cards forward before a test (https://github.com/open-spaced-repetition/fsrs4anki-helper). Easy Days and load balancing arrived in 24.11 (https://github.com/ankitects/anki/releases/tag/24.11).
  - Quizlet: a separate, web-only Spaced Repetition mode with new cards per day, apart from Learn paths (article created 2026-08-21). https://help.quizlet.com/hc/en-us/articles/48324742264077-Studying-with-Spaced-Repetition
  - Knowt: spaced repetition is a separate per-set mode with no exam date. https://help.knowt.com/en/articles/10714645-how-do-i-use-spaced-repetition-mode
  - Duolingo: practice is built into the path, plus a Practice Hub. https://blog.duolingo.com/guide-to-duolingo-practice-hub/
  - Brilliant: practice sets and Review/Redo; no scheduler documented.
- **Pattern:** review is a standing block or mode, never individual checklist items. Only an exam date (RemNote) changes what review picks.

#### Progress display

- **Per list:**
  - Things: a progress pie and a deadline countdown. https://culturedcode.com/things/features/
  - Notion: a bar or ring drawn from any number or formula (2022-08-11). https://www.notion.com/releases/2022-08-11
  - Microsoft To Do: a step counter.
  - Todoist:
    - a daily pie against a goal (default 5), weekly totals against 25;
    - current and longest streaks;
    - karma points;
    - % complete per project in Insights.
    - https://www.todoist.com/help/todoist/features/use-the-productivity-view-in-todoist-6S63uAa9
- **Forecast and health:** Linear predicts a finish date with optimistic and pessimistic bounds, shows % per milestone, and labels projects On track / At risk / Off track. https://linear.app/docs/project-graph, https://linear.app/docs/initiative-and-project-updates
- **Mastery:**
  - Khan: Attempted / Familiar / Proficient / Mastered; course % counts only Proficient and above.
  - Quizlet and Knowt: three or four term states.
  - RemNote: card levels, a heatmap, a 30-day forecast, and an exam bar with % done and practices left. https://help.remnote.com/en/articles/7970392-flashcard-statistics
  - Anki: no streak; the heatmap is an add-on.
  - Brilliant's parent dashboard says it measures consistency, "not mastery".
- **LMS:**
  - Canvas: students see icons per item; teachers' *View Progress* shows each student's modules. https://community.instructure.com/en/kb/articles/660912-how-do-i-use-modules-to-view-the-progress-of-students-in-a-course
  - Moodle: My courses shows a % done. https://docs.moodle.org/503/en/My_courses
- **Streak protection:**
  - Todoist: vacation mode and days off.
  - Duolingo: up to two Streak Freezes.
  - RemNote: earns one freeze per six days, holds two.
  - Knowt: freezes for coins, up to three.
  - Brilliant: Streak Charges apply themselves.
  - Khan: the streak is weekly, not daily. https://support.khanacademy.org/hc/en-us/articles/28717667146893-What-is-a-streak

#### Social and teacher features

- **Shared list, one tick for all:**
  - Notion: a Person property; comments; no who-finished list, only page analytics.
  - Todoist: shared projects with one assignee each; a People tab and Reporting (beta, 2026-04-23). https://www.todoist.com/help/todoist/product-updates/a-clearer-picture-of-your-teams-work-apr-23-2026-tUh7Nsstf
  - Microsoft To Do: lists shared by link; assign to a member; alerts on complete or assign. https://support.microsoft.com/en-us/ToDo/assign-tasks-in-shared-lists
  - Heptabase:
    - whiteboard chat;
    - @mentions show who has read or replied;
    - collaborators can set to-do dates (June 2025);
    - no assignees.
    - https://wiki.heptabase.com/collaborate-and-discuss-with-others
  - Things, Sunsama, Akiflow: none. Their teams pool billing only.
- **One assignment, a state per learner:**
  - Classroom:
    - assign to classes, up to 100 students, or groups;
    - Turned in / Assigned counts on each card;
    - private comments.
  - Canvas:
    - assign to everyone, sections, tags or individuals;
    - *Message Students Who* has not submitted or scored below X.
    - https://community.instructure.com/en/kb/articles/660849-how-do-i-send-a-message-to-students-from-the-gradebook
  - Moodle: groups through restrict access, and a Parent role.
  - Khan: assign to a class or to chosen students, and parents can assign too. The reimagined experience drops points and badges for a class Gem goal. https://support.khanacademy.org/hc/en-us/articles/38555182616717-How-do-I-set-the-Gem-challenge-class-reward
  - Quizlet:
    - started/completed counts, with individual data kept 10 days after the end;
    - Study Groups of up to 8;
    - "Study with friends" links with a finished counter.
    - https://help.quizlet.com/hc/en-us/articles/48158602540685-Using-Study-with-friends
  - Knowt: per-student time per mode and mastery; Knowt Play; a leaderboard on a shared predicted exam. https://help.knowt.com/en/articles/17737405-how-to-share-a-predicted-exam-with-friends
  - Brilliant: a grid of who finished, plus leagues of 30 across 10 tiers. https://brilliant.org/help/features/what-are-leagues-and-leaderboards/
- **Friends:**
  - Duolingo Friend Streaks: up to 5 friends, you can nudge, and learners with one are 22% more likely to do the daily lesson (2024-08-05, spot-checked). https://blog.duolingo.com/friend-streak/
  - Duolingo Friends Quests: weekly pairs with a shared goal. https://blog.duolingo.com/friends-quests/
  - RemNote groups share documents read-only, with no progress sharing. https://help.remnote.com/en/articles/8119315-groups
  - Anki's shared decks are copies.

#### Reminders

- **Task apps:**
  - Notion:
    - `@remind`, and a Remind option on date properties with advance alerts;
    - delivered to the Inbox, desktop and mobile push, or email when Notion is closed;
    - no recurring reminders yet.
    - https://www.notion.com/help/reminders
  - Todoist (page updated 2026-10-26):
    - automatic for timed tasks, custom, recurring and by location;
    - can be aimed at a collaborator;
    - push, desktop and email.
    - https://www.todoist.com/help/todoist/features/introduction-to-reminders-9PezfU
  - Things: only on the start date. https://culturedcode.com/things/support/articles/2803585/
  - Linear: Remind me, an Inbox, email digests, and nudges to post project updates. https://linear.app/docs/notifications
  - Sunsama: a planning reminder and a shutdown prompt; per-task reminders have been asked for since 2020 (forum, unverified).
  - Power Planner:
    - a summary the day before, sent 10 minutes after your last class;
    - one hour before an item is due.
    - https://support.powerplanner.net/tasks-and-events/automatic-reminders/
  - MyStudyLife: reminders mute during holidays; parents get a weekly digest. https://mystudylife.com/parent/
- **LMS:**
  - Classroom: 24 h before unsubmitted work is due; a guardian daily or weekly email without grades. https://support.google.com/edu/classroom/answer/6141557, https://support.google.com/edu/classroom/answer/6388136
  - Canvas: per type and channel, immediately / daily / weekly / off, by email, SMS, Slack or push. https://community.instructure.com/en/kb/articles/662894-how-do-i-manage-my-canvas-notification-settings
  - Moodle: 7 days before, 48 h before, and overdue. https://docs.moodle.org/503/en/Assignment_settings
  - Khan: a weekly streak push at a time you choose (app 8.5.0, Aug 2026).
- **Study apps:**
  - Quizlet: spaced repetition reminds at 10 a.m. local on days cards are due.
  - Knowt: a daily reminder at a time you choose. https://help.knowt.com/en/articles/10714597-how-do-i-change-my-notification-settings
  - RemNote: when you fall behind on an exam or have cards due.
  - AnkiMobile: one daily alert. AnkiDroid: when more than n cards are due.
  - Duolingo: a bandit algorithm picks the wording and rests wording you saw recently (KDD 2020). That it also picks the send time is unverified. https://research.duolingo.com/papers/yancey.kdd20.pdf

### 2.2 App by app: what is distinctive

The facts behind each line are cited in 2.1. The links here are each app's main source.

#### Task apps

| App | Distinctive |
| --- | --- |
| Notion | @mentions everywhere. Dependencies keep a chain of dates in line. Progress is any number drawn as a bar. Tasks need a database before they get assignees or reminders for others (https://www.notion.com/help/guides/give-your-to-dos-a-home-with-task-databases). |
| Todoist | The plan date and the deadline are separate. Streaks are protected by vacation mode. A PDF or photo turns into tasks. Goals (beta) was retired on 2026-07-13 (https://www.todoist.com/help/todoist/product-updates/goals-beta-retired-VKe2PuGn5). |
| Things 3 | This Evening splits Today. Repeating deadlines appear early. A pie per project. No sharing at all (https://culturedcode.com/things/support/articles/2803566/). |
| Microsoft To Do | My Day starts blank every day with suggestions. Steps. Flagged email and Planner tasks arrive as lists. |
| Linear | Outside evidence closes the issue (a merged PR). Predicted finish. Partial credit for started work. Health labels. |
| Sunsama | Warns you are overcommitted before the day starts. Rollover counter. Daily work aligned to weekly objectives. The classic ritual is now "Legacy". |
| Akiflow | Warns when a plan date endangers the deadline. You choose what "done" does at the source. One time block holds many tasks and sends one reminder. |

#### Student planners and canvas

| App | Distinctive |
| --- | --- |
| MyStudyLife | Rotating timetables. Revision tasks tied to an exam and planned by AI. A parent companion (https://mystudylife.com/tour/). |
| Power Planner | "What If?" grades. Reminder times follow the timetable. |
| Heptabase | To-dos scoped to the open whiteboard (Nov 2025). Cards live apart from boards. The Task app was folded into the Inbox in June 2025 (https://wiki.heptabase.com/changelog/2025). |

#### LMS

| App | Distinctive |
| --- | --- |
| Google Classroom | A per-student file copy whose edit rights switch at turn-in and return. A guardian digest without grades. Insights such as 3+ missing in a row, with an AI-drafted check-in (https://support.google.com/edu/classroom/answer/18117192). |
| Canvas | The completion rule is per item. Students' own to-dos sit in the course agenda and can link to an item (https://canvas.instructure.com/doc/api/planner.html). Mastery Paths. Per-student pacing. |
| Moodle | A soft reminder date beside the due date. A "cannot be completed" state. Locked items say what unlocks them (https://docs.moodle.org/503/en/Restrict_access_settings). |
| Khan Academy | Due dates build Daily/Weekly Missions; overdue work never drops off. "Done" is a skill state that can go backwards. A shared class goal instead of individual ranking. |

#### Study and gamified apps

| App | Distinctive |
| --- | --- |
| Quizlet | Three-state icons per mode for each student. Assignment links that need no login, with data that expires. Spaced repetition kept apart from Learn. Checkpoint is likely retired (unverified). Q-Chat was reportedly retired after 2025-06-30 (third-party, unverified). |
| StudySmarter / Vaia | The exam date lives on the study set. Plans generated from uploads. Daily goals, streaks and leaderboards are unverified. |
| Knowt | An assignment bundles material, allowed modes, a time goal, a deadline and a late switch (https://help.knowt.com/en/articles/17737407-how-to-assign-a-note-or-flashcard-set-to-a-class). The plan puts the weakest units first. |
| RemNote | An exam timeline in phases with chosen study days. Reviews and new cards as two blocks today. A streak goal separate from the daily goal. Freezes earned, not bought. |
| Anki | FSRS. "Today only" limits. No deadline mode; add-ons fill it. |
| Duolingo | One path. Friend Streaks. Friends Quests. Reminder wording that rests once seen. |
| Brilliant | Streak Charges. A teacher grid with a skills score that is not a grade. Courses renamed topics, units and concepts (Oct 2026). |

## 3. What Capy has today

### 3.1 Read progress

#### Tables

- `study_progress (user_id, workspace_id, file_id | material_id, state, updated_at)`:
  - `state` is `started`, `done` or `removed`, one row per touched item (`server/migrations/0051_study_progress.sql:17-28`);
  - user index in `0118_study_progress_user_idx.sql`.
- `workspace_study (user_id, workspace_id, enabled)`: Hide study progress (`0051_study_progress.sql:9-14`). The global default was dropped in `0108_study_plans.sql:39`.

#### Writes

- `PUT /api/workspaces/{id}/study/items` (`SetStudyItem`, `server/internal/store/study.go:409`):
  - `done` is Mark as read;
  - `removed` is Stop tracking;
  - no state deletes the row (Mark as unread, Start tracking).
- Side effects of practice:
  - `markProgressTx` (`study.go:453-462`) never downgrades `done`;
  - a rating marks a quiz or set `started`, or `done` once every current item is rated (`study.go:571-582`);
  - a quiz check marks it `done` (`study.go:652`).
- `POST /api/workspaces/{id}/study/reset` (`ResetStudy`, `study.go:440`) also clears `review_states`.
- `PUT /api/workspaces/{id}/study/enabled` (`SetWorkspaceStudy`, `study.go:216`).

#### Reads

- `GET /api/workspaces/{id}/study`: items and `enabled`, beside the review parts (`study.go:233-355`).
- `GET /api/learning/progress` (`server/internal/store/learning_progress.go`, 225 lines).
- The plans endpoints, which count steps from tracked items (`study_plans.go:81-185`).
- The agent route `POST /api/internal/study-progress` (`server/internal/httpapi/internal_study.go:8-37`, `AgentStudyProgress` at `study.go:900`).

#### UI

- **Files panel:** marks and the row ⋮ items (`src/features/study/studyItems.tsx`, used by `src/features/files/FileListItem.tsx` and `src/features/materials/MaterialListItem.tsx`).
- **Header:** the Mark as read toggle in `src/features/materials/CenterContentHeader.tsx`.
- **Study page** (`src/features/study/StudyPage.tsx`, 705 lines; map at `:492`, Continue at `:514`):
  - the railway map;
  - Continue (next unread item in reading order);
  - chapter accordions with "done of tracked";
  - the Show filter (Not read / Read / Not tracked);
  - Reset.
  - Rows are drawn by `studyRows.tsx` (405 lines).
- **Railway map:** `src/features/study/railMap/` (`map.ts` 1,191, `buildings.ts` 905, `RailMap.tsx` 384, `railMap.css` 84, `map.test.ts` 82) and `WorkspaceRailMap.tsx`. It borrows pieces from the bank's `features/questions/trailMap/`; the bank does not import it.
- **Learning → Progress** (`src/routes/Learning.tsx`):
  - Continue your study, the map, Your plans, Default plans, Finished;
  - empty state `RecordProgress.tsx` with `PlaceholderRailMap`.
- **Finish toasts:** the workspace half of `src/features/study/finishToasts.ts`. The bank-topic half is separate.
- **Workspace settings:** the Study tab's Hide switch, `src/features/workspace/WorkspaceSettingsDialog.tsx`.

#### What depends on it outside read progress

- **Learning → Review lists a workspace only if it has a non-removed progress row** (`server/internal/store/review_sessions.go:946-956`).
- **Suggestion interest** decays from the last progress change (`review_sessions.go:147-160, 1026`).
- **Stop tracking filters review:** the review pool, the new-item pool and `hasQuizzes` skip `removed` items (`review_sessions.go:1149-1157`; `openwiki/study-progress.md:192-196, 250-254`).
- **File move:**
  - It refuses with 409 `progress_loss` until confirmed, then deletes the progress and plan steps (`server/internal/store/file_move.go:128-146`).
  - Front-end: `MoveFileDialog`; MSW `src/mocks/handlers.ts:625-626, 1856-1864`.
- **Chat tool `read_study_progress`:**
  - `server/internal/agenttools/agenttools.go:1026-1033`;
  - `pipeline/pipeline/retrieval/tools.py:4595-4634, 4701-4702`;
  - the turn flag at `server/internal/httpapi/chat_stream.go:583`.
- **Account purge** (`server/internal/store/account_purge.go:251`).
- **Tests and mocks:**
  - `e2e/study/study-progress.spec.ts` (725 lines);
  - `e2e/uat/journeys/study.spec.ts:301` (asserts progress rows);
  - `src/mocks/study.ts` (1,433 lines);
  - `learning_progress_test.go`, `study_test.go`, `StudyPage.test.tsx`, `finishToasts.test.ts`, `railMap/map.test.ts`.
- **Copy:**
  - The tour's Study step (`src/features/guide/Tour.tsx:200-206`) promises a plan for "what to learn and by when" (`messages/en.json:2575`), though plans hold no dates.
  - The starter note says your files show up on the Study page (`server/internal/store/starter.go:60`).

### 3.2 Plans and steps now

- **Plans:** `study_plans (id, user_id, workspace_id, name ≤ 60)` (`0108_study_plans.sql:4-12`):
  - private to their user;
  - kept in a parent workspace and deleted with it;
  - at most 10 per user per workspace (`server/internal/store/study_plans.go:21`).
- **Steps:** `study_plan_steps (plan_id, position, kind file|material, workspace_id, file_id | material_id)`:
  - `0119_plan_reviews_file_steps.sql:15-25` dropped the chapter, Others and whole-workspace kinds;
  - at most 200 files in 20 chapter groups (`study_plans.go:23-32`);
  - steps can reach any workspace the user reads, and show "locked" once access is lost (`openwiki/study-progress.md:124-128`).
- **Progress:** steps carry none. A step is done when its item's `study_progress` row is `done`, counted in the browser; the current step is the first not done (`src/features/study/plans/planProgress.ts:33-76`).
- **UI:**
  - one plan at a time through `PlanSelect.tsx` (`plan=<id>`), with "Default Plan" meaning chapter order;
  - Add files through `AddStepsPopover.tsx`: workspace → whole workspace, chapters, Others, single files;
  - Remove from plan, Rename and Delete; no reordering at all (`human/study-progress.md:65-66`);
  - Learning lists Your plans (done of total files) and Finished; the Review tab's Your plans start a plan review.
- **Migration numbers:** the shipped files are 0108 and 0119. The "0116" in the brief and the "0118" in `openwiki/study-progress.md:460` are pre-landing numbers: 0116 is `deepseek_chat_default` and 0118 is the progress index.

### 3.3 Review sessions and FSRS, and how they tie to plans

- **FSRS state:**
  - `review_states` per user, material and item, plus an append-only `review_log` (`0051_study_progress.sql:32-56`);
  - the go-fsrs v3 wrapper is `server/internal/review/review.go`: retention 0.9, at most 365 days, no same-day steps;
  - editing an item's prompt resets that item through its hash (`openwiki/study-progress.md:96-107`).
- **No dates:** reviews are ordered by retrievability; signed-in users are never shown a due date, a due count or an interval (`openwiki/study-progress.md:17-21`).
- **Ratings:**
  - cards are rated 1–4;
  - a question's score maps to Again below 0.5, Hard below 0.7, else Good;
  - routes are `POST /api/review/ratings`, `/api/review/check` and `/api/quizzes/{id}/check` (`openwiki/study-progress.md:73-85, 145-148`).
- **Sessions:**
  - `review_sessions` and `review_answers` (`0071_review_sessions.sql`), written with the first answer;
  - groups are chapter, others, workspace, and plan (added in 0119 with `plan_id` and `plan_name`);
  - routes cover a new session, Continue, the result, Finish, Past reviews and the overview (`openwiki/study-progress.md:131-144`).
- **Suggestions:**
  - each item scores `(1 − R) × (1 + tricky + learned)`;
  - items are grouped by chapter, Others or the whole workspace;
  - a workspace's interest decays after 30 days without progress;
  - the top 5 show, at most 2 per workspace (`openwiki/study-progress.md:209-262`).
  - A manual review mixes 60% never-rated items with 40% practised ones (`:247-258`).
- **Quick review:** up to four quick items (`study.go:356`, `quickActions.tsx`, `ZoomCard.tsx`).
- **Attempts:** quiz and flashcard attempts share `attempts`: correct, total, pct, questions, taken_at, kind, started_at (`0001_init.sql:482-496`, `0094_flashcard_attempts.sql`). An attempt is never closed; unchecked questions score 0 (`human/study-progress.md:62`).
- **Preferences:** `users.study_preferences` (0053) holds session size, items and focus.
- **Ties to plans:** a plan review (`group=plan&planId=`) draws on the quizzes and sets among the plan's steps, new items in step order (`PlanScopeOf`, `study_plans.go:433`). It keeps going if the plan loses steps or is deleted (`openwiki/study-progress.md:460-470`). Nothing else carries a plan: attempts, ratings and other sessions do not (`human/study-progress.md:46`).

### 3.4 Other pieces a task model can use, or must clear

- **A dormant planner** (`0001_init.sql:557-598`):
  - Tables: `tasks (id, user_id, title ≤ 80, meta, done, due_date NOT NULL)`, plus `events`, `labels` and `event_labels`.
  - Routes cover list, update and delete only; there is no create route (`server/internal/httpapi/huma_schedule.go:58-67`).
  - `/tasks` and `/schedule` sit behind flags that default to off (`src/lib/features.ts:17-24`, `src/router.ts:434-493`).
  - Its rows come only from `dev_seed.sql:142-148`, and `DashboardCalendar.tsx` is imported nowhere.
  - ROADMAP parks "Calendar and tasks as a product" (`ROADMAP.md:36`).
  - It has no workspace and no link to files, so delete it rather than extend it.
- **`item_opens (user_id, file_id | material_id, opened_at)`** (`0120_workspace_visits.sql:33-44`) keeps each user's last open of each item. It could back an "opened" hint with no new tracking.
- **Mentions:**
  - Notes have @member mentions only, stored as an id plus a label (`src/features/notes/MentionInput.tsx`; `openwiki/frontend/plate-editor.md:116-121`).
  - BlockSuite's @ menu is vendored:
    - It takes a pluggable `getMenus` (`vendor/blocksuite/affine/widgets/linked-doc/src/view.ts:13-31`) and triggers on `@` and `[[` (`widget.ts:223`).
    - Capy switches it off until a docs collection exists (`src/features/blocksuite/pageEditor.ts:47-50`; D14, `todo-blocksuite-spike.md:804-808`).
  - `affine:list` has a `todo` type with `checked` (`todo-blocksuite-layout.md:122-138`). `affine:database` is not registered (`todo-blocksuite-decisions.md:177`).
- **Pickers:** `AddStepsPopover.tsx` already lists workspace → chapters → files.
- **Notifications:**
  - Capy has in-app notifications and an email outbox.
  - Preferences exist only for invites and billing (`0001_init.sql:706-714`, `0060_notification_cleanup.sql`).
  - `emails/templates/` has no study mail.
  - There is no web push in the code (no PushManager or VAPID).
- **Roles:**
  - Workspace roles are owner, editor and viewer, plus a link share role (`openwiki/authorization-permissions-lifecycles.md:27-55`).
  - Every reader records their own progress (`:53`).
  - There is no class or teacher role.

### 3.5 Keep, remove, replace

#### Remove: read progress

| What | Where |
| --- | --- |
| `study_progress` and its indexes | `0051`, `0118` |
| `workspace_study` and the Hide switch, if nothing else needs hiding | `0051`; `study.go:216-231`; `WorkspaceSettingsDialog.tsx` |
| Mark as read / Stop tracking: route, marks, menus, header toggle | `study.go:409`; `studyItems.tsx`; `FileListItem.tsx`; `MaterialListItem.tsx`; `CenterContentHeader.tsx` |
| Progress side effects of ratings and checks | `study.go:453-462, 571-582, 652` |
| Continue, the chapter rows with read counts, the Show filter, Default Plan | `StudyPage.tsx`, `studyRows.tsx`, `features/workspace/workspaceContent.ts` (reading order may stay for other uses) |
| Learning → Progress tab, `GET /api/learning/progress` | `Learning.tsx`, `learning_progress.go`, `RecordProgress.tsx` |
| Railway map, unless it is reused for plans (below) | `src/features/study/railMap/`, `WorkspaceRailMap.tsx` |
| Workspace finish toasts (the bank's stay) | `finishToasts.ts` |
| File move `progress_loss` | `file_move.go:128-146`, `MoveFileDialog`, MSW |
| The tracked-items part of `read_study_progress` | `study.go:900`, `internal_study.go`, `agenttools.go:1026`, `tools.py:4595` |
| Dormant planner (`tasks`, `events`, `labels`, `/tasks`, `/schedule`) | `0001_init.sql:557-598`, `huma_schedule.go`, `routes/Tasks.tsx`, `routes/Schedule.tsx`, `features/tasks`, `features/schedule` |
| Their tests, mocks and copy | e2e study specs, `src/mocks/study.ts`, store tests, tour and starter text |

#### Replace: plans

| Today | Becomes |
| --- | --- |
| `study_plan_steps` (file/material, position) | tasks: text with mention targets, an optional date, an optional completion rule |
| Done from `study_progress` (`planProgress.ts`) | completion rows per person |
| `AddStepsPopover` tree picker | the @ picker, reusing its listing |
| PlanSelect + Default Plan | a plan list or card; no implicit plan |
| Caps: 10 plans, 200 files, 20 groups | new caps (sign-off) |
| Learning's Your plans ("done of total files") | tasks done of total, plus Today / Upcoming |
| Plan review scope = quiz and set steps | scope = quizzes and sets the tasks mention |
| Railway map, if kept | a plan's tasks as stops and headings as stations: it only needs ordered items with done states and groups |

#### Keep: review

`review_states` and `review_log`, `server/internal/review`, the rating and check routes, `review_sessions` and `review_answers` with their plan columns, suggestions, Quick review, `ReviewSession.tsx`, `ReviewResult.tsx`, `PastReviews.tsx`, `attempts` and All results, study preferences, and the signed-out `ts-fsrs` path (`src/lib/srs.ts`).

#### Needs a new source once read progress goes

- **Review tab membership** (`review_sessions.go:946-956`): for example any rated item, attempt, session or plan in the workspace.
- **Interest** (`:1026`): the last rating, attempt or open.
- **The `removed` filters:** gone, or "in scope of a plan".
- **Suggestion groups,** if chapters leave with the canvas: F-impact lists chapters as an open question. Groups could become plans, canvas frames or workspaces.

### 3.6 Earlier decisions the redesign touches (sign-off needed)

- **No dates for review.** No due date, due count or interval is shown for review (`openwiki/study-progress.md:17-21`; the old learning todo, `git show 4dd037d92:todo-learning.md`, lines 160-165 and 282-283).
- **No assumed deadlines.** "Workspace purpose and deadlines are never assumed" (`human/study-progress.md:10`). User-entered dates are not assumed, but the line should be revisited.
- **No study mail.** Review sessions send no push or email; re-engaging inactive users "may come later" (`human/study-progress.md:9`).
- **Parked on the ROADMAP** (`ROADMAP.md:36-38`):
  - "Calendar and tasks as a product", with "do not keep polishing due dates";
  - the "Adaptive study engine".
  - Shape 3 runs straight into both.
- **No defaults without sign-off** (AGENTS.md): a default pass mark for quiz tasks, for example 80%, needs Epo.
- **Embeds record nothing** (`human/study-progress.md:4`). This goes away once quizzes are real files on the canvas.

## 4. Suggestions

### 4.1 What the comparison settles

Each shape below answers six questions. The evidence leans one way on most of them.

1. **Document or record?**
   - Every app that completes tasks by itself or shows who finished uses records: the LMSs, Khan, Quizlet, Knowt, Brilliant, Linear.
   - Document to-dos (Notion, RemNote, Heptabase) are manual and shared.
   - Notion itself moves tasks into a database once they need an assignee, a status or reminders for others.
2. **Whose tick?**
   - Shared lists (Notion, Todoist, Microsoft To Do) keep one tick for everyone, which suits chores.
   - Study and school apps keep the task shared and the tick per person.
   - Friends need the second.
3. **What counts as done?**
   - A manual tick by default, as every task app and Classroom's Mark as done do.
   - Evidence for practice: Canvas's minimum score, Moodle's passing grade, Khan and Knowt mastery, Linear's merge.
   - Opening a file is weak evidence: Canvas's view rule only means the page was opened.
4. **Which dates?**
   - Keep "when I'll do it" separate from "when it's due" (Todoist, Things, Akiflow, Moodle).
   - Only study apps plan back from an exam (RemNote, Knowt, StudySmarter, MyStudyLife).
5. **Where does review sit?** Beside the tasks as a standing block (RemNote), never as checkbox items. This lets Capy keep "no due counts".
6. **Where do tasks show?**
   - Write them per container: a project, class or workspace.
   - Gather them per person: Notion My Tasks over up to 10 databases, Microsoft To Do's Assigned to you, Canvas List View, Classroom To-do, Moodle Timeline, Khan Daily Mission.

### 4.2 Shape 1: checklist card on the canvas

**Borrows from:**
- Notion to-dos with @page mentions;
- Heptabase to-dos scoped to the open whiteboard, and its Journal task list;
- RemNote to-dos inside notes;
- AFFiNE's @ linked-doc menu.

**How it works:**
- A plan is a note card on the workspace canvas. `[]` starts a to-do.
- `@` opens Capy's file list: the vendored linked-doc menu with a Capy `getMenus`. It inserts a chip; clicking the chip opens the file or pans to its card.
- The card has a "Review this plan" button. It starts today's plan review, scoped to the quizzes and sets the chips mention.

**Data:** none new for the list itself (BlockSuite `affine:list` todos). Learning or Today would need a projection of to-dos and mentions out of the room, like effects or indexing.

**What a student gets:** writing a plan feels like writing notes. Headings, notes between tasks and pictures come free, and the plan sits next to the files.

**Costs:**
- **Shared ticks:** a tick is room state, so in a shared workspace one person's tick ticks for everyone (as in Notion's and Microsoft To Do's shared lists).
- **No private plans:** F-impact notes per-note permissions are impossible in one canvas document.
- **No completion rules,** and no cross-workspace plans.
- **Slow aggregation:** a cross-workspace Today must parse every canvas room, against the "fast and performant" rule in AGENTS.md.
- **Switched off today:** the @ menu is off (D14).

**Verdict:** good as "notes with checkboxes", weak as the Study model.

### 4.3 Shape 2: task list with completion rules, plus a review block

**Borrows from:**
- Todoist and Things: the list, headings, a "do on" date apart from a deadline, Today;
- Microsoft To Do: steps, and My Day's daily suggestions;
- Canvas and Moodle: a completion rule per item;
- Linear: @ chips, and evidence closing the task;
- Classroom: Mark as done vs Turn in, and a To-do across classes;
- RemNote: a review block beside the plan's work.

**How it works:**
- **The plan** lives in a workspace, as today. It is private or shared with the workspace's members, and anyone it is shared with ticks their own copy.
- **Each task** is one line of text with @ chips for a file, quiz, flashcard set or note (later a bank topic). Optional: headings, a "do on" date, a rule.
- **Rules:**
  - A manual tick is always there, and also overrides any rule.
  - "Quiz: every question checked", or "score ≥ X%", read from `attempts.correct/total`. Attempts never close, so unchecked questions count 0.
  - "Flashcards: every card rated once", read from the set's flashcard attempt.
  - "Opened" can only suggest a tick, from `item_opens`; it never ticks on its own.
- **Review block:** a pinned row at the top of the plan and of Today: "Review: N practised" (no due counts, as today). It starts the plan review, today's `group=plan` with its scope now taken from the tasks' mentions. Quick review cards come from the same pool.
- **Progress:** "4 of 9 tasks" with a small pie (Things), and counts per heading. The railway map could stay as a plan view: tasks as stops, headings as stations.
- **Today / Upcoming on Learning (or the Dashboard):**
  - every plan's dated and undated tasks, newest plan first;
  - missed dated tasks stay until done, as Khan's do;
  - a "From Tue" label in Akiflow's style.
- **On the canvas:** a plan can be placed as a card that renders the records live, taking Shape 1's spot without its storage.

**Data sketch:** keep `study_plans` and add a visibility. Replace `study_plan_steps` with:
- `plan_tasks`: id, plan_id, position, heading, text as spans with mention ids, do_on, rule;
- `plan_task_targets`: task_id, file_id | material_id, with foreign keys. These cascade, let a quiz check find "tasks that mention this quiz", and let a move or delete clear chips;
- `task_completions`: task_id, user_id, done_at, via (manual or attempt id).

`study_progress` goes.

**What a student gets:**
- One list says what to do and links straight to it.
- Finishing the quiz ticks the task, so nothing is recorded twice.
- Review is always one click away and never becomes a chore list.
- Ticks are small upserts, easy to queue offline. Plans already persist in IndexedDB.

**Costs:** an @ input, three tables, and the rules' evaluation on the quiz-check and rating paths. The paths already exist: progress is marked there today.

**School fit:** the same records let an owner or editor publish a plan to members and see who finished, as Canvas's View Progress and Quizlet's class progress do, with no model change.

### 4.4 Shape 3: plan to a date (exam countdown)

**Borrows from:**
- RemNote Exam Scheduler: the date, study days, phases, an on-track indicator, "Learn More Today";
- Knowt: Learn paced to the exam, weakest units first;
- StudySmarter: the exam date on the set;
- MyStudyLife: revision tasks tied to an exam, split by AI;
- Khan: Daily and Weekly Missions built from dates; overdue work stays;
- Sunsama and Akiflow: rollover counters, overcommit and deadline-at-risk warnings;
- Things: start a few days before the deadline;
- Linear: On track / At risk, and a predicted finish.

**How it works:** Shape 2, plus an exam date and study days on the plan.
- **Spreading:** undated tasks spread over the remaining study days, each getting a "do on". Dates the student set stay put.
- **Today** shows the day's tasks and the review block.
- **Missed tasks** roll forward with a counter. They are re-spread only when the student presses Re-plan, which keeps the machinery small and predictable.
- **Header:** "12 days left · on track / 3 behind". When the work won't fit, it offers to move the date or trim, as RemNote suggests a new goal.
- **Review near the date:**
  - the plan's never-practised items are introduced before a final-review window;
  - the plan review favours plan items, in the spirit of RemNote's phases and Anki's "Advance";
  - still no intervals or due counts shown.
- **AI:** "Plan this from @syllabus.pdf" drafts dated tasks with a preview before adding, like Todoist Task Capture and Scout AI. Capy already has ingest and the agent.

**What a student gets:** an answer to "will I be ready by Friday?", which no general task app gives.

**Costs:**
- a scheduler, dates and timezones;
- reminders need a channel (email and in-app today, no push);
- it collides with "no due dates", "deadlines never assumed" and the parked adaptive engine (§3.6).

Build it only as a layer on Shape 2, after sign-off.

### 4.5 Side by side

| | Shape 1 canvas checklist | Shape 2 task list with rules | Shape 3 plan to a date |
| --- | --- | --- | --- |
| Storage | Canvas room (Yjs) | Postgres rows | Shape 2 + dates |
| Ticks | Shared by all | Per person | Per person |
| Completion from quiz score | No | Yes | Yes |
| Private plans | No (one room ACL) | Yes | Yes |
| Plans across workspaces | Links only | Yes, as today | Yes |
| Today across workspaces | Parse every room | One query | One query + spreading |
| Review | A button | Pinned block | Block + exam phases |
| Teacher/class later | Hard | Natural | Natural |
| New machinery | @ menu, projection | @ input, 3 tables, rules | + scheduler, reminders |
| Prior decisions hit | None | Few | No dates, parked engine |

### 4.6 My pick

Shape 2 as the base, placed on the canvas as a live card where Epo wants it. Add Shape 3's exam date later, if friends ask "am I on track?". This is the split the LMSs and RemNote make:
- records and rules for the work;
- a separate block for review;
- an optional date on top.

### 4.7 Other references worth borrowing (friends and school)

1. **Ticks per person on a shared plan, with friends' avatars on what they finished.** Sources: Classroom's and Canvas's per-student state, Heptabase's read receipts on mentions, Quizlet's finished counter. A student sees friends moving without a ranking.
2. **Cooperative goals rather than leagues.** Sources: Duolingo Friends Quests (a weekly shared goal), Friend Streaks (up to 5, nudges, +22% daily lessons), Khan's class Gem goal. A friend group sets "we all finish week 3 by Sunday" and nudges whoever is behind. Leagues rank strangers (Duolingo, Brilliant). Keep any race opt-in and inside a friend group, like a Knowt-style leaderboard on a shared quiz.
3. **Forgiving streaks, if streaks come at all.** Sources: Todoist's vacation mode, Brilliant's Streak Charges, RemNote's earned freezes, Khan's weekly streak. A missed day doesn't punish a student into quitting.
4. **"Publish to members" with a who-finished grid.** Sources: Classroom (Turned in / Assigned counts), Canvas View Progress, Quizlet's three-state icons, Brilliant (Completed / In progress / Not started), Knowt (time and mastery per student). It maps onto owner and editor roles, so a workspace becomes a class.
5. **Message the ones who haven't** (Canvas *Message Students Who*; Classroom insights with an AI-drafted check-in). Capy's agent could draft the nudge, and the owner sends it.
6. **A per-student copy of a worksheet.** Classroom's "Make a copy for each student", with edit rights switching at turn-in and return. A homework task gives each student their own DOCX. This needs a copy-on-assign, from Capy's clone work.
7. **A soft date plus a hard due date, and Missing / Late states, for assigned work.** Sources: Moodle's reminder date, due date and cut-off; Classroom's Missing; Canvas's labels; Khan keeping overdue work. Students see what slipped, not just what is next.
8. **Branching on a score.** Canvas Mastery Paths, Khan Readiness Missions, Knowt putting the weakest units first. For example: "under 60% on @Quiz 2 adds 'Re-read @Chapter 2 notes'". Students get help where they actually struggle, which AGENTS.md names as a gap in other notebooks.
9. **Syllabus to tasks** (Todoist Task Capture, MyStudyLife Scout AI). "Make a plan from @syllabus.pdf" with a preview: the first plan costs a minute, not twenty.
10. **A morning pick instead of auto-scheduling** (Microsoft To Do's My Day clearing nightly with suggestions; Sunsama's ritual and shutdown; Things' This Evening). This gets most of Shape 3's value with no scheduler.
11. **Reminders fitted to the student's day.** Sources:
    - Power Planner: the day before, after the last class;
    - Classroom: 24 h before due;
    - Quizlet: 10 a.m. on due days;
    - Knowt: a chosen time;
    - Duolingo: wording that rests once seen.

    Start with one opt-in daily email or in-app digest at a chosen time. There is no web push yet.
12. **Guardian digests** (Classroom without grades, MyStudyLife Family Connect, Canvas Parent alerts). These belong to the school platform later.
13. **Live class games on Capy quizzes** (Quizlet Live, Knowt Play with a 6-digit code, Khan's Gem Jam on the teacher's screen only). These are for later; the board stays on the teacher's screen.
14. **Linear's evidence and health:** done from outside evidence, partial credit for started work, On track / At risk. These fit plan status for friend groups and classes.

What not to copy, as signals that these vendors pruned features:
- Todoist retired Goals (beta) on 2026-07-13.
- Khan's reimagined experience drops Course Mastery Goals, energy points and badges.
- Sunsama labels its classic ritual Legacy.
- Heptabase folded its Task app into the Inbox (June 2025).
- Quizlet's 2017 test-date plan seems gone, and Checkpoint and Q-Chat are likely retired (unverified).

## 5. Open questions for Epo

1. **Private, shared or both:** are plans private, shared with the workspace, or both? Who sees whose ticks?
2. **Storage:** are tasks rows (Shape 2) or to-dos in the canvas (Shape 1)? Should the canvas show a plan as a live card?
3. **Rules:** which completion rules, and is there a default pass mark? (AGENTS.md: no defaults without sign-off.)
4. **Dates:**
   - Do tasks get a "do on" date?
   - Do plans get an exam date?
   - Does "no due dates or counts" for review stay?
   - Does the ROADMAP's calendar parking still hold?
5. **Today:** where does the cross-workspace Today live: Learning, the Dashboard, or both?
6. **Hide switch:** does Hide study progress (`workspace_study`) stay as "Hide study", or go?
7. **Grouping:** if chapters go, what groups suggestions: plans, canvas frames or the workspace?
8. **Railway map:** reuse it as a plan view, or delete it?
9. **Reminders:** opt-in email or in-app digest first? A session or task reminder reverses the 2026-10-10 "no push or email" line.
10. **Dormant planner:** delete `tasks`, `events`, `labels`, `/tasks` and `/schedule` with read progress?
11. **Agent:** may the chat agent create or edit tasks? Should `read_study_progress` become a plan and attempt read?

## Appendix: paths

| Area | Paths |
| --- | --- |
| Docs | `openwiki/study-progress.md`; `human/study-progress.md`; `openwiki/question-bank.md:699-760` (bank progress, separate); `ROADMAP.md:36-38`; `git show 4dd037d92:todo-learning.md`; `todo-blocksuite-spike.md:804-808, 965-967`; `todo-blocksuite-decisions.md:177` |
| Migrations | `0051_study_progress.sql`; `0053_study_preferences.sql`; `0071_review_sessions.sql`; `0094_flashcard_attempts.sql`; `0108_study_plans.sql`; `0118_study_progress_user_idx.sql`; `0119_plan_reviews_file_steps.sql`; `0120_workspace_visits.sql` (item_opens); `0001_init.sql:482-496` (attempts), `:557-598` (planner), `:706-714` (notification prefs) |
| Go: study | `server/internal/store/study.go` (1,148); `study_plans.go` (469); `review_sessions.go` (1,369); `learning_progress.go` (225); `server/internal/review/review.go` |
| Go: routes | `server/internal/httpapi/huma_study.go` (527); `internal_study.go`; `huma_schedule.go` |
| Go: dependents | `file_move.go:128-146`; `account_purge.go:251`; `agenttools/agenttools.go:1026`; `chat_stream.go:583` |
| Pipeline | `pipeline/pipeline/retrieval/tools.py:4595-4702`; `pipeline/pipeline/retrieve/service.py:286, 487` |
| Front end: study | `src/features/study/` (StudyPage, studyRows, studyItems, quickActions, ZoomCard, ReviewTab, PastReviews, ReviewResult, AllResults, finishToasts, RecordProgress, WorkspaceRailMap, railMap/, plans/) |
| Front end: routes | `src/routes/Learning.tsx`, `ReviewSession.tsx`, `ReviewResult.tsx`, `Tasks.tsx`, `Schedule.tsx` |
| Front end: other | `src/api/hooks.ts:2833-3188`; `src/lib/features.ts`; `src/features/guide/Tour.tsx:200-206` |
| BlockSuite | `vendor/blocksuite/affine/widgets/linked-doc/src/view.ts:13-31`, `widget.ts:223`; `src/features/blocksuite/pageEditor.ts:47-50` |
| Tests and mocks | `e2e/study/study-progress.spec.ts`; `e2e/uat/journeys/study.spec.ts`; `src/mocks/study.ts`; `server/internal/store/*study*_test.go`, `learning_progress_test.go`, `review_sessions_test.go` |
