# Curate-turn fold capacity

How many library sections one curate-mode chat turn can work through under live
turn-note compaction, and what gives way first.

No model was called. The section text, every tool result, and the summarizer are
synthetic. What is measured is the compaction mechanism: when a fold runs, how
much of the turn stays verbatim, how large the admitted request gets, and how the
12,000-token note ceiling behaves as sections accumulate. Note quality is not
measured and cannot be inferred from these numbers.

## What the script simulates

[`turn_fold_capacity.py`](../scripts/turn_fold_capacity.py) builds a message list
in the shape `agent.py` builds one: the real chat system prompt, the query tagged
`_kind: "query"`, then tool exchanges. Before every simulated model response it
calls `compact.compact_messages` with the same keyword arguments the agent uses
(`schemas`, `extra`, `protect_live_chain=True`, `allow_summary=True`). Nothing in
`compact.py`, `agent.py` or `prompts/chat.py` was changed.

One curate-mode section costs three exchanges. Result sizes below are the
`accounting.estimate_context_value` measurements of the generated corpus, after
the real `tools.limit_tool_result` 8,192-token cap (which never fired: no single
result came close).

| Exchange        | Calls per exchange | Result tokens, measured |
| --------------- | ------------------ | ----------------------- |
| search hit list | 1 to 4             | 1,396 to 2,736          |
| full read       | 1 to 2             | 1,356 to 1,822          |
| material receipt| 1                  | 90 to 96                |

The turn closes with one exchange re-reading four sections spread across the
corpus (1,437 to 1,772 tokens each) and one exchange creating the quiz, then a
final admission standing in for the answer text.

The corpus is deterministic by seed. Each section is 626 to 817 words of
template-generated biology or statistics prose and plants a unique excerpt id
(`ex_f03s2`) plus a unique fact code (`KEY-F03S2-...`) inside that prose, so
survival through a fold is a string search. The fact code sits a third of the way
into the section, past the length of any hit-list snippet, so it reaches the
conversation only through a full read. Excerpt ids also appear in hit lists, and
a hit list samples the whole corpus, so every excerpt id shows up in the first
few steps. **Fact codes are the per-section signal; excerpt-id counts are not.**

One section in three carries a figure. When such a section is read, a capture
attaches and its `capture.patch_tokens` estimate (1,036 to 2,000 tokens each)
rides in `extra` for every later admission, the way `capture.image_tokens` does in
`agent.py`. The first 8 captures attach and the rest are ignored, matching
`cfg.captures_per_turn`.

Tool schemas are the 12 real contract definitions from `contract.model_schema`,
plus `search_knowledge` and `read_knowledge` cloned from `search_workspace` and
`read_document` under their curate-mode names, because the contract has no
definition for them yet. 14 schemas, 3,959 estimated tokens. The system prompt is
the real `chat.system_prompt("en")`, 1,159 estimated tokens.

The summarizer is a deterministic stub. It writes one line per folded step, naming
that step's call plus every excerpt id and fact code the step exposed, chains the
previous note in front of the new lines, and drops the oldest lines first once the
note passes `SUMMARY_MAX_TOKENS`. This is an **upper bound** on id retention: a
real summarizer also has to write prose, locations and facts, so it would keep
fewer ids per token of note.

Budgets are measured from `compact.usable_input_limit`, not assumed. The spec is a
non-Anthropic chat model, so the output reserve is a flat 8,192 tokens.

| Context window | Usable input |
| -------------- | ------------ |
| 32,000         | 23,296       |
| 64,000         | 55,296       |
| 128,000        | 119,296      |
| 200,000        | 191,296      |

## Commands

```sh
uv run --extra test python bench/rag/scripts/turn_fold_capacity.py --files 8 --sections 4
uv run --extra test python bench/rag/scripts/turn_fold_capacity.py --files 16 --sections 4
uv run --extra test python bench/rag/scripts/turn_fold_capacity.py --files 24 --sections 4
```

Every run uses the default seed 7 and the default window sweep
(32k, 64k, 128k, 200k). Raw per-step records land in
[`2026-09-16-turn-fold-capacity/`](2026-09-16-turn-fold-capacity/) as
`<files>x<sections>-w<window>.json`.

The matching in-process test is
`test_curate_turn_folds_every_section_without_losing_an_excerpt_id` in
`pipeline/tests/test_compact.py`: a 32-section curate turn on a 64k window, run
with a smaller stub, asserting no `ContextTooLarge`, at most two exchanges kept
after each fold, and no excerpt id lost from the note chain.

## Results

