# typesafe.ai jev as a math quiz judge, 19 September 2026

Can typesafe.ai's `jev-1.13.0` replace the LLM quiz judge for open math
answers, how does it do on rubric grading in other subjects, and can it tell
the two apart? Six probes, all run from
[`typesafe_math.py`](../scripts/typesafe_math.py) against
[`typesafe_math_cases.json`](../fixtures/typesafe_math_cases.json),
[`typesafe_equiv_cases.json`](../fixtures/typesafe_equiv_cases.json),
[`typesafe_units_cases.json`](../fixtures/typesafe_units_cases.json),
[`typesafe_algebra_cases.json`](../fixtures/typesafe_algebra_cases.json),
[`typesafe_rubric_cases.json`](../fixtures/typesafe_rubric_cases.json),
[`typesafe_route_cases.json`](../fixtures/typesafe_route_cases.json) and
the eight English [seed files](../fixtures/seeds/). Raw rows
are in the gitignored `data/grading-benchmark/runs/typesafe-*.jsonl`. The
vendor's own [jaggedness page](https://docs.typesafe.ai/model-jaggedness/jev-1.13.md)
says "Jev is not a calculator"; this report measures where that bites.

Cases are author-written, not student work. Each math case has a correct
worked solution, one or more correct alternative methods, wrong-final-answer
variants (sign flip, transposed digits, rounding, wrong exponent) and
step-only variants that reach the right final answer through a wrong step.
Repeats of one request move the noul by about ±0.05; between runs the
no-reference numbers moved up to ±0.15.

## Connection

`POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer`, body
`{model: "jev-latest", state: {...}, questions: {...}}`. Several questions run
against one state in one request. Latency p50 0.85 s, max 1.7 s over 183
requests; 300 to 1,000 input tokens per request at $0.042 per million.

## Step checking: 13 cases, 61 answers, three state shapes

State was `{question, user_answer}` (no ref), plus `correct_answer` holding
either the final answer only (final ref) or the full worked solution (worked
ref). Noul: "fully correct, every calculation and reasoning step accurate",
threshold 0.5. Score: three levels mirroring the app's 0 / 0.5 / 1 award,
full marks at ≥ 1.5.

| State shape | Wrong marked correct (noul) | of which final answer wrong | of which step-only | Correct marked wrong | Wrong given full marks (score) |
| --- | ---: | ---: | ---: | ---: | ---: |
| no ref | 17/35 | 9/21 | 8/14 | 0/26 | 17/35 |
| final ref | 13/35 | 2/21 | 11/14 | 0/26 | 9/35 |
| worked ref | 3/35 | 0/21 | 3/14 | 0/26 | 2/35 |

Where it breaks without a reference: everything up to single-identity
algebra (17 × 23, 3x + 7 = 22, factoring a quadratic, product rule) is caught.
From the first case that needs an actual evaluation the model cannot do in
its head, plausible-looking wrong answers pass at 0.7 to 0.96: lim = 1 instead
of 1/2, ∫₀¹ x eˣ = 2e − 1, $1157.36 for $1157.63, $1157.62 (rounding), 20/7 ≈
2.587, determinant −69 for −59, 3¹⁰⁰ mod 7 = 2. The sec(2π/9) proof is the
clearest: the correct proof scores 0.93 and four single-token corruptions
(cos2θ for cos3θ, 6π/3 for 8π/3, Vieta +3 for −3, product +1 for −1) score
0.90 to 0.94. Only the variant that ends "= −6" against a claim of 6 is
caught.

A final-answer reference fixes final-answer errors (2/21 remain: lim = 1 at
0.50, and 2.587 against "20/7" because it cannot evaluate 20/7) but makes
step-only errors worse (11/14 pass, up from 8/14). Once the final answer
matches the reference the model stops looking at the working.

A full worked reference is the best shape and is essentially a diff. It
catches every final-answer error and 11/14 step-only errors, and the correct
alternative methods (completing the square, tabular integration, natural
frequencies for Bayes, 3³ ≡ −1 for the modular case, Gauss pairing for the
induction) all still score 0.87 to 0.99, so it is not punishing a different
route. The three misses are the ones where the diff is one token inside a
long proof: cos2θ (0.97), 6π/3 (0.63) and 3(−10) for 3(−20) (0.66). Three
more sit at 0.33 to 0.47.

