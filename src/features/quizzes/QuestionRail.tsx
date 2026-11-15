import { type ReactNode, useEffect, useRef, useState } from 'react';
import type { Question } from '@/api/types';
import { Icon } from '@/components/ui/Icon';
import { PendingDot } from '@/components/ui/PendingDot';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  useMenuOpenAutoFocus,
} from '@/components/ui/Popover';
import { ToolbarButton } from '@/components/ui/ToolbarButton';
import { answerKind, kindIcons } from '@/features/questions/editorFields';
import { questionIssues } from '@/features/questions/issues';
import { questionMarks } from '@/features/questions/types';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { questionSummary, RowMark } from './QuizSplit';

const marksLabel = (count: number) =>
  count === 1 ? m.question_ui_one_mark() : m.question_ui_marks({ count });

/** The outline, opened by pointer with no row ringed, as the menus are. */
function OutlineContent({ children }: { children: ReactNode }) {
  const onOpenAutoFocus = useMenuOpenAutoFocus();
  return (
    <PopoverContent
      align="start"
      className="max-h-(--radix-popover-content-available-height) w-110 gap-0 overflow-y-auto"
      onOpenAutoFocus={onOpenAutoFocus}
      side="right"
    >
      {children}
    </PopoverContent>
  );
}

/**
 * The editor's question list as Canvas's Build page has it (Epo 2026-11-15,
 * boards ListA and ListA2): a narrow rail of numbers, the open one dark and one
 * with an issue dotted, whose ≡ opens the outline (number, type, question,
 * marks), as Canvas's Question Navigator, and + under them adds a question at
 * the end. From md; phones have the cards alone.
 */
export function QuestionRail({
  current,
  onAdd,
  onOpen,
  opening,
  questions,
}: {
  current: string | undefined;
  /** Add question, at the quiz's end, from the + under the numbers. */
  onAdd: () => void;
  onOpen: (id: string) => void;
  /** Painted before its rooms sync: nothing to mark yet. */
  opening?: boolean;
  questions: Question[];
}) {
  const [outline, setOutline] = useState(false);
  const rail = useRef<HTMLElement>(null);
  // The open question's number stays in view.
  useEffect(() => {
    rail.current
      ?.querySelector('[aria-current="true"]')
      // Not in every test DOM.
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [current]);
  const issue = (question: Question) =>
    !opening && questionIssues(question).length > 0;
  const total = questions.reduce((sum, q) => sum + questionMarks(q), 0);
  return (
    <nav
      aria-label={m.question_ui_questions()}
      className="hidden w-15 shrink-0 flex-col items-center border-divider border-r py-2.5 md:flex"
      ref={rail}
    >
      <Popover onOpenChange={setOutline} open={outline}>
        <PopoverTrigger asChild>
          <ToolbarButton
            className={cn('mb-1.5', outline && 'bg-page-hover')}
            label={m.quiz_editor_navigator()}
          >
            <Icon name="menu" />
          </ToolbarButton>
        </PopoverTrigger>
        <OutlineContent>
          <p className="flex items-center px-2 pt-0.5 pb-2 font-bold">
            {m.quiz_editor_questions({ count: questions.length })}
            <span className="ml-auto font-medium text-fg-muted text-xs">
              {marksLabel(total)}
            </span>
          </p>
          {questions.map((question, i) => (
            <button
              aria-current={question.id === current || undefined}
              className={cn(
                'grid min-h-10 w-full cursor-pointer grid-cols-[18px_16px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-lg px-2 text-left text-[13.5px] outline-none hover:bg-surface-hover-bg focus-visible:ring-2 focus-visible:ring-action',
                question.id === current && 'bg-page-hover hover:bg-page-hover'
              )}
              key={question.id}
              onClick={() => {
                onOpen(question.id);
                setOutline(false);
              }}
              type="button"
            >
              <span className="font-bold text-fg-secondary">{i + 1}</span>
              <Icon
                className="size-4 text-fg-muted"
                name={kindIcons[answerKind(question.parts[0].answer)]}
              />
              <span className="truncate">{questionSummary(question)}</span>
              <span className="flex items-center gap-1.5 whitespace-nowrap text-fg-muted text-xs">
                {issue(question) && (
                  <RowMark label={m.quiz_editor_has_issue()}>
                    <Icon
                      className="size-4 text-tint-warning-fg"
                      name="alert"
                    />
                  </RowMark>
                )}
                {marksLabel(questionMarks(question))}
              </span>
            </button>
          ))}
        </OutlineContent>
      </Popover>
      {/* The numbers scroll between ≡ and +, faded at an edge with more. */}
      <div className="scroll-fade-y flex min-h-0 w-full flex-1 flex-col items-center gap-0.5 overflow-y-auto py-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {questions.map((question, i) => (
          <button
            aria-current={question.id === current || undefined}
            aria-label={
              issue(question)
                ? `${m.quiz_editor_question({ number: i + 1 })}, ${m.quiz_editor_has_issue()}`
                : m.quiz_editor_question({ number: i + 1 })
            }
            className={cn(
              'relative flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-lg font-semibold text-[13.5px] text-fg-secondary outline-none hover:bg-surface-hover-bg focus-visible:ring-2 focus-visible:ring-action',
              question.id === current &&
                'bg-action text-action-fg hover:bg-action-hover'
            )}
            data-question-row={question.id}
            key={question.id}
            onClick={() => onOpen(question.id)}
            type="button"
          >
            {i + 1}
            {issue(question) && <PendingDot className="top-1.25 right-1.25" />}
          </button>
        ))}
      </div>
      <ToolbarButton
        className="mt-1.5"
        disabled={opening}
        label={m.quiz_add_question()}
        onClick={onAdd}
      >
        <Icon name="plus" />
      </ToolbarButton>
    </nav>
  );
}
