# Question bank, round 2: plan

Status: draft for Epo, 2026-10-02. No code has changed yet apart from the sidebar entry (`src/components/app/Sidebar.tsx`).

Background reading: `data/question-bank/analysis/hkdse-math-compulsory.md` and `ielts-academic-reading.md` (both git-ignored, copies in the private bank bucket under `analysis/`). Earlier context: `question-bank-handoff.md` and `todo-question-bank.md`.

## Agreed

Every item below was agreed by Epo on 2026-10-02.

- **Pilot data.** The 1,098 live pilot questions are disposable, and so are the old quizzes; no real users or data exist. Dump the bank, then clear it before publishing the first round-2 batch.
- **Syllabus topics.** Topics use the official syllabus names where they exist. Otherwise we choose names that are useful to a learner.
  - **HKDSE:** the 18 senior learning units, renamed to the exact EDB unit names. The S1–3 units stay out (Epo first asked for them, then withdrew). Junior content is about 43% of Paper 1 marks; it appears only where it serves a senior topic.
  - **IELTS:** has no official topics, so topics are passage subject areas we name ourselves (Epo approved the seven below). Task types are stored on each question now. The filter that uses them is page-only work, deferred.
- **Questions we skip.** Proofs and "show your working" questions. Jev can't grade method, and the bank is a mix of questions, not a mock paper.
- **Guided verdict parts.** A part that asks whether a claim holds, justified by working, becomes guided steps: find each deciding value, then a final true/false verdict.
- **Paper 1 vs Paper 2.** No field or topic for it. It changes how a learner sits a paper, not what a question contains.
- **Graph elements.** Add angle, arc, sector and polygon to the graph block.
- **Weighting.** Question counts per topic follow how often the topic appears in real papers, with a floor.
- **Web passages.** Passages may come from the web as well as the library. Learners see them, so the licence must allow adapted reuse: CC BY, CC BY-SA, CC0 or public domain, never ND or NC. Each needs its own provenance record.
- **Small batch first.** Epo reviews it before the full run.

## 1. Syllabus catalogs

Changes to `lab/questions/syllabi/`:

- **HKDSE Mathematics Compulsory Part.** The ids stay the same. The labels become the exact names from the EDB Mathematics Education KLA Curriculum Guide (2017), page 25:
  1. Quadratic equations in one unknown
  2. Functions and graphs
  3. Exponential and logarithmic functions
  4. More about polynomials
  5. More about equations
  6. Variations
  7. Arithmetic and geometric sequences and their summations
  8. Inequalities and linear programming
  9. More about graphs of functions
  10. Equations of straight lines
  11. Basic properties of circles
  12. Loci
  13. Equations of circles
  14. More about trigonometry
  15. Permutations and combinations
  16. More about probability
  17. Measures of dispersion
  18. Uses and abuses of statistics
- **IELTS Academic Reading.** Topics are passage subject areas. These seven cover the 24 real passages, plus areas the real tests also use:
  1. Nature and wildlife
  2. Environment and climate
  3. Mind and behaviour
  4. Health and medicine
  5. Science and technology
  6. History and archaeology
  7. Society and culture (work, economy, education, language, the arts)

  The 24 real passages split as: nature and wildlife 8, mind and behaviour 6, history 5, technology 4, environment 2. Health and society appear in official samples and older books.
- **Question-type vocabulary.** The syllabus file lists each subject's question types under `question_types`. For IELTS these are the 11 official task types, using their official names. HKDSE has none for now. The list lives only in the syllabus file; the publisher validates against it.

## 2. Bank schema and API

- **Migration `server/bankmigrations/0002`.** One additive column: `questions.question_types text[] NOT NULL DEFAULT '{}'`. It holds the task types a question contains. The publisher fills it from the generation output and rejects ids outside the syllabus file's vocabulary.
- **API.** No change this round.
  - The topic list already returns every light row for a topic in one response, and the page loads full questions 10 at a time by id.
  - A later type filter adds the column to those light rows plus a label map on the page. That is page-only work, with no query or pagination change.
  - The agent search can filter by the same column.
- **Not in this round.** The retraction flag and progress tables belong to the bank-progress work in `todo-learning-outputs.md`. They can share a migration if that work lands first.

## 3. Question format

### Graph elements

New whitelisted JSXGraph types, alongside the existing ones:

- **angle:** three point ids, an optional label and an arc radius. A 90° angle draws the square mark.
- **arc:** a centre and two points.
- **sector:** a centre and two points, filled.
- **polygon:** point ids, an optional fill and an optional hatch.

Places that change:

- **Validators:** Go `server/internal/questions`, the shared TS/collaboration validators and the generated field limits.
- **Rendering:** the SVG export and the headless publish render.
- **Editor:** the graph editor's + popover gains the four types, using the existing element-row pattern with ⋮ menus. No new components.
- **Tests:** fixtures for each new type.

### Web sources

A question's `sources` becomes a list of either kind:

