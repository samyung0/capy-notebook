/* Markdown to a material document, shared by the editor's import and the
   collaboration service's converter (markdownConvert.ts), so pasted and agent
   markdown give the same nodes, images aside (an upload in the browser, a
   link from an agent). */
import { encodeUrlIfNeeded, validateUrl } from '@platejs/link';
import { type DeserializeMdOptions, MarkdownPlugin } from '@platejs/markdown';
import { type Descendant, ElementApi, KEYS, type SlateEditor } from 'platejs';
import {
  createMaterialDocument,
  type MaterialDocument,
  type MaterialElement,
  type MaterialNode,
  type MaterialValue,
} from '@/features/materials/document';

type MarkdownApi = {
  markdown: {
    deserialize: (
      source: string,
      options?: DeserializeMdOptions
    ) => MaterialValue;
  };
};

/** Plain Markdown: no MDX. Plate's MDX pass rewrites every `<tag …>` in the
 * text, fenced code included (`class=` becomes `className=`, `i<n;…>` in a
 * script gets quoted), drops `{…}` from prose, and when the MDX parse fails
 * keeps only the text before the first `<` intact. Without MDX Plate has no
 * fallback and would return nothing on an error, so the error is thrown. */
const PLAIN: DeserializeMdOptions = {
  onError: (error) => {
    throw error;
  },
  withoutMdx: true,
};

/** An image a note cannot hold, one with a URL and no asset id (markdown
 * `![alt](url)`, an `<img>` in pasted HTML): its URL and alt text. Notes keep
 * assets only (Epo, 2026-10-10), so each becomes something else. */
export type UrlImage = { text: string; url: string };

/** `url` as an absolute http(s) URL, or null. */
export function webUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
      ? parsed.href
      : null;
  } catch {
    return null;
  }
}

/** A link to the image showing its alt text (else the URL), as its own
 * paragraph; nothing for a URL that is not web (`javascript:`, `data:`). What
 * an agent's markdown image becomes, and one the browser cannot read. */
export function urlImageLink(
  editor: SlateEditor,
  image: UrlImage
): Descendant[] {
  const url = webUrl(image.url);
  if (!url) return [];
  // An inline element sits between text leaves, as Slate normalizes it.
  return [
    {
      children: [
        { text: '' },
        {
          children: [{ text: image.text || url }],
          type: editor.getType(KEYS.link),
          url,
        },
        { text: '' },
      ],
      type: editor.getType(KEYS.p),
    } as Descendant,
  ];
}

/** `nodes` with each URL image replaced by what `replace` gives. One inside
 * an inline element (an image in a link) becomes its alt text there; an
 * element left with nothing (a quote, list item or cell that held only a
 * dropped image) keeps an empty text leaf. */
export function replaceUrlImages(
  editor: SlateEditor,
  nodes: Descendant[],
  replace: (image: UrlImage) => Descendant[],
  inline = false
): Descendant[] {
  return nodes.flatMap((node): Descendant[] => {
    if (!ElementApi.isElement(node)) return [node];
    if (
      node.type === editor.getType(KEYS.img) &&
      typeof node.url === 'string' &&
      typeof node.assetId !== 'string'
    ) {
      const caption = Array.isArray(node.caption) ? node.caption : [];
      const text = caption
        .map((leaf: { text?: unknown }) =>
          typeof leaf.text === 'string' ? leaf.text : ''
        )
        .join('')
        .trim();
      if (inline) return [{ text: text || (webUrl(node.url) ?? '') }];
      const replaced = replace({ text, url: node.url });
      // A list item that held only a dropped image stays an empty item.
      if (replaced.length || node.listStyleType === undefined) return replaced;
      const list = Object.fromEntries(
        ['indent', 'listStart', 'listStyleType', 'checked']
          .filter((key) => node[key] !== undefined)
          .map((key) => [key, node[key]])
      );
      return [
        {
          ...list,
          children: [{ text: '' }],
          type: editor.getType(KEYS.p),
        } as Descendant,
      ];
    }
    const children = replaceUrlImages(
      editor,
      node.children,
      replace,
      inline || editor.api.isInline(node)
    );
    return [
      {
        ...node,
        children: children.length ? children : [{ text: '' }],
      } as Descendant,
    ];
  });
}

/** Clears link URLs that fail the link plugin's validation. */
export function sanitizeLinks(
  editor: SlateEditor,
  document: MaterialDocument
): MaterialDocument {
  const sanitize = (node: MaterialNode): MaterialNode => {
    if ('text' in node) return { ...node };
    const sanitized = { ...node, children: node.children.map(sanitize) };
    if (node.type !== editor.getType(KEYS.link)) return sanitized;
    const url =
      typeof node.url === 'string' ? encodeUrlIfNeeded(node.url.trim()) : '';
    return { ...sanitized, url: url && validateUrl(editor, url) ? url : '' };
  };
  return createMaterialDocument(
    document.value.map((node) => sanitize(node) as MaterialElement)
  );
}

/** Deserialize with the editor's markdown rules, then sanitize links. `plain`
 * reads `source` as Markdown without MDX and throws what a fence rule throws;
 * `transform` reshapes the deserialized nodes before the document check (an
 * agent's images, markdownConvert.ts); `replaceImage`, when given, then
 * replaces each URL image (an upload placeholder or a link in the browser,
 * pastedImages.ts). */
export function importMarkdownValue(
  editor: SlateEditor,
  source: string,
  {
    plain = false,
    replaceImage,
    transform,
  }: {
    plain?: boolean;
    replaceImage?: (image: UrlImage) => Descendant[];
    transform?: (value: MaterialValue) => MaterialValue;
  } = {}
): MaterialDocument {
  const api = (
    editor.getApi as unknown as (plugin: typeof MarkdownPlugin) => MarkdownApi
  )(MarkdownPlugin);
  const deserialized = api.markdown.deserialize(
    source,
    plain ? PLAIN : undefined
  );
  const value = transform ? transform(deserialized) : deserialized;
  return sanitizeLinks(
    editor,
    createMaterialDocument(
      replaceImage
        ? (replaceUrlImages(
            editor,
            value as Descendant[],
            replaceImage
          ) as MaterialValue)
        : value
    )
  );
}
