# Learning page plan

Status 2026-11-04: proposal only, nothing built. It waits for Epo's answers in §8.

Epo's ask: "i want ot see if we cna start planning what the learning page at home do, ideally i dont want to use AI to do a lot of suggestion, rather i want to use the algorithms/scores to decide".

Mocks: Design canvas https://claude.ai/artifact/QCQEdnhKxg1PnPP41Q1y7W. It is private until shared from its Share menu. Pages: 1 layouts A, B, C; 2 too little data; 3 class and personal; 4 after Assignments and tabs. Every state has a 360px board. Sticky notes hold the rules.

## 1. What is there today

Checked on `claude/study-all` at 3d39344fa.

- **Hidden.** `features.learning` is off (`src/lib/features.ts`), so there is no sidebar row and `/learning` redirects Home. The code stays. The session and result pages under `/learning/review` and `/learning/reviews` still work.
- **The hidden page.** Two tabs: Review (`ReviewTab`, ending with `PastReviews`) and All results (`AllResults`). Review reads `GET /api/review/overview`: top 5 suggestions, at most 2 per workspace, then unfinished sessions, then every workspace with progress.
- **Neighbours, so the page does not repeat them:**

| Page | Scope | Job |
|---|---|---|
| Workspace Dashboard | One workspace | What to practise next, Activity |
| Study → Practice | One workspace | Suggested (at most 3, questions only), every quiz, own topic reviews |
| Study → Summary | One workspace | Results by topic and, for class members, Overall. Not built yet |
| Question bank `/qb` | The bank | Its own topics and progress map |

Nothing today answers "which workspace should I open". That is the gap.

**If the flag were turned on today:**
- `reviewableWorkspaces` checks neither `workspaces.kind` nor role. A class owner who tried their own quiz gets their own class suggested, which Practice refuses (`canEdit && kind == WorkspaceClass`).
- A new member has no `study_progress` row, so their class is missing and the page is empty.
- Learning's suggestions use the review items preference (questions and cards). Practice's use questions only. The same topic can read differently on the two pages.
- `ReviewOverview` runs role, switch, pool and history queries per workspace. The page needs one scope query and a measurement (§6).

## 2. What we record per user

Trust means how far a score can lean on it.

| Signal | Where | Holds | Trust and limits |
|---|---|---|---|
| Memory | `review_states` | Per item: stability, difficulty, reps, lapses, last review, hash. R is computed on read | **Medium.** Default FSRS weights, never fitted. Questions rate Again, Hard or Good from their marks, never Easy. Card ratings are the learner's own. A same-day redo keeps stability but moves the clock, so the item looks fresher (checked on go-fsrs: S 0.403 stays). Gone with its material |
| Ratings | `review_log` | Every rating with its time, for questions and cards | **Good for activity and history.** No hash, so misses from before an edit still count as tricky. Reset leaves it. Blank and unmarked questions are absent. No workspace column: join `materials`. Gone with its material |
| Graded parts | `answer_events` | Per part: awarded of marks, grader, source, attempt, hash, `key_seen`, workspace, time | **Best evidence: it keeps partial credit.** Nothing reads it yet. No topic column. Only quiz and review checks: no flashcards, bank, embedded or signed-out answers. `grader='ai'` parts carry Jev's marks (88.9% correct in the 2026-11-03 bench). Reset leaves it |
| Attempts | `attempts` | Marks, percent, start and end, answers, graded snapshot, workspace, kind | **Good for history, wrong for weakness.** A try left partway scores unchecked questions 0, so a low score can mean unfinished. A flashcard attempt's total is cards rated, not the set's size. `attempts.topics` is a scope snapshot, not a question's topic |
| Sessions | `review_sessions`, `review_answers` | Group, mode, evidence, served items with reasons, start, last answer, finish, each answer | **High**, written with the answer. Sessions only. Skips leave nothing |
| Practised | `study_progress` | One row per quiz or set: state, `updated_at` | **Row and `updated_at` are reliable**: the time moves on every rating and check. **`state` is not**: the first check of a quiz writes `done` (`study.go:582`) with 1 of 10 checked. Nothing in the product reads it |
| Opens | `workspace_visits`, `item_opens` | Last open only | **Weak.** Epo: opening proves little. Fit only for ordering |
| Bank | `bank_progress` | Latest score per bank question, overwritten, with hash and bank topic | **Good for "where was I".** No history or FSRS, and bank topics are not workspace topics |
| Topic | `materials.topic_id` | One topic per quiz | **Coarse.** A quiz spanning topics counts wholly to its own. Moving a quiz moves its history |
| Switches | `workspace_study.enabled`, `users.study_preferences` | Hide study progress, session size, items, focus | Reliable |
| Role | `workspaces.kind`, `workspace_members.role` | Class or personal, owner, editor, viewer | Reliable |

