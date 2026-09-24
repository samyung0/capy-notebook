import { isValidElement } from 'react';
import { createPortal } from 'react-dom';
import { Toaster, useSonner } from 'sonner';
import type { ToastProps } from '../ui/Sonner';

/** Sonner renders inline instead of portalling, so mounting it anywhere inside
 * `#root` (which is `isolation: isolate`) traps toasts in a stacking context
 * that paints below the dialog/drawer portals attached to <body>. Portalling to
 * <body> puts the toaster in the same stacking context as those overlays, where
 * its z-index wins. */
// this fixes the issue where toaster is getting painted behind the dialogs and drawers
export function AppToaster() {
  const { toasts } = useSonner();
  const hasError = toasts.some(
    ({ jsx }) =>
      isValidElement<ToastProps>(jsx) && jsx.props.variant === 'error'
  );
  return createPortal(
    <Toaster
      expand={hasError}
      position="bottom-right"
      visibleToasts={hasError ? Number.POSITIVE_INFINITY : 3}
    />,
    document.body
  );
}
