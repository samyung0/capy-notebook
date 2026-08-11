import { createPortal } from 'react-dom';
import { Toaster } from 'sonner';

/** Sonner renders inline instead of portalling, so mounting it anywhere inside
 * `#root` (which is `isolation: isolate`) traps toasts in a stacking context
 * that paints below the dialog/drawer portals attached to <body>. Portalling to
 * <body> puts the toaster in the same stacking context as those overlays, where
 * its z-index wins. */
// this fixes the issue where toaster is getting painted behind the dialogs and drawers
export function AppToaster() {
  return createPortal(<Toaster />, document.body);
}