**Missing:**
- Question-level topics (`question_topics`) and a topic on each event.
- Question difficulty (`item_stats`), and time per question.
- Due dates, because Assignments is not built. Exam dates and goals are never assumed (Epo 2026-10-10).
- A record of skips.
- Link between clones: a member's clone has the same questions under new material ids, so both copies can be suggested.
- Real learner data. Every constant here is unmeasured on real learners.

Leave aside: signed-out study stays in IndexedDB, and standalone quizzes have no workspace. Both stay out of the lists. Standalone attempts stay in All results. Reset has an endpoint but no UI at this commit; if it returns, the labels must read events from after it.

## 3. The page's job

**Across every workspace you study in: what to do next, and how each one stands. Every row is picked by a stated rule and says why.**

Workspace detail stays on Summary and Practice. Learning picks the workspace and links there.

## 4. The rules

No model call anywhere in this section. Reasons are paraglide templates.

### Scope: which workspaces count

A workspace counts when all of these hold:
1. You can read it (`WorkspaceEffectiveRole`).
2. It is not a class you own or edit: the test Practice already uses.
3. Hide study progress is off.
4. You are its owner or a member, or you have a `study_progress` row there (a link or public visitor who practised).

### What to do next

Fixed order by kind, 6 rows at most. Kinds are never scored against each other, because a single number across them would hide why a row is there.

| Kind | Rule | Row says | Opens |
|---|---|---|---|
| **Due** (after Assignments) | Assigned to you in a class where you are a member, not submitted, overdue or due within 7 days, soonest first. At most 3 | "Due Fri 7 Nov · 12 questions", "Late, was due Mon 2 Nov" | The assignment |
| **Continue** | A session with `finished_at` empty, or the newest attempt on a quiz with fewer questions checked than it holds; last answer within 14 days; newest first. At most 2 | "3 of 10 answered · 2 h ago" | The session or the attempt |
| **Review** | Today's engine, unchanged: item = (1 − R) × (1 + tricky + learned), items at R ≤ 0.9, summed per topic, × interest. Shows at 3 or more, largest first, at most 5 and 2 per workspace. A topic under Continue is skipped | Today's mode label, `reviewReason` and "N items" | The session |
| **Start** | The first quiz or set in reading order with no `study_progress` row, one per workspace, where you are the owner or a member and opened or practised it in the last 30 days. Newest visit first. At most 2, and it keeps 1 of the 6 rows if any exists | "Not started · 12 questions" | The quiz or set |

- A session older than 14 days leaves the list and Past reviews shows it as Stopped. Today Past reviews lists finished sessions only, so its query changes.
- Sets stay out of Continue for now: a run's place lives in the browser, so another device could not resume it. Quiz attempts need a small `attempt` search param for the same reason.

### Workspaces

One row per workspace in scope that holds a quiz or set, newest practice first. A row opens that workspace's Summary.

- **Topic labels:** counts per label ("2 Needs practice").
- **Items tried:** rated items with current content, of all items ("38 of 120 items tried"), from `reviewPool` and `itemCounts`.
- **Last practised:** `study_progress.updated_at`.
- **Overall (after Assignments):** class members only, as on Summary.

