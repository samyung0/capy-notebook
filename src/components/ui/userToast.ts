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

/** What shows: an open error at the bottom, the other toast just above it. */
export type ShownToasts = {
  error: QueuedToast | null;
  other: QueuedToast | null;
};

type Lane = { shown: QueuedToast | null; queue: QueuedToast[] };
type LaneName = keyof ShownToasts;

/* One toast at a time in each lane (S1 and E2, Epo 2026-11-03): an error
   stays at the bottom until closed while other toasts show above it, so it
   never holds them up. In a lane a different toast waits until the shown one
   closes, and the same toast again counts up instead of queueing. */
const lanes: Record<LaneName, Lane> = {
  error: { queue: [], shown: null },
  other: { queue: [], shown: null },
};
let snapshot: ShownToasts = { error: null, other: null };
let revision = 0;
let nextId = 0;
const listeners = new Set<() => void>();

function emit() {
  snapshot = { error: lanes.error.shown, other: lanes.other.shown };
  for (const listener of listeners) listener();
}

const laneOf = (toast: Pick<ToastOptions, 'variant'>): LaneName =>
  toast.variant === 'error' ? 'error' : 'other';

const sameToast = (a: Omit<ToastOptions, 'id'>, b: Omit<ToastOptions, 'id'>) =>
  (a.variant ?? 'default') === (b.variant ?? 'default') &&
  a.title === b.title &&
  a.description === b.description &&
  a.button?.label === b.button?.label;

function add(lane: Lane, toast: QueuedToast) {
  if (lane.shown) lane.queue = [...lane.queue, toast];
  else lane.shown = toast;
}

/** Takes a toast out of its lane at once; the next one shows. */
function remove(lane: Lane, toast: QueuedToast) {
  if (lane.shown === toast) {
    lane.shown = lane.queue[0] ?? null;
    lane.queue = lane.queue.slice(1);
  } else lane.queue = lane.queue.filter((item) => item !== toast);
}

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
  const to = lanes[laneOf(options)];
  for (const lane of Object.values(lanes)) {
    const match = [lane.shown, ...lane.queue].find(
      (toast) =>
        toast !== null &&
        (id === undefined ? sameToast(toast, options) : toast.id === id)
    );
    if (!match) continue;
    const next: QueuedToast = {
      ...options,
      closing: false,
      count: sameToast(match, options) ? match.count + 1 : 1,
      id: match.id,
      revision,
    };
    if (lane === to) {
      if (match === lane.shown) lane.shown = next;
      else
        lane.queue = lane.queue.map((toast) =>
          toast === match ? next : toast
        );
    } else {
      // A working toast that failed moves down to the errors, and back.
      remove(lane, match);
      add(to, next);
    }
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
  add(to, toast);
  emit();
  return toast.id;
}

/** Closes a toast (a shown one fades out first), or every toast. */
export function dismissToast(id?: ToastId) {
  for (const lane of Object.values(lanes)) {
    if (id === undefined) lane.queue = [];
    else lane.queue = lane.queue.filter((toast) => toast.id !== id);
    const { shown } = lane;
    if (shown && (id === undefined || shown.id === id) && !shown.closing)
      lane.shown = { ...shown, closing: true };
  }
  emit();
}

/** A shown toast finished fading out: the next one in its lane shows. */
export function finishToast(id: ToastId) {
  for (const lane of Object.values(lanes))
    if (lane.shown?.closing && lane.shown.id === id) remove(lane, lane.shown);
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The toasts on screen. */
export const shownToasts = () => snapshot;

const NONE: ShownToasts = { error: null, other: null };

export const useShownToasts = () =>
  useSyncExternalStore(subscribe, shownToasts, () => NONE);

/** How long a toast stays: errors and working toasts until closed or
 * updated; warnings twelve seconds; others seven with a button, else four. */
export function toastDuration(toast: Pick<ToastOptions, 'button' | 'variant'>) {
  if (toast.variant === 'error' || toast.variant === 'loading') return null;
  if (toast.variant === 'warning') return 12_000;
  return toast.button ? 7000 : 4000;
}
