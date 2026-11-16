import { createSlateEditor, NodeApi, type Value } from 'platejs';
import { expect, it } from 'vitest';
import { FormulaJoinPlugin } from './formulaJoin';

const split = (before: string, after: string): Value => [
  { children: [{ text: before }], type: 'p' },
  { children: [{ text: '' }], texExpression: 'x^2', type: 'equation' },
  { children: [{ text: after }], type: 'p' },
];

const editorWith = (value: Value) =>
  createSlateEditor({ plugins: [FormulaJoinPlugin], value });

const texts = (value: Value) =>
  value.map((block) => [block.type, NodeApi.string(block)]);

it('joins the paragraphs around a removed display formula', () => {
  const editor = editorWith(
    split('structures found in ', 'the two cell types')
  );
  editor.tf.select({ offset: 0, path: [1, 0] });
  editor.tf.deleteBackward('character');
  expect(texts(editor.children)).toEqual([
    ['p', 'structures found in the two cell types'],
  ]);
  expect(editor.selection?.anchor).toEqual({ offset: 20, path: [0, 0] });
});

it('keeps a line break where the seam has no space', () => {
  const editor = editorWith(split('First line.', 'Second line.'));
  editor.tf.select({ offset: 0, path: [2, 0] });
  editor.tf.deleteBackward('character');
  expect(texts(editor.children)).toEqual([['p', 'First line.\nSecond line.']]);
});
