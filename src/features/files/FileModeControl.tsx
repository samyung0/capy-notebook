import { createContext, useContext } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/Button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';
import { m } from '@/i18n';

// File runtimes retain their own save/mode lifecycle; only their controls move.
export const FileHeaderTarget = createContext<HTMLElement | null>(null);

export function FileModeControl({
  mode,
  canEdit,
  disabled,
  onChange,
  status,
  onSave,
  saveDisabled,
}: {
  mode: 'view' | 'edit';
  canEdit: boolean;
  disabled?: boolean;
  onChange: (mode: 'view' | 'edit') => void;
  status?: string;
  onSave?: () => void;
  saveDisabled?: boolean;
}) {
  const target = useContext(FileHeaderTarget);
  const controls = (
    <div className="flex items-center gap-2">
      {status && (
        <span className="t-meta text-fg-muted" role="status">
          {status}
        </span>
      )}
      {mode === 'edit' && onSave && (
        <Button
          disabled={saveDisabled}
          onClick={onSave}
          size="sm"
          variant="ghost-hover"
        >
          {m.action_save()}
        </Button>
      )}
      {canEdit && (
        <Select
          disabled={disabled}
          onValueChange={(value) => onChange(value as 'view' | 'edit')}
          value={mode}
        >
          <SelectTrigger
            aria-label={m.material_mode()}
            className="px-1.5 py-2"
            variant="ghost-hover"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem
              iconAndValue={{ icon: 'view', label: m.material_mode_view() }}
              value="view"
            >
              {m.material_mode_view()}
            </SelectItem>
            <SelectItem
              iconAndValue={{ icon: 'pencil', label: m.material_mode_edit() }}
              value="edit"
            >
              {m.material_mode_edit()}
            </SelectItem>
          </SelectContent>
        </Select>
      )}
    </div>
  );
  return target ? createPortal(controls, target) : controls;
}
