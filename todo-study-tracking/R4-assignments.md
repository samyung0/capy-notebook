# R4: Practice vs graded work in education apps, and a minimal assignment model for Capy

2026-11-02. This is research for the study rework (Epo's direction of 2026-11-02; canvas mode is on hold, `todo-canvas-workspace.md:5`). It is read-only: nothing in the repo was changed. Earlier research on task completion, due lists and "who finished" grids is in `todo-canvas-workspace/E-study.md`. This report does not repeat it.

Source keys such as [C5] resolve to URLs in §8. Repo paths are relative to the `blocksuite-notes` worktree. "Unverified" means the claim rests on memory, a community post, a search snippet or one weak source.

---

## 0. In short

- **Two ways to separate practice from graded work.**
  - **A different mode or type:**
    - Canvas Classic's *practice quiz* type [C12];
    - Wayground's Practice, Accuracy and Testing homework modes [W1];
    - Microsoft Forms' practice mode [F2];
    - Classroom's practice sets, a separate product [G5].
  - **Settings on the same quiz:**
    - Moodle: question behaviour, attempts, the review matrix [M1];
    - Canvas New Quizzes and Gradescope: time limit, attempts, result view [C5][GS1].
  - **Either way, practice means:** immediate feedback, retries, nothing in the gradebook.
  - **And graded work means:** deferred feedback, limited attempts, dates, controlled release, then a gradebook.
- **Practice never counts by itself in any app I checked.**
  - Canvas practice quizzes give no grade [C12].
  - Classroom practice-set scores must be typed into the gradebook by hand [G5].
  - Khan, Seneca and Sparx keep mastery, memory strength or completion apart from scores [KA1][SE1][SP1].
- **The timer works the same way almost everywhere.**
  - Each student's clock starts when they press Start. It never pauses, and keeps running if they leave.
  - At time-out, whatever is saved is submitted: Canvas, Moodle's default, Gradescope and Forms [C18][M1][GS1][F1].
  - A close or due date cuts the clock short [C5][GS3].
  - Canvas fixed a bug on 2026-04-28 (community post, unverified): attempts with no open session did not auto-submit at the close date. So the server must close attempts itself.
- **Roll-up.**
  - Total points is the default: Classroom, Teams, Moodle "Natural", Canvas unweighted [G3][T2][M2][C1]. Weighted categories are opt-in.
  - Excused work leaves the calculation [C11][G3].
  - Missing work gets a 0 by policy: Classroom gives a draft 0 by default; Canvas can award a set percentage [G4][C10].
  - Drop lowest applies per group [C2][M3]. Grading periods exist in Canvas and Classroom [C1][G4].
- **Results pass two gates.**
  - What the attempt review shows: Moodle's matrix, Canvas's result view, Forms' respondent settings, Wayground's answer display [M1][C6][G2][W2].
  - When the grade reaches the student: Canvas posting policy, Classroom and Teams Return, Gradescope Publish Grades [C14][G4][T3][GS1].
- **Anti-cheating on the web is signals, not prevention.**
  - Examples: full-screen and tab exits reported to the teacher (Exam.net Medium, Wayground's monitor), multiple-session detection (Canvas), shuffles and question pools [EX1][W2][C5][C20].
  - Real lockdown needs Safe Exam Browser, a vendor app or managed Chromebooks [EX1][SEB1][G1].
  - Canvas says its quiz logs are not meant to prove cheating [C19]. Moodle calls its browser security not fool-proof [M1].
- **For Capy:**
  - Add an `assignments` table that holds a **frozen copy** of a quiz plus its settings.
  - Extend `attempts` with the assignment, a server start time, a deadline, a submit time and a status.
  - The grading queue is the attempts waiting in status `grading`. The API's existing minute sweep drains it, with retries.
  - A small overrides table holds extra time, moved dates and excused.
  - The gradebook is computed when read.
  - **Biggest gap:** today any member can reach a workspace quiz's answer keys:
    - Check returns them;
    - viewers may clone, and clones keep keys;
    - editors open the editor.

    So a test must be served only from the frozen copy (§6, §7.6).

---

## 1. Method

- **Searches and fetches.** I made 20 web searches out of a budget of 35. Everything else came from fetching official help pages directly.
- **Browser reads.**
  - Some pages render in JavaScript or refuse plain fetches: Canvas Community, Kahoot, Khan, Gradescope, Exam.net and Carousel's help centre.
  - I read those as page text in the desktop app's browser pane.
  - On Instructure's own search page I stopped at a Cloudflare check and did not try to get past it.
- **Page dates.** Each page's date is noted where it shows one. Canvas guide pages show "Last Updated" dates from July to October 2026. The Moodle pages are the 5.3 docs.
- **Capy facts.** These come from `openwiki/study-progress.md`, `openwiki/question-bank.md`, `openwiki/authorization-permissions-lifecycles.md`, `openwiki/observability-metering.md`, the migrations, and `server/internal/store/queries.go`.

---

## 2. Practice vs assessment, app by app

| App | How practice and graded work are told apart | Worth copying |
| --- | --- | --- |
| **Google Classroom + Forms** | An assignment with points is graded; one without points is "ungraded" [G1]. A quiz assignment is a Forms quiz. Importing grades needs: the form is the only attachment, emails are collected, one response per student [G1]. Practice sets (Education Plus or Teaching and Learning Upgrade) grade themselves, but their scores do not reach the gradebook: the teacher enters them [G5][G6]. Search snippets say practice sets give unlimited tries with a Try again message (unverified: the page text I read was cut short). | Grades stay drafts until Return [G4]. Forms releases grades either immediately or after manual review, and lets the teacher choose whether students see missed questions, correct answers and point values [G2]. Locked mode works only on school-managed Chromebooks; the teacher gets an email when a student leaves and reopens the quiz [G1]. |
| **Canvas LMS** | Classic Quizzes has four quiz types: graded quiz, practice quiz (no grade, kept off the Grades page), graded survey and ungraded survey. Practice quizzes exist only in Classic [C12]. In New Quizzes every quiz is an assignment in an assignment group. "Do not count this assignment toward the final grade" works for assignments only, not quizzes [C3]; a group weighted at 0% does not count [C1]. | The richest settings: time limit, attempts with a score to keep, waiting period, one question at a time, result view, accommodations [C5][C6][C7]. Weighted groups and drop rules [C1][C2]. Late and missing policies [C9][C10]. Posting policy [C14]. A separate Learning Mastery Gradebook [C15]. |
| **Moodle quiz** | The same activity serves practice or exam through settings. Question behaviours: "Deferred feedback" is the exam style; "Interactive with multiple tries" and "Immediate feedback" are practice styles [M1]. Plus attempts, grading method and the review-options matrix [M1]. | The review matrix (what × when). Three "When time expires" policies. User and group overrides. An offline app that refuses timed quizzes [M1]. |
| **Microsoft Teams Assignments + Forms** | An assignment has points, a grading category, a due date and an optional close date [T1]. Forms quizzes have a practice mode: learners work at their own pace and see each correct answer before submitting [F2]. | Late turn-ins are allowed by default because no close date is set [T1]. Grades reach students on Return or Return for revision [T3][T4]. The Forms timer cannot be paused and submits automatically [F1]. Shuffle can lock chosen questions in place [F2]. Forms can require the "Take a Test" app [F2]. |
| **Wayground (Quizizz until 2025-06-24 [W3])** | Homework comes in three modes: **Practice** (own pace, instant feedback, retries, redemption questions), **Accuracy** (reattempts per question until a mastery goal of 80, 90 or 100%) and **Testing**, which the help page says is for formal assessments [W1]. | Session attempts can be 1, 2, 3 or unlimited; limits require sign-in. Rotating question sets give each attempt a different subset. Late submissions with a final close date. Accommodations and differentiated versions. Anti-Cheating Monitor (School or District plan) [W2]. |
| **Kahoot** | An assigned kahoot is learner-paced, with a deadline up to 28 days ahead (hour-level; some plans allow no deadline) [K1]. Reports only, no gradebook. Participants need no account [K1]. | Editing a kahoot does not change an existing assignment: you create a new one [K1]. Answer order can be randomised. The report shows who didn't start, with an emailed reminder [K1]. |
| **Khan Academy** | Assignments have a start date and a due date; the report shows each student's best score [KA2][KA3]. Mastery is separate: skill levels from Not started to Mastered, and course mastery = the share of skills at Proficient or Mastered (a new calculation, updated about two months ago) [KA1]. | Teachers choose the same question set for everyone or a different one per student. Start Over is unavailable with the same set [KA3]. "All students" includes students who join before the due date [KA3]. |
| **Gradescope** | Online assignments (Institutional licence; described as beta) have a release date, a due date and an optional late due date, plus Enforce Time Limit [GS1]. Grades and manual feedback stay hidden until Publish Grades [GS1][GS4]. | The clock runs from Start, never pauses and keeps running if the student leaves [GS2]. The latest saved answer per question is graded [GS1]. Questions and responses can be hidden until grades are published [GS1]. Shuffle questions and choices [GS1]. Per-student extensions [GS3]. Regrade requests per question [GS4]. |
| **Sparx Maths** | Each weekly homework has **Compulsory** (complete only when every question is right; about 60 minutes by default; late allowed up to 48 days, marked late), **XP Boost** (optional, about 30 minutes) and **Target** (optional, up to six harder questions) [SP1]. It measures completion, not grades [SP1]. | Bookwork checks ask for the answer to a recently answered question by its code, without showing the question. They come less often to students who pass them [SP2]. Up to three question swaps after watching a support video [SP1]. |
| **Seneca** | Each section gets a score; separately, memory strength builds over spaced repeats [SE1]. Teachers sort results by first, best, worst, average or most recent attempt, by number of attempts and by study time [SE1]. | AI-marked exam questions that teachers can re-mark (page dated 2026-08-26) [SE2]. |
| **Carousel Learning** | Retrieval-practice quizzes. Carousel marks exact matches and blanks itself; students self-mark the rest. Then comes a teacher moderation stage [CA2][CA1]. | Moderation locks the quiz and auto-submits unfinished responses. Marking can be anonymised and shuffled. A teacher can flip a self-mark. Chosen answers go anonymously into Whole Class Feedback [CA2]. |
| **Exam.net + Safe Exam Browser** | An exam platform with three security levels: **High** (SEB or the Exam.net app), **Medium** (browser full screen) and **Disabled** [EX1]. | In Medium, leaving full screen notifies the teacher. The teacher can require a written explanation and a 30, 60 or 90 s lockout, and sees who left, for how long and why [EX1]. SEB is a kiosk browser; the exam system can check that an unaltered SEB with the right settings is in use [SEB1]. |

**Retired or changing features:**
- Quizizz became Wayground on 2025-06-24 [W3].
- Canvas Classic Quizzes has no removal date that I found; practice quizzes still exist only there [C12]. New Quizzes' native integration became the default on 2026-07-01 and was enforced from 2026-08-15 [C23]. Instructure plans to drop the New Quizzes toggles in early 2027 without taking Classic away [C24]. Both points come from search summaries (unverified).
- Moodle calls "Mean of grades (with extra credits)" old and unsupported [M2]. The quiz due date is new in Moodle 5.3 [M1].
- Microsoft Forms still says "Windows 10 Take a Test app" [F2].
- Khan's assignment article describes the platform before "Khan Academy Reimagined" [KA3].
- Capy removed its own unenforced timer earlier (`openwiki/question-bank.md:150-151`).

---

## 3. Settings that matter

### 3.1 Timer and time-out

| App | Clock | At time-out | Close date vs timer |
| --- | --- | --- | --- |
| Canvas New Quizzes | Time limit in hours and minutes [C5]. Leaving the quiz does not stop the timer [C18]. | Auto-submits [C18]. | An attempt in progress auto-submits at the Until date even with time left [C5][C7]. A changed due date still ends a started attempt at the original time [C18]. |
| Moodle | Optional limit; the countdown can be hidden [M1]. | Three policies: auto-submit what's open (default); a grace period in which students can submit but not answer; or must submit before time-out, else the attempt doesn't count. Server-side allowance defaults to 60 s [M1]. | The close date blocks new attempts; answers sent after it are saved but not marked [M1]. |
| Gradescope | Runs from Start Assignment, never pauses, keeps running in another tab [GS2]. | The latest saved answer per question counts [GS1]. | Students cannot continue past the due or late due date whatever the timer shows. Starting at 9:59 for a 10:00 late due date leaves one minute [GS3]. |
| Microsoft Forms | Set in minutes; cannot be paused; a warning in the last minute [F1]. | Answers are submitted automatically [F1][F2]. | Start and end dates limit when responses are collected [F2]. A Q&A says the timer needs organisation-only responses (unverified) [F3]. |
| Wayground | Per-question timer; options allow late answers or lock answers when time ends [W2]. | Not a whole-test timer. | Homework start and end up to 30 days ahead [W2]. |
| Kahoot assignments | Deadline-based. 2020 guides suggest turning the question timer off (unverified) [K2]. | Participants must finish before the deadline [K1]. | — |
| Google Forms | No timer on the Forms quiz page (absence, unverified) [G2]. | — | — |

**For Capy:**
- The server is the only clock. `deadline_at = least(start + limit + extra, close)`, set when the student starts.
- Saves after the deadline plus a small grace are refused.
- Time-out submits what is saved (the common default).
- A sweep finalises late attempts, because a browser-only auto-submit fails when the tab is gone (the Canvas bug [C21], unverified; another Canvas post says Classic submits from the browser [C22], unverified).
- Timed tests need a connection: Moodle's offline app refuses timed quizzes [M1].

### 3.2 Attempts and which counts

| App | Attempts | Which counts |
| --- | --- | --- |
| Canvas New Quizzes | Unlimited or a set number, an optional wait between attempts, "Build on last attempt" [C5]. | Highest, average, latest or first. The late policy is not supported with multiple attempts [C5]. Extra attempts per student follow the same rule [C8]. |
| Moodle | Number allowed, enforced delays, "each attempt builds on the last", redo within an attempt [M1]. | Highest, average, first or last [M1]. |
| Wayground | Session attempts 1, 2, 3 or unlimited (limits need sign-in); reattempts per question in Accuracy mode [W2]. | Not stated. |
| Khan | Start Over (not with the same question set) [KA3]. | Best score in the report [KA2]. |
| Seneca | Multiple attempts [SE1]. | Teachers can view first, best, worst, average or latest [SE1]. |
| Classroom + Forms | One response per student is required for grade import [G1]. | — |

**For Capy:** one attempt in the MVP. Several attempts with a score to keep come later.

### 3.3 Dates, late, missing

- **Canvas.**
  - Submissions after the due date are marked late. Availability dates ("Available from" and "Until") decide when students can view and submit [C4].
  - The late policy takes a percentage per day or hour late (days round up), with a lowest-grade floor. It affects only submissions with the Late status [C9].
  - The missing policy awards a set percentage of points to missing work, including New Quizzes. It applies only after it is set up, not to work already graded [C10].
  - Statuses are Late, Missing, Excused, None and custom ones. Excused work is not counted, and students cannot submit it [C11].
- **Moodle 5.3.** The due date marks attempts overdue but does not block them; the close date blocks. Overrides can change dates [M1].
- **Classroom.** Missing or past-due work gets a draft 0 by default, which can be turned off. Teachers mark work missing or complete, and excuse it [G4].
- **Teams.** No close date by default, so late turn-ins are allowed. Posting can be scheduled, and there is a default due time [T1][T2].
- **Wayground.** Allow late submissions, with a final close date that blocks everything after it [W2].
- **Kahoot.** The deadline can be extended or removed from the report. An expired assignment cannot restart [K1].
- **Sparx.** Late work is allowed up to 48 days and marked late [SP1].
- **Gradescope.** Release, due and late due dates [GS1].
- **Carousel.** Teacher marking auto-submits unfinished work once the deadline has passed [CA2].

**For Capy:**
- Opens, due and close dates.
- Late is a flag only in the MVP.
- Missing counts as 0 once the due date passes. Classroom does this by default; it needs Epo's sign-off.
- The teacher can excuse.
- Late penalties come later.

### 3.4 Order, pools, one at a time, no going back

- **Canvas.**
  - Shuffle questions, and shuffle answers for multiple choice, multiple answer and matching. Shuffling does not guarantee a different order for every student [C5].
  - "One question at a time", with "Allow Backtracking" on by default [C5].
  - A random set from an item bank means different students see different questions [C20].
- **Moodle.**
  - Questions per page.
  - Navigation is "Free" or "Sequential"; sequential allows no going back or skipping [M1].
- **Gradescope.**
  - Shuffle top-level questions and choices.
  - Graders see the original order, and can view each student's shuffle [GS1].
- **Wayground.**
  - Shuffle questions and answers.
  - Rotating question sets, for example 8 of 30.
  - A toggle to skip and come back.
  - Differentiated versions [W2].
- **Khan.** The same or a different question set per student [KA3].
- **Kahoot.** Randomised answer order [K1].
- **Forms.** Shuffle, not with sections [F2].

**For Capy:**
- Shuffle question order per student in the MVP, seeded by the attempt.
- Shuffling multiple-choice options needs an index mapping, because answers are option indices in stored order (`openwiki/question-bank.md:557-566`). That comes later, with pools, versions and sequential navigation.

### 3.5 When results and answers are released

| App | What the student sees | When |
| --- | --- | --- |
| Moodle | Rows: the attempt, whether correct, maximum marks, marks, specific and general feedback, right answer, overall feedback [M1]. | Columns: during (only for immediate or interactive behaviours), immediately after (within 2 minutes), later while open, after close [M1]. |
| Canvas New Quizzes | "Hide results from students". If shown: questions, responses, correct or incorrect, the correct answer, points possible and awarded [C6]. | Responses for all attempts, once after each, after the last, or once after the last, each from a chosen date. Correct answers after each or after the last attempt [C6]. Separately, Gradebook posting is automatic or manual [C14][C6]. |
| Classroom + Forms | Missed questions, correct answers, point values [G2]. | Forms: immediately or after manual review [G2]. Classroom: drafts until Return [G4]. |
| Teams | Feedback and score [T4]. | After Return or Return for revision [T3]. |
| Gradescope | Questions and responses hidden after the time limit or due date [GS1]. | When grades are published [GS1][GS4]. |
| Wayground | During: off, "Validate only" (right or wrong) or on. After: on (with answers), questions only, or off [W2]. | Per session [W2]. |

**For Capy:**
- No feedback during an assessment: Moodle's deferred style.
- One release setting: on submit, after close, or manual.
- Plus a switch for showing correct answers and worked solutions.
- Per-item matrices come later.
- If students have per-student close dates, "after close" must mean after the latest close among them. Otherwise one student sees the key while another is still working. Moodle ties the "after close" column to the quiz close date [M1].

### 3.6 Extra time per student

- **Canvas.**
  - Course accommodations give additional time, remove the limit, or apply a time multiplier. There is one per student, for every quiz.
  - Reduced answer choices removes one wrong option from multiple-choice questions with four or more options [C7].
  - Quiz-level moderation adds attempts and time, or reopens the latest attempt with its answers and remaining time.
  - Course settings apply first, and the quiz setting cannot be reduced by them.
  - Availability dates still apply [C8].
- **Moodle.**
  - User or group overrides change dates, time limit, attempts and password.
  - A user override beats a group one; with several groups, the most generous wins [M1].
- **Gradescope.**
  - Per-student extensions of dates and time.
  - A time-only extension pushes the due dates out by the same amount [GS3].
- **Wayground.** Accommodations give scaffolded versions [W2].

**For Capy:**
- Per-student extra time and moved due or close dates in the MVP.
- Course-wide accommodations and a multiplier come later.

### 3.7 Re-grading, overrides, AI marks

- **Canvas regrade** (in SpeedGrader).
  - The teacher changes the correct answer or points.
  - Then picks one of: award correct answers only; current and previous correct answers; any submitted answer; or full credit for everyone.
  - Not for essays or file uploads [C13].
- **Canvas grade tools.** Fudge points for a whole quiz [C13]. The guide also has pages for overriding a final grade and for a grading-change history (titles in the guide navigation, `660860`, `660864`).
- **Canvas IgniteAI grading assistance** (Canvas Plus or Next).
  - Suggests rubric ratings and comments for written work.
  - The teacher must review and approve them, and students see the mark is AI-assisted.
  - Not meant for single-answer questions [C16].
- **Moodle.** A manual grading report for essays, where auto-graded marks can also be edited; regrade or delete chosen attempts [M4].
- **Seneca.** The teacher can re-mark an AI-marked exam question [SE2].
- **Carousel.** The teacher flips self-marks during moderation [CA2].
- **Classroom practice sets.** The teacher sets Correct or Incorrect per question [G5].
- **Gradescope.**
  - Regrade requests per question, on by default once published.
  - An optional request window; graders accept or reject [GS4].

**For Capy:**
- Jev grades the open parts in a queue.
- The teacher can override any part: marks in halves, plus a comment. The override survives regrades.
- After a key fix, the teacher can regrade one question for every submission.
- Student regrade requests come later.

### 3.8 Partial credit

- Forms takes partial points in manual grading [G2]. Canvas questions can vary points by answer [C13].
- Capy already gives half marks per marking item, and splits marks item by item for matching and gaps; other closed parts are all or nothing (`openwiki/question-bank.md:414-420, 469-472`).
- Overrides should keep the half-mark step.

---

## 4. Roll-up: how scores make a member's overall result

### 4.1 Points or weighted categories

- **Total points is the common default.**
  - Classroom: none, total points, or weighted by category; weights must total 100% to save [G3].
  - Teams: points by default, weighted grading categories as an option [T2][T1].
  - Moodle: "Natural" (the sum of points) is the default. It also offers mean, weighted mean, simple weighted mean, median, lowest, highest and mode [M2].
- **Canvas.**
  - Weights apply to groups. Within a group, the percentage is points earned over points possible [C1].
  - A group with nothing graded drops out, and the rest are divided by their combined weight [C1].
  - Weights may total more or less than 100% [C1].
  - A 0% group never counts [C1].

### 4.2 Drop lowest, excused, missing, ungraded

- **Drop rules.**
  - Canvas: drop the lowest or highest x per group, or never drop an item. It drops whichever score helps (or hurts) the total most by points, not by percentage [C2].
  - Moodle: "Drop the lowest" and "Keep the highest" per category [M3].
  - Classroom has no drop rule [G3].
- **Excused** work is removed from the calculation in Canvas and Classroom [C11][G3].
- **Missing** work:
  - Classroom: a draft 0 by default [G4].
  - Canvas: an optional percentage policy [C10].
- **Ungraded work in Canvas.** The "Current" score ignores unsubmitted work, and the "Final" score counts it as 0. The Gradebook can display "View ungraded as 0" without changing grades [C17].
- **Moodle.** "Aggregate only non-empty grades" decides whether empty grades count as minimum or are left out [M3].

### 4.3 Grading periods

- Canvas weights grading periods, and assignment-group weights apply inside each period. Weights and drop rules freeze once a period closes [C1][C2].
- Classroom filters grades by grading period [G4] and starts a new class for a new term [G3].

**For Capy:** a workspace is one class. Skip grading periods: Classroom's model, where each term gets its own class, is enough.

### 4.4 Who sees the overall

- Classroom: students see their overall grade unless it is set to "No overall grade"; an option puts it on their profile [G3].
- Teams: a switch controls whether students see their average [T2].
- Canvas: hidden (manually posted) grades change the total only in the teacher's view until they are posted [C14]. There is also a setting to hide totals (guide title `661136`).

### 4.5 Does practice count? Grade vs mastery

- **No app counts practice automatically.**
  - Canvas practice quizzes [C12].
  - Classroom practice sets, entered by hand [G5].
  - Forms practice mode [F2].
  - Wayground Practice and Accuracy modes, separate from Testing [W1].
- **Mastery runs on its own track.**
  - Canvas: the Learning Mastery Gradebook (outcomes, opt-in) [C15]; Moodle can optionally put outcomes into the grade, and warns this may skew it [M3].
  - Khan: skill levels and mastery percentage, separate from the best assignment score [KA1][KA2].
  - Seneca: memory strength, separate from section score [SE1].
  - Sparx: completion plus XP; no grades [SP1].
- **Direction of flow.** Graded work may feed mastery: Khan's quizzes, unit tests and course challenges move skill levels [KA1]. Practice never feeds the grade.

### 4.6 Recommendation for Capy

1. **MVP overall per member per workspace.** Awarded marks over possible marks across released, non-excused assessments (Classroom "Total points", Moodle "Natural").
   - Missing work counts as 0 once its due date passes, if Epo signs off.
   - Work still being graded or not yet released is left out, like Canvas's "Current" score.
   - Show Test and Homework subtotals beside the overall.
2. **Next: weight by kind.** Two numbers, Tests x% and Homework y%. Renormalise over kinds that have graded work, as Canvas does [C1]. This is small if Epo wants tests to count more from day one.
3. **Later.** Custom categories, drop lowest [C2], late penalties [C9], CSV export (Khan offers a scores CSV [KA2]).
4. **Practice never counts.** FSRS, review sessions and practice attempts appear beside the grade as practice signals, never in it. Whether teachers see those signals is a separate privacy decision (§7.7).

---

## 5. Anti-cheating and fairness that fits a web app

| Tier | Measures | Who does it | Fit for Capy |
| --- | --- | --- | --- |
| 0 Structural | Server clock. No answer key or grade before submit and release. Each student gets their own frozen copy. One attempt. Answers saved on the server. Only signed-in members. | Canvas, Moodle, Gradescope (§3) | **MVP.** It closes the biggest leak, the keys (§6). |
| 1 Signals | Log tab, focus and full-screen exits with times. Optionally require an explanation and a 30 to 90 s lockout. Flag a second session or device. | Exam.net Medium [EX1]; Wayground monitor [W2]; Canvas multiple sessions [C5]; Classroom emails on exit [G1] | Next. Show it as information, not proof: Canvas says its logs are not for proving cheating [C19]. |
| 2 Content | Question pools or random subsets, choice shuffle, versions per student, access code, sequential navigation. | Canvas [C5][C20]; Wayground [W2]; Khan [KA3]; Moodle password and IP limits [M1] | Later, as quizzes grow. |
| 3 Lockdown | Kiosk browser or app, managed devices, IP filtering. | SEB [SEB1]; Exam.net High [EX1]; Classroom locked mode [G1]; Forms with Take a Test [F2]; Canvas IP filter [C5] | Not for a web app. Moodle notes its browser security can be beaten [M1]. |

Other realistic measures:

- **Work by hand.** Sparx's bookwork checks show written working can be checked lightly [SP2].
- **Copied or AI-written answers.** Carousel picks out answers that may not be the student's own for class discussion rather than as proof [CA2].
- **Undetectable AI help.** An open answer written with an AI chat cannot be reliably detected. A short time limit, as Gradescope's guide points out, is the practical brake [GS1].

Fairness:

- **Show the rules before starting.** Gradescope's start dialog gives the time and the latest start that still allows the full time [GS2].
- **Never lose saved work.** At time-out, what is saved counts (§3.1).
- **Accommodations** (§3.6).
- **Regrade after a wrong key** (§3.7), and a teacher override with a comment.
- **Same rules for everyone.** "After close" release waits for the last student (§3.5).

What students see:

- **During:**
  - a timer they can hide (Moodle, Gradescope [M1][GS2]);
  - how many questions are answered and that answers are saved;
  - nothing about correctness.
- **After:** whatever the release setting allows. Today's practice quizzes keep their per-question Check and key.

---

## 6. Capy today: what an assignment builds on

- **Attempts.**
  - `attempts` (`server/migrations/0001_init.sql:482-498`) holds: `user_id`, `material_id` (set to null when the quiz is deleted), name snapshots, `chapters`, `correct`/`total`/`pct`, `answers`, `questions` (the graded snapshot) and `taken_at`.
  - `kind` and `started_at` were added in `0094_flashcard_attempts.sql:5-10`.
- **The check flow.** `CheckQuizQuestion` (`server/internal/store/queries.go:2138-2231`):
  - grades one question per call and adds it to the attempt;
  - never closes an attempt; unchecked questions score 0;
  - rates the question for FSRS and marks the quiz done;
  - refuses a second check of the same question with 409.
- **Start time.** `started_at` is the browser's time, kept only if it is not in the future (`startedBefore`, `queries.go:2108-2116`). Nothing in Capy is timed by the server.
- **Grading.**
  - Closed parts are graded in Go. Open parts go to Jev, one request per part (`server/internal/httpapi/quiz_grading.go:102-131`).
  - Any Jev failure fails the check, and the learner checks again.
  - Signed-in users are capped at 2,000 graded parts a day. Over the cap the API answers 429, though closed-only attempts are still graded.
  - The metering doc calls attempt points not a trusted score (`openwiki/observability-metering.md:729-750`).
- **Who sees answer keys.** Reading never sends keys; checking returns the key for the question just checked (`openwiki/question-bank.md:504-516`).
- **Copies keep keys.** Clones and Copy to quiz keep them (`openwiki/question-bank.md:530-532`). Viewer members may clone a workspace's materials (`openwiki/authorization-permissions-lifecycles.md:37-53`).
- **Editors see keys.** `GET /api/quizzes/{id}/edit` and the keys room give editors the full key (`openwiki/question-bank.md:517-528`).
- **Embedded quizzes** in notes record nothing (`openwiki/study-progress.md:55-58`).
- **Roles.** `workspace_members.role` is owner, editor or viewer (`server/migrations/0001_init.sql:614-621`). Only the owner manages members (`openwiki/authorization-permissions-lifecycles.md:55`).
- **Privacy.** Study progress, FSRS state and the review log are private to their user (`openwiki/authorization-permissions-lifecycles.md:983-988`, `openwiki/study-progress.md:814-819`). So are attempts: there is no route for reading another user's.
- **Notifications.** A `notifications` table exists, with `kind`, `data`, `href` and `workspace_id` (`server/migrations/0001_init.sql:651-662`).
- **Background work.** The API runs one-minute sweeps (`server/cmd/api/main.go:503-530`). Bank comment notices use row locks that let a second replica skip locked rows (`openwiki/question-bank.md:651-656`).
- **Project rules that apply.**
  - Retries are for components such as parsing and ingest, not calls a user can easily retry. Background grading after submit is that kind of component, but it still needs sign-off.
  - No defaults or fallbacks without human sign-off (`AGENTS.md`).

---

## 7. A minimal assignment model for Capy

### 7.1 Rules

1. **Two kinds.** A **quiz** stays practice: per-question Check, immediate key, unlimited tries, FSRS, private. An **assignment** wraps a quiz for grading, with kind `test` or `homework`. The kind is also its roll-up category. Epo says "tests and assignments"; I use `homework` in the column so a row is never "an assignment of kind assignment". The name is for Epo to settle.
2. **Frozen at publish.** The assignment keeps its own copy of the questions, with keys and marking schemes. Editing the quiz does not change a published assignment, as with Kahoot [K1]. Before anyone starts, the teacher may refresh the copy. After that, only key fixes followed by a regrade.
3. **Students only see the copy, without keys.** Assignment routes serve the copy through `questions.LearnerView`. Keys appear only when results are released with answers shown.
   - Source should be a quiz the assignees cannot read, such as the teacher's own standalone quiz.
   - Otherwise, warn: members could practise it, clone it or open its editor (§6).
4. **Teacher and students.** The owner is the teacher. Every other member (editor or viewer) is a student. The owner sees every submission. Before starting, students are told the owner will see their answers.
5. **Who can take one.** Only members, never link or public visitors. Only quizzes not embedded in notes.
6. **Grading and mastery stay apart.** Assignment results never feed FSRS in the MVP. Teacher-private test questions are not reviewable workspace items anyway.

### 7.2 Settings: MVP and later

| Setting | MVP | Later | Who does it |
| --- | --- | --- | --- |
| Kind (test or homework) as roll-up category | Yes | Custom categories with weights | Canvas groups [C1]; Classroom, Teams categories [G3][T1] |
| Frozen copy of the quiz | Yes; refresh until the first start | Versions | Kahoot [K1] |
| Assignees | Every non-owner member, including those who join before close (sign-off; Teams' default is current students only) | Chosen students or groups | Khan [KA3]; Teams [T1] |
| Opens, due, close | Each optional; no close means late allowed (sign-off) | Bulk date edits | Canvas [C4]; Teams [T1]; Moodle [M1] |
| Time limit | Optional minutes. Server deadline = min(start + limit + extra, close). Time-out submits saved answers. Small grace for saves in flight (sign-off; Moodle's default allowance is 60 s) | Moodle's "grace" and "must submit" policies | Canvas [C18]; Moodle [M1]; Gradescope [GS1]; Forms [F1] |
| Attempts | One | Several, with highest, latest, first or average and a wait between | Canvas [C5]; Moodle [M1]; Wayground [W2] |
| Late | Flag only | Percentage per day or hour, with a floor | Canvas [C9] |
| Missing | 0 after due in the overall (sign-off) | Percentage policy | Classroom [G4]; Canvas [C10] |
| Excused | Per student | — | Canvas [C11]; Classroom [G3] |
| Per-student accommodation | Extra minutes; moved due and close dates | Course-wide, multiplier, reopen, extra attempt | Canvas [C7][C8]; Moodle [M1]; Gradescope [GS3] |
| Question order | Optional shuffle per student, seeded by the attempt | Choice shuffle, pools, versions, one at a time, no backtracking | Canvas [C5][C20]; Gradescope [GS1]; Moodle [M1]; Wayground [W2]; Khan [KA3] |
| During the attempt | No marks, key or check; autosave; "n of m answered" | — | Moodle deferred feedback [M1] |
| Release | On submit, after close, or manual; plus show correct answers and solutions | Per-item matrix, release dates | Moodle [M1]; Canvas [C6][C14]; Forms [G2]; Gradescope [GS1] |
| Open answers | Jev in the queue; teacher override per part with a comment | Review AI marks before they count; grade one question across students | Canvas IgniteAI [C16]; Seneca [SE2]; Carousel [CA2]; Moodle [M4] |
| Regrade | After a key fix, one question for everyone | Canvas's four options | Canvas [C13] |
| Regrade requests | — | Per question, with a window | Gradescope [GS4] |
| Integrity signals | — | Focus and full-screen exit log, explanation, lockout, second-session flag | Exam.net [EX1]; Wayground [W2]; Canvas [C5][C19] |
| Notifications | Posted; results released | Due soon; "didn't start" nudge | Classroom [G4]; Kahoot [K1] |
| Gradebook | Grid of students × assignments, overall points plus subtotals, student profile, a student's own view | Weights, drop lowest, CSV, "View ungraded as 0" | Canvas [C1][C2][C17]; Classroom [G3]; Khan [KA2] |

### 7.3 Tables (sketch; names to be settled)

```sql
-- A graded use of a quiz in a workspace. `questions` is the frozen copy.
CREATE TABLE assignments (
  id                 text PRIMARY KEY,
  workspace_id       text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_material_id text REFERENCES materials(id) ON DELETE SET NULL,  -- provenance only
  created_by         text REFERENCES users(id) ON DELETE SET NULL,
  kind               text NOT NULL CHECK (kind IN ('test', 'homework')),
  title              text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  questions          jsonb NOT NULL,   -- full questions with keys and marking schemes
  total_marks        numeric NOT NULL CHECK (total_marks > 0),
  time_limit_s       int CHECK (time_limit_s > 0),
  opens_at           timestamptz,
  due_at             timestamptz,
  closes_at          timestamptz,
  shuffle_questions  boolean NOT NULL,
  release            text NOT NULL CHECK (release IN ('on_submit', 'after_close', 'manual')),
  show_answers       boolean NOT NULL, -- keys and solutions once released
  released_at        timestamptz,      -- manual release
  published_at       timestamptz,      -- NULL while a draft
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (due_at IS NULL OR closes_at IS NULL OR due_at <= closes_at),
  CHECK (release <> 'after_close' OR closes_at IS NOT NULL)
);
CREATE INDEX assignments_workspace_idx ON assignments(workspace_id, due_at);

-- One row only for a student with something special.
CREATE TABLE assignment_overrides (
  assignment_id text NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  user_id       text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  extra_time_s  int CHECK (extra_time_s > 0),
  due_at        timestamptz,
  closes_at     timestamptz,
  excused       boolean NOT NULL,
  PRIMARY KEY (assignment_id, user_id)
);

-- Assessment attempts are attempts tied to an assignment (practice rows keep these NULL).
ALTER TABLE attempts
  ADD COLUMN assignment_id   text REFERENCES assignments(id) ON DELETE CASCADE,
  ADD COLUMN deadline_at     timestamptz,  -- set by the server at start
  ADD COLUMN submitted_at    timestamptz,
  ADD COLUMN auto_submitted  boolean,
  ADD COLUMN status          text CHECK (status IN ('in_progress', 'grading', 'needs_review', 'graded')),
  ADD COLUMN grade_tries     int,
  ADD COLUMN next_grade_at   timestamptz,
  ADD COLUMN overrides       jsonb;        -- {questionId: {partId: {awarded, comment, by, at}}}
CREATE UNIQUE INDEX attempts_assignment_user_idx ON attempts(assignment_id, user_id)
  WHERE assignment_id IS NOT NULL;      -- one attempt (MVP)
CREATE INDEX attempts_open_deadline_idx ON attempts(deadline_at) WHERE status = 'in_progress';
CREATE INDEX attempts_grading_idx ON attempts(next_grade_at) WHERE status = 'grading';
```

**Why extend `attempts`:**
- It already has the right shape: per user, answers, graded snapshot, correct and total, start and end.
- The result page (`AttemptResult`) and All results can show assessment attempts with a Test or Homework tag.
- Guard the practice path: `/api/quizzes/{id}/check` must refuse an attempt that has `assignment_id`, and only practice attempts rate FSRS.
- The alternative, a separate `submissions` table, gives a cleaner split at the cost of duplicate columns and a second renderer path.

**The gradebook has no table.** It is computed from assignments, overrides, members and attempts. Sizes stay small: one workspace's members times its assignments.

### 7.4 Flows

```
publish ─▶ start (server sets started_at and deadline) ─▶ in_progress
in_progress ─▶ save answers (refused after deadline + grace)
in_progress ─▶ submit, or deadline passes (read or sweep) ─▶ closed parts graded in Go
            ├─ no open parts ─▶ graded
            └─ open parts ─▶ grading ─(minute sweep, SKIP LOCKED, Jev, retries)─▶ graded
                                     └─ tries used up ─▶ needs_review (teacher marks by hand)
graded ─▶ visible per release (on submit, after close, manual Release)
teacher: override part ─▶ total recomputed; key fix ─▶ regrade question ─▶ grading or graded
```

- **Student's effective dates:**
  - `due = coalesce(override.due_at, a.due_at)`;
  - `close = coalesce(override.closes_at, a.closes_at)`;
  - `limit = a.time_limit_s + coalesce(override.extra_time_s, 0)`.
- **Start.** Needs: published, after opens, before close, not excused, no existing attempt. Starting again returns the attempt already in progress.
- **The browser counts down from server time.** Send `serverNow` and `deadlineAt` with the start response.
- **Late** means `submitted_at` is after the due date.
- **Statuses, worked out not stored:**
  - excused;
  - submitted (late or on time), with its grading state;
  - in progress;
  - missing (past due, nothing submitted);
  - upcoming or open.
- **The sweep.** It runs in the API's existing minute loop:
  - it finalises attempts past their deadline;
  - it grades attempts waiting in `grading` (Jev, five parts at a time as today);
  - on failure it backs off, and after N tries moves the attempt to `needs_review`. The retry rule needs sign-off.
  - Deadlines are enforced when answers are written, so finishing up to a minute late does no harm.

### 7.5 Endpoints (sketch)

| Who | Route | Does |
| --- | --- | --- |
| Owner | `POST /api/workspaces/{id}/assignments` | Creates a draft from a quiz the owner can edit (`{materialId, kind, title, dates, timeLimit, shuffle, release, showAnswers}`); copies the questions. |
| Owner | `PATCH /api/assignments/{id}`, `POST /api/assignments/{id}/publish`, `DELETE /api/assignments/{id}` | Edits settings; refreshes the copy until the first start; publishes; deletes. |
| Owner | `PUT /api/assignments/{id}/overrides/{userId}` | Extra time, moved dates, excused. |
| Owner | `GET /api/assignments/{id}/submissions`, `GET /api/assignment-attempts/{id}` | Every assignee's status, score and answers. |
| Owner | `PATCH /api/assignment-attempts/{id}/marks` | Overrides a part's marks with a comment. |
| Owner | `POST /api/assignments/{id}/regrade` | Regrades one question for everyone after a key fix. |
| Owner | `POST /api/assignments/{id}/release` | Manual release. |
| Owner | `GET /api/workspaces/{id}/gradebook`, `GET /api/workspaces/{id}/members/{userId}/grades` | The grid and one student's profile. |
| Student | `GET /api/workspaces/{id}/assignments` | Their list with statuses and released scores. |
| Student | `POST /api/assignments/{id}/start` | Starts or resumes; returns questions without keys (shuffled if set), `deadlineAt` and `serverNow`. |
| Student | `PUT /api/assignment-attempts/{id}/answers` | `{questionId, answers}` autosave. No grading, no key. The user retries a failed save. |
| Student | `POST /api/assignment-attempts/{id}/submit` | Submits. |
| Student | `GET /api/assignment-attempts/{id}` and `GET /api/workspaces/{id}/grades` | Their result, as released, and their overall. |

### 7.6 How it maps onto Capy's tables, and the gaps

| Concept | Today | Needed |
| --- | --- | --- |
| Quiz as a material | `materials.kind='quiz'`, live-edited with no versions; embedded quizzes record nothing (`openwiki/question-bank.md:396-401`, `openwiki/study-progress.md:55-58`) | `assignments.questions` is the frozen copy. Embedded quizzes cannot be assigned. A standalone teacher quiz is the safest source. |
| Answer keys | Check returns the key (`question-bank.md:504-516`). Clones keep keys and viewers may clone (`question-bank.md:530-532`, `authorization…:37-53`). Editors see keys (`question-bank.md:517-528`). | Assignment routes only. Warn when the source quiz is readable by assignees. |
| Attempt | Never closed; browser start time; one check per call; key returned (`queries.go:2108-2231`) | Server start and deadline, autosave without grading, submit, status, overrides. Practice check refuses assessment attempts. |
| Grading | Synchronous Jev; a failure fails the check; 2,000 parts a day cap (`observability-metering.md:729-750`) | A background queue with retries (sign-off). Decide whether assessment grading counts against the student's cap. A test has at most 20 open parts (`question-bank.md:430-435`). |
| Roles | Owner, editor, viewer are content rights; only the owner manages members (`0001_init.sql:614-621`, `authorization…:55`) | Teacher = owner and students = everyone else for the MVP. A co-teacher flag later. Editors are students, but can still open a workspace quiz's editor, hence the copy. |
| Privacy | Attempts and progress are private (`authorization…:983-988`) | The owner reads assessment attempts. Tell students before they start. Practice stays private unless Epo decides otherwise. |
| Notifications | `notifications` with kind, data, href, workspace (`0001_init.sql:651-662`) | New kinds: posted, released. |
| Background jobs | Minute sweeps (`server/cmd/api/main.go:503-530`), SKIP LOCKED pattern | Finalise expired attempts; drain the grading queue. |
| Chapters | `attempts.chapters`, `review_sessions` chapter groups | Not used. Folders only organise (Epo, 2026-11-02). The column can go with the chapter clean-up. |
| Mistakes | `mistakes` pool for "Review mistakes" (`0001_init.sql:500-507`) | Later: released test mistakes could go into it. |

Open edge cases to decide:
- **Clone.** Should a cloned workspace copy assignments? Today clones copy no study rows. Classroom reuses posts.
- **Transfer.** The new owner would see results.
- **A student leaves or deletes their account.** Their attempts stay, or cascade on account deletion. Canvas lists inactive enrolments separately (guide title `660835`).
- **Frozen owners.** Students should still submit, as study recording does today.

### 7.7 Decisions for Epo (each is a default or a rule needing sign-off)

1. **Names.** Kinds `test` and `homework`; "Assignment" in the UI.
2. **Missing work** counts 0 after the due date, or only after close.
3. **No close date** means late is allowed forever (Teams default) or the due date closes it.
4. **Grace** for saves after the deadline: 0, 10 or 60 s (Moodle's default allowance is 60 s).
5. **Retries** for Jev grading after submit, the number of tries, and falling back to `needs_review`.
6. **Roll-up**: total points (recommended for the MVP) or weights by kind from day one.
7. **Late joiners**: do members who join before close get open assignments?
8. **Teacher view of practice**: does the owner see members' practice (attempts, reviews, mastery), and with what notice? Today it is private.
9. **Assessment answers and FSRS**: do they ever feed FSRS or "Review mistakes" (Khan lets tests move mastery [KA1])?
10. **Overall for students**: shown always, or behind a switch (Teams, Classroom) [T2][G3].
11. **A workspace quiz as the source**: forbid it, warn, or hide it while the assignment runs.

---

## 8. Sources

Canvas LMS (Instructor and Student Guides; the "Last Updated" date shown on each page):
- [C1] Weight final grade by assignment groups (2026-07-28): https://community.instructure.com/en/kb/articles/660669-how-do-i-weight-the-final-course-grade-based-on-assignment-groups
- [C2] Rules for an assignment group (2026-07-28): https://community.instructure.com/en/kb/articles/660670-how-do-i-create-rules-for-an-assignment-group
- [C3] Exclude an assignment from final grades (2026-07-31): https://community.instructure.com/en/kb/articles/660677-how-do-i-exclude-an-assignment-from-the-courses-final-grades
- [C4] Due dates vs availability dates (2026-07-31): https://community.instructure.com/en/kb/articles/660663-what-is-the-difference-between-assignment-due-dates-and-availability-dates
- [C5] New Quizzes settings (2026-09-11): https://community.instructure.com/en/kb/articles/661070-how-do-i-manage-settings-for-a-quiz-in-new-quizzes
- [C6] New Quizzes results (2026-09-11): https://community.instructure.com/en/kb/articles/661071-how-do-i-manage-quiz-results-in-new-quizzes
- [C7] New Quizzes accommodations (2026-09-09): https://community.instructure.com/en/kb/articles/661093-how-do-i-add-accommodations-for-a-student-in-new-quizzes
- [C8] Moderate a student's attempt (2026-09-04): https://community.instructure.com/en/kb/articles/661092-how-do-i-moderate-a-students-quiz-attempt-in-new-quizzes
- [C9] Late Submission policy (2026-10-02): https://community.instructure.com/en/kb/articles/660858-how-do-i-apply-a-late-submission-policy-in-the-gradebook
- [C10] Missing Submission policy (2026-08-17): https://community.instructure.com/en/kb/articles/660857-how-do-i-apply-a-missing-submission-policy-in-the-gradebook
- [C11] Submission statuses (2026-10-08): https://community.instructure.com/en/kb/articles/660848-how-do-i-change-the-status-of-a-submission-in-the-gradebook
- [C12] Quiz types, Classic (2026-08-20): https://community.instructure.com/en/kb/articles/660994-what-quiz-types-can-i-create-in-a-course
- [C13] Regrade in New Quizzes (2026-09-11): https://community.instructure.com/en/kb/articles/661074-how-do-i-regrade-a-quiz-question-in-new-quizzes
- [C14] Course posting policy (2026-09-02): https://community.instructure.com/en/kb/articles/660844-how-do-i-select-a-grade-posting-policy-for-a-course-in-the-gradebook
- [C15] Learning Mastery Gradebook (2026-10-22): https://community.instructure.com/en/kb/articles/660867-how-do-i-use-the-learning-mastery-gradebook-to-view-outcome-results-in-a-course-from-the-gradebook
- [C16] IgniteAI Grading Assistance (2026-10-12): https://community.instructure.com/en/kb/articles/664423-how-do-i-use-the-igniteai-grading-assistance-for-speedgrader
- [C17] View ungraded as zero; Current vs Final (2026-08-15): https://community.instructure.com/en/kb/articles/660831-how-do-i-view-total-scores-in-the-gradebook-as-if-all-ungraded-assignments-were-given-zero-grades
- [C18] Resume a quiz, student guide (2026-10-01): https://community.instructure.com/en/kb/articles/661356-how-do-i-resume-a-quiz-that-i-already-started-taking
- [C19] Quiz log (2026-09-04): https://community.instructure.com/en/kb/articles/661037-how-do-i-view-a-quiz-log-for-a-student
- [C20] Random set from an item bank (2026-09-14): https://community.instructure.com/en/kb/articles/661082-how-do-i-add-all-items-or-a-random-set-from-an-item-bank-to-a-quiz-in-new-quizzes
- [C21] Community, attempts not auto-submitting at Until, fixed 2026-04-28 (search summary, unverified): https://community.instructure.com/en/discussion/665833/in-progress-new-quiz-attempts-arent-auto-submitting-after-the-until-date
- [C22] Community, submission happens in the browser (unverified): https://community.instructure.com/en/discussion/626017/issue-new-quiz-and-auto-submit-when-student-leaves-a-test-before-time-runs-out
- [C23] New Quizzes native integration dates (search summary, unverified): https://community.instructure.com/en/discussion/665555/new-quizzes-native-integration-in-canvas-q1-2026
- [C24] October 2026 New & Next showcase (search summary, unverified): https://www.instructure.com/resources/blog/what-we-shared-october-2026-new-next-showcase
- Titles seen in the guide navigation (existence only): final grade override `660860`, grading history `660864`, hide totals `661136`, inactive enrolments `660835`.

Moodle (5.3 docs):
- [M1] Quiz settings (edited 2026-09-17): https://docs.moodle.org/503/en/Quiz_settings
- [M2] Grade aggregation: https://docs.moodle.org/503/en/Grade_aggregation
- [M3] Grade categories: https://docs.moodle.org/503/en/Grade_categories
- [M4] Quiz reports: https://docs.moodle.org/503/en/Quiz_reports

Google:
- [G1] Create a quiz assignment: https://support.google.com/edu/classroom/answer/9095575
- [G2] Create and grade quizzes with Google Forms: https://support.google.com/docs/answer/7032287
- [G3] Set up grading: https://support.google.com/edu/classroom/answer/9184995
- [G4] Grade and return an assignment: https://support.google.com/edu/classroom/answer/6020294
- [G5] Grade and track practice set assignments: https://support.google.com/edu/classroom/answer/13457851
- [G6] Learn about practice sets: https://support.google.com/edu/classroom/answer/13455950

Microsoft:
- [T1] Create an assignment in Teams: https://support.microsoft.com/en-us/education/assignments/create-an-assignment-in-microsoft-teams
- [T2] Adjust assignment settings: https://support.microsoft.com/en-us/topic/adjust-assignment-settings-in-your-class-team-05bb3b89-1cdf-415a-b6c7-44add0376a77
- [T3] Grade, return and reassign (search summary): https://support.microsoft.com/en-us/education/assignments/grade-return-and-reassign-assignments
- [T4] View assignments, student (search summary): https://support.microsoft.com/en-us/education/assignments/view-and-navigate-your-assignments-student
- [F1] Set a timer in Forms: https://support.microsoft.com/en-us/forms/set-a-timer-for-forms-or-quizzes-in-microsoft-forms
- [F2] Form and quiz settings: https://support.microsoft.com/en-us/office/adjust-your-form-or-quiz-settings-in-microsoft-forms-f255a4ba-e03c-4e12-b880-f7e8b62e0665
- [F3] Q&A, timer limited to organisation respondents (unverified): https://learn.microsoft.com/en-us/answers/questions/5509163/how-to-set-time-limit-for-anyone-can-respond-micro

Wayground (formerly Quizizz):
- [W1] Async (homework) modes (updated 2025-11-08): https://help.wayground.com/support/solutions/articles/158000404919-async-homework-session-modes-on-wayground
- [W2] Session settings: https://help.wayground.com/support/solutions/articles/158000404930-navigate-session-settings
- [W3] Rebrand, THE Journal 2025-06-24: https://thejournal.com/articles/2025/06/24/quizizz-rebrands-as-wayground-announces-new-ai-features.aspx

Kahoot:
- [K1] Assign a kahoot in the web platform (updated about 11 days before 2026-11-02): https://support.kahoot.com/hc/en-us/articles/360039411334-How-to-assign-a-kahoot-in-web-platform
- [K2] 2020 blog, timer off for challenges (unverified): https://kahoot.com/blog/2020/03/31/ace-virtual-lessons-with-student-paced-challenges/

Khan Academy:
- [KA1] Course and Unit Mastery: https://support.khanacademy.org/hc/en-us/articles/115002552631-What-are-Course-and-Unit-Mastery
- [KA2] Assignments report: https://support.khanacademy.org/hc/en-us/articles/360031122951-How-do-I-use-the-Assignments-report
- [KA3] Make assignments (pre-Reimagined platform): https://support.khanacademy.org/hc/en-us/articles/115000772311-How-do-I-create-assignments-

Gradescope:
- [GS1] Creating an Online Assignment: https://guides.gradescope.com/hc/en-us/articles/23603175384717-Creating-an-Online-Assignment
- [GS2] Submitting timed assignments: https://guides.gradescope.com/hc/en-us/articles/21864654527245-Submitting-timed-assignments
- [GS3] Time limit extensions vs due dates (search summary): https://guides.gradescope.com/hc/en-us/articles/21867952494861-How-do-time-limit-extensions-affect-due-dates-late-due-dates-and-time-limits
- [GS4] Managing regrade requests (search summary): https://guides.gradescope.com/hc/en-us/articles/22237994239885-Managing-Regrade-Requests

Sparx Maths:
- [SP1] Key concepts of a homework: https://support.sparxmaths.com/en/articles/342349-key-concepts-of-a-sparx-maths-homework
- [SP2] Understanding bookwork checks: https://support.sparxmaths.com/en/articles/342329-understanding-bookwork-checks

Seneca:
- [SE1] Student stats: https://help.senecalearning.com/en/articles/3577117-how-are-student-stats-data-displayed-on-seneca
- [SE2] AI-marked exam questions (2026-08-26): https://help.senecalearning.com/en/articles/6536455-ai-marked-exam-questions-for-teachers

Carousel Learning:
- [CA1] Home page: https://carousel-learning.com/
- [CA2] Marking a Quiz: https://carousel-learning.zendesk.com/hc/en-gb/articles/360018711039-Marking-a-Quiz

Exam.net and Safe Exam Browser:
- [EX1] Security settings in exams: https://support.exam.net/s/article/security-settings-in-exams?language=en_US
- [SEB1] SEB overview: https://safeexambrowser.org/about_overview_en.html

Capy (repo paths): `openwiki/study-progress.md`, `openwiki/question-bank.md`, `openwiki/authorization-permissions-lifecycles.md`, `openwiki/observability-metering.md`, `server/migrations/0001_init.sql`, `server/migrations/0094_flashcard_attempts.sql`, `server/internal/store/queries.go`, `server/internal/httpapi/quiz_grading.go`, `server/cmd/api/main.go`, `todo-canvas-workspace.md`, `todo-canvas-workspace/E-study.md`, `AGENTS.md`.
