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
       * Capy opens its file picker (the frame has no user activation for
       * one) and sends the chosen file in `menu-file` instead of a command.
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

/**
 * What a click on a menu item does: open Capy's file picker (`pick`), run
 * one of Capy's own commands, or send the id to the runtime.
 */
export function officeItemAction(
  item: Pick<Extract<OfficeMenuEntry, { kind: 'item' }>, 'id' | 'pick'>
):
  | { kind: 'pick'; accept: string }
  | { kind: 'host'; command: OfficeHostCommand }
  | { kind: 'runtime' } {
  if (item.pick === 'image') return { accept: 'image/*', kind: 'pick' };
  const command = officeHostCommand(item.id);
  return command ? { command, kind: 'host' } : { kind: 'runtime' };
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
