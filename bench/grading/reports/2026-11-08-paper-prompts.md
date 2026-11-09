# Upload prompts R, P1 and B, word for word (2026-11-08)

`scripts/paper_prompts.py` sends the three prompts Epo approved
(`todo-file-submissions.md`, question M) unchanged, on 1017 through
OpenRouter, eight runs. Raw rows: `2026-11-08-paper-prompts.jsonl`.

## R on every closed type (3 handwritten pages, 10 parts)

Choice with a crossed-out mark, choose two, true/false, gaps with one left
empty, matching, ordering, short, an open part answered out of order, an
unanswered choice part.

- Pages right in 8 of 8 runs (10/10 each).
- Answers right 10/10 in 5 runs, 9/10 in 3. The miss is always the same: the
  unanswered choice part comes back with pages `[]` but answer `["C"]`, the
  right option, guessed. The build drops any answer whose pages are empty, so
  it scores nothing as it should; the prompt stays as approved.
- The crossed-out A, the two letters, `false`, the empty gap `""`, the
  matching object and the order were read right every time.
- About 0.3 credits a call (0.65 uncached), 1–2 s.

## R's pages, then P1 + B four parts a call (the 10-page paper)

- Pages 15/16 every run: part 12 (left blank, with "F = ma ?" as rough working
  under its label) is put on page 10. It is a short part, so the code marks the
  read answer; no grading call is made for it.
- Open parts right 11/11 in 3 runs and 10/11 in 5. Every miss is part 9
  ("cell wall, chloroplasts, vacuole" for two differences between plant and
  animal cells), given 0 with `vocabulary_only` set: rule 7 of today's grading
  prompt (a bare list of terms earns nothing).
- The same answer typed into today's prompt with no pages got 0 in 4 of 6
  runs, so the swing is rule 7's, not the page sections'. Whether rule 7 should
  let a list answer a "state two" question is a separate question.
- 8–16 credits for the paper (4 calls, reasoning on), 15–31 s.
