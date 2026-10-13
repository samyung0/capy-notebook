# Graph editor: Desmos-style list and board

Plan from 2026-10-13. Mocks (round 2, approved): https://22k07cljxnpa.postplan.dev
(local copy `artifacts/2026-10-13-graph-editor-mocks.html`). Current behaviour
lives in `openwiki/question-bank.md` (Editing and assets) and
`openwiki/frontend/plate-editor.md`.

## Decided (Epo, 2026-10-13)

- Layout A: expression rows on the left (320px), a large board on the right, in
  the chart dialog's frame (SimpleDialog 1040, underline `Field`/`SelectField`,
  ghost Advanced, Cancel and Save pills, no Remove). Phones stack the board on
  top in the same card and scroll as one page (P1).
- Rows are typeset with MathLive while typing (I1).
- Input follows Desmos's syntax. Desmos itself is never embedded or called.
- Implicit curves and inequalities are in scope, including implicit ones such as
  `x^2 + y^2 < 4`.
- Readers still get the static SVG only. No sliders or interactive graphs.
- A row with an error shows only the warning icon and a wavy underline; the
  message is the icon's tooltip.
- Description stays outside Advanced (it is required), nudged 2px like the chart
  dialog's Advanced fields. Notes show it under the graph as a muted caption
  (`MEDIA_CAPTION_CLASS`, as image captions do).
- Pan and zoom are judged live, not in mocks.
- The agent's `plot` block is out of scope.

## What you can type

| Kind | Row | Stored as |
| --- | --- | --- |
| Function | `y = 0.5x^2 - 3`, `f(x) = sin(x)` | `functiongraph` (exists) |
| Restriction | `y = sqrt(x) {0 <= x <= 4}` | `functiongraph` + `domain` (exists) |
| Implicit curve | `x^2/16 + y^2/4 = 1`, `x = 2` | `implicit`, relation `=` (new) |
| Inequality | `y > x + 2`, `x^2 + y^2 <= 4` | `implicit`, relation `<` `<=` `>` `>=` (new) |
| Point | `A = (-2, -1)`, `(3, 4)` | `point`, the name is its label (exists) |
| Segment, line | `segment(A, B)`, `line(A, B)` | `segment`, `line` (exists) |
| Polygon, circle | `polygon(A, B, C)`, `circle(A, 3)` | `polygon`, `circle` (exists) |
| Angle, arc, sector | `angle(B, A, C)`, `arc(O, A, B)`, `sector(O, A, B)` | exists |
| Label | Add label button: text and position | `text` (exists) |

Line style, equal-side marks, shading, hiding and an angle's label sit in the
row's style menu (its left button), not in the typed text. Parametric and polar
curves come later.

## Phase 1: editor, frontend only

No stored-format change, so nothing for Go or Rust.

- `src/features/questions/graphSyntax.ts` (new): row text to recipe element and
  back, for the existing element types. Inserts the `*` JessieCode needs
  (`2x`, `sin x`). Errors carry the tooltip copy (Paraglide).
- MathLive rows: ASCII-math out of the field, converted to the stored
  JessieCode term; the reverse to show a saved term. Stored terms stay what they
  are today.
- `src/features/questions/graph.ts`: keep one board while editing and update
  the changed elements in place instead of rebuilding on every change. Turn on
  JSXGraph's own pan and zoom (drag, wheel, pinch, two-finger pan, double-click),
  keep equal scale on both axes, smooth the wheel zoom around the pointer, and
  write the visible area back to `board.bbox` so Save keeps what is framed. Fit
  button frames every element. Dragging a point updates its row.
- `src/features/questions/GraphEditor.tsx`: rewritten as the row list (style
  button, ⋮ menu, trailing empty row, Add label), Advanced (width, height, axes,
  grid, attribution) and Description. Used by both `QuestionDialog` and the
  note's `VisualBlockDialog`; the note dialog goes from 760 to 1040 wide.
- Notes: the description as a muted caption under the graph (`FigureView` in
  `src/features/materials/staticViews.tsx`, so the editor, view mode and shared
  pages match).
