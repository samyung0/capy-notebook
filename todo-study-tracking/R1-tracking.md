# R1 · Tracking members' scores and performance in education apps

Research for Capy Notebook's workspace performance tracking, 2026-11-02. This was
read-only research: nothing in the repo changed. Sources are official help centres,
product source code (Canvas is open source) and, where an official page blocked
automated reading, the search engine's excerpt of that page.

## How to read this report

- Every claim carries a reference key such as [G1]. The keys map to URLs under
  **References** at the end.
- Evidence marks:
  - **No mark:** read on the cited official page, or in the product's own source code.
  - **(snippet):** the claim rests on the search engine's excerpt of the official
    page. Either the page refused automated reading (the Khan Academy, Quizlet,
    Kahoot, Gradescope and Blooket help centres answer 403), or I did not open it.
    Treat these as medium confidence.
  - **(secondary):** a school guide, a third-party review or a community post. Low to
    medium confidence.
  - **(unverified):** from memory, or not confirmed by any source I found. Treat these
    as leads.
- Quotes are a few words at most.
- Thin coverage: I found too little reliable material on Pear Assessment's report
  screens, Schoology's item analysis, Carousel's analytics and CENTURY's algorithm,
  so those rows are short.

## What Capy has today (context for the options)

From `openwiki/study-progress.md` and `openwiki/question-bank.md`:

- **Privacy:** progress and review state are private to their user. Anyone who can
  read a workspace records their own progress, and nobody else can read it.
- **Attempts:** a quiz attempt is never closed, so a partial attempt counts with
  whatever it checked. `correct` holds the awarded marks and `total` the quiz's marks;
  `started_at` is the browser's start time and `taken_at` the latest check.
- **Grading:** the server grades every check. Jev grades open parts against the
  marking scheme.
- **Question format:** questions have ordered parts with whole marks (1–20), seven
  answer types, and marking-scheme items on open parts. The unenforced timer was
  removed.
- **Topics:** workspace quizzes have no topic tags. Bank questions sit in an
  exam → subject → topic tree, and bank progress keeps only the latest score per
  question.
- **Review:** there is FSRS state per question and card, an append-only rating log,
  recorded review sessions, and suggested reviews labelled Tricky, Fading or Just
  learned.
- **Hiding:** Hide study progress hides progress from the user themself, and
  recording continues. Embedded quizzes record nothing.

A teacher view therefore needs three things Capy lacks:

1. a rule for who may read a member's results;
2. a test mode with a closed, timed attempt;
3. a source of topics.

---

## 1. Views

### 1a. Class overview (students × work, completion, averages)

| App | What the teacher sees | Refs |
|---|---|---|
| Google Classroom | **Grades page:** students × assignments (layout unverified). **Analytics tab** (Education Plus or the Teaching and Learning Upgrade): assignment completion % for a chosen period, average grade, "Active students %", and a drill-down to one student's assignments. Assignments with zero submissions are left out by default. Data refreshes daily and covers only classes created or updated in the last 365 days. | [G3] [G5] |
| Canvas | **Gradebook:** students × assignments, with assignment-group totals (layout unverified). **New Analytics:** course grade and weekly activity charts (details unverified). It has been the only course analytics since 2025, when legacy Course Analytics was removed (secondary). | [C16] |
| Moodle | **Grader report:** students × grade items under category columns. Teachers can collapse categories, sort, and hide or lock items; overrides are marked. In group mode a group filter appears; a page holds up to 5000 rows. | [M6] |
| Schoology | Gradebook by grading category and grading period (snippet; layout unverified). | [S4] |
| Teams for Education | **Grades tab:** students × assignments (unverified). **Insights tab or app:** activity, assignments and grades, for class owners only. | [T2] [T3] |
| Khan Academy | **Reimagined dashboard** (district rollout from back-to-school 2026): shows "who needs attention" and what to assign next. Reports: Assignments overview, Responses, Activity, Skills, and Assignment scores with CSV export (snippet). | [K8] [K3] |
| IXL | **Score Grid**, "like a digital grade book": SmartScores by skill, filterable by standards. Also an assignment completion grid. | [I2] [I4] |
| Quizlet | **Class Progress** per set: each student's status per study mode (not started, started, finished), covering the last two weeks by default. Web only; needs Quizlet Plus for teachers (snippet). | [Q1] |
| Wayground (ex-Quizizz) | An overview, plus a separate report per attempt. Sort and filter by accuracy, score and submission time; growth graphs across quizzes. | [W1] |
| Kahoot | **Report summary:** participants, who didn't finish, the podium, and difficult questions. | [KH2] |
| Formative | **Tracker:** students × formatives, or students × standards, with colour-coded scores. The date range defaults to 14 days, and only school and district plans can change it. "Hide Names" for projecting. | [F2] |
| Sparx Maths | **Dashboard:** completion across classes. **Hand-in page** per student: a completion bar split into correct, incorrect, video watched and unanswered; working time without idle time; bookwork-check accuracy; the last six weeks. Statuses: Get going, Partial completion, Complete. | [SP1] [SP2] |
| CENTURY | **Overview tab:** nuggets completed, questions answered, time spent, average scores. Assignments from the last 14 days open an Assignment Markbook. | [CE1] |
| Seneca | Tabs: **Students** (last active), **Assignments**, **Grades** (across assignments, filterable by course, topic and date, with Excel export) and **Knowledge Gaps**. | [SE1] |
| Carousel Learning | Homework completion reports and Whole Class Feedback reports. Details of the analytics are thin. | [CA2] |
| Duolingo for Schools | Dashboard of XP, time spent and each student's latest assignment, in list and course-progress views (snippet). | [D1] |
| Blooket / Gimkit | **Blooket** homework results: a student leaderboard with accuracy, question breakdown, time played and completion (snippet). **Gimkit** assignment results filter by Completed, Working On It and Has Not Started. | [B2] [GK3] |

### 1b. Per-assignment results (difficulty, wrong answers, time)

| App | Difficulty | Common wrong answers | Time | Item quality | Refs |
|---|---|---|---|---|---|
| Moodle quiz statistics | Facility index ("average mark (as a percentage)") per question. The report covers all attempts or first attempts only. | Response frequency per answer, each marked right or wrong (not for essays) | Not stated | Discrimination index, discriminative efficiency, SD, random-guess score, intended vs effective weight; Cronbach's alpha. Low discrimination is shaded red, with no numeric cutoff. | [M2] |
| Canvas | New Quizzes "Quiz and Item Analysis" has quiz-level and item-level sections (snippet) | Distractor statistics in Classic Quizzes item analysis (secondary) | Unverified | Canvas's "discrimination" matches the point-biserial of the correct option (secondary). Classic item analysis covers only multiple choice and true/false (secondary). | [C14] [C15] |
| Google practice sets | How many answered each question correctly | All responses to one question | — | Insights on "where the class or individuals struggled" | [G6] |
| Kahoot | % correct per question; difficult questions highlighted below 35% correct (snippet) | Per-question split of correct and incorrect | Game duration | — | [KH2] [KH1] |
| Wayground | Accuracy per question | — | Time per question per student | — | [W1] |
| Gradescope | How often each rubric item was applied per question; statistics groupable by tag (snippet) | Rubric items act as named error types | — | Bubble-sheet item analysis: a point-biserial "discriminatory score", flagged below 0.20 and N/A at 0% or 100%. Bands: hard below 50%, medium 50–84%, easy 85–100% (snippet). | [GS1] [GS2] |
| Blooket | Accuracy and correct, incorrect and unattempted counts per question (Plus) (snippet) | — | Average answering time | — | [B1] |
| Sparx Maths | One square per student per question, showing attempts and whether it was correct after retries | — | Working time per student | Flags: failed bookwork check, swapped question, "seek help", video watched | [SP1] |
| IXL | Trouble Spots list the actual questions students missed, by item type | The missed questions themselves | — | — | [I2] |
| Quizlet | The Mastery view groups a set's terms by how often students got them right or wrong (snippet) | — | — | — | [Q1] |

