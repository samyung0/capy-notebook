import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { m } from '@/i18n';
import { StudyProgress } from './StudyProgress';

const study = vi.hoisted(() => ({ enabled: true }));

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    className,
    params,
    to,
  }: {
    children: React.ReactNode;
    className?: string;
    params?: Record<string, string>;
    to: string;
  }) => (
    <a
      className={className}
      href={to.replace(/\$(\w+)/g, (_, key) => params?.[key] ?? '')}
    >
      {children}
    </a>
  ),
}));

const attempt = (id: string, kind: 'quiz' | 'flashcards', takenAt: string) => ({
  chapters: [],
  correct: 3,
  id,
  kind,
  materialId: kind === 'quiz' ? 'qz' : 'set',
  pct: 75,
  quizName: '',
  startedAt: null,
  takenAt,
  total: 4,
  workspaceId: 'ws',
  workspaceName: 'Bio',
});

vi.mock('@/api/hooks', () => ({
  useChapters: () => ({ data: [] }),
  useFiles: () => ({
    data: [
      {
        addedAt: '',
        chapterId: null,
        id: 'f1',
        kind: 'pdf',
        name: 'Cells.pdf',
        position: 0,
      },
    ],
  }),
  useMaterials: () => ({
    data: [
      {
        chapterId: null,
        createdAt: '',
        id: 'qz',
        position: 1,
        title: 'Quiz',
        type: 'quiz',
      },
      {
        chapterId: null,
        createdAt: '',
        id: 'set',
        position: 2,
        title: 'Cards',
        type: 'flashcards',
      },
    ],
  }),
  useSetStudyItem: () => ({ mutate: vi.fn() }),
  useWorkspaceAttempts: () => ({
    data: {
      items: [
        {
          count: 2,
          materialId: 'qz',
          recent: [
            attempt('at_2', 'quiz', '2026-10-16T10:00:00Z'),
            attempt('at_1', 'quiz', '2026-10-11T10:00:00Z'),
          ],
          size: 10,
        },
        {
          count: 1,
          materialId: 'set',
          recent: [attempt('fa_1', 'flashcards', '2026-10-13T10:00:00Z')],
          size: 18,
        },
      ],
    },
  }),
  useWorkspaceStudy: () => ({
    data: {
      enabled: study.enabled,
      items: [
        { fileId: 'f1', state: 'done', updatedAt: '2026-10-09T10:00:00Z' },
      ],
    },
  }),
}));

it('lists every item with its read state, attempts and latest result', () => {
  const html = renderToStaticMarkup(
    <StudyProgress
      onOpenItem={() => {}}
      onOpenTrackProgress={() => {}}
      workspaceId="ws"
    />
  );
  expect(html).toContain('Cells.pdf');
  expect(html).toContain(m.progress_read_on({ date: '' }).trim());
  expect(html).toContain(
    `${m.progress_attempts({ count: 2 })} · ${m.question_ui_question_count({ count: 10 })}`
  );
  expect(html).toContain(m.flashcards_score({ correct: 3, total: 4 }));
  // A practised quiz or set opens its latest result.
  expect(html).toContain('href="/quizzes/attempts/at_2"');
  expect(html).toContain('href="/flashcards/attempts/fa_1"');
});

it('says progress is off and links to Track progress instead of listing', () => {
  study.enabled = false;
  const html = renderToStaticMarkup(
    <StudyProgress
      onOpenItem={() => {}}
      onOpenTrackProgress={() => {}}
      workspaceId="ws"
    />
  );
  study.enabled = true;
  expect(html).toContain(m.progress_off_title());
  expect(html).toContain(m.progress_off_turn_on());
  expect(html).not.toContain('Cells.pdf');
});
