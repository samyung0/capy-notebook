# DeepSeek grading, round 3: answer rules, V4.1 Flash on OpenRouter

Round 3 of the DeepSeek grading bench, after the plan's "Answer rules apart from the
marking points" (`todo-study-tracking.md` §9, board R1). It follows
[round 1](2026-11-03-deepseek-grading.md) and [round 2](2026-11-03-deepseek-grading-round2.md).
The answer sets and labels are unchanged.

**Round 3 runs on two models:**
- 0731;
- `deepseek/deepseek-v4.1-flash`, new, on OpenRouter.

Direct Flash with the round-2 prompt is the reference; it was not rerun.

**The setup is round 2's:** thinking at low effort on maths, and one thinking-low
sample on flagged parts. It changes in three ways:
- answer rules, moved out of the question and item text;
- a code copy check that never reaches the model;
- round 2's own suggestions.

**Findings:**
- **V4.1 Flash now matches direct Flash, and beats it on unearned marks.**
  - The comparison uses the passage-coverage copy check (below).
  - V4.1 Flash on round 3 matched 1,877 of 1,946 items (96.5%), with 21.5 unearned
    marks.
  - Direct Flash on round 2, cascade included, matched 1,870 with 28.5 unearned.
  - V4.1 Flash costs $0.00022 a part against $0.00063, with a median latency of
    1.1 s.
  - On the sets the answer rules don't touch, V4.1 Flash is as good as direct Flash
    by itself: 1,390 items against 1,379.
  - Its own cascade adds 3 items and 4.5 unearned marks, so it isn't needed.
- **0731 does not match.**
  - Round 3 leaves it at 1,826 items with 58 unearned marks (1,857 and 47 with the
    cascade).
  - That is about twice direct Flash's unearned marks.
  - The answer rules fixed its two reading failures, but its contract, essay and
    original-Chinese scores fell slightly.
- **The answer rules fix both reading failures:**
  - **Pasted IELTS paragraphs:** these now score 0 for both models. 0731 gave them
    7 marks in round 2.
  - **DSE Chinese answers that only quote the passage:**
    - 12 of the 15 are scored 0 by the copy check before any model call;
    - V4.1 Flash gives the remaining 3 nothing;
    - 0731 gives them 1.5 marks, down from 10.
- **The copy check needs two measures.**
  - **Share of the answer copied** (the specified measure, at 0.7) is right for
    DSE 只抄原文而未解釋. It caught 12 of 15 quote-only answers with no false hit
    on 80 answers.
  - It is wrong for IELTS "copying out whole paragraphs". Every fully copied
    answer scores 100%, including 3 that correctly lift one sentence, at every
    threshold from 0.5 to 0.9. Those 3 false hits cost 7 marks per model.
  - **Share of the passage copied** (≥ 0.5) catches all 3 pasted paragraphs with
    no false hit.
- **Model-judged own-words rules were applied 10 times, all rightly.**
  - V4.1 Flash broke 7 (6 IELTS, 1 DSE), 0731 4 (3 IELTS, 1 DSE). Every one is an
    answer whose gold is 0.
  - Neither model applied an own-words rule to an answer that earns marks.
- **Round 2's suggestions:**
  - **16k thinking limit:** no empty maths replies, against 2 per model in round 2.
    0731's maths tail grew to 67 s at p95 and 142 s at most.
  - **Step rules scoped to calculations and proofs:** this partly undid 0731's
    contradiction side effect (2 of 11 exact back to 6 of 11).
  - **Explain rule scoped:** no correct copied IELTS answer was lost to it.
  - **Dropping the reference:** cost 0731 about 5 contract items, as round 2's
    no-reference ablation predicted (−6). V4.1 Flash showed no loss.
- **Cost and latency:**
  - V4.1 Flash: $0.00022 a part, p50 1.1 s, p95 7.2 s (maths 5.0 s / 33 s), on
    Wafer's mxfp4 US endpoint for 705 of 710 calls.
  - 0731: $0.00020 a part, p50 2.2 s, p95 21.5 s.
  - The 58 parts the copy check scored cost nothing and return at once.

- **The dated pin `deepseek/deepseek-v4.1-flash-1017` matches as well.** This is the
  captioning and extraction pin, on the pipeline's InferenceNet → Cloudflare order.
  - On the contract, maths, IELTS and HKDSE Chinese sets it matched 1,104 of 1,149
    items, the same as V4.1 Flash on Wafer. It gave 16.5 unearned marks against
    Wafer's 15, and direct Flash round 2 gave 22.
  - It is slower: maths p50 11 s, p95 57 s, and a 156 s tail.

