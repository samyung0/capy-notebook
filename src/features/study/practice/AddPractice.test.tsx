import type { ComponentProps, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import type { MakeQuizDialog } from '@/features/makeQuiz/MakeQuizDialog';
import { m } from '@/i18n';
import { AddPracticeDialog } from './AddPractice';

vi.mock('@/api/hooks', () => ({
  useCopyQuizToGradedQuiz: () => ({ isPending: false, mutate: vi.fn() }),
  useCreateBankQuiz: () => ({ isPending: false, mutate: vi.fn() }),
  useCreateMaterial: () => ({ isPending: false, mutate: vi.fn() }),
  useMaterials: () => ({ data: [] }),
  usePractice: () => ({
    data: { items: [{ id: 'qz1', kind: 'quiz', size: 12, title: 'Osmosis' }] },
  }),
}));
// Outside a dialog here, where Cancel has nothing to close.
vi.mock('@/components/ui/Dialog', () => ({ DialogCancel: () => null }));
// Convert to quiz's own dialog: the tabs it is handed are what is under test.
vi.mock('@/features/makeQuiz/MakeQuizDialog', () => ({
  MakeQuizDialog: ({
    tabs,
  }: {
    tabs: {
      other?: { body: ReactNode; footer: ReactNode };
      strip: ReactNode;
      title: string;
    };
  }) => (
    <div data-files-tab={String(!tabs.other)}>
      <h2>{tabs.title}</h2>
      {tabs.strip}
      {tabs.other?.body}
      {tabs.other?.footer}
    </div>
  ),
}));
vi.mock('./MakePractice', () => ({
  useMakePractice: () => ({
    body: <div data-generate />,
    credits: null,
    isPending: false,
    startButton: null,
  }),
}));

const render = (graded?: ComponentProps<typeof AddPracticeDialog>['graded']) =>
  renderToStaticMarkup(
    <AddPracticeDialog
      graded={graded}
      make={
        {
          initial: { answers: [], paper: [] },
          onClose: () => undefined,
          step: 'files',
          workspaceId: 'ws',
          workspaceName: 'Biology 101',
        } as unknown as ComponentProps<typeof MakeQuizDialog>
      }
      onOpenQuiz={() => undefined}
    />
  );

// Epo 2026-11-14: Add quiz opens on Convert to quiz, its first tab; Create
// blank comes last (Epo 2026-11-16).
it('opens Add quiz on Convert to quiz, the first of its four tabs', () => {
  const html = render();
  expect(html).toContain(m.practice_add_quiz());
  const at = [
    m.practice_tab_convert(),
    m.practice_tab_generate(),
    m.practice_tab_bank(),
    m.practice_tab_create(),
  ].map((tab) => html.indexOf(tab));
  expect(at.every((index) => index >= 0)).toBe(true);
  expect(at).toEqual([...at].sort((a, b) => a - b));
  expect(html).toContain('data-files-tab="true"');
});

// Epo 2026-11-16: New graded quiz's Questions step starts on Existing quiz,
// a quiz the workspace already has, ahead of the four ways to make one.
it("opens New graded quiz's Questions on Existing quiz, listing the workspace's quizzes", () => {
  const html = render({
    form: {} as never,
    onBack: () => undefined,
    onMade: () => undefined,
    title: 'New graded quiz',
  });
  const at = [
    m.assignment_tab_existing(),
    m.practice_tab_convert(),
    m.practice_tab_create(),
  ].map((tab) => html.indexOf(tab));
  expect(at).toEqual([...at].sort((a, b) => a - b));
  expect(html).toContain('data-files-tab="false"');
  expect(html).toContain('Osmosis');
});
