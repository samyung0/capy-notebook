import { type ReactNode, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import type { LearnerQuestion, Question } from '@/features/questions/types';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';

/** A question's row text: its first words as written. */
export function questionSummary(question: Question | LearnerQuestion): string {
  const blocks = [
    ...question.stem,
    ...(question.groups?.flatMap((group) => group.blocks) ?? []),
    ...question.parts.flatMap((part) => part.blocks),
  ];
  for (const block of blocks)
    if (block.type === 'text' && block.text.trim()) return block.text.trim();
  return m.quiz_editor_untitled();
}

/** Which question is open, and on a phone whether it or the list shows. */
export function useQuizPick(target?: string, startOnQuestion = !!target) {
  const [picked, setPicked] = useState<string | null>(target ?? null);
  const [onQuestion, setOnQuestion] = useState(startOnQuestion);
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

/**
 * A quiz's one layout, in view, edit, study and an assignment (Epo 2026-11-06,
 * from board X2): the question list on the left, the open question on the right.
 * Phones have room for one: the list, then the question with a way back to it.
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
  questions: Q[];
  /** What a row ends with: a question's marks, unless this says otherwise. */
  rowEnd: (question: Q) => ReactNode;
}) {
  return (
    <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)] md:grid-cols-[300px_minmax(0,1fr)]">
      <nav
        aria-label={m.question_ui_questions()}
        className={cn(
          'min-h-0 flex-col gap-px overflow-y-auto p-2.5 md:flex md:border-divider md:border-r',
          onQuestion ? 'hidden' : 'flex'
        )}
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
          'min-h-0 min-w-0 overflow-y-auto md:block',
          onQuestion ? 'block' : 'hidden'
        )}
      >
        <button
          className="mx-4 mt-3 inline-flex cursor-pointer items-center gap-1.5 font-semibold text-fg-secondary underline md:hidden"
          onClick={onBack}
          type="button"
        >
          <Icon name="navigationBack" size={16} />
          {m.quiz_editor_all_questions()}
        </button>
        {children}
      </div>
    </div>
  );
}
