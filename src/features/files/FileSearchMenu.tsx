import { type ReactNode, type RefObject, useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/Popover';
import { selectTriggerVariants } from '@/components/ui/Select';
import { PanelSearchField } from '@/features/workspace/PanelSearch';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';

/** A form's Choose a file (Make a quiz's question paper and answers, a task's
 * and an assignment's Files; Epo 2026-11-12): the field's select-like trigger,
 * full width, kept above the files chosen, whose menu ticks them. Props pass
 * through, for the menu's trigger and `disabled`. */
export function ChooseFileButton({
  className,
  ...props
}: React.ComponentProps<'button'>) {
  return (
    <button
      className={cn(
        selectTriggerVariants(),
        'w-full justify-between text-fg-muted',
        className
      )}
      type="button"
      {...props}
    >
      <span className="min-w-0 truncate">{m.file_choose()}</span>
      <Icon name="chevronDown" size={16} />
    </button>
  );
}

/** A chosen file row's ×: small and muted until hovered (Epo 2026-11-12). */
export function RemoveFileButton({
  className,
  ...props
}: Omit<React.ComponentProps<typeof IconButton>, 'icon'>) {
  return (
    <IconButton
      className={cn('size-7 text-fg-muted hover:text-fg', className)}
      icon="x"
      size="xs"
      type="button"
      variant="ghost-hover"
      {...props}
    />
  );
}

/** A menu of files with a search field on top (Make a quiz's X0a; a task's
 * and an assignment's Files, a task's Quiz, Epo 2026-11-12). The caller lists the rows for what is
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

/** A row of the menu. One already chosen ends in a tick (Epo 2026-11-12). */
export function FileMenuRow({
  children,
  className,
  selected,
  ...props
}: React.ComponentProps<'button'> & { selected?: boolean }) {
  return (
    <button
      aria-selected={selected}
      className={cn(
        'flex min-h-9 w-full shrink-0 cursor-pointer items-center gap-2.5 rounded-button px-2.5 text-left font-semibold outline-none hover:bg-surface-hover-bg focus-visible:bg-surface-hover-bg disabled:cursor-progress disabled:opacity-50',
        className
      )}
      type="button"
      {...props}
    >
      {children}
      {selected && <Icon className="shrink-0" name="check" size={16} />}
    </button>
  );
}

/** A line in the list instead of rows: nothing matches. */
export function FileMenuNote({ children }: { children: ReactNode }) {
  return <p className="t-meta px-2.5 py-2 text-fg-muted">{children}</p>;
}
