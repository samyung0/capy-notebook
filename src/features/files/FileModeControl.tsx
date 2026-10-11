import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useIsMounted } from 'usehooks-ts';
import { MaterialModeToggle } from '@/features/materials/MaterialModeToggle';
import {
  FileHeaderTarget,
  type FileMode,
  FileModeContext,
} from './fileModeContext';

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
}: {
  mode: 'view' | 'edit';
  canEdit: boolean;
  disabled?: boolean;
  onChange: (mode: FileMode) => void | Promise<boolean>;
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
  const controls = canEdit ? (
    <MaterialModeToggle
      disabled={disabled}
      mode={mode}
      onChange={(next) => {
        void onChange(next);
      }}
    />
  ) : null;
  return target ? createPortal(controls, target) : controls;
}
