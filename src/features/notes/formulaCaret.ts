import { KEYS, RangeApi } from 'platejs';
import { createPlatePlugin, type PlateEditor } from 'platejs/react';

// How long after a press its selection may still arrive: Slate takes DOM
// selection changes throttled, so it can land after the click.
const PRESS_MS = 500;

/** Each editor's last press beside, not on, a formula. */
const presses = new WeakMap<PlateEditor, { at: number; x: number }>();

/** After a press beside a formula, a caret inside it moves out to the side
 * pressed. */
function moveBeside(editor: PlateEditor) {
  const press = presses.get(editor);
  const { selection } = editor;
  if (
    !press ||
    performance.now() - press.at > PRESS_MS ||
    !(selection && RangeApi.isCollapsed(selection))
  )
    return;
  const entry = editor.api.above({
    at: selection,
    match: { type: KEYS.inlineEquation },
  });
  if (!entry) return;
  presses.delete(editor);
  const box = editor.api.toDOMNode(entry[0])?.getBoundingClientRect();
  const after = !box || press.x >= box.left + box.width / 2;
  const point = after
    ? editor.api.after(entry[1])
    : editor.api.before(entry[1]);
  if (point) editor.tf.select(point);
}

/** A press beside an inline formula, not on it, puts the caret beside it on
 * the side pressed (Epo 2026-11-16, "clicking after it doesnt insert the
 * caret"). Chrome lands such a press in the formula's hidden spacer, which
 * selects the formula itself, and typing there writes nothing. The selection
 * may arrive after the click (Slate throttles it), or not change at all when
 * the formula was already selected, so both the click and the selection
 * change check. Notes and the question editors both use it. */
export const FormulaCaretPlugin = createPlatePlugin({
  handlers: {
    onClick: ({ editor }) => {
      moveBeside(editor);
    },
    onKeyDown: ({ editor }) => {
      presses.delete(editor);
    },
    onMouseDown: ({ editor, event }) => {
      const onFormula =
        event.target instanceof Element &&
        event.target.closest('[data-slate-void]');
      if (onFormula) presses.delete(editor);
      else presses.set(editor, { at: event.timeStamp, x: event.clientX });
    },
  },
  key: 'capy-formula-caret',
}).overrideEditor(({ editor, tf: { apply } }) => ({
  transforms: {
    apply(operation) {
      apply(operation);
      if (operation.type === 'set_selection') moveBeside(editor);
    },
  },
}));
