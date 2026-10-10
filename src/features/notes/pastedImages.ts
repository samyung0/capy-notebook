import { PlaceholderPlugin } from '@platejs/media/react';
import {
  createSlatePlugin,
  type Descendant,
  ElementApi,
  KEYS,
  type SlateEditor,
} from 'platejs';
import { uid } from '@/lib/id';

/**
 * Pasted images go through the editor's normal asset path (Epo, 2026-10-10):
 * clipboard image files become upload placeholders, as dropped files do;
 * an `<img>` in pasted HTML (which Plate's image parser turns into a URL-only
 * image node) becomes a placeholder in its place whose element fetches the
 * URL in the browser and uploads the bytes, or a link to the URL when the
 * browser cannot read it. Nothing is fetched by a server, and a media node
 * always names its asset. Without asset uploads (`allowExternalAssets` off)
 * a pasted image is a link and clipboard files are left to the default.
 */

/** Pasted image URLs waiting for their placeholder, by placeholder id. Local
 * to this tab, as the placeholder plugin's uploading files: a peer seeing the
 * placeholder must not fetch it too. */
const pastedUrls = new Map<string, string>();

export function pastedImageUrl(id: string): string | undefined {
  return pastedUrls.get(id);
}

export function forgetPastedImage(id: string) {
  pastedUrls.delete(id);
}

/** A link to an image the browser could not read, as its own paragraph;
 * none for a URL that is not web (`javascript:`, a broken `data:`). */
export function pastedImageLink(
  editor: SlateEditor,
  url: string
): Descendant | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  // An inline element sits between text leaves, as Slate normalizes it.
  return {
    children: [
      { text: '' },
      {
        children: [{ text: parsed.href }],
        type: editor.getType(KEYS.link),
        url: parsed.href,
      },
      { text: '' },
    ],
    type: editor.getType(KEYS.p),
  } as Descendant;
}

/** The bytes of a pasted image the browser can read (a `data:` URL, a host
 * that allows CORS), as a file to upload; null when it cannot. */
export async function readPastedImage(
  url: string,
  signal?: AbortSignal
): Promise<File | null> {
  let blob: Blob;
  try {
    const response = await fetch(url, { credentials: 'omit', signal });
    if (!response.ok) return null;
    blob = await response.blob();
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
  if (!blob.type.startsWith('image/')) return null;
  const extension = blob.type.slice('image/'.length).split('+')[0] || 'png';
  let name = `pasted-image.${extension}`;
  if (!url.startsWith('data:')) {
    const last = new URL(url).pathname.split('/').pop();
    if (last) name = decodeURIComponent(last);
  }
  return new File([blob], name, { type: blob.type });
}

/** Settles a pasted image's placeholder (by id): what the browser reads
 * uploads through `upload` (the placeholder's own upload), else the
 * placeholder becomes a link to the URL, or goes when the URL is not web. An
 * aborted read (the placeholder unmounted) leaves the URL for the next mount. */
export async function settlePastedImage(
  editor: SlateEditor,
  id: string,
  url: string,
  {
    signal,
    upload,
  }: { signal: AbortSignal; upload: (file: File) => Promise<void> }
) {
  let file: File | null;
  try {
    file = await readPastedImage(url, signal);
  } catch {
    return;
  }
  if (signal.aborted) return;
  if (file) {
    await upload(file);
    if (!signal.aborted) forgetPastedImage(id);
    return;
  }
  forgetPastedImage(id);
  const [entry] = editor.api.nodes({
    at: [],
    match: (node) => ElementApi.isElement(node) && node.id === id,
  });
  if (!entry) return;
  const link = pastedImageLink(editor, url);
  editor.tf.withoutSaving(() => {
    editor.tf.removeNodes({ at: entry[1] });
    if (link) editor.tf.insertNodes(link, { at: entry[1] });
  });
}

/** A pasted fragment with each URL-only image node replaced: an upload
 * placeholder when assets can be created, else a link (or nothing). */
export function replacePastedImages(
  editor: SlateEditor,
  nodes: Descendant[],
  allowExternalAssets: boolean
): Descendant[] {
  const image = editor.getType(KEYS.img);
  return nodes.flatMap((node): Descendant[] => {
    if (!ElementApi.isElement(node)) return [node];
    if (
      node.type === image &&
      typeof node.url === 'string' &&
      typeof node.assetId !== 'string'
    ) {
      if (!allowExternalAssets) {
        const link = pastedImageLink(editor, node.url);
        return link ? [link] : [];
      }
      const id = uid('pasted');
      pastedUrls.set(id, node.url);
      return [
        {
          children: [{ text: '' }],
          id,
          mediaType: image,
          type: editor.getType(KEYS.placeholder),
        } as Descendant,
      ];
    }
    return [
      {
        ...node,
        children: replacePastedImages(
          editor,
          node.children,
          allowExternalAssets
        ),
      } as Descendant,
    ];
  });
}

/** The note editor's paste handling for images (see the module comment). */
export function pastedImagesPlugin(allowExternalAssets: boolean) {
  return createSlatePlugin({ key: 'capy-pasted-images' }).overrideEditor(
    ({ editor, tf: { insertData, insertFragment } }) => ({
      transforms: {
        insertData(data) {
          const images = [...data.files].filter((file) =>
            file.type.startsWith('image/')
          );
          if (allowExternalAssets && images.length) {
            // insert.media reads its files with Array.from.
            editor
              .getTransforms(PlaceholderPlugin)
              .insert.media(images as unknown as FileList);
            return;
          }
          insertData(data);
        },
        insertFragment(fragment, options) {
          insertFragment(
            replacePastedImages(editor, fragment, allowExternalAssets),
            options
          );
        },
      },
    })
  );
}