Recommendation, in full [below](#recommendation): grade with 1017 on the pipeline's
route, using the round-3 prompt, answer rules and the code copy check with the two
measures, without a cascade. One model then serves grading, extraction and captions.
Set the maths timeout for InferenceNet's tail.

Round 3 cost $0.57 for 2,356 model calls, including the 1017 check. All three
rounds together cost $2.36.

## What changed

**Answer rules.** `deepseek-grading-rules.json` (on `claude/bench-deepseek-grading-4a344d`)
names 22 parts of the existing fixtures. For each, it moves the instructions about
the answer as a whole out of the question text and item texts (exact replace pairs,
asserted present) into a `rules` list. Each rule has:
- a kind: `copy_passage`, `word_limit`, `own_words` or `custom`;
- a check: code or model;
- a penalty: no marks, or deduct N.

The rule fixture leaves the original fixtures untouched, so rounds 1–2 still
reproduce. Gold labels are unchanged; the fixtures were labelled with these
conventions.

| Set | Parts | Rules | Moved out of |
| --- | ---: | --- | --- |
| IELTS | 3 | copy, code, no marks ("copying out whole paragraphs earns no marks") | the part text |
| IELTS | 3 | own words, model, no marks ("in your own words … do not copy phrases") | the part text and 6 items ("Explains in own words, not copied from the passage, …") |
| HKDSE Chinese (2020–21) | 15 | copy, code, no marks (只抄錄原文而未有解釋，不給分) | 7 items' 只引錄 / 摘錄原文 notes |
| HKDSE Chinese (2020–21) | 4 | own words, model, no marks (以自己的文句) | the part text |
| DSE-style Chinese, original | 1 | copy (code) + own words (model, 須以白話說明), both no marks | 2 items |

- **Word limits:** no fixture states a word or character limit, so the `word_limit`
  check exists in code but has nothing to run on.
- **The original classical passage's part (d)** keeps its 只抄錄 note inside the
  item. A quote-only answer there still earns the part's 引用 mark, so a
  whole-part "no marks" rule would be wrong.

**Rules checked in code, never sent to the model.**
- **Copy check:** the share of the answer's letters, digits and CJK characters that
  sit in runs of 8 or more words, or 12 or more CJK characters, also found in the
  stem's passage text. Matching is after NFKC, case folding and whitespace collapse.
- **Threshold:** 0.7.
- **Penalty:** a broken no-marks rule scores the part 0 with no model call.
- **The `--copy-alt` arm** applies a second measure to the three IELTS
  whole-paragraph rules: the share of the passage copied into the answer, at 0.5.

**Rules judged by the model.**
- **Placement:** an `<answer_rules>` block (`r0: …`) before `<marking_items>`.
- **Reply:** the model reports `{"id", "kept", "quote"}` for each rule before the
  items, and is told not to apply penalties or let rules change its item choices.
- **Applying the penalty:** code applies it when a rule is reported broken with a
  quote found in the answer (the same tolerant match as item quotes). A broken rule
  without evidence is not applied.
- **Second look:** a broken rule also flags the part for the cascade.

**Prompt** (`SYSTEM_PROMPT_R3`, `--prompt r3`). Round 2's prompt, plus the
answer-rules section and round 2's own suggestions:
- **no reference block;**
- **working rules 9–14** limited to "calculations, algebra and proofs; not … written
  explanations or arguments";
- **reading rule 15** limited to items that themselves ask for an explanation. It
  also says copying the right words is fine where an item only asks to identify a
  point;
- **the own-words rule (old 16) removed:** it now arrives as an answer rule;
- **thinking limit** raised to 16,000 tokens.

**Models.**
- **0731:** as before; Reka served 708 of 710 calls and DigitalOcean 2.
- **V4.1 Flash:** `deepseek/deepseek-v4.1-flash` with provider order `wafer/us`,
  then `inference-net/fp8`, fallbacks off. `wafer/us` lists $0.045 / $0.012 /
  $0.50 per million input / cached / output tokens, at mxfp4. InferenceNet (fp8)
  is the provider of the 1017 captioning pin. Wafer served 705 calls and InferenceNet
  5.
- **Thinking:** low effort, through OpenRouter's `reasoning`.

## Results by set

Items exact, then marks over-credited / under-credited. "+c" adds the one-sample
thinking cascade. Direct Flash is round 2.

| Set (items) | Jev | Flash r2 | Flash r2+c | 0731 r2 | 0731 r2+c | **0731 r3** | 0731 r3+c | **V4.1 Flash r3** | V4.1 Flash r3+c |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Contract (464) | 435 · +11/−5.5 | 445 · +5/−6.5 | 449 · +6/−4.5 | 438 · +11.5/−5.5 | 443 · +11/−3.5 | 433 · +14/−5 | 438 · +15.5/−2.5 | 449 · +6/−3.5 | 448 · +7.5/−4 |
| LaTeX (40) | 37 · +1/−1 | 38 · +0/−1 | 38 · +0/−1 | 39 · +0/−0.5 | 38 · +1/−1 | 40 · +0/−0 | 39 · +1/−0 | 40 · +0/−0 | 40 · +0/−0 |
| Held-out partial credit (66) | 65 · +0/−0.5 | 64 · +0.5/−0.5 | 64 · +0.5/−0.5 | 55 · +5.5/−0.5 | 63 · +1.5/−0.5 | 59 · +3.5/−0.5 | 63 · +1.5/−0.5 | 64 · +0.5/−0.5 | 64 · +0.5/−0.5 |
| Held-out rubric essays (384) | 347 · +14.5/−6 | 380 · +1.5/−1.5 | 381 · +2.5/−0 | 369 · +5.5/−6 | 380 · +1.5/−2 | 366 · +7.5/−4.5 | 381 · +1.5/−1 | 378 · +0.5/−3 | 380 · +2.5/−1 |
| Prompt injection (56) | 54 · +0/−1 | 53 · +0/−2 | 53 · +0/−2 | 54 · +0/−1.5 | 54 · +0.5/−0.5 | 54 · +0/−1.5 | 55 · +0.5/−0 | 54 · +0/−1.5 | 53 · +0/−2 |
| Traditional Chinese (91) | 87 · +1/−1.5 | 87 · +1/−1.5 | 87 · +1/−1.5 | 86 · +2/−0.5 | 86 · +2/−0.5 | 87 · +2/−0 | 85 · +2.5/−0.5 | 86 · +1.5/−1.5 | 85 · +1.5/−2 |
| HKDSE maths (335) | 276 · +20/−24 | 312 · +4/−6.5 | 312 · +4/−6.5 | 319 · +2.5/−6 | 319 · +2.5/−6 | 316 · +6/−8.5 | 316 · +6/−8.5 | 319 · +3.5/−8 | 319 · +3.5/−8 |
| IELTS reading (141) | 124 · +8.5/−4 | 135 · +1/−3 | 137 · +0/−3 | 131 · +8/−1 | 131 · +7.5/−1.5 | 130 · +1.5/−8 | 132 · +0/−8.5 | 129 · +1/−10.5 | 129 · +1/−10.5 |
| IELTS, passage-coverage copy check | | | | | | 137 · +1.5/−1 | | 137 · +0.5/−1.5 | |
| HKDSE Chinese reading (209) | 155 · +28.5/−2 | 191 · +12/−0.5 | 194 · +11.5/−0.5 | 176 · +22.5/−1 | 188 · +18.5/−0.5 | 182 · +17/−1 | 188 · +14.5/−2 | 199 · +5/−1 | 201 · +6/−0.5 |
| DSE-style Chinese, original (160) | 150 · +4.5/−3 | 154 · +3.5/−1.5 | 155 · +3/−1.5 | 157 · +3/−2 | 157 · +3/−0.5 | 152 · +6.5/−0.5 | 154 · +4/−1.5 | 151 · +4/−2 | 153 · +4/−2 |

Totals (1,946 items, 732 parts). The "passage coverage" rows replace the IELTS
answers with the `--copy-alt` runs:

| Setup | Items exact | Unearned / missed marks | Parts exact | Cost per part | Latency p50 / p95 |
| --- | ---: | --- | ---: | ---: | --- |
| Jev | 1,730 (88.9%) | +89 / −48.5 | 579 | $0.000064 | 0.68 / 1.04 s |
| Direct Flash r2 | 1,859 (95.5%) | +28.5 / −24.5 | 661 | $0.00052 | 1.58 / 8.9 s |
| **Direct Flash r2 + cascade (reference)** | **1,870 (96.1%)** | **+28.5 / −21** | **671** | **$0.00063** | |
| 0731 r2 + cascade | 1,859 (95.5%) | +49 / −16.5 | 660 | $0.00024 | |
| 0731 r3 | 1,819 (93.5%) | +58 / −29.5 | 634 | $0.00020 | 2.24 / 21.5 s |
| 0731 r3, passage coverage | 1,826 (93.8%) | +58 / −22.5 | 638 | $0.00020 | |
| 0731 r3, passage coverage + cascade | 1,857 (95.4%) | +47 / −18 | 657 | $0.00027 | |
| V4.1 Flash r3 | 1,869 (96.0%) | +22 / −31.5 | 670 | $0.00022 | 1.14 / 7.2 s |
| **V4.1 Flash r3, passage coverage** | **1,877 (96.5%)** | **+21.5 / −22.5** | **674** | **$0.00022** | **1.14 / 7.2 s** |
| V4.1 Flash r3, passage coverage + cascade | 1,880 (96.6%) | +26 / −21.5 | 676 | $0.00028 | |

## Pasted paragraphs and quote-only answers

| | Jev | Flash r2 | 0731 r2 | 0731 r3 | V4.1 Flash r3 |
| --- | --- | --- | --- | --- | --- |
| IELTS `copied_dump`, parts exact (of 3), marks over | 0 · +7 | 3 · +0 | 0 · +7 | 3 · +0 | 3 · +0 |
| IELTS `copied_correct` (of 13), marks under | 10 · −0.5 | 12 · −2 | 13 · −0 | 10 · −7 | 9 · −9 |
| … with the passage-coverage copy check | | | | 13 · −0 | 13 · −0 |
| HKDSE Chinese `quote_only` (of 15), marks over | 6 · +14.5 | 10 · +5.5 | 9 · +10 | 13 · +1.5 | 15 · +0 |
| Original Chinese `quote_only` (of 7), marks over | 5 · +2.5 | 6 · +2 | 6 · +2 | 4 · +4 | 6 · +2 |

- **The code copy check caught all three pasted paragraphs.** It also caught 12 of
  the 15 DSE quote-only answers, so none of these reached the model.
- **The three quote-only answers it let through** copy too little:
  - one is under 12 CJK characters long;
  - one copies two pieces of 11 and 6 characters, each shorter than a run;
  - one has a 0.66 share.
- **The models handled the rest:** V4.1 Flash gave them nothing, and 0731 gave one
  of them 1.5 marks.
- **Original passages:** 0731 r3 over-credited its quote-only answers more than in
  round 2 (+4 against +2). All of it is on parts without a copy rule.
  - Both models give 2 marks to a quote-only answer to the classical translation
    (b), which copies the original sentence instead of translating it. A
    "translate, don't copy" rule would catch it.
  - The other parts' items require a quotation (引用) and keep their own notes.
- **`copied_correct` losses under the specified measure** are all the copy check's
  three false hits (below). With the passage-coverage measure, both models score
  13 of 13.

## The copy check: hits and false hits

On every answer to a part with a copy rule. A hit is right when the gold part score
is 0. No model is involved.

| Set (answers with a copy rule; gold 0) | Measure, threshold | Hits | Right | False |
| --- | --- | ---: | ---: | ---: |
| IELTS (18; 9) | answer share, any threshold from 0.5 to 0.9 | 9 | 6 | 3 |
| IELTS | **passage coverage ≥ 0.5** | 3 | 3 | 0 |
| HKDSE Chinese (80; 31) | answer share ≥ 0.5 or 0.6 | 13 | 13 | 0 |
| HKDSE Chinese | **answer share ≥ 0.7** | 12 | 12 | 0 |
| HKDSE Chinese | answer share ≥ 0.9 | 11 | 11 | 0 |
| DSE-style Chinese, original (4; 1) | answer share ≥ 0.7 | 1 | 1 | 0 |

- **Answer share has no right threshold for IELTS "copying out whole paragraphs".**
  - A correct answer that lifts the right sentence is as copied (100%) as a pasted
    paragraph.
  - The 3 false hits are `copied_correct` answers to motivation, rockets and birds
    (gold 2–3 marks each).
  - The 3 extra right hits are `copied_wrong` answers, whose gold is 0 anyway.
- **Passage coverage separates the IELTS cases cleanly.**
  - Pasted paragraphs cover 64–100% of the excerpt.
  - Copied sentences, right or wrong, cover 23–35%.
- **For DSE Chinese, answer share is the right measure.**
  - Quote-only answers copy short sentences: 66–100% of the answer, but only 4–67%
    of the passage.
  - Real answers that quote evidence stay at 13% or below.
  - 0.6 catches one more quote-only answer than 0.7 with no false hit; 0.7 is the
    safer starting point.
- **Two measures for two rules.**
  - "Don't just copy without explaining" is answer share ≥ 0.7.
  - "Don't copy whole paragraphs" is the share of a passage paragraph copied, ≥ 0.5.
    Here the excerpt is the paragraph. In real papers it should be measured per
    paragraph of the stem, not over the whole stem.

## Rules judged by the model

| Set | Rule | 0731: reported broken / applied / right | V4.1 Flash |
| --- | --- | --- | --- |
| IELTS (15 answers) | own words | 3 / 3 / 3 | 6 / 6 / 6 |
| HKDSE Chinese (19 answers) | 以自己的文句 | 1 / 1 / 1 | 1 / 1 / 1 |
| Original classical (c) (3 answers sent) | 須以白話說明 | 0 | 0 |

**Every applied break is an answer whose gold is 0.**
- **V4.1 Flash's six IELTS breaks** are the 3 correctly copied and 3 wrongly copied
  answers to the own-words parts. 0731 flagged only the 3 correctly copied ones. The
  wrongly copied answers score 0 anyway.
- **No break was reported without evidence.**
- **No rule was applied to an answer that earns marks.**

**The rules change few marks**, because the item choices already gave these answers
none. Their value is the explicit reason: "rule broken: own words", which the results
screen in board R1 shows.

## Effects of round 2's suggestions

- **16k thinking limit:**
  - no empty maths replies in 230 maths calls (round 2: 4 in 230);
  - maths reasoning is longer: 0731 maths p50 11.7 s and p95 67 s (max 142 s);
    V4.1 Flash maths p50 5.0 s and p95 33 s;
  - the server timeout and Check waiting state need to allow for the tail. A hard
    60 s cut would fail 8 of 115 of 0731's maths parts (7%) and none of V4.1
    Flash's.
- **Step rules limited to calculations and proofs:** 0731's contradictions in the
  held-out partial-credit set went from 2 of 11 exact (round 2) to 6 of 11 (round 1
  was 7). V4.1 Flash got 10 of 11. Maths was unaffected: alternative methods lose
  2–2.5 marks across 23 parts, wrong working gains 0.5–2.5.
- **Explain rule limited to items that ask for it:** with the passage-coverage copy
  check, no correct copied IELTS answer is lost (13 of 13 for both models). In
  round 2 Flash lost 2 marks to the unscoped rule.
- **Dropping the reference:**
  - **0731's contract:** 438 → 433 and rambling-answer over-credit +5 → +6.5. That
    matches round 2's ablation, where removing the reference cost 0731 6 contract
    items.
  - **Elsewhere:** no consistent change.
  - **V4.1 Flash:** has no round-2 run to compare against. Its contract (449) equals
    direct Flash's best.

## Does 0731 or V4.1 Flash now match direct Flash?

**V4.1 Flash does.**
- **Overall:** with the passage-coverage copy check it matched 1,877 items, with 21.5
  unearned and 22.5 missed marks. The direct Flash reference (round 2 plus cascade)
  matched 1,870, with 28.5 unearned and 21 missed.
- **The rules aren't what puts it there.** On the seven sets the answer rules
  don't touch, V4.1 Flash round 3 matched 1,390 items against direct Flash round
  2's 1,379:

  | Set | Direct Flash r2 | V4.1 Flash r3 |
  | --- | ---: | ---: |
  | Contract | 445 | 449 |
  | Maths | 312 | 319 |
  | Held-out partial credit | 64 | 64 |
  | Held-out rubric essays | 380 | 378 |
  | Injection | 53 | 54 |
  | Traditional Chinese | 87 | 86 |
  | LaTeX | 38 | 40 |

- **Real Chinese reading:** it is the best grader measured (199 of 209 items, 5
  unearned marks).
- **Injection:** all 27 pure injections at 0 and no over-credit on any of the 54
  injection answers.
- **Cascade:** it fixes 17 items and breaks 14, so it adds little.
- **Caveat:** direct Flash was not run with the round-3 prompt. Part of V4.1 Flash's
  reading gain (pasted paragraphs, quote-only answers) comes from the rules and the
  copy check, which would help direct Flash too.

**0731 does not.**
- **With the cascade:** 1,857 items and 47 unearned marks, about 1.7 times direct
  Flash's.
- **Before the cascade:** 1,826 and 58.
- **Where its unearned marks remain:**
  - contract answers, mostly partial and rambling: 14 marks, 15.5 with the
    cascade;
  - DSE Chinese partial, paraphrase and misread answers: 17;
  - keyword-stuffed essays: 7;
  - original Chinese: 6.5.
- **Injection:** it over-credited 3 contract injection answers by half a mark each
  (real content beside the injection, e.g. "Fertile soil." given full credit). Pure
  injections still scored 0.

## The dated pin: `deepseek/deepseek-v4.1-flash-1017`

After the first round-3 runs, the same setup ran on the captioning and extraction
pin.
- **Setup:** the round-3 prompt and rules, thinking at low effort on maths, no
  cascade.
- **Routing:** the pipeline's provider order (`OPENROUTER_ROUTING`: InferenceNet,
  then Cloudflare, fallbacks off). InferenceNet (fp8) served all 424 calls.
