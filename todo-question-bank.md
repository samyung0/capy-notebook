# Question bank follow-ups

Product follow-ups after the initial bank implementation. The original mocks are in
`artifacts/2026-09-25-question-bank-mocks.html`. Each item below needs its own
design pass before implementation.

Approved small-screen layout A is in
`artifacts/2026-09-27-question-bank-responsive-mocks.html`: sequential bank
navigation, no redundant exam/subject heading, and standard named minimum
breakpoints only. [Open the interactive preview](https://faflav2lddl1.postplan.dev).

## Studying from the bank

- [ ] Define how learners study from the question bank page. The current idea
  is not final. The page shows a question without answers, marking scheme or
  worked solution. Check answer adds the question to a learning plan if it is
  not on one yet, grades it and stores the attempt on that plan. The question
  list shows a check for correct and a cross for incorrect, read from the plan.

## Answer types

- [ ] Design the answer control for each answer type. The True / False / Not
  given control in the split-view mock is a placeholder. Decide whether the
  current seven types are too many.
- [ ] Multiple choice options are text only for now. Graph or image options are
  out of scope.
- [x] Implement the approved separate matching choice pool beside correct
  pairs, retaining unused options and permitting reuse where the exam allows.
- [x] Implement fixed-unit quantity entry: the author prescribes the unit,
  the control displays it, and the learner enters only the value. Reject
  typed units; accepted answers use the same unit. Neither Jev nor fuzzy
  matching converts units. Include sign-preservation and unit-rejection tests.

## Grading

The [September 27 input review](bench/grading/reports/2026-09-27-jev-question-bank.md)
records the JSON request, archived results and a completed 192-call context
comparison: 368/384 item labels with question text, 365/384 without, with no
request failures. This does not validate item-level half-credit or missing
visual context.

The [partial-credit screening](bench/grading/reports/2026-09-27-jev-partial-credit.md)
adds 288 successful calls across explicit grade criteria and plain marking
items. With question context, direct grading matched 66/66 and 62/66
respectively, versus 56/66 and 55/66 for probability bands. These are synthetic
diagnostics, not production approval; missing-evidence cases have unknown gold.

- [ ] Implement Epo's September 27 grading direction after the benchmark:
  text-only Jev for non-computational open/essay questions, deterministic
  types for computational questions. Generation instructions enforce the
  split. Keep calls on the backend under the existing grading policy.
- [x] Screen per-item direct 0/0.5/1 decisions against `noul` probability bands
  below 0.35 = 0, below 0.65 = 0.5, otherwise 1. Every marking item is one
  mark and a part's marks are its item count. Add item-level half-credit
  examples, omissions, contradictions and keyword stuffing. The new fixture
  supplies genuine item-level partial-credit labels; old archived binary
  labels remain separate.
- [ ] Choose the per-item scoring contract after reviewing the direct-choice
  recommendation, then evaluate held-out realistic answers and less explicit
  schemes. Preserve the planned plain-string marking-item format unless a
  separate decision adds stored partial-credit criteria.
- [x] Run paired grading requests for the 96 saved essay answers with identical
  marking schemes and student answers, with and without question context,
  192 requests for the two variants.
- [x] Add synthetic paired context cases for shared stems,
  references between parts and figure-dependent questions. Record whether
  the marking scheme supplies enough text; text-only JSON cannot convey a
  missing graph or image by itself.
- [ ] Extend the existing computation-routing benchmark with conceptual math,
  proofs and figure-dependent non-computational questions. Test computation
  and sufficient text separately before selecting the review/edit check's
  threshold and reject/warn behavior.
- [ ] Preserve previous reports and raw responses. New fixtures, runners and
  reports belong under `bench/grading`; use a new run path and record actual
  model identity. The new `jev_context.py` accepts hidden credential input
  or `TYPESAFE_API_KEY`. The old `typesafe_math.py` runner uses fixed archive paths,
  so do not rerun it unchanged over existing results.
