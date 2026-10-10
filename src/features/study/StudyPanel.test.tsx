import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { m } from '@/i18n';
import { StudyPanel } from './StudyPanel';

const study = vi.hoisted(() => ({ enabled: false }));

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
    const html = renderToStaticMarkup(
      <StudyPanel
        onOpenItem={() => {}}
        renderTabRow={() => null}
        workspaceId="ws"
      />
    );
    expect(html).toContain('Golgi');
    expect(html).not.toContain(m.material_attribution_title());
    expect(html).not.toContain(
      m.material_attribution_sources({ count: 1 }).split('(')[0]
    );
  } finally {
    study.enabled = false;
  }
});
