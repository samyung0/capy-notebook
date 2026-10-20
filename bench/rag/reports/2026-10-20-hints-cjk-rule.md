# Hints CJK word rules (2026-10-20)

The hints matcher counts a message's words: a hint needs two of them to match
an edit, or every one when the message has fewer. Overlapping two-character
pieces let 什么是光合作用 ("what is photosynthesis") hint notes that share only
什么+么是 or 合作+作用 (hints-round review S3). Epo decided a Chinese, Japanese
or Korean message counts its words by a CJK rule: first a word-difficulty list
that drops simple words, falling back to each run counting once. The first
list rule (dropping every HSK level-1 word) lost terms such as 电子 and 沸点,
counted 为什么, and the Japanese and Korean fallback let です hint (re-review
R1-R3). Epo then allowed hand-picked lists where measured necessary, the rule
that lands being the best measured on the Chinese, Japanese and Korean sets.

## Setup

- **Word list:** HSK 3.0 levels from
  [complete-hsk-vocabulary](https://github.com/drkameleon/complete-hsk-vocabulary)
  (MIT; licence in the file headers), 10,969 words at their lowest level plus
  the source's Traditional forms at the same level (6,731 more; HSK itself is
  Simplified), 17,700 entries (`fixtures/hints-eval/hsk-levels.tsv`).
  Production keeps the same list in `pipeline/retrieval/hsk_words.tsv` without
  the single characters above level 1, which split the same as unlisted ones
  (15,599 words, 149 KB).
- **Hand-picked lists** (production, `pipeline/retrieval/hint_words.py`):
  - Chinese: 222 dropped words counting their Traditional forms (function words, pronouns, question words,
    request verbs such as 请问, 解释 and 复习, modal and light verbs, measure
    words, locatives), and 43 one-character measure words, locatives, 对 and 能
    that a lone character keeps.
  - Korean: 28 question words and set phrases, and 33 endings.
- **Messages:**
  - `fixtures/hints-eval/chinese.json`: 18 Chinese messages over three notes.
    11 are about an edit (7 by its words, 1 什么是X, 3 by a synonym), 2 about
    indexed text and 5 small talk, with the review's three notes.
  - `fixtures/hints-eval/cjk-terms.json`:
    - 18 Chinese messages: the re-review's R1/R2 cases (什么是电子, 水的沸点是多少,
      电流和电压, 什么是对数, 太阳系有几个行星, 为什么会下雨, 牛顿第一定律 …) over
      16 edits holding those terms, the decoys 为什么要复习 and 这个成语的意思,
      and 3 small-talk messages;
    - 7 Japanese and 7 Korean messages with kana and particle decoys
      (今日は晴れです, 이것은 무엇인가요? 이란 나라).
  - Labels: a shown edit is relevant, topical (on the message's subject) or noise.
- **Matcher:** production's `match_units` (one SQL, distinct lexemes, the
  two-word rule and its one-word clause) on a scratch `pgvector/pgvector:pg16`.
  Only the message's word units change per rule.
- **Run:** `scripts/hints_eval_cjk.py` from `pipeline/`.

## Results

### Chinese, 36 messages (26 edit questions)

