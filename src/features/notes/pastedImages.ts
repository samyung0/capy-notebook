import { PlaceholderPlugin } from '@platejs/media/react';
import { type Descendant, ElementApi, KEYS, type SlateEditor } from 'platejs';
import { createPlatePlugin } from 'platejs/react';
import { uid } from '@/lib/id';
import {
  replaceUrlImages,
  type UrlImage,
  urlImageLink,
} from './markdownImport';

/**
 * Pasted images go through the editor's normal asset path (Epo, 2026-10-10):
 * clipboard image files become upload placeholders, as dropped files do;
 * an `<img>` in pasted HTML and a markdown image pasted as text or imported
 * (which Plate's parsers turn into URL-only image nodes) become a placeholder
 * in their place whose element fetches the URL in the browser and uploads the
 * bytes, or a link to the URL when the browser cannot read it. Nothing is
 * fetched by a server, and a media node always names its asset. Without asset
 * uploads (`allowExternalAssets` off) a pasted image is a link and clipboard
 * files are left to the default.
 */

/** Pasted images waiting for their placeholder, by placeholder id. Local to
 * this tab, as the placeholder plugin's uploading files: a peer seeing the
 * placeholder must not fetch it too. */
const pastedImages = new Map<string, UrlImage>();

export function pastedImage(id: string): UrlImage | undefined {
  return pastedImages.get(id);
}

export function forgetPastedImage(id: string) {
  pastedImages.delete(id);
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
  image: UrlImage,
  {
    signal,
    upload,
  }: { signal: AbortSignal; upload: (file: File) => Promise<void> }
) {
  let file: File | null;
  try {
    file = await readPastedImage(image.url, signal);
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
  const link = urlImageLink(editor, image);
  editor.tf.withoutSaving(() => {
    editor.tf.removeNodes({ at: entry[1] });
    if (link.length) editor.tf.insertNodes(link, { at: entry[1] });
  });
}

/** What a URL image becomes in the browser: an upload placeholder whose
 * element reads the URL, or a link when assets cannot be created. */
export function uploadOrLink(
  editor: SlateEditor,
  allowExternalAssets: boolean
) {
  return (image: UrlImage): Descendant[] => {
    if (!allowExternalAssets) return urlImageLink(editor, image);
    const id = uid('pasted');
    pastedImages.set(id, image);
    return [
      {
        children: [{ text: '' }],
        id,
        mediaType: editor.getType(KEYS.img),
        type: editor.getType(KEYS.placeholder),
      } as Descendant,
    ];
  };
}

/** The note editor's paste handling for images (see the module comment).
 * Plate's placeholder plugin takes a paste of files alone; this takes image
 * files that come with HTML (a browser's Copy image), which would otherwise
 * paste the `<img>` URL. A paste only: a dropped file is the DnD plugin's
 * (`onDropFiles`), so a drop makes one placeholder, not two. */
export function pastedImagesPlugin(allowExternalAssets: boolean) {
  return createPlatePlugin({
    handlers: {
      onPaste: ({ editor, event }) => {
        const images = [...event.clipboardData.files].filter((file) =>
          file.type.startsWith('image/')
        );
        if (!allowExternalAssets || !images.length) return false;
        event.preventDefault();
        // insert.media reads its files with Array.from.
        editor
          .getTransforms(PlaceholderPlugin)
          .insert.media(images as unknown as FileList);
        return true;
      },
    },
    key: 'capy-pasted-images',
  }).overrideEditor(({ editor, tf: { insertFragment } }) => ({
    transforms: {
      insertFragment(fragment, options) {
        insertFragment(
          replaceUrlImages(
            editor,
            fragment,
            uploadOrLink(editor, allowExternalAssets)
          ),
          options
        );
      },
    },
  }));
}
