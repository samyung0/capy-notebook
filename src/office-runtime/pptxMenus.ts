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

/** Present, as Google Slides' Slideshow button, in both modes. */
export function presentAction(locale: OfficeLocale): OfficeHeaderAction {
  return {
    icon: 'presentation',
    id: 'view.present',
    label: pptxT(locale)('toolbar.present'),
  };
}

/** View mode: only what works, so nothing disabled. */
export function viewerMenus(
  locale: OfficeLocale,
  hasSlides: boolean,
  speakerNotes: boolean
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
              item('view.present', t('toolbar.present'), {
                edits: false,
                icon: 'presentation',
              }),
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
