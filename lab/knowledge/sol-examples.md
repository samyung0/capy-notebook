# Sol book-processing examples

Read these before working on a book. They illustrate the review contract; they
are not source evidence and must not be copied into unrelated books. Decide
from each actual excerpt, its necessary context and the pages you inspect.
The packet example is `lab/knowledge/examples/book-review-packet.json`, or the
frozen `packet_example_path` supplied in your assignment.

## 1. General explanation inside a specialized book

Source in *Statistics in R*: "Simple linear regression describes a response
using one explanatory variable and a straight-line model."

- Do: summary "Defines simple linear regression." Scope "Conceptual definition
  for one explanatory variable; this passage gives no software-specific steps."
- Don't: "Requires R" or "Only suitable for R users" because of the book title.
- If the actual passage teaches `lm(y ~ x, data = d)`, do say that it demonstrates
  simple linear regression in R. Do not describe that implementation as
  software-independent.

## 2. Audience is different from applicability

Source in *Mathematics for Elementary Teachers*: a definition of a unit fraction.

- Do: scope "Defines fractions with numerator 1; no teaching activity is needed
  to use this definition."
- Don't: "For prospective elementary teachers only."
- If another excerpt asks a teacher to diagnose pupils' fraction misconceptions,
  do describe that classroom task. Do not paste the same audience-based scope
  across an entire chapter.

The same distinction applies outside software. For an excerpt explicitly about
a fictional jurisdiction's 1850 voting rule, do name that jurisdiction and
period. Don't turn it into a statement about voting everywhere today. A scope
such as "This passage does not establish current rules" states an evidence
limit; it does not claim that current rules must differ.

## 3. Classify what the passage does

| Actual source | Do | Don't |
| --- | --- | --- |
| "After this chapter you will be able to describe the median." | `non_teaching`, no topics | `exercise`, because it mentions an ability |
| "We will discuss historical milestones next." | `non_teaching`, no topics | `introduction`, because it announces a topic |
| "Welcome to the course. A contract is an enforceable agreement." | Preserve the definition as teaching, using the appropriate teaching role | Hide the whole mixed excerpt as administration |
| "Order 2, 4, 9. The middle value is 4, so the median is 4." | `worked_example` | `exercise` without a learner task |
| "Find the median of 2, 4, 9." | `exercise` | `worked_example` without a solution |
| A bibliography of statistics books | `non_teaching`, no topics | `reference` solely because it lists references |
| A table defining statistical symbols | `reference` | `non_teaching` merely because it is a table |

One mixed excerpt can have multiple teaching roles when it actually does those
jobs. `non_teaching` always stands alone. A running header on an otherwise blank
PDF page is not a hidden exercise; inspect the page before claiming missing content.

## 4. Keep full notes and add a short retrieval summary

Existing full note: "Bootstrap resampling draws observations with replacement,
retains sample size, recalculates a statistic and uses repeated results to
describe sampling variability. The passage gives no software implementation."

- Do: keep that full synopsis and add summary "Explains bootstrap resampling
  and sampling variability."
- Don't: replace the full synopsis with "Bootstrap resampling."
- Do correct a source-contradicting note with evidence and a recorded note change.
  Don't preserve an invented claim just to keep the old string identical.

Observed inherited-note failure, *Chinese Contract Law*, excerpt 57: the source
says Chen announces repayment to Guo, then a robber takes the money. The old
synopsis says this happened "at the creditor's direction", which the passage
does not say. Do remove that unsupported direction and retain the repayment
question and the dispute about its timing. Don't treat an unchanged old note as
verified, infer a legal outcome, or shorten the entire note to a topic label.

## 5. Missing formulas need an excerpt-level warning

Extracted text: "Write the following fractions as Egyptian fractions. [No
fractions survived extraction.] Can you find a general algorithm?"

- Do: role `exercise`; summary "Asks for Egyptian-fraction representations and
  a general algorithm." Scope "The target fractions are missing from the
  extracted text; this exercise needs the source page before it can be used."
- Don't: give a generic scope such as "Elementary fraction exercises" and put
  the defect only in the book's unresolved-items list. Search returns individual
  excerpts, so that warning would be lost.
- Don't: invent likely fractions or link the preceding passage and call it
  repaired when that passage also lacks the operands.
- If authorized to repair source text, inspect the exact PDF page, preserve the
  original, record the page and correction, then validate the corrected text.
  In annotation-only work, leave the extraction limit explicit.
- Do distinguish "metadata reviewed; target fractions still missing" from
  "source recovered" in the completion record. A warning and a page path do
  not restore operands. Keep unresolved recovery against the affected IDs even
  when their roles, topics and retrieval metadata are complete.

An empty answer column in a learner worksheet may be intentional. Do inspect
the table layout; don't fill it or report lost answers just because cells are blank.
Do distinguish an error printed in the textbook from an extraction error.

## 6. Links must restore the right context

Excerpt A gives a ribbon problem with lengths 1/2 and 1/3 of the same unit.
Excerpt B supplies its calculation without repeating the question.

- Do: read A, link B to A, and state that A supplies the question and givens.
- If B also contains an unrelated definition, do say the link is needed for
  the ribbon solution only. Don't make all of B depend on A.
- Don't link a nearby regression solution to a different question because both
  mention the Elmhurst dataset. Check the variables, sample, model and task.
- Don't link every neighboring excerpt on the same topic. Relevance alone is
  not a missing-context dependency.

Observed failures in *Mathematics for Elementary Teachers*:

