import { useWorkspaces } from '@/api/hooks';
import { SettingRow } from '@/components/app/tabPanel';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';
import { FIELD_WIDTH } from '@/features/workspace/TopicSelect';
import { useStorageStatus } from '@/features/workspace/WorkspaceHealth';
import { m } from '@/i18n';
import { iconUrl } from '@/lib/icon-catalog';

/** The Select's value for No workspace. */
const NONE = 'none';

/** Where the Files page's Add file puts what it adds, a field above the Add
 * file dialog's footer (Epo 2026-11-12; a dialog of its own before): No
 * workspace first, then the workspaces the caller edits, most recently opened
 * first (P3, 2026-10-27). null is No workspace. What is added is charged to
 * the caller, so a frozen or full account is told why it can't add. */
export function AddFileDestination({
  onChange,
  value,
}: {
  onChange: (workspaceId: string | null) => void;
  value: string | null;
}) {
  const { data: workspaces } = useWorkspaces(
    { sort: 'accessed' },
    { errorBoundary: false }
  );
  const editable = (workspaces ?? []).filter((ws) => ws.capabilities.canEdit);
  const status = useStorageStatus();
  const blocked = status?.kind === 'frozen-self' || status?.kind === 'full';
  return (
    <SettingRow
      hint={
        blocked && (
          <span className="text-tint-error-fg" role="note">
            {status.short}
          </span>
        )
      }
      title={m.files_add_to()}
    >
      <Select
        onValueChange={(id) => {
          // The form's hidden native select reports '' while options load.
          if (!id) return;
          onChange(id === NONE ? null : id);
        }}
        value={value ?? NONE}
      >
        <SelectTrigger aria-label={m.files_add_to()} className={FIELD_WIDTH}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem
            iconAndValue={{ icon: 'filesNav', label: m.clone_no_workspace() }}
            value={NONE}
          />
          {editable.map((ws) => (
            <SelectItem key={ws.id} value={ws.id}>
              <span className="flex min-w-0 items-center gap-2">
                <img
                  alt=""
                  className="size-4.5 shrink-0 -translate-y-px rounded-[4px]"
                  src={iconUrl(ws.iconId)}
                />
                <span className="truncate">{ws.name}</span>
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </SettingRow>
  );
}