### 1c. Per-student profile

| App | Scores over time | Mastery by skill or topic | Engagement | Refs |
|---|---|---|---|---|
| Google Classroom | A student page lists their assignments, with insight cards at the top | Learning goals single-goal view | Patterns of activity, late work and missing work | [G3] [G4] [G8] |
| Canvas | Grades per student (unverified) | A row per student in the Learning Mastery Gradebook (layout unverified) | New Analytics per student (unverified) | [C13] |
| Moodle | **User report:** every grade item with feedback and weight, plus optional rank and contribution to the total | **Competency breakdown report:** the student's rating per competency, editable by the teacher | — | [M5] [M4] |
| Khan Academy | Assignment scores | Skill levels and unit missions; the older Activity, Skills and Mastery tabs (snippet) | Activity and minutes | [K7] [K10] |
| IXL | Questions log per skill (secondary) | Diagnostic level per strand, with an action plan | Usage (unverified) | [I5] [I4] |
| Sparx Maths | Six weeks of compulsory results | — | Working time, independent-learning time, an answer timeline | [SP1] |
| CENTURY | Student dashboard, opened from the class overview | Recommended focus and stretch nuggets | Time | [CE1] [CE2] |
| Formative | A side panel listing the student's work | Standards grouped by score band | — | [F2] |
| Teams Insights | Drill-down to one student's class activities | — | Activity, meetings, files | [T2] |

### 1d. Class × skill heatmaps

| App | Grid | Refs |
|---|---|---|
| IXL | **Score Grid:** students × skills; highlight scores above thresholds; filter by standards | [I2] |
| Canvas | **Learning Mastery Gradebook:** students × outcomes, coloured by the mastery scale (unverified; the code is at [C13]) | [C13] |
| Google Classroom | **Learning goals:** a "whole class multi-goal view" with trend arrows, and a single-goal view | [G8] |
| Formative | Tracker standards view, colour-coded by score thresholds (bands not documented) | [F2] |
| Wayground | Accuracy per standard; no grid described | [W1] |
| Khan Academy | Unit missions such as "3 of 22 skills to Proficient" (snippet); Reimagined has no course-level grid | [K10] [K6] |
| Moodle | No heatmap: a per-student competency breakdown and course competency statistics | [M4] |

---

## 2. Aggregation

### 2a. Grades

| App | Points vs percent | Weighting | Practice excluded | Attempt policy | Missing / late | Grading periods | Refs |
|---|---|---|---|---|---|---|---|
| Google Classroom | Overall grade: none, total points, or weighted by category | Category weights must add up to 100% | Practice-set scores must be entered by hand | One submission (unverified) | Excused work leaves the calculation; work can be marked "Missing" (effect on the overall grade not stated) | A separate grading-periods article exists (not read) | [G1] [G6] |
| Canvas | Points, percent or letter schemes | Assignment groups weighted by percent; drop lowest or highest, and "never drop" | Practice quiz type; "omit from final grade" | Classic Quizzes keep the highest (default), latest or average score. New Quizzes has a similar setting (options unverified). | **Late policy:** a % deduction per hour or day, with a floor. **Missing policy:** a % deduction. | Grading periods with weights and close dates | [C8] [C7] [C9] [C11] [C5] [C10] |
| Moodle | Real, percentage, letter, or two together | 9 aggregations: Natural (default unverified), mean, weighted mean, simple weighted mean, median, lowest, highest, mode, and a legacy extra-credit mean. Drop lowest or keep highest per category. | Hidden items or zero weight (unverified) | Quiz: highest, average, first or last attempt | Per category, empty grades are either ignored or counted as the minimum | None found (unverified) | [M1] [M7] [M8] [M3] |
| Schoology | A category is graded by total points or by item percentages; the overall grade uses unrounded values | Category weights; drop the lowest n | "Count in grade" turned off for practice and pre-assessments (snippet) | Unverified | Unverified | Grading periods, plus final and midterm weights (snippet) | [S1] [S4] |
| Teams for Education | Points by default; letter schemes available | Weighted categories adding up to 100% (snippet) | When categories are on, items without one don't count (snippet) | Unverified | Unverified | Unverified | [T1] |
| Formative | Points earned over points possible, summed across everything in view | Questions with more points weigh more | — | — | Unanswered questions in unsubmitted work are left out; blanks in submitted work count | Date-range filter | [F2] |
| Gimkit | — | — | — | The report counts each student's first response; results record the first three attempts | Past-due icon | — | [GK2] [GK3] [GK1] |
| Sparx Maths | Completion rather than a score: compulsory homework is complete when every question is correct (school guide, secondary) | — | XP Boost and Target homework are optional | Students retry until correct | "Late" and "Not opened" labels; a low completer finishes 50% or less | Weekly hand-in | [SP1] [SP2] [SP4] |
| Quizlet | Class Progress is "not meant" for grading (snippet) | — | Everything is practice | — | — | Two-week window | [Q1] [Q2] |

### 2b. Mastery calculation methods

| Method | Rule | Offered by (default in bold) | Refs |
|---|---|---|---|
| Highest | The best score | Canvas, Google learning goals, Pear ("Maximum"), D2L Brightspace (snippet) | [C1] [G8] [P1] [D2L] |
| Most recent | The latest score | Canvas, Google, **Pear**, D2L | [C1] [G8] [P1] [D2L] |
| Average | The mean of all scores | Canvas (with a warning), Google, Pear, Schoology | [C1] [G8] [P1] [S3] |
| Decaying average (new Canvas) | The newest score gets X%; the running total of older scores decays by (100−X)% at each step. X is 50–99, default 65. | Canvas (behind a feature flag), Google (65/35), Pear (65/35 unless an admin changes it), **Schoology** (75% decay rate), D2L | [C1] [C2] [C3] [G8] [P1] [S2] |
| Weighted average (the legacy Canvas "decaying average") | The newest score counts X%, the average of all others (100−X)%. X is 1–99, default 65. | Canvas | [C1] [C2] |
| n Number of Times | The student must reach mastery n times (1–10, default 5); scores above mastery are averaged | Canvas | [C1] [C2] [C3] |
| Moving average | The mean of the last N scores (default 5) | Pear | [P1] |
| Mode | The most frequent score | Google, Pear, **D2L "Most common"** (snippet) | [G8] [P1] [D2L] |
| Power law | A best-fit trend line; the formula is not published | Pear | [P1] |
| Total points | Points earned over points possible on tagged work | Google, Formative Tracker | [G8] [F2] |
| Level rules | Attempted below 70%. Familiar at 70–99% in an exercise. Proficient: all correct, starting from Familiar. Mastered: all correct on a unit test or course challenge, starting from Proficient. Levels can also go down (snippet). | Khan Academy | [K1] |
| Adaptive score | The SmartScore runs 0–100 and is not percent correct: it rises and falls with difficulty, recent answers and consistency. 80 means proficient. 90 means excellence and opens the Challenge Zone (smaller gains, bigger drops). 100 means mastery (snippet). | IXL | [I1] [I7] |