- Image viewer pan and zoom (`react-zoom-pan-pinch`) is untouched; it only
  scales a picture.

## Phase 2: implicit curves and inequalities

New element, one type for both:

```ts
{ type: 'implicit'; id: string; left: string; right: string;
  relation: '=' | '<' | '<=' | '>' | '>='; dash?: boolean; hidden?: boolean }
```

- `left` and `right` keep the row as typed, so it prints back the same way. Both
  are JessieCode terms over `x` and `y` (the term check gains `y` for this type
  only). `y = f(x)` keeps parsing to `functiongraph`, which draws exactly.
- Drawing: F = left − right. The edge is JSXGraph's `implicitcurve` for F = 0,
  dashed when the relation is strict. The shading samples F over the visible area
  (about one point per 4px, coarser while panning or zooming) and traces F < 0
  (or > 0) into one SVG `<path>` in the board's SVG, which the export then
  carries. One path avoids hairline seams at 15% opacity. Undefined values
  (`sqrt`, `log`, division by zero) count as outside. JSXGraph's own
  `inequality` only covers lines and `y = f(x)`, so every inequality goes through
  the sampler instead.
- Proposed cap: 8 implicit elements per graph (`QUESTION_GRAPH_IMPLICIT_MAX`),
  since each is sampled on every redraw.

Files that change for the new type:

- TypeScript: `src/features/questions/types.ts`, `validation.ts`, `graph.ts`,
  `graphSyntax.ts`.
- Go: `server/internal/questions/questions.go` (element keys, term check with
  `y`), `server/internal/fieldlimits/fieldlimits.go` (new cap), then
  `pnpm gen:openapi` regenerates the limits and the embed catalog
  (`src/api/limits.generated.ts`, `src/api/embeds.generated.ts`,
  `pipeline/pipeline/generated/`, `collaboration-rs/crates/notes/src/catalog.rs`);
  commit `catalog.rs` with it.
- Rust: `collaboration-rs/crates/notes/src/questions.rs` (`graph_element`,
  `valid_graph_term`), reading the cap from the generated `catalog.rs` rather
  than a hand-copied constant, and the parity fixtures in
  `collaboration-rs/crates/items/tests/parity/` (`rust.json`, `ts.json`).
  Live quiz rooms validate through the same `notes::questions` path;
  `crates/items/src/quiz.rs` stores a graph as one opaque value and needs no
  change.
- Lab: `lab/questions/schema.py` (the bank writer's schema), so bank recipes can
  use the new type; `lab/questions/render-client.tsx` already renders through
  `renderGraphSvg`.

## Tests and docs

- Unit: `graphSyntax` parse and print for each row kind; the region sampler on
  a disk, a half-plane and a function with an undefined part; the new type's
  validation in TS, Go and Rust through the shared parity fixtures (Rust
  `items/tests/parity/`, Go `server/internal/questions/testdata/`): an
  `implicit` with an x-only term, a `y` in a non-implicit element (refused),
  and a bad relation.
- One editor e2e: type a row, see the board change, save, see the SVG.
- Update `openwiki/question-bank.md`, `openwiki/frontend/plate-editor.md` and
  `openwiki/test-catalog.md`.

## Rust session check (2026-10-13)

No clash. The Rust session will soon swap the hand-copied limits at the top of
`notes/src/questions.rs` for `catalog.rs` constants and edit `material.rs`,
`limits.rs` and `edit.rs`; it leaves `graph_element` and `valid_graph_term`
alone. Whoever lands second in `questions.rs` rebases. A graph stays an inline
value replaced whole (last save wins), so in-place board updates in phase 1 are
editor-local. Phase 2 ships Go, Rust and the browser in one release: an older
server refuses an unknown element type, which in a live quiz room closes the
writer's channel and sends unsaved edits to recovery. Say so in the landing
notes.

## Open

- Saving with a row in error: refuse Save and point at the marked rows
  (proposed), or drop those rows.
- Dragged points: round to 0.1 (proposed), or snap to the grid when it shows.
- The implicit cap of 8.
