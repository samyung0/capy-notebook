import { type IconName, isIconName } from '@/components/ui/Icon';

/**
 * The Office runtime's menu bar and header actions, drawn by Capy's file
 * header. The runtime sends labels in Capy's locale (`set-appearance`), so
 * the host only renders and routes clicks.
 */
export type OfficeMenuEntry =
  | {
      kind: 'item';
      id: string;
      label: string;
      /**
       * Running it changes the document (or saves it), as the editor that
       * defines it declares: paused editing disables it.
       */
      edits: boolean;
      /** Shown right-aligned, e.g. "⌘B" or "Ctrl+B". */
      shortcut?: string;
      /** A toggle: drawn with a tick, unticked when false. */
      checked?: boolean;
      /** One of an exclusive set: a radio item, ticked by `checked`. */
      radio?: boolean;
      disabled?: boolean;
      icon?: IconName;
      /**
       * The ribbon opens the file picker from its click, and runs the item
       * with the chosen file.
       */
      pick?: 'image';
      /**
       * Running it puts the runtime in full screen: Capy hands the click's
       * full-screen permission to the frame with the command.
       */
      fullscreen?: boolean;
      /**
       * Capy opens the runtime's presenter window from the click (the frame
       * gets no user activation from it) and sends the window's token as the
       * command's value; a blocked window sends the command again with ''.
       */
      popup?: 'presenter';
    }
  | { kind: 'separator' }
  | {
      kind: 'submenu';
      id: string;
      label: string;
      items: OfficeMenuEntry[];
      icon?: IconName;
      /** Nothing in it can run now (editing paused). */
      disabled?: boolean;
    }
  /** Capy's table size picker (8×8); its command carries "<rows>x<cols>".
   * It inserts a table, so it always edits. */
  | { kind: 'grid'; id: string };

export interface OfficeMenu {
  id: string;
  items: OfficeMenuEntry[];
  label: string;
}

/**
 * A labelled button in the header's right cluster, e.g. PPTX Present; with
 * `items` a split button whose arrow opens them.
 */
export interface OfficeHeaderAction {
  /** As a menu item's `fullscreen`. */
  fullscreen?: boolean;
  icon: IconName;
  id: string;
  items?: OfficeMenuEntry[];
  label: string;
}

/**
 * The ribbon's tab line, which Capy's header draws (Q562): Undo and Redo on
 * every tab, as Office's Quick Access Toolbar, and the editor's tabs. The ribbon
 * itself is in the frame. Only edit mode has one (Q666).
 */
export interface OfficeRibbon {
  collapsed: boolean;
  redo: Extract<OfficeMenuEntry, { kind: 'item' }>;
  /** Null: collapsed, with no tab open over the page. */
  tab: string | null;
  tabs: { id: string; label: string }[];
  undo: Extract<OfficeMenuEntry, { kind: 'item' }>;
}

/** Ids the tab line sends in `menu-command`; the runtime keeps the tab state. */
export const OFFICE_RIBBON_COMMANDS = {
  collapse: 'ribbon.collapse',
  /** The keyboard goes from the tab line into the current tab's commands. */
  enter: 'ribbon.enter',
  /** Followed by the tab's id. */
  tab: 'ribbon.tab:',
} as const;

/**
 * A file strip the runtime draws under its ribbon, as Office's message bar
 * (Q566): what FileBanner would draw; `banner-action` carries the clicks back.
 */
export interface OfficeBanner {
  actions: { disabled?: boolean; label: string }[];
  closeable: boolean;
  inline: boolean;
  kind?: string;
  message: string;
  testId?: string;
  tone: 'neutral' | 'error';
}

/**
 * Items Capy performs itself instead of the runtime, which is sandboxed
 * without downloads, popups or modals: the runtime lists them where they
 * belong, and the host handles a click without a `menu-command`.
 * - save: the checkpoint the old Save button took (edit mode), as Ctrl/Cmd+S.
 * - download: the document's bytes from `export` (both modes), saved under
 *   the file's name.
 * - print: pages from `render` {kind: 'print'}, printed from the app's
 *   document.
 * - png: an image from `render` {kind: 'png'}, saved as "<name>.png".
 */