**Notes:**

- **Against plain averages:** Canvas's own interface warns that plain average "is not a good fit" for mastery, because early poor results drag it down [C1].
- **Order of results:** Canvas orders results by submission time (secondary) [C18]. Schoology orders them by when each observation was last modified [S2]. Google uses the due date, or the publication date when there is no due date [G8].
- **Pear's docs:** Pear defines "Maximum" with the same words as most recent, which looks like a documentation error [P1].

---

## 3. Strengths and weaknesses

### 3a. How they are decided

| App | Unit | Rule and evidence | Refs |
|---|---|---|---|
| Canvas | Outcome (account or course level) | The calculation is set per outcome (2b). For the averages, one result is enough: "the single score will be returned". n times needs n results. | [C1] |
| Moodle | Competency | A teacher rates by hand. Alternatively, completing a linked activity can attach evidence, send the competency for review, or complete it. | [M4] |
| Google Classroom | Learning goal: either Google's "learning skills" or official standards | A per-goal score, using one of six methods. A goal linked to a rubric uses only that criterion's points. Insight trends: 3 or more consecutive missing assignments, grades trending, frequent late work, completion rising. A 2025 post adds: no class visit in a week, grades up over 25% since last month, over half of work late, and scores below 70% as a factor. | [G8] [G4] [G5] |
| Pear Assessment | Standard | Points on the standard's items over points possible (from the docs' example). District admins set the bands; the defaults are Exceeds ≥90%, Mastered ≥80%, Almost ≥60%, Not mastered <60%. | [P1] |
| Formative | Standard | Points summed over the date range | [F2] |
| Khan Academy | Skill | The level rules in 2b. Course mastery counts only Proficient or Mastered skills (snippet). | [K1] [K2] |
| IXL | Skill and item type | **Trouble Spot:** 3 missed questions in one item type of a skill. **Live Classroom:** a tile turns red after 3 misses in the last 5. **Diagnostic:** shows a level range that narrows to one number (a star) as answers come in; students keep it current with 10–15 questions a week (snippet). | [I2] [I5] |
| Kahoot | Question | Difficult when under 35% answer correctly (snippet) | [KH1] |
| Gradescope | Question, rubric item, tag | Hard below 50% correct; low discrimination below 0.20 (snippet) | [GS2] |
| Sparx Maths | Question | A "seek help" flag after 6 failed attempts, once the student has watched the video | [SP1] |
| Quizlet | Term | Terms grouped by how often they were answered right or wrong (snippet) | [Q1] |
| Seneca | Topic | Knowledge Gaps show the topics a student struggles with; the rule is not documented | [SE1] |
| CENTURY | Nugget | AI recommends focus and stretch nuggets; the rule is not documented | [CE2] |

### 3b. How they are shown

- **Colour bands on grids:**
  - IXL Score Grid thresholds [I2];
  - Formative score bands [F2];
  - Canvas mastery-scale colours (unverified);
  - CENTURY nugget scores in red, yellow and green (school guide, secondary) [CE4].
- **Named levels:** Khan's four levels [K1], Pear's four grades [P1], and IXL's 80, 90 and 100 milestones [I1].
- **Trend arrows:** Google learning goals [G8].
- **Lists of the exact missed questions:**
  - IXL Trouble Spots, sorted by how many students share each spot [I2];
  - Kahoot's difficult questions [KH2].
- **Insight cards with a reason and an action:**
  - **Google:** cards on the homepage, Stream, Analytics and student pages. Teachers rate them with thumbs up or down, and Gemini drafts a check-in, a guardian email, or teaching strategies [G4].
  - **Khan:** "who needs attention" [K8].
  - **Teams:** "advanced inferences (such as engagement warnings)", behind an admin toggle [T2].

### 3c. Who sets the tags

| Source | Apps |
|---|---|
| The platform's curriculum | Khan Academy, IXL, Sparx Maths, CENTURY, Seneca, Duolingo |
| Admins build frameworks; teachers link them | Moodle competencies [M4]; Canvas outcomes at account or course level [C4]; Schoology [S2]; Pear, where the district also sets the calculation and bands [P1] |
| Teachers tag each question | **Formative:** several standards per question, from the Common Standards Project or custom sets [F1]. **Wayground:** topics and standards [W1]. **Gradescope:** tags [GS1]. **Google learning goals:** up to 10 per item [G8]. |
| AI suggests, teacher confirms | Google learning goals, with a "may not be accurate" warning [G8] |
| AI decides | CENTURY recommendations [CE2] |
| Standards imports | Google ingests CASE-format standards through 1EdTech, Common Good Learning Tools and the Satchel Rosetta Exchange [G9] |

---

## 4. Students' own view, peers and parents

| App | Own data | Peers | Parents | Refs |
|---|---|---|---|---|
| Google Classroom | Grades once work is returned; the overall grade only if the teacher shows it | None found (unverified) | Guardian email summaries, daily or weekly: missing work, upcoming work, class activity. No grades. | [G2] [G1] [G10] |
| Canvas | Grades once posted. Courses can hide final grades, or "restrict quantitative data" so no numbers show. | Grade distribution graphs, unless the course hides them | An Observer role linked to a student | [C6] [C8] [C17] |
| Moodle | User report; the quiz review options decide when marks, feedback and right answers appear | An optional rank column | Unverified | [M5] [M3] |
| Schoology | Grades; practice work shown without counting (snippet) | Unverified | Parents see progress (snippet) | [S4] |
| Teams for Education | Students never see Insights | — | A weekly guardian email digest of assignments. The Parent Connection app was retired after 30 Sep 2025. | [T2] [T4] |
| Khan Academy | Skill levels and unit missions (snippet) | Reimagined has leaderboards, for district partners only (snippet) | Parent accounts (snippet, article title only) | [K10] [K5] [K12] |
| IXL | SmartScores (unverified detail) | Unverified | Shareable progress reports for families | [I4] |
| Formative | Question tags, and their own Tracker tab | — | — | [F1] |
| Wayground | Answers after each question, or a review at the end, depending on settings (older Quizizz guide, secondary) | A leaderboard on student screens, as a toggle (secondary) | Reports can be shared with parents | [W3] [W1] |
| Kahoot | The live podium | The podium and live ranks | — | [KH2] |
| Gradescope | Grades once published; regrade requests (snippet) | — | — | [GS1] |
| Sparx Maths | XP and XP levels | Teachers can run XP leaderboards over custom timeframes (snippet); a school-vs-school completion leaderboard for staff | Parent guides written by schools (secondary) | [SP3] [SP2] |
| CENTURY | The recommended path | — | **Guardian portal:** average score per nugget and number of attempts (school guide, secondary). Guardian insight emails. | [CE4] [CE3] |
| Seneca | Unverified | — | Grades sent to parents with School Sync | [SE1] |
| Carousel Learning | Students mark their own quizzes and teachers moderate (secondary); student homepages on Platinum MIS plans | Whole Class Feedback reports for discussing results with the class | — | [CA1] [CA2] |
| Duolingo for Schools | XP and streaks | Leagues and friends (school settings unverified) | Families can remove teacher access (third-party summary of the policy, secondary) | [D3] |
| Blooket / Gimkit | Game results; Gimkit allows replays | In-game leaderboards | — | [B2] [GK2] |

