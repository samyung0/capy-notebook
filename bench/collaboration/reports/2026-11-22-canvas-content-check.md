# Canvas room content check: cost on recorded editor sessions (2026-11-22)

The canvas room now checks every update against the board's rules
(`board::admit_shapes`, Epo 2026-11-22 "sure A then"; openwiki/frontend/plate-editor.md,
"What the room admits"). This measures what that check adds to an update's admission,
on updates a real editor sent.

## Input

`collaboration-rs/crates/board/tests/fixtures/editor-sessions.json.gz`: 4 sessions,
7,524 updates, written by the growth bench
(`bench/collaboration/scripts/board-growth.growth.ts`) with
`GROWTH_SESSIONS=1 GROWTH_MINUTES=10` and the tests "a mixed hour", "adding then
deleting", "shapes with text" and "notes": pen strokes, undo, shapes dragged, resized
and labelled, notes typed and edited, planes opened, things deleted, each session from
the board's first state. The bench's "plane edits" test is out of date (the plane editor
now writes only when it closes) and was left out.

## Run

```bash
pnpm --config.verify-deps-before-run=false run test:collaboration -p board --test replay --release -- --nocapture
```

M1 MacBook Air, 8 GB, release with debug info, other work running on the machine.

## Results

| | updates | median | p99 | max |
|---|---|---|---|---|
| placement (`inspect_bounded`, its trial copy) and content check | 7,524 | 4.7 µs | 207 µs | 1.7 ms |
| content check alone | 7,524 | 3.2 µs | 31 µs | 99 µs |

Every update was admitted: the rules refuse nothing these sessions wrote. They are
online sessions, one update per transaction; updates sent together after a reconnect
(offline work, an erase and its undo, overwritten values merged into one struct) are
covered by the parity cases and the room tests, not by this replay.

## Reading

The content check is about a seventh of what admission spends at p99 and a twentieth
at the worst update. An earlier build of this branch, run while the machine was busy,
gave the check 51 µs at p99 and 1.5 ms at most, so read these as orders of magnitude.
The slowest updates are those that take the trial copy, where the check reads the
touched entities from the copy instead of the overlay. Its
cost grows with the update, the entities it touches and the room items its delete
ranges cover (a reconnect repeats its whole delete set), and that walk counts toward the
work budget: the step-count tests (`crates/board/tests/admit_cost.rs`) hold it linear for
a small edit on a large board and for a reconnect that repeats a long delete set, and
refuse a tiny update whose delete range would walk a whole history past the budget.
