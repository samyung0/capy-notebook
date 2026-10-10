import { LinkPlugin } from '@platejs/link/react';
import { ImagePlugin, PlaceholderPlugin } from '@platejs/media/react';
import { createPlateEditor } from 'platejs/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { importMarkdownDocument } from './documentAdapters';
import { noteMarkdownPlugin } from './markdown';
import { markdownToDocument } from './markdownConvert';
import {
  pastedImage,
  pastedImagesPlugin,
  readPastedImage,
  settlePastedImage,
} from './pastedImages';
import { VscodeMarkdownPastePlugin } from './pastePlugins';

type Node = {
  children?: Node[];
  id?: string;
  text?: string;
  type?: string;
  url?: string;
};

function editorWith(allowExternalAssets: boolean) {
  const editor = createPlateEditor({
    plugins: [
      ImagePlugin.configure({
        options: { disableEmbedInsert: true, disableUploadInsert: true },
      }),
      PlaceholderPlugin,
      LinkPlugin,
      noteMarkdownPlugin,
      VscodeMarkdownPastePlugin,
      pastedImagesPlugin(allowExternalAssets),
    ],
    value: [{ children: [{ text: 'note' }], id: 'b1', type: 'p' }] as never,
  });
  editor.tf.select({ offset: 4, path: [0, 0] });
  return editor;
}
type Editor = ReturnType<typeof editorWith>;

const children = (editor: Editor) => editor.children as unknown as Node[];

/** Pasted HTML as Plate's image parser leaves it: `<img src>` is a URL-only
 * image node between the paragraphs it sat between. */
const pastedHtml = [
  { children: [{ text: 'before' }], type: 'p' },
  { children: [{ text: '' }], type: 'img', url: 'https://cdn.example/fig.png' },
  { children: [{ text: 'after' }], type: 'p' },
];

const png = () =>
  new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' });

const blocked = () =>
  vi.fn(async () => {
    throw new TypeError('Failed to fetch');
  });

/** Settles every pasted placeholder as its element would, uploading through
 * `upload`. */
async function settleAll(editor: Editor, upload: (file: File) => unknown) {
  const ids = children(editor)
    .filter((node) => node.type === 'placeholder')
    .map((node) => node.id!);
  for (const id of ids)
    await settlePastedImage(editor, id, pastedImage(id)!, {
      signal: new AbortController().signal,
      upload: async (file) => void upload(file),
    });
}

afterEach(() => vi.unstubAllGlobals());

describe('pasted images', () => {
  // A browser's Copy image puts the file and an <img> on the clipboard.
  it('uploads a clipboard image file pasted with HTML through a placeholder', () => {
    const editor = editorWith(true);
    const file = new File([png()], 'shot.png', { type: 'image/png' });
    const preventDefault = vi.fn();
    const handled = editor
      .getPlugin(pastedImagesPlugin(true))
      .handlers.onPaste?.({
        editor,
        event: { clipboardData: { files: [file] }, preventDefault },
      } as never);
    expect(handled).toBe(true);
    expect(preventDefault).toHaveBeenCalled();
    const placeholder = children(editor).find(
      (node) => node.type === 'placeholder'
    );
    expect(placeholder).toBeDefined();
    expect(
      editor
        .getApi(PlaceholderPlugin)
        .placeholder.getUploadingFile(placeholder!.id!)
    ).toBe(file);
  });

  // A drop reaches insertData too; the DnD plugin's file drop makes its
  // placeholder, so a second one would upload the file twice.
  it('leaves a dropped file to the DnD plugin', () => {
    const editor = editorWith(true);
    const file = new File([png()], 'shot.png', { type: 'image/png' });
    editor.tf.insertData({
      files: [file] as unknown as FileList,
      getData: () => '',
      types: ['Files'],
    } as unknown as DataTransfer);
    expect(children(editor).some((node) => node.type === 'placeholder')).toBe(
      false
    );
  });

  it('keeps a pasted <img> in its place as a placeholder that reads its URL', () => {
    const editor = editorWith(true);
    editor.tf.insertFragment(pastedHtml as never);
    const types = children(editor).map((node) => node.type);
    expect(types).toEqual(['p', 'placeholder', 'p']);
    expect(children(editor).some((node) => node.type === 'img')).toBe(false);
    const placeholder = children(editor)[1]!;
    expect(pastedImage(placeholder.id!)).toEqual({
      text: '',
      url: 'https://cdn.example/fig.png',
    });
  });

  it('makes a pasted <img> a link without asset uploads', () => {
    const editor = editorWith(false);
    editor.tf.insertFragment(pastedHtml as never);
    expect(children(editor)[1]).toMatchObject({
      children: [
        { text: '' },
        {
          children: [{ text: 'https://cdn.example/fig.png' }],
          type: 'a',
          url: 'https://cdn.example/fig.png',
        },
        { text: '' },
      ],
      type: 'p',
    });
  });

  it('reads a data: URL image in the browser', async () => {
    const file = await readPastedImage('data:image/png;base64,iVBORw0KGgo=');
    expect(file?.type).toBe('image/png');
    expect(file?.name).toBe('pasted-image.png');
  });

  it('uploads an image a CORS-readable host serves, named after its path', async () => {
    const fetch = vi.fn(async () => new Response(png()));
    vi.stubGlobal('fetch', fetch);
    const editor = editorWith(true);
    editor.tf.insertFragment(pastedHtml as never);
    const id = children(editor)[1]!.id!;
    const upload = vi.fn();
    await settleAll(editor, upload);
    expect(fetch).toHaveBeenCalledWith('https://cdn.example/fig.png', {
      credentials: 'omit',
      signal: expect.any(AbortSignal),
    });
    const [uploaded] = upload.mock.calls[0] as unknown as [File];
    expect(uploaded.name).toBe('fig.png');
    expect(uploaded.type).toBe('image/png');
    expect(pastedImage(id)).toBeUndefined();
  });

  it('turns an image the browser cannot read (no CORS) into a link', async () => {
    vi.stubGlobal('fetch', blocked());
    const editor = editorWith(true);
    editor.tf.insertFragment(pastedHtml as never);
    const upload = vi.fn();
    await settleAll(editor, upload);
    expect(upload).not.toHaveBeenCalled();
    expect(children(editor).map((node) => node.type)).toEqual(['p', 'p', 'p']);
    expect(children(editor)[1]!.children![1]).toMatchObject({
      type: 'a',
      url: 'https://cdn.example/fig.png',
    });
  });

  it('drops an unreadable image whose URL is not web', async () => {
    vi.stubGlobal('fetch', blocked());
    const editor = editorWith(true);
    editor.tf.insertFragment([
      { children: [{ text: '' }], type: 'img', url: 'javascript:alert(1)' },
    ] as never);
    await settleAll(editor, vi.fn());
    expect(children(editor).some((node) => node.type === 'placeholder')).toBe(
      false
    );
    expect(JSON.stringify(editor.children)).not.toContain('javascript:');
  });
});

