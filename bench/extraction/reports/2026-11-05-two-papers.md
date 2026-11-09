# Two question files with the same numbering

Review findings 5 and 6 on the Make a quiz branch, 2026-11-05: a box's `page` names no file,
so a question could take the other paper's figure, and a label two papers share would
overwrite the earlier copy. Script: `scripts/two_papers.py`. Results stay in the ignored
`.results/twopapers/`, and nothing here quotes a paper.

## Setup

- HKDSE Maths Paper 2 from 2023 and 2024, pages 6, 7, 8, 10 and 13 of each: the same page
  numbers, figures on all of them, the same question numbers. The 2023 paper is born digital
  and the 2024 paper is a scan.
- The finished route on `deepseek/deepseek-v4.1-flash-1017` through OpenRouter, with saved
  layout boxes and no answer file. Three runs, $0.127 in all, plus $0.009 for a run of the
  script that stopped early.

## Results

| Run | Map | Saved | Missing | Copied twice | Labels with no paper | Box uses | Other paper's box | Time | Cost |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 30 | 30 | 0 | 0 | 0 | 17 | 0 | 242 s | $0.0442 |
| 2 | 30 | 30 | 0 | 0 | 0 | 17 | 0 | 293 s | $0.0360 |
| 3 | 30 | 30 | 0 | 0 | 0 | 17 | 0 | 345 s | $0.0470 |

- **Labels (finding 6):** the map named the papers A and B in every run, A16 to A39 and B16 to
  B39, 15 each, and all three maps matched. Every copy call kept its prefix, so nothing
  collided. The earlier run in `2026-11-05-remaining-selections.md` saw a different prefix
  dropped before the label wording changed; these three plus that report's one make four
  clean runs since.
- **Figures (finding 5):** all 51 box uses stayed on the question's own paper. The page
  headings name the file and boxes are numbered once across the selection, which seems to be
  enough. A box's paper comes from the order boxes are sent in, and a question's paper from
  its label. The crops were not checked by eye.

## Limits

One pair of papers and three runs. Only the 2023 paper has a text layer, so the 2024 labels
have no independent count beyond the three maps agreeing. Code still has no guard: if a model
gave two papers the same label, the later copy would overwrite the earlier one with no notice.

## A tool call with no result (finding 9)

A question check that fails twice leaves the model's tool call with no result in its thread.
Sent such a history twice with a made-up question on the same route: both accepted, as were
two with the result in place. So on this route a later solve call goes on. Another provider
behind OpenRouter could answer differently, and the probe did not record which served it.
