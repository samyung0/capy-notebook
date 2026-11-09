import type {
  OfficeBanner,
  OfficeMenu,
  OfficeMenuEntry,
  OfficeRibbon,
} from '@/features/files/officeMenus';
import { OFFICE_RIBBON_COMMANDS } from '@/features/files/officeMenus';
import { m } from '@/i18n';
import type { OfficeMenuSource } from './runtimeMenus';

/** The contextual tabs an editor can add, as Office's Table and Picture. */
export type RibbonContext = 'picture' | 'table';

export interface RibbonState {
  /** Only the host's strip under the tabs, Capy's message bar (Q566). */
  banner: OfficeBanner | null;
  collapsed: boolean;
  contexts: readonly RibbonContext[];
  /** Counts the times the tab line sent the keyboard into the ribbon. */
  focusRequest: number;
  /** The editor's whole menu tree, paused or not; the host shows only File. */
  menus: readonly OfficeMenu[];
  /** The ribbon is on screen: the host's strips and tab line count on it. */
  mounted: boolean;
  /** Collapsed, with a clicked tab's ribbon open over the page. */
  over: boolean;
  /** Edit always opens on Home (Q665). */
  tab: string;
}

export const HOME_TAB = 'home';

/** The tab line's tabs: Home, then the menus after File, then what's in context. */
export function ribbonTabs(
  menus: readonly OfficeMenu[],
  contexts: readonly RibbonContext[]
) {
  return [
    { id: HOME_TAB, label: m.files_office_tab_home() },
    ...menus
      .filter((menu) => menu.id !== 'file')
      .map(({ id, label }) => ({ id, label })),
    ...contexts.map((id) => ({
      id,
      label:
        id === 'table'
          ? m.files_office_tab_table()
          : m.files_office_tab_picture(),
    })),
  ];
}

function historyItem(menus: readonly OfficeMenu[], name: 'redo' | 'undo') {
  for (const entry of menus.find((menu) => menu.id === 'edit')?.items ?? [])
    if (
      entry.kind === 'item' &&
      (entry.id === name || entry.id.endsWith(`.${name}`))
    )
      return entry;
}

/** What Capy's tab line draws; the editor's own tree stays in the frame. */
export function ribbonChrome(state: RibbonState): OfficeRibbon | null {
  if (!state.mounted) return null;
  const undo = historyItem(state.menus, 'undo');
  const redo = historyItem(state.menus, 'redo');
  if (!(undo && redo)) return null;
  return {
    collapsed: state.collapsed,
    redo,
    // Collapsed, no tab is current until one opens over the page, as in Office.
    tab: state.collapsed && !state.over ? null : state.tab,
    tabs: ribbonTabs(state.menus, state.contexts),
    undo,
  };
}

/** The menu or entry an id names, submenus searched. */
export function findRibbonEntry(
  menus: readonly OfficeMenu[],
  id: string
): OfficeMenuEntry | undefined {
  const search = (
    entries: readonly OfficeMenuEntry[]
  ): OfficeMenuEntry | undefined => {
    for (const entry of entries) {
      if (entry.kind === 'separator') continue;
      if (entry.id === id) return entry;
      const found = entry.kind === 'submenu' ? search(entry.items) : undefined;
      if (found) return found;
    }
  };
  for (const menu of menus) {
    if (menu.id === id)
      return { id, items: menu.items, kind: 'submenu', label: menu.label };
    const found = search(menu.items);
    if (found) return found;
  }
}

/**
 * What a layout's cell draws from the menus. A split with no list (a deck with
 * no slides has no layouts to list) draws its upper half, whole.
 */
export function findRibbonCell(
  menus: readonly OfficeMenu[],
  cell: { id: string; split?: string }
) {
  const found = findRibbonEntry(menus, cell.id);
  if (found && found.kind !== 'separator' && found.kind !== 'grid')
    return found;
  const split = cell.split ? findRibbonEntry(menus, cell.split) : undefined;
  return split?.kind === 'item' ? split : null;
}

