import { useSyncExternalStore } from 'react';
import { PREF_KEYS, writePref } from '@/lib/localPrefs';

export const GETTING_STARTED_STEPS = ['upload', 'chat', 'plan'] as const;
export type GettingStartedStep = (typeof GETTING_STARTED_STEPS)[number];

/** The Get started list of the account that onboarded in this browser: the
 * steps done here and whether it was closed. Only the browser that saw the
 * onboarding dialog writes it, so other browsers never show the list. */
export type GettingStarted = {
  owner: string;
  done: GettingStartedStep[];
  hidden: boolean;
};

const isStep = (value: unknown): value is GettingStartedStep =>
  GETTING_STARTED_STEPS.includes(value as GettingStartedStep);

function parse(raw: string | null): GettingStarted | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return null;
    const { owner, done, hidden } = value as Record<string, unknown>;
    if (typeof owner !== 'string' || typeof hidden !== 'boolean') return null;
    if (!Array.isArray(done) || !done.every(isStep)) return null;
    return { done, hidden, owner };
  } catch {
    return null;
  }
}

// useSyncExternalStore needs the same object until the stored text changes.
let cached: { raw: string | null; value: GettingStarted | null } = {
  raw: null,
  value: null,
};

function read(): GettingStarted | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(PREF_KEYS.gettingStarted);
  } catch {
    // Blocked storage: no list.
  }
  if (raw !== cached.raw) cached = { raw, value: parse(raw) };
  return cached.value;
}

const listeners = new Set<() => void>();

function write(next: GettingStarted) {
  writePref(PREF_KEYS.gettingStarted, next);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  // Another tab ticking a step or closing the list.
  window.addEventListener('storage', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', listener);
  };
}

/** Called when this browser finishes or skips onboarding; keeps a list the
 * same account already has here. */
export function startGettingStarted(owner: string) {
  if (read()?.owner === owner) return;
  write({ done: [], hidden: false, owner });
}

export function markGettingStarted(step: GettingStartedStep) {
  const current = read();
  if (!current || current.done.includes(step)) return;
  write({ ...current, done: [...current.done, step] });
}

export function hideGettingStarted() {
  const current = read();
  if (current) write({ ...current, hidden: true });
}

/** The list to show the signed-in account: none once closed or every step is
 * done. */
export function useGettingStarted(
  owner: string | undefined
): GettingStarted | null {
  const value = useSyncExternalStore(subscribe, read, () => null);
  if (!value || !owner || value.owner !== owner || value.hidden) return null;
  if (value.done.length >= GETTING_STARTED_STEPS.length) return null;
  return value;
}
