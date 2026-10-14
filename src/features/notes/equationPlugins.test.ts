import { createPlateEditor } from 'platejs/react';
import { expect, it } from 'vitest';
import {
  EquationPlugin,
  equationRule,
  InlineEquationPlugin,
  inlineEquationRule,
} from './equationPlugins';

/** The rules copied from @platejs/math 53 still turn typed dollars into
 * formulas (checked against that package's MathRules when copied). */
function typed(text: string, enter = false) {
  const editor = createPlateEditor({
    plugins: [
      InlineEquationPlugin.configure({ inputRules: [inlineEquationRule] }),
      EquationPlugin.configure({ inputRules: [equationRule] }),
    ],
    value: [{ children: [{ text: '' }], type: 'p' }],
  });
  editor.tf.select({ offset: 0, path: [0, 0] });
  for (const ch of text) editor.tf.insertText(ch);
  if (enter) editor.tf.insertBreak();
  return editor.children;
}

it('turns $x$ into an inline formula', () => {
  expect(typed('area $x^2$')).toEqual([
    {
      children: [
        { text: 'area ' },
        {
          children: [{ text: '' }],
          texExpression: 'x^2',
          type: 'inline_equation',
        },
        { text: '' },
      ],
      type: 'p',
    },
  ]);
  expect(typed('costs $5 or $6')[0]).toEqual({
    children: [{ text: 'costs $5 or $6' }],
    type: 'p',
  });
});

it('turns a $$ paragraph into a block formula on Enter', () => {
  expect(typed('$$', true)).toEqual([
    { children: [{ text: '' }], texExpression: '', type: 'equation' },
  ]);
});