- Excerpt 5 contains general problem-solving advice and a reflection on the
  earlier ABC puzzle. Do read and link excerpt 3 for the ABC reflection and say
  in scope that the general advice stands alone. Don't leave the reflection
  without its puzzle or make the general advice depend on that puzzle.
- Excerpt 155's page 281 contains growing-pattern Problems 16-18, but excerpt
  154 supplies what to do with each pattern. Do link 154 for those instructions
  and separately record the need for the diagrams. Don't assume that seeing
  the pictures or warning about their absence supplies the learner's task.
- Excerpt 43's supplied section path already contains the base-seven task.
  Do read headings and locators as well as body text before declaring context
  missing. Don't add a neighbor link merely because a short summary omits the
  instructions; preserve the additional base-four task when summarizing it.

These excerpt numbers identify the observed cases, not universal link rules.
Verify the actual IDs, contents and headings in each new assignment.

## 7. Topic reuse includes meaning, not only spelling

Catalog: `fraction-addition`, label "Adding fractions", covering common
denominators. Candidate: `adding-fractions`, label "Addition of fractions",
covering the same material.

- Do: reuse `fraction-addition`; don't create a duplicate because the ID differs.
- If the new book also teaches Egyptian-fraction decomposition and no catalog
  topic covers it, do propose that genuinely missing topic with its source sections.
  Don't force it into "Adding fractions" just to avoid a new proposal.
- On a catalog refresh, do reread scope, aliases and source sections, reconsider
  proposals, and use the final merged IDs. An exact ID/label/alias merge can miss
  a semantic duplicate. Don't merely replace stale hashes or trust the merge
  function as a semantic reviewer.
- If a catalog scope and its source sections conflict, report the conflict.
  Don't silently leave teaching content without a topic.

Observed catalog conflict: `chinese-contract-law-history` describes historical
evolution in its scope but explicitly includes "1.1 Contract law: some
background" in `source_sections`. Excerpt 6 in that section explains contracts
and market exchange. Do report the disagreement between catalog fields and
resolve it with the book owner. Don't silently drop its topic, invent a new
topic before checking the catalog, or label explanatory prose `reference` just
because it discusses a named scholar.

## 8. Split-book coverage and honest visual claims

A book has 236 excerpts assigned as 79, 79 and 78.

- Each scope worker reviews exactly its assigned IDs and may read other excerpts
  for context. It reports provisional topic matches and unresolved source defects.
- The book owner assembles all three scopes, checks unique complete coverage,
  reads their full notes, then reasons about topics and emits final tags.
- Don't treat the first completed scope as whole-book topic evidence. Don't
  discard fields or shorten notes when assembling the scopes.
- If 35 distinct pages were inspected, report those 35 exact PDF page numbers,
  observations and paths. Don't claim that every formula in a 457-page book was
  verified. One image cannot validate other pages or every claim on that page.
- Page checks belong to Sol's initial work. Qwen is optional later text review;
  Sol never submits, polls, waits for or repairs Qwen responses.

Observed overclaims: the literature page prints `177273`; the trial reported
`1772-73` as visually verified. Do record the printed string and uncertainty;
an interpretation needs separate support. Don't silently insert a separator.
The math inventory has 28 inspection records covering 27 distinct PDF pages.
Do derive counts from the saved inventory and distinguish records from unique
pages; don't state "28 distinct pages" or infer whole-book verification.

Observed scope boilerplate: one worker repeated three broad strings across
38 excerpts. Do compare each scope with that excerpt's actual conditions and
missing inputs. Don't paste "for elementary teachers" or "no special software"
onto every definition and exercise. Identical wording can be valid, but its
frequency is a reason to reread the affected passages, not an automatic defect.

## 9. Emit the fixed packet

Read the JSON example before exporting. In that example, only `e-solution` is
assigned for review, while `e-question` is included as source context. That
does not claim a complete book review.

- Do use `lab/knowledge/packet.py` with the artifact paths in `review.md`.
  Supply the assignment's `--baseline-notes` and `--baseline-sha256`; the exporter
  rejects a note file that does not match that frozen hash.
- Do embed actual source text and locators, old full notes and candidate tags,
  catalog/proposal/merged IDs, exact assigned IDs, hashes and unresolved limits.
- Do pass the assigned original run directory to the exporter. If a diagram-only
  old note is "(a) (b) (c)" and your supported candidate describes the diagrams,
  `full_reviewed_notes` keeps "(a) (b) (c)" while `final_tags[].synopsis` carries
  the new description. Don't create a substitute run with your revised notes in
  `reviewed-notes.json`; that erases the before/after comparison. Check the
  packet's full-note hash against the frozen original-note binding.
- The original run path alone is insufficient: `enrich --apply` updates that
  run's `reviewed-notes.json`. Freeze the original bytes/hash before applying
  changes and retain the existing `retrieval-review-backups` copy. If the
  exporter's baseline differs from the frozen original, report packet export
  as blocked by a baseline mismatch. Don't overwrite live notes, edit the
  expected hash, or call a packet with identical old/new revised notes correct.
  Do use a matching immutable backup as the explicit baseline, leaving live
  reviewed notes intact. Don't compute a new expected hash from revised notes.
- Don't rename `source.excerpts` to `source_excerpts`, `final_tags` to
  `candidate_tags`, or omit `assignment.target_ids` or `assignment.fields`.
- Don't supply only local paths. A reviewer on another computer needs the text.
- Don't copy the illustrative hashes or agent ID from the example. Record actual
  provenance and leave unavailable usage unknown.
- A valid packet confirms its shape and source binding, not that its claims are
  correct. Preserve uncertain candidate claims for review and record their limits.
