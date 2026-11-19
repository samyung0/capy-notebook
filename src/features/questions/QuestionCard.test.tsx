import { parseHTML } from 'linkedom';
import { act, useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { getLocale, m } from '@/i18n';
import { blankQuestion, type Question } from './types';

/* The open text's editor reads its value once, so a block added or removed
   above it closes it rather than letting it write over the block in its place. */

getLocale();
const { document, window } = parseHTML(
  '<!doctype html><html><body></body></html>'
);
Object.assign(globalThis, { document, IS_REACT_ACT_ENVIRONMENT: true, window });

vi.mock('@/components/ui/Dialog', () => ({ useIsPhone: () => false }));
// Menus and the type select stay shut here; this DOM has no layout for them.
vi.mock('@/components/ui/Popover', () => ({
  Popover: () => null,
  PopoverTrigger: () => null,
}));
vi.mock('@/components/ui/ToolbarButton', () => ({
  ToolbarButton: ({
    disabled,
    label,
    onClick,
  }: {
    disabled?: boolean;
    label: string;
    onClick?: () => void;
  }) => (
    <button
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      type="button"
    />
  ),
}));
vi.mock('./editorFields', async (original) => ({
  ...(await original<typeof import('./editorFields')>()),
  AnswerTypeSelect: () => null,
  MarksInput: () => null,
}));
// As the real editor: uncontrolled, its value read on mount.
vi.mock('./TextEditor', () => ({
  TextEditor: ({
    onChange,
    value,
  }: {
    onChange: (text: string, ids: string[]) => void;
    value: string;
  }) => (
    <textarea
      data-editor=""
      defaultValue={value}
      onChange={(event) => onChange(event.target.value, [])}
    />
  ),
}));

const { createRoot } = await import('react-dom/client');
const { QuestionCard } = await import('./QuestionCard');

const host = document.createElement('div');
document.body.append(host);
let root: ReturnType<typeof createRoot>;
afterEach(() => act(() => root.unmount()));

let current: Question;
let setOutside: (question: Question) => void;

function Card({ start }: { start: Question }) {
  const [question, setQuestion] = useState(start);
  current = question;
  setOutside = setQuestion;
  return <QuestionCard question={question} write={setQuestion} />;
}

const text = (value: string) => ({ text: value, type: 'text' as const });
const table = { header: false, rows: [['1']], type: 'table' as const };

/** A question whose text is A, a table, B and C, with B open in its editor. */
async function showEditingB() {
  const question = blankQuestion();
  const [part] = question.parts;
  root = createRoot(host);
  await act(async () =>
    root.render(
      <Card
        start={{
          ...question,
          parts: [
            { ...part, blocks: [text('A'), table, text('B'), text('C')] },
          ],
        }}
      />
    )
  );
  const b = [...host.querySelectorAll('button')].find(
    (button) => button.textContent === 'B'
  );
  await act(async () => b?.click());
}

const blockTexts = () =>
  current.parts[0].blocks.map((block) =>
    block.type === 'text' ? block.text : block.type
  );

it('closes the open text when a figure above it goes', async () => {
  await showEditingB();
  expect(host.querySelector('[data-editor]')).not.toBeNull();
  const remove = host.querySelector<HTMLButtonElement>(
    `button[aria-label="${m.question_ui_remove_block()}"]`
  );
  await act(async () => remove?.click());
  expect(host.querySelector('[data-editor]')).toBeNull();
  expect(blockTexts()).toEqual(['A', 'B', 'C']);
});

it('closes the open text when a co-editor removes a block above it', async () => {
  await showEditingB();
  expect(host.querySelector('[data-editor]')).not.toBeNull();
  const [part] = current.parts;
  await act(async () =>
    setOutside({
      ...current,
      parts: [{ ...part, blocks: part.blocks.slice(1) }],
    })
  );
  // C now sits where B's editor was.
  expect(host.querySelector('[data-editor]')).toBeNull();
  expect(blockTexts()).toEqual(['table', 'B', 'C']);
});
