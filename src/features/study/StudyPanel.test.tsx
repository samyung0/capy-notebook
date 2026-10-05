import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { m } from '@/i18n';
import { StudyPanel } from './StudyPanel';

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
  useWorkspaceStudy: () => ({
    data: {
      enabled: false,
      items: [{ materialId: 'qz', state: 'started' }],
      quickReview: [
        {
          front: 'Golgi',
          itemId: 'c1',
          kind: 'card',
          materialId: 'set',
          materialTitle: 'Cards',
        },
      ],
      recentAttempts: [],
      reviewable: 4,
    },
  }),
}));

it('shows only the off line and the switch while progress is off', () => {
  const html = renderToStaticMarkup(
    <StudyPanel
      onOpenItem={() => {}}
      renderTabRow={() => null}
      workspaceId="ws"
    />
  );
  expect(html).toContain(m.study_off());
  expect(html).toContain('aria-checked="false"');
  for (const hidden of [
    m.study_up_next(),
    m.study_review(),
    m.study_quick_review(),
    m.study_done(),
    'Golgi',
  ])
    expect(html).not.toContain(hidden);
});
