import { create } from 'zustand';
import { readPref, writePref } from '@/lib/localPrefs';

/** A store kept in this browser, so a reload finds it, with the account it belongs to.
 * `claim` runs when the signed-in account is known: another account's state goes. */
export function savedForAccount<S extends object>(
  key: string,
  empty: S,
  isState: (value: unknown) => value is S
) {
  const stored = readPref(
    key,
    { owner: null, state: empty },
    (value): value is { owner: string | null; state: S } => {
      if (typeof value !== 'object' || value === null) return false;
      const { owner, state } = value as { owner?: unknown; state?: unknown };
      return (owner === null || typeof owner === 'string') && isState(state);
    }
  );
  let owner = stored.owner;
  const store = create<S>(() => stored.state);
  store.subscribe((state) => writePref(key, { owner, state }));
  return {
    claim(next: string | null) {
      if (owner === next) return;
      owner = next;
      store.setState(empty, true);
    },
    store,
  };
}
