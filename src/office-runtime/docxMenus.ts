import {
  createT,
  deepMerge,
  en,
  type LocaleStrings,
  type Translations,
  zhCN,
} from '@betteroffice/docx-i18n';
import type { HostMenu, HostMenuEntry } from '@betteroffice/docx-react';
import type { IconName } from '@/components/ui/Icon';
import {
  OFFICE_HOST_COMMANDS,
  type OfficeMenu,
  type OfficeMenuEntry,
} from '@/features/files/officeMenus';
import type { OfficeLocale } from '@/features/files/officeProtocol';

/**
 * Capy's sentence case where the editor's English uses title case, in its
 * menus, dropdowns and pickers; the colour labels as the note toolbar's and
 * PPTX's. Word's own names (table styles) keep theirs.
 */
const EN: Translations = {
  alignment: { alignLeft: 'Align left', alignRight: 'Align right' },
  colorPicker: {
    customColor: 'Custom color',
    highlightColors: 'Highlight colors',
    noColor: 'No color',
    standardColors: 'Standard colors',
    themeColors: 'Theme colors',
  },
  contextMenu: {
    pastePlainText: 'Paste as plain text',
    selectAll: 'Select all',
  },
  font: { sansSerif: 'Sans serif' },
  formattingBar: {
    fontColor: 'Text color',
    highlightColor: 'Highlight color',
  },
  imageWrap: {
    behindText: 'Behind text',
    floatLeft: 'Square left',
    floatRight: 'Square right',
    inFrontOfText: 'In front of text',
    inline: 'In line with text',
    menu: {
      behindText: 'Behind text',
      inFrontOfText: 'In front of text',
      inLineWithText: 'In line with text',
      squareLeft: 'Square left',
      squareRight: 'Square right',
    },
    topAndBottom: 'Top and bottom',
  },
  table: { borderColor: 'Border color', cellFillColor: 'Cell fill color' },
};

// A string zh-CN lacks falls back to Capy's English, not the editor's.
const ZH = deepMerge(EN, zhCN) as Translations;

/** The DOCX editor's strings for Capy's locale, over its built-in English. */
export function docxStrings(locale: OfficeLocale): Translations {
  return locale === 'zh' ? ZH : EN;
}

export function docxT(locale: OfficeLocale) {
  return createT(deepMerge(en, docxStrings(locale)) as LocaleStrings);
}

/** Capy's icons beside the DOCX menu items, as Google Docs draws them. */
const ICONS: Record<string, IconName> = {
  [OFFICE_HOST_COMMANDS.print]: 'print',
  download: 'download',
  'find-replace': 'search',
  'format-align': 'alignLeft',
  'format-lists': 'list',
  'format-text': 'bold',
  'image-options': 'image',
  'insert-comment': 'commentAdd',
  'insert-image': 'image',
  'insert-link': 'link',
  'insert-table': 'table',
  'page-setup': 'settings',
  redo: 'redo',
  save: 'cloudSync',
  'table-properties': 'table',
  undo: 'undo',
  zoom: 'zoomIn',
};

function withIcons(entries: HostMenuEntry[]): OfficeMenuEntry[] {
  return entries.map((entry) => {
    if (entry.kind === 'separator' || entry.kind === 'grid') return entry;
    const icon = ICONS[entry.id];
    if (entry.kind === 'submenu')
      return { ...entry, icon, items: withIcons(entry.items) };
    // Capy opens the picker: a click in its menu gives the frame no user
    // activation to open one.
    const pick = entry.id === 'insert-image' ? ('image' as const) : undefined;
    return icon && entry.checked === undefined
      ? { ...entry, icon, pick }
      : { ...entry, pick };
  });
}

/** File › Download ▸ Word document, which Capy performs. */
export function downloadMenu(locale: OfficeLocale): OfficeMenuEntry {
  const t = docxT(locale);
  return {
    icon: 'download',
    id: 'download',
    items: [
      {
        id: OFFICE_HOST_COMMANDS.download,
        kind: 'item',
        label: t('hostMenus.wordDocument'),
      },
    ],
    kind: 'submenu',
    label: t('hostMenus.download'),
  };
}

/** File › Print, which Capy performs from the pages the runtime draws. */
export function printItem(locale: OfficeLocale): OfficeMenuEntry {
  return {
    icon: 'print',
    id: OFFICE_HOST_COMMANDS.print,
    kind: 'item',
    label: docxT(locale)('toolbar.print'),
  };
}

/**
 * The editor's menus for the header: Capy's icons, and Download and Print
 * added to File.
 */
export function editorMenus(
  menus: HostMenu[],
  locale: OfficeLocale
): OfficeMenu[] {
  return menus.map((menu) => {
    const items = withIcons(menu.items);
    if (menu.id !== 'file') return { ...menu, items };
    // Capy saves itself (the checkpoint), as Ctrl/Cmd+S does.
    const save = items.findIndex(
      (entry) => entry.kind === 'item' && entry.id === 'save'
    );
    const saveItem = items[save];
    if (saveItem?.kind === 'item')
      items[save] = { ...saveItem, id: OFFICE_HOST_COMMANDS.save };
    // As the mock: Save | Download ▸ | Page setup, Print.
    items.splice(save + 1, 0, { kind: 'separator' }, downloadMenu(locale), {
      kind: 'separator',
    });
    items.push(printItem(locale));
    return { ...menu, items };
  });
}