Sending each wrong line alone, without the rest of the proof, does not help:
5/8 still pass (6π/3 at 0.90, Vieta +3 at 0.89, 3(−10) at 0.92, 1.05³ =
1.175625 at 0.86, 20/7 ≈ 2.587 at 0.62). This is a computation ceiling, not
dilution by long state, so decomposition into per-step questions will not
fix it.

## Final-answer equivalence: 64 pairs

State `{question, correct_answer, user_answer}`, noul "same value, allowing a
different but equivalent form, notation or unit". Six pairs where a human
marker could go either way are excluded from the counts.

| Group | Equivalent marked different | Near miss marked same |
| --- | ---: | ---: |
| numeric (fraction, decimal, percent, π, √, $) | 0/10 | 0/9 |
| algebra (expand/factor, reorder, ±, sets, pairs, identities) | 0/12 | 0/8 |
| units (days/weeks/hours, min/h/s, km/m, kg/g, °F) | 0/11 | 1/8 |

It handles 1/8 = 0.125 = 12.5% = 2/16, (x+1)² = x² + 2x + 1 = 1 + 2x + x²,
x = ±2 = {−2, 2} = "2 or −2", sin 2x = 2 sin x cos x, (3, 2) = "x = 3, y =
2" (and rejects (2, 3)), 90 min = 1.5 h = 1h30 = 5400 s, 1500 g = 1.5 kg, and
rejects the near misses 0.128, 1/6, 0.6, 1.141, 6.82, x = 2 alone, x² + 2x −
1, 1 hour 20 minutes, 150 g.

The one miss is the same ceiling as above. Against "9 days": "1 week 2 days"
0.96 and "1 week 3 days" 0.93 are indistinguishable, "1 week 1 day" 0.62,
"192 hours" 0.85, "240 hours" 0.59, while "216 hours" (right) is only 0.85.
Any equivalence that needs arithmetic the model has not memorised is a coin
flip. Three repeats of each confirmed these are stable, not noise.

Of the arguable pairs: "2^5" for 32 scores 0.56 and "2 km" for "convert to
metres" 0.51, both sensible fence-sitting; "5 m/s" against 18 km/h (0.07) and
"25 °C" against 77 °F (0.01) are marked wrong, which reads the "convert"
instruction literally and is defensible.

## Unit conversions: 235 pairs across 12 families

