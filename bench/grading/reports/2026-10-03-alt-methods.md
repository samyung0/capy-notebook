# Alternative methods: deterministic checker against Jev

Open computational questions accept more than one route. A student can find a
triangle's area with the cosine rule and Heron's formula instead of ½ab sin C,
prove an angle with a different chain of circle theorems, or skip a step the
scheme lists. Can Jev grade these, and can a deterministic checker that verifies
facts instead of matching steps? This is a small probe, not a benchmark: 3
questions, 23 answers and 50 scored marks. One agent wrote every case, every label
and the checker. Treat it as worked examples of where each approach breaks.

- **Jev grades against the wording of the scheme, not the mathematics.** A valid
  method the scheme does not name loses its method mark. A valid proof that does
  not cite the scheme's theorem loses its reason mark. A right final answer gets
  the answer mark even when the student's own working gives a different number.
  Adding an "any correct method earns the marks" rule to the state changed 1 of
  50 marks. Adding the worked solution changed none.
- **Jev reads what a reason says.** Asked which theorem each circle reason names,
  it got 17 of 17. That includes "other" for the two reasons outside its list.
- **The deterministic checker** is exact where it has a rule. It verifies
  every line against the true quantities, the figure or the solution set, so the
  route does not matter. It fails on every answer that needs a rule it lacks.
  It got 44 of 50 marks, and all 6 misses are missing rules.

## Design

[`alt-methods.json`](../fixtures/alt-methods.json) holds three questions. Labels
follow one policy, written in the fixture: any correct method earns the scheme's
marks unless the question names a method; a value counts if it is stated or
clearly implied by later correct working; an answer the student's own working
does not produce earns nothing; every reason must justify its step. Two
follow-through and bare-answer cases on the equation are marked arguable and
excluded from the counts.

| Question | Marking scheme as a teacher writes it |
| --- | --- |
| Triangle PQR, PQ = 7, PR = 5, angle P = 40°; find the area | Uses ½ × 7 × 5 × sin 40° · Area = 11.2 cm² |
| A, B, C, D on a circle in order, AC a diameter, BAC = 32°; find BDC with reasons | BDC = 32° · Reason: angles in the same segment |
| Solve 3(x − 2) = 2x + 5, show working | Expands 3x − 6 · Collects 3x − 2x = 5 + 6 · x = 11 |

**The checker** ([`alt_methods.py`](../scripts/alt_methods.py)) reads each answer
as the structured lines or claims a MathLive input would give. Turning free text
into that structure is not tested.

- Triangle: it builds a table of the triangle's true quantities (third side and
  its square, semi-perimeter and its differences, three heights, two angles,
  area). Every line must be arithmetically consistent and its value must be one
  of those quantities, within 1%.
- Circle: it places the points on a unit circle. Each claim must be true in the
  figure. The cited theorem's preconditions must hold there: same chord and same
  side for the same segment, a diameter for the semicircle, the centre on the
  inscribed angle's side for the angle at the centre. The claim may use only
  angles that are given or already established.
- Equation: every line must keep the original solution. A substitution line
  maps solutions back to x. A valid chain that ends at x = 11 implies the
  skipped steps.

**Jev** got the production request: question, markscheme, answer, one
zero/partial/full `choice` per item and the vocabulary guard. It ran in three
arms. `steps` is the request unchanged. `policy` adds the labelling policy to the
state as `marking_rules`. `policy_ref` also adds the scheme's worked solution. A
separate request per circle answer asked which theorem each parenthesised reason
names. 79 requests went to `jev-1.13.0`; none failed.

## Results

Marks are per scheme item. Bold marks the cells that disagree with the label.

### Triangle area

| Answer | Gold | Checker | Jev steps | Jev policy | Jev policy + ref |
| --- | --- | --- | --- | --- | --- |
| Scheme method, one line | 1/1 | 1/1 | 1/1 | 1/1 | 1/1 |
| Cosine rule then Heron's formula | 1/1 | 1/1 | **0/1** | **0/1** | **0/1** |
| Height h = 5 sin 40°, then ½ × base × height | 1/1 | 1/1 | 1/1 | 1/1 | 1/1 |
| Cosine rule and Heron, slip in the last line (13.1) | 1/0 | 1/0 | **0/0** | **0/0** | **0/0** |
| ½ × 7 × 5 × cos 40° = 13.4 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 |
| Wrong QR (38.4 for 20.38) but final 11.2 | 0/0 | 0/0 | **0/1** | **0/1** | **0/1** |
| Bare "11.2 cm²" | 1/1 | 1/1 | **0/1** | **0/1** | **0/1** |
| Scheme method split into arithmetic lines | 1/1 | **0/0** | 1/1 | 1/1 | 1/1 |

For the inconsistent answer the checker reports the exact fault: line 1's
expression is 20.38, not 38.4, and the final square root is 15.07, not 11.2.
Jev credits 11.2 because it matches the scheme. In the split answer, "½ × 7 × 5 =
17.5" and "sin 40° = 0.6428" are true arithmetic but not quantities of the
triangle, so the checker rejects a correct answer. The table rule cannot tell
neutral arithmetic from a wrong formula: ½ × 7 × 5 × cos 40° = 13.4 is also
correct arithmetic.

### Circle angle

