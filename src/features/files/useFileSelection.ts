import { useRef, useState } from 'react';
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

export function useFileSelection<T>(
  items: T[],
  keyOf: (item: T) => string,
  loadAll: () => Promise<T[]>,
  onBusyChange: (busy: boolean) => void
) {
  const [selecting, setSelecting] = useState(false);
  const [keys, setKeys] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const selected = items.filter((item) => keys.includes(keyOf(item)));

  function markBusy(value: boolean) {
    locked.current = value;
    setBusy(value);
    onBusyChange(value);
  }

  function exit() {
    if (locked.current) return;
    setSelecting(false);
    setKeys([]);
  }

  function toggle(item: T) {
    if (locked.current) return;
    const key = keyOf(item);
    setKeys((current) =>
      current.includes(key)
        ? current.filter((value) => value !== key)
        : [...current, key]
    );
  }

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

  async function run(targets: T[], mutate: (item: T) => Promise<unknown>) {
    if (locked.current || targets.length === 0) return;
    markBusy(true);
    try {
      for (const item of targets) {
        await mutate(item);
        setKeys((current) => current.filter((key) => key !== keyOf(item)));
      }
    } catch {
      // Global mutation errors explain the failure. Keep unfinished items
      // selected for a user-initiated retry; never retry a batch.
    } finally {
      markBusy(false);
    }
  }

  return {
    busy,
    clear: () => {
      if (!locked.current) setKeys([]);
    },
    exit,
    isSelected: (item: T) => keys.includes(keyOf(item)),
    run,
    selectAll,
    selected,
    selecting,
    start: () => setSelecting(true),
    toggle,
  };
}
