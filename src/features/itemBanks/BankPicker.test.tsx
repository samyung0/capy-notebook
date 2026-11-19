import { parseHTML } from 'linkedom';
import { expect, it, vi } from 'vitest';
import type { AssignmentFormReq, ItemBankQuestion } from '@/api/types';
import { getLocale, m } from '@/i18n';

// The locale resolves before a window exists, then linkedom's document goes
// in before react-dom/client loads.
getLocale();
const { document, window } = parseHTML(
  '<!doctype html><html><body><div id="root"></div></body></html>'
);
Object.assign(globalThis, { document, IS_REACT_ACT_ENVIRONMENT: true, window });

const question = (id: string, text: string, marks: number) =>
  ({
    createdAt: '2026-11-12T10:00:00Z',
    id,
    question: {
      id: `q_${id}`,
      labels: 'letters',
      layout: 'paper',
      parts: [
        {
          answer: { accepted: ['water'], type: 'short' },
          blocks: [{ text, type: 'text' }],
          id: `p_${id}`,
          marks,
          solution: [],
        },
      ],
      stem: [],
    },
    tags: ['osmosis'],
    updatedAt: '2026-11-12T10:00:00Z',
  }) satisfies ItemBankQuestion;

const create = vi.hoisted(() => vi.fn());
const copy = vi.hoisted(() => vi.fn());
vi.mock('@/api/hooks', () => ({
  useCopyBankQuestions: () => ({ isPending: false, mutate: copy }),
  useCreateBankQuiz: () => ({ isPending: false, mutate: create }),
  useTopics: (wsId: string) => ({
    data: wsId ? [{ id: 'tp_cells', name: 'Cells', workspaceId: wsId }] : [],
  }),
}));
vi.mock('@/api/itemBanks', () => ({
  PERSONAL_BANK: 'me',
  useItemBankQuestions: () => ({
    data: {
      pageParams: [''],
      pages: [
        {
          items: [
            {
              ...question('bq1', 'Define osmosis.', 1),
              question: {
                ...question('bq1', 'Define osmosis.', 1).question,
                topicIds: ['tp_cells'],
              },
            },
            question('bq2', 'Explain turgor.', 2),
          ],
          total: 2,
        },
      ],
    },
    hasNextPage: false,
    isError: false,
    isPending: false,
  }),
  useItemBanks: () => ({
    data: [
      { count: 2, id: 'ws_bio', kind: 'workspace', name: 'Biology' },
      { count: 2, id: 'me', kind: 'personal', name: '' },
    ],
  }),
  useItemBankTags: () => ({ data: ['osmosis'] }),
}));
vi.mock('@/components/app/ListToolbar', () => ({
  FilterPopover: () => null,
  toggleValue: () => [],
}));
vi.mock('@/components/app/ListEnd', () => ({ ListEnd: () => null }));
// The dialog stays mounted while closed, as Radix keeps it for its animation.
vi.mock('@/components/ui/Dialog', () => ({
  SimpleDialog: ({
    action,
    children,
    footer,
  }: Record<string, import('react').ReactNode>) => (
    <>
      {children}
      <p data-note>{footer}</p>
      {action}
    </>
  ),
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { BankQuestionsDialog, useBankPicker } = await import('./BankPicker');

const form = { kind: 'marked', title: 'Cells check' } as AssignmentFormReq;

function Harness() {
  const { action, body, note } = useBankPicker({
    active: true,
    gradedQuiz: form,
    label: m.action_continue(),
    onMade: () => {},
    title: () => 'Biology quiz 1',
    workspaceId: 'ws_bio',
  });
  return (
    <>
      {body}
      <p data-note>{note}</p>
      {action}
    </>
  );
}

const click = (element: Element | null | undefined) =>
  act(async () => {
    element?.dispatchEvent(new window.Event('click', { bubbles: true }));
  });
const byText = (selector: string, text: string) =>
  [...document.querySelectorAll(selector)].find((element) =>
    element.textContent?.includes(text)
  );
const note = () => document.querySelector('[data-note]')?.textContent ?? '';

// From the bank: the class's bank and My bank switched, a box per question;
// the picks, in the order picked, go to the server as one copy, and switching
// banks starts the picks over. A class bank's question shows its topic.
it('copies the questions picked from the bank shown', async () => {
  const root = createRoot(document.getElementById('root') as never);
  await act(async () => root.render(<Harness />));
  expect(byText('[role=group] button', 'Biology')).toBeTruthy();
  expect(byText('button', m.bank_personal())).toBeTruthy();
  expect(byText('[role=checkbox]', 'Define osmosis.')?.textContent).toContain(
    'Cells'
  );

  await click(byText('[role=checkbox]', 'Explain turgor.'));
  await click(byText('[role=checkbox]', 'Define osmosis.'));
  expect(note()).toContain(m.question_ui_question_count({ count: 2 }));
  expect(note()).toContain(m.question_ui_marks({ count: 3 }));
  await click(byText('button', m.action_continue()));
  expect(create).toHaveBeenCalledWith(
    {
      bank: 'ws_bio',
      gradedQuiz: form,
      questionIds: ['bq2', 'bq1'],
      title: 'Biology quiz 1',
    },
    expect.anything()
  );

  await click(byText('button', m.bank_personal()));
  expect(note()).toBe('');
  await click(byText('[role=checkbox]', m.bank_select_all({ count: 2 })));
  expect(note()).toContain(m.question_ui_question_count({ count: 2 }));
  await act(async () => root.unmount());
});

// The quiz editor's From the bank starts empty each time it opens, so a
// second open never adds the last picks again.
it('starts the quiz dialog over each time it opens', async () => {
  const root = createRoot(document.getElementById('root') as never);
  const render = (open: boolean) =>
    act(async () =>
      root.render(
        <BankQuestionsDialog
          existing={[]}
          onAdd={() => {}}
          onClose={() => {}}
          open={open}
          quizId="qz_1"
          workspaceId="ws_bio"
        />
      )
    );
  await render(true);
  await click(byText('[role=checkbox]', 'Explain turgor.'));
  expect(note()).toContain(m.question_ui_one_question());
  await click(byText('button', m.bank_add_one_question()));
  expect(copy).toHaveBeenCalledWith(
    { bank: 'ws_bio', questionIds: ['bq2'] },
    expect.anything()
  );
  await render(false);
  await render(true);
  expect(note()).toBe('');
  expect(byText('button', m.bank_add_questions_none())).toBeTruthy();
  await act(async () => root.unmount());
});
