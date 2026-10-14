import type { Descendant } from 'platejs';
import { expect, it } from 'vitest';
import { EMBED_CATALOG } from '@/api/embeds.generated';
import {
  MATERIAL_REF_TYPE,
  type MaterialRefKind,
  materialRefNode,
} from '@/features/materials/document';
import { resolvePendingRefs } from './pendingRefs';

/* Imported quiz and flashcards fences become references to rows created for
 * them before anything enters the note (live-items REVIEW5: a fence body holds
 * the answer keys). */

it('points every fence at its new row, nested ones too, and drops a failed one', async () => {
  const created: [MaterialRefKind, string][] = [];
  const nodes = [
    { children: [{ text: 'intro' }], id: 'p', type: 'p' },
    materialRefNode('', 'quiz', 'questions: []'),
    {
      children: [
        {
          children: [materialRefNode('', 'flashcards', 'cards: []')],
          type: 'column',
        },
      ],
      id: 'cols',
      type: 'column_group',
    },
    materialRefNode('', 'quiz', 'broken'),
  ] as unknown as Descendant[];
  const resolved = await resolvePendingRefs(nodes, async (kind, body) => {
    if (body === 'broken') throw new Error('invalid fence');
    created.push([kind, body]);
    return { id: `row_${created.length}` };
  });
  expect(created).toEqual([
    ['quiz', 'questions: []'],
    ['flashcards', 'cards: []'],
  ]);
  expect(JSON.stringify(resolved)).not.toContain('pending');
  expect(resolved).toHaveLength(3);
  expect(resolved[0]).toBe(nodes[0]);
  expect(resolved[1]).toMatchObject({
    materialId: 'row_1',
    refKind: 'quiz',
    type: 'material_ref',
  });
  expect(resolved[2]).toMatchObject({
    children: [{ children: [{ materialId: 'row_2', type: 'material_ref' }] }],
  });
});

/* The key a fence body waits under is the one the embed catalog forbids on a
 * stored reference (the store and the room refuse it), and nothing resolved
 * carries a key the catalog forbids its element. */
it('leaves no key the embed catalog forbids', async () => {
  const forbidden = new Map<string, readonly string[]>(
    EMBED_CATALOG.elements.map((element) => [
      element.type,
      'forbidden' in element ? element.forbidden : [],
    ])
  );
  const reference = materialRefNode('', 'quiz', 'questions: []');
  expect(
    Object.keys(reference).filter((key) =>
      forbidden.get(MATERIAL_REF_TYPE)?.includes(key)
    )
  ).toEqual(['pending']);
  const resolved = await resolvePendingRefs(
    [reference] as unknown as Descendant[],
    async () => ({ id: 'row' })
  );
  const carried = (node: Record<string, unknown>): string[] => [
    ...Object.keys(node).filter((key) =>
      forbidden.get(String(node.type))?.includes(key)
    ),
    ...((node.children as Record<string, unknown>[] | undefined) ?? []).flatMap(
      carried
    ),
  ];
  expect(resolved.flatMap((node) => carried(node as never))).toEqual([]);
});
