/**
 * PPTX menus for Capy's header, shared by the viewer and the editor. Nothing
 * here loads editor code: the viewer imports it.
 */

import {
  createT,
  deepMerge,
  en,
  type LocaleStrings,
  zhCN,
} from '@betteroffice/pptx-i18n';
import { PRESENT_ITEMS } from '@betteroffice/pptx-react/presentation';
import type { IconName } from '@/components/ui/Icon';
import {
  OFFICE_HOST_COMMANDS,
  type OfficeHeaderAction,
  type OfficeMenu,
  type OfficeMenuEntry,
} from '@/features/files/officeMenus';
import type { OfficeLocale } from '@/features/files/officeProtocol';
import { m } from '@/i18n';

/** The PPTX editor's translations for Capy's locale (English is built in). */
export function pptxStrings(locale: OfficeLocale) {
  return locale === 'zh' ? zhCN : undefined;
}

export function pptxT(locale: OfficeLocale) {
  return createT(
    deepMerge(en, pptxStrings(locale)) as LocaleStrings,
    locale === 'zh' ? 'zh-CN' : 'en'
  );
}

const APPLE = /Mac|iPhone|iPad/;

export function shortcut(keys: string) {
  const parts = keys.split('+');
  const key = parts.pop() ?? '';
  if (APPLE.test(navigator.platform))
    return (
      parts
        .map((part) => ({ Alt: '⌥', Mod: '⌘', Shift: '⇧' })[part] ?? part)
        .join('') + key
    );
  return [...parts.map((part) => (part === 'Mod' ? 'Ctrl' : part)), key].join(
    '+'
  );
}

export function item(
  id: string,
  label: string,
  extra: Partial<Extract<OfficeMenuEntry, { kind: 'item' }>> & {
    edits: boolean;
  }
): OfficeMenuEntry {
  return { id, kind: 'item', label, ...extra };
}

export function submenu(
  id: string,
  label: string,
  items: OfficeMenuEntry[],
  icon?: IconName
): OfficeMenuEntry {
  return { icon, id, items, kind: 'submenu', label };
}

export const separator: OfficeMenuEntry = { kind: 'separator' };

/** File › Download ▸ and Print, which Capy performs from the runtime's pages. */
export function fileOutputs(): OfficeMenuEntry[] {
  return [
    submenu(
      'download',
      m.files_office_pptx_download(),
      [
        item(
          OFFICE_HOST_COMMANDS.download,
          m.files_office_pptx_download_pptx(),
          { edits: false }
        ),
        item(OFFICE_HOST_COMMANDS.png, m.files_office_pptx_download_png(), {
          edits: false,
        }),
      ],
      'download'
    ),
    item(OFFICE_HOST_COMMANDS.print, m.files_office_pptx_print(), {
      edits: false,
      icon: 'print',
    }),
  ];
}

/**
 * From this slide, From the start and Presenter view (pptx-react's
 * PRESENT_ITEMS): the first two go full screen in this tab, the last opens
 * the speaker notes window. None edits, so they run while editing is paused.
 */
export function presentItems(
  locale: OfficeLocale,
  disabled?: boolean
): OfficeMenuEntry[] {
  const t = pptxT(locale);
  return PRESENT_ITEMS.flatMap((entry) => {
    const value = 'value' in entry ? entry.value : undefined;
    const presenter = entry.command === 'view.presenterView';
    const presented = item(
      value ? `${entry.command}:${value}` : entry.command,
      t(entry.labelKey),
      {
        disabled: disabled || undefined,
        edits: false,
        // From the start lines up under From this slide's icon.
        icon: value ? undefined : presenter ? 'speakerNotes' : 'presentation',
        ...(presenter ? { popup: 'presenter' as const } : { fullscreen: true }),
      }
    );
    return presenter ? [separator, presented] : [presented];
  });
}

/**
 * Present, as Google Slides' Slideshow ▾, in both modes: the main part
 * presents from the current slide, the arrow lists `presentItems`, disabled
 * in a deck without slides.
 */
export function presentAction(
  locale: OfficeLocale,
  disabled?: boolean
): OfficeHeaderAction {
  return {
    fullscreen: true,
    icon: 'presentation',
    id: 'view.present',
    items: presentItems(locale, disabled),
    label: pptxT(locale)('toolbar.present'),
  };
}

const ZOOMS = ['0.5', '0.75', '1', '1.25', '1.5', '2'];

/**
 * View › Zoom ▸ Fit and the toolbar's levels, `current` ('fit' or a scale
 * such as '1.5') ticked. Zoom edits nothing, so it runs while paused.
 */
export function zoomMenu(
  locale: OfficeLocale,
  current: string,
  disabled?: boolean
): OfficeMenuEntry {
  const t = pptxT(locale);
  const level = (value: string, label: string) =>
    item(`view.zoom:${value}`, label, {
      checked: value === current,
      disabled: disabled || undefined,
      edits: false,
    });
  return submenu(
    'zoom',
    t('toolbar.groups.zoom'),
    [
      level('fit', t('toolbar.fit')),
      ...ZOOMS.map((zoom) => level(zoom, `${Number(zoom) * 100}%`)),
    ],
    'zoomIn'
  );
}

/** View mode: only what works, so nothing disabled. */
export function viewerMenus(
  locale: OfficeLocale,
  hasSlides: boolean,
  speakerNotes: boolean,
  zoom: string
): OfficeMenu[] {
  const t = pptxT(locale);
  return [
    {
      id: 'file',
      items: fileOutputs(),
      label: m.files_office_pptx_menu_file(),
    },
    ...(hasSlides
      ? [
          {
            id: 'view',
            items: [
              submenu(
                'present',
                t('toolbar.present'),
                presentItems(locale),
                'presentation'
              ),
              zoomMenu(locale, zoom),
              separator,
              item('view.speakerNotes', t('notes.showSpeakerNotes'), {
                checked: speakerNotes,
                edits: false,
              }),
            ],
            label: m.files_office_pptx_menu_view(),
          },
        ]
      : []),
  ];
}
