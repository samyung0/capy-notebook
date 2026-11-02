# R2: Member strengths and weaknesses, and personalised follow-up

Status 2026-11-02: research round 1 for Epo. Nothing is decided. Every suggestion first says how other apps and the research do it.

- **Code read:** the `blocksuite-notes` worktree (repo paths below are relative to the repo root).
- **Data read:** `/Users/sam/web/capy-notebook/data/question-bank` (main tree only).
- **Web:** 19 searches, plus direct reads of official help centres, abstracts (Europe PMC, ERIC, arXiv) and one paper's full text.
- **"Unverified"** marks a claim that rests on memory, on one weak or secondary source, or on a search summary I could not open.
- **Scripts** behind the numbers in §5 and the appendix (synthetic, nothing touches the repo):
  - `/private/tmp/claude-501/-Users-sam-web-capy-notebook/6013b112-5e49-4dab-8bfe-41856549d0e4/scratchpad/tools/evidence3.py`
  - `/private/tmp/claude-501/-Users-sam-web-capy-notebook/6013b112-5e49-4dab-8bfe-41856549d0e4/scratchpad/tools/sim.py`
  - `/private/tmp/claude-501/-Users-sam-web-capy-notebook/6013b112-5e49-4dab-8bfe-41856549d0e4/scratchpad/tools/kalman_check.py`

---

## 0. In short

1. **Model skill and memory separately.**
   - FSRS stays the memory model for each item.
   - Skill gets its own model per member and topic.
2. **The skill model is a small Bayesian logistic (Rasch-type) model, updated online like Elo or Glicko.**
   - It has a member ability for the whole workspace, a deviation per topic, and a difficulty per question pooled across members.
   - Single-answer multiple choice and true/false get a fixed guessing floor.
   - Partial credit is the outcome itself (awarded / marks).
   - Each answer carries a weight. LLM-graded parts weigh less, as do repeats after the key was shown.
   - Uncertainty grows slowly while a topic goes unpractised.
   - The update is about 10 lines of Go, and the whole thing can be replayed from an answer log.
3. **Percent correct cannot be the skill measure once follow-up adapts.**
   - Adaptive practice serves weaker members easier items, so everyone's raw percent drifts towards the target rate.
   - In a synthetic check, raw percent caught 71% of truly weak topics under adaptive practice. The model caught 92% (§5.7, with its caveat).