---

## 5. Privacy and visibility

### 5a. Who sees what

| App | Teacher | Co-teacher or leader | Student | Parent | Refs |
|---|---|---|---|---|---|
| Google Classroom | Class analytics automatically (Education Plus) | Super admins can designate "education leaders" with analytics access | Their own returned grades | Summaries without grades | [G5] [G2] [G10] |
| Canvas | Gradebook and outcomes | TA and designer roles (scope unverified) | Posted grades | Observer | [C17] [C6] |
| Moodle | Grader report, granted by default to managers, teachers and non-editing teachers; filter by separate groups | Non-editing teachers get the same capability | User report | Unverified | [M6] |
| Teams for Education | Insights, for class owners with a faculty licence | Education leaders see aggregations | No access to Insights | Guardian digest | [T2] [T4] |
| Formative | Tracker, with Hide Names for projecting | Admin Team Tracker | Their own Tracker | — | [F2] [F1] |
| Kahoot Study Groups | — | — | Everyone's scores on the group leaderboard | — | [KH3] |

### 5b. Releasing results later, and hiding grades

| App | Release later | Hide | Refs |
|---|---|---|---|
| Canvas | Manual posting per assignment, or scheduled posting of grades and comments | Hide final grades; hide grade distribution graphs; restrict quantitative data | [C6] [C8] |
| Google Classroom | Grades stay drafts until returned; "Automatically return after grading" is an option in Grade all | The overall grade stays hidden unless the teacher shows it | [G2] [G1] |
| Moodle | Review options in four windows: during the attempt, immediately after (within 2 minutes), later while the quiz is open, and after it closes. Grade items can be "Hidden until" a date. | Hidden items; locking after a date. The "View hidden grades" capability bypasses hiding. | [M3] [M7] |
| Gradescope | Publish grades and email students (snippet) | — | [GS1] |
| Capy today | — | Hide study progress hides progress from the user themself | study-progress.md |

### 5c. Legal context for minors

- **FERPA (US):**
  - It gives parents rights over their children's education records. The rights pass
    to the student, as an "eligible student", at 18 or on entering postsecondary
    education [L1].
  - It binds schools that receive US Department of Education funds, and vendors
    usually see records as "school officials" under contract. Both points are
    unverified: they are not on the fetched page.
  - In *Owasso v. Falvo* (2002) the Supreme Court held that "peer grading does not
    violate FERPA": marks a classmate gives are not education records until the
    teacher records them [L2].
- **COPPA (US):**
  - It covers online services that collect personal data from children under 13.
  - The FTC finalised amendments on 16 Jan 2025. They require separate parental
    consent before disclosing children's data to third parties, and they forbid
    keeping that data indefinitely [L3].
  - The FTC declined to adopt the proposed rules specific to edtech in schools [L3].
  - The rule took effect on 23 Jun 2025, with compliance due by 22 Apr 2026. These
    dates are unverified.
- **EU:** GDPR Article 8 sets 16 as the age at which a child can consent to an
  online service. Member states may lower it, but not below 13 [L4].
- **UK:** the Age Appropriate Design Code expects high-privacy defaults and
  profiling off by default for under-18s. This is unverified, because the ICO page
  refused fetching [L5].
- **For Capy:**
  - Adult friend groups need GDPR-grade transparency about what is shared, and
    consent.
  - Schools later act as the data controller. That needs data-processing agreements,
    age gates, and leaderboards and profiling switched off by default for minors.

### 5d. Retention

- **Teams Insights:**
  - Data stays until an admin turns Insights off or the tenant's subscription ends.
    Turning Insights off deletes all its data, and the data cannot be restored.
  - When an account closes, its data stays "to provide completeness" for past
    periods, until an admin files a deletion request. The request waits a week and
    completes within 28 days [T2].
- **Display windows** (these limit what is shown; they delete nothing):
  - Google Classroom analytics shows only classes created or updated in the past
    365 days [G3].
  - Formative's free plans show only the last 14 days [F2].
- **Kahoot:** reports can be moved to a Trash Bin [KH2].
- **COPPA (2025):** children's data may be kept only as long as reasonably necessary,
  never indefinitely [L3].
- **Capy today:** account purge deletes the user's progress rows. When a user loses
  access, their rows stay but can't be read (study-progress.md, Lifecycle).

---

## 6. Small groups (friends, not school)

| App | What exists | Refs |
|---|---|---|
| Kahoot Study Groups | Anyone old enough can create a group and add kahoots. A group leaderboard shows everyone's scores, overall, by month or by week (snippet). The age limit is 13+ in the US and 16+ elsewhere according to one help page; another says under-16s cannot join. Kahoot Groups can also assign challenges and read their reports (snippet). | [KH3] [KH4] |
| Duolingo | Follow friends to see their progress. Weekly Friends Quests pair two friends on a shared goal, with nudges; users can opt out in settings (2022). | [D2] |
| Brainscape | Classes with a "Learner report" (student, card, mastery, time), under a paid class licence | [BR1] |
| Quizlet | Class Progress requires Quizlet Plus for teachers (snippet) and is aimed at teachers | [Q1] |
| Gimkit / Blooket / Wayground | Anyone can host a game and read its report; Gimkit assignments need Pro | [GK1] |

No app I found gives a group of friends a members × quizzes grid with mutual opt-in
sharing. Friend features are leaderboards, streaks and quests, and the tracking views
all assume a teacher.

---

## 7. Retired, renamed and changed (with dates)

- **Khan Academy Reimagined** (snippet) [K4] [K5] [K6]:
  - **Rollout:** late June 2026 for teachers in the USA, early July 2026 for North
    America, Europe and several other regions, early 2027 for the rest.
  - **Retired:** Course Mastery Goals, which Unit Missions replace, and the purple-bar
    Course Mastery report.
  - **Older system:** 2018 materials show mastery points of 50, 80 and 100 per skill
    (snippet) [K11].
- **Canvas:**
  - Legacy Course Analytics was removed in 2025: on 19 Jul 2025 according to
    Montclair, in August 2025 according to Harvard DCE. New Analytics is now
    mandatory (secondary) [C16].
  - The legacy "decaying average" is now called "weighted average". A new "decaying
    average" sits behind the "Outcomes New Decaying Average Calculation Method"
    feature flag [C2] [C4].