- **Sets:** the contract, maths, IELTS (with the passage-coverage copy check) and
  HKDSE Chinese.

Items exact, then marks over-credited / under-credited:

| Set (items) | Direct Flash r2 | V4.1 Flash, Wafer | **1017, InferenceNet** | 0731 r3 |
| --- | --- | --- | --- | --- |
| Contract (464) | 445 · +5/−6.5 | 449 · +6/−3.5 | 451 · +5/−3.5 | 433 · +14/−5 |
| HKDSE maths (335) | 312 · +4/−6.5 | 319 · +3.5/−8 | 321 · +2.5/−7 | 316 · +6/−8.5 |
| IELTS, passage-coverage copy check (141) | 135 · +1/−3 | 137 · +0.5/−1.5 | 137 · +0.5/−1.5 | 137 · +1.5/−1 |
| HKDSE Chinese reading (209) | 191 · +12/−0.5 | 199 · +5/−1 | 195 · +8.5/−1.5 | 182 · +17/−1 |
| **Four sets (1,149)** | **1,083 · +22/−16.5** | **1,104 · +15/−14** | **1,104 · +16.5/−13.5** | **1,068 · +38.5/−15.5** |
| Parts exact (of 439) | 387 | 400 | 400 | 374 |
| Cost per part, these sets | $0.00069 | $0.00031 | $0.00032 | $0.00027 |
| Latency p50 / p95, contract | 1.5 / 1.8 s | 1.1 / 1.6 s | 2.4 / 3.8 s | 1.9 / 3.6 s |
| Latency p50 / p95, maths | 5.4 / 30.1 s | 5.0 / 33.1 s | 11.0 / 56.6 s | 11.7 / 67.2 s |
| Failures | 2 | 0 | 0 | 0 |

