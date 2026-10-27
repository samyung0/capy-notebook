import type { MathfieldElement } from 'mathlive';
import { KEYS } from 'platejs';
import { m } from '@/i18n';
import type { NoteEditorInstance } from './insertEditorNode';

/** The formula templates the toolbar's Σ menu offers: glyph, LaTeX, name. */
export const MATH_TEMPLATES = [
  ['∑', '\\sum_{n=1}^{\\infty}', m.editor_math_sum],
  ['∫', '\\int_0^1', m.editor_math_integral],
  ['lim', '\\lim_{x\\to 0}', m.editor_math_limit],
  ['ⁿ√', '\\sqrt[n]{}', m.editor_math_root],
  ['logₐ', '\\log_a', m.editor_math_log],
  ['→', '\\vec{}', m.editor_math_vector],
] as const;

/** An inline formula at the selection, holding the selected text if any. */
export function insertInlineEquation(
  editor: NoteEditorInstance,
  expression?: string
) {
  const selection = editor.selection;
  const texExpression =
    expression ??
    (selection && !editor.api.isCollapsed(selection)
      ? editor.api.string(selection)
      : '');
  editor.tf.focus();
  editor.tf.insertNodes(
    { children: [{ text: '' }], texExpression, type: KEYS.inlineEquation },
    selection ? { at: selection, select: true } : { select: true }
  );
}

/** A template into the formula being edited, else as a new inline formula. */
export function insertMathTemplate(
  editor: NoteEditorInstance,
  expression: string
) {
  const active = document.activeElement;
  if (active?.tagName.toLowerCase() === 'math-field') {
    (active as MathfieldElement).insert(expression);
    return;
  }
  insertInlineEquation(editor, expression);
}