- **Microsoft Teams:** the Parent Connection app was retired after 30 Sep 2025; the
  weekly guardian digest continues [T4].
- **Quizizz** became **Wayground** on 24 Jun 2025 (secondary) [W2].
- **Edulastic** became **Pear Assessment** (date unverified).
- **Moodle:** "Mean of grades (with extra credits)" is unsupported and kept only for
  backward compatibility [M1].
- **Google Classroom:** practice sets became generally available in April 2023
  (snippet) [G7]. The Analytics tab and class insights rolled out from 9 Jun 2025,
  expected to finish by 1 Aug 2025 [G5].

---

## 8. Patterns that matter for Capy

1. **Grades and mastery are two different numbers.**
   - Canvas keeps a Gradebook and a separate Learning Mastery Gradebook [C13].
   - Google adds learning goals beside grades [G8].
   - Schoology and Pear calculate mastery apart from category grades [S2] [P1].
   - Quizlet says its progress data is not for grading [Q1].
2. **Practice shows but does not count.** Canvas has practice quizzes and "omit from
   final grade" [C9] [C11]; Schoology has "count in grade" [S4]; Google practice-set
   scores must be entered by hand [G6].
3. **The first teacher view is a students × work grid** with a status and a score in
   each cell. Every LMS has one, and so do Formative, Sparx, Blooket and Gimkit
   [M6] [F2] [SP1] [B2] [GK3].
4. **Per-question difficulty is cheap and needs no tags:** % correct or facility,
   plus answer frequencies (Moodle, Kahoot, Blooket, Wayground, Gradescope). Item
   statistics such as discrimination need many takers: Moodle says low values need
   investigation [M2], and Gradescope shows N/A at 0% or 100% [GS2].
5. **Mastery methods converge on recency.**
   - A 65/35 decaying average is the commonest default [C1] [G8] [P1]; Schoology
     uses 75% [S2].
   - Canvas warns against plain averages [C1].
   - Khan and IXL let levels fall [K1] [I1].
6. **Judgements wait for small, explicit counts and say why:**
   - 3 misses, or 3 of the last 5 (IXL);
   - 6 attempts (Sparx);
   - 3 consecutive missing assignments (Google);
   - under 35% correct (Kahoot);
   - n times (Canvas).

   IXL shows a range until it has enough evidence [I5].
7. **Tags come from a curriculum, a teacher, or AI with teacher review** (3c). Capy
   has no curriculum except the bank, so it needs teacher tags, AI-suggested tags or
   topics derived from sources.
8. **Graded work has a release step:** Canvas posting [C6], Google return [G2],
   Moodle review windows [M3], Gradescope publish [GS1].
9. **Students see their own data; peers see aggregates at most.** Leaderboards live
   in game tools and opt-in social tools (Kahoot, Duolingo, Sparx XP). Khan limits
   them to district partners [K5].
10. **Insight cards are the newest layer:** a plain reason, an action and an AI draft
    (Google 2025 [G4] [G5], Khan 2026 [K8]; in Teams they sit behind an admin toggle
    [T2]).
11. **Follow-up means a new quiz built from what went wrong:** Kahoot [KH2], IXL
    Instant Review [I3], Seneca Knowledge Gaps [SE1], Canvas Mastery Paths [C12].
12. **Partial work needs a status, not a low score.**
    - Formative leaves out unanswered questions of unsubmitted work [F2].
    - Gimkit counts only first responses [GK2].
    - Sparx splits its completion bar into parts [SP1].

    Capy's never-closed practice attempts need the same treatment.
13. **Time means active time:** Sparx leaves out idle time [SP1]. Capy's
    start-to-last-check time is elapsed time, idle included.
14. **Small groups leak, and nobody serves them.** An average over 2–3 people reveals
    individuals. Friend tools offer leaderboards and quests, not gradebooks, and no app
    gives a group of friends mutual opt-in tracking. That gap is an opening for Capy.
15. **Capy already holds data others lack.**
    - Marking-scheme items with Jev awards can give rubric-item statistics like
      Gradescope's [GS1].
    - FSRS gives a memory signal that grade-based tools approximate with decay.
    - Source citations on AI-written questions can seed topics.

---

## 9. Options for Capy

Every default below is a proposal that needs Epo's sign-off: AGENTS.md says no
defaults or fallbacks without it.

### 9.1 First decide who may read a member's results

Today nobody but the member can.

| Option | What the owner sees | Analogue | Trade-off |
|---|---|---|---|
| **A. Assigned work only** | Results on tests and assignments, and on quizzes the owner marks as tracked. Self-study (own quizzes, flashcards, FSRS reviews) stays private. | Course gradebooks in Canvas, Google and Moodle | Clear and familiar, but the owner misses self-study effort |
| **B. Everything in the workspace** | Every attempt and review in the workspace | Khan's Activity overview includes unassigned work (snippet) [K7]; Quizlet Class Progress covers all study of class sets [Q1] | The most insight, but it feels like surveillance among friends, and raw FSRS ratings mean little to anyone else |
| **C. Member opt-in** | Whatever each member chooses to share | Duolingo following [D2]; Kahoot Study Groups, where joining means sharing [KH3] | Fits friend groups, but leaves gaps in a class grid |

**Proposal:**

- Use A for both study groups and classrooms.
- Ask for consent when a member joins a tracked workspace, and ask existing members
  once.
- Give members a "What the owner sees" preview, like Moodle's "View report as"
  [M5].
- Later, classrooms make consent part of school enrolment.
- Keep B off.

**Peers:**

- No peer's individual results by default.
- Show aggregates (average, completion) only when at least k members have results.
  In a group of two, the average reveals the other person's score.
- Leaderboards are opt-in, per workspace and per member.

### 9.2 Which views to build first

The order follows both value and what Capy's data already supports.

1. **Results grid (owner): members × tracked quizzes and tests.**
   - **Cell:** a status (not started; in progress, e.g. "4 of 10 checked"; submitted;
     late; missing), the score in marks and percent, and the attempt count.
   - **Column header:** completion such as "5 of 7", plus the mean once at least k
     members have results.
   - **Filters:** kind (practice or test), folder, date range.
   - **Navigation:** a row opens the member profile; a column opens the quiz report.
   - **Data:** `attempts` already holds correct, total, the graded questions, answers
     and times per user. What's missing is a cross-user read and a status for
     partial attempts.
   - **Precedent:** every LMS [G3] [M6], Formative [F2], Sparx [SP1], Blooket and
     Gimkit [B2] [GK3].
2. **Quiz or test report.**
   - **Facility** per question and per part: the share of marks earned. In small
     groups, show counts such as "3 of 5" alongside.
   - **Answer distribution:** options chosen for multiple choice, plus grouped short
     answers, orderings and matchings.
   - **Open parts:** how often each marking-scheme item was awarded, like Gradescope's
     rubric-item statistics [GS1]. Jev's stored awards already allow this.
   - **Time:** per attempt, labelled as elapsed time, because Sparx-style active time
     would need new capture [SP1].
   - **Hard questions:** flagged by a stated rule.
   - **Skip discrimination** until groups are large [M2].
