import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { Topic } from '@/api/types';
import { TopicField, withTopics } from './TopicField';

const topic = (id: string, name: string, order: number): Topic => ({
  description: '',
  fileIds: [],
  id,
  name,
  order,
  workspaceId: 'ws_bio',
});
const topics = [
  topic('tp_cells', 'Cell structure', 0),
  topic('tp_membranes', 'Membranes & transport', 1),
  topic('tp_genetics', 'Genetics', 2),
];
const field = (topicIds?: string[]) =>
  renderToStaticMarkup(
    <TopicField
      fallback={topics[1]}
      onChange={() => {}}
      topicIds={topicIds}
      topics={topics}
    />
  );

// The trigger reads the quiz's topic with none of its own, else the names in
// the workspace's order, joined with commas (board "Several topics per
// question"); an id the workspace no longer holds reads as none.
it('names the question topics in the trigger', () => {
  expect(field()).toContain('Membranes &amp; transport');
  expect(field(['tp_gone'])).toContain('Membranes &amp; transport');
  expect(field(['tp_genetics', 'tp_cells'])).toContain(
    'Cell structure, Genetics'
  );
});

it('drops the field when the topics are cleared', () => {
  const question = { id: 'q1', topicIds: ['tp_cells'] };
  expect(withTopics(question, [])).toEqual({ id: 'q1' });
  expect(withTopics(question, ['tp_genetics'])).toEqual({
    id: 'q1',
    topicIds: ['tp_genetics'],
  });
});
