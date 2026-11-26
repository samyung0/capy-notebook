import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useMediaQuery } from 'usehooks-ts';

/** A Files tab's toolbar action (Add file, Empty trash, Delete all): in the
 * page header on phones, so the toolbar keeps one row, else at the toolbar's
 * right edge. Render `portal`; pass `toolbarAction` to the toolbar. */
export function useHeaderAction(
  slot: HTMLElement | null | undefined,
  action: ReactNode
) {
  const phone = !useMediaQuery('(min-width: 640px)');
  const inHeader = phone && !!slot;
  return {
    portal: inHeader && slot ? createPortal(action, slot) : null,
    toolbarAction: inHeader ? undefined : action,
  };
}