- `{kind: 'library', excerptId, bookId, version}` (today's shape)
- `{kind: 'web', url, title, authors, publisher, licence, retrievedAt}`

`sources` is already jsonb, so no migration is needed. Changes:

- **Licence checks.** `bank.Source`, `Store.Provenance` and the publisher validate both kinds.
- **Copyleft rule.** It applies to web licences too: BY-SA makes the question BY-SA, and two copyleft families are refused.
- **Attribution.** The footer renders web credits ("adapted from").
- **Copies.** `store.Provenance` gains web entries for when copy-to-quiz lands.

### Render fixes from the handoff

Checked 2026-10-02 against a real render: the grid, raw-LaTeX and degree-spacing issues were already fixed in the code (`graph.ts` axis ticks, `AnswerView` wraps LaTeX, `°` has no space). The IELTS instruction placement is handled by generation. Nothing left to change.

## 4. Bank page (mocks first)

One mock round, for the **bank review screen**. Epo picks before anything is built. Navigation is unchanged (exam → subject → topic → questions); the question-type filter is deferred.

- **Bank review screen.** Spaced-repetition review of attempted bank questions, grouped by exam and topic. It is separate from the workspace review route in `study-progress-plan.md` and not bound to a workspace.

## 5. Generation pipeline (`lab/questions`)

### Style guides

The per-topic `references` and `style` stages are replaced by one guide per exam, built from the analyses (references stay private):

- an exam-wide guide: conventions, marking style, distractor patterns, figure rules, answer formats
- a short section per topic: how it appears, typical shapes, its share of the exam

Epo reviews the guides before writing starts. The writer packet gets the exam guide plus its topic's section, never the references.

### Writer rules added

- **HKDSE.**
  - Both question shapes: chained 2–3 part questions with short answers, and single 4-option multiple choice.
  - Multiple-choice options are in ascending numeric order, with distractors taken from the listed slips. Some items use the I/II/III style, written as mcq.
  - Guided verdict parts; proofs skipped; "show X, hence find Y" keeps the hence part with X given.
  - Exact answers where possible, otherwise the stated precision (3 s.f.). Simplified fractions, π and surd forms.
  - Marking items mirror the official method/accuracy steps, and worked solutions follow the scheme layout, with a reason on every geometry step.
- **IELTS.**
  - Every IELTS question is one full passage of 760–960 words. It follows the real section 1, 2 or 3 pattern, with 13–14 items in 2–4 task-type groups.
  - There are no single-type drills. Filtering by type finds every passage containing that type, which covers practice by type.
  - The rare types (headings, diagram labels, short answers) still appear now and then, so the filter never comes up empty.
  - Each passage records its subject area, which sets its topic, and the task types it contains.
  - Completion defaults to ONE WORD ONLY, with answers in their passage form. Accepted answers include British and American spellings and an optional plural where the key would allow it.
  - NOT GIVEN and distractor design follow the analysis.
- **Both.** The lessons the pilot kept only in dispatch prompts move into the frozen prompts:
  - paraphrase the official instructions
  - plain numbers for quantity answers
  - no `PI` in graph terms
  - write JSON with `json.dump`
  - reviewers check for answer-position leaks

### Passage sourcing

- `run.py passage` accepts web passages as well as library excerpts.
- A sourcing stage finds candidates and records the URL, licence evidence and the exact text it fetched.
- The driver rejects ND, NC, missing licences and pages behind bot checks or logins.

### Weighting

- The topic count for a full run is the exam share from the analysis times the subject total, with a floor.
- The totals and the floor are decided after the first batch.

### Unchanged

Frozen packets, the blind solver on the learner render, compare/judge, the fix loop, the 12-word copy check against the private references, the Go validator, and publish (insert only).

## 6. First batch

- **HKDSE:** 10 questions each in three topics, mixing both shapes:
  - Basic properties of circles (angle chasing, needs the new graph elements)
  - More about trigonometry (includes 3-D)
  - Measures of dispersion (tables, stem-and-leaf, box plots)
- **IELTS:** two full passages, one in the section 1 pattern and one in the section 3 pattern, on two different subject areas. At least one comes from a web source.
- **Review:** Epo reviews the real renders, with answers, marking schemes and solutions, before anything is published. After approval, dump the bank, clear it, run the migration and publish.

## Order of work

1. Catalogs (1) and the style guides (5). Epo reviews the guides. Done 2026-10-02: `lab/questions/syllabi/*.json` updated; guides in `data/question-bank/style/` (private).
2. Graph elements and web sources (3), plus the render fixes. Done 2026-10-02 (uncommitted): validators, renderer, editor, provenance, footer, docs and tests; the render fixes were already in the code.
3. First batch (6). Epo reviews it. Done 2026-10-02: 32 questions in `data/question-bank/round2-2026-10-02/`, review page https://claude.ai/artifact/2JrsBU1i7N3qCZmtmTmB5Y. Bank migration `0002_question_types.sql` and the publisher's `questionTypes` support are written but not applied. Epo's review (2026-10-03) changed the format (part marks, marking schemes on open parts only, segment ticks, no chart values table), the HKDSE and IELTS guides and the passage difficulty check (`lab/questions/readability.py`); the second batch is in `data/question-bank/round2-2026-10-03/`.
4. Bank migration and API (2), then clear and publish.
5. The mock round (4) can run in parallel with steps 2–4. The page work follows Epo's pick.

## Later, not in this round

Each of these has its own entry in `todo-learning-outputs.md` or `todo-question-bank.md`:

- bank progress and review (state table, retraction flag)
- copy-to-quiz
  - the quiz validator accepts bank image URLs
  - waits for the "Question bank image uploads" session's work to land
- agent search over the bank
- the question-type filter on the bank page (page-only, using `questions.question_types`)
- Jev grading for bank open parts
- the full-run totals

## Open

- No single-type IELTS drills: every IELTS question is a full real-pattern passage (section 5). Proposed, not yet confirmed.
