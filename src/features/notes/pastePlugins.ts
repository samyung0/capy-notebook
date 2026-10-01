import { createSlatePlugin, isHtmlBlockElement, KEYS } from 'platejs';
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