Direct Flash round 2 had no answer rules; its IELTS figure is its round-2 score. Cost
per part is higher here than over all ten sets because maths is a quarter of these
parts.

- **1017 matches V4.1 Flash on Wafer.**
  - Both matched 1,104 of 1,149 items. 1017 gave 1.5 more unearned marks and 0.5
    fewer missed ones.
  - The two agree on 1,122 items. Where they disagree, each is right on 13.
  - Against direct Flash round 2, 1017 is 21 items better with 5.5 fewer unearned
    marks, at under half the cost.
- **Where 1017 is weaker than Wafer:**
  - **HKDSE Chinese partial and paraphrase answers:** +6 marks over, against +3.
  - **One wrong own-words penalty:** it zeroed a partial 2020 Q5(ii) answer that
    restates the 抱薪救火 analogy in modern Chinese (gold 1 mark).
  - **Contract injection answers:** two over-credited by half a mark, on their real
    content. All 6 pure contract injections scored 0.
- **The copy check behaved the same.** It caught the 3 pasted IELTS paragraphs and 12
  DSE quote-only answers, all rightly.
- **InferenceNet is about twice as slow as Wafer.**
  - Contract: p50 2.4 s against 1.1 s.
  - Maths: p50 11 s against 5 s, p95 57 s against 33 s.
  - Its slowest maths part took 156 s, and 4 of 115 took over 60 s.
  - Maths reasoning averaged 1,321 tokens, about the same as on Wafer, so the time
    is the provider's.
  - Cloudflare, the fallback, was never used.
