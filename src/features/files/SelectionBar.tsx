import type { MouseEvent, ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import type { IconName } from '@/components/ui/Icon';
import { m } from '@/i18n';

/** Stands in for a list's toolbar while anything is selected: clear with the
 * count on it, Select all, then the page's actions (`SelectionAction`), all
 * at Add file's size (Epo 2026-11-12). Action labels give way to icons on
 * phones; the count stays. */
export function SelectionBar({
  allSelected,
  busy,
  children,
  count,
  onClear,
  onSelectAll,
}: {
  allSelected: boolean;
  busy: boolean;
  children: ReactNode;
  count: number;
  onClear: () => void;
  onSelectAll: () => void;
}) {
  return (
    <div className="-mx-2.5 flex min-h-10 w-full items-center gap-1 sm:min-h-11.5">
      <Button
        aria-label={m.files_clear_selection()}
        className="px-2.5"
        disabled={busy}
        iconLeft="x"
        onClick={onClear}
        variant="ghost-hover"
      >
        <span aria-hidden className="whitespace-nowrap">
          {m.files_selected_count({ count })}
        </span>
      </Button>
      <span aria-live="polite" className="sr-only">
        {m.files_selected_count({ count })}
      </span>
      {!allSelected && (
        <SelectionAction
          disabled={busy}
          icon="check"
          label={m.files_select_all()}
          onClick={onSelectAll}
        />
      )}
      <div className="ml-auto flex items-center gap-1">{children}</div>
    </div>
  );
}

export function SelectionAction({
  danger = false,
  disabled,
  icon,
  label,
  onClick,
}: {
  danger?: boolean;
  disabled?: boolean;
  icon: IconName;
  label: string;
  onClick: () => void;
}) {
  return (
    <Button
      aria-label={label}
      className="px-2.5"
      disabled={disabled}
      iconLeft={icon}
      onClick={onClick}
      variant={danger ? 'danger-light' : 'ghost-hover'}
    >
      <span className="hidden sm:inline">{label}</span>
    </Button>
  );
}

/** A click on the list outside any item clears the selection, as in Drive. */
export function clearOnBlank(clear: () => void) {
  return (event: MouseEvent) => {
    if (!(event.target as Element).closest('[data-item]')) clear();
  };
}
