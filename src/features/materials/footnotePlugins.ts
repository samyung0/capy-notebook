import { createSlatePlugin } from 'platejs';

/** Markdown footnotes as the editor's markdown import reads them (the embed
 * catalog): there is no footnote block yet, so a reference draws nothing. */
export const FootnotePlugins = [
  createSlatePlugin({
    key: 'footnoteReference',
    node: {
      isElement: true,
      isInline: true,
      isVoid: true,
      type: 'footnoteReference',
    },
  }),
  createSlatePlugin({
    key: 'footnoteDefinition',
    node: { isElement: true, type: 'footnoteDefinition' },
  }),
];
