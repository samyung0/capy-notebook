import type { ComponentProps, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import type { MakeQuizDialog } from '@/features/makeQuiz/MakeQuizDialog';
import { m } from '@/i18n';
import { AddPracticeDialog } from './AddPractice';

vi.mock('@/api/hooks', () => ({
  useCreateBankQuiz: () => ({ isPending: false, mutate: vi.fn() }),
  useCreateMaterial: () => ({ isPending: false, mutate: vi.fn() }),
  useMaterials: () => ({ data: [] }),
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

const render = () =>
  renderToStaticMarkup(
    <AddPracticeDialog
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

// Epo 2026-11-14: Add quiz opens on Convert to quiz, its first tab; From the
// bank comes last.
it('opens Add quiz on Convert to quiz, the first of its four tabs', () => {
  const html = render();
  expect(html).toContain(m.practice_add_quiz());
  const at = [
    m.practice_tab_convert(),
    m.practice_tab_create(),
    m.practice_tab_generate(),
    m.practice_tab_bank(),
  ].map((tab) => html.indexOf(tab));
  expect(at.every((index) => index >= 0)).toBe(true);
  expect(at).toEqual([...at].sort((a, b) => a - b));
  expect(html).toContain('data-files-tab="true"');
});
