# Hints CJK word rule (2026-10-20)

Epo's decision after the hints-round review's S3: overlapping two-character
pieces let 什么是光合作用 ("what is photosynthesis") hint notes that share only
什么+么是 or 合作+作用, so a Chinese, Japanese or Korean message counts its words
by a CJK rule. First try a word-difficulty list that drops simple words; if it
drops what users ask about, fall back to counting each run of characters once.

## Setup

- Word list: HSK 3.0 levels from
  [complete-hsk-vocabulary](https://github.com/drkameleon/complete-hsk-vocabulary)
  (MIT; licence in the file headers), 10,969 words at their lowest level,
  plus the source's Traditional forms at the same level (6,731 more; HSK
  itself is Simplified, Editor 2026-10-20), 17,700 entries
  (`fixtures/hints-eval/hsk-levels.tsv`). Production keeps the same list in
  `pipeline/retrieval/hsk_words.tsv` without the single characters above
  level 1, which split the same as unlisted ones (15,599 words, 149 KB).
- Messages: 18 Chinese messages over three simple-config notes
  (`fixtures/hints-eval/chinese.json`): 11 about an edit (7 by its words,
  including 什么是光合作用; 1 "what is X", 什么是细胞分裂; 3 by a synonym),
  2 about indexed text (one bait: 合作学习有什么好处 against the 合作与作用
  note) and 5 small talk. The review's three notes are in. A shown edit is
  relevant, topical (on the message's subject) or noise.
- Matcher: production's `match_units` (one SQL, distinct lexemes, the
  two-word rule with its "all words when fewer than two" clause) on a scratch
  `pgvector/pgvector:pg16`; only the message's word units change per rule.
- Run: `scripts/hints_eval_cjk.py` from `pipeline/`.

## Results

| Rule | Hints / msg | Precision | Precision with topical | Recall | Edit messages found | Noise / msg | Messages with noise |
|---|---|---|---|---|---|---|---|
| pairs (before) | 1.28 | 0.48 | 0.78 | 1.00 | 11/11 | 0.28 | 5/18 |
| runs-any (fallback) | 2.06 | 0.30 | 0.49 | 1.00 | 11/11 | 1.06 | 11/18 |
| runs-all | 0.06 | 1.00 | 1.00 | 0.09 | 1/11 | 0.00 | 0/18 |
| hsk1-all | 0.72 | 0.46 | 0.77 | 0.55 | 6/11 | 0.17 | 1/18 |
| hsk1-any | 1.17 | 0.52 | 0.71 | 1.00 | 11/11 | 0.33 | 4/18 |
| **seg-merge (production)** | 1.00 | **0.61** | **0.89** | **1.00** | **11/11** | **0.11** | **2/18** |
| seg-words | 0.94 | 0.47 | 0.71 | 0.73 | 8/11 | 0.28 | 5/18 |

- **pairs**: every overlapping pair a word (the rule before).
- **runs-any / runs-all**: each CJK run one word, matched by any / all of its
  pairs. runs-any is Epo's fallback; it reads 什么 as content, so small talk
  and "what is X" match every note holding 什么 or 进行 (1.06 noise).
- **hsk1-all / hsk1-any**: level-1 words dropped, each leftover piece one
  word. Without the rest of the list, pieces run together (卡尔文循环生成,
  怎样影响光合作) and miss by all-pairs; by any-pair they are back to noisy.
- **seg-merge**: the run split by longest match over the whole list, level 1
  dropped, every other list word ending a word, unlisted characters joined to
  the next list word (光 + 合作 = 光合作; 用 is level 1). 什么是光合作用 counts
  one word, 光合作, and hints only the photosynthesis notes, not 什么是细胞分裂
  or 合作与作用; the bait 合作学习有什么好处 hints nothing.
- **seg-words**: the same split keeping only list words; dropping unlisted
  characters loses terms the list lacks (减数, 染色体, 叶绿体).

The list did not drop what these 18 messages ask about: seg-merge found every
edit question. None of them has a term the list splits into a level-1 word;
the re-review found such terms lose their words (什么是电子, 水的沸点, 电流和电压
give none) and level-2 question words count (为什么, 如何, 可以), so the rule
is not settled by this set. Its two noisy messages share two real
words with the noise (温度+影响 against "温度对很多事情都有影响"; 进行+复习
against the review plan).

Japanese and Korean (no list): each run counts once, matched by any of its
pairs. 光合成とは何ですか？ still hints its edit (and the other edit of the same
note through the note's name); 광합성 에너지는 무엇인가요? hints its edit only.

## Limits

18 hand-written messages on three notes, simplified Chinese only; the
Traditional forms were added after the run and leave every Simplified unit
of every rule unchanged (checked against the run's units), and the
Traditional messages checked (什麼是光合作用, 什麼是細胞分裂, 謝謝, 合作學習有什麼好處 and
the rest of the set's shapes) give the same words as their Simplified forms. HSK covers
everyday and exam vocabulary, not subject terms; seg-merge relies on unlisted
characters joining a neighbouring list word, which held for every term here
(光合作, 卡尔文循环, 减数分裂, 染色体) but is not measured on other subjects.