### Topic labels

Plan §5 sets the labels and thresholds. Its model (Rasch with priors, step 6) needs a simulator and three new tables. This is a count that needs no tables and can be replaced later without touching the UI:

1. Take your `answer_events` on the topic's untrashed, visible quizzes (unfiled quizzes are Other files). Keep each question's events with its latest hash.
2. Weigh each graded part: `w = repeat × parts × age`.
   - `repeat`: 1 for a question's first check, 0.5 a day or more after its previous check, 0 for a same-day repeat with `key_seen`.
   - `parts`: min(1, 3 / parts in the question).
   - `age`: 0.5^(days / 30). Claude's number.
3. `right = 1 + Σ w·awarded/marks`, `wrong = 1 + Σ w·(1 − awarded/marks)`. Success follows Beta(right, wrong).

| Label | Rule |
|---|---|
| Not started | No events |
| Attempted | Fewer than 3 different questions |
| Needs practice | P(success < 0.6) ≥ 0.8. Leaves when that falls below 0.5, so it does not flicker |
| Familiar | Between |
| Proficient | P(success > 0.7) ≥ 0.8 |
| Mastered | Proficient, then a question at least 3 days later scored 0.7 or more. 3 days is Claude's number |

Read as plain counts, first answers, computed:

| Asked | Needs practice | Familiar | Proficient |
|---|---|---|---|
| 3 | 0–1 right | 2–3 | none yet |
| 5 | 0–2 | 3–4 | 5 |
| 10 | 0–4 | 5–8 | 9–10 |
| 20 | 0–10 | 11–15 | 16–20 |

The trade-off: it ignores question difficulty, so once sessions adapt, a weak learner served easier questions looks better than they are. The plan's synthetic check found 71% of weak topics with raw percent against 92% with the model, and this count sits nearer raw percent. Flashcards stay out, as decided.

### This week

`review_log` rows in scope in the last 7 days, quiz items as questions and set items as cards: "This week: 41 questions, 18 cards". No streak. Epo did not ask for this line; see §8.

### Tabs

Overview, Past reviews, All results. Both tables stay as they are.

### Too little data

Boards on canvas page 2.

| State | Detected by | Shows |
|---|---|---|
| Nothing to study | No workspace in scope holds a quiz or set | The ink book, "No quizzes or flashcards yet", Go to Workspaces |
| Just joined | Quizzes exist, no progress rows | Start rows. Workspaces rows read "Not started · 0 of 120 items tried" |
| A little practice | Fewer than 3 questions on a topic, no group at 3 | Continue and Start. Attempted with its count |
| Caught up | Nothing to continue or start, no group at 3 | No Next section, only Workspaces |
| Everything hidden | Hide study progress on all | Same as Nothing to study |

Reviews never show a date or a due count. Empty sections are not shown.

How long Review rows take to appear, from the real scheduler with today's constants, days after one attempt at full interest:

| Questions | All right | Half right | All wrong |
|---|---|---|---|
| 3 | 57 | 18 | 3 |
| 5 | 17 | 4 | 1 |
| 10 | 6 | 1 | 0.5 |
| 20 | 3 | 0.5 | 0.4 |

This follows from Epo's absolute counts (2026-10-10). See §8.

### Class and personal

Boards on canvas page 3.

| Who | Class | Personal |
|---|---|---|
| Owner, editor | Out of Next and Workspaces, even after trying their own quiz. Rows stay and return if the workspace turns personal | Next, Workspaces |
| Viewer member | Next, Workspaces. Due and Overall after Assignments | Next, Workspaces, their own results only |
| Link or public visitor | After practising there: Continue, Review, Workspaces row. No Start | Same |
| Lost access | Out, rows stay | Same |

Past reviews and All results keep listing your own history everywhere, as today.

## 5. Where AI would still appear

Nothing on the page needs it: picking, ranking, labels and wording are all rules. These are the places around it, for Epo to decide:

