import { type Editor, KEYS, type TElement } from 'platejs';
import {
  createPlatePlugin,
  useEditorSelector,
  usePluginOption,
} from 'platejs/react';
import { useEffect } from 'react';
import { m } from '@/i18n';

/** The empty paragraph's "Type / for commands" (BlockPlaceholderPlugin's). */
export const PLACEHOLDER_CLASS =
  'before:absolute before:cursor-text before:text-placeholder before:text-sm before:leading-[2] before:font-normal before:content-[attr(placeholder)]';

/** The note's last block, when it is an empty plain paragraph. */
export function openEnd(editor: Editor) {
  const last = editor.children.at(-1);
  return last?.type === KEYS.p &&
    !last.listStyleType &&
    editor.api.isEmpty(last)
    ? last
    : null;
}

/**
 * The note always ends with "Type / for commands" (Epo 2026-11-17): an empty
 * last paragraph shows it unfocused too, and a note ending in anything else
 * draws it after its last block (`data-trailing-hint` on the editable,
 * `tailwind.css`), where a click adds the paragraph (`openTrailingParagraph`).
 * Nothing is written for it: opening a note writes nothing (2026-11-04). A
 * note of one empty paragraph has the editor's own placeholder instead.
 */
export const trailingHintPlugin = createPlatePlugin({
  editOnly: true,
  // camelCase: Plate names a style entry after it.
  key: 'trailingHint',
  options: { last: null as TElement | null },
  useHooks: ({ setOption }) => {
    const last = useEditorSelector(
      (editor) => (editor.children.length > 1 ? openEnd(editor) : null),
      []
    );
    useEffect(() => setOption('last', last), [last, setOption]);
  },
})
  .extendSelectors(({ getOption }) => ({
    isLast: (node?: TElement) => !!node && getOption('last') === node,
  }))
  .extend({
    inject: {
      isBlock: true,
      nodeProps: {
        transformProps: (props) => {
          // A hook, as BlockPlaceholderPlugin's: only the block whose answer
          // changed renders again. Every block runs it, as that plugin's
          // does: one block turning into a paragraph (a heading emptied and
          // reset) keeps its React element, so a hook for paragraphs alone
          // would change its hook count.
          const isLast = usePluginOption(props.plugin, 'isLast', props.element);
          if (isLast)
            return {
              className: PLACEHOLDER_CLASS,
              placeholder: m.editor_placeholder(),
            };
        },
      },
    },
  });