- **Spend:** $0.14 for 424 model calls; the copy check scored the other 15 of
  the 439 parts.

## Cost and latency

| Per part | Jev | Direct Flash r2 | 0731 r3 | V4.1 Flash r3 |
| --- | ---: | ---: | ---: | ---: |
| Mean cost | $0.000064 | $0.00052 | $0.00020 | $0.00022 |
| With cascade | | $0.00063 | $0.00027 | $0.00028 |
| Maths part (thinking) | | $0.0019 | $0.00063 | $0.00092 |
| Other parts | | ≈ $0.00027 | ≈ $0.00012 | ≈ $0.00009 |
| Latency p50 / p95 / max, all parts | 0.68 / 1.04 / 3.3 s | 1.58 / 8.9 / 51 s | 2.24 / 21.5 / 142 s | 1.14 / 7.2 / 39 s |
| Latency p50 / p95, maths | 0.70 / 0.95 s | 5.4 / 30.1 s | 11.7 / 67.2 s | 5.0 / 33.1 s |
| Input cached | | 78% | 70% | 78% |

- **V4.1 Flash is the cheapest model per part outside maths, and the fastest.**
  - It is slightly dearer than 0731 per maths part, because it reasons for more
    output tokens at $0.50 per million.
  - Its overall cost is about 10% above 0731's.