"Facts still readable" counts the fact codes present in the final request (the
note plus whatever is still verbatim) against the fact codes the turn actually
read. "First fact dropped" is the section count at the first admission where a
fact code that had been in the note was no longer in it.

### 8 files x 4 sections: 32 sections, 99 admissions

| Window  | Sections | Folds | Peak request | Final note | Facts still readable | Summarizer in / out | Outcome                                       |
| ------- | -------- | ----- | ------------ | ---------- | -------------------- | ------------------- | --------------------------------------------- |
| 32,000  | 8 of 32  | 7     | 22,298       | 2,177      | 9 of 9               | 78,059 / 10,481     | `ContextTooLarge` on the 9th section's write   |
| 64,000  | 32 of 32 | 9     | 55,151       | 9,250      | 32 of 32             | 325,360 / 49,253    | completed                                      |
| 128,000 | 32 of 32 | 3     | 119,162      | 9,492      | 32 of 32             | 295,691 / 19,043    | completed                                      |
| 200,000 | 32 of 32 | 1     | 185,033      | 5,581      | 32 of 32             | 168,697 / 5,581     | completed                                      |

No fact code was dropped from the note in any 8x4 run. At 64k the note ends at
9,250 tokens, still under the 12,000 ceiling. At 200k only one fold ran in the
whole turn, so most of the work was still verbatim at the end and the note holds
only 19 of the 32 fact codes; all 32 are in the request.

### 16 files x 4 sections: 64 sections, 195 admissions

| Window  | Sections | Folds | Peak request | Final note | Facts still readable | First fact dropped | Summarizer in / out | Outcome                                      |
| ------- | -------- | ----- | ------------ | ---------- | -------------------- | ------------------ | ------------------- | -------------------------------------------- |
| 32,000  | 9 of 64  | 8     | 22,521       | 2,336      | 10 of 10             | none               | 89,024 / 12,279     | `ContextTooLarge` on the 10th section's read  |
| 64,000  | 64 of 64 | 23    | 55,169       | 11,972     | 47 of 64             | after 45 sections  | 761,052 / 208,315   | completed                                     |
| 128,000 | 64 of 64 | 6     | 118,708      | 11,972     | 47 of 64             | after 54 sections  | 582,390 / 54,832    | completed                                     |
| 200,000 | 64 of 64 | 3     | 189,482      | 11,986     | 50 of 64             | after 59 sections  | 510,831 / 29,056    | completed                                     |

### 24 files x 4 sections: 96 sections, 291 admissions

| Window  | Sections | Folds | Peak request | Final note | Facts still readable | First fact dropped | Summarizer in / out | Outcome                                     |
| ------- | -------- | ----- | ------------ | ---------- | -------------------- | ------------------ | ------------------- | ------------------------------------------- |
| 32,000  | 8 of 96  | 8     | 22,592       | 2,217      | 10 of 10             | none               | 80,807 / 11,392     | `ContextTooLarge` on the 9th section's write |
| 64,000  | 96 of 96 | 34    | 55,244       | 11,983     | 47 of 96             | after 45 sections  | 1,170,074 / 345,788 | completed                                    |
| 128,000 | 96 of 96 | 9     | 119,281      | 11,993     | 46 of 96             | after 45 sections  | 894,341 / 92,172    | completed                                    |
| 200,000 | 96 of 96 | 5     | 191,225      | 11,993     | 46 of 96             | after 58 sections  | 849,138 / 53,108    | completed                                    |

Tripling the corpus from 32 to 96 sections changed nothing about whether the turn
survives: every window at 64k and above ran all 96 sections and 291 admissions
without raising. What did not scale is how much of the work stays addressable. The
number of sections whose read facts are still in the request plateaus at 46 or 47
in every large run, whether the corpus holds 64 sections or 96.

### Where 32k dies

All three 32k runs stop on the 9th or 10th section, and the note is not the
reason: it is only about 2,200 tokens when the turn fails. The floor is
everything else that has to fit in 23,296 usable tokens. In the 8x4 run at the
failing step the system prompt is 1,159, the 14 schemas are 3,959, accumulated
capture estimates are 6,144, and the last two exchanges (a search of up to four
hit lists plus a read) are the rest. Folding to exactly two exchanges is already
the smallest protected set the mechanism will produce, so there is nothing left
to give. Corpus size is irrelevant here: 8, 16 and 24 files all die at the same
place.

### Captures are a standing charge

Image estimates accumulate for the whole turn and ride on every later admission.
By the end of a 16x4 run all 8 `cfg.captures_per_turn` slots are used and `extra`
is 14,082 tokens: 25 percent of the 64k usable budget and 60 percent of the 32k
one. The 24x4 runs settle at 12,584. Nothing releases it before the turn ends, and
the 32k run had already spent 6,144 tokens on captures at the step where it
failed.

