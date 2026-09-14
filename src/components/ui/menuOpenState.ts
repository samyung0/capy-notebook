import { createContext, type KeyboardEvent, useState } from 'react';

export const MenuOpenContext = createContext(false);

/** Radix's synchronous reopen focus can run before React clears inert. */
export function focusReopenedSubmenu(event: KeyboardEvent<HTMLElement>) {
  if (
    event.defaultPrevented ||
    event.target !== event.currentTarget ||
    !['ArrowLeft', 'ArrowRight', 'Enter', ' '].includes(event.key)
  )
    return;
  const trigger = event.currentTarget;
  if (trigger.dataset.state !== 'closed') return;
  requestAnimationFrame(() => {
    if (trigger.ownerDocument.activeElement !== trigger) return;
    const contentId = trigger.getAttribute('aria-controls');
    const content =
      contentId && trigger.ownerDocument.getElementById(contentId);
    if (content && content.dataset.state === 'open' && !content.inert) {
      content.focus();
    }
  });
}

/** Mirror the primitive's open state so retained exits become inert immediately. */
export function useMenuOpenState({
  open,
  defaultOpen = false,
  onOpenChange,
}: {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [uncontrolledOpen, setOpen] = useState(defaultOpen);
  return [
    open ?? uncontrolledOpen,
    (next: boolean) => {
      setOpen(next);
      onOpenChange?.(next);
    },
  ] as const;
}
