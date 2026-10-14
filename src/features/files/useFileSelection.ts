import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { userToast } from '@/components/ui/userToast';
import { m } from '@/i18n';

type Page<T> = { items: T[]; nextCursor?: string };

/** Finish pagination before selecting or confirming deletion of all items. */
export async function collectSelectionPages<T>(
  pages: Page<T>[],
  fetchNext: () => Promise<{ data?: { pages: Page<T>[] } }>
): Promise<T[]> {
  let loaded = pages;
  while (loaded.at(-1)?.nextCursor) {
    const result = await fetchNext();
    if (
      !result.data ||
      result.data.pages.at(-1)?.nextCursor === loaded.at(-1)?.nextCursor
    ) {
      throw new Error('Selection page unavailable');
    }
    loaded = result.data.pages;
  }
  return loaded.flatMap((page) => page.items);
}

/** How a click picks: `only` (click) selects just this item, `toggle`
 * (Cmd/Ctrl-click, long-press, taps while selecting) adds or removes it,
 * `range` (Shift-click) selects from the last picked item to this one. */
export type SelectMode = 'only' | 'toggle' | 'range';

/** The selected keys after picking `key` in `order` (the list as shown). */
export function pickKeys(
  current: string[],
  order: string[],
  key: string,
  mode: SelectMode,
  anchor: string | null
): string[] {
  if (mode === 'only') return [key];
  if (mode === 'toggle')
    return current.includes(key)
      ? current.filter((value) => value !== key)
      : [...current, key];
  const from = anchor ? order.indexOf(anchor) : -1;
  const to = order.indexOf(key);
  if (from < 0 || to < 0) return [key];
  const span = order.slice(Math.min(from, to), Math.max(from, to) + 1);
  return [...current.filter((value) => !span.includes(value)), ...span];
}

/** What every pickable item's overlay reads (ItemPick in ItemCard.tsx). */
export interface PickContext {
  /** Anything is selected: a touch tap then adds or removes. */
  active: boolean;
  busy: boolean;
  pick: (key: string, mode: SelectMode) => void;
}

/** The pages' selection: there is no mode, the user is selecting while
 * anything is selected. `pickKey`, `run` and `pickContext` stay stable while
 * nothing about them changes, so memoised items skip re-rendering on a pick. */
export function useFileSelection<T>(
  items: T[],
  keyOf: (item: T) => string,
  loadAll: () => Promise<T[]>,
  onBusyChange: (busy: boolean) => void
) {
  const [keys, setKeys] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  // Shift-click ranges start from the last item picked without Shift.
  const anchor = useRef<string | null>(null);
  // Read by the stable callbacks below.
  const order = useRef<string[]>([]);
  order.current = items.map(keyOf);
  const latest = useRef({ keyOf, onBusyChange });
  latest.current = { keyOf, onBusyChange };
  const selected = items.filter((item) => keys.includes(keyOf(item)));

  const markBusy = useCallback((value: boolean) => {
    locked.current = value;
    setBusy(value);
    latest.current.onBusyChange(value);
  }, []);

  const pickKey = useCallback((key: string, mode: SelectMode) => {
    if (locked.current) return;
    setKeys((current) =>
      pickKeys(current, order.current, key, mode, anchor.current)
    );
    if (mode !== 'range') anchor.current = key;
  }, []);

  async function selectAll() {
    if (locked.current) return;
    markBusy(true);
    try {
      const all = await loadAll();
      setKeys(all.map(keyOf));
      return all;
    } catch {
      userToast({ title: m.files_selection_load_failed(), variant: 'error' });
    } finally {
      markBusy(false);
    }
  }

  const run = useCallback(
    async (targets: T[], mutate: (item: T) => Promise<unknown>) => {
      if (locked.current || targets.length === 0) return;
      markBusy(true);
      try {
        for (const item of targets) {
          await mutate(item);
          const done = latest.current.keyOf(item);
          setKeys((current) => current.filter((key) => key !== done));
        }
      } catch {
        // Global mutation errors explain the failure. Keep unfinished items
        // selected for a user-initiated retry; never retry a batch.
      } finally {
        markBusy(false);
      }
    },
    [markBusy]
  );

  const active = selected.length > 0;
  // Esc clears, unless a dialog, menu or field has it.
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const target = event.target as Element;
      if (
        target.closest('[role="dialog"], [role="menu"], input, textarea') ||
        (target as HTMLElement).isContentEditable
      )
        return;
      if (!locked.current) setKeys([]);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [active]);

  const pickContext = useMemo<PickContext>(
    () => ({ active, busy, pick: pickKey }),
    [active, busy, pickKey]
  );

  return {
    busy,
    clear: () => {
      if (!locked.current) setKeys([]);
    },
    isSelected: (item: T) => keys.includes(keyOf(item)),
    pickContext,
    run,
    selectAll,
    selected,
    selecting: active,
  };
}