- **Cost in credits (at $0.0005 a credit):** V4.1 Flash 0.45 per part (0.56 with a
  cascade), direct Flash 1.26 with its cascade.
- **Parts skipped by a code rule cost nothing.** That is 22 of 732 per model run,
  plus 3 of 68 per `--copy-alt` arm.
- **Failures:** none in either model's round-3 runs: 0 transport, 0 malformed,
  0 length stops.

## Limitations

- **The rules fixture was written after rounds 1–2.**
  - The rules restate conventions the labels already followed, so they can only
    help where a model ignored them.
  - The passage-coverage measure was chosen after seeing the answer-share false
    hits on these same 18 IELTS answers. It needs fresh answers, and real
    multi-paragraph stems, before it sets a production threshold.
- **Not run:** direct Flash with the round-3 prompt.
- **V4.1 Flash routing:**
  - V4.1 Flash ran on Wafer's mxfp4 endpoint. Quantised providers have garbled
    non-English text in an earlier descriptor bench (gpt-oss-20b), though not here:
    its Chinese results are the best measured.
  - Wafer also stopped serving MiniMax for this project in October.
  - The slug `deepseek/deepseek-v4.1-flash` is an alias. The dated
    `deepseek/deepseek-v4.1-flash-1017`, the captioning pin, was not tested.