describe('markdown images in the browser', () => {
  const markdown = [
    'Tangents',
    '![Tangent figure](https://cdn.example/tangent.png)',
    '![dot](data:image/png;base64,iVBORw0KGgo=)',
  ].join('\n\n');

  // The three ways markdown reaches a note in the browser.
  const ways: [string, (editor: Editor) => void][] = [
    [
      'pasted as text',
      (editor) =>
        editor.tf.insertData({
          files: [],
          getData: (type: string) => (type === 'text/plain' ? markdown : ''),
          types: ['text/plain'],
        } as unknown as DataTransfer),
    ],
    [
      'pasted from VS Code',
      (editor) => {
        vi.stubGlobal(
          'DataTransfer',
          class {
            data = new Map<string, string>();
            files = [];
            getData = (type: string) => this.data.get(type) ?? '';
            setData = (type: string, value: string) =>
              this.data.set(type, value);
          }
        );
        editor.tf.insertData({
          files: [],
          getData: (type: string) =>
            type === 'text/plain'
              ? markdown
              : type === 'vscode-editor-data'
                ? '{"mode":"markdown"}'
                : '',
          types: ['text/plain', 'vscode-editor-data'],
        } as unknown as DataTransfer);
      },
    ],
    [
      'imported',
      (editor) =>
        editor.tf.insertNodes(
          importMarkdownDocument(editor, markdown, true).value as never,
          { at: [1] }
        ),
    ],
  ];

  it.each(ways)(
    '%s: upload placeholders, CORS-readable and data: URLs uploaded',
    async (_, add) => {
      const editor = editorWith(true);
      add(editor);
      const placeholders = children(editor).filter(
        (node) => node.type === 'placeholder'
      );
      expect(placeholders).toHaveLength(2);
      expect(children(editor).some((node) => node.type === 'img')).toBe(false);
      // The data: URL goes to the real fetch, the web one to a CORS host.
      const real = globalThis.fetch;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init?: RequestInit) =>
          url.startsWith('data:') ? real(url, init) : new Response(png())
        )
      );
      const upload = vi.fn();
      await settleAll(editor, upload);
      expect(upload.mock.calls.map(([file]) => [file.name, file.type])).toEqual(
        [
          ['tangent.png', 'image/png'],
          ['pasted-image.png', 'image/png'],
        ]
      );
    }
  );

  it.each(ways)(
    '%s: an image the browser cannot read is a link with its alt text',
    async (_, add) => {
      vi.stubGlobal('fetch', blocked());
      const editor = editorWith(true);
      add(editor);
      await settleAll(editor, vi.fn());
      const links = JSON.stringify(editor.children);
      expect(links).toContain(
        '{"children":[{"text":"Tangent figure"}],"type":"a","url":"https://cdn.example/tangent.png"}'
      );
      // A data: URL nobody can read is not web, so it goes.
      expect(links).not.toContain('data:');
      expect(children(editor).some((node) => node.type === 'placeholder')).toBe(
        false
      );
    }
  );

  it('imports as the agent converter does without asset uploads', () => {
    const source = [
      '![Tangent figure](https://cdn.example/tangent.png)',
      '![](https://cdn.example/plain.png)',
      '[![badge](https://ci.example/badge.svg)](https://ci.example)',
      '![x](javascript:alert(1))',
    ].join('\n\n');
    const withoutIds = (value: unknown) =>
      JSON.parse(
        JSON.stringify(value, (key, item) => (key === 'id' ? undefined : item))
      );
    const imported = withoutIds(
      importMarkdownDocument(editorWith(false), source, false).value
    );
    expect(imported).toEqual(withoutIds(markdownToDocument(source).value));
    expect(imported).toEqual([
      {
        children: [
          { text: '' },
          {
            children: [{ text: 'Tangent figure' }],
            type: 'a',
            url: 'https://cdn.example/tangent.png',
          },
          { text: '' },
        ],
        type: 'p',
      },
      {
        children: [
          { text: '' },
          {
            children: [{ text: 'https://cdn.example/plain.png' }],
            type: 'a',
            url: 'https://cdn.example/plain.png',
          },
          { text: '' },
        ],
        type: 'p',
      },
      {
        children: [
          {
            children: [{ text: 'badge' }],
            type: 'a',
            url: 'https://ci.example',
          },
        ],
        type: 'p',
      },
    ]);
  });
});
