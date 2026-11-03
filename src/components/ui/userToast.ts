import { useSyncExternalStore } from 'react';
import type { ToastOptions } from './Toast';

export type ToastId = string | number;

/** The toast on screen or waiting its turn. `count` is how many times the
 * same toast fired; `revision` changes on every fire, so its timer restarts. */
export type QueuedToast = Omit<ToastOptions, 'id'> & {
  id: ToastId;
  count: number;
  revision: number;
  /** Fading out; the next toast shows once it is gone (`finishToast`). */
  closing: boolean;
};

/* One toast at a time (S1, Epo 2026-11-03): a different toast waits until the
   shown one closes, and the same toast again counts up instead of queueing. */
let shown: QueuedToast | null = null;
let queue: QueuedToast[] = [];
let revision = 0;
let nextId = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

const sameToast = (a: Omit<ToastOptions, 'id'>, b: Omit<ToastOptions, 'id'>) =>
  (a.variant ?? 'default') === (b.variant ?? 'default') &&
  a.title === b.title &&
  a.description === b.description &&
  a.button?.label === b.button?.label;

/**
 * Shows a toast and returns its id. A toast with the id of one shown or
 * waiting (or, without an id, with the same copy) updates it in place: the
 * same copy counts up (×2, ×3), new copy replaces it (a working toast turning
 * into its done toast). Either way its timer restarts.
 */
export function userToast({
  id,
  ...options
}: Omit<ToastOptions, 'id'> & { id?: ToastId }): ToastId {
  revision += 1;
  const match = [shown, ...queue].find(
    (toast) =>
      toast !== null &&
      (id === undefined ? sameToast(toast, options) : toast.id === id)
  );
  if (match) {
    const next: QueuedToast = {
      ...options,
      closing: false,
      count: sameToast(match, options) ? match.count + 1 : 1,
      id: match.id,
      revision,
    };
    if (match === shown) shown = next;
    else queue = queue.map((toast) => (toast === match ? next : toast));
    emit();
    return next.id;
  }
  nextId += 1;
  const toast: QueuedToast = {
    ...options,
    closing: false,
    count: 1,
    id: id ?? `toast-${nextId}`,
    revision,
  };
  if (shown) queue = [...queue, toast];
  else shown = toast;
  emit();
  return toast.id;
}

/** Closes a toast (the shown one fades out first), or every toast. */
export function dismissToast(id?: ToastId) {
  if (id === undefined) queue = [];
  else queue = queue.filter((toast) => toast.id !== id);
  if (shown && (id === undefined || shown.id === id) && !shown.closing)
    shown = { ...shown, closing: true };
  emit();
}

/** The shown toast finished fading out: the next one takes its place. */
export function finishToast(id: ToastId) {
  if (!shown?.closing || shown.id !== id) return;
  shown = queue[0] ?? null;
  queue = queue.slice(1);
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The toast on screen, if any. */
export const shownToast = () => shown;

export const useShownToast = () =>
  useSyncExternalStore(subscribe, shownToast, () => null);

/** How long a toast stays: errors and working toasts until closed or
 * updated; warnings twelve seconds; others seven with a button, else four. */
export function toastDuration(toast: Pick<ToastOptions, 'button' | 'variant'>) {
  if (toast.variant === 'error' || toast.variant === 'loading') return null;
  if (toast.variant === 'warning') return 12_000;
  return toast.button ? 7000 : 4000;
}
