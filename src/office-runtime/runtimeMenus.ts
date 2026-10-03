import {
  OFFICE_HOST_COMMANDS,
  type OfficeHeaderAction,
  type OfficeMenu,
  type OfficeMenuEntry,
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

/** View-menu commands that still change the document (XLSX freezes panes). */
const VIEW_EDITS = /^freeze/;
const OUTPUTS = new Set<string>([
  OFFICE_HOST_COMMANDS.download,
  OFFICE_HOST_COMMANDS.print,
  OFFICE_HOST_COMMANDS.png,
]);

function viewIds(menus: readonly OfficeMenu[]) {
  const ids = new Set<string>();
  const walk = (entries: readonly OfficeMenuEntry[]) => {
    for (const entry of entries) {
      if (entry.kind === 'separator' || VIEW_EDITS.test(entry.id)) continue;
      ids.add(entry.id);
      if (entry.kind === 'submenu') walk(entry.items);
    }
  };
  for (const menu of menus) if (menu.id === 'view') walk(menu.items);
  return ids;
}

/**
 * Whether a command may run while editing is paused (handoff, replaced,
 * recovery, connecting, discarding): the View menu's, the header actions'
 * and Capy's Download and Print. Everything else edits.
 */
export function runsWhilePaused(source: OfficeMenuSource | null, id: string) {
  return (
    OUTPUTS.has(id) ||
    !!source?.actions?.some((action) => action.id === id) ||
    (!!source && viewIds(source.menus).has(id))
  );
}

/**
 * The menus while editing is paused: everything that edits stays listed but
 * disabled, File › Save included; a submenu with nothing left to run is
 * disabled too.
 */
export function pausedMenus(menus: readonly OfficeMenu[]): OfficeMenu[] {
  const allowed = viewIds(menus);
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
      return allowed.has(entry.id) || OUTPUTS.has(entry.id)
        ? entry
        : { ...entry, disabled: true };
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
