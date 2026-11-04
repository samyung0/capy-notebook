import type { WorkspaceKind } from '@/api/types';
import { InputTitle } from '@/components/ui/Input';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';

const KINDS: {
  label: () => string;
  line: () => string;
  value: WorkspaceKind;
}[] = [
  {
    label: m.workspace_kind_personal,
    line: m.workspace_kind_personal_line,
    value: 'personal',
  },
  {
    label: m.workspace_kind_class,
    line: m.workspace_kind_class_line,
    value: 'class',
  },
];

/** "Used for" (Epo 2026-11-04, board U3, C1): a two-way switch with one line
 * under it that follows the choice. `note` adds a line under that. */
export function WorkspaceKindField({
  disabled,
  note,
  onChange,
  value,
}: {
  disabled?: boolean;
  note?: string;
  onChange: (kind: WorkspaceKind) => void;
  value: WorkspaceKind;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <InputTitle>{m.workspace_kind_label()}</InputTitle>
      <div
        aria-label={m.workspace_kind_label()}
        className="grid grid-cols-2 overflow-hidden rounded-input border border-line"
        role="group"
      >
        {KINDS.map((kind) => (
          <button
            aria-pressed={value === kind.value}
            className={cn(
              'h-(--control-h) not-first:border-line not-first:border-l font-semibold outline-none focus-visible:ring-2 focus-visible:ring-action focus-visible:ring-inset disabled:cursor-default',
              value === kind.value
                ? 'bg-action text-action-fg'
                : 'text-fg-secondary hover:bg-surface-hover-bg'
            )}
            disabled={disabled}
            key={kind.value}
            onClick={() => onChange(kind.value)}
            type="button"
          >
            {kind.label()}
          </button>
        ))}
      </div>
      <p className="t-meta text-fg-muted">
        {KINDS.find((kind) => kind.value === value)?.line()}
      </p>
      {note && <p className="t-meta text-fg-muted">{note}</p>}
    </div>
  );
}