| Rule | Hints / msg | Precision (with topical) | Recall | Edit questions found | Noise / msg | Messages with noise |
|---|---|---|---|---|---|---|
| pairs (before the CJK rule) | 1.03 | 0.57 (0.76) | 0.81 | 21/26 | 0.25 | 9/36 |
| runs-any (Epo's fallback) | 1.92 | 0.38 (0.48) | 1.00 | 26/26 | 1.00 | 23/36 |
| runs-all | 0.17 | 1.00 (1.00) | 0.23 | 6/26 | 0.00 | 0/36 |
| hsk1-all | 0.67 | 0.46 (0.62) | 0.42 | 11/26 | 0.25 | 4/36 |
| hsk1-any | 0.89 | 0.50 (0.62) | 0.62 | 16/26 | 0.33 | 7/36 |
| hsk1-merge (first list rule) | 0.75 | 0.59 (0.78) | 0.62 | 16/26 | 0.17 | 5/36 |
| seg-words | 0.75 | 0.48 (0.63) | 0.50 | 13/26 | 0.28 | 9/36 |
| **hand (production)** | 1.00 | **0.69 (0.83)** | **0.96** | **25/26** | **0.17** | **4/36** |

Per set:

| Rule | chinese.json (11 edit questions) | cjk-terms zh (15) |
|---|---|---|
| pairs | 11/11, noise 0.28 | 10/15, noise 0.22 |
| runs-any | 11/11, noise 1.06 | 15/15, noise 0.94 |
| hsk1-merge | 11/11, noise 0.11 | 5/15, noise 0.22 |
| hand | 10/11, noise 0.33 | 15/15, noise 0.00 |

An intermediate variant took its stopwords from the HSK source's
part-of-speech tags (944 words with a pronoun, particle, conjunction,
preposition, adverb or interjection tag, and 31 hand-added verbs). It found
21/26 with 0.19 noise. Single-character stopwords cut 对数 and 动能; the
adverb 光 cut 光合作; and measure words and locatives that were not stopwords
broke 行星 and 叶绿体. The hand-picked list replaced it.

### Japanese (5 edit questions of 7) and Korean (4 of 7)

| Rule | Japanese | Korean |
|---|---|---|
| pairs | 4/5, precision 0.80, noise 0.14 | 4/4, precision 0.57, noise 0.29 |
| any (each run once by any pair) | 5/5, precision 0.36, noise 1.29 | 2/4, precision 0.67, noise 0.14 |
| **hand (production)** | **5/5, precision 0.83 (1.00), noise 0.00** | **4/4, precision 1.00, noise 0.00** |

## What the rules do

- **Chinese (hand):** split by longest match over HSK plus the hand list.
  - Only listed words are dropped. Every other list word ends a word, and
    characters between them join the next.
  - Each word matches by all its pairs.
  - A character left alone takes a joinable neighbour, so 什么是对数 is 对数,
    什么是动能 is 动能, and 什么是中子 is 中子.
  - Examples: 什么是光合作用 is 光合作 (it hints neither 什么是细胞分裂 nor
    合作与作用); 为什么会下雨 is 下雨; 水的沸点是多少 is 沸点; 太阳系有几个行星 is
    太阳+行星; 请问这个是什么意思 and 可以帮我复习一下吗 have no words.
- **Japanese:** a run counts once and matches by any pair not made only of
  hiragana. 細胞分裂とは何ですか no longer hints 今日は晴れです, and
  何をすればいいですか (only 何を) hints nothing.
- **Korean:** a word loses one ending (광합성이란 → 광합성, 분열은 → 분열), drops
  if it is a question word or set phrase (무엇, 어떻게, 역할, 이건), and matches
  by two of its pairs. 광합성이란 무엇인가요 is 광합성, and 이건 무엇인가요 has no
  words.

## Remaining misses and noise (hand)

- **Miss:** 植物怎么把光能变成化学能 shares only 变成 with "光合作用把光变成能量"
  (a synonym question).
- **Noise:**
  - 温度太高会怎样影响光合作用 also hints "温度对很多事情都有影响" (two real shared
    words).
  - 今天天气怎么样 hints "今天天气很好".
  - 合作学习有什么好处 and 我有点累了，不想学习 hint the notes of
    "语文与学习笔记", whose name holds 学习.

## Limits

- **Small sets:** 36 Chinese, 7 Japanese and 7 Korean hand-written messages on
  a few notes, mostly science. The hand list was tuned on these sets, so the
  numbers are an upper bound for other subjects.
- **Traditional Chinese:** the lists hold Traditional forms; the checked
  Traditional messages give the same words as their Simplified forms.
- **Mixed scripts:** a Japanese message is detected by any kana in it, so a
  kanji-only Japanese message is read as Chinese.
