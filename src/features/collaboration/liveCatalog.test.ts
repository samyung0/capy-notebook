/* The live layer against the embed catalog (openwiki/embeds.md): the one
   shared-text key the slate-yjs patch and live Mermaid hold as a Y.Text, and
   the read each item kind's embed gets in a note's footer. A kind or key the
   catalog adds fails here until this layer handles it. */
import { slateNodesToInsertDelta, yTextToSlateElement } from '@slate-yjs/core';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { EMBED_CATALOG } from '@/api/embeds.generated';
import { MATERIAL_REF_TYPE } from '@/features/materials/document';
import {
  readMermaid,
  SHARED_TEXT_ELEMENT,
  SHARED_TEXT_KEY,
} from '@/features/materials/liveMermaid';
import { EMBED_READ_KEYS, embedKey } from '@/features/materials/useNoteFooter';

const sharedText = (element: (typeof EMBED_CATALOG.elements)[number]) =>
  'sharedText' in element ? (element.sharedText as readonly string[]) : [];

describe('shared text', () => {
  it('is the one key live Mermaid reads', () => {
    expect(
      EMBED_CATALOG.elements
        .filter((element) => sharedText(element).length > 0)
        .map((element) => [element.type, sharedText(element)])
    ).toEqual([[SHARED_TEXT_ELEMENT, [SHARED_TEXT_KEY]]]);
  });

  it.each(
    EMBED_CATALOG.elements.map((element) => [element.type, element] as const)
  )('is what the slate-yjs patch makes a text on a %s', (type, element) => {
    const doc = new Y.Doc();
    const root = doc.get('content', Y.XmlText);
    root.applyDelta(
      slateNodesToInsertDelta([
        { children: [{ text: '' }], id: 'b', source: 'A --> B', type },
      ] as never),
      { sanitize: false }
    );
    const block = (root.toDelta() as { insert: Y.XmlText }[])[0].insert;
    expect(block.getAttribute(SHARED_TEXT_KEY) instanceof Y.Text).toBe(
      sharedText(element).includes(SHARED_TEXT_KEY)
    );
    expect(yTextToSlateElement(block)).toMatchObject({ source: 'A --> B' });
    if (type === SHARED_TEXT_ELEMENT)
      expect(readMermaid(doc)?.source).toBeInstanceOf(Y.Text);
  });
});

describe('embedded items', () => {
  const items = EMBED_CATALOG.embeds.filter((embed) => embed.class === 'item');

  it('each have the read their block makes', () => {
    expect(Object.keys(EMBED_READ_KEYS).sort()).toEqual(
      items.map((embed) => embed.kind).sort()
    );
    expect(
      EMBED_CATALOG.materialKinds
        .filter((kind) => 'item' in kind && kind.item)
        .map((kind) => kind.kind)
        .sort()
    ).toEqual(items.map((embed) => embed.kind).sort());
  });

  it('are found in a note by their reference', () => {
    const value = items.map((embed) => {
      expect(embed.element).toBe(MATERIAL_REF_TYPE);
      return {
        children: [{ text: '' }],
        materialId: `m_${embed.kind}`,
        refKind: embed.kind,
        type: embed.element,
      };
    });
    expect(embedKey(value)).toBe(
      items.map((embed) => `${embed.kind}:m_${embed.kind}`).join(' ')
    );
  });
});
