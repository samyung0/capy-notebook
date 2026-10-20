import {
  isValidElement,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { expect, it, vi } from 'vitest';
import { m } from '@/i18n';
import { AnswerEditor, StringList } from './editorFields';
import type { QuestionAnswer } from './types';

type Props = {
  'aria-label'?: string;
  children?: ReactNode;
  disabled?: boolean;
  label?: string;
  onClick?: () => void;
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
};

/** The first element under `node` that `match` picks. The answer editor and
 * the string list hold no hooks, so calling them returns their trees. */
function find(
  node: ReactNode,
  match: (element: ReactElement<Props>) => boolean
): ReactElement<Props> | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = find(child, match);
      if (found) return found;
    }
    return;
  }
  if (!isValidElement<Props>(node)) return;
  if (match(node)) return node;
  return find(node.props.children, match);
}

const answer: Extract<QuestionAnswer, { type: 'matching' }> = {
  options: ['Stores DNA', 'Makes ATP', 'Builds proteins'],
  pairs: [
    { left: 'Nucleus', right: 0 },
    { left: 'Mitochondrion', right: 1 },
    { left: 'Ribosome', right: 2 },
  ],
  type: 'matching',
};
const answers = ({ options, pairs }: typeof answer) =>
  pairs.map((pair) => [pair.left, options[pair.right]]);

/** The option pool as the answer editor draws it, and what its moves make. */
function pool() {
  const changed: QuestionAnswer[] = [];
  const list = find(
    AnswerEditor({
      answer,
      bank: false,
      onChange: (next) => changed.push(next),
    }),
    (element) => element.type === StringList
  );
  if (!list) throw new Error('No option pool');
  return {
    changed,
    tree: StringList(list.props as Parameters<typeof StringList>[0]),
  };
}

it('moves an option with its buttons, every prompt keeping its answer', () => {
  const { changed, tree } = pool();
  const button = (label: string) =>
    find(tree, (element) => element.props.label === label)?.props;
  expect(button(m.question_ui_move_option_up({ number: 1 }))?.disabled).toBe(
    true
  );
  expect(button(m.question_ui_move_option_down({ number: 3 }))?.disabled).toBe(
    true
  );
  button(m.question_ui_move_option_down({ number: 1 }))?.onClick?.();
  const [moved] = changed;
  if (moved?.type !== 'matching') throw new Error('No move');
  expect(moved.options).toEqual(['Makes ATP', 'Stores DNA', 'Builds proteins']);
  expect(answers(moved)).toEqual(answers(answer));
});

it('moves the focused option with Alt+ArrowUp, focus following it', () => {
  const { changed, tree } = pool();
  const input = find(
    tree,
    (element) =>
      element.props['aria-label'] ===
      m.question_ui_numbered_item({
        label: m.question_ui_choice_pool(),
        number: 3,
      })
  );
  const inputs = answer.options.map(() => ({ focus: vi.fn() }));
  input?.props.onKeyDown?.({
    altKey: true,
    currentTarget: {
      closest: () => ({ querySelectorAll: () => inputs }),
    },
    key: 'ArrowUp',
    preventDefault: vi.fn(),
  } as unknown as KeyboardEvent<HTMLInputElement>);
  const [moved] = changed;
  if (moved?.type !== 'matching') throw new Error('No move');
  expect(moved.options).toEqual(['Stores DNA', 'Builds proteins', 'Makes ATP']);
  expect(answers(moved)).toEqual(answers(answer));
  expect(inputs[1].focus).toHaveBeenCalled();
});
