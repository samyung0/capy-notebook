# Ledger vs no ledger (2026-10-13)

Does the chat agent's build ledger (todos the model must create and name on
every write) pay for itself? Two playground arms over the same 16 requests, on
main e639e4c9 (contract v20: the three question tools, shuffled options, nulls
dropped), GLM-5.3-Flash at high reasoning, Library on, decks off, one run per
request.

- `measure-ledger`: production (`intake-a`).
- `measure-noledger`: the same with `ledger_mode: off` (no `create_ledger`, no
  `todo` argument; once a write lands the turn has the build budget, and every
  successful write is stall-guard progress) and `excerpts: auto` (no
  `excerpt_ids`; a write credits the excerpts read since the previous write, or
  all read this turn when none are new). See `lab/playground/README.md`.

Requests (`bench/rag/intake/fixtures/requests.json`): gen-01, gen-02, gen-05,
gen-07 (two-turn multi-chapter flows), stat-05, -07, -11, -15, -18, -19,
form-01, -03, -05, -06, -07, -08. Driver:
`run_requests.py --config <arm> --once`. Run records:
`bench/rag/reports/local/2026-10-13-noledger/` (local). The question bank was
not running on the PC, so neither arm had the bank tools; every question was
written through the question tools. A first batch ran without the library (the
worktree had no `.env.local`); it is kept under `no-library/` and agrees with
the numbers below on refusals.

## Results

| | Ledger | No ledger + auto credits |
|---|---|---|
| Input tokens | 8.94M (7.94M cached) | 6.61M (5.88M cached), −26% |
| Wall time | 118 min | 102 min |
| Write calls | 90 | 91 |
| Refused writes | 22 (24%) | 8 (9%) |
| Turns ending on a refused write | 0 | 0 |
| Stall-guard stops | 0 | 0 |
| Materials | 61 (32 notes, 23 quizzes, 6 flashcards) | 65 (36 notes, 28 quizzes, 1 flashcards) |
| Questions written | 411 | 401 |
| Excerpts read / page captures | 99 / 5 | 73 / 13 |
| Uncredited materials | 0 | 0 |
| Books credited per material | 1–4 (max 4) | 1–8; 13 of 65 credit 5 or more |

- **Refusals.** 9 of the ledger arm's 22 refusals were todo bookkeeping (a
  missing todo id, or one already done) and one an unread excerpt; the
  no-ledger arm has none of either. What remains in both is content: note
  fences (YAML/JSON), a figure placement, one edit command, question fields.
- **Tokens.** Most of the saving is the long flow: gen-01 (six chapters) took
  3.87M with the ledger and 1.74M without. Single-topic requests vary both ways
  with how many items the run chose to build.
- **Completeness.** Neither arm reliably builds exactly what was asked, and the
  ledger does not prevent it: the ledger arm built a note without its quiz for
  form-07, stat-05 and stat-07 (and 6 unrequested flashcard sets for gen-01);
  the no-ledger arm did so for form-01 and gave gen-07 one note for its
  chapters. The workspace-only batch showed the same mix.
- **Credits.** Automatic crediting never left a material uncredited, but it
  credits everything read since the previous write, so exploratory reads widen
  the footer (up to 8 books where the ledger arm's model named at most 4).

## Reading

One run per request; differences on single requests are noise. The aggregate
signal is consistent across both batches: without the ledger the agent spends
about a quarter fewer input tokens and has about a third of the refusals, with
no loss of completeness, which the ledger was not securing anyway. Automatic
crediting removes the excerpt refusals but over-credits; naming stays more
precise.

## Follow-up: how precise are the credits?

Every (material, book) pair where the material's write came after a read
from that book: the library-on no-ledger arm (191 automatic book credits on 65
materials) against named credits (`excerpt_ids` chosen by the model) from the
ledger arm and 149 materials in older playground runs (481 credits). A judging
pass (six agents, 255 pairs, each with the material and the text read from the
book) labelled a pair `used` only for something specific to that text: its
worked example, data or numbers, a placed figure, distinctive phrasing.
Pairs sharing 20 or more distinctive word 4-grams (5 for named credits) were
counted as used and uncredited pairs sharing none as unused; 15 of each were
spot-checked and agreed (one came out `topic_only`).

| Credits | Used | Same topic only | Unrelated |
|---|---|---|---|
| Automatic (191) | 129 (68%) | 28 | 34 |
| Named by the model (481) | 456 (95%) | 25 | 0 |

- The model rarely forgets a book: of 160 books it read but did not name, 3
  were used (3 of 459 used books).
- 28 of 65 automatically credited materials list a book they did not use; none
  lists only unused books.
- A filter keeping a candidate book only when the write shares with its read
  text at least one word 4-gram, or one number with a decimal point or two or
  more digits, that no other candidate book's text has: precision 86%, 2 of
  129 used books dropped, no material left uncredited. Three 4-grams: 93%, 6
  dropped. Epo took the first (2026-10-13): a missing credit on a CC BY book
  is the worse error. Named credits stay as named.
