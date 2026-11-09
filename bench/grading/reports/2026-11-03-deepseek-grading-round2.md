# DeepSeek grading, round 2: reference, working rules, reading rules

Round 2 of the [DeepSeek grading bench](2026-11-03-deepseek-grading.md), following the
plan's "Grading prompt, round 2" (`todo-study-tracking.md` §9). The answer sets,
labels and models are the same as round 1. Round 1's prompt is kept as the baseline.
Maths parts now always run with thinking at low effort.

- **The round-2 setup lifts both models.**
  - Flash: from 1,824 to 1,859 of 1,946 items (95.5%). With the cascade (one
    thinking-low sample on flagged non-maths parts) it reaches 1,870 (96.1%).
  - 0731: from 1,782 to 1,824 (93.7%), or 1,859 (95.5%) with the cascade.
  - Jev stays at 1,730.
- **Unearned marks fell for both.** Flash went from 49.5 to 28.5, 0731 from 88 to
  60.5. With the cascade, 0731 is at 49 and Flash still at 28.5.
- **How far the prompt closes 0731's gap.**
  - Round 2 plus the cascade brings 0731 to Flash's round-1 level: 1,859 items,
    49 unearned marks.
  - Against Flash on the same setup, 0731 still gives 20.5 more unearned marks
    (49 against 28.5). The gap was 38.5 in round 1.
  - Maths closes completely (0731 2.5 marks over, Flash 4). The reading sets and
    the contract do not.
- **Maths moved most.**
  - Flash: 284 to 312 items. 0731: 273 to 319.
  - Valid alternative methods now lose 1.5–2 marks instead of 10–15.
  - A right answer with wrong working now gains 0–1 marks instead of 9.5–12.
  - A bare answer gains at most 1 mark.
  - About half of the gain comes from the working rules and half from thinking.
- **Answers that only quote the passage (DSE Chinese)** earn about half as many
  unearned marks: Flash 10 to 5.5 (4 with the cascade), 0731 16 to 10 (6).
- **Pasted IELTS paragraphs:** 0731 still credits them (+7 marks), as in round 1.
  Flash never did.
- **The reference block made no measurable difference.** Without it, round 2 scored
  within ±6 items on every set tested.
- **The tolerant quote check** recovered every LaTeX item the strict check zeroed.
  - Flash had no quote failure in 1,946 items.
  - 0731's 9 remaining failures are mostly quotes joined with "…", which the
    prompt forbids.
- **Side effects:**
  - 0731 now gives half credit to contradiction answers (held-out: 7 to 2 of 11
    exact). The cascade repairs this.
  - The reading rule zeroed one correct copied IELTS answer for Flash.
  - Flash's contract score moved from 449 to 445, within noise.
- **Cost per part:**
  - Flash: $0.00052, or $0.00063 with the cascade. A maths part with thinking costs
    $0.0019.
  - 0731: $0.00019, or $0.00024 with the cascade.
  - Jev: $0.000064.
- **Latency:** maths with thinking takes 5–7 s at the median and 30–43 s at p95.