Same question as above, one neutral question per family ("What is the mass of
the sample?"), pairs classed by what the conversion needs rather than by unit.
Nine arguable pairs (1 MB = 1024 KB, 1 atm ≈ 100 kPa, 10 in ≈ 25 cm, 500 kcal
≈ 2000 kJ, 60 mph ≈ 100 km/h) are excluded.

| Conversion kind | Families | Equivalent marked different | Near miss marked same |
| --- | --- | ---: | ---: |
| decimal shift | kg/g/mg/t, L/mL/cL/cm³, KB/MB/GB/TB, km/m/cm/mm, m²/cm²/ha, GHz/MHz, kW/W, mA/A, kV/V, k/million/dozen | 0/40 | 3/52 |
| non-10 factor | lb/oz (16), kg/lb (2.2), gallon/quart (4), cups/pint (2), bits/bytes (8), Mbps/MB/s (8), ft/in (12), yd/ft (3), h/min (60), days/h (24), weeks/days (7), months/years (12), km/h ↔ m/s (3.6) | 0/36 | 18/41 |
| formula | °C/°F/K, degrees/radians | 0/17 | 4/13 |
| approximate constant | miles/km, in/cm, kcal/kJ, kWh/MJ, atm/kPa/bar | 0/13 | 2/14 |
| all | | 0/106 | 27/120 |

It never rejects a genuine equivalent, so false negatives are not the risk.
The risk is accepting near misses, and that splits cleanly by kind.

Decimal shifts are safe: 2.5 kg ≠ 2050 g (0.04), 0.75 L ≠ 705 mL (0.03),
3.2 GB ≠ 3020 MB (0.14), 1.75 m ≠ 157 cm (0.03), 2.5 km² ≠ 2,500 m² (0.02),
1 m² ≠ 100 cm² (0.01). The three misses are digit shuffles inside a
three-significant-figure value: 4.25 kg vs 4025 g (0.89) and 4225 g (0.53),
2.4 g vs 2040 mg (0.67). KB/MB behaves like kg/g, and the model treats 1000
and 1024 as both fine (1 MB = 1024 KB 0.96, 1.5 GB = 1536 MB 0.95).

Non-10 factors fail 44% of the time. The memorised pairs are solid (2 lb = 32
oz, 5 ft = 60 in, 2.5 h = 150 min, 36 km/h = 10 m/s, 18 months = 1.5 years,
all ≥ 0.92) and the "wrong-shaped" near misses are caught (250 min for 2.5 h
0.10, 36 m/s for 36 km/h 0.03, 10 MB/s for 10 Mbps 0.04). Everything between
is a coin flip: 84 oz for 5 lb 0.84, 20 oz for 2 lb 0.77, 6 quarts for 2
gallons 0.88, 12 bits for 2 bytes 0.81, 60 inches for 2 yards 0.96, 8 feet for
2 yards 0.85, 1 hour 25 minutes for 1.25 hours 0.80, 1 year 8 months for 18
months 0.96, 1.8 years for 18 months 0.96, 0.45 minutes for 45 seconds 0.97,
12 m/s for 36 km/h 0.96, 25 m/s for 72 km/h 0.76.

Temperature is a coin flip too (4/8): 96.8 °F for 37 °C 0.92, 70 °F for 20 °C
0.78, 30 °C for 300 K 0.85, 55 °F for 15 °C 0.86. Only the famous anchors (0
°C = 32 °F, 100 °C = 212 °F, 37 °C = 98.6 °F) are reliable. Angles are perfect
because the special angles are memorised. Approximate constants mostly hold
but the equivalents score low (10 kg = 22 lb 0.74, 5 km = 3.1 miles 0.86, −10
°C = 14 °F 0.75), so a stricter threshold would start losing them.

Five of the 27 misses sit between 0.5 and 0.6 and could flip on a rerun; the
other 22 are at 0.62 or above and repeat-stable in earlier checks.

## Algebraic form: 217 pairs across 12 families

Same shape, noul "mathematically equivalent: equal for every value of the
variables where both are defined, even if written in a different form".
Questions were phrased so no particular form is demanded ("Find f(x) given
f(x)·(x + 1) = x² + x + 1"). Every label with a sympy form was verified
numerically at six random points before the run; the check caught one of my
own mislabels, which says something about how easy these are to get wrong by
eye. Nine arguable pairs (unchanged input, x² without + C, 0.8333x) excluded.

| Family | Equivalent marked different | Near miss marked same |
| --- | ---: | ---: |
| rational (polynomial + proper fraction rewrites) | 0/10 | 7/19 |
| fraction (combine, split, partial fractions) | 0/7 | 0/11 |
| factor / expand / complete the square | 0/11 | 0/13 |
| exponent rules | 0/10 | 0/10 |
| exp / log rules | 0/7 | 0/8 |
| trig identities | 0/8 | 0/13 |
| radicals | 0/8 | 1/9 |
| calculus (derivative and antiderivative forms) | 0/9 | 0/10 |
| quadratic roots in surd form | 0/5 | 1/6 |
| complex numbers | 0/7 | 0/7 |
| intervals and solution sets | 0/5 | 0/5 |
| closed forms (sums, binomials) | 0/6 | 1/4 |
| all | 0/93 | 10/115 |

Outside the rational family this is strong: 3 misses in 96 near misses, and
those three are borderline (2/√2 for √2/2 at 0.55, (−4 ± √12)/4 at 0.70,
n²/2 − n at 0.75). Identity rewrites it has seen in textbooks are recognised
in either direction: (2 − x)(3 − x) for (x − 2)(x − 3), 2cos²x − 1 for
cos 2x, −log(b/a) for log(a/b), 2^x + 2^x for 2·2^x, (x⁵)^(1/6) for x^(5/6),
(1/√2)e^(−iπ/4) for (1 − i)/2, C(n+1, 2) for n(n+1)/2, −3 < x − 2 < 3 for
−1 < x < 5, all ≥ 0.90. Sign flips, swapped coefficients, missing roots and
the classic mistakes ((a + b)² = a² + b², log(a + b), 1/x + 1/y = 1/(x + y))
all score ≤ 0.07.

The rational family is where the reasoning-LLM question came from, and it is
a coin flip. Against (x² + x + 1)/(x + 1): 1 + x²/(x + 1) 0.89 and
x + 1/(x + 1) 0.55 (both right), but x + 1 + 1/(x + 1) 0.93, 1 + x/(x + 1)
0.88 and (x² + x)/(x + 1) + 1 0.92 (all wrong). Against x²/(x + 1):
x − 1 + 1/(x + 1) 0.93 (right) but x + 1 − 1/(x + 1) 0.81, x − 1 − 1/(x + 1)
0.83 and x − 1/(x + 1) 0.54 (all wrong). Against (x + 2)/(x + 1):
1 + 1/(x + 1) 0.94 (right) and 1 − 1/(x + 1) 0.88 (wrong). Checking any of
these means multiplying out and comparing coefficients, and the model does
not do that; it scores whether the answer has the right shape.

## Rubric grading across subjects: 1,688 answers, 3,568 marking points

This is the app's actual shape: question plus a list of marking points, no
model answer. Each marking point became one noul, "The user_answer conveys
this marking point: …", all asked in one request per answer, threshold 0.5.
Award follows the app: every point met is 1, some is 0.5, none is 0.

Two sources. Sixteen hand-written four-point essay questions, one per
subject, each with six answers: full, terse full, partial (two or three
points), keyword-stuffed (the rubric's vocabulary without any of its claims),
contradiction (meets the other points and states the opposite of one) and a
fluent off-topic answer. And the eight English seed files from the local
grading bench: 400 questions × paraphrase, point A alone, point B alone and
misconception, minus the 8 misconceptions the label audit marks as partial.
The seed run is the same 1,592 English primary cases Gemma 4 E2B was scored
on in [2026-09-05-core-results.md](2026-09-05-core-results.md), though under
a different protocol (per-point nouls rather than the app prompt with a
model answer). Cost: 822k input tokens, about 3.5 cents; 1,688 requests in
under four minutes at 8 parallel.

| Essay subject | Met points missed | Unmet points credited | Award exact |
| --- | ---: | ---: | ---: |
| psychology, civics, geography, philosophy, language, mathematics | 0 | 0 or 1 | 6/6 |
| history, literature, economics, biology, computing, business, medicine, music | 0 | 1 to 2 | 5/6 |
| physics | 0/13 | 2/11 | 5/6 |
| chemistry | 0/14 | 3/10 | 5/6 |
| all 16 | 0/214 | 15/170 | 86/96 |

| Essay answer kind | Award exact | Notes |
| --- | ---: | --- |
| full | 16/16 | |
| terse full (bullet-like) | 16/16 | terseness costs nothing |
| partial | 16/16 | one point over-credited in 28, award unchanged |
| contradiction | 16/16 | the contradicted point scored ≤ 0.10 every time; other points still credited |
| off-topic | 16/16 | |
| keyword-stuffed | 6/16 | 14 of 63 unmet points credited, 10 answers given 0.5 instead of 0 |

| Seed domain | Point-A/B-only answers over-credited | Misconceptions credited | Award exact |
| --- | ---: | ---: | ---: |
| language_literature | 2/100 | 0/48 | 99.0% |
| chemistry | 3/100 | 0/50 | 98.5% |
| geography_economics | 4/100 | 1/49 | 97.5% |
| biology | 5/100 | 1/50 | 97.0% |
| mathematics | 6/100 | 0/46 | 96.9% |
| physics | 7/100 | 0/49 | 96.5% |
| history_civics | 7/100 | 2/50 | 95.5% |
| computing | 10/100 | 0/50 | 95.0% |
| all | 44/800 | 4/392 | 1,544/1,592 = 97.0% |

Gemma 4 E2B scored 86.6% on the same English cases with the app prompt.

Every genuinely met point was credited: 0 of 214 essay points and 0 of 1,600
seed points missed, all 800 paraphrases at full marks. Every error is
over-crediting, never under. Contradictions are handled properly: "obedience
was rare, only 5% went to the top" scored 0.02 on the 65% point while the
other three points stayed above 0.9, and the same held for all sixteen.
Off-topic answers got nothing except where they happened to state a point
(the boiling-point answer does say water molecules hydrogen-bond).

The one weakness is vocabulary without a claim. "The satellite stays up
because of centripetal force, tangential velocity, free fall and orbital
radius" earned the tangential-velocity point at 0.90 and the v = √(GM/r)
point at 0.92; "resistance is caused by … plasmids … horizontal gene
transfer is a type of transfer" earned the plasmid point at 0.82; "antigens,
antibodies, B cells, T cells" earned the antibody point at 0.77. Half of the
keyword-stuffed credits sit between 0.52 and 0.61, though, and genuinely met
points never scored below 0.86 in the essays (5th percentile 0.94) or 0.60
on the seeds (5th percentile 0.90). Raising the threshold to 0.6 misses no
met point, lifts seed award accuracy to 97.9% and cuts keyword-stuffed
over-awards from 10 to 6 of 16; at 0.7 the seeds reach 98.7% at the cost of
4 missed points in 1,600. Subject makes little difference. Physics and
chemistry look worst on the essays only because their rubrics name concrete
nouns (tangential velocity, hydrogen bond, lattice) that a stuffed answer
can drop in; history and computing lead the seed over-credits for the same
reason, one point's key term appearing inside the other point's sentence.

## Routing: does this question need calculation checking? 102 questions

If jev grades everything except computation, something has to decide which
is which, and the question text can mislead: a word problem in plain prose,
a proof with no numbers, or a recall question whose answer happens to be a
number. 102 questions across 15 subjects, 46 needing calculation or
derivation (40 numeric, 6 symbolic) and 56 not (18 recall, 35 explanation,
3 arguable), 38 of them written to point the wrong way. One noul, "grading
an answer to this question correctly requires checking a numeric
calculation or a step-by-step algebraic, symbolic or logical derivation",
asked three ways: question alone, with the model answer, with model answer
and rubrics.

| State | Compute questions sent to jev | Non-compute sent to the LLM | Accuracy |
| --- | ---: | ---: | ---: |
| question only | 0/46 | 0/53 | 100% |
| question + correct_answer | 1/46 | 0/53 | 99% |
| question + correct_answer + rubrics | 1/46 | 0/53 | 99% |

From the question alone every deceptive case went the right way: "a train
leaves at 09:40 and arrives at 13:15", "a recipe for four needs 300 g",
"Sam has three times as many marbles", "a heart beats 72 times a minute,
how many in a day", "a colony doubles every 20 minutes", "5 mg per kg every
8 hours for a 70 kg patient", "a bill needs two thirds of 435", "show that
√2 is irrational" and "derive the period of a pendulum" all to the LLM
(0.76 to 0.99); "π to two decimal places", "how many degrees in a triangle",
"how many chromosomes", "what year did WWII end", "what percentage of
Milgram's participants" and "how many syllables in university" all to jev
(0.03 to 0.30). The margins are wide: compute questions score median 0.97
and 10th percentile 0.87, non-compute median 0.03, 90th percentile 0.09,
maximum 0.30. The two closest calls are both proofs-in-prose or
counting-in-prose: "explain why the interior angles of a triangle sum to
180°" at 0.52 and the Aa × Aa Punnett fraction at 0.58.

The model answer does not help. The one flip is the triangle question,
which drops to 0.29 once its parallel-line argument is attached, because the
answer reads like an explanation. Rubrics change nothing. So route on the
question alone, and put the threshold near 0.3 rather than 0.5: nothing
non-computational scored above 0.30, the two borderline proofs get caught,
and a wrong route to the LLM only costs latency while a wrong route to jev
costs a wrong grade.

## What this means for the quiz judge

Step-by-step verification of worked math is out for jev: half of the wrong
answers pass without a reference, and even with a full worked reference it
is a text diff that misses one-token errors in long proofs. Route open math
answers that need their working checked to a reasoning LLM.

Route first: one question-only noul with a 0.3 threshold sends anything
that needs calculation or derivation checking to the reasoning judge and
was right on all 99 unambiguous cases, including the prose word problems and
numeric-answer recall questions written to fool it.

For rubric-marked open answers in any subject, jev is a good fit at one
noul per marking point: 97% award agreement on the English seed corpus
against Gemma's 86.6%, no under-crediting at all, contradictions and
off-topic answers handled, under a second per answer. Its one bias is
crediting vocabulary, so use a 0.6 to 0.65 threshold rather than 0.5 and
expect a name-dropping answer to pick up partial credit about a third of
the time. Math is the exception below.

Final-answer equivalence is usable when the quiz author supplies a final
answer and the marking is "same value in any form", with two carve-outs.
Form changes (fraction/decimal/percent, expand/factor, reorder, ±, sets,
pairs, textbook identities in trig/log/exponent/radical/complex form),
SI-prefix unit shifts and memorised anchors are reliable: 0 of 199 genuine
equivalents rejected and 3 of 96 near misses accepted outside the two weak
spots. The weak spots share one cause, a computation the model cannot do in
its head: unit conversions with a non-10 factor or a formula (about half of
wrong ones accepted), and rational-expression rewrites that need polynomial
division to check (7 of 19 wrong ones accepted, and the genuine ones drop to
0.55 to 0.89). Units the quiz author can constrain. Rational rewrites they
cannot, so for open algebra answers the reliable check is a CAS: parse both
expressions and compare them numerically at a handful of random points,
which is exactly how this fixture's labels were verified. The parsing of
free-text math is the real work there, not the comparison.
