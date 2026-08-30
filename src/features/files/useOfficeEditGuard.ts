import { useBlocker } from '@tanstack/react-router';
import { useCallback, useRef } from 'react';
import { m } from '@/i18n';

export function confirmOfficeEditDiscard(
  dirty: boolean,
  confirm: (message: string) => boolean = (message) => window.confirm(message)
) {
  return !dirty || confirm(m.files_office_discard_changes());
}

/** Guards both router navigation and local state changes that replace a viewer. */
export function useOfficeEditGuard(dirty: boolean) {
  const approvedRef = useRef(false);

  const confirmViewerReplacement = useCallback(() => {
    if (!dirty || approvedRef.current) return true;
    if (!confirmOfficeEditDiscard(true)) return false;
    approvedRef.current = true;
    window.setTimeout(() => {
      approvedRef.current = false;
    }, 0);
    return true;
  }, [dirty]);

  useBlocker({
    disabled: !dirty,
    enableBeforeUnload: true,
    shouldBlockFn: () => {
      if (approvedRef.current) {
        approvedRef.current = false;
        return false;
      }
      return !confirmOfficeEditDiscard(true);
    },
  });

  return confirmViewerReplacement;
}