Recommendation, in full [below](#recommendation):
- **Model:** direct `deepseek-flash` with the round-2 prompt, thinking on maths and
  the cascade on flagged parts.
- **Fallback:** 0731 with the same setup is the credible fallback, if Epo signs off
  a fallback. It costs a third as much and had no availability failures. It gives
  about 1 more unearned mark per 100 items, almost all on reading answers.

Round 2 cost $1.10 for 2,888 calls. Both rounds together cost $1.79.

## What changed

**Prompt** (`SYSTEM_PROMPT_R2` in [`deepseek_grading.py`](../scripts/deepseek_grading.py),
selected with `--prompt r2`). Round 1's rules 1–8 are kept word for word. The
additions:

- **`<reference_for_marker>`.** A block between the scheme and the answer: "the
  part's correct answer and worked solution, for you only. It shows one correct
  route; a different valid method or wording earns the same credit. Never give
  credit for resemblance to the reference alone."
- **Working rules 9–14:**
  - check every step and record a verdict per step in `steps` before the items;
  - find the first wrong step, and items before it stand;
  - later correct steps from a wrong value earn M items, not A items, unless the
    item says ft;
  - an A item needs its M item ("M0 A1 is impossible");
  - a right final answer with missing or wrong working earns no M items;
  - a valid different method is judged on its own mathematics.
- **Reading rules 15–16:**
  - an explain, how or why item is not earned by copying the passage without
    explaining it (只抄原文而未解釋不給分), though quoting inside one's own
    explanation is fine;
  - where the question or item asks for own words, copied or pasted text earns
    none.
- **Reply shape:** `{"steps": [{"step", "ok"}], "vocabulary_only", "injection_suspected", "items": [...]}`.
  `steps` is recorded but never scored. Flash wrote steps for 105 of 113 maths
  answers (4.6 on average); 0731 for 105 (4.1).

**Thinking.** Maths parts are graded with thinking on at low effort
(`--thinking-sets math`); every other set runs without thinking. The cascade gives
flagged non-maths parts one thinking-low sample and keeps it. A part is flagged by
any `partial`, a failed quote, `injection_suspected` or `vocabulary_only`. Maths
parts are not sampled again.

**Quote check.**
- Round 2 matches on letters and digits after NFKC and case folding.
- LaTeX command names are also removed before matching, so `$x \neq a$` and
  `x ≠ a` both match as `xa`. A 5-answer LaTeX pilot showed letters and digits
  alone still failing on `\neq` against `≠`.
- The strict whitespace match is kept as a diagnostic.

**Which parts got a reference.** 498 of the 732 answers:

| Set | Reference | Source |
| --- | --- | --- |
| Contract, LaTeX, injection, translated zh-Hant (238 answers) | yes | `accepted`, the fixture's model answer. No fixture part has a `solution` |
| zh-Hant corpus rows (12) | yes | the corpus `model_answer` |
| HKDSE maths (115) | yes | the fixture's `solution_summary`, the worked solution in brief. For 15 parts (2021, 2022, 2024) it comes from the HKEAA answers. For 8 parts (2023, 2025) it was written in the HKEAA style, since there is no official scheme locally |
| HKDSE Chinese reading (80) | yes | the 評卷參考 參考答案 |
| DSE-style Chinese, original (53) | yes | the author's model answer |
| Held-out partial credit (66), held-out rubric essays (96), IELTS (68), sensitive probe (4) | no | none in the fixtures |

## Results by set

Items exact, then marks over-credited / under-credited. "+c" adds the cascade.
Round 1's cascade here uses one sample (the first thinking sample). The round-1
report required both samples, so its totals were 3 lower for Flash (1,848) and 1
lower for 0731 (1,832).

| Set (items) | Jev | Flash r1 | Flash r1+c | **Flash r2** | **Flash r2+c** | 0731 r1 | 0731 r1+c | **0731 r2** | **0731 r2+c** |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Contract (464) | 435 · +11/−5.5 | 449 · +4.5/−4.5 | 452 · +4.5/−3 | 445 · +5/−6.5 | 449 · +6/−4.5 | 440 · +10.5/−4 | 443 · +11.5/−2.5 | 438 · +11.5/−5.5 | 443 · +11/−3.5 |
| LaTeX (40) | 37 · +1/−1 | 37 · +0/−2.5 | 39 · +0/−0.5 | 38 · +0/−1 | 38 · +0/−1 | 35 · +0/−4.5 | 37 · +0/−2.5 | 39 · +0/−0.5 | 38 · +1/−1 |
| Held-out partial credit (66) | 65 · +0/−0.5 | 64 · +1/−0.5 | 64 · +1/−0.5 | 64 · +0.5/−0.5 | 64 · +0.5/−0.5 | 60 · +3/−0.5 | 63 · +1.5/−0.5 | 55 · +5.5/−0.5 | 63 · +1.5/−0.5 |
| Held-out rubric essays (384) | 347 · +14.5/−6 | 380 · +1/−1.5 | 379 · +3/−0.5 | 380 · +1.5/−1.5 | 381 · +2.5/−0 | 378 · +0/−6 | 381 · +1/−1.5 | 369 · +5.5/−6 | 380 · +1.5/−2 |
| Prompt injection (56) | 54 · +0/−1 | 54 · +0/−1 | 54 · +0/−1.5 | 53 · +0/−2 | 53 · +0/−2 | 54 · +0/−1.5 | 54 · +0/−1.5 | 54 · +0/−1.5 | 54 · +0.5/−0.5 |
| Traditional Chinese (91) | 87 · +1/−1.5 | 87 · +1/−1.5 | 87 · +1/−1.5 | 87 · +1/−1.5 | 87 · +1/−1.5 | 87 · +1.5/−0.5 | 87 · +1.5/−0.5 | 86 · +2/−0.5 | 86 · +2/−0.5 |
| HKDSE maths (335) | 276 · +20/−24 | 284 · +19/−21.5 | 300 · +13/−20.5 | 312 · +4/−6.5 | 312 · +4/−6.5 | 273 · +30.5/−15 | 298 · +21/−12 | 319 · +2.5/−6 | 319 · +2.5/−6 |
| IELTS reading (141) | 124 · +8.5/−4 | 138 · +0/−1.5 | 139 · +0/−1 | 135 · +1/−3 | 137 · +0/−3 | 131 · +8/−1 | 132 · +7/−1.5 | 131 · +8/−1 | 131 · +7.5/−1.5 |
| HKDSE Chinese reading (209) | 155 · +28.5/−2 | 184 · +19.5/−0.5 | 190 · +16/−0.5 | 191 · +12/−0.5 | 194 · +11.5/−0.5 | 171 · +28/−0.5 | 184 · +21.5/−1.5 | 176 · +22.5/−1 | 188 · +18.5/−0.5 |
| DSE-style Chinese, original (160) | 150 · +4.5/−3 | 147 · +3.5/−1.5 | 147 · +3/−2 | 154 · +3.5/−1.5 | 155 · +3/−1.5 | 153 · +6.5/−0 | 154 · +5/−1 | 157 · +3/−2 | 157 · +3/−0.5 |
| **All (1,946)** | **1,730 · +89/−48.5** | **1,824 · +49.5/−36.5** | **1,851 · +41.5/−31.5** | **1,859 · +28.5/−24.5** | **1,870 · +28.5/−21** | **1,782 · +88/−33.5** | **1,833 · +70/−25** | **1,824 · +60.5/−24.5** | **1,859 · +49/−16.5** |
| Parts exact (of 732) | 579 | 635 | 659 | 661 | 671 | 613 | 643 | 643 | 660 |

**Run failures.**
- **Round 1:** Flash's 104 first-attempt failures there (DeepSeek's outage) are
  scored with their re-asked answers.
