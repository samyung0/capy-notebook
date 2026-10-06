import type {
  OfficeHeaderAction,
  OfficeMenu,
  OfficeMenuEntry,
} from '@/features/files/officeMenus';
import type { OfficeRenderedPage } from '@/features/files/officeProtocol';

/**
 * What an editor or viewer puts in Capy's file header: its menus, header
 * actions, and the function that runs their ids (`menu-command`). Capy's own
 * ids (`OFFICE_HOST_COMMANDS`) never reach `run`.
 */
export interface OfficeMenuSource {
  actions?: OfficeHeaderAction[];
  menus: OfficeMenu[];
  /** `file` comes with a `pick` item, from Capy's picker. */
  run: (id: string, value?: string, file?: File) => void;
}

export type OfficeMenuReporter = (source: OfficeMenuSource | null) => void;

/**
 * Pages to print, or the one image saved as PNG, as the host asked;
 * `truncated` when a sheet printed only its first pages.
 */
export type OfficeRenderer = (
  kind: 'print' | 'png'
) => Promise<
  OfficeRenderedPage[] | { pages: OfficeRenderedPage[]; truncated: boolean }
>;

/** The menu item an id names, if any. */
function findItem(
  entries: readonly OfficeMenuEntry[],
  id: string
): Extract<OfficeMenuEntry, { kind: 'item' }> | undefined {
  for (const entry of entries) {
    if (entry.kind === 'item' && entry.id === id) return entry;
    if (entry.kind === 'submenu') {
      const found = findItem(entry.items, id);
      if (found) return found;
    }
  }
}

/**
 * Whether a command may run while editing is paused (handoff, replaced,
 * recovery, connecting, discarding): a header action, or a menu or header
 * action item that does not edit (`edits`, declared by the editor that
 * defines it).
 */
export function runsWhilePaused(source: OfficeMenuSource | null, id: string) {
  if (!source) return false;
  if (source.actions?.some((action) => action.id === id)) return true;
  const item = findItem(
    [
      ...source.menus.flatMap((menu) => menu.items),
      ...(source.actions?.flatMap((action) => action.items ?? []) ?? []),
    ],
    id
  );
  return !!item && !item.edits;
}

/**
 * The menus while editing is paused: every item that edits stays listed but
 * disabled (File › Save, Capy's own, included), read-only ones keep their
 * state; a submenu with nothing left to run is disabled too, the table grid
 * counting as an edit.
 */
export function pausedMenus(menus: readonly OfficeMenu[]): OfficeMenu[] {
  const pause = (entries: readonly OfficeMenuEntry[]): OfficeMenuEntry[] =>
    entries.map((entry) => {
      if (entry.kind === 'separator' || entry.kind === 'grid') return entry;
      if (entry.kind === 'submenu') {
        const items = pause(entry.items);
        const live = items.some(
          (item) =>
            (item.kind === 'item' || item.kind === 'submenu') && !item.disabled
        );
        return { ...entry, disabled: !live, items };
      }
      return entry.edits ? { ...entry, disabled: true } : entry;
    });
  return menus.map((menu) => ({ ...menu, items: pause(menu.items) }));
}

/** A rendered canvas as PNG bytes, sized in CSS px for the printed page. */
export async function canvasPage(
  canvas: HTMLCanvasElement,
  width = canvas.width,
  height = canvas.height
): Promise<OfficeRenderedPage> {
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/png')
  );
  if (!blob) throw new Error('The page could not be rendered');
  return { bytes: await blob.arrayBuffer(), height, width };
}
