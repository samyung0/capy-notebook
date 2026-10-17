/* The live layer against the embed catalog (openwiki/embeds.md): the one
   shared-text key the slate-yjs patch and live Mermaid hold as a Y.Text, the
   figure blocks it holds as a Y.Map with their lists as Y.Arrays of Y.Maps,
   and the read each item kind's embed gets in a note's footer. A kind or key
   the catalog adds fails here until this layer handles it. */
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

describe('shared maps', () => {
  const keys = (
    element: (typeof EMBED_CATALOG.elements)[number],
    name: 'sharedLists' | 'sharedMap'
  ) =>
    name in element
      ? ((element as { [key in typeof name]?: readonly string[] })[name] ?? [])
      : [];

  it('are the keys this test writes', () => {
    const all = (name: 'sharedLists' | 'sharedMap') =>
      new Set(EMBED_CATALOG.elements.flatMap((element) => keys(element, name)));
    expect(all('sharedMap')).toEqual(new Set(['block']));
    expect(all('sharedLists')).toEqual(new Set(['elements', 'series']));
  });

  it.each(
    EMBED_CATALOG.elements.map((element) => [element.type, element] as const)
  )('are what the slate-yjs patch makes a map on a %s', (type, element) => {
    const block = {
      elements: [{ id: 'e1', type: 'point' }],
      series: [{ name: 'S', values: [1] }],
      title: 'T',
      type,
    };
    const doc = new Y.Doc();
    const root = doc.get('content', Y.XmlText);
    root.applyDelta(
      slateNodesToInsertDelta([
        { block, children: [{ text: '' }], id: 'b', type },
      ] as never),
      { sanitize: false }
    );
    const node = (root.toDelta() as { insert: Y.XmlText }[])[0].insert;
    const held = node.getAttribute('block') as unknown;
    const shared = keys(element, 'sharedMap').includes('block');
    expect(held instanceof Y.Map).toBe(shared);
    if (held instanceof Y.Map)
      for (const list of ['elements', 'series'])
        expect(held.get(list) instanceof Y.Array).toBe(
          keys(element, 'sharedLists').includes(list)
        );
    expect(yTextToSlateElement(node)).toMatchObject({ block });
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
    // A kind this version has no read for has no credits to read.
    expect(
      embedKey([
        ...value,
        { ...value[0], materialId: 'm_later', refKind: 'timeline' },
        { ...value[0], materialId: 'm_proto', refKind: 'constructor' },
      ])
    ).toBe(embedKey(value));
  });
});