export const OFFICE_HOST_COMMANDS = {
  download: 'capy.download',
  png: 'capy.png',
  print: 'capy.print',
  save: 'capy.save',
} as const;

export type OfficeHostCommand = keyof typeof OFFICE_HOST_COMMANDS;

/** Which of Capy's own commands an id names, if any. */
export function officeHostCommand(id: string): OfficeHostCommand | undefined {
  return (Object.keys(OFFICE_HOST_COMMANDS) as OfficeHostCommand[]).find(
    (command) => OFFICE_HOST_COMMANDS[command] === id
  );
}

const MAC_MODIFIERS = /^[⌃⌥⇧⌘]*/;

/** A menu shortcut ("⌘⇧V", "Ctrl+Shift+V") as aria-keyshortcuts reads it. */
export function ariaKeyShortcut(shortcut: string) {
  const names: Record<string, string> = {
    Ctrl: 'Control',
    Del: 'Delete',
    Esc: 'Escape',
    '⇧': 'Shift',
    '⌃': 'Control',
    '⌘': 'Meta',
    '⌥': 'Alt',
  };
  const parts = shortcut.includes('+')
    ? shortcut.split('+')
    : [
        ...shortcut.match(MAC_MODIFIERS)![0],
        shortcut.replace(MAC_MODIFIERS, ''),
      ];
  return parts
    .filter(Boolean)
    .map((part) => names[part] ?? part)
    .join('+');
}

const MAX_MENUS = 12;
/** A longer submenu is left out (its menu stays); a longer menu is refused. */
const MAX_ENTRIES = 80;
/** Beyond this a submenu is not a menu at all, and the message is refused. */
const MAX_SUBMENU_ENTRIES = 2000;
const MAX_DEPTH = 3;
const MAX_TEXT = 120;

function isText(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= MAX_TEXT
  );
}

function isOptionalIcon(value: unknown): boolean {
  return (
    value === undefined || (typeof value === 'string' && isIconName(value))
  );
}

function isOptional(value: unknown, type: 'boolean' | 'string'): boolean {
  return value === undefined || typeof value === type;
}

function isEntries(
  value: unknown,
  depth: number,
  limit = MAX_ENTRIES
): value is OfficeMenuEntry[] {
  return (
    Array.isArray(value) &&
    value.length <= limit &&
    value.every((entry) => isEntry(entry, depth))
  );
}

function isEntry(value: unknown, depth: number): value is OfficeMenuEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  if (entry.kind === 'separator') return true;
  if (!isText(entry.id)) return false;
  if (entry.kind === 'item')
    return (
      isText(entry.label) &&
      isOptional(entry.shortcut, 'string') &&
      isOptional(entry.checked, 'boolean') &&
      isOptional(entry.radio, 'boolean') &&
      isOptional(entry.disabled, 'boolean') &&
      isOptionalIcon(entry.icon) &&
      (entry.pick === undefined || entry.pick === 'image') &&
      isOptional(entry.fullscreen, 'boolean') &&
      (entry.popup === undefined || entry.popup === 'presenter')
    );
  if (entry.kind === 'submenu')
    return (
      depth < MAX_DEPTH &&
      isText(entry.label) &&
      isOptionalIcon(entry.icon) &&
      isOptional(entry.disabled, 'boolean') &&
      isEntries(entry.items, depth + 1, MAX_SUBMENU_ENTRIES)
    );
  if (entry.kind === 'grid') return true;
  return false;
}

export function isOfficeMenus(value: unknown): value is OfficeMenu[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_MENUS &&
    value.every((menu) => {
      if (!menu || typeof menu !== 'object') return false;
      const candidate = menu as Record<string, unknown>;
      return (
        isText(candidate.id) &&
        isText(candidate.label) &&
        isEntries(candidate.items, 1)
      );
    })
  );
}

/** What the frame may put on the tab line, which is Capy's page. */
const MAX_TAB_LABEL = 40;
const TAB_ID = /^[a-z]{1,16}$/;

function isTabLabel(value: unknown) {
  return isText(value) && value.length <= MAX_TAB_LABEL;
}

