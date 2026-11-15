import { type CSSProperties, useId } from 'react';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { TextView } from './TextView';

/** How a cell reads: picked while answering, a correct cell in the editor,
 * and once checked a right pick, a wrong one or the correct cell missed. */
type CellState = 'picked' | 'correct' | 'right' | 'wrong' | 'missed';

function cellState(
  picked: boolean | undefined,
  correct: boolean | undefined
): CellState | undefined {
  // No picks: the editor's key.
  if (picked === undefined) return correct ? 'correct' : undefined;
  // No key: a member answering.
  if (correct === undefined) return picked ? 'picked' : undefined;
  if (picked) return correct ? 'right' : 'wrong';
  return correct ? 'missed' : undefined;
}

/** A cell's accessible name: "row: column", with what a checked answer or a
 * shown key says of it, so its state is not in its colour alone. */
function cellName(
  row: string,
  column: string,
  state: CellState | undefined,
  readOnly: boolean
) {
  switch (state) {
    case 'right':
      return m.question_ui_grid_cell_right({ column, row });
    case 'wrong':
      return m.question_ui_grid_cell_wrong({ column, row });
    case 'missed':
      return m.question_ui_grid_cell_answer({ column, row });
    case 'correct':
      if (readOnly) return m.question_ui_grid_cell_answer({ column, row });
  }
  return m.question_ui_grid_cell({ column, row });
}

/** The mark beside a checked cell: right or the missed answer ✓, wrong ×. */
const GLYPHS: Partial<Record<CellState, string>> = {
  missed: '✓',
  right: '✓',
  wrong: '×',
};

/**
 * A matching answer as a grid (Epo 2026-11-15, Google Forms' multiple choice
 * grid): rows down the side, columns across, one pick per row. Every row is a
 * native radio group, so arrow keys move its pick within the row, and each
 * cell's accessible name is "row: column".
 *
 * - The question editor passes `correct` and `onPick` (its key, set by a
 *   click): correct cells fill green.
 * - A member answering passes `value` and `onPick`: picks fill dark.
 * - A checked answer passes `value` and `correct` with no `onPick`: a right
 *   pick fills green, a wrong one red, a missed correct cell gets a green ring,
 *   each with a ✓ or × beside it and its state in its name.
 *
 * Without `onPick` it only reads: its cells stay focusable (aria-disabled,
 * not disabled), so a screen reader walks the grid. Rows are banded; on a
 * phone the grid scrolls sideways with the row names held at its left edge.
 */
export function MatchingGrid({
  className,
  columns,
  correct,
  label,
  onPick,
  rows,
  value,
}: {
  className?: string;
  /** The column heads (a matching answer's options). */
  columns: string[];
  /** Each row's correct column, when the key shows. */
  correct?: (number | undefined)[];
  /** The grid's accessible name, e.g. the question's. */
  label: string;
  onPick?: (row: number, column: number) => void;
  /** The row names (a matching answer's left items). */
  rows: string[];
  /** Each row's picked column, when picks show. */
  value?: (number | undefined)[];
}) {
  const id = useId();
  const readOnly = !onPick;
  return (
    <div
      aria-label={label}
      className={cn('overflow-x-auto', className)}
      role="group"
    >
      <div
        className="grid grid-cols-[minmax(6.875rem,9.375rem)_repeat(var(--columns),minmax(5.75rem,1fr))] items-center text-[13.5px]"
        style={{ '--columns': columns.length } as CSSProperties}
      >
        <div aria-hidden className="col-span-full grid grid-cols-subgrid">
          {/* Held over the row names as the grid scrolls. */}
          <span className="sticky left-0 z-1 self-stretch bg-surface" />
          {columns.map((column, i) => (
            <span
              className="px-1 pb-1.5 text-center font-semibold text-[12.5px] text-fg-secondary leading-snug"
              key={i}
            >
              <TextView text={column} />
            </span>
          ))}
        </div>
        {rows.map((row, r) => (
          <div
            aria-label={row}
            aria-readonly={readOnly || undefined}
            className={cn(
              'col-span-full grid min-h-11 grid-cols-subgrid items-center',
              r % 2 === 0 && 'bg-page'
            )}
            key={r}
            role="radiogroup"
          >
            <span
              className={cn(
                'sticky left-0 z-1 flex min-h-11 items-center self-stretch py-1.5 pl-2 max-sm:shadow-[4px_0_6px_-4px_rgb(0_0_0/0.15)]',
                r % 2 === 0 ? 'bg-page' : 'bg-surface'
              )}
            >
              <TextView className="min-w-0" text={row} />
            </span>
            {columns.map((column, c) => {
              const picked = value ? value[r] === c : undefined;
              const right = correct ? correct[r] === c : undefined;
              const state = cellState(picked, right);
              const glyph = state && GLYPHS[state];
              return (
                <span className="relative grid place-items-center" key={c}>
                  <input
                    aria-disabled={readOnly || undefined}
                    aria-label={cellName(row, column, state, readOnly)}
                    checked={picked ?? right ?? false}
                    className={cn(
                      'size-4.5 cursor-pointer appearance-none rounded-full border-2 border-line-strong bg-surface outline-none transition-colors focus-visible:ring-2 focus-visible:ring-action focus-visible:ring-offset-2 aria-disabled:cursor-default',
                      !(readOnly || state) && 'hover:border-fg-muted',
                      state &&
                        state !== 'missed' &&
                        'shadow-[inset_0_0_0_3px_var(--color-surface)]',
                      state === 'picked' && 'border-fg bg-fg',
                      (state === 'correct' || state === 'right') &&
                        'border-tint-success-fg bg-tint-success-fg',
                      state === 'wrong' &&
                        'border-tint-error-fg bg-tint-error-fg',
                      state === 'missed' && 'border-tint-success-fg'
                    )}
                    name={`${id}-${r}`}
                    onChange={() => onPick?.(r, c)}
                    // Read-only: a click or an arrow key leaves the pick.
                    onClick={(event) => readOnly && event.preventDefault()}
                    type="radio"
                  />
                  {glyph && (
                    <span
                      aria-hidden
                      className={cn(
                        'absolute left-[calc(50%+0.875rem)] font-bold text-[12px] leading-none',
                        state === 'wrong'
                          ? 'text-tint-error-fg'
                          : 'text-tint-success-fg'
                      )}
                    >
                      {glyph}
                    </span>
                  )}
                </span>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
