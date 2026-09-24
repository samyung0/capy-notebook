import { Toggle } from 'radix-ui';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useIsMounted } from 'usehooks-ts';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { ToolbarButton } from '@/components/ui/ToolbarButton';
import { m } from '@/i18n';

// File runtimes retain their save lifecycle while controls render in the header.
export const FileHeaderTarget = createContext<HTMLElement | null>(null);

type FileMode = 'view' | 'edit';

export const FileModeContext = createContext<{
  mode: FileMode;
  onChange: (mode: FileMode) => void;
} | null>(null);

/** Keep each runtime's save lifecycle; commit the URL only when it accepts a mode. */
export function useFileMode(canEdit: boolean, initialMode: FileMode) {
  const context = useContext(FileModeContext);
  const [mode, setMode] = useState<FileMode>(
    canEdit ? (context?.mode ?? initialMode) : 'view'
  );
  const mounted = useRef(false);
  // Visible controls can be clicked before passive effects run.
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const commitMode = useCallback(
    (next: FileMode) => {
      if (!mounted.current) return;
      setMode(next);
      context?.onChange(next);
    },
    [context]
  );
  return [mode, commitMode] as const;
}

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
  onChange: (mode: FileMode) => void | Promise<boolean>;
  status?: string;
  onSave?: () => void;
  saveDisabled?: boolean;
}) {
  const target = useContext(FileHeaderTarget);
  const context = useContext(FileModeContext);
  const isMounted = useIsMounted();
  const requested = useRef<FileMode | undefined>(undefined);
  useEffect(() => {
    if (!context || !canEdit || disabled || requested.current === context.mode)
      return;
    requested.current = context.mode;
    if (context.mode === mode) return;
    void Promise.resolve(onChange(context.mode)).then((accepted) => {
      if (isMounted() && accepted === false) context.onChange(mode);
    });
  }, [context, canEdit, disabled, mode, onChange, isMounted]);
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
        <Toggle.Root
          asChild
          disabled={disabled}
          onPressedChange={(pressed) => {
            void onChange(pressed ? 'edit' : 'view');
          }}
          pressed={mode === 'edit'}
        >
          <ToolbarButton
            aria-label={m.material_mode()}
            disabled={disabled}
            label={
              mode === 'edit' ? m.material_mode_edit() : m.material_mode_view()
            }
          >
            <Icon name={mode === 'edit' ? 'pencil' : 'view'} />
          </ToolbarButton>
        </Toggle.Root>
      )}
    </div>
  );
  return target ? createPortal(controls, target) : controls;
}
