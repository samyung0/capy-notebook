import { PlaceholderPlugin } from '@platejs/media/react';
import { type Descendant, ElementApi, KEYS, type SlateEditor } from 'platejs';
import { createPlatePlugin } from 'platejs/react';
import { IMAGE_EXTENSIONS } from '@/lib/fitImage';
import { uid } from '@/lib/id';
import {
  replaceUrlImages,
  type UrlImage,
  urlImageLink,
  webUrl,
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

const EXTENSION = /\.[^.]*$/;
/** Control characters, which Go refuses in a file name (a `%0A` in a URL). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point.
const CONTROL = /[\u0000-\u001f\u007f]/g;

/** A name for the file: the URL's last path segment without its extension
 * (Go's file names stop at 120 characters), the extension from the type. */
function fileName(url: string, extension: string) {
  let base = 'pasted-image';
  if (!url.startsWith('data:'))
    try {
      const last = new URL(url).pathname.split('/').pop() ?? '';
      base =
        decodeURIComponent(last).replace(CONTROL, '').replace(EXTENSION, '') ||
        base;
    } catch {
      // A malformed escape: the default name.
    }
  return `${base.slice(0, 100)}.${extension}`;
}

/** The bytes of a pasted image the browser can read (a `data:` URL, a web
 * host that allows CORS) and the server stores, as a file to upload; null
 * otherwise. Only absolute http(s) and `data:` URLs are read, never a path on
 * this app. Throws only when `signal` aborts. */
export async function readPastedImage(
  url: string,
  signal?: AbortSignal
): Promise<File | null> {
  const target = url.startsWith('data:') ? url : webUrl(url);
  if (!target) return null;
  let blob: Blob;
  try {
    const response = await fetch(target, { credentials: 'omit', signal });
    if (!response.ok) return null;
    blob = await response.blob();
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
  const type = blob.type.split(';')[0].trim();
  const extension = IMAGE_EXTENSIONS[type];
  if (!extension) return null;
  return new File([blob], fileName(target, extension), { type });
}

/** Pasted images read and upload four at a time (REVIEW5 N6), so an imported
 * document with hundreds of images does not start them all at once; the
 * others wait as skeletons. */
const SETTLING = 4;
let settling = 0;
const waiting: Array<() => void> = [];

function settleSlot(signal: AbortSignal): Promise<boolean> {
  if (settling < SETTLING) {
    settling += 1;
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const grant = () => {
      signal.removeEventListener('abort', cancel);
      resolve(true);
    };
    const cancel = () => {
      const at = waiting.indexOf(grant);
      if (at >= 0) waiting.splice(at, 1);
      resolve(false);
    };
    waiting.push(grant);
    signal.addEventListener('abort', cancel, { once: true });
  });
}

function releaseSlot() {
  const next = waiting.shift();
  if (next) next();
  else settling -= 1;
}

/** Settles a pasted image's placeholder (by id): what the browser reads
 * uploads through `upload` (the placeholder's own upload), else the
 * placeholder becomes a link to the URL, or goes when the URL is not web. Any
 * failed read ends there, so no skeleton stays; an aborted one (the
 * placeholder unmounted) leaves the URL for the next mount. */
export async function settlePastedImage(
  editor: SlateEditor,
  id: string,
  image: UrlImage,
  {
    signal,
    upload,
  }: { signal: AbortSignal; upload: (file: File) => Promise<void> }
) {
  if (!(await settleSlot(signal))) return;
  try {
    let file: File | null;
    try {
      file = await readPastedImage(image.url, signal);
    } catch {
      if (signal.aborted) return;
      file = null;
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
  } finally {
    releaseSlot();
  }
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

/** A browser's Copy image: HTML that is nothing but `<img>` elements (the
 * page wrapper, comments and meta tags aside). Excel, PowerPoint and OneNote
 * put a rendered picture beside a table's HTML, which must paste as HTML. */
export function onlyImages(html: string) {
  const rest = html
    .replace(COMMENTS, '')
    .replace(HEAD, '')
    .replace(WRAPPERS, '')
    .trim();
  return IMAGES_ONLY.test(rest);
}
const COMMENTS = /<!--[\s\S]*?-->/g;
const HEAD = /<head\b[\s\S]*?<\/head>/gi;
const WRAPPERS = /<\/?(?:html|body|meta)\b[^>]*>/gi;
const IMAGES_ONLY = /^(?:<img\b[^>]*>\s*)+$/i;

/** The note editor's paste handling for images (see the module comment).
 * Plate's placeholder plugin takes a paste of files alone; this takes image
 * files that come with a browser's Copy image HTML, which would otherwise
 * paste the `<img>` URL (any other HTML pastes as HTML, REVIEW5 M2). A paste
 * only: a dropped file is the DnD plugin's (`onDropFiles`), so a drop makes
 * one placeholder, not two. */
export function pastedImagesPlugin(allowExternalAssets: boolean) {
  return createPlatePlugin({
    handlers: {
      onPaste: ({ editor, event }) => {
        const images = [...event.clipboardData.files].filter((file) =>
          file.type.startsWith('image/')
        );
        if (
          !(allowExternalAssets && images.length) ||
          !onlyImages(event.clipboardData.getData('text/html'))
        )
          return false;
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
