# Intake agent models: Opus 5.5 medium, Sonnet 5.5 high, Haiku 5.5 xhigh

Date: 2026-10-15, on the Mac. Question (Epo): with the ODL v14 parser, can
Sonnet 5.5 high or Haiku 5.5 xhigh do the per-book intake agent's work, now
planned for Opus 5.5 medium, at a lower price? Raw runs, prompts and scoring
scripts sit in the ignored `bench/rag/reports/local/2026-10-15-intake-models/`.

## Summary

- **Sonnet 5.5 high matches Opus 5.5 medium on source review** (equal
  defect repairs, no false repairs, slightly better scopes) at about 75% of
  Opus's cost per review. On whole-book rights screening it read more and
  cost 15% more than Opus, with one missed item.
- **Haiku 5.5 xhigh is not a safe sole reviewer.** It repaired 53 of 68
  extraction defects against Opus's and Sonnet's 64, made 3 false formula
  repairs (inventing an ε, changing a printed exponent, dropping a `dx`), and
  in rights screening excluded ten photos the book's own copyright page
  covers. It costs 35–45% of Opus, not the 1/40 the price list suggests:
  at xhigh it writes about 5.7 times Opus's output, and most of its requests exceed
  100K tokens, which Haiku bills at five times the base rate.
- **Rights screening barely separates the models.** All three found the same
  restricted works (the Sondheim lyrics, the Batsell chapter, the MIT NC-SA
  adaptation, the Music licence mismatch). Their differences from the
  published record come from past case-by-case decisions the brief did not
  state (below), not from model ability.
- **The review still has real work after v14.** 68 extraction defects in 52
  excerpts: formulas printed as pictures left as `[formula]`, fractions
  flattened into integers (`5/36` read as `365`), tables flattened, figure
  text missing.

## Method

Two tasks, the same frozen brief for every model, each run as a Claude Code
subagent in its own folder (model and effort set on the subagent), told to
work only inside that folder. Folder names hid the model.

1. **Source review** of three slices parsed with ODL v14
   (`odl-2.5.7-refined-rapidocr-v14`, run natively on the Mac with the
   image's pinned packages and OCR models, since Docker could not pull
   images): Brief Calculus PDF 132–144 (24 excerpts, formula-heavy),
   Advanced High School Statistics 141–150 (18, tables and fractions),
   Learning Statistics with jamovi 154–167 (10, long prose and figures).
   The brief (`review-assignment.md`) is the delegated review of
   `lab/knowledge/review.md` with `source-repair.md` and `sol-examples.md`,
   stopping at a candidate file: roles, full notes, verbatim evidence,
   retrieval summary/scope/links, existing topic IDs, and chunk repairs
   checked against page images. One blind Opus 5.5 high judge per book saw
   the three reviews as A/B/C and scored every excerpt against the page
   images (`judge-assignment.md`).
2. **Rights screening** of five whole published books with known
   withholdings (`rights-assignment.md`): Manufacturing Processes 4-5,
   #TheatreAppreciation, Producing Open Source Software, Media Innovation and
   Entrepreneurship, and Music: Its Language, History, and Culture as a
   licence-mismatch case. Scored against the library's `withheld_pages`,
   `figure_exclusions` and `rights_notes` and the recorded decisions.

Costs are API list prices applied to each subagent's usage (5-minute cache
writes at 1.25 times input; Haiku's cache-read price is unlisted and taken as
10% of input). The Claude Code harness adds about 60K cached tokens per
request to every run, as it will in production intake.

## Source review (52 excerpts, blind judge)

| | Opus 5.5 medium | Sonnet 5.5 high | Haiku 5.5 xhigh |
|---|---|---|---|
| Roles right | 52 | 52 | 52 |
| Wrong claims in notes or scope | 1 | 2 | 5 |
| Excerpts missing content | 0 | 0 | 3 (minor) |
| Scope score (0–2, sum) | 97 | 101 | 88 |
| Defects repaired / flagged / missed (of 68) | 64 / 3 / 1 | 64 / 1 / 3 | 53 / 6 / 9 |
| False repairs | 0 | 0 | 3 |
| Unneeded edits of chunk overlap | 14 | 5 | 4 |
| Publishable as is / minor fix / no | 46 / 6 / 0 | 47 / 5 / 0 | 41 / 10 / 1 |
| Judge ranking (Calculus, AHSS, LSJ) | 1st, 1st, 2nd | 2nd, 2nd, 1st | 3rd, 3rd, 3rd |
| Cost per slice | $1.83 | $1.36 | $0.66 |

Programmatic checks passed for every run: all excerpts tagged, valid roles,
evidence verbatim in 51 of 52 for Opus and all 52 for the others, field
limits, link and topic IDs.

## Rights screening (5 books)

| | Opus 5.5 medium | Sonnet 5.5 high | Haiku 5.5 xhigh |
|---|---|---|---|
| Sondheim lyrics (8 withheld pages) | 7 | 7 | 7 |
| Batsell chapter and LUMA cards (29) | 25 | 25 | 25 |
| MIT NC-SA adaptation (110 pages) | 42 | 31 | 27 (+7 pages not in the record) |
| OSS reprinted works (6 pages) | 5 | 3 (missed the Deloitte disclaimer) | 5 |
| Recorded figure exclusions found | 30 of 30 | 30 of 30 | 30 of 30 |
| Music licence mismatch (BY vs BY-SA) | yes | yes | yes, but excluded 10 covered photos |
| Cost per book | $1.82 | $2.08 | $0.80 |

Gaps every model shared, all from decisions the brief did not spell out:
the LUMA card text on PDF 72–75 (only the card images were excluded), the
96-word Reiners email Epo kept (2026-10-02; all three withheld it), page 59
of the second lyric, the whole-chapter withholding where a chapter-level
credit names an NC source (models estimated section ranges and flagged the
uncertainty), and about 25 uncredited third-party images per illustrated book
that the brief told them to exclude and the published versions kept.

## Findings for the intake brief and parser

- Every model read the chunker's designed overlap (a chunk opening with the
  previous chunk's last paragraph) as duplicated extraction; Opus "repaired"
  it in 14 LSJ chunks. `source-repair.md` should say the overlap is by design.
- AHSS section paths swallow exercise titles, a problem stem and a learning
  objective (excerpts 172–179); the reviewers copied the text into chunks but
  cannot fix paths. Parser or chunker work for the PC.
- The rights brief needs the recorded policy details above (short emails,
  card text under single-use permission, chapter-level NC credits, uncredited
  third-party images) before any model runs it unattended.

## Not tested

Sonnet 5.5 at medium effort and Opus 5.5 at low effort, the obvious next
cost cuts; topic proposals across a whole book; split-scope assembly;
publishing. One run per model per book: small samples, the gaps above
are large enough to matter, the 1–2 point differences are not.