- **Sample sizes:** small: 3 pasted paragraphs, 15 + 7 quote-only answers,
  34 own-words answers.
- **As before:** all labels are AI-written and not human-certified.

## Recommendation

1. **Model: `deepseek/deepseek-v4.1-flash-1017`, the round-3 prompt, without a
   cascade.**
   - Route: the pipeline's existing order, InferenceNet then Cloudflare, fallbacks
     off.
   - Thinking at low effort on maths with a 16k limit; no thinking elsewhere.
   - **It matches the alias on Wafer:** 1,104 items on the four sets each.
   - **It beats direct Flash:** 1,104 items against 1,083, with 16.5 unearned marks
     against 22, at under half the cost.
   - **One model for everything:** it is already the captioning and extraction pin,
     so grading, extraction and captions run on one model.
   - Before switching:
     - **Timeout:** set the maths grading timeout for InferenceNet's tail (p95 57 s,
       slowest 156 s), or cap reasoning for grading. Other parts answer in under
       4 s at p95.
     - **Capacity:** give grading its own share of the 1017 gate. Today it holds 40
       calls in flight with 20 reserved for interactive use, shared by captions and
       ghost text (`deploy/model-capacities.sql`).
     - **Usage rows:** record the provider on every one, as for the other pins.
   - **Faster alternative:** the undated alias on Wafer's `wafer/us` endpoint is
     about twice as fast at the same accuracy. It is a second route and a small
     mxfp4 provider, so take it only if latency matters more than one pin.
2. **Answer rules, as in board R1, with the copy check in code:**
   - **"Don't just copy without explaining" (DSE 只抄原文):** answer share ≥ 0.7,
     no marks, no model call.
   - **"Don't copy whole paragraphs":** share of a passage paragraph copied ≥ 0.5,
     measured per paragraph.
   - **"Own words" and other prose rules:** judged by the model in
     `<answer_rules>`. The penalty is applied only with a quote found in the
     answer.
   - **Word limits:** in code; untested here, since no fixture has one.
3. **0731:** not recommended as the grader. Even with every round-3 change and a
   cascade it gives about 1.7 times direct Flash's unearned marks. It is no longer
   the cheaper choice either: V4.1 Flash costs about 10% more and is twice as fast.
