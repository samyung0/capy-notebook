import type { MouseEvent, ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import type { IconName } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { m } from '@/i18n';

/** Stands in for a list's toolbar while anything is selected: clear, the
 * count, Select all, then the page's actions (`SelectionAction`). Labels give
 * way to icons on phones. */
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
    <div className="-mx-1.5 flex min-h-10 w-full items-center gap-1 sm:min-h-11.5">
      <IconButton
        className="p-1.5"
        disabled={busy}
        icon="x"
        label={m.files_clear_selection()}
        onClick={onClear}
        size="sm"
        variant="ghost-hover"
      />
      <span
        aria-live="polite"
        className="mr-1 whitespace-nowrap font-semibold text-sm"
      >
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
      className="px-1.5"
      disabled={disabled}
      iconLeft={icon}
      onClick={onClick}
      size="sm"
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