1. **AI marks feed the scores.** Open parts are marked by a model, then count in FSRS and in the labels. Already so, and the discount was dropped (Epo 2026-11-03).
2. **Per-question topics.** Plan §3 tags questions with AI. The page works without it on one topic per quiz, and gets sharper with it.
3. **A topic with nothing new to serve.** The topic session repeats questions already seen. Only Make my own practice (AI, the learner's credits, on click) could add new ones.
4. **The chat agent.** `read_study_progress` stays gone. Bringing it back is a prompt change and needs its own sign-off.
5. **A written summary.** Plan §10 queues AI insights for later. None here.

## 6. Build outline, once decided

Reuse before adding: `groupSuggestions`, `scoredWorkspace`, `reviewReason`, `itemCounts`, `SuggestedList`'s row, `PastReviews`, `AllResults`.

1. Mocks changed to Epo's answers.
2. Server: one scope query, a new `GET /api/learning/overview`, Continue and Start in SQL, topic labels in Go. No new tables.
3. Summary and Workspaces share the labels.
4. UI, then the flag on.
5. Due and Overall when Assignments lands.
6. Measure the endpoint with `bench/gateway` at the 50-workspace cap before landing. `itemCounts` parses documents on a cache miss; if that is slow, store each material's item count on write.
7. Docs and tests: `openwiki/study-progress.md`, `test-catalog.md`, store tests for scope, Continue, Start and the label table above, and `e2e/study`.

## 7. Decisions this would change

Each needs Epo's yes and a line in `human/study-progress.md`:

- 2026-10-19: Past reviews is the Review tab's last section. Becomes its own tab.
- 2026-10-10, 2026-10-25: Learning's workspace rows start a whole-workspace review and show no item count. Become rows that open Summary and show items tried.
- 2026-10-10: suggestions read Start. Become Review, because Start now means a new quiz.
- 2026-10-10: "not tested yet" is Continue's job. Continue went with read progress, so Start rows take it.
- 2026-11-04: Learning stays hidden until AI analysis of study progress is decided. This plan brings it back with none.
- Plan §10: "perhaps to show the AI suggestions across workspaces". Replaced by rules.

## 8. Questions for Epo

1. **Layout (canvas page 1).** A one list, B grouped by workspace, or C with Topics to practise beside it? I recommend A: it is the only one that answers "what first" across workspaces.
2. **Bring Learning back with no AI?** It was hidden until AI analysis is decided. If yes, `read_study_progress` stays gone too. I recommend yes.
3. **Topic labels now or later?** Count them now as in §4, or wait for the mastery model after its simulator? I recommend now, replacing the count when the model lands.
4. **Summary.** Workspaces rows open Summary, which is not built. Build Summary with this page, or open Practice until it exists? I recommend building them together, since both need the labels.
5. **Class owner with nothing to study (canvas page 3).** O1 empty page, or O2 You teach rows that open Study → Members? I recommend O2, so a teacher does not land on a dead end.
6. **Start rows.** Suggest the first not-started quiz or set per workspace? I recommend yes: without it a new member's page is empty.
7. **Review threshold.** Keep 3? A 5-question quiz answered right waits 17 days, while a 20-question quiz answered wrong comes back in about 10 hours. I recommend keeping it, with Start and Practice covering the wait.
8. **Whole-workspace review.** Today's Learning rows start one. Drop it, or keep it in a row ⋮? I recommend dropping it: Suggested and topic sessions cover it.
9. **Flashcards in Review rows.** Keep cards in Learning's suggestions while Practice stays on questions? I recommend keeping them: this would be the only place sets get suggested.
10. **Question bank.** Add one Continue row for the last bank topic, or keep the bank off this page? I recommend keeping it off: it has its own landing.
11. **This week line.** Keep or drop? You did not ask for it. I would keep it, as the one line that shows the work adding up.
12. **Topic with nothing new to serve.** Link to Make my own practice (AI, credits, on click) from this page? I recommend no: leave it on Practice.
13. **Words.** Are "Overview", "What to do next" and "items tried" right?
