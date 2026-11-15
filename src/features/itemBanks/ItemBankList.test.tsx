import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import type { ItemBankPage } from '@/api/types';
import { answerLabels } from '@/features/questions/editorFields';
import { m } from '@/i18n';
import { ItemBankList } from './ItemBankList';
import { bankFilterSections } from './TopicAndTags';

const page: ItemBankPage = {
  items: [
    {
      createdAt: '2026-11-12T10:00:00Z',
      id: 'bq1',
      question: {
        id: 'q1',
        labels: 'letters',
        layout: 'paper',
        parts: [
          {
            answer: {
              correct: [0],
              options: ['Osmosis', 'Diffusion'],
              type: 'mcq',
            },
            blocks: [
              { text: 'Which statement describes osmosis?', type: 'text' },
            ],
            id: 'p1',
            marks: 1,
            solution: [],
          },
          {
            answer: { accepted: ['water'], type: 'short' },
            blocks: [{ text: 'Name the solvent.', type: 'text' }],
            id: 'p2',
            marks: 2,
            solution: [],
          },
        ],
        stem: [],
        topicIds: ['tp_cells', 'tp_dna'],
      },
      tags: ['osmosis', 'membranes'],
      updatedAt: '2026-11-12T10:00:00Z',
    },
  ],
  total: 1,
};

vi.mock('@/api/hooks', () => ({
  useTopics: (wsId: string) => ({
    data: wsId
      ? [
          { id: 'tp_cells', name: 'Cell structure', workspaceId: wsId },
          { id: 'tp_dna', name: 'Genetics', workspaceId: wsId },
        ]
      : [],
  }),
}));
vi.mock('@/api/itemBanks', () => ({
  PERSONAL_BANK: 'me',
  useDeleteItemBankQuestion: () => ({ mutate: vi.fn() }),
  useItemBankQuestions: () => ({
    data: { pageParams: [''], pages: [page] },
    hasNextPage: false,
    isError: false,
    isPending: false,
  }),
  useItemBankTags: () => ({ data: ['membranes', 'osmosis'] }),
  useSaveItemBankQuestion: () => ({ mutateAsync: vi.fn() }),
}));

// A bank lists each question's first words, its answer types, its marks, its
// tags and the day it was added, under Search, one Filter and the count.
it('lists the bank questions as the mock table does', () => {
  const html = renderToStaticMarkup(
    <ItemBankList bank="me" creating={false} onCreatingChange={() => {}} />
  );
  expect(html).toContain(m.bank_search());
  expect(html.split(`aria-label="${m.workspaces_filter()}"`)).toHaveLength(2);
  expect(html).toContain(m.question_ui_one_question());
  expect(html).toContain('Which statement describes osmosis?');
  expect(html).toContain(`${answerLabels.mcq()}, ${answerLabels.short()}`);
  expect(html).toContain('>3<');
  expect(html).toContain('membranes');
});

// A class bank shows a badge per topic of the question before its tags.
it('shows a class bank question topics before its tags', () => {
  const html = renderToStaticMarkup(
    <ItemBankList bank="ws_bio" creating={false} onCreatingChange={() => {}} />
  );
  expect(html).toContain(m.bank_topic_and_tags());
  expect(html.indexOf('Cell structure</span>')).toBeLessThan(
    html.indexOf('Genetics</span><span>osmosis')
  );
});

// One Filter holds the bank's sections (Epo 2026-11-15): Topic when the class
// has topics, then Tags.
it('puts Topic and Tags in one filter', () => {
  const sections = (topics: { id: string; name: string }[]) =>
    bankFilterSections({
      bankTags: ['osmosis'],
      onTags: () => {},
      onTopicIds: () => {},
      tags: [],
      topicIds: [],
      topics: topics.map((topic) => ({
        ...topic,
        description: '',
        fileIds: [],
        order: 0,
        workspaceId: 'ws_bio',
      })),
    }).map((section) => section.label);
  expect(sections([{ id: 'tp_cells', name: 'Cells' }])).toEqual([
    m.quiz_editor_topic(),
    m.common_tags(),
  ]);
  expect(sections([])).toEqual([m.common_tags()]);
});