3. **Member profile.**
   - Their results over time, attempts, last active date and practice volume.
   - The questions they still miss, meaning their latest answer was wrong.
   - An action that drafts a follow-up quiz.
4. **Insights (later).**
   - Cards with a plain reason, following Google's "3 or more consecutive" missing
     assignments [G4], Sparx-style "stuck after repeated misses" [SP1], and IXL's
     "3 of the last 5" [I2].
   - AI drafts a check-in or a quiz for the owner to send, as Google does with
     Gemini [G4].
5. **Members × topics grid** (once topics exist). Precedents: IXL Score Grid [I2],
   Canvas Learning Mastery Gradebook [C13], Google multi-goal view [G8], Formative
   standards [F2]. Cells read "not enough evidence" until the threshold is met.

### 9.3 Which aggregation to use

**Per assessment:** marks earned over marks possible, with the percent. Capy's parts
already carry whole marks and half-mark awards.

**Practice vs graded.**

- Quizzes stay practice: they show in the grid but never count towards a grade.
  Precedents: Canvas practice quizzes [C9], Schoology "count in grade" [S4], Google
  practice sets [G6].
- Tests and assignments are a new mode with these settings:
  - open and due dates;
  - a time limit enforced on the server, with one of Moodle's three expiry rules:
    auto-submit, grace period, or must submit [M3];
  - attempts allowed (proposed: 1);
  - the score to keep when more attempts are allowed: highest, latest, first or
    average, as in Moodle [M3] (Canvas defaults to highest [C9]);
  - a release rule: immediately, after the due date, or manually (Canvas posting
    [C6], Moodle review windows [M3], Google return [G2]).
- A test attempt closes on submit, unlike today's open practice attempts.

**Overall score.**

- The owner picks none, total points, or weighted categories, as in Google [G1].
- Excused work leaves the calculation [G1].
- Missing work counts as 0 only if the owner opts in (Canvas missing policy [C5],
  Moodle "Aggregate only non-empty grades" [M8]).
- Version 1 has no late penalties and no grading periods. A date-range filter covers
  periods, as in Google analytics [G3] and Formative [F2].

**Mastery, kept separate from grades.**

- Per member and per topic, a decaying average of question scores in answer order.
  65/35 is the commonest default (Canvas, Google, Pear) [C1] [G8] [P1]; Schoology
  uses 75% [S2].
- Not a plain average, because of Canvas's warning [C1]. Not highest, because it
  never falls.
- **Evidence before a label:** for example, at least 3 questions answered on at least
  2 days. Until then, show a range or "not enough evidence", like the IXL Diagnostic
  [I5].
- **Bands:** four named bands, each with words, e.g. Pear's 90/80/60 cutoffs [P1] or
  Khan-style levels [K1].
- **FSRS recall** stays a separate "memory" signal for practised items. It already
  resets when a prompt changes.

**Explanations:** every number gets a short note on how it was computed and from
which attempts.

### 9.4 Where topics come from

The options can be combined.

- **T1. Owner tags** each question from a workspace topic list, as in Formative [F1],
  Gradescope [GS1], Wayground [W1] and Google learning goals (up to 10) [G8].
  Accurate, but it costs effort.
- **T2. AI suggests, owner confirms.** This is Google's pattern, with its accuracy
  warning [G8]. The chat agent that writes a question knows its source passage.
- **T3. Derive topics from provenance:** a question generated from a file inherits
  that file, or its section heading, as its topic. No effort, but coarse. Folders
  only organise files, so a folder is not a topic.
- **T4. Bank topics:** bank questions keep the bank's topic when copied. Bank
  progress already stores `topic_id`.

Until topics exist, strengths and weaknesses stay per question and per quiz, as in
Kahoot [KH2], IXL item types [I2] and Moodle facility [M2].

### 9.5 What members and owners see

| Data | Owner | Other members | The member |
|---|---|---|---|
| Results on tracked items | Yes, after consent and subject to the release rule | No; aggregates only once k members have results | Yes, subject to the release rule |
| Answers and Jev feedback on tests | Yes | No | After release |
| Self-study (own quizzes, flashcards, FSRS) | No, under option A | No | Yes |
| Topic mastery | Yes, from tracked items | No | Yes, the same view as the owner |
| Leaderboard | If the owner turns it on | Only members who opted in | Opt-in |
| Chats, notes | No | No | Yes |

Still open:

- **Editors:** do editors (co-owners) see results? Moodle grants non-editing teachers
  by default [M6]; Teams shows Insights to class owners only [T2].
- **Members who leave:** does the owner keep read-only results for a while, as Teams
  keeps past data [T2], or lose them at once?
- **Hide study progress:** may it hide tracked results from the owner?

### 9.6 AI follow-up

- **From a quiz report:** "Make a follow-up quiz from the hardest questions", like
  Kahoot's "Create Kahoot from Difficult Questions" [KH2].
- **From a member profile:** a personalised quiz on that member's missed questions or
  weak topics, drafted for the owner to review and assign. Precedents:
  - Seneca, which turns Knowledge Gaps into targeted assignments [SE1];
  - IXL Instant Review, built from Trouble Spots [I3];
  - Canvas Mastery Paths, which route by score range [C12];
  - CENTURY focus nuggets [CE2].
- **Nudges:** reattempt messages (Wayground [W1]) and Gemini-drafted check-ins
  (Google [G4]).
- **What exists today:**
  - Members already get private suggestions: Tricky, Fading, Just learned.
  - The agent's `read_study_progress` reads only the caller's own progress. Reading
    members' results would need a new owner scope.

### 9.7 Decisions needed from Epo

1. The sharing model (A, B or C), and how consent is asked.
2. Whether practice quizzes show in the owner's grid by default.
3. Test settings: default attempts, which score to keep, the expiry rule, the release
   rule.
4. The default overall score: none, total points or weighted categories.
5. Missing work: counted as zero or left out; and whether late work only gets a label.
6. The mastery method, the evidence threshold, and the band names and cutoffs.
7. The topic source (T1–T4), and whether AI tags need confirmation.
8. The aggregate threshold k, and the leaderboard policy.
9. Whether co-owners see results, what retention applies after a member leaves, and
   how this works with Hide study progress.
10. An age policy before schools arrive (COPPA under 13, GDPR 13–16). Kahoot gates its
    groups at 13+ or 16+.

---

## References

Marks: no mark = read on the page or in source code; (snippet) = official page blocked,
search excerpt used; (secondary) = third-party or school; titles are given where useful.

**Canvas (Instructure)**