/** Only the editors' own history commands: never one of Capy's (`capy.download`). */
function isTabLineItem(value: unknown, ids: readonly string[]) {
  if (!(isEntry(value, 1) && (value as { kind: string }).kind === 'item'))
    return false;
  const item = value as { id: string; label: string };
  return ids.includes(item.id) && isTabLabel(item.label);
}

export function isOfficeRibbon(value: unknown): value is OfficeRibbon {
  if (!value || typeof value !== 'object') return false;
  const ribbon = value as Record<string, unknown>;
  if (
    !(
      typeof ribbon.collapsed === 'boolean' &&
      isTabLineItem(ribbon.undo, ['undo', 'edit.undo']) &&
      isTabLineItem(ribbon.redo, ['redo', 'edit.redo']) &&
      Array.isArray(ribbon.tabs) &&
      ribbon.tabs.length <= MAX_MENUS &&
      ribbon.tabs.every(
        (tab) =>
          typeof tab?.id === 'string' &&
          TAB_ID.test(tab.id) &&
          isTabLabel(tab?.label)
      )
    )
  )
    return false;
  return (
    ribbon.tab === null ||
    (ribbon.tabs as { id: string }[]).some((tab) => tab.id === ribbon.tab)
  );
}

export function isOfficeBanner(value: unknown): value is OfficeBanner {
  if (!value || typeof value !== 'object') return false;
  const banner = value as Record<string, unknown>;
  return (
    typeof banner.message === 'string' &&
    (banner.tone === 'neutral' || banner.tone === 'error') &&
    typeof banner.closeable === 'boolean' &&
    typeof banner.inline === 'boolean' &&
    isOptional(banner.kind, 'string') &&
    isOptional(banner.testId, 'string') &&
    Array.isArray(banner.actions) &&
    banner.actions.every(
      (action) =>
        isText(action?.label) && isOptional(action?.disabled, 'boolean')
    )
  );
}

/**
 * The menus without any submenu longer than MAX_ENTRIES (a document's style
 * list, say): one oversized list costs that submenu, not the menu bar.
 */
export function fitOfficeMenus(menus: OfficeMenu[]): OfficeMenu[] {
  const trim = (entries: OfficeMenuEntry[]): OfficeMenuEntry[] =>
    entries.flatMap((entry): OfficeMenuEntry[] => {
      if (entry.kind !== 'submenu') return [entry];
      if (entry.items.length > MAX_ENTRIES) return [];
      return [{ ...entry, items: trim(entry.items) }];
    });
  return menus.map((menu) => ({ ...menu, items: trim(menu.items) }));
}

export function isOfficeHeaderActions(
  value: unknown
): value is OfficeHeaderAction[] {
  return (
    Array.isArray(value) &&
    value.length <= 4 &&
    value.every((action) => {
      if (!action || typeof action !== 'object') return false;
      const candidate = action as Record<string, unknown>;
      return (
        isText(candidate.id) &&
        isText(candidate.label) &&
        typeof candidate.icon === 'string' &&
        isIconName(candidate.icon) &&
        isOptional(candidate.fullscreen, 'boolean') &&
        (candidate.items === undefined || isEntries(candidate.items, 2))
      );
    })
  );
}

/**
 * What Capy does with a click on the item or header action `id`, beyond
 * sending it: hand over full screen, or open the presenter window first.
 */
export function officeCommandNeeds(
  menus: { menus: OfficeMenu[]; actions: OfficeHeaderAction[] } | null,
  id: string
): { fullscreen: boolean; popup?: 'presenter' } {
  const find = (
    entries: readonly OfficeMenuEntry[]
  ): Extract<OfficeMenuEntry, { kind: 'item' }> | undefined => {
    for (const entry of entries) {
      if (entry.kind === 'item' && entry.id === id) return entry;
      const found = entry.kind === 'submenu' ? find(entry.items) : undefined;
      if (found) return found;
    }
  };
  const action = menus?.actions.find((candidate) => candidate.id === id);
  if (action) return { fullscreen: !!action.fullscreen };
  const item = find([
    ...(menus?.menus.flatMap((menu) => menu.items) ?? []),
    ...(menus?.actions.flatMap((candidate) => candidate.items ?? []) ?? []),
  ]);
  return { fullscreen: !!item?.fullscreen, popup: item?.popup };
}
