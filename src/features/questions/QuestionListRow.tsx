import type { ReactNode } from 'react';
import { checkboxVariants } from '@/components/ui/Checkbox';
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
 * `selected` turns the row into a checkbox whose box takes the result's place.
 */
export function QuestionListRow({
  row,
  current,
  result,
  meta,
  selected,
  onClick,
}: {
  row: Pick<
    BankRow,
    'position' | 'preview' | 'marks' | 'hasFigure' | 'hasTable'
  >;
  current: boolean;
  result?: number | null;
  meta?: ReactNode;
  selected?: boolean;
  onClick: () => void;
}) {
  const picking = selected !== undefined;
  const marked = result !== undefined;
  const status = bankStatus(result ?? undefined);
  return (
    <button
      aria-checked={selected}
      aria-current={current ? 'true' : undefined}
      className={cn(
        'grid w-full grid-cols-[1.5rem_minmax(0,1fr)] rounded-button py-2 pr-1 pl-2 text-left text-sm hover:bg-surface-hover-bg',
        // The result circle or checkbox sits 2px left of the panel's icons.
        (marked || picking) &&
          'grid-cols-[1.75rem_1.5rem_minmax(0,1fr)] pl-3.5',
        current && 'bg-surface-hover-bg'
      )}
      data-result={marked ? status : undefined}
      onClick={onClick}
      role={picking ? 'checkbox' : undefined}
      type="button"
    >
      {picking && (
        <span
          aria-hidden
          className={cn(
            checkboxVariants({ checked: selected }),
            'mt-0.5 size-4'
          )}
        >
          {selected && <Icon name="check" size={11.5} strokeWidth={2.4} />}
        </span>
      )}
      {marked &&
        !picking &&
        // Screen readers hear the result after the row, so its name still
        // starts with the question number. Correct is the file panel's done
        // mark; wrong and partly right use the same hollow circle.
        (status === 'notDone' ? (
          <span
            aria-hidden
            className="mt-0.5 size-4 rounded-full border-[1.5px] border-line-strong"
          />
        ) : (
          <Icon
            aria-hidden
            className={cn('mt-0.5', statusTones[status])}
            name={statusIcons[status]}
            size={16}
          />
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
          (marked || picking) && 'col-start-3'
        )}
      >
        {row.marks === 1
          ? m.question_ui_one_mark()
          : m.question_ui_marks({ count: row.marks })}
        {row.hasFigure && <Icon name="image" size={13} />}
        {row.hasTable && <Icon name="table" size={13} />}
        {meta}
        {marked && !picking && (
          <span className="sr-only">{statusLabels[status]()}</span>
        )}
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
const statusIcons = {
  correct: 'circleCheck',
  partial: 'circleMinus',
  wrong: 'circleX',
} as const;
const statusTones = {
  correct: 'text-tint-success-fg',
  partial: 'text-tint-warning-fg',
  wrong: 'text-tint-error-fg',
};
