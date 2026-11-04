import type { WorkspaceKind } from '@/api/types';
import { InputTitle } from '@/components/ui/Input';
import { TwoWaySwitch } from '@/components/ui/TwoWaySwitch';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';

/** "Used for" (Epo 2026-11-04, board U3, C1): a two-way switch with one line
 * that follows the choice, and `note` under that. Laid out as a settings row
 * from sm, the switch at the right; stacked on phones, the line under it. */
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
    <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-x-6 sm:gap-y-1">
      <InputTitle>{m.workspace_kind_label()}</InputTitle>
      <TwoWaySwitch
        className={cn(
          'sm:col-start-2 sm:row-start-1',
          note ? 'sm:row-span-3' : 'sm:row-span-2'
        )}
        disabled={disabled}
        label={m.workspace_kind_label()}
        onChange={onChange}
        options={[
          { label: m.workspace_kind_personal(), value: 'personal' },
          { label: m.workspace_kind_class(), value: 'class' },
        ]}
        value={value}
      />
      <p className="t-meta text-fg-muted sm:col-start-1">
        {value === 'class'
          ? m.workspace_kind_class_line()
          : m.workspace_kind_personal_line()}
      </p>
      {note && <p className="t-meta text-fg-muted sm:col-start-1">{note}</p>}
    </div>
  );
}
