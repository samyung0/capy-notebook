import type { ComponentProps, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { shownToasts } from '@/components/ui/userToast';
import { m } from '@/i18n';
import { AddPracticeDialog } from './AddPractice';

vi.mock('@/api/hooks', () => ({
  useCopyQuizToGradedQuiz: () => ({ mutateAsync: vi.fn() }),
  useCreateBankQuiz: () => ({ isPending: false, mutateAsync: vi.fn() }),
  useCreateMaterial: () => ({ isPending: false, mutateAsync: vi.fn() }),
  useFiles: () => ({
    data: [
      {
        hasBytes: true,
        id: 'f1',
        kind: 'pdf',
        name: 'Mock paper.pdf',
        sizeBytes: 2048,
      },
    ],
  }),
  useMakeFileGradedQuiz: () => ({ mutateAsync: vi.fn() }),
  useMaterials: () => ({ data: [] }),
  usePractice: () => ({
    data: { items: [{ id: 'qz1', kind: 'quiz', size: 12, title: 'Osmosis' }] },
  }),
}));
// Outside a dialog here, where Cancel has nothing to close.
vi.mock('@/components/ui/Dialog', () => ({ DialogCancel: () => null }));
// Extract from file's own dialog: the ways it is handed, and what it calls
// once a quiz is made, are what is under test.
let onDone: ((quizId: string) => void) | undefined;
vi.mock('@/features/makeQuiz/MakeQuizDialog', () => ({
  MakeQuizDialog: (props: {
    onDone: (quizId: string) => void;
    tabs: {
      other?: { body: ReactNode; footer: ReactNode };
      title: string;
    };
  }) => {
    onDone = props.onDone;
    return (
      <div data-files-tab={String(!props.tabs.other)}>
        <h2>{props.tabs.title}</h2>
        {props.tabs.other?.body}
        {props.tabs.other?.footer}
      </div>
    );
  },
}));
vi.mock('./MakePractice', () => ({
  useMakePractice: () => ({
    body: <div data-generate />,
    credits: null,
    isPending: false,
    startButton: null,
  }),
}));

const render = (
  graded?: ComponentProps<typeof AddPracticeDialog>['graded'],
  paper: string[] = [],
  onClose: () => void = () => undefined,
  onOpenQuiz: (id: string) => void = () => undefined
) =>
  renderToStaticMarkup(
    <AddPracticeDialog
      graded={graded}
      make={
        {
          initial: { answers: [], paper },
          onClose,
          step: 'files',
          workspaceId: 'ws',
          workspaceName: 'Biology 101',
        } as unknown as ComponentProps<typeof AddPracticeDialog>['make']
      }
      onOpenQuiz={onOpenQuiz}
    />
  );

// Each text's place in the markup: all there, in this order.
const inOrder = (html: string, texts: string[]) => {
  const at = texts.map((text) => html.indexOf(text));
  return (
    !at.includes(-1) && at.every((index, i) => i === 0 || index > at[i - 1])
  );
};

// Epo 2026-11-20, board B: New quiz (was Add quiz) opens on its four ways as
// cards, Extract from file (was Convert to quiz) first and Create blank last
// (Epo 2026-11-16), each saying what it does.
it('opens New quiz on its four ways, each with what it does', () => {
  const html = render();
  expect(html).toContain(m.practice_new_quiz());
  expect(html).toContain('data-files-tab="false"');
  expect(
    inOrder(html, [
      m.practice_tab_convert(),
      m.practice_way_convert(),
      m.practice_tab_generate(),
      m.practice_way_generate(),
      m.practice_tab_bank(),
      m.practice_way_bank(),
      m.practice_tab_create(),
      m.practice_way_create(),
    ])
  ).toBe(true);
});

// Epo 2026-11-16: New graded quiz may start from Existing file, a quiz or
// (2026-11-20) a file the workspace already has, ahead of the four ways to
// make one; Settings come after the pick (2026-11-20).
it('opens New graded quiz on its five ways, Existing file first', () => {
  const html = render({
    onMade: () => undefined,
    onNext: () => undefined,
    title: 'New graded quiz',
  });
  expect(html).toContain('<h2>New graded quiz</h2>');
  expect(
    inOrder(html, [
      m.assignment_tab_existing(),
      m.practice_way_existing(),
      m.practice_tab_convert(),
      m.practice_tab_create(),
    ])
  ).toBe(true);
});

// A link or reload with a paper picked is Extract from file's.
it('opens on Extract from file when the address has files picked', () => {
  const html = render(undefined, ['f1']);
  expect(html).toContain('data-files-tab="true"');
  expect(html).toContain(`<h2>${m.practice_tab_convert()}</h2>`);
});

// Epo 2026-11-20: a quiz made closes the dialog, and its toast opens it.
it('closes once a quiz is made, its toast opening it', () => {
  const onClose = vi.fn();
  const onOpenQuiz = vi.fn();
  render(undefined, [], onClose, onOpenQuiz);
  onDone?.('qz9');
  expect(onClose).toHaveBeenCalled();
  const toast = shownToasts().other;
  expect(toast?.title).toBe(m.practice_quiz_created());
  toast?.button?.onClick();
  expect(onOpenQuiz).toHaveBeenCalledWith('qz9');
});