- [C1] Outcome calculation methods, UI text (source): https://github.com/instructure/canvas-lms/blob/master/ui/shared/grading/CalculationMethodContent.js
- [C2] Valid calculation ints, method comments (source): https://github.com/instructure/canvas-lms/blob/master/app/models/outcome_calculation_method.rb
- [C3] Default calculation method and ints (source): https://github.com/instructure/canvas-lms/blob/master/app/models/learning_outcome.rb
- [C4] Outcomes API, calculation_method values: https://canvas.instructure.com/doc/api/outcomes.html
- [C5] Late and missing policy (source): https://github.com/instructure/canvas-lms/blob/master/app/models/late_policy.rb
- [C6] Post policies, manual and scheduled posting (source): https://github.com/instructure/canvas-lms/blob/master/app/models/post_policy.rb
- [C7] Assignment group drop rules (source): https://github.com/instructure/canvas-lms/blob/master/app/models/assignment_group.rb
- [C8] Course settings: group weighting, hide final grades, hide distribution graphs, restrict quantitative data (source): https://github.com/instructure/canvas-lms/blob/master/app/models/course.rb and https://github.com/instructure/canvas-lms/blob/master/app/graphql/types/course_settings_type.rb
- [C9] Classic quiz types and score to keep (source): https://github.com/instructure/canvas-lms/blob/master/app/models/quizzes/quiz.rb and https://github.com/instructure/canvas-lms/blob/master/app/models/quizzes/quiz_submission.rb
- [C10] Grading periods with weight and close date (source): https://github.com/instructure/canvas-lms/blob/master/app/models/grading_period.rb
- [C11] omit_from_final_grade (source): https://github.com/instructure/canvas-lms/blob/master/app/models/abstract_assignment.rb
- [C12] Mastery Paths scoring ranges (source): https://github.com/instructure/canvas-lms/blob/master/app/models/conditional_release/scoring_range.rb
- [C13] Learning Mastery Gradebook v2 (source): https://github.com/instructure/canvas-lms/tree/master/ui/features/learning_mastery_v2
- [C14] New Quizzes Quiz and Item Analysis (snippet): https://community.canvaslms.com/t5/Canvas-Resource-Documents/New-Quizzes-Quiz-and-Item-Analysis/ta-p/580197
- [C15] Discrimination equals point-biserial; Classic item analysis is MC and true/false only (secondary): https://community.canvaslms.com/t5/Canvas-Question-Forum/Reproduce-discrimination-index-using-item-analysis/td-p/583963 and https://community.canvaslms.com/t5/New-Quizzes-Discussion/Item-Analysis/m-p/589305
- [C16] Legacy analytics removal, New Analytics mandatory (secondary): https://www.montclair.edu/canvas/?p=673 and https://teach.dce.harvard.edu/resource/canvas-new-analytics.md
- [C17] Enrollment types including ObserverEnrollment: https://canvas.instructure.com/doc/api/enrollments.html
- [C18] Decaying average uses the submission date (secondary): https://community.canvaslms.com/t5/Developers-Group/For-decaying-average-in-mastery-learning-are-dates-scores-are/td-p/165699

**Google Classroom**

- [G1] Set up grading: https://support.google.com/edu/classroom/answer/9184995
- [G2] Grade and return an assignment: https://support.google.com/edu/classroom/answer/6020294
- [G3] Classroom analytics: https://support.google.com/edu/classroom/answer/14221316
- [G4] Classroom insights and Gemini: https://support.google.com/edu/classroom/answer/18117192
- [G5] New class analytics and insights, 9 Jun 2025: https://workspaceupdates.googleblog.com/2025/06/new-class-analytics-and-insights-in-google-classroom.html
- [G6] Grade and track practice sets: https://support.google.com/edu/classroom/answer/13457851
- [G7] Practice sets generally available, April 2023 (snippet): https://workspaceupdates.googleblog.com/2023/04/practice-sets-for-google-classroom.html
- [G8] Learning goals: https://support.google.com/edu/classroom/answer/17074065
- [G9] Local learning standards: https://support.google.com/edu/classroom/answer/17073569
- [G10] Guardian email summaries: https://support.google.com/edu/classroom/answer/6388136

**Moodle (5.3 docs)**

- [M1] Grade aggregation: https://docs.moodle.org/en/Grade_aggregation
- [M2] Quiz statistics report: https://docs.moodle.org/en/Quiz_statistics_report
- [M3] Quiz settings: https://docs.moodle.org/en/Quiz_settings
- [M4] Competencies: https://docs.moodle.org/en/Competencies
- [M5] User report: https://docs.moodle.org/en/User_report
- [M6] Grader report: https://docs.moodle.org/en/Grader_report
- [M7] Grade items: https://docs.moodle.org/en/Grade_items
- [M8] Grade categories: https://docs.moodle.org/en/Grade_categories

**Schoology (PowerSchool)**

- [S1] Grade calculations: https://uc.powerschool-docs.com/en/schoology/latest/grade-calculations
- [S2] Decaying average mastery calculation: https://uc.powerschool-docs.com/en/schoology/latest/decaying-average-mastery-calculation
- [S3] District mastery settings (snippet): https://support.schoology.com/hc/en-us/articles/360022855734-District-Mastery-Settings-System-Admins-
- [S4] Grade setup and grading structures (snippet): https://uc.powerschool-docs.com/en/schoology/latest/courses-grade-setup and https://uc.powerschool-docs.com/en/schoology/latest/create-grading-structures

**Microsoft Teams for Education**

- [T1] Weighted grading categories (snippet): https://support.microsoft.com/en-us/education/assignments/set-up-weighted-grading-categories-in-teams-assignments
- [T2] IT admin guide to Education Insights (updated 2025-08-21): https://learn.microsoft.com/en-us/microsoftteams/class-insights
- [T3] Insights overview: https://support.microsoft.com/office/27b56255-90c0-47aa-bac3-1c9f50157181
- [T4] Parent Connection retirement: https://support.microsoft.com/en-us/teams/education/connect-with-educators-in-teams

**Khan Academy** (help centre blocked fetching; all (snippet) except K8)

- [K1] Mastery levels: https://support.khanacademy.org/hc/en-us/articles/5548760867853--How-do-Khan-Academy-s-Mastery-levels-work
- [K2] Course and unit mastery: https://support.khanacademy.org/hc/en-us/articles/115002552631-What-are-Course-and-Unit-Mastery
- [K3] Teacher reports in Reimagined: https://support.khanacademy.org/hc/en-us/articles/38554738905997-What-teacher-reports-are-available-on-Khan-Academy-Reimagined
- [K4] What's changing for teachers: https://support.khanacademy.org/hc/en-us/articles/46056253778061-What-s-changing-for-teachers-in-the-reimagined-Khan-Academy-experience
- [K5] What administrators need to know: https://support.khanacademy.org/hc/en-us/articles/46056304557837-What-do-administrators-need-to-know-about-the-Khan-Academy-reimagined-experience
- [K6] Why no Course Mastery: https://support.khanacademy.org/hc/en-us/articles/47216131257997-Why-don-t-I-see-Course-Mastery-in-the-reimagined-Khan-Academy-experience
- [K7] Activity overview tabs: https://support.khanacademy.org/hc/en-us/articles/360031052391-How-do-I-use-the-Activity-Skills-and-Mastery-tabs-on-the-Activity-overview-report
- [K8] Reimagined for districts (fetched): https://blog.khanacademy.org/khan-academy-reimagined-for-districts-2026/
- [K10] Skill progress in Reimagined: https://support.khanacademy.org/hc/en-us/articles/47078681852045-Where-can-I-view-my-skill-progress-in-Khan-Academy-Reimagined
- [K11] Mastery mechanics changes, September 2018: https://support.khanacademy.org/hc/en-us/community/posts/360023249611-Update-Mastery-Mechanics-Changes-September-2018
- [K12] Parents quick start (title only): https://support.khanacademy.org/hc/en-us/articles/360040168512-Khan-Academy-for-Parents-Quick-Start-Guide

