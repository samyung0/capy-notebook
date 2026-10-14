/* The equation nodes and their `$`/`$$` input rules, declared here instead of
   imported from @platejs/math: that package imports KaTeX and its stylesheet,
   which the editors never use (MathLive draws every formula). The rules are
   @platejs/math 53's MathRules.markdown. */
import {
  createBlockFenceInputRule,
  type DelimitedInlineInputRuleMatch,
  defineInputRule,
  KEYS,
  matchDelimitedInline,
  type SlateEditor,
} from 'platejs';
import { createPlatePlugin } from 'platejs/react';

export const EquationPlugin = createPlatePlugin({
  key: KEYS.equation,
  node: { isElement: true, isVoid: true },
});

export const InlineEquationPlugin = createPlatePlugin({
  key: KEYS.inlineEquation,
  node: { isElement: true, isInline: true, isVoid: true },
});

/** No formula starts inside code or another formula. */
const inputAllowed = ({ editor }: { editor: SlateEditor }) =>
  !editor.api.some({
    match: {
      type: [
        editor.getType(KEYS.codeBlock),
        editor.getType(KEYS.equation),
        editor.getType(KEYS.inlineEquation),
      ],
    },
  });

const INLINE_BOUNDARY = /[\s([{'"`]/;
const INLINE_FOLLOW = /[\s)\]}:;,.!?'"`]/;

type InlineEquationMatch = {
  deleteRange: DelimitedInlineInputRuleMatch['deleteRange'];
  texExpression: string;
};

/** `$x$` typed in text becomes an inline formula. */
export const inlineEquationRule = defineInputRule<InlineEquationMatch>({
  apply: ({ editor }, match) => {
    editor.tf.delete({ at: match.deleteRange });
    editor.tf.select(match.deleteRange.anchor);
    editor.tf.insertNodes({
      children: [{ text: '' }],
      texExpression: match.texExpression,
      type: editor.getType(KEYS.inlineEquation),
    });
    return true;
  },
  enabled: inputAllowed,
  resolve: (context) => {
    if (context.text !== '$' || context.options?.at) return;
    const match = matchDelimitedInline(context, {
      boundaryRe: INLINE_BOUNDARY,
      followRe: INLINE_FOLLOW,
      open: '$',
      requireClosingDelimiter: false,
      trim: 'reject',
    });
    return (
      match && { deleteRange: match.deleteRange, texExpression: match.content }
    );
  },
  target: 'insertText',
  trigger: '$',
});

/** A paragraph of `$$` turns into a block formula on Enter. */
export const equationRule = createBlockFenceInputRule({
  apply: ({ editor }, match) => {
    editor.tf.removeNodes({ at: match.path });
    editor.tf.insertNodes(
      {
        children: [{ text: '' }],
        texExpression: '',
        type: editor.getType(KEYS.equation),
      },
      { at: match.path, select: true }
    );
    return true;
  },
  block: KEYS.p,
  enabled: inputAllowed,
  fence: '$$',
  on: 'break',
  priority: 100,
});
