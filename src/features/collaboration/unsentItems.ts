import { useBlocker } from '@tanstack/react-router';
import { useSyncExternalStore } from 'react';
import { m } from '@/i18n';

/* Live item rooms holding edits the server has not acknowledged (or, offline,
 * not stored): leaving the tab or the page asks first (REVIEW1 S1, with the
 * offline drafts of Epo 2026-10-04). Kept apart from the rooms so the app
 * shell's guard loads no Yjs. */

const unsent = new Set<object>();
const listeners = new Set<() => void>();

function warnOnClose(event: BeforeUnloadEvent) {
  event.preventDefault();
  event.returnValue = '';
}

export function markUnsent(room: object, value: boolean) {
  const had = unsent.size > 0;
  if (value) unsent.add(room);
  else unsent.delete(room);
  const has = unsent.size > 0;
  if (had === has) return;
  if (typeof window !== 'undefined') {
    if (has) window.addEventListener('beforeunload', warnOnClose);
    else window.removeEventListener('beforeunload', warnOnClose);
  }
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** In the app shell: an in-app navigation away from unsent item edits asks
 * first (the tab's own close asks through `beforeunload`). */
export function ItemLeaveGuard() {
  const dirty = useSyncExternalStore(subscribe, () => unsent.size > 0);
  useBlocker({
    disabled: !dirty,
    shouldBlockFn: () => !window.confirm(m.item_leave_unsent()),
  });
  return null;
}
