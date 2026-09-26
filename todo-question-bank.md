# Question bank follow-ups

Deferred while designing the exam question bank UI. The mocks are in
`artifacts/2026-09-25-question-bank-mocks.html`. Each item below needs its own
design pass before implementation.

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

## Grading

- [ ] Grade each marking scheme item with the LLM grader. Every item is one
  mark, awarded 1, 0.5 or 0, and a part's marks are its item count. Scheme
  items replace `rubrics` in the question JSON, the judge returns one score per
  item (`/quiz-grade` in the pipeline and the in-browser judge), and
  `bench/grading` needs a rerun because the task changes.
