import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { m } from '@/i18n';
import { StudyPanel } from './StudyPanel';

const study = vi.hoisted(() => ({
  enabled: false,
  quickReview: [
    {
      front: 'Golgi',
      itemId: 'c1',
      kind: 'card',
      materialId: 'set',
      materialTitle: 'Cards',
    },
  ] as Record<string, unknown>[],
  unfinished: undefined as
    | { answered: number; id: string; lastAnswerAt: string; total: number }
    | undefined,
}));

vi.mock('@/api/hooks', () => ({
  useChapters: () => ({ data: [] }),
  useFiles: () => ({ data: [] }),
  useMaterials: () => ({
    data: [
      {
        chapterId: null,
        createdAt: '',
        id: 'qz',
        position: 0,
        title: 'Cells',
        type: 'quiz',
      },
    ],
  }),
  useRateReviewItem: () => ({ mutateAsync: vi.fn() }),
  useSetWorkspaceStudyEnabled: () => ({ mutate: vi.fn() }),
  useWorkspace: () => ({ data: undefined }),
  useWorkspaceStudy: () => ({
    data: {
      enabled: study.enabled,
      items: [{ materialId: 'qz', state: 'started' }],
      quickReview: study.quickReview,
      recentAttempts: [],
      reviewable: 4,
      unfinished: study.unfinished,
    },
  }),
}));

const render = () =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <StudyPanel
        onOpenItem={() => {}}
        onOpenProgress={() => {}}
        renderTabRow={() => null}
        workspaceId="ws"
      />
    </QueryClientProvider>
  );

it('shows only the off line and the switch while progress is off', () => {
  const html = render();
  expect(html).toContain(m.study_off());
  expect(html).toContain('aria-checked="false"');
  for (const hidden of [
    m.study_quick_actions(),
    m.study_quick_review(),
    m.study_done(),
    'Golgi',
  ])
    expect(html).not.toContain(hidden);
});

// Mini views show part of an item or mix items, so they credit nothing
// (Epo 2026-10-11): the item's own pages and its note do.
it('shows Quick review cards without credits', () => {
  study.enabled = true;
  try {
    const html = render();
    expect(html).toContain('Golgi');
    expect(html).not.toContain(m.material_attribution_title());
    expect(html).not.toContain(
      m.material_attribution_sources({ count: 1 }).split('(')[0]
    );
  } finally {
    study.enabled = false;
  }
});

it('offers the whole workspace review, continuing an unfinished session', () => {
  study.enabled = true;
  try {
    let html = render();
    expect(html).toContain(m.study_whole_workspace());
    expect(html).toContain(m.study_review_button());
    expect(html).not.toContain(m.learning_continue_review());
    study.unfinished = {
      answered: 1,
      id: 's1',
      lastAnswerAt: new Date().toISOString(),
      total: 3,
    };
    html = render();
    expect(html).toContain(m.learning_continue_review());
    expect(html).toContain('1 of 3');
  } finally {
    study.enabled = false;
    study.unfinished = undefined;
  }
});

it('shows a quick question with Check', () => {
  study.enabled = true;
  const card = study.quickReview;
  study.quickReview = [
    {
      itemId: 'q4',
      kind: 'question',
      materialId: 'qz',
      materialTitle: 'Cells',
      question: {
        id: 'q4',
        layout: 'paper',
        parts: [
          {
            answer: { type: 'short' },
            blocks: [{ text: 'Name the process.', type: 'text' }],
            id: 'q4:part',
            marks: 1,
          },
        ],
        stem: [],
      },
    },
  ];
  try {
    const html = render();
    expect(html).toContain('Name the process.');
    expect(html).toContain(m.review_check());
  } finally {
    study.enabled = false;
    study.quickReview = card;
  }
});
