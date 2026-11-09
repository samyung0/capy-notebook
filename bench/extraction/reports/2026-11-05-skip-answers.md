# Skipping an answer the pages can't give

Epo, 2026-11-05: "well the user will check the answer anyway, i guess u can be a bit safe and
say sth like skip the answer if there not enough information/missing information/unreadable
etc." A one-page PDF citing figures it doesn't print had come back with made-up keys, and one
accepted answer that was the words saying it couldn't be answered. Script:
`scripts/skip_answers.py`. Results stay in the ignored `.results/skipanswers/`, and nothing
here quotes a paper.

## Setup

The finished route on `deepseek/deepseek-v4.1-flash-1017` through OpenRouter, with the wording
Epo approved. Eight runs, $0.0702 in all.

- **cited:** the one-page test PDF, four questions, three of them citing figures it doesn't
  print.
- **worked:** HKDSE Maths 2023 Paper 1, pages 2 to 9, with no answer file. Everything needed is
  on the pages, so nothing should be skipped.
- **scheme:** 2021 Paper 1 as text, with its mark scheme as text. Nothing should be skipped.

## Results

| Job | Runs | Questions saved | Parts | Skipped | Keys or solutions with an excuse word | Cost per run |
|---|---:|---:|---:|---:|---:|---:|
| cited | 3 | 4 of 4 | 4 | 3 in every run: questions 1, 2, 3 | 0 | $0.0013-0.0019 |
| worked | 3 | 11 of 11 | 18 | 0 | 0 | $0.0098-0.0169 |
| scheme | 2 | 10 of 10 | 19 | 0 | 0 | $0.0106-0.0163 |

Excuse words are searched in accepted answers and solutions: "not determinable", "not printed",
"missing" and the like. Before this wording the same PDF saved made-up keys for two questions and
those words as the key for a third.

## Limits

Small: one test page and two past papers. This counts skips, not whether the answers given are
right; a wrong answer the model didn't think to skip looks the same as before. Saving a skipped
question to the quiz's room goes through Go's `insert_child`, which these runs don't reach: the
bench stops at the run's result, so that step still needs a run on UAT.