| Answer | Gold | Checker | Jev (all three arms) | Jev reads the reasons as |
| --- | --- | --- | --- | --- |
| Same segment, one step | 1/1 | 1/1 | 1/1 | same segment |
| Semicircle, triangle, same segment, semicircle, subtraction | 1/1 | 1/1 | 1/1 | all four right |
| Angle at the centre, then half | 1/1 | 1/1 | **1/0** | centre, centre |
| Right angle, "opposite angles in a cyclic quad" | 1/0 | 1/0 | 1/0 | cyclic quadrilateral |
| Semicircle route with "alternate segment theorem" in one step | 1/0 | 1/0 | 1/0 | all four right |
| 180 − 32 = 148° (cyclic quad) | 0/0 | 0/0 | 0/0 | cyclic quadrilateral |
| Bare "32°" | 1/0 | 1/0 | 1/0 | none given |
| Radii, isosceles triangle, straight line, centre | 1/1 | **1/0** | **1/0** | other, triangle, other, centre |

Jev gave the reason mark only to answers that cite "same segment". Its correct
zeros for the two wrong-reason answers prove nothing: neither answer cites the
scheme's theorem either. The valid centre proof lost the mark in every arm.

The checker caught the wrong theorem inside an otherwise valid five-step proof
("alternate segment" needs a tangent). It failed the isosceles proof for three
reasons. It has no rule for isosceles triangles from radii or for angles on a
straight line. It also did not know that BAO and BAC name the same angle,
because O lies on AC.

### Linear equation

| Answer | Gold | Checker | Jev steps | Jev policy | Jev policy + ref |
| --- | --- | --- | --- | --- | --- |
| Scheme method | 1/1/1 | 1/1/1 | 1/1/1 | 1/1/1 | 1/1/1 |
| 3x − 6 = 2x + 5, so x = 11 (collect skipped) | 1/1/1 | 1/1/1 | **1/0/1** | **1/0/1** | **1/0/1** |
| Collect on the other side (−11 = −x) | 1/1/1 | 1/1/1 | 1/1/1 | 1/1/1 | 1/1/1 |
| Let y = x − 2, solve for y | 1/1/1 | 1/1/1 | **0/1/1** | 1/1/1 | 1/1/1 |
| 3x − 2 = 2x + 5, then x = 11 | 0/0/0 | 0/0/0 | **0/0/1** | **0/0/1** | **0/0/1** |
| 3(x − 2) = 3x − 6 on its own line first | 1/1/1 | **0/0/0** | **1/0/1** | **1/0/1** | **1/0/1** |
| *Wrong expansion, correct follow-through (arguable)* | 0/1/0 | 0/0/0 | 0/0/0 | 0/0/0 | 0/0/0 |
| *Bare "x = 11" (arguable)* | 0/0/1 | 0/0/1 | 0/0/1 | 0/0/1 | 0/0/1 |

The substitution answer is the only mark the policy rule changed. Jev never
credited a skipped collection step. It credited x = 11 written under a line that
gives x = 7. The checker rejected the side-expansion line because
3(x − 2) = 3x − 6 is true for every x, so it has no single solution to compare.
It also does no follow-through. The arguable case is reported as "follows from
the line before", but no mark depends on that.

### Totals, arguable answers excluded

| | Marks matching gold (of 50) |
| --- | ---: |
| Deterministic checker | 44 |
| Jev, production request | 40 |
| Jev + any-valid-method rule | 41 |
| Jev + rule + worked solution | 41 |
| Jev naming the theorem a reason cites | 17 of 17 reasons |

## What this means

The two approaches fail differently. Jev's errors are inherent to it: it
matches the scheme's text, and it cannot check arithmetic, so no instruction
fixed them. The checker's errors were each a missing rule. Each one is easy
to fix once seen:
- arithmetic lines that are internally consistent are neutral;
- isosceles triangles from radii and angles on a straight line join the theorem
  list;
- angle names resolve to the rays they describe;
- a line that only rewrites one side is allowed.

But the rule set is per question type, and its coverage is never finished. Every
new topic needs its own quantity table or figure model and its own theorem
list, and an uncovered route is marked wrong with confidence.

A workable split from this evidence:
- **Checker** for whether each line or claim is true and justified. It needs a
  figure or quantity model authored with the question.
- **Jev** only for reading free text into the checker's structure. Naming the
  theorem a reason cites is something it did perfectly here.
- **Review** when the checker meets a step it has no rule for, instead of marking
  that step wrong. Here that catches the isosceles proof (unknown theorems) and
  the side-expansion line (no single solution). It does not separate the
  split-arithmetic answer from the wrong-formula one: both contain lines whose
  values are not quantities of the triangle. Sending those to review would also
  send the wrong formula, so review volume is the cost.

Jev alone should not grade open computational answers that may leave the scheme's
route. It under-credits valid alternatives, and it over-credits right answers
reached by wrong working.

## Limitations

- 23 answers. The cases and the checker were written by the same agent, and the
  checker was written knowing the cases. The 44/50 is a statement about these
  answers, not an accuracy estimate.
- The checker reads hand-structured lines and claims. A real system has to get
  them from MathLive input, plus free text for reasons.
- English only. One figure, one triangle, one linear equation. Questions that
  need the figure only as a picture were not attempted.
- Jev's run-to-run noise (5 of 116 decisions in the October 2 repeat) is larger
  than the one-mark difference between arms.

## Provenance and reproduction

The raw rows are in the ignored `data/grading-benchmark/alt-methods-20261003/results.jsonl`
(model-facing state and questions, raw answers, resolved model, usage, latency).
The key was read from `JEV_TYPESAFE_API_KEY` in `deploy/.env.uat` into the
environment and is absent from the run files.

```sh
python bench/grading/scripts/alt_methods.py --check
python bench/grading/scripts/alt_methods.py --checker-only
set -a; source <(grep '^JEV_TYPESAFE_API_KEY=' deploy/.env.uat); set +a
TYPESAFE_API_KEY="$JEV_TYPESAFE_API_KEY" python bench/grading/scripts/alt_methods.py --output data/grading-benchmark/alt-methods-<fresh>
```