4. **Timeouts:** allow about 60–70 s for a maths part with thinking (V4.1 Flash p95
   33 s; 0731's tail reached 142 s). Other parts stay within 10 s at p95.

## Provenance

Runs are in the ignored `data/grading-benchmark/deepseek-grading-20261103-r3/` of
the bench worktree. Committed records: `2026-11-03-mac-round3/` (on `claude/bench-deepseek-grading-4a344d`),
one line per part (code-skipped parts included, marked `skipped`) plus each run's
manifest. Its `summary.json` covers all three rounds, including `copy_check` (the
threshold sweep).

| Run | Grader | Parts | Model calls | Input / cached / output / reasoning tokens | Cost | Started (UTC) |
| --- | --- | ---: | ---: | --- | ---: | --- |
| `0731-r3` | deepseek-0731 | 732 | 710 | 1,075,538 / 754,432 / 304,539 / 190,309 | $0.147 | 14:37 |
| `v41-flash-r3` | deepseek/deepseek-v4.1-flash | 732 | 710 | 1,079,123 / 846,464 / 286,321 / 179,095 | $0.164 | 14:52 |
| `0731-r3-copy-alt` | deepseek-0731 | 68 | 65 | 101,727 / 22,784 / 8,469 / 0 | $0.011 | 14:59 |
| `0731-r3-cascade` | deepseek-0731 | 182 | 182 | 269,235 / 157,184 / 121,222 / 99,181 | $0.051 | 15:00 |
| `v41-flash-r3-copy-alt` | deepseek/deepseek-v4.1-flash | 68 | 65 | 101,792 / 83,840 / 8,770 / 0 | $0.006 | 15:04 |
| `v41-flash-r3-cascade` | deepseek/deepseek-v4.1-flash | 168 | 168 | 247,572 / 189,440 / 70,621 / 53,989 | $0.040 | 15:05 |
| pilots (rules, 20 answers × 2) | both | 40 | 32 | 53,336 / 13,056 / 5,367 / 0 | $0.005 | 14:36 |
| `v41-1017-r3` (contract, maths) | deepseek/deepseek-v4.1-flash-1017 | 291 | 291 | 424,425 / 337,664 / 206,979 / 151,883 | $0.124 | 15:12 |
| `v41-1017-r3-reading-en` (copy-alt) | deepseek/deepseek-v4.1-flash-1017 | 68 | 65 | 101,792 / 80,768 / 8,679 / 0 | $0.007 | 15:22 |
| `v41-1017-r3-reading-zh` | deepseek/deepseek-v4.1-flash-1017 | 80 | 68 | 145,686 / 112,128 / 10,768 / 0 | $0.010 | 15:23 |
| **Total** | | **2,429** | **2,356** | **3,600,226 / 2,597,760 / 1,031,735 / 674,457** | **$0.57** | |

Keys were read from `deploy/.env.uat` into memory, as in rounds 1–2. A search of
the run directories, the committed records and the fixtures for each key's first
ten characters found nothing.

## Reproduction

```sh
S=bench/grading/scripts/deepseek_grading.py
D=data/grading-benchmark/deepseek-grading-<fresh>
E=deploy/.env.uat
for g in 0731 v41-flash; do
  python $S run --grader deepseek-$g --sets all --prompt r3 --thinking-sets math --label $g-r3 --env $E --output $D/$g-r3
  python $S run --grader deepseek-$g --sets reading_en --prompt r3 --copy-alt --label $g-r3-copy-alt --env $E --output $D/$g-r3-copy-alt
  python $S run --grader deepseek-$g --sets all --prompt r3 --thinking low --samples 1 --borderline-from $D/$g-r3 --label $g-r3-cascade --env $E --output $D/$g-r3-cascade
done
# the dated pin, on the pipeline's InferenceNet -> Cloudflare order
python $S run --grader deepseek-v41-1017 --sets contract,math --prompt r3 --thinking-sets math --label v41-1017-r3 --env $E --output $D/v41-1017-r3
python $S run --grader deepseek-v41-1017 --sets reading_en --prompt r3 --copy-alt --label v41-1017-r3-reading-en --env $E --output $D/v41-1017-r3-reading-en
python $S run --grader deepseek-v41-1017 --sets reading_zh --prompt r3 --label v41-1017-r3-reading-zh --env $E --output $D/v41-1017-r3-reading-zh
python $S report --runs <round 1 and 2 runs> $D/0731-r3 $D/v41-flash-r3 $D/0731-r3-copy-alt $D/v41-flash-r3-copy-alt $D/0731-r3-cascade $D/v41-flash-r3-cascade --output $D/summary.json
```

`--prompt r1` and `--prompt r2` still reproduce the earlier rounds. The rules fixture
applies only with `--prompt r3`.
