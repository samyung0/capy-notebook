import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { parseMathText } from '@/features/questions/parseMathText';
import {
  GAP_MARKER,
  type LearnerQuestion,
  type Question,
} from '@/features/questions/types';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';

/** Text without formula markup: a plain formula as written, others elided. */
const rowText = (text: string) =>
  parseMathText(text)
    .map(({ type, value }) =>
      type !== 'text' && value.includes('\\') ? '…' : value
    )
    .join('');

/** A question's row text: its first words as written, gaps as plain blanks. */
export function questionSummary(question: Question | LearnerQuestion): string {
  const blocks = [
    ...question.stem,
    ...(question.groups?.flatMap((group) => group.blocks) ?? []),
    ...question.parts.flatMap((part) => part.blocks),
  ];
  for (const block of blocks)
    if (block.type === 'text' && block.text.trim())
      return rowText(block.text.trim()).replace(GAP_MARKER, '___');
  // Nothing to quote: a figure says so, and only an empty one is new.
  return blocks.some((block) => block.type !== 'text')
    ? m.quiz_row_figure()
    : m.quiz_editor_untitled();
}

/** Which question is open, and on a phone whether it or the list shows. A link
 * to another question opens that one. */
export function useQuizPick(target?: string, startOnQuestion = !!target) {
  const [picked, setPicked] = useState<string | null>(target ?? null);
  const [onQuestion, setOnQuestion] = useState(startOnQuestion);
  const [linked, setLinked] = useState(target);
  if (linked !== target) {
    setLinked(target);
    if (target) {
      setPicked(target);
      setOnQuestion(true);
    }
  }
  return {
    onQuestion,
    open: (id: string | null) => {
      setPicked(id);
      setOnQuestion(true);
    },
    picked,
    setOnQuestion,
    setPicked,
  };
}

/** A row's mark that isn't its number of marks: it says what it means. */
export function RowMark({
  children,
  label,
}: {
  children: ReactNode;
  label: string;
}) {
  return (
    <span aria-label={label} className="inline-flex" role="img">
      {children}
    </span>
  );
}

/**
 * A quiz's one layout, in view, edit, study and an assignment (Epo 2026-11-06,
 * from board X2): the question list on the left, the open question on the right.
 * Phones have room for one: the list, then the question with a way back to it,
 * or `phoneStrip` above the question in place of the list.
 */
export function QuizSplit<Q extends Question | LearnerQuestion>({
  action,
  above,
  children,
  current,
  foot,
  onBack,
  onOpen,
  onQuestion,
  paneClassName,
  phoneStrip,
  questions,
  rowEnd,
}: {
  /** In line with the list's heading, at its right. */
  action?: ReactNode;
  /** Above the rows, under the heading. */
  above?: ReactNode;
  /** The open question's pane. */
  children: ReactNode;
  current: string | undefined;
  /** Under the rows. */
  foot?: ReactNode;
  onBack: () => void;
  onOpen: (id: string) => void;
  onQuestion: boolean;
  /** Around the pane's content: room under it for what floats over the page. */
  paneClassName?: string;
  /** Phones: always above the question, with no list. */
  phoneStrip?: ReactNode;
  questions: Q[];
  /** What a row ends with: a question's marks, unless this says otherwise. */
  rowEnd: (question: Q) => ReactNode;
}) {
  const list = useRef<HTMLElement>(null);
  const pane = useRef<HTMLDivElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  // The list keeps the open question in view, and each opens at its top.
  useEffect(() => {
    if (pane.current) pane.current.scrollTop = 0;
    const row = list.current?.querySelector('[aria-current="true"]');
    // Not in every test DOM.
    row?.scrollIntoView?.({ block: 'nearest' });
  }, [current]);
  // A phone swaps one for the other, and the focus goes where the reader went.
  const onQuestionBefore = useRef(onQuestion);
  useEffect(() => {
    if (onQuestionBefore.current === onQuestion) return;
    onQuestionBefore.current = onQuestion;
    if (onQuestion) back.current?.focus();
    else
      list.current
        ?.querySelector<HTMLElement>('[aria-current="true"]')
        ?.focus();
  }, [onQuestion]);
  const phoneOnQuestion = onQuestion || !!phoneStrip;
  return (
    <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)] md:grid-cols-[300px_minmax(0,1fr)]">
      <nav
        aria-label={m.question_ui_questions()}
        className={cn(
          'min-h-0 flex-col gap-px overflow-y-auto p-2.5 md:flex md:border-divider md:border-r',
          phoneOnQuestion ? 'hidden' : 'flex'
        )}
        ref={list}
      >
        <div className="flex min-h-7 items-center px-1.5 pt-0.5 pb-1.5">
          <p className="min-w-0 font-bold text-[11px] text-fg-muted uppercase leading-none tracking-[.06rem]">
            {m.quiz_editor_questions({ count: questions.length })}
          </p>
          {/* The button's icon in line with the rows' ends. */}
          {action && <span className="-mr-1.25 ml-auto">{action}</span>}
        </div>
        {above}
        {questions.map((item, i) => (
          <button
            aria-current={item.id === current || undefined}
            className={cn(
              'grid min-h-9 w-full cursor-pointer grid-cols-[22px_minmax(0,1fr)_auto] items-center gap-2 rounded-lg px-2 py-1 text-left text-[13.5px] outline-none hover:bg-surface-hover-bg focus-visible:ring-2 focus-visible:ring-action',
              item.id === current && 'bg-page-hover hover:bg-page-hover'
            )}
            data-question-row={item.id}
            key={item.id}
            onClick={() => onOpen(item.id)}
            type="button"
          >
            <span className="font-bold text-fg-secondary">{i + 1}</span>
            <span className="truncate">{questionSummary(item)}</span>
            <span className="flex min-w-5 items-center justify-end gap-1.5 text-right text-fg-muted text-xs">
              {rowEnd(item)}
            </span>
          </button>
        ))}
        <div className="mt-auto flex flex-col gap-2 px-2 pt-3 pb-1 empty:hidden">
          {foot}
        </div>
      </nav>
      <div
        className={cn(
          'min-h-0 min-w-0 flex-col md:flex',
          phoneOnQuestion ? 'flex' : 'hidden'
        )}
      >
        {phoneStrip ?? (
          <button
            className="mx-4 mt-3 inline-flex shrink-0 cursor-pointer items-center gap-1.5 self-start font-semibold text-fg-secondary underline md:hidden"
            onClick={onBack}
            ref={back}
            type="button"
          >
            <Icon name="navigationBack" size={16} />
            {m.quiz_editor_all_questions()}
          </button>
        )}
        <div
          className={cn(
            'min-h-0 min-w-0 flex-1 overflow-y-auto',
            paneClassName
          )}
          data-quiz-pane=""
          ref={pane}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