**IXL**

- [I1] SmartScore (snippet): https://blog.ixl.com/2020/11/11/ixl-smartscore-the-key-to-mastery-based-learning/
- [I2] Three popular teacher reports: https://blog.ixl.com/2020/11/04/3-popular-teacher-reports-on-ixl/
- [I3] Instant Review, 11 Sep 2025: https://blog.ixl.com/2025/09/11/make-every-review-count-with-instant-review/
- [I4] IXL Analytics: https://www.ixl.com/analytics
- [I5] Real-Time Diagnostic questions (snippet): https://blog.ixl.com/2021/01/28/common-questions-about-the-ixl-real-time-diagnostic/
- [I7] SmartScore family guide (snippet): https://www.ixl.com/inspiration/us/IXL-SmartScore-Guide.pdf

**Quizlet** (help centre blocked fetching)

- [Q1] Using Class Progress (snippet): https://help.quizlet.com/hc/en-us/articles/360030512432-Using-Class-Progress
- [Q2] Student activity data (snippet): https://help.quizlet.com/hc/en-us/articles/360030640912-Student-activity-data

**Wayground (ex-Quizizz)**

- [W1] Reports: https://wayground.com/home/solutions/reports
- [W2] Rebrand, 24 Jun 2025 (secondary): https://thejournal.com/articles/2025/06/24/quizizz-rebrands-as-wayground-announces-new-ai-features.aspx
- [W3] Older Quizizz settings guide (secondary): https://www.tsc.edu/assets/documents/academics/educational_technology/canvas/softwareandtechnologyresources/quizizz_free_quizzes_for_every_student.pdf

**Kahoot**

- [KH1] Quiz reports (snippet): https://support.kahoot.com/hc/en-us/articles/360035063054
- [KH2] Reports explained, 18 Jul 2025: https://kahoot.com/blog/2025/07/18/teacher-takeover-sabina-reports/
- [KH3] Intro to Study Groups (snippet): https://support.kahoot.com/hc/en-us/articles/360053615654-Intro-to-Study-Groups
- [KH4] Groups, assigning content (snippet): https://support.kahoot.com/hc/en-us/articles/360055143294-Groups-How-to-add-remove-and-assign-kahoots

**Gradescope** (help centre blocked fetching)

- [GS1] Assignment statistics (snippet): https://guides.gradescope.com/hc/en-us/articles/22059823947917-Assignment-Statistics
- [GS2] Bubble sheet grading and item analysis (snippet): https://guides.gradescope.com/hc/en-us/articles/22065675043341-Grading-a-Bubble-Sheet-Assignment

**Formative**

- [F1] Tag questions with standards: https://help.formative.com/en/articles/188657-tag-questions-with-standards
- [F2] Navigating the Tracker: https://help.formative.com/en/articles/6267112-navigating-the-tracker

**Pear Assessment (ex-Edulastic)**

- [P1] Standards-based grading: https://docs.goguardian.com/products/pear-assessment/learn-how-supports-standards-based-grading

**D2L Brightspace** (extra, not in the brief)

- [D2L] Mastery view calculation (snippet, university help page): https://help.d2l.msu.edu/msu-docs/standards-lessons-tool/mastery-view

**Sparx Maths**

- [SP1] Monitoring homework completion: https://support.sparxmaths.com/en/articles/342343-monitoring-homework-completion
- [SP2] Accessing and interpreting reports: https://support.sparxmaths.com/en/articles/342339-accessing-and-interpreting-reports
- [SP3] Helping your team, XP leaderboard (snippet): https://support.sparxmaths.com/en/articles/342330-helping-your-team-to-make-the-most-of-sparx-maths
- [SP4] School parent guide (secondary): https://www.thegrangeacademy.co.uk/downloads/top_tips_for_parents__sparx_maths_homework_.pdf

**CENTURY Tech**

- [CE1] Teacher Dashboard, Overview tab (modified 3 Apr 2025): https://support.century.tech/support/solutions/articles/44002252928-teacher-dashboard-overview-tab
- [CE2] Focus and stretch nuggets (modified 22 Aug 2024): https://support.century.tech/support/solutions/articles/44002435262-what-are-focus-and-stretch-nuggets-
- [CE3] Teacher knowledge base, insight emails folder: https://support.century.tech/support/solutions/44000805036
- [CE4] School guides (secondary): https://aldergrange.com/wp-content/uploads/2021/11/Century-Tech-user-guide.pdf and https://appletonacademy.co.uk/wp-content/uploads/2023/02/Guardian-Portal-Guide.pdf

**Seneca**

- [SE1] Seeing students' progress (dated 21 Aug 2026): https://help.senecalearning.com/en/articles/2482911-how-do-i-see-my-students-progress-on-seneca

**Carousel Learning**

- [CA1] Home page (snippet): https://carousel-learning.com/
- [CA2] Product page: https://www.carousel-learning.com/product

**Duolingo**

- [D1] Duolingo for Schools (snippet): https://blog.duolingo.com/duolingo-schools-equitable-learning/
- [D2] Friends Quests, 9 Sep 2022: https://blog.duolingo.com/friends-quests/
- [D3] Privacy policy summary (secondary): https://conductatlas.com/platform/duolingo/duolingo-privacy-policy/teachers-can-view-student-learning-progress-data/

**Blooket and Gimkit**

- [B1] How to read Blooket reports (snippet): https://help.blooket.com/hc/en-us/articles/16180020488727
- [B2] Blooket homework results (snippet): https://help.blooket.com/hc/en-us/articles/16179265863959
- [GK1] Gimkit assignments explained: https://help.gimkit.com/en/article/assignments-explained-1dgudm/
- [GK2] Gimkit assignment reports: https://help.gimkit.com/en/article/assignment-reports-180nh4c/
- [GK3] Gimkit assignment results: https://help.gimkit.com/en/article/assignment-results-iqnbei/

**Brainscape**

- [BR1] For teachers: https://www.brainscape.com/teachers

**Law**

- [L1] FERPA FAQ: https://studentprivacy.ed.gov/faq/what-ferpa
- [L2] Owasso v. Falvo (2002): https://www.law.cornell.edu/supct/html/00-1073.ZS.html
- [L3] FTC COPPA amendments, 16 Jan 2025: https://www.ftc.gov/news-events/news/press-releases/2025/01/ftc-finalizes-changes-childrens-privacy-rule-limiting-companies-ability-monetize-kids-data
- [L4] GDPR Article 8: https://gdpr-info.eu/art-8-gdpr/
- [L5] UK Children's code, not fetched (unverified): https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/childrens-information/childrens-code-guidance-and-resources/

**Capy (internal)**

- `openwiki/study-progress.md` (Data model, Authorization, Lifecycle) and
  `openwiki/question-bank.md` (Shared question format, Learner progress), in the
  `blocksuite-notes` worktree.
