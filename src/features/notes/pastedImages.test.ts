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
  /** The image paste handler on a clipboard of `html` and a PNG file. */
  function pasteFile(html: string) {
    const editor = editorWith(true);
    const file = new File([png()], 'shot.png', { type: 'image/png' });
    const preventDefault = vi.fn();
    const handled = editor
      .getPlugin(pastedImagesPlugin(true))
      .handlers.onPaste?.({
        editor,
        event: {
          clipboardData: {
            files: [file],
            getData: (type: string) => (type === 'text/html' ? html : ''),
          },
          preventDefault,
        },
      } as never);
    return { editor, file, handled, preventDefault };
  }

  // A browser's Copy image puts the file and an <img> on the clipboard.
  it('uploads a Copy image file through a placeholder', () => {
    const { editor, file, handled, preventDefault } = pasteFile(
      '<html><body><!--StartFragment--><img src="https://cdn.example/a.png" alt="A"/><!--EndFragment--></body></html>'
    );
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

  // REVIEW5 M2: Excel, PowerPoint and OneNote put a rendered picture beside
  // their HTML; the table must paste, not the picture.
  it('leaves an Office table with its picture to the HTML paste', () => {
    const { editor, handled, preventDefault } = pasteFile(
      '<html xmlns:o="urn:schemas-microsoft-com:office:office"><head><meta charset="utf-8"><style>td{mso-number-format:General}</style></head><body><!--StartFragment--><table><tr><td>Q1</td><td>42</td></tr></table><!--EndFragment--></body></html>'
    );
    expect(handled).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(children(editor).some((node) => node.type === 'placeholder')).toBe(
      false
    );
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

// REVIEW5 S1: the name takes its extension from the type the server
// stores, only web and data: URLs are read, and any failed read ends as the
// link (or nothing) so no skeleton stays.
describe('reading a pasted image', () => {
  const serving = (type: string) =>
    vi.fn(
      async () => new Response(new Blob([new Uint8Array([1, 2, 3])], { type }))
    );

  it.each([
    [
      'https://images.unsplash.com/photo-1500000000?w=800',
      'image/jpeg',
      'photo-1500000000.jpg',
    ],
    ['https://pbs.twimg.com/media/X?format=jpg', 'image/jpeg', 'X.jpg'],
    ['https://cdn.example/photo.jpg', 'image/webp', 'photo.webp'],
    ['https://cors.example/100%ZZ.png', 'image/png', 'pasted-image.png'],
    // Go refuses control characters in a name (REVIEW5 recheck).
    ['https://cors.example/a%0Ab%7F.png', 'image/png', 'ab.png'],
  ])('names %s from its type', async (url, type, name) => {
    vi.stubGlobal('fetch', serving(type));
    const file = await readPastedImage(url);
    expect([file?.name, file?.type]).toEqual([name, type]);
  });

  it.each([
    ['an icon', 'https://example.com/favicon.ico', 'image/x-icon'],
    ['an SVG', 'https://example.com/figure.svg', 'image/svg+xml'],
  ])('reads %s the server would refuse as nothing', async (_, url, type) => {
    vi.stubGlobal('fetch', serving(type));
    expect(await readPastedImage(url)).toBeNull();
  });

  it('does not upload an SVG data: URL', async () => {
    expect(
      await readPastedImage(
        'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>'
      )
    ).toBeNull();
  });

  it('never reads a path on this app', async () => {
    const fetch = serving('image/svg+xml');
    vi.stubGlobal('fetch', fetch);
    expect(await readPastedImage('/favicon.svg')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['a relative URL', '/favicon.svg', null],
    [
      'an icon',
      'https://example.com/favicon.ico',
      'https://example.com/favicon.ico',
    ],
  ])(
    'settles %s as a link or nothing, and forgets it',
    async (_, url, linked) => {
      vi.stubGlobal('fetch', serving('image/x-icon'));
      const editor = editorWith(true);
      editor.tf.insertFragment([
        { children: [{ text: '' }], type: 'img', url },
      ] as never);
      const id = children(editor).find((node) => node.type === 'placeholder')!
        .id!;
      const upload = vi.fn();
      await settleAll(editor, upload);
      expect(upload).not.toHaveBeenCalled();
      expect(pastedImage(id)).toBeUndefined();
      expect(children(editor).some((node) => node.type === 'placeholder')).toBe(
        false
      );
      expect(
        JSON.stringify(editor.children).includes(`"url":"${linked}"`)
      ).toBe(!!linked);
    }
  );

  // REVIEW5 N6: an imported document with many images reads four at a time.
  it('reads and uploads pasted images four at a time', async () => {
    let open = 0;
    let most = 0;
    const releases: Array<() => void> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        open += 1;
        most = Math.max(most, open);
        await new Promise<void>((resolve) => releases.push(resolve));
        open -= 1;
        return new Response(png());
      })
    );
    const editor = editorWith(true);
    editor.tf.insertFragment(
      Array.from({ length: 10 }, (_, n) => ({
        children: [{ text: '' }],
        type: 'img',
        url: `https://cdn.example/${n}.png`,
      })) as never
    );
    const upload = vi.fn();
    const ids = children(editor)
      .filter((node) => node.type === 'placeholder')
      .map((node) => node.id!);
    const settled = Promise.all(
      ids.map((id) =>
        settlePastedImage(editor, id, pastedImage(id)!, {
          signal: new AbortController().signal,
          upload: async (file) => void upload(file),
        })
      )
    );
    for (let round = 0; round < 10; round++) {
      await vi.waitFor(() => expect(releases.length).toBeGreaterThan(0));
      releases.shift()!();
    }
    await settled;
    expect(most).toBe(4);
    expect(upload).toHaveBeenCalledTimes(10);
  });
});

// REVIEW5 S2: an image that goes, alone in a quote, list item or cell, leaves
// an empty text there instead of failing the whole conversion.
describe('dropped images in containers', () => {
  const withoutIds = (value: unknown) =>
    JSON.parse(
      JSON.stringify(value, (key, item) => (key === 'id' ? undefined : item))
    );

  it.each([
    ['a quote', '> ![q](javascript:x)', 'blockquote'],
    ['a table cell', '| a |\n|---|\n| ![t](/t.png) |', 'table'],
  ])('converts %s, as the browser import does', (_, source, type) => {
    const agent = withoutIds(markdownToDocument(source).value);
    expect(agent.map((node: { type: string }) => node.type)).toEqual([type]);
    expect(JSON.stringify(agent)).not.toContain('"img"');
    expect(JSON.stringify(agent)).toContain('{"text":""}');
    expect(
      withoutIds(importMarkdownDocument(editorWith(false), source, false).value)
    ).toEqual(agent);
  });

  // The test editor has no list plugin; the converter's list items are
  // indented paragraphs.
  it('keeps a list item that held only a dropped image as an empty item', () => {
    expect(withoutIds(markdownToDocument('- ![i](diagram.png)').value)).toEqual(
      [
        {
          children: [{ text: '' }],
          indent: 1,
          listStyleType: 'disc',
          type: 'p',
        },
      ]
    );
  });
});
