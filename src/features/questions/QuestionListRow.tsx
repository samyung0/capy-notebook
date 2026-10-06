import type { ReactNode } from 'react';
import { Icon } from '@/components/ui/Icon';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { type BankRow, type BankStatus, bankStatus } from './bank';
import { TextView } from './QuestionView';

/**
 * One question in a question list: bold number, the stem clamped to two
 * lines, then a muted line with the marks, figure and table icons and `meta`.
 * `result` leads the row with the learner's latest score (1 right, 0 wrong,
 * between partly right, null not answered); lists without results leave it out.
 */
export function QuestionListRow({
  row,
  current,
  result,
  meta,
  onClick,
}: {
  row: Pick<
    BankRow,
    'position' | 'preview' | 'marks' | 'hasFigure' | 'hasTable'
  >;
  current: boolean;
  result?: number | null;
  meta?: ReactNode;
  onClick: () => void;
}) {
  const marked = result !== undefined;
  const status = bankStatus(result ?? undefined);
  return (
    <button
      aria-current={current ? 'true' : undefined}
      className={cn(
        'grid w-full grid-cols-[1.5rem_minmax(0,1fr)] rounded-button px-2 py-2 text-left text-sm hover:bg-surface-hover-bg',
        marked && 'grid-cols-[1.5rem_1.5rem_minmax(0,1fr)]',
        current && 'bg-surface-hover-bg'
      )}
      onClick={onClick}
      type="button"
    >
      {marked &&
        // Screen readers hear the result after the row, so its name still
        // starts with the question number. Correct uses the file panel's
        // done mark.
        (status === 'correct' ? (
          <Icon
            aria-hidden
            className="mt-0.5 text-tint-success-fg"
            name="circleCheck"
            size={16}
          />
        ) : (
          <span
            aria-hidden
            className={cn(
              'mt-0.5 grid size-4 place-items-center rounded-full text-surface',
              status === 'notDone' && 'border-[1.5px] border-line-strong',
              status === 'partial' && 'bg-tint-warning-fg',
              status === 'wrong' && 'bg-tint-error-fg'
            )}
            title={statusLabels[status]()}
          >
            {status !== 'notDone' && (
              <Icon name={statusIcons[status]} size={11} />
            )}
          </span>
        ))}
      <span className="font-bold">{row.position}.</span>
      <span className="line-clamp-2">
        {row.preview ? (
          <TextView text={row.preview} />
        ) : (
          m.question_ui_question_number({ number: row.position })
        )}
      </span>
      <span
        className={cn(
          'col-start-2 mt-0.5 flex items-center gap-2 text-fg-muted text-xs',
          marked && 'col-start-3'
        )}
      >
        {row.marks === 1
          ? m.question_ui_one_mark()
          : m.question_ui_marks({ count: row.marks })}
        {row.hasFigure && <Icon name="image" size={13} />}
        {row.hasTable && <Icon name="table" size={13} />}
        {meta}
        {marked && <span className="sr-only">{statusLabels[status]()}</span>}
      </span>
    </button>
  );
}

export const statusLabels: Record<BankStatus, () => string> = {
  correct: m.question_ui_status_correct,
  notDone: m.question_ui_status_not_done,
  partial: m.question_ui_status_partial,
  wrong: m.question_ui_status_wrong,
};
const statusIcons = { partial: 'minus', wrong: 'x' } as const;
