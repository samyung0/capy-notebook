import {
  createSlatePlugin,
  ElementApi,
  isHtmlBlockElement,
  KEYS,
  PathApi,
  RangeApi,
} from 'platejs';
import { ParagraphPlugin } from 'platejs/react';

/**
 * VS Code puts its own payload on every copy, and the code-block plugin turns
 * any such paste into a code block. Markdown copied from VS Code should render
 * as blocks instead, so outside a code block it is pasted as plain markdown.
 */
export const VscodeMarkdownPastePlugin = createSlatePlugin({
  key: 'capy-vscode-markdown-paste',
}).overrideEditor(({ editor, tf: { insertData } }) => ({
  transforms: {
    insertData(data) {
      const block = editor.api.block()?.[0];
      const inCode =
        block?.type === editor.getType(KEYS.codeBlock) ||
        block?.type === editor.getType(KEYS.codeLine);
      if (!inCode && vscodeMode(data) === 'markdown') {
        const markdown = new DataTransfer();
        markdown.setData('text/plain', data.getData('text/plain'));
        insertData(markdown);
        return;
      }
      insertData(data);
    },
  },
}));

function vscodeMode(data: DataTransfer): string | undefined {
  const raw = data.getData('vscode-editor-data');
  if (!raw) return;
  try {
    return (JSON.parse(raw) as { mode?: string }).mode;
  } catch {}
}

/**
 * Many sites and editors (Slack, Discord, contenteditable apps) copy one
 * <div> per line. Plate only maps <p> to paragraphs and flattens unknown divs,
 * which joins the lines, so leaf divs become paragraphs too. Wrapper divs
 * holding blocks still flatten.
 */
export const NoteParagraphPlugin = ParagraphPlugin.configure({
  parsers: {
    html: {
      deserializer: {
        query: ({ element }) =>
          element.style.fontFamily !== 'Consolas' &&
          (element.nodeName !== 'DIV' ||
            ![...element.children].some(isHtmlBlockElement)),
        rules: [{ validNodeName: ['P', 'DIV'] }],
      },
    },
  },
});

/**
 * Blocks pasted while the caret is on a void block (a quiz, an image, an
 * embed) go in right after that block, the caret following them. Slate drops
 * a fragment inserted into a void, so the paste would do nothing.
 */
export const VoidBlockPastePlugin = createSlatePlugin({
  key: 'capy-void-block-paste',
}).overrideEditor(({ editor, tf: { insertFragment } }) => ({
  transforms: {
    insertFragment(fragment, options) {
      const selection = editor.selection;
      const entry =
        !options?.at && selection && RangeApi.isCollapsed(selection)
          ? editor.api.block()
          : undefined;
      if (
        entry &&
        editor.api.isVoid(entry[0]) &&
        fragment.length > 0 &&
        fragment.every(
          (node) => ElementApi.isElement(node) && editor.api.isBlock(node)
        )
      ) {
        editor.tf.insertNodes(fragment, {
          at: PathApi.next(entry[1]),
          select: true,
        });
        return;
      }
      insertFragment(fragment, options);
    },
  },
}));
