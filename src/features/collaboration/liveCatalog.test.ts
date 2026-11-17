/* The live layer against the embed catalog (openwiki/embeds.md): the one
   shared-text key the slate-yjs patch and live Mermaid hold as a Y.Text, the
   blocks it holds as a Y.Map (a figure as the figure map quiz rooms hold, a
   table view with its lists as Y.Arrays of Y.Maps), and the read each item
   kind's embed gets in a note's footer. A kind or key the catalog adds fails
   here until this layer handles it. */
import { slateNodesToInsertDelta, yTextToSlateElement } from '@slate-yjs/core';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { EMBED_CATALOG } from '@/api/embeds.generated';
import { FIGURE_MAPS, isFigureType } from '@/features/figures/figureMap';
import { MATERIAL_REF_TYPE } from '@/features/materials/document';
import {
  readMermaid,
  SHARED_TEXT_ELEMENT,
  SHARED_TEXT_KEY,
} from '@/features/materials/liveMermaid';
import { EMBED_READ_KEYS, embedKey } from '@/features/materials/useNoteFooter';
import '@/features/notes/figureBinding';

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
  const lists = ['columns', 'rows', 'views'];
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
    expect(all('sharedLists')).toEqual(new Set(lists));
  });

  it.each(
    EMBED_CATALOG.elements.map((element) => [element.type, element] as const)
  )('are what the slate-yjs patch makes a map on a %s', (type, element) => {
    const figures: Record<string, object> = {
      chart: {
        kind: 'bar',
        labels: ['L'],
        series: [{ name: 'S', values: [1] }],
        title: 'T',
        type,
      },
      graph: {
        board: { axis: true, bbox: [-1, 1, 1, -1], grid: false },
        elements: [{ coords: [0, 0], id: 'e1', type: 'point' }],
        height: 100,
        type,
        width: 100,
      },
      plot: {
        kind: 'line',
        series: [{ name: 'S', points: [[0, 0]] }],
        title: 'T',
        type,
      },
    };
    const block = figures[type] ?? {
      columns: [{ id: 'c1', kind: 'title', name: 'Name' }],
      rows: [{ c1: 'A', id: 'r1' }],
      title: 'T',
      type,
      views: [{ id: 'v1', kind: 'table', name: 'Table' }],
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
    if (held instanceof Y.Map) {
      for (const list of lists)
        expect(held.get(list) instanceof Y.Array).toBe(
          keys(element, 'sharedLists').includes(list)
        );
      if (isFigureType(type))
        for (const key of FIGURE_MAPS[type])
          expect(held.get(key)).toBeInstanceOf(Y.Map);
    }
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