4. **Data-hungry models don't fit 1–50 members and under 10 answers per question.** This rules out 2PL IRT, BKT fitted per skill, DKT/SAKT, ALEKS-style knowledge spaces and Math Academy-style hand-built graphs.
   - The research agrees: logistic models "with the right set of features" lead on moderate datasets ([Gervet et al. 2020](https://jedm.educationaldatamining.org/index.php/JEDM/article/view/451)).
   - Deep models add little over DKT ([pyKT](https://arxiv.org/abs/2206.11460)).
5. **Topics are a flat list per workspace, separate from folders.**
   - Aim for 5–20 topics and cap at 30, with one topic per question.
   - The agent tags questions when it writes them. A background tagger tags hand-written, imported and bank-copied questions.
   - Owners and editors edit topics, and the AI proposes merges.
   - The bank's topic tables and its topic-summary UI are the template.
6. **Show four lenses:**
   - memory (fading items);
   - skill (a label plus how sure);
   - coverage (answered of total);
   - effort (answers, days, minutes).
   - Label topics with action words, never "weak". A topic needs answers to at least three different questions before it gets a label.
7. **Follow-up reuses review sessions, grouped by topic instead of chapter.**
   - A session mixes old missed and fading items, unattempted items near a 75% predicted success, and one interleaved topic.
   - When the pool runs short, the agent writes new variant questions into the member's private practice quiz in the background, and they come up next time.
   - Variants pass leakage and blind-solve checks.
   - Teacher approval is only for class-wide or graded work.
8. **Offline evaluation can't use the pilot.**
   - The pilot holds only AI blind-solve results: 32 questions, all agreed, mean part score 1.0. There are no learner answers.
   - Start logging answer events now. Evaluate on a simulator and on classroom-sized slices of public datasets.

---

## 1. What Capy has today (relevant facts)

| Fact | Where |
|---|---|
| FSRS per item via go-fsrs v3.3.1: default weights, target retention 0.9, no short-term steps. The forgetting curve is `R = (1 + 19/81 · t/S)^-0.5` (Decay −0.5). | `server/internal/review/review.go:36-43`, `server/go.mod:19`, go-fsrs `parameters.go:19-20` |
| A question score maps to an FSRS rating: below 0.5 Again, below 0.7 Hard, else Good, never Easy. | `review.go:76-87` |
| `review_log` stores only the rating (1–4), so partial credit is collapsed to three levels there. | `openwiki/study-progress.md` (Data model) |
| Full part awards live in attempt snapshots and in `review_answers` (correct of total). | `server/migrations/0001_init.sql:482-496`, `0071_review_sessions.sql` |
| Suggestions score items by `(1 - R) × (1 + tricky + learned)`. History covers the last 8 ratings, weighted 0.9^k, with priors of 2 misses and 0.75 known. They are grouped by chapter, Others or workspace. | `review.go:143-204`, `openwiki/study-progress.md` (Suggested reviews) |
| Manual sessions mix 60% new items with 40% practised items (`withNew`). | `openwiki/study-progress.md` |
| Review group kinds: chapter, others, workspace, plan. | `server/migrations/0119_plan_reviews_file_steps.sql:5-7` |
| The agent's `read_study_progress` returns tracked items, recent attempts and the three chapters with the lowest mean R. | `openwiki/study-progress.md` (Chat agent), `server/internal/store/study.go:900` |
| `add_questions` takes question, options/correct, accepted, marks/markscheme, explanation and hints, plus `chapter_id` and `excerpt_ids`. There is no topic or difficulty field. | `pipeline/pipeline/generated/agent_tools.json`, `pipeline/pipeline/retrieval/questions.py:62-122` |
| The question type has an optional `level` (recall, application, analysis), but the agent never sends it. | `src/features/questions/types.ts:15,214`; `questions.py` `SERVER_FILLED` |
| The bank is a fixed tree: exams → subjects → topics, each question with one `topic_id`. | `server/bankmigrations/0001_init.sql` |
| Bank progress keeps the latest score per question only. | `server/migrations/0056_bank_progress.sql` |
| Owners and editors already see a workspace aggregate (attempt count, mean %). | `server/internal/store/queries.go:303-320` (`WorkspaceStats`) |
| Progress and review state are private to their user. | `openwiki/study-progress.md` (Authorization) |
| Jev on open parts: 435 of 464 item labels (93.8%) and 154 of 176 part scores matched exactly; 167 of 176 were within half a mark. The labels are AI-made, not human-certified. | `bench/grading/reports/2026-10-02-jev-production-contract.md` |
| Pilot bank: 32 questions with 68 parts (36 mcq, 28 short, 2 boolean, 1 gaps, 1 matching). `level` is unset on 30. Questions have 1 to 11 parts. | `/Users/sam/web/capy-notebook/data/question-bank/round2-2026-10-03/*/questions/*.json` |
| Pilot "answers" are blind AI solves only: 32 of 32 agreed, mean part score 1.0. | `.../round2-2026-10-03/*/compare.json` |
| Canvas mode is on hold; study and member performance tracking come first. | `todo-canvas-workspace.md:5` |

**Consequence.** Every graded part already reaches the server with `awarded` and `marks` (`questions.Graded`), so a skill model needs no new grading, only a log and a model. Open parts are Jev-graded; closed parts are graded exactly.

---

## 2. Q1: Learner models compared

### 2.1 How each works, briefly

1. **Percent correct per tag, recency-weighted.**
   - Canvas Outcomes offers latest, highest, average, n-mastery and decaying average. The default decaying average weights the latest score 65% and the rest 35% ([Canvas developer docs](https://developerdocs.instructure.com/services/canvas/file.all_resources/outcomes); the 65/35 default comes from Canvas community guides via search).
   - Capy's own `HistoryWeights` is a per-item version with priors.
2. **Elo and Glicko.**
   - Each answer is a "match" between learner and item, so one update moves the learner's skill and the item's difficulty ([Pelánek 2016, Computers & Education](https://www.fi.muni.cz/~xpelanek/publications/CAE-elo.pdf); [MU record](https://muni.cz/en/research/publications/1376317)).
   - Math Garden runs an Elo-type rating per game, with a scoring rule that combines accuracy and response time ([Brinkhuis et al. 2018, JLA](https://files.eric.ed.gov/fulltext/EJ1187391.pdf); [Klinkenberg et al. 2011](https://doi.org/10.1016/j.compedu.2011.02.003)).
   - Lichess rates puzzles with Glicko-2, "the same rating system as games": each attempt is a game between player and puzzle ([Lichess forum quoting its blog](https://lichess.org/forum/general-chess-discussion/puzzle-rating-question)). A community blog says a puzzle's rating settles after about 20–30 attempts (unverified, user blog).
   - Glicko adds a rating deviation that grows with time away ([glicko.net](http://www.glicko.net/glicko/glicko2.pdf); details from memory, unverified).
   - Pelánek's education variant replaces Elo's fixed K with an "uncertainty function" that shrinks as answers accumulate (form from memory, unverified).
3. **IRT: Rasch and 2PL.**
   - Rasch: `P = σ(θ − b)`. 2PL adds a discrimination per item.
   - For Rasch calibration, Linacre's table puts 30 examinees per item at ±1 logit with 95% confidence (16–36 by targeting), 100 at ±½ logit, and 250 for high stakes ([Linacre 1994, RMT 7:4](https://www.rasch.org/rmt/rmt74m.htm)).
   - 2PL usually needs hundreds. 500 is the common rule (it comes from graded-response studies), and one dissertation found 250 workable (search summary of [Jiang et al. 2016](https://www.frontiersin.org/journals/psychology/articles/10.3389/fpsyg.2016.00109/pdf) and others; unverified for 2PL specifically).
   - Partial credit has its own model, the Partial Credit Model, with a step parameter per mark (Masters 1982, [doi](https://doi.org/10.1007/BF02296272); from memory).
4. **BKT and PFA.**
   - BKT is a two-state hidden Markov model per skill, with prior, learn, guess and slip (forget usually 0).
   - It is fitted by EM and has an identifiability problem: different parameter sets fit the same data equally well, and fits can degenerate (guess above 1 − slip). Common practice bounds guess and slip to [0, 0.5] ([Beck & Chang 2007 as cited in JEDM](https://jedm.educationaldatamining.org/index.php/JEDM/article/download/35/pdf_27); [Baker et al.](https://learninganalytics.upenn.edu/ryanbaker/paper_143.pdf)).
   - The 0.95 mastery threshold of the Cognitive Tutors is a convention (unverified).
   - PFA (Pavlik, Cen & Koedinger 2009) recasts Learning Factors Analysis as a per-student, per-skill logistic model that can choose practice ([ERIC ED506305](https://eric.ed.gov/?id=ED506305)). Its form, from memory (unverified): `logit P = β_skill + γ·successes + ρ·failures`, summed over the item's skills.
5. **Deep knowledge tracing.**
   - DKT models knowledge with RNNs that "do not require the explicit encoding" of domain knowledge ([Piech et al. 2015](https://arxiv.org/abs/1506.05908)).
   - SAKT attends over the few relevant past answers, motivated by sparse data, and reports +4.43% AUC ([Pandey & Karypis 2019](https://arxiv.org/abs/1907.06837)).
   - Across nine datasets, logistic regression with the right features leads at moderate size, DKT leads on large data, and BKT lags ([Gervet et al. 2020](https://jedm.educationaldatamining.org/index.php/JEDM/article/view/451)).
   - The pyKT benchmark finds most successors add "minimal" improvement over DKT, and wrong evaluation settings leak labels ([Liu et al. 2022](https://arxiv.org/abs/2206.11460)).
6. **Knowledge space theory (ALEKS).**
   - A knowledge state is a feasible set of concepts. Algebra 1 has about 350 concepts and "millions" of states, and the assessment estimates a state in about 25–30 questions ([ALEKS](https://www.aleks.com/about_aleks/knowledge_space_theory)).
   - The outer fringe is what the student is "ready to learn" ([Wikipedia: Knowledge space](https://en.wikipedia.org/wiki/Knowledge_space)).
7. **Math Academy (knowledge graph + FIRe).**
   - It keeps a hand-built prerequisite graph plus a separate "encompassing" graph ([Skycak, FIRe](https://www.justinmath.com/individualized-spaced-repetition-in-hierarchical-knowledge-structures/)).
   - Passing an advanced topic sends fractional review credit down to the topics it encompasses, while failures penalise upward only.
   - Each student–topic pair has a "learning speed" (ability over difficulty) that scales credit. Courses run to 300+ topics.
8. **Khan Academy mastery levels.**
   - In an exercise, under 70% correct is Attempted, 70–99% Familiar and 100% Proficient. Mixed-skill assessments move a skill up to Mastered or down a level ([Khan help](https://support.khanacademy.org/hc/en-us/articles/5548760867853--How-do-Khan-Academy-s-Mastery-levels-work)).
   - Course mastery % is the share of skills at Proficient or above ([Khan help](https://support.khanacademy.org/hc/en-us/articles/115002552631-What-are-Course-and-Unit-Mastery)).
9. **IXL SmartScore.**
   - It runs 0–100 and is "not a percentage". 80 means proficiency, 90 starts the Challenge Zone (smaller gains, larger drops) and 100 means mastery. Questions get harder after correct answers and easier after misses ([IXL blog](https://blog.ixl.com/2020/11/11/ixl-smartscore-the-key-to-mastery-based-learning/)).
   - Mastery can take "as many as 10" correct in a row ([SmartScore guide](https://www.ixl.com/materials/SmartScore_Guide.pdf), via a search snippet).
10. **Duolingo Birdbrain and half-life regression.**
    - Birdbrain V1 is logistic regression "inspired by item response theory" ([IEEE Spectrum](https://spectrum.ieee.org/duolingo)):
      - an exercise's difficulty is the sum of its features (type, words);
      - it takes one SGD step per exercise, generalising Elo;
      - it updated daily.
    - V2 (an LSTM) holds a 40-dimensional learner state and updates within minutes. V1 was retired in May 2022. Duolingo serves about 1 billion exercises a day.
    - Half-life regression models each word's memory half-life from practice counts; the released data has about 13M traces ([Settles & Meeder 2016](https://aclanthology.org/P16-1174/); [repo](https://github.com/duolingo/halflife-regression)). Its form `p = 2^(−Δ/h)`, `h = 2^(Θ·x)` is from memory (unverified).
11. **FSRS** models the memory of one item: difficulty, stability (the interval at which R is 90%) and retrievability ([FSRS wiki](https://github.com/open-spaced-repetition/awesome-fsrs/wiki/The-Algorithm)). It says nothing about a new item on the same topic.

### 2.2 Comparison

| Model | Data needs | Cold start, small classes | Partial credit, noisy grades | Explainability | Cost in Capy | Fits Capy? |
|---|---|---|---|---|---|---|
| % correct per tag, recency-weighted | Responses + tags | Undefined at 0 answers; extreme after 1 unless a Beta prior is added. Needs no other members. | Natural (Σawarded/Σmarks); averages noise, no item model | Best ("6 of 10 recently") | Trivial | **As a lens, yes. As skill, no**: item difficulty and adaptive selection confound it (§5.7). |
| Elo / Glicko | Online stream | Works from answer 1. Uncertainty-aware step sizes; item ratings stay noisy with few attempts (Lichess: ~20–30 to settle, unverified). | Fractional outcomes are native (chess draws = 0.5); down-weight unreliable grades | Medium: translate to "expected % on a typical question" | Low | **Yes**, as the update rule |
| Rasch (1PL) | ~30 per item for ±1 logit (Linacre) | Needs priors at Capy's size; with priors, fine | Fractional (quasi-binomial) outcome, or the PCM with too many steps for small data; weights for noise | Medium (one scale for learners and items) | Medium as a batch fit; low as online | **Yes, with priors**: it is the model the Elo-style update approximates |
| 2PL | Hundreds per item | Infeasible | Same as Rasch | Lower (discrimination) | Medium | No |
| BKT | Many students per skill to fit 4 params; identifiability issues | Defaults possible but arbitrary; no item difficulty | Binary by design; partial-credit variants exist (unverified) | High ("probability known") | Medium | No: lags in benchmarks and ignores item difficulty |
| PFA | Fitted γ, ρ per skill | Pool γ, ρ across skills; fine once data exists | Fractional counts possible | Medium-high | Low-medium | **Later alternative** (PFA-lite with shared γ, ρ) |
| DKT, SAKT and successors | Large logs | New items per workspace are cold; can't explain | Possible but opaque | Low | High (training, serving) | No |
| Knowledge spaces (ALEKS) | Expert-built structure (~350 concepts per course) | Assessment-driven; structure is the cost | Probabilistic variants handle careless errors (unverified) | High ("ready to learn") | Very high for user files | No; borrow "ready to learn" later |
| Math Academy FIRe | Hand-built prerequisite and encompassing graphs, 300+ topics | Diagnostic, 30–45 min | Credit scaled by work quality | Medium | Very high | No; the encompassing idea is for later |
| Khan levels | Authored skills, homogeneous item pools | Fine | Binary rules | High | Low | Borrow the display (levels that can drop), not the rules |
| IXL SmartScore | Authored, calibrated generators per skill | Fine | None | High score, opaque rule | Low | Borrow the display and the recommendation types |
| Birdbrain V1 / HLR | Huge logs to fit feature weights | Feature-based difficulty is a strong cold start | Binary | Medium | Low to run, needs data to fit | **Borrow the feature-based item difficulty prior** |
| FSRS | Per-item review history | Defaults work | Rating 1–4 | Medium (R as "chance you recall it") | Exists | **Keep for memory**, not skill |

### 2.3 Which fit Capy's small, uncalibrated, AI-generated setting

- **Fit:**
  - Rasch with priors, updated online in Elo/Glicko style.
  - Feature-based item difficulty priors (Birdbrain V1's idea).
  - FSRS for memory.
  - Percent correct as a coverage and raw-score lens.
  - PFA-lite as a challenger once Capy has data.
- **Don't fit:**
  - 2PL, BKT fitted per skill and deep KT (data);
  - knowledge spaces and FIRe (hand-built structures);
  - Khan and IXL rules (they assume authored, homogeneous item pools).
- **Why logistic and not percent:**
  - Capy's items vary in difficulty: AI recall MCQs sit beside multi-part open questions, and bank questions beside both.
  - Follow-up will pick items by predicted difficulty, so only a model that knows each item's difficulty can compare members fairly.
  - This is the reason Duolingo, Math Garden and Lichess all pair learners and items on one scale.

---

## 3. Q2: Topics without chapters

### 3.1 How platforms decide what a topic is

- **Curriculum standards, authored by the platform:**
  - Wayground supports about 55 US frameworks (Common Core, NGSS, IB, WIDA) and five Brazilian ones. Teachers tag questions by hand, and reports then show each student's performance per standard ([Wayground: tag standards](https://help.wayground.com/support/solutions/articles/158000405013-tag-state-standards-to-questions)).
  - 1EdTech CASE gives each standard a GUID so platforms can align content to it, and several states publish their standards in CASE ([1EdTech CASE](https://www.1edtech.org/standards/case)).
  - Khan, IXL, Sparx (objectives at a set difficulty), ALEKS (about 350 concepts for Algebra 1) and Math Academy (300+ topics) all author their own taxonomies, and items are tagged when they are written (sources in §2.1 and §4.1).
- **Teacher tags:**
  - Wayground's manual standards tags.
  - Canvas Outcomes, which institutions and teachers create and align to assessments ([Canvas docs](https://developerdocs.instructure.com/services/canvas/file.all_resources/outcomes)).
- **AI tagging, then merging:**
  - Wayground's "Enhance with AI" auto-tags standards, and the teacher reviews before saving ([Wayground](https://help.wayground.com/support/solutions/articles/158000405099-enhance-questions-with-wayground-ai)).
  - Research findings:
    - GPT-4's generated knowledge components (KCs) matched human ones for about 56% of chemistry and 35% of e-learning MCQs. Where they disagreed, experts preferred the LLM's KCs about two-thirds of the time. Clustering grouped questions by KC from content alone ([Moore et al. 2024](https://arxiv.org/abs/2405.20526)).
    - A follow-up on 646 MCQs found the first LLM KC model over-split: 569 KCs against the experts' 101, and slightly worse fit (RMSE 0.4285 vs 0.4206). Merging KCs at cosine ≥ 0.8 cut it to 428, with RMSE 0.4259 ([Wang, Lin & Koedinger 2025](https://arxiv.org/abs/2511.09935)).
    - On fine-grained standards, language models "struggle to tag and verify" and land close but subtly wrong ([MathFish, Lucy et al. 2024](https://arxiv.org/abs/2408.04226)).
- **Capy's bank:**
  - A curated three-level tree with one topic per question (`server/bankmigrations/0001_init.sql`).
  - The pilot holds 32 questions in 5 topics, about 6 per topic.
- **Pattern:**
  - Skill units are authored or curated. Where AI proposes them, it over-splits, so platforms reuse existing units, merge near-duplicates and let a human edit.
  - The experts' ratio above was about 6 questions per KC.

### 3.2 Proposal for Capy

- **What a topic is:**
  - A workspace-local unit a learner would name on a revision checklist ("Circle theorems", "Osmosis"). Not a single step ("angle in a semicircle"), not a subject ("Geometry").
  - Topics are independent of folders: a topic spans quizzes in many folders, and a folder can hold many topics. This matches Epo's rule that folders only organise.
- **Shape:**
  - A flat list per workspace (label ≤ 60 characters, a one-sentence description the tagger reads, a position), plus an "Unsorted" bucket for untagged questions.
  - No hierarchy in v1. A bank-backed workspace may mirror the bank's subject level later.
- **How many:**
  - Aim for 5–20 per workspace and cap at 30.
  - A topic should hold at least about 5 questions. A topic with fewer than 3 questions shows coverage but never a skill label.
  - Rationale: the experts' ratio of about 6 questions per KC; the label evidence in §5.5 (three different questions); and a member grid that stays readable at 360px.
- **One topic per question** (a single-KC Q-matrix): simplest to explain, and it avoids splitting credit with tiny data. Parts inherit it; a per-part topic can come later if bank multi-part questions need it.
- **At generation time (the agent):**
  - The agent sees the workspace's topic list (id, label, description, question count) in its context, beside the folders.
  - `add_questions` gains a `topic` per question: an existing topic id, or `{label, description}` for a new one. An optional `difficulty` (easy, medium, hard) feeds the item prior.
  - The server checks each new label against existing topics. A name match or an embedding cosine ≥ 0.8 (the threshold Wang et al. used) maps to the existing topic, and the result says so.
  - Past the cap, the server answers with the list to choose from, in the refusal style `add_questions` already uses.
  - Cost: none extra, since the agent knows the source passage it wrote from.
- **At extraction time (everything else):** a background tagger covers hand-written questions in the quiz editor, imported questions and older quizzes.
  - It runs debounced after a quiz's content settles.
  - It makes one cheap-model call per quiz with the topic list and the questions' text and keys.
  - It returns a topic id or a proposal, with a confidence. Low confidence goes to Unsorted for the owner.
  - Bank copies map the bank topic to a workspace topic: reuse a near-duplicate, else create one with the bank's label and keep `bank_topic_id`.
  - A changed `QuestionHash` (prompt text edited) re-tags, unless an owner set the topic.
- **Editable:**
  - Owners and editors (content authority) rename, describe, reorder, merge and delete topics (questions go to Unsorted).
  - They move a question to another topic: a Topic select in the question dialog's settings, and bulk moves on a topic page.
  - AI proposals ("These look the same: merge?", "Fold this 1-question topic into X?") are suggestions only.
  - Every change triggers a skill rebuild for the workspace (§5.3).
- **Flashcards:**
  - Cards are self-rated, not graded, so they stay out of the skill model in v1.
  - Topics on sets, or cards, can come in v2 for the memory lens.
- **Clone:** copies topics and tags, remapped to the new workspace. Skill and item stats are per user and are not copied, like review states.

### 3.3 What to reuse from the bank code

| Bank piece | Reuse |
|---|---|
| `topics(id, subject_id, label, position)` + `questions.topic_id` (`server/bankmigrations/0001_init.sql`) | Shape of `workspace_topics` + `question_topics` (§5.2), with no subject or exam level |
| `bank.TopicProgress`, `summarize`, `Store.Progress`: answered, correct, next question, and "current" meaning the stored hash equals the current one (`server/internal/bank/progress.go:46-166`) | Coverage per topic, same hash rule |
| `bank.PageRows` status filters: correct, wrong, partial, notDone (`server/internal/bank/page.go`) | Filter a topic's questions by the member's results |
| `TopicSummary.tsx`: score, squares, marks by type, "Worth another look" (`MISSED_ROWS = 7`), next topic (`src/features/questions/TopicSummary.tsx:15`) | A workspace topic page, nearly as is |
| `ResultSummary.tsx` (`outcomeOf`, `OUTCOME_FILL`) and `TopicSquares` (`src/routes/QuestionBank.tsx:1512`) | Result squares per question in a topic |
| `searchSyllabus` ranking: exact, prefix, word start, anywhere (`src/features/questions/bankSearch.ts:34`) | The topic picker's search |
| `soleSubject` / `soleTopic`: hide a level with one entry (`src/features/questions/bank.ts`) | Hide topic UI when a workspace has one topic |
| `POST /api/bank/copy` (kept on the server, unused) | Offer bank questions on the same topic as follow-up in exam-aligned workspaces (HKDSE, IELTS) |

---

## 4. Q3: What to show

### 4.1 How others do it

- **Labels that describe the next action, not the person:**
  - IXL's five recommendation types are Work It Out ("building block skills to help you tackle your trouble spots"), Keep At It, Go For Gold, Next Up and Try Something New ([IXL recommendation types, PDF](https://www.ixl.com/materials/IXL_Recommendation_Types.pdf)). Its teacher report is called Trouble Spots ([IXL blog via search](https://blog.ixl.com/?p=15171)).
  - Century adds "Focus for Improvement" nuggets and a symbol saying why each was added ([ASE](https://www.ase.org.uk/node/21267); [school guide](https://www.clrchs.co.uk/wp-content/uploads/2021/07/Student-guide-to-Century-Tech.221666414.pdf); secondary sources).
  - Wayground's report talks of standards that "would benefit from additional attention" ([Wayground](https://help.wayground.com/support/solutions/articles/158000461076-how-to-use-a-standards-mastery-report)).
  - Duolingo's Mistakes practice reads "so they won't trip you up next time" ([Duolingo](https://blog.duolingo.com/guide-to-duolingo-practice-hub/)).
  - Khan's levels (Attempted, Familiar, Proficient, Mastered) describe evidence and can drop.
  - Capy already says "Worth another look" (`TopicSummary.tsx`) and Tricky, Fading and Just learned.
- **Research behind it:**
  - Children praised for intelligence persisted less and made more low-ability attributions after failure than those praised for effort ([Mueller & Dweck 1998](https://doi.org/10.1037/0022-3514.75.1.33)).
  - Feedback's effect depends on its type and how it is given ([Hattie & Timperley 2007](https://eric.ed.gov/?id=EJ782448)). Their task, process and self levels, with self-level feedback the weakest, are from memory (unverified).
  - Feedback that draws attention to the self can lower performance ([Kluger & DeNisi 1996](https://doi.org/10.1037/0033-2909.119.2.254); exact figures unverified).
  - Dashboards lean heavily on peer comparison, which fosters competition rather than mastery ([Jivet et al.](https://research.ou.nl/en/publications/awareness-is-not-enough-pitfalls-of-learning-analytics-dashboards/)).
- **Showing confidence:**
  - Open learner models ask explicitly how uncertainty is shown ([Bull & Kay, SMILI](https://research.birmingham.ac.uk/en/publications/smili-a-framework-for-interfaces-to-learning-data-in-open-learner/)).
  - Skill meters that show the student's confidence beside the system's estimate improved knowledge monitoring and performance, most for low achievers ([Al-Shanfari et al. 2020](https://link.springer.com/article/10.1007/s11257-019-09253-4)).
  - Glicko shows a rating with a deviation that grows when inactive.
- **How much evidence platforms wait for:**
  - Sparx needs about 100 questions (4–5 weeks) for an accurate homework level ([Sparx](https://support.sparxmaths.com/en/articles/342349-key-concepts-of-a-sparx-maths-homework)).
  - IXL mastery can take up to 10 correct in a row.
  - Linacre: 30 answers for ±1 logit.
  - Khan reads a whole exercise (70%, 100%) before moving a level.

### 4.2 Four lenses, kept apart

| Lens | What | Source in Capy | Member wording (proposal) |
|---|---|---|---|
| Memory | Items likely forgotten | FSRS R per practised item; per topic the count at R ≤ 0.9 and Σ(1 − R) | "3 questions are fading. A quick review keeps them." |
| Skill | Expected success on a typical question of the topic, with confidence | The model in §5.1 | A label (below), with "based on 7 answers to 5 questions" |
| Coverage | What was attempted | Distinct current questions answered of the topic's current questions | "Answered 12 of 20" · "Not started" |
| Effort | Activity | Answers, active days, minutes (`attempts.started_at` to the last check), sessions | "This week: 34 answers on 3 days" |

- **Skill labels (proposal):** Not started · Too early to tell · Focus next · Getting there · Strong.
  - Never "weak", "failing" or a rank among classmates.
  - Every label sits next to a single action: Practise, Review fading, Start.
- **Memory and skill stay separate.** A topic can read "Strong · 5 fading". Skill does not decay with time; its uncertainty grows (§5.1), while FSRS carries forgetting.

### 4.3 How much evidence, and how to show confidence

**Proposed rules** (posterior from §5.1, with the prior centred on 70% typical success; constants need sign-off):

- **Too early to tell:** fewer than 3 different questions answered in the topic.
- **Focus next:** P(m < 0.6) ≥ 0.8 and at least 3 different questions. Leave it only when P(m < 0.6) falls below 0.5 (hysteresis, so labels don't flicker).
- **Strong:** P(m > 0.7) ≥ 0.8 and at least 3 different questions.
- **Getting there:** everything else.

**Which answer patterns cross the rules** (items of typical difficulty; computed by `evidence3.py`):

| Question kind | Focus next at most | Strong at least |
|---|---|---|
| Open or short answer (no guessing) | 0/3, 1/4, 1/5, 2/6, 2/7, 3/8, 3/9, 4/10 | 3/3, 4/4, 5/5, 6/6, 6/7, 7/8, 8/9, 9/10 |
| 4-option MCQ (guess floor 0.25) | 0/3, 1/4, 1/5, 2/6, 3/7, 3/8, 4/9, 5/10 | 5/5, 6/6, 7/7, 8/8, 9/9, 9/10 |
| True/false (floor 0.5) | 0/3, 1/4, 2/5, 3/6, 3/7, 4/8, 5/9, 6/10 | 8/8, 9/9, 10/10 |

- **What the rules mean:**
  - One miss never labels a topic. Three misses on three different questions do.
  - Topics made only of MCQs need five straight right answers to count as Strong, and true/false almost never gets there.
  - This argues for mixing question kinds in generated practice.
- **Showing confidence:**
  - **Members:** words, not numbers, while evidence is thin ("Early estimate · 3 answers"). Show no percentage until the label is firm. Then show "about 6 in 10 on typical questions", rounded. Show the evidence count and the last practice date.
  - **Owners:** a bar from the 10th to the 90th percentile of m per cell, and hatched cells for Too early to tell.
  - **Both:** the questions behind an estimate are one click away (IXL's Trouble Spots shows the exact questions missed).

### 4.4 Owners versus members

- **Members:**
  - Their own topics with the four lenses and one Focus next card.
  - No classmates' data. Any social layer uses shared goals, as in the canvas plan §4.4, not leagues.
- **Owners** (once Epo decides visibility, §7):
  - **Class grid:** members × topics, with labels and confidence. Phones show a topic list with "4 of 9 members: Focus next" that expands to the members.
  - **Topic order:** by how many members need it, as IXL orders Trouble Spots.
  - **Per-question item analysis:** facility, answers, and "check this question" flags. Flag when at least 4 first answers average below 0.25 and members who do well elsewhere miss it (a negative correlation with ability). Wayground's report has item analysis too. For AI-generated questions this mostly catches wrong keys.
  - **Per member:** labels, recent attempts, activity.
  - **Actions:** "Make a follow-up quiz for the class" and "Suggest practice to Sam" (§6).
- **Precedent in Capy:** owners and editors already see an aggregate (`WorkspaceStats`), and the canvas plan's presence research says "peers see standing, the host sees answers" (`todo-canvas-workspace.md:281`).
- **Link and public visitors** record progress today. They should never appear in an owner's view; only members do.

---

## 5. Q5: Recommended design

### 5.1 The model and its formulas

**Notation:** member u, topic t, question i with parts j.

**Prediction for a part:**

    η = a_u + d_ut − b_i
    π = σ(η)
    P = c_i + (1 − c_i) · π

- `a_u` is the member's ability across the workspace (logits).
- `d_ut` is the member's deviation on topic t.
- `b_i` is the question's difficulty, pooled across every member who answered it.
- `c_i` is a fixed guessing floor:
  - 1/k for an MCQ with exactly one correct option of k;
  - 0.5 for true/false;
  - 0 for everything else, including multi-correct MCQs that need the exact set.

**Priors** (Gaussian, independent):

- `a_u ~ N(μ_a, 1.0²)`, where μ_a is the platform's typical first-attempt success on a logit scale. Use logit 0.7 until data exists.
- `d_ut ~ N(0, 0.7²)`. A new topic starts at the member's own level, the hierarchical cold start.
- `b_i ~ N(b0(features_i), 1.0²)`:
  - `b0` sums feature effects: answer type, `level`, the generator's `difficulty`, marks. This is Birdbrain V1's idea.
  - All effects start at 0 and are fitted platform-wide once a few thousand first answers exist.
  - Bank questions take the bank-wide estimate, per environment.
  - A variant starts at its parent's estimate with variance +0.5², because generated variants vary in difficulty ([BMC Med Educ 2023](https://doi.org/10.1186/s12909-023-04457-0)).

**Observation per graded part:**

- **Outcome:** `s = awarded / marks` in [0, 1]. Partial credit enters directly, as a fractional (quasi-binomial) outcome.
- **Weight:** `w = r_grade × r_repeat × r_parts`:
  - `r_grade`: 1 for exact grading, 0.8 for a Jev-graded open part (Jev matched 87.5% of part scores), 1 once an owner confirms or regrades, 0 while the member has reported the question.
  - `r_repeat`: 1 for the member's first answer to the question; 0.5 for a repeat at least one day after the previous answer; 0 for a repeat within a day of seeing the key (that is memory of this item, FSRS's job). A variant answered in the same session as its parent's revealed key also gets 0.5.
  - `r_parts = min(1, 3 / n_parts)`: one question contributes at most 3 units, so an 11-part IELTS passage doesn't swamp a topic (a testlet effect).
- **Excluded:** a wholly blank question, following the existing rule (`questions.Blank`). An optional explicit "I don't know" counts as s = 0, w = 1 (Math Garden's question-mark button; [Brinkhuis et al.](https://files.eric.ed.gov/fulltext/EJ1187391.pdf)).

**Online update per observation** (a one-step Laplace/Kalman update; Glicko and TrueSkill do the same thing in spirit):

    g = w (s − P) (1 − c) π (1 − π) / (P (1 − P))          (c = 0: g = w (s − π))
    h = w ((1 − c) π (1 − π))² / (P (1 − P))               (c = 0: h = w π (1 − π))
    V = v_a + v_d + v_b
    a ← a + v_a g / (1 + hV)     v_a ← v_a − v_a² h / (1 + hV)
    d ← d + v_d g / (1 + hV)     v_d ← v_d − v_d² h / (1 + hV)
    b ← b − v_b g / (1 + hV)     v_b ← v_b − v_b² h / (1 + hV)

- **Drift:** before each update, `v_a` and `v_d` grow by `q · days since their last update`, with q = 0.01 logit² per day, capped at the prior variance. Old evidence counts for less without any explicit window. Item difficulty does not drift.
- **Covariance:** the update drops the covariance it creates. That overstates the uncertainty of a + d, which is conservative: fewer labels.
- **Accuracy:** against the exact posterior on four sample histories, the update was within 0.2 logit in mean and 0.1 in SD (`kalman_check.py`; appendix B).

**Shown quantities:**

    m_ut  ≈ σ( (μ_a + μ_d − b̃_t) / sqrt(1 + π (v_a + v_d) / 8) )     expected success on a typical question
    P(m_ut < T) = Φ( (logit T + b̃_t − μ_a − μ_d) / sqrt(v_a + v_d) )

- `b̃_t` is the median difficulty of the topic's current questions.
- **Owners' class view:** the mean of m over members with a label, and the count per label.
- **Strength relative to oneself:** `μ_d / sqrt(v_d)`, for "your best topics" lists.

**Choices and their alternatives:**

- **Online update over a nightly batch fit.**
  - It updates in the answer's own transaction.
  - It handles cold start through the variances.
  - A replay of the log gives the same result, which makes it deterministic.
  - A batch MAP fit is the offline check (§5.6).
- **Fixed guessing floors over a 3PL guessing parameter.** There are no answers to fit one with.
- **No mean decay of skill.** Forgetting is shown through FSRS, so "Strong · 5 fading" stays honest.

### 5.2 Tables

All tables are per environment, in the app database.

| Table | Columns | Notes |
|---|---|---|
| `workspace_topics` | id, workspace_id, label (≤ 60), description (≤ 200), position, bank_topic_id NULL, created_by (`agent`, `tagger`, `user`), created_at, updated_at | Unique (workspace_id, lower(label)); cap 30; cascades with the workspace |
| `question_topics` | material_id, item_id, topic_id NULL, source (`generated`, `tagged`, `owner`, `bank`), confidence NULL, item_hash, tagged_at | PK (material_id, item_id); topic SET NULL on topic delete (Unsorted); cascades with the material. A side table, so the question format, its three validators and the live quiz rooms don't change, and tagging never writes the Yjs document. |
| `answer_events` | id, user_id, workspace_id NULL, material_id NULL, item_id, bank_question_id NULL, item_hash, origin (`quiz`, `review`, `practice`, `test`, `bank`), parts jsonb `[{id, type, awarded, marks}]`, key_seen_before bool, answered_at, regraded_at NULL, excluded bool | Append-only, one row per checked question, written beside `review_log` in the existing transactions (quiz check, review check, bank check). It keeps partial credit, which `review_log` drops. It is the source of truth for skills and for evaluation. Purge rules follow `review_log`. |
| `member_abilities` | user_id, workspace_id, mean, var, last_at | `a_u` |
| `skill_states` | user_id, workspace_id, topic_id, mean, var, questions, answers, last_at, label | `d_ut` and the stored label (for hysteresis); PK (user, workspace, topic) |
| `item_stats` | material_id, item_id, item_hash, b_mean, b_var, guess, answers, first_answers | A hash change starts a new item at the prior |
| `bank_item_stats` | question_id, item_hash, b_mean, b_var, answers | Bank difficulty pooled across all bank learners in this environment |
| `question_origins` | material_id, item_id, variant_of_material_id, variant_of_item_id, generated_for_user_id, run_id, created_at | Variants and practice provenance, for exposure and leakage rules |
| practice quiz | `materials.practice_for_user_id` NULL | One hidden quiz per member per workspace holding their AI practice (§6.3). Needs authorization rules. |
| results visibility | e.g. `workspaces.results_sharing` (`private`, `owner_summary`, `owner_full`) plus a member notice or acknowledgement | Epo's decision (§7) |

- **Topics replace chapters in reviews:** `review_sessions` gains the group kind `topic` (with the topic ids) beside chapter, others, workspace and plan.
- **The agent:** `read_study_progress` returns topics (label, lenses, recent misses by question id) instead of "three chapters with the lowest mean R".

### 5.3 When it updates

1. **On every graded answer** (quiz check, review check, practice check, bank check): insert the `answer_event`, then update `item_stats`, `member_abilities` and `skill_states` for the question's topic, in the same transaction and under the rating lock the check already takes. That is two or three small upserts.
2. **Rebuild** a workspace by replaying its `answer_events` in time order through the same update. It is queued, coalesced per workspace and debounced about 1 minute. It runs when:
   - a topic is merged, deleted or retagged;
   - a question's hash changes (a new item);
   - an owner regrades or a report is resolved;
   - the model's constants change (a version number).
   - At ≤ 50 members and ~10⁵ events this takes milliseconds to seconds.
3. **Reads** take labels and m from `skill_states` and need no document parse. FSRS is unchanged.
4. **No nightly job is needed.** The bank-wide `b0` feature effects are refitted by hand from the log when enough data exists.

### 5.4 What owners see and what members see

See §4.4. Members get their own four lenses and Focus next. Owners get the class grid, topics ordered by need, item analysis, per-member drill-down and follow-up actions, once visibility is decided.

### 5.5 Evidence rules and constants for sign-off

AGENTS.md asks for no defaults without a human sign-off. Every constant is listed here.

| Constant | Proposal | Why |
|---|---|---|
| Typical success prior μ_a | logit 0.7 | AI questions from one's own files; refit from data |
| SD of a, d, b priors | 1.0, 0.7, 1.0 | Usual logit scales; d smaller so a topic starts near the member |
| Drift q | 0.01 logit² per day | SD of a settled estimate (0.3) grows to about 0.83 after 60 days |
| Guess floors | 1/k single-correct MCQ, 0.5 true/false, else 0 | Chance of a blind guess |
| Jev weight | 0.8 | Jev part-score exact agreement 87.5% |
| Repeat weights | 1 first, 0.5 spaced (≥ 1 day), 0 same day after the key | Repeats measure memory of the item |
| Parts cap | 3 units per question | Testlet dependence |
| Labels | Too early (< 3 questions); Focus next P(m < 0.6) ≥ 0.8, leave below 0.5; Strong P(m > 0.7) ≥ 0.8 | §4.3 table |
| Topic counts | 5–20, cap 30, ≥ 3 questions for a label | §3.2 |
| Practice target | 0.75 predicted success | §6.1 |

### 5.6 Offline evaluation

- **The pilot cannot be used.** It has no learner answers: only AI blind solves, all at full marks.
- **Order of work:**
  1. **Log first.** Ship `answer_events` (and `item_stats`) before any UI, on UAT, so real data accrues.
  2. **Simulator** in `bench/learner-model/` (scripts, fixtures, reports, as `bench/README.md` lays out). It generates classes of 5–50 members with 5–20 topics and 50–300 items, and includes:
     - learning and forgetting;
     - guessing on MCQs;
     - partial credit;
     - Jev noise at its measured rates;
     - 10–20% mis-tagged questions;
     - adaptive selection.
     It compares raw %, a recency Beta, this model online, a batch MAP Rasch and PFA-lite. `sim.py` here is a seed.
  3. **Public data cut to classroom size:** ASSISTments, Junyi or EdNet, subsampled to ≤ 50 students and ≤ 10 answers per item. Use a temporal split (predict each answer from earlier ones only), the leakage-safe setting pyKT warns about.
  4. **Real data, once it exists:** monthly reports, refits of `b0` and the priors, and an A/B test of the practice target (0.75 against 0.85) measured on later unseen variants, not engagement.
- **Metrics:**
  - log loss and RMSE on fractional outcomes; AUC on binarised outcomes;
  - calibration error;
  - precision of Focus next at fixed recall (a false weakness is the costly error);
  - label flip rate per week.
- **Pass bar (proposal):** the model beats raw % on log loss and Focus precision, with calibration error under 0.05.

### 5.7 Synthetic check (seed of §5.6)

- **Setup:** 30 synthetic classes, each with 20 members, 8 topics and 40 items per topic.
  - True abilities N(0, 1), topic deviations N(0, 0.7²), difficulties N(0, 1).
  - 30% of items are LLM-graded, with 12% of outcomes flipped and weight 0.8.
- **Result** (raw % uses a Beta prior at 70%; "Focus" means truth below 60%):

| Scenario | Rank correlation with true skill (raw / model) | Focus precision / recall, raw | Focus precision / recall, model |
|---|---|---|---|
| 10 shared quiz items per topic | 0.80 / 0.86 | 0.88 / 0.81 | 0.86 / 0.91 |
| 4 shared + 6 adaptive items (closest to 75% predicted) | 0.77 / 0.86 | 0.91 / 0.71 | 0.84 / 0.92 |

- **Under adaptive practice, raw % misses weak topics:** recall falls to 0.71, because weaker members get easier items and drift towards 75%. The model holds at 0.92.
- **Labelling by probability (§4.3)** rather than by point estimate should raise the model's precision; that is not tested here.
- **Caveat:** the data come from the model's own family, so this shows the mechanism, not real-world accuracy.

---

## 6. Q4: Personalised follow-up

### 6.1 How others choose and generate the next practice

- **Khanmigo:**
  - "Recommend Assignments" suggests what Khan content students should do next from their data, and the teacher assigns it.
  - "Class Snapshot" summarises 7 days of learning time, completion and mastery ([Khan help](https://support.khanacademy.org/hc/en-us/articles/14799047733645-What-teacher-tools-are-available-on-Khanmigo)).
  - A guide notes generated content sometimes introduces inaccuracies, so teachers should review it ([OER Project guide](https://www.oerproject.com/OER-Materials/OER-Media/PDFs/Teacher-Resources/OER-Project-Khanmigo-Guide), via search).
  - Outside Khanmigo, Khan's mixed-skill assessments move levels up or down.
- **IXL:**
  - The Recommendations wall refreshes every time a student practises and holds the five types above.
  - Within a skill, questions get harder after correct answers and easier after misses ([IXL blog](https://blog.ixl.com/2020/11/11/ixl-smartscore-the-key-to-mastery-based-learning/)).
- **Sparx Maths** ([Sparx](https://support.sparxmaths.com/en/articles/342349-key-concepts-of-a-sparx-maths-homework)):
  - Compulsory homework is about 60% new topics and 40% consolidation of topics from about 3 and 10 weeks earlier, unmastered first, with mixed-topic questions.
  - Objectives come at Introduce, Strengthen and Deepen levels, matched to a level learned over about 100 questions. Teachers set the starting level and can override it.
  - After 15 seconds of a support video a student may swap up to three questions. Struggling students are flagged to the teacher.
  - Compulsory work is complete only when every question is right.
- **Century** (school guides and ASE, secondary):
  - Diagnostic nuggets give no feedback.
  - The AI then adds "Focus for Improvement" and "Memory Boost" nuggets beside teacher-set ones.
  - The path updates after each nugget, and a symbol shows why a nugget is there.
- **Wayground:**
  - In Mastery Peak, missed questions come back after a delay until the teacher's accuracy goal is reached. Reports show results with or without repeats ([Wayground](https://help.wayground.com/support/solutions/articles/158000404926-host-an-assessment-quiz-in-mastery-peak-mode)).
  - "Enhance with AI" adds similar questions, simplifies, translates, converts types and auto-tags standards. Teachers "review the changes" before saving and publishing ([Wayground](https://help.wayground.com/support/solutions/articles/158000405099-enhance-questions-with-wayground-ai)).
  - AI quiz versions take a question count and a difficulty ([Edutopia](https://www.edutopia.org/article/supercharge-your-wayground-use/), secondary).
- **Quizlet Learn:** builds a "personalized study path" from the learner's goal and familiarity, "powered by machine learning" ([Quizlet](https://help.quizlet.com/hc/en-us/articles/360030986971)).
- **Math Academy** ([how it works](https://www.mathacademy.com/how-it-works)):
  - The diagnostic places the student at their frontier.
  - Each knowledge point allows up to 5 practice problems and needs two correct in a row.
  - A quiz comes every 150 XP, and missed quiz topics are assigned as reviews at once.
  - FIRe picks reviews whose implicit credit "knocks out" other due reviews.
- **Duolingo:**
  - The Session Generator picks exercises by Birdbrain's predicted success to keep learners "squarely in the zone".
  - Lessons include recently missed material ([IEEE Spectrum](https://spectrum.ieee.org/duolingo)).
  - The Practice Hub's Mistakes set reviews 10 past mistakes ([Duolingo](https://blog.duolingo.com/guide-to-duolingo-practice-hub/)).
- **Math Garden:**
  - Children choose easy (about 90% expected correct), medium (about 75%) or hard (about 60%).
  - Adaptive tests aim near 50% for measurement precision, while practice aims for learning and motivation ([Brinkhuis et al. 2018](https://files.eric.ed.gov/fulltext/EJ1187391.pdf)).

### 6.2 What the research says about each choice

- **Weakest topics first, but not only.**
  - Sparx keeps 40% consolidation, Knowt's exam plan puts the weakest units first (`todo-canvas-workspace/E-study.md`), and IXL keeps "Keep At It" and "Next Up" beside "Work It Out".
  - **For Capy:** about 70% of a session on one or two Focus topics, and 30% elsewhere.
- **Interleaving.**
  - Interleaving helps inductive learning overall (g = 0.42), and maths moderately (g = 0.34). It helps most when categories are similar to each other. For words, blocking won (g = −0.39) ([Brunmair & Richter 2019](https://doi.org/10.1037/bul0000209)).
  - In a 54-class maths RCT, interleaved assignments scored 61% against 38% on an unannounced test a month later (d = 0.83) ([Rohrer et al. 2020, ERIC EJ1237752](https://eric.ed.gov/?id=EJ1237752)).
  - **For Capy:** interleave a Focus topic with a similar topic; block vocabulary-style flashcards more.
- **Target success rate.**
  - The 85% rule is a theorem for gradient-descent learners on binary classification: the optimal error is about 15.87% ([Wilson et al. 2019](https://doi.org/10.1038/s41467-019-12552-4)).
  - Human evidence varies. Math Garden offers 60, 75 and 90%. FSRS targets 0.9 recall for memory. For spaced practice, the efficient difficulty "differed markedly from prior recommendations", with up to 40% more recalled ([Eglington & Pavlik 2020](https://doi.org/10.31234/osf.io/kaxds)).
  - **For Capy:**
    - aim for 0.75 predicted success on Focus practice;
    - aim for 0.85–0.9 on reviews of strengths;
    - allow at most 20% stretch items below 0.6, labelled "challenge";
    - test the target in an A/B test (§5.6).
- **Old items and new variants.**
  - Old missed items train recall of that item (FSRS). New variants test transfer.
  - Sparx's 60/40 split and Capy's own `withNew` 60/40 both mix the two.
  - **For Capy:** in Focus topics, half practised items (FSRS score) and half unattempted or variant items near target.
- **Avoiding answer leakage.**
  - Variants built from templates still differ in difficulty ([BMC Med Educ 2023](https://doi.org/10.1186/s12909-023-04457-0)). LLM item banks can be checked with simulated students for difficulty spread ([arXiv 2602.05114](https://arxiv.org/abs/2602.05114)).
  - Expert review of LLM-made TIMSS items found unjustified or repeated distractors, items with no correct answer and items with several ([IEA report](https://www.iea.nl/sites/default/files/2025-10/Muszy%C5%84ski%20AIG%20LLM%20Report.pdf)).
  - Rule-based item-writing-flaw checks beat GPT-4 at finding flaws ([Moore et al. 2023](https://arxiv.org/abs/2307.08161)).
  - Capy's bank pipeline already blind-solves every question (`lab/questions`, `openwiki/question-bank.md`).
- **Teacher approval.**
  - Wayground requires review before publishing.
  - Khanmigo recommends and the teacher assigns.
  - Century mixes AI and teacher nuggets and says why each is there.
  - **For Capy:** no approval for a member's own practice (quizzes are practice); approval for class-wide follow-ups and anything graded.

### 6.3 Capy's design

**A. Topic review session.** This extends the existing review session.

- **Entry points:** the Focus next card's Practise button; Learning → Review suggestions, now grouped by topic instead of chapter.
- **Request:** `GET /api/workspaces/{id}/review?group=topic&topicIds=…` returns a recorded session like the others.
- **Selection, for size N from the existing `reviewSize` preference:**
  1. Split: Focus topics 0.7·N; one interleave topic 0.3·N (the most similar topic by embedding, or a fading strength).
  2. Within each Focus topic:
     - Half come from practised items, scored as today: `(1 − R)(1 + tricky + learned)`.
     - Half come from unattempted items in the topic (any workspace quiz, plus the member's practice quiz), scored by `exp(−(logit P − logit 0.75)² / (2 · 0.5²))`.
     - Stretch items (P < 0.6) take at most 20%.
     - If one side runs short, the other fills its places, as `withNew` does.
  3. Exclude items whose key the member saw in the last 24 hours, outside a "Redo mistakes" session.
  4. Interleave topics, as modes are interleaved today.
- **Result page:** adds per-topic movement ("Circle theorems: Focus next → Getting there"), worded from the labels.

**B. Generated practice (the agent).**

- **Trigger:** a Focus topic has fewer than about 5 unattempted items near target, or the member asks in chat.
- **Where the questions go:** the agent writes 3–5 variant questions into the member's hidden practice quiz. It reuses `add_questions` with:
  - `quiz_id` set to the practice quiz;
  - `topic`;
  - `variant_of` (a question id);
  - `difficulty`.
- **Timing:** generation runs in the background after a session, not before one, so a failed or slow run never blocks practice. Per AGENTS.md there is no automatic retry; the card offers "Make questions" again.
- **Inputs to the agent:**
  - the member's missed questions in the topic, with keys;
  - the topic's source passages (it already searches the workspace);
  - the target ("a bit easier than question 12", from the member's estimate and the item's difficulty).
- **Rules** (a new agent skill, beside `editing` and `note_building`):
  - keep the skill, change the surface: new numbers, a new context, or a new angle on a concept;
  - never reuse the original's answer, numbers or worked steps;
  - use the member's wrong answer as a distractor where it is a real misconception;
  - mix question kinds (MCQ-only evidence is weak, §4.3).
- **Server checks before a variant is saved:**
  - token overlap with its parent's stem below a threshold;
  - a numeric or short answer must differ from the parent's, unless the question is conceptual;
  - the parent's correct option must not be copied verbatim as the new correct option;
  - rule-based flaw checks (longest option correct, "all of the above", which the tool description already forbids, overlapping options);
  - a cheap blind solve without the key: a mismatch discards the variant.
- **Exposure:**
  - a variant never meets the same member twice within 30 days;
  - in its first session after the parent's key it counts at weight 0.5;
  - items reserved for a test stay out of the practice and variant pool until the test closes.
- **Visibility:** practice questions are the member's own, marked "AI practice" with "Report this question" (report → weight 0, owner notified). An owner can promote one into a workspace quiz.

**C. Chat agent.** `read_study_progress` returns topics with the four lenses and recent misses, so the agent can say "Let's work on circle theorems; you missed 3 of 4" and call the practice flow. The agent never writes progress.

**D. Owner flow** (class mode):

1. The class view lists topics by members who need them.
2. "Make a follow-up quiz" has the agent write a normal workspace quiz on the top one or two topics, tagged.
3. The owner reviews it in the quiz editor and shares it. It becomes a plan task (canvas plan §4.3) or a graded assignment later.
4. "Suggest practice to Sam" starts the practice flow for one member. Who pays the credits is Epo's decision.

**E. Bank as follow-up.** When a workspace topic maps to a bank topic (HKDSE, IELTS), unattempted bank questions on it join the candidate pool through Copy to quiz. They come with platform-wide difficulty estimates, the best-calibrated items Capy has.

---

## 7. Decisions for Epo

1. **Results visibility:**
   - Owners only, or editors too?
   - A summary (labels, coverage, effort), or every answer?
   - Practice private with only tests visible, or both visible?
   - Members told on joining, or asked to opt in?
   - The recommendation is owner summary for practice and full results for tests and assignments, with a notice shown on joining.
2. **Labels and thresholds:** Not started, Too early to tell, Focus next, Getting there, Strong; with the 0.6 and 0.7 targets, 0.8 confidence and at least 3 questions (§5.5).
3. **Topics:**
   - A flat list, 5–20 with a cap of 30, one per question?
   - Owners and editors edit them?
   - AI merge suggestions only, never automatic merges?
4. **Flashcards:** keep self-rated cards out of skill (memory lens only)?
5. **Practice storage:** a hidden per-member practice quiz, or a separate table? And who pays generation credits, the member or the owner?
6. **Approval:** none for self-practice; required for class follow-ups and graded work?
7. **Constants** in §5.5: priors, drift, the Jev weight, repeat weights, the parts cap.
8. **"I don't know" button** on practice questions (Math Garden)?
9. **Topics replacing chapters** in suggestions, sessions and `read_study_progress`, given that folders only organise?
10. **Evidence from deleted quizzes:** keep it while a quiz is trashed and drop it at purge (the proposal), or keep it for good as attempts are kept?

---

## Appendix A. Evidence table (exact grid posterior)

- **Setup:** prior centred on 70% success, SD 1.22 logits (a and d combined), items of typical difficulty, P(m < 0.6) and P(m > 0.7) as in §4.3.
- **Script:** `/private/tmp/claude-501/-Users-sam-web-capy-notebook/6013b112-5e49-4dab-8bfe-41856549d0e4/scratchpad/tools/evidence3.py`. Its output is the table in §4.3.
- **With the prior centred on 50%** (`evidence.py` in the same folder), a single miss already gives P(m < 0.6) = 0.82. That is why the prior must sit at typical success and why the "at least 3 questions" rule is needed.

## Appendix B. Online update against the exact posterior

`kalman_check.py`: the prior is centred on 0.7, with SD 1.22.

| History | Exact mean, SD | Online mean, SD |
|---|---|---|
| miss, miss, right, miss | −0.28, 0.81 | −0.28, 0.79 |
| 6 right in a row | +2.08, 0.88 | +1.89, 0.79 |
| partial 0.5, 0.25, 1.0, 0.5 (Jev, w 0.8) | +0.57, 0.87 | +0.53, 0.85 |
| 2 hard misses (b 1.5), then 2 easy rights (b −1) | +0.55, 0.87 | +0.54, 0.84 |

The online update is slightly overconfident on long streaks. The batch MAP refit in §5.6 measures how much that matters.

## Appendix C. Paths

- `server/internal/review/review.go`
- `server/internal/store/study.go`
- `server/internal/store/review_sessions.go`
- `server/internal/store/queries.go`
- `server/internal/bank/bank.go`, `progress.go`, `page.go`
- `server/bankmigrations/0001_init.sql`
- `server/migrations/0051_study_progress.sql`, `0056_bank_progress.sql`, `0071_review_sessions.sql`, `0119_plan_reviews_file_steps.sql`
- `pipeline/pipeline/retrieval/questions.py`, `pipeline/pipeline/generated/agent_tools.json`
- `src/features/questions/types.ts`, `bank.ts`, `bankSearch.ts`, `TopicSummary.tsx`
- `src/routes/QuestionBank.tsx`
- `src/features/quizzes/ResultSummary.tsx`
- `openwiki/study-progress.md`, `openwiki/question-bank.md`
- `todo-canvas-workspace.md`, `todo-canvas-workspace/E-study.md`
- `bench/grading/reports/2026-10-02-jev-production-contract.md`
- `/Users/sam/web/capy-notebook/data/question-bank/round2-2026-10-03/`
