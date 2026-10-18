import { useState } from 'react';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';

/** The notes toolbar's table size picker, also the Office menus' Insert ›
 * Table picker: its own module, so an Office view loads no Plate. */
export function TablePicker({
  onInsert,
}: {
  onInsert: (rowCount: number, colCount: number) => void;
}) {
  const [size, setSize] = useState({ colCount: 3, rowCount: 3 });
  const dimension = 8;

  return (
    <div
      aria-label={m.editor_insert_table_size({
        cols: String(size.colCount),
        rows: String(size.rowCount),
      })}
      className="m-0 flex flex-col gap-1 p-1 outline-none"
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onInsert(size.rowCount, size.colCount);
          return;
        }

        const next = { ...size };
        if (event.key === 'ArrowUp')
          next.rowCount = Math.max(1, size.rowCount - 1);
        else if (event.key === 'ArrowDown')
          next.rowCount = Math.min(dimension, size.rowCount + 1);
        else if (event.key === 'ArrowLeft')
          next.colCount = Math.max(1, size.colCount - 1);
        else if (event.key === 'ArrowRight')
          next.colCount = Math.min(dimension, size.colCount + 1);
        else return;

        event.preventDefault();
        setSize(next);
      }}
      role="grid"
      tabIndex={0}
    >
      <div className="grid size-32 grid-cols-8 gap-0.5">
        {Array.from({ length: dimension * dimension }, (_, index) => {
          const row = Math.floor(index / dimension) + 1;
          const column = (index % dimension) + 1;
          const active = row <= size.rowCount && column <= size.colCount;

          return (
            <button
              aria-label={m.editor_insert_table_size({
                cols: String(column),
                rows: String(row),
              })}
              aria-selected={active}
              className={cn(
                'size-3.5 rounded-xs border border-line bg-surface outline-none',
                active && 'border-action-accent bg-tint-accent-1'
              )}
              key={`${row}:${column}`}
              onClick={() => onInsert(row, column)}
              onFocus={() => setSize({ colCount: column, rowCount: row })}
              onPointerEnter={() =>
                setSize({ colCount: column, rowCount: row })
              }
              role="gridcell"
              tabIndex={-1}
              type="button"
            />
          );
        })}
      </div>
      <div className="text-center text-fg-secondary text-xs">
        {size.rowCount} × {size.colCount}
      </div>
    </div>
  );
}
