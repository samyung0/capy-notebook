import { expect, it } from 'vitest';
import type { ItemBank, Question, Topic } from '@/api/types';
import { bankCopy, topicTag } from './AddToBankItem';

const question = {
  id: 'q1',
  labels: 'letters',
  layout: 'paper',
  parts: [
    {
      answer: { accepted: ['water'], type: 'short' },
      blocks: [{ text: 'Name the solvent.', type: 'text' }],
      id: 'p1',
      marks: 1,
      solution: [],
    },
  ],
  stem: [],
} satisfies Question;
const topic = (id: string, name: string) =>
  ({
    description: '',
    fileIds: [],
    id,
    name,
    order: 0,
    workspaceId: 'ws_bio',
  }) satisfies Topic;
const topics = [topic('tp_cells', 'Cells, tissues'), topic('tp_dna', 'DNA')];
const bank = (id: string, kind: ItemBank['kind']): ItemBank => ({
  count: 0,
  id,
  kind,
  name: '',
});

// The class's own bank keeps the topics the question counts toward; My bank
// and another class's bank take each one's name as a plain tag instead.
it('keeps the topics in its class bank and tags them elsewhere', () => {
  expect(bankCopy(question, bank('ws_bio', 'workspace'), topics)).toEqual({
    question: { ...question, topicIds: ['tp_cells', 'tp_dna'] },
    tags: [],
  });
  for (const other of [bank('me', 'personal'), bank('ws_x', 'workspace')])
    expect(
      bankCopy({ ...question, topicIds: ['tp_cells', 'tp_dna'] }, other, topics)
    ).toEqual({ question, tags: ['Cells tissues', 'DNA'] });
  expect(topicTag('x'.repeat(60))).toHaveLength(35);
  // Cut by whole characters: an emoji that does not fit is left out whole.
  expect(topicTag(`${'x'.repeat(34)}🧬`)).toBe('x'.repeat(34));
});
