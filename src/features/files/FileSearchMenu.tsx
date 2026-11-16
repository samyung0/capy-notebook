import { type ReactNode, type RefObject, useRef, useState } from 'react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/Popover';
import { PanelSearchField } from '@/features/workspace/PanelSearch';
import { cn } from '@/lib/cn';

/** A menu of files with a search field on top (Make a quiz's X0a; a task's
 * Files and Quiz, Epo 2026-11-12). The caller lists the rows for what is
 * typed, so a list may filter what it holds or ask the server; `list` is the
 * box that scrolls, for a list that loads more at its end. The search clears
 * as the menu closes. */
export function FileSearchMenu({
  children,
  label,
  onOpenChange,
  open,
  searchLabel,
  top,
  trigger,
  wide,
}: {
  children: (
    query: string,
    list: RefObject<HTMLDivElement | null>
  ) => ReactNode;
  /** The list's name. */
  label: string;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  /** The search field's label and placeholder. */
  searchLabel: string;
  /** Rows between the search and the list (Upload a file). */
  top?: ReactNode;
  trigger: ReactNode;
  /** Under a small button: as wide as the dialog's fields, not the button. */
  wide?: boolean;
}) {
  const [query, setQuery] = useState('');
  const list = useRef<HTMLDivElement>(null);
  return (
    <Popover
      onOpenChange={(next) => {
        if (!next) setQuery('');
        onOpenChange(next);
      }}
      open={open}
    >
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        align="start"
        alignWidthToTrigger={!wide}
        className={cn(
          'max-h-[min(420px,var(--radix-popover-content-available-height))] gap-0 overflow-hidden p-1.5',
          wide && 'w-[550px] max-w-[calc(100vw-2rem)]'
        )}
        collisionPadding={8}
      >
        <div className="mb-1 shrink-0">
          <PanelSearchField
            label={searchLabel}
            onChange={setQuery}
            value={query}
          />
        </div>
        {top}
        <div
          aria-label={label}
          className="min-h-0 overflow-y-auto"
          ref={list}
          role="listbox"
        >
          {children(query, list)}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** A row of the menu. */
export function FileMenuRow({
  className,
  ...props
}: React.ComponentProps<'button'>) {
  return (
    <button
      className={cn(
        'flex min-h-9 w-full shrink-0 cursor-pointer items-center gap-2.5 rounded-button px-2.5 text-left font-semibold outline-none hover:bg-surface-hover-bg focus-visible:bg-surface-hover-bg disabled:cursor-progress disabled:opacity-50',
        className
      )}
      type="button"
      {...props}
    />
  );
}

/** A line in the list instead of rows: nothing matches. */
export function FileMenuNote({ children }: { children: ReactNode }) {
  return <p className="t-meta px-2.5 py-2 text-fg-muted">{children}</p>;
}
