import type { Descendant } from 'platejs';
import { expect, it } from 'vitest';
import {
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