/**
 * After a command the keys go back to the document, as in Office, unless the
 * command moved them (a comment box, a dialog) or a list stays open.
 */
export function returnKeys(focus: () => void) {
  requestAnimationFrame(() => {
    const active = document.activeElement;
    if (
      (!active ||
        active === document.body ||
        active.closest('.office-ribbon')) &&
      !document.querySelector('.office-ribbon [aria-expanded="true"]')
    )
      focus();
  });
}

/**
 * The ribbon's state for one edit frame: the tab line in Capy's header and the
 * ribbon in the editor's toolbar both read it, so a tab click moves neither
 * the editor nor its toolbar's other state.
 */
export function createRibbonStore(onChromeChange: () => void) {
  let state: RibbonState = {
    banner: null,
    collapsed: false,
    contexts: [],
    focusRequest: 0,
    menus: [],
    mounted: false,
    over: false,
    tab: HOME_TAB,
  };
  const listeners = new Set<() => void>();
  let runner: OfficeMenuSource['run'] | null = null;
  let focuser: (() => void) | null = null;
  let menusText = '[]';
  const set = (next: Partial<RibbonState>) => {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  };
  return {
    closeOver() {
      if (!state.over) return;
      set({ over: false });
      onChromeChange();
    },
    /** Handles a `menu-command` from the tab line; false when it's not one. */
    command(id: string) {
      if (id === OFFICE_RIBBON_COMMANDS.collapse) {
        set({ collapsed: !state.collapsed, over: false });
      } else if (id.startsWith(OFFICE_RIBBON_COMMANDS.tab)) {
        const tab = id.slice(OFFICE_RIBBON_COMMANDS.tab.length);
        // A click on the open tab closes what's over the page, as in Office.
        if (state.collapsed && state.over && tab === state.tab)
          set({ over: false });
        else set({ over: state.collapsed, tab });
      } else if (id === OFFICE_RIBBON_COMMANDS.enter) {
        set({
          focusRequest: state.focusRequest + 1,
          over: state.collapsed,
        });
      } else return false;
      onChromeChange();
      return true;
    },
    /** Puts the keys back in the document. */
    focusDocument() {
      focuser?.();
    },
    get: () => state,
    /** A room swap's new frame takes over the tab and the collapse. */
    restore(kept: { collapsed: boolean; tab: string | null }) {
      set({ collapsed: kept.collapsed, tab: kept.tab ?? HOME_TAB });
    },
    run(id: string, value?: string, file?: File) {
      runner?.(id, value, file);
    },
    /** The host reports its strip on every render; only a change draws. */
    setBanner(banner: OfficeBanner | null) {
      if (JSON.stringify(banner) !== JSON.stringify(state.banner))
        set({ banner });
    },
    setContexts(contexts: readonly RibbonContext[]) {
      if (contexts.join() === state.contexts.join()) return;
      const tabs = ribbonTabs(state.menus, contexts);
      set({
        contexts,
        // The selection left the table: back to Home, as Office leaves its
        // contextual tab.
        tab: tabs.some((tab) => tab.id === state.tab) ? state.tab : HOME_TAB,
      });
      onChromeChange();
    },
    setMenus(
      menus: readonly OfficeMenu[],
      run: OfficeMenuSource['run'] | null,
      focus: (() => void) | null = null
    ) {
      runner = run;
      focuser = focus;
      // Editors re-report on each selection change; most change nothing here,
      // and an arrow key in a sheet must not draw the ribbon.
      const text = JSON.stringify(menus);
      if (text === menusText) return;
      menusText = text;
      // A restored tab that isn't here (a table the caret isn't in): Home.
      const known = ribbonTabs(menus, state.contexts).some(
        (tab) => tab.id === state.tab
      );
      set({ menus, tab: known || !menus.length ? state.tab : HOME_TAB });
    },
    setMounted(mounted: boolean) {
      set({ mounted });
      onChromeChange();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export type RibbonStore = ReturnType<typeof createRibbonStore>;