### Folds keep exactly two exchanges

Every fold in every run left exactly two exchanges verbatim, matching
`TURN_KEEP_EXCHANGES`. The retained pair is the expensive part of the protected
floor, because one of them can be a four-call search exchange.

### The note saturates and then forgets silently

At 64k with 64 sections the note grows 1,472, 2,564, 3,530 and on to 11,921 over
the first 14 folds, then sits flat at 11,97x for the remaining 9, with 165 note
lines dropped over the run. The 96-section run at 64k does the same thing and
drops 419 lines. Nothing fails at that point. The turn keeps running, keeps
creating materials, and quietly stops carrying the earliest sections' read facts.

Excerpt ids behave differently: they keep reappearing in fresh hit lists, so the
note still names early sections long after it has lost what was read from them.
An id in the note is not evidence the section's content survived.

The plateau is the real capacity number. Across every run that reached it, the
note retains the read facts of about 46 to 47 sections, and that figure did not
move when the corpus grew from 64 to 96 sections. It moved a little with the
window (45 sections at 64k, 54 at 128k, 59 at 200k in the 16x4 runs) only because
a wider window folds later, leaving more material verbatim for longer.

### The quiz step is protected by its re-read, not by the note

In every completed run all four excerpt ids the quiz needed were present in the
final request. The reason is structural: at the admission that creates the quiz, a
fold ran and kept the last two exchanges, one of which is the re-read of those
four sections. Their full text was verbatim in that request. A quiz built from the
note alone would be exposed at these corpus sizes; a quiz that re-reads first is
not. One of the four sections in the 96-section run is `ex_f00s0`, read at the
very start, whose fact code the note had already dropped.

## Limitations

- No model ran, so nothing here says whether a real turn note would be *useful*.
  The stub keeps identifiers perfectly until the ceiling forces a drop; a real
  summarizer writing prose would saturate earlier, not later.
- Synthetic prose and synthetic hit lists. Real hit lists repeat passages across
  queries and real sections vary far more in length.
- Token counts are `accounting.estimate_context_value` estimates, the same ones
  admission uses. They are deliberately conservative and are not provider counts.
- The simulated turn has no conversation history, so only the turn-note path runs;
  the checkpoint path that folds completed history is untested here.
- Assistant messages carry no provider reasoning-continuity items
  (`output_items`). On providers that keep them, the two retained exchanges are
  larger than measured and every window's capacity is slightly lower.
- Tool call arguments are short. A model that writes long queries or long
  `create_material` payloads pushes the protected exchanges up.
- One seed, one exchange shape. The per-section cost is a plausible pattern, not a
  measured distribution from production traffic.

## Conclusion

A curate turn on a 64k model or wider does not run out of context. 96 sections
across 24 files finished on every window from 64k up, with no `ContextTooLarge`
anywhere, and the folding kept up with 291 admissions. The fold mechanism is not
the limit on how many files a turn can walk through.

Two things do limit it.

First, small models cannot do curate mode at all. A 32k window stops at 8 or 9
sections regardless of corpus size, because the protected floor (system prompt,
14 tool schemas, the two retained exchanges, and the accumulated capture estimate)
already fills 23,296 usable tokens. There is no tuning left inside compaction to
recover that; the turn either gets a bigger window or carries fewer schemas,
smaller exchanges, or fewer captures.

Second, and more quietly, the turn's memory of its own work stops growing at
roughly 46 sections. The note hits its 12,000-token ceiling and then drops its
oldest lines, so a 96-section turn ends knowing what it read in the last ~46
sections and nothing about the first 50. It does not fail, warn, or slow down. Any
curate step that needs to reason across everything it has read (choosing the
hardest sections, cross-referencing, deduplicating) is working from a partial
record once the corpus passes about 46 sections. Steps that re-read before acting
are unaffected: the end-of-turn quiz kept all four of its sections in every
completed run, because the re-read exchange is one of the two the fold preserves.

Assumed, not measured: that a real summarizer would saturate no later than this
stub. The stub writes nothing but identifiers, which is the most id-dense note
possible, so the 46-section plateau is a ceiling rather than an estimate.

The practical reading: budget a curate turn at roughly 40 sections, or about 10
files at 4 sections each, if the turn has to reason over everything it read. Above
that, either split the work across turns, or persist per-section results outside
the conversation (the materials themselves already are such a store) rather than
relying on the turn note to carry them.
