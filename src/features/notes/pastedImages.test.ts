import { LinkPlugin } from '@platejs/link/react';
import { ImagePlugin, PlaceholderPlugin } from '@platejs/media/react';
import { createPlateEditor } from 'platejs/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  pastedImagesPlugin,
  pastedImageUrl,
  readPastedImage,
  settlePastedImage,
} from './pastedImages';

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
      pastedImagesPlugin(allowExternalAssets),
    ],
    value: [{ children: [{ text: 'note' }], id: 'b1', type: 'p' }] as never,
  });
  editor.tf.select({ offset: 4, path: [0, 0] });
  return editor;
}

const children = (editor: ReturnType<typeof editorWith>) =>
  editor.children as unknown as Node[];

/** Pasted HTML as Plate's image parser leaves it: `<img src>` is a URL-only
 * image node between the paragraphs it sat between. */
const pastedHtml = [
  { children: [{ text: 'before' }], type: 'p' },
  { children: [{ text: '' }], type: 'img', url: 'https://cdn.example/fig.png' },
  { children: [{ text: 'after' }], type: 'p' },
];

const png = () =>
  new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' });

afterEach(() => vi.unstubAllGlobals());

describe('pasted images', () => {
  it('uploads a clipboard image file through a placeholder, as a dropped file', () => {
    const editor = editorWith(true);
    const file = new File([png()], 'shot.png', { type: 'image/png' });
    editor.tf.insertData({
      files: [file] as unknown as FileList,
      getData: () => '',
      types: ['Files'],
    } as unknown as DataTransfer);
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

  it('keeps a pasted <img> in its place as a placeholder that reads its URL', () => {
    const editor = editorWith(true);
    editor.tf.insertFragment(pastedHtml as never);
    const types = children(editor).map((node) => node.type);
    expect(types).toEqual(['p', 'placeholder', 'p']);
    expect(children(editor).some((node) => node.type === 'img')).toBe(false);
    const placeholder = children(editor)[1]!;
    expect(pastedImageUrl(placeholder.id!)).toBe('https://cdn.example/fig.png');
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
    const upload = vi.fn(async () => undefined);
    await settlePastedImage(editor, id, pastedImageUrl(id)!, {
      signal: new AbortController().signal,
      upload,
    });
    expect(fetch).toHaveBeenCalledWith('https://cdn.example/fig.png', {
      credentials: 'omit',
      signal: expect.any(AbortSignal),
    });
    const [uploaded] = upload.mock.calls[0] as unknown as [File];
    expect(uploaded.name).toBe('fig.png');
    expect(uploaded.type).toBe('image/png');
    expect(pastedImageUrl(id)).toBeUndefined();
  });

  it('turns an image the browser cannot read (no CORS) into a link', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      })
    );
    const editor = editorWith(true);
    editor.tf.insertFragment(pastedHtml as never);
    const id = children(editor)[1]!.id!;
    const upload = vi.fn(async () => undefined);
    await settlePastedImage(editor, id, pastedImageUrl(id)!, {
      signal: new AbortController().signal,
      upload,
    });
    expect(upload).not.toHaveBeenCalled();
    expect(children(editor).map((node) => node.type)).toEqual(['p', 'p', 'p']);
    expect(children(editor)[1]!.children![1]).toMatchObject({
      type: 'a',
      url: 'https://cdn.example/fig.png',
    });
  });

  it('drops an unreadable image whose URL is not web', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      })
    );
    const editor = editorWith(true);
    editor.tf.insertFragment([
      { children: [{ text: '' }], type: 'img', url: 'javascript:alert(1)' },
    ] as never);
    const id = children(editor).find((node) => node.type === 'placeholder')!
      .id!;
    await settlePastedImage(editor, id, 'javascript:alert(1)', {
      signal: new AbortController().signal,
      upload: vi.fn(async () => undefined),
    });
    expect(children(editor).some((node) => node.type === 'placeholder')).toBe(
      false
    );
    expect(JSON.stringify(editor.children)).not.toContain('javascript:');
  });
});
