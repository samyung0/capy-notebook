import { useCallback, useRef, useSyncExternalStore } from 'react';
import * as Y from 'yjs';
import { EMBED_CATALOG } from '@/api/embeds.generated';
import type { MaterialDocument, MermaidElement } from './document';
import type { MermaidTheme } from './mermaidThemes';

/* A standalone mindmap's or diagram's room read without Plate (live-items
 * DESIGN.md 6.4): the note document's `content` root holds one `mermaid`
 * block, its source a Y.Text attribute (shape A, Epo 2026-10-10) and its
 * caption the text of its `mermaid_caption` child. */

const [shared] = EMBED_CATALOG.elements.flatMap((element) =>
  'sharedText' in element
    ? element.sharedText.map((key) => [element.type, key] as const)
    : []
);

/** The element whose key is held as shared text, and that key: the embed
 * catalog's one `sharedText` entry, as the slate-yjs patch and the
 * collaboration server hold it (liveCatalog.test.ts). */
export const SHARED_TEXT_ELEMENT = shared[0];
export const SHARED_TEXT_KEY = shared[1];

/** A source the room still holds as a string turns into a text under this
 * origin, outside every Undo. */
const UPGRADE = Symbol('mermaid-source-upgrade');

export interface LiveMermaid {
  block: Y.XmlText;
  caption: Y.XmlText | null;
  id: string;
  /** A text (shape A), or a string a room written before it still holds. */
  source: Y.Text | string;
  theme?: MermaidTheme;
  width?: string;
}

/** The note document's root, as slate-yjs names it. */
export const contentRoot = (doc: Y.Doc) => doc.get('content', Y.XmlText);

/** The first `mermaid` block of a note document. */
export function readMermaid(doc: Y.Doc): LiveMermaid | null {
  for (const op of contentRoot(doc).toDelta() as { insert: unknown }[]) {
    const block = op.insert;
    if (
      !(block instanceof Y.XmlText) ||
      block.getAttribute('type') !== SHARED_TEXT_ELEMENT
    )
      continue;
    const [first] = block.toDelta() as { insert: unknown }[];
    return {
      block,
      caption: first?.insert instanceof Y.XmlText ? first.insert : null,
      id: String(block.getAttribute('id') ?? ''),
      source: block.getAttribute(SHARED_TEXT_KEY) as Y.Text | string,
      theme: block.getAttribute('theme') as MermaidTheme | undefined,
      width: block.getAttribute('width') as string | undefined,
    };
  }
  return null;
}

/** The block, read again when the room adds, removes or re-attributes it;
 * typing in its source or caption does not re-read it. */
export function useMermaid(doc: Y.Doc | null | undefined): LiveMermaid | null {
  const cached = useRef<LiveMermaid | null>(null);
  const cachedFor = useRef<Y.Doc | null>(null);
  const subscribe = useCallback(
    (notify: () => void) => {
      if (!doc) return () => undefined;
      cached.current = readMermaid(doc);
      cachedFor.current = doc;
      let block = cached.current?.block ?? null;
      const changed = () => {
        block?.unobserve(changed);
        cached.current = readMermaid(doc);
        block = cached.current?.block ?? null;
        block?.observe(changed);
        notify();
      };
      const root = contentRoot(doc);
      root.observe(changed);
      block?.observe(changed);
      return () => {
        root.unobserve(changed);
        block?.unobserve(changed);
      };
    },
    [doc]
  );
  return useSyncExternalStore(subscribe, () => {
    if (!doc) return null;
    if (cachedFor.current !== doc) {
      cached.current = readMermaid(doc);
      cachedFor.current = doc;
    }
    return cached.current;
  });
}

/** A `mermaid` block's source text, made one first (outside Undo) when the
 * room still holds a string. */
export function blockSource(block: Y.XmlText): Y.Text {
  const held: unknown = block.getAttribute(SHARED_TEXT_KEY);
  if (held instanceof Y.Text) return held;
  const text = new Y.Text(typeof held === 'string' ? held : '');
  const apply = () => block.setAttribute(SHARED_TEXT_KEY, text as never);
  if (block.doc) block.doc.transact(apply, UPGRADE);
  else apply();
  return text;
}

/** The block as a Plate node (View, the hand-over to View). */
export function mermaidNode(live: LiveMermaid): MermaidElement {
  return {
    children: [
      {
        children: [{ text: live.caption?.toString() ?? '' }],
        type: 'mermaid_caption',
      },
    ],
    id: live.id,
    source: live.source.toString(),
    type: 'mermaid',
    ...(live.theme && { theme: live.theme }),
    ...(live.width && { width: live.width }),
  } as MermaidElement;
}

/** `content` with its mermaid block replaced by the live one. */
export function withMermaid(
  content: MaterialDocument,
  live: LiveMermaid
): MaterialDocument {
  return {
    ...content,
    value: content.value.map((node) =>
      node.type === 'mermaid' ? mermaidNode(live) : node
    ),
  };
}
