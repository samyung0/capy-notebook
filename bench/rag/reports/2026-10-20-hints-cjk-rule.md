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
  - Chinese:
    - 222 dropped words, counting their Traditional forms: function words,
      pronouns, question words, request verbs such as 请问, 解释 and 复习,
      modal and light verbs, measure words and locatives;
    - 43 one-character measure words, locatives, 对 and 能, which a lone
      character keeps;
    - 8 terms the lists would cut (向量, 内能, 中和, 位能, 向心力, 说明文, with
      their Traditional forms).
  - Korean: 28 question words and set phrases, and 33 endings.
- **Messages:**
  - `fixtures/hints-eval/chinese.json`: 18 Chinese messages over three notes.
    11 are about an edit (7 by its words, 1 什么是X, 3 by a synonym), 2 about
    indexed text and 5 small talk, with the review's three notes.
  - `fixtures/hints-eval/cjk-terms.json`:
    - 21 Chinese messages: the re-review's R1/R2 cases (什么是电子, 水的沸点是多少,
      电流和电压, 什么是对数, 太阳系有几个行星, 为什么会下雨, 牛顿第一定律 …) and
      the final look's 什么是向量, 什么是内能 and 什么是中和反应, over 20 edits
      holding those terms plus a 化学反应 decoy, the decoys 为什么要复习 and 这个成语的意思,
      and 3 small-talk messages;
    - 7 Japanese and 7 Korean messages with kana and particle decoys
      (今日は晴れです, 이것은 무엇인가요? 이란 나라).
  - Labels: a shown edit is relevant, topical (on the message's subject) or noise.
- **Matcher:** production's `match_units` (one SQL, distinct lexemes, the
  two-word rule and its one-word clause) on a scratch `pgvector/pgvector:pg16`.
  Only the message's word units change per rule.
- **Run:** `scripts/hints_eval_cjk.py` from `pipeline/`.

## Results

### Chinese, 39 messages (29 edit questions)

| Rule | Hints / msg | Precision (with topical) | Recall | Edit questions found | Noise / msg | Messages with noise |
|---|---|---|---|---|---|---|
| pairs (before the CJK rule) | 0.97 | 0.58 (0.76) | 0.76 | 22/29 | 0.23 | 9/39 |
| runs-any (Epo's fallback) | 1.97 | 0.38 (0.47) | 1.00 | 29/29 | 1.05 | 26/39 |
| runs-all | 0.15 | 1.00 (1.00) | 0.21 | 6/29 | 0.00 | 0/39 |
| hsk1-all | 0.69 | 0.48 (0.63) | 0.45 | 13/29 | 0.26 | 5/39 |
| hsk1-any | 0.90 | 0.51 (0.63) | 0.62 | 18/29 | 0.33 | 8/39 |
| hsk1-merge (first list rule) | 0.77 | 0.60 (0.77) | 0.62 | 18/29 | 0.18 | 6/39 |
| seg-words | 0.74 | 0.48 (0.62) | 0.48 | 14/29 | 0.28 | 10/39 |
| **hand (production)** | 1.00 | **0.72 (0.85)** | **0.97** | **28/29** | **0.15** | **4/39** |

Per set:

| Rule | chinese.json (11 edit questions) | cjk-terms zh (18) |
|---|---|---|
| pairs | 11/11, noise 0.28 | 11/18, noise 0.19 |
| runs-any | 11/11, noise 1.06 | 18/18, noise 1.05 |
| hsk1-merge | 11/11, noise 0.11 | 7/18, noise 0.24 |
| hand | 10/11, noise 0.33 | 18/18, noise 0.00 |

The final look added 什么是向量, 什么是内能 and 什么是中和反应 (with a 化学反应 decoy
edit) to cjk-terms; the hand rule's added terms (向量, 内能, 中和, 位能, 向心力,
说明文) took it from 15/15 to 18/18 there with no noise. Before them, on the 36
messages without these three, it found 25/26 at 0.17 noise.

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
- **Long messages:** a word matches by at most 24 pairs, a Korean word by two
  of its pairs only up to 8 characters (a longer run, such as Korean pasted
  without spaces, by any pair), and a message counts at most 40 words. Two of
  every pair of a long Korean run grew quadratically and overflowed
  Postgres's tsquery at 1,000 characters (final look B1).