- **Round 2:** it had no transport failures. Each model's main run returned 2
  empty replies, both maths parts whose thinking used up the 8,000-token limit
  (see [Failures](#failures)). They count as wrong.

## Which change moved what

Two ablations ran beside the main round-2 runs:
- **Maths without thinking** (`*-r2-math-nothink`): the round-2 prompt without
  thinking on the maths set.
- **Round 2 without the reference block** (`*-r2-noref`, `--no-reference`), on the
  four sets with the most reference material: contract, maths (with thinking),
  HKDSE Chinese, and the original Chinese passages.

Items exact, then marks over/under:

| Set | Flash r1 | Flash r2, no thinking on maths | Flash r2, no reference | **Flash r2** | 0731 r1 | 0731 r2, no thinking on maths | 0731 r2, no reference | **0731 r2** |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Maths (335) | 284 · +19/−21.5 | 303 · +7.5/−14 | 312 · +6/−7.5 | 312 · +4/−6.5 | 273 · +30.5/−15 | 296 · +16.5/−15.5 | 320 · +0.5/−6 | 319 · +2.5/−6 |
| Contract (464) | 449 · +4.5/−4.5 | | 448 · +5.5/−5 | 445 · +5/−6.5 | 440 · +10.5/−4 | | 432 · +13.5/−5 | 438 · +11.5/−5.5 |
| HKDSE Chinese (209) | 184 · +19.5/−0.5 | | 194 · +10/−0.5 | 191 · +12/−0.5 | 171 · +28/−0.5 | | 179 · +24.5/−0.5 | 176 · +22.5/−1 |
| DSE-style Chinese, original (160) | 147 · +3.5/−1.5 | | 153 · +4/−2 | 154 · +3.5/−1.5 | 153 · +6.5/−0 | | 156 · +4.5/−0 | 157 · +3/−2 |

- **Working rules (maths, no thinking):** +19 items for Flash, +23 for 0731. They
  remove the over-credit on bare answers.
- **Thinking on maths, on top of the rules:** +9 for Flash, +23 for 0731. It removes
  most of the over-credit on wrong working and the under-credit on alternative
  methods. 0731 gains far more from thinking than Flash.
- **Reference block:** no consistent effect.
  - Flash with the reference against without: −3 contract, 0 maths, −3 HKDSE
    Chinese, +1 original Chinese.
  - 0731: +6, −1, −3, +1.
  - Every difference is within the run-to-run noise measured in round 1.
  - On HKDSE Chinese both models scored 3 items lower with it. A plausible reason is
    that a quotation which matches the 參考答案's wording looks like content.
- **Reading rules** (round 2 against round 1, no reference involved on IELTS):
  - HKDSE Chinese +10 for Flash and +8 for 0731, measured without the reference.
  - IELTS −3 for Flash and 0 for 0731.
- **Tolerant quote check:** LaTeX +2 for Flash and +4 for 0731, against the strict
  check on the same round-2 replies. Elsewhere it changed nothing.

### Maths: working against final answer, alternative methods

Parts exact, then marks over/under, by answer kind (23 parts per kind; bare_answer
12, wrong_working 11):

| Kind | Jev | Flash r1 | Flash r2, no thinking | **Flash r2** | 0731 r1 | 0731 r2, no thinking | **0731 r2** |
| --- | --- | --- | --- | --- | --- | --- | --- |
| correct | 23 · +0/−0 | 23 · +0/−0 | 23 · +0/−0 | 23 · +0/−0 | 22 · +0/−1 | 22 · +0/−1 | 23 · +0/−0 |
| bare_answer | 0 · +11/−0 | 6 · +4.5/−0 | 12 · +0/−0 | 11 · +1/−0 | 4 · +6.5/−0 | 9 · +2.5/−0 | 11 · +1/−0 |
| wrong_working | 5 · +5/−0 | 4 · +9.5/−0 | 6 · +6/−0 | 9 · +1/−0 | 2 · +12/−0 | 6 · +10/−0 | 10 · +0/−0 |
| slip | 12 · +2/−11 | 9 · +4/−6.5 | 12 · +1/−7 | 15 · +1/−5 | 8 · +6.5/−4 | 11 · +3.5/−5.5 | 17 · +1/−4 |
| alt_method | 10 · +0/−13 | 13 · +0/−15 | 18 · +0/−7 | 21 · +0/−1.5 | 15 · +0/−10 | 15 · +0/−9 | 21 · +0/−2 |
| nonsense | 21 · +2/−0 | 21 · +1/−0 | 22 · +0.5/−0 | 21 · +1/−0 | 19 · +5.5/−0 | 22 · +0.5/−0 | 22 · +0.5/−0 |

- **Valid alternative methods are now credited.** Long division for 2022 Q14(a), and
  the coordinate and similarity routes in the 2023–2024 geometry parts, were the
  round-1 failures. With thinking on, both models lose at most 2 marks across 23
  parts.
- **Wrong working after a right answer no longer pays.** Without thinking it still
  earned 6–10 marks across 11 parts; with thinking, 0–1.
- **Slips are still the hardest kind** (15 and 17 of 23 parts exact). The remaining
  errors are mostly under-credit: an M mark lost after a slip, where the HKEAA rule
  keeps it.
- **Against round 1, item by item.** Flash's round-2 maths is right where round 1
  was wrong on 35 items, and the reverse on 4. For 0731 it is 51 against 4.

### Chinese reading: quoting without explaining

HKDSE Chinese reading, 15 `quote_only` answers (gold 0 on every item), parts
exact, then marks over-credited:

| Jev | Flash r1 | Flash r2 | Flash r2+c | 0731 r1 | 0731 r2 | 0731 r2+c |
| --- | --- | --- | --- | --- | --- | --- |
| 6 · +14.5 | 8 · +10 | 10 · +5.5 | 12 · +4 | 6 · +16 | 9 · +10 | 11 · +6 |

- **The 只抄原文而未解釋不給分 rule roughly halves the over-credit.** It does not
  remove it.
- **On the original passages,** `quote_only` over-credit fell from 4.5 to 2 for 0731
  and stayed at 2 for Flash.
- **Other answer kinds barely moved** (partial, paraphrase, misread). The set's
  remaining over-credit is spread across them: Flash r2+c 11.5 marks, 0731 r2+c
  18.5.

### IELTS: pasted paragraphs and copied answers

| Kind (parts) | Jev | Flash r1 | Flash r2 | 0731 r1 | 0731 r2 | 0731 r2+c |
| --- | --- | --- | --- | --- | --- | --- |
| copied_dump (3) | 0 · +7 | 3 · +0 | 3 · +0 | 0 · +7 | 0 · +7 | 0 · +7 |
| copied_correct (13) | 10 · +1/−0.5 | 13 · +0/−0 | 12 · +0/−2 | 13 · +0/−0 | 13 · +0/−0 | 13 · +0/−0 |
| copied_wrong (13) | 12 · +0.5 | 13 · +0 | 13 · +0 | 13 · +0 | 13 · +0 | 13 · +0 |

- **0731 still credits pasted paragraphs.** These are parts that state copying
  whole paragraphs earns nothing. The own-words rule did not change that, with or
  without thinking.
- **The explain rule cost Flash 2 marks** on a correct copied answer. The IELTS
  fixture accepts copying the right sentence unless the item asks for own words;
  the DSE rule does not. Scope rule 15 to items that say explain, or to Chinese
  reading, or accept that loss.

### Side effects outside maths and reading

- **Contradictions in the held-out partial-credit set.** These answers state the
  right first half of an item, then contradict the second, so the gold is zero.
  0731's round-2 replies apply "items before the first wrong step stand" to them.
  Exact parts fell from 7 of 11 to 2 of 11, giving half credit ("only first half
  correct; second contradicts"). The cascade brings it back to 10 of 11. Flash
  was unaffected (10 of 11).
- **Keyword-stuffed essays.** These use rubric words in sentences without the
  points. 0731 round 2 over-credits them by 5 marks (round 1: 0); the cascade brings
  that to 1.5. 0731 also joined quotes with "…" on 5 music and language items,
  zeroing right answers.
- **Contract.** Flash fell from 449 to 445 and 0731 from 440 to 438, almost all on
  partial and injection answers, under-credited. Against round 1, Flash's round-2
  decisions changed on 12 contract items: 3 for the better and 7 for the worse.
  That is within run noise.
- **Injection.** Still no grader gives a pure injection credit (27 of 27 at zero).
  0731 round 2 over-credited one contract injection answer by half a mark. Flash
  flagged 53 of 54 injection answers as suspected and 0731 51.

### Tolerant quote check

| Round 2, items exact | Flash: strict match / tolerant match | 0731: strict / tolerant |
| --- | --- | --- |
| LaTeX (40) | 36 / 38 | 35 / 39 |
| Every other set | identical | identical |

- **Flash had no quote failure** under the tolerant match in 1,946 items.
- **0731 had 9.** 8 deserved credit (5 of them "…"-joined quotes on essays), and 1
  was rightly zeroed.
- **The check now removes almost nothing.** It is an evidence field, not a filter.
  The plan already treats it that way.

## Cascade on round 2

| | Flash r2 | 0731 r2 |
| --- | ---: | ---: |
| Flagged non-maths parts (items) | 165 (396) | 171 (408) |
| Items exact: first answer → thinking sample | 361 → 372 | 350 → 385 |
| Items fixed / broken | 18 / 7 | 41 / 6 |
| Parts exact: first → thinking | 135 → 145 | 132 → 149 |
| Sample cost, total | $0.082 | $0.038 |
| Sample latency p50 / p95 | 1.8 / 7.4 s | 3.3 / 10.8 s |
| Failures | 0 | 0 |

- **0731 gains more from the cascade, as in round 1.** +35 items against Flash's
  +11, because its first answers are worse.
- **The cascade repairs most of 0731's new side effects:** contradictions,
  keyword-stuffed essays and the contract partials.

## Cost and latency

Per part, all 732 answers:

| | Jev | Flash r1 | **Flash r2** | **Flash r2+c** | 0731 r1 | **0731 r2** | **0731 r2+c** |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Mean cost | $0.000064 | $0.00024 | $0.00052 | $0.00063 | $0.00012 | $0.00019 | $0.00024 |
| Credits (at $0.0005) | 0.13 | 0.48 | 1.04 | 1.26 | 0.24 | 0.37 | 0.48 |
| Maths part (thinking) | | $0.00030 (no thinking) | $0.0019 | $0.0019 | $0.00014 (no thinking) | $0.00050 | $0.00050 |
| Other parts | | ≈ $0.00023 | ≈ $0.00027 | ≈ $0.00040 | ≈ $0.00012 | ≈ $0.00013 | ≈ $0.00019 |
| Latency p50 / p95, all parts | 0.68 / 1.04 s | 1.94 / 10.3 s* | 1.58 / 8.9 s | | 1.91 / 3.7 s | 1.97 / 12.3 s | |
| Latency p50 / p95, maths | 0.70 / 0.95 s | 1.92 / 7.5 s | 5.4 / 30.1 s | | 1.93 / 2.9 s | 6.9 / 42.6 s | |

\* Round 1's Flash latency includes DeepSeek's outage window. Without it, p50 was
1.94 s and p95 4.0 s.

- **Round 2 makes non-maths prompts longer.** The rules and the reference add about
  400–500 input tokens per part (Flash 1,022 → 1,511, 0731 1,079 → 1,488). `steps`
  adds output. Most input is cached (78% for Flash, 72% for 0731), so non-maths
  cost rises only from about $0.00023 to $0.00027 (Flash) and $0.00012 to $0.00013
  (0731).
- **Thinking on maths averaged about 1,200 reasoning tokens** for both models, with
  a p95 of about 4,000.
- **Maths without thinking is the cheap option:** about $0.00045 (Flash) or
  $0.00017 (0731) per part, at 1.9 s.
- **In credits, maths with thinking costs 3.8 for Flash and 1.0 for 0731.**
- **A maths Check needs a longer wait.** The 30–43 s p95 needs the Check button's
  waiting state, and the server's 30 s grading timeout, to allow about 60 s.

## Failures

- **Round 2 had no transport failures on either route.** That is 2,888 calls, all
  between 11:13 and 11:54 UTC (19:13–19:54 in Hong Kong). Round 1's DeepSeek
  outage was at about 17:00 Hong Kong time; one quiet evening does not show it is
  solved.
- **Empty replies:** 7 calls, all maths with thinking. They hit the 8,000-token
  output limit with `finish_reason: length`: Flash 2 + 1, 0731 2 + 2, across the
  main and no-reference runs. Every one is a 2022, 2024 or 2025 Q8 geometry part
  (wrong-working, alternative-method or slip answers). Raise the limit for
  thinking (about 16k), or treat a length stop as "needs the teacher".
- **No other malformed replies.** Neither model returned a malformed reply without
  thinking, in round 1 or round 2.

## Limitations

- Everything in round 1's limitations still applies: AI-written labels, small
  injection and sensitive sets, binary truth on the held-out rubric essays, and
  latency measured from a Mac.
- The prompt changes were specified before the run and not tuned on these results.
  They do, however, encode the same conventions the maths and Chinese fixtures were
  labelled with (HKEAA M/A/ft; 只抄錄原文不給分). Some of the gain is the prompt
  agreeing with the labeller.
- Rounds 1 and 2 ran about two hours apart, so differences of a few items on any
  set are within noise. Round 1 measured 1–5 changed decisions in 116 on an
  identical repeat.
- The maths references for 2023 and 2025 are not official, and the reference had no
  measurable effect.
- The no-reference ablation covers four sets, not all ten.

## Recommendation

1. **Use direct `deepseek-flash` with the round-2 prompt:**
   - thinking at low effort on maths parts;
   - non-maths parts without thinking;
   - one thinking-low sample on flagged non-maths parts;
   - the tolerant quote match.

   It is the best grader measured: 1,870 of 1,946 items (96.1%), 28.5 unearned
   marks, 21 marks under-credited. That costs about $0.00063 a part (1.3 credits),
   or $0.0019 for a maths part.
2. **0731 with the same setup** reaches 1,859 items for $0.00024 a part, a third of
   the cost, and had no availability failures in either round. Choose it only if
   cost or availability outweigh about 20 more unearned marks per 1,946 items:
   - pasted IELTS paragraphs, 7 marks that no setting fixed;
   - DSE Chinese reading, 7 more marks than Flash;
   - contract partial and rambling answers, 5 more.

   It is also the natural fallback when DeepSeek's API refuses or times out, if Epo
   signs off a fallback. The same prompt runs on both, so the switch costs nothing
   to build.
3. **Prompt adjustments before switching:**
   - **The explain rule:** scope rule 15 to items that ask for an explanation or
     own words, or to Chinese reading. As written it zeroed a correct copied IELTS
     answer.
   - **Steps and contradictions:** limit the steps rules (10–11) to calculation
     and proof working. That stops 0731 reading contradictions as "right until the
     first wrong step".
   - **The reference block:** keep it only if it is free. It did not help here, and
     on DSE Chinese it may make copied wording look like content.
   - **Thinking limit:** raise it to about 16k tokens, or treat `length` as needing
     the teacher.
4. **Maths still needs the owner's approval on assignments,** even at 93–95% item
   agreement.
   - Slips, the M mark after a wrong value, are the weakest kind.
   - A maths Check with thinking can take 30–40 s at p95.
   - Cheaper option: the round-2 rules without thinking keep most of the gain on
     bare answers (Flash 303 of 335 items) at 1.9 s and $0.00045 a part. Wrong
     working and alternative methods still need thinking.

## Provenance

Runs are in the ignored `data/grading-benchmark/deepseek-grading-20261103-r2/` of the
bench worktree. Committed records: `2026-11-03-mac-round2/` (on `claude/bench-deepseek-grading-4a344d`),
one line per call plus each run's manifest. Its `summary.json` covers round 1 and
round 2 together; round 1's records are in `2026-11-03-mac/` (on `claude/bench-deepseek-grading-4a344d`).

| Run | Grader | Calls | Input / cached / output / reasoning tokens | Cost | Started (UTC) |
| --- | --- | ---: | --- | ---: | --- |
| `flash-r2` | deepseek-flash | 732 | 1,118,948 / 878,206 / 251,561 / 136,140 | $0.379 | 11:13 |
| `0731-r2` | deepseek-0731 | 732 | 1,099,254 / 796,416 / 265,884 / 141,460 | $0.137 | 11:22 |
| `flash-r2-math-nothink` | deepseek-flash | 115 | 183,967 / 136,960 / 30,343 / 0 | $0.051 | 11:33 |
| `flash-r2-noref` | deepseek-flash | 424 | 670,680 / 569,472 / 214,354 / 140,402 | $0.291 | 11:34 |
| `flash-r2-cascade` | deepseek-flash | 165 | 241,225 / 189,184 / 53,990 / 34,369 | $0.082 | 11:40 |
| `0731-r2-math-nothink` | deepseek-0731 | 115 | 181,322 / 94,464 / 26,990 / 0 | $0.020 | 11:42 |
| `0731-r2-noref` | deepseek-0731 | 424 | 658,053 / 497,664 / 225,987 / 149,539 | $0.099 | 11:43 |
| `0731-r2-cascade` | deepseek-0731 | 171 | 241,562 / 194,816 / 90,782 / 70,079 | $0.038 | 11:51 |
| pilot (LaTeX, 5 × 2) | both | 10 | 13,641 / 3,584 / 1,701 / 0 | $0.003 | 11:13 |
| **Total** | | **2,888** | **4,408,652 / 3,360,766 / 1,161,592 / 671,989** | **$1.10** | |

Keys were read from `deploy/.env.uat` into memory, as in round 1. A search of the run
directories, the committed records and the fixtures for each key's first ten
characters found nothing. 0731 was served by Reka, DigitalOcean and StreamLake in the
pinned order.

## Reproduction

```sh
S=bench/grading/scripts/deepseek_grading.py
D=data/grading-benchmark/deepseek-grading-<fresh>
E=deploy/.env.uat
for g in flash 0731; do
  python $S run --grader deepseek-$g --sets all --prompt r2 --thinking-sets math --label $g-r2 --env $E --output $D/$g-r2
  python $S run --grader deepseek-$g --sets math --prompt r2 --label $g-r2-math-nothink --env $E --output $D/$g-r2-math-nothink
  python $S run --grader deepseek-$g --sets contract,math,reading_zh,reading_zh_original --prompt r2 --no-reference --thinking-sets math --label $g-r2-noref --env $E --output $D/$g-r2-noref
  python $S run --grader deepseek-$g --sets all --prompt r2 --thinking low --samples 1 --borderline-from $D/$g-r2 --label $g-r2-cascade --env $E --output $D/$g-r2-cascade
done
python $S report --runs <round 1 runs> $D/flash-r2 $D/0731-r2 $D/flash-r2-math-nothink $D/0731-r2-math-nothink $D/flash-r2-noref $D/0731-r2-noref $D/flash-r2-cascade $D/0731-r2-cascade --output $D/summary.json
```

`--prompt r1` (the default) reproduces round 1 byte for byte. `--dry-run` prints the
planned calls, the number of parts with a reference and a sample user message.
