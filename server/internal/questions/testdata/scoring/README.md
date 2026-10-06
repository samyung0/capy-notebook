# Scoring fixtures

Shared by the Go scorer (`questions.ScorePart`, `score_test.go`) and the
browser scorer (`scorePart` in `src/features/quizzes/grade.ts`),
so the two stay in step. Every file holds `cases`:

```json
{ "name": "…", "part": { "answer": { … }, "marks": 2 }, "answer": …, "awarded": 1.5, "items": [true, false] }
```

- `part` carries only what the scorer reads: the stored `answer` (with its key) and `marks`.
- `answer` is the learner's answer to that part; a case without it is unanswered.
- `awarded` is the part's marks, rounded down to a half mark for matching and gaps.
- `items` is whether each scored item is right: one per pair or gap, else one item.

Answer shapes, by answer type:

| Type | Learner's answer |
|---|---|
| `mcq`, `multi` | option indices in stored order (`LearnerView` keeps that order) |
| `boolean` | `true` or `false` |
| `short`, `open` | the typed text |
| `ordering` | the item texts in the learner's order |
| `matching` | `{ "0": "option text", … }`, keyed by the left item's index |
| `gaps` | one string per gap, in gap order |

Matching and ordering answer by text because `LearnerView` shuffles their options
and items. Open parts are graded by Jev and are not here.
