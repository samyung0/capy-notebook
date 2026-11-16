import type { ComponentProps, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import type { MakeQuizDialog } from '@/features/makeQuiz/MakeQuizDialog';
import { m } from '@/i18n';
import { AddPracticeDialog } from './AddPractice';
import { QUIZ_TEMPLATES, templateLabel } from './quizTemplates';

vi.mock('@/api/hooks', () => ({
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

const render = (paper: string[] = []) =>
  renderToStaticMarkup(
    <AddPracticeDialog
      make={
        {
          initial: { answers: [], paper },
          onClose: () => undefined,
          step: 'files',
          workspaceId: 'ws',
          workspaceName: 'Biology 101',
        } as unknown as ComponentProps<typeof MakeQuizDialog>
      }
      onOpenQuiz={() => undefined}
    />
  );

// Epo 2026-11-11: one dialog, three ways to make a quiz.
it('opens on Create quiz with a template for each kind of question', () => {
  const html = render();
  expect(html).toContain(m.practice_add());
  for (const tab of [
    m.practice_tab_create(),
    m.practice_tab_generate(),
    m.practice_tab_convert(),
  ])
    expect(html).toContain(tab);
  for (const id of QUIZ_TEMPLATES) expect(html).toContain(templateLabel(id));
  expect(html).toContain(m.action_create());
  expect(html).toContain('data-files-tab="false"');
});

it('opens on Convert to quiz when files are already picked', () => {
  expect(render(['f_1'])).toContain('data-files-tab="true"');
});
