import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';

/** Decorative marker; the enclosing button exposes the selection state. */
export function FileSelectionMark({ selected }: { selected: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'flex size-4 shrink-0 items-center justify-center rounded border',
        selected
          ? 'border-accent bg-action-accent text-action-accent-fg'
          : 'border-line-strong'
      )}
    >
      {selected && <Icon name="check" size={12} />}
    </span>
  );
}

export function FileSelectionActions({
  allSelected,
  count,
  busy,
  onSelectAll,
  onClear,
  onRestore,
}: {
  allSelected: boolean;
  count: number;
  busy: boolean;
  onSelectAll: () => void;
  onClear: () => void;
  onRestore?: () => void;
}) {
  return (
    <div className="flex h-11.5 flex-wrap items-center gap-2">
      <div aria-live="polite" className="w-26 truncate text-fg-muted text-sm">
        {m.files_selected_count({ count })}
      </div>
      <Button
        className="px-1"
        disabled={busy}
        iconLeft={allSelected ? 'x' : 'check'}
        onClick={allSelected ? onClear : onSelectAll}
        size="sm"
        variant="ghost-hover"
      >
        {allSelected ? m.files_clear_selection() : m.files_select_all()}
      </Button>
      {onRestore && (
        <Button
          className="px-1"
          disabled={busy || count === 0}
          iconLeft="undo"
          onClick={onRestore}
          size="sm"
          variant="ghost-hover"
        >
          {m.trash_restore()}
        </Button>
      )}
    </div>
  );
}
