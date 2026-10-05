import {
  createT,
  deepMerge,
  en,
  type LocaleStrings,
  zhCN,
} from '@betteroffice/xlsx-i18n';
import {
  isXlsxCommand,
  type XlsxCommand,
  type XlsxCommandState,
  type XlsxEditorApi,
  xlsxCommandEdits,
  ZOOM_PERCENTS,
} from '@betteroffice/xlsx-react';
import type { IconName } from '@/components/ui/Icon';
import {
  OFFICE_HOST_COMMANDS,
  type OfficeMenu,
  type OfficeMenuEntry,
} from '@/features/files/officeMenus';
import type { OfficeLocale } from '@/features/files/officeProtocol';

/** The XLSX editor's translations for Capy's locale (English is built in). */
export function xlsxStrings(locale: OfficeLocale) {
  return locale === 'zh' ? zhCN : undefined;
}

function xlsxT(locale: OfficeLocale) {
  return createT(deepMerge(en, xlsxStrings(locale)) as LocaleStrings);
}

const APPLE = /Mac|iPhone|iPad/;

/** "⌘⇧Z" on Apple platforms, "Ctrl+Shift+Z" elsewhere. */
function shortcut(keys: string) {
  const mac = APPLE.test(navigator.platform);
  const parts = keys.split('+');
  const key = parts.pop() ?? '';
  if (mac)
    return (
      parts
        .map((part) => ({ Alt: '⌥', Mod: '⌘', Shift: '⇧' })[part] ?? part)
        .join('') + key
    );
  return [...parts.map((part) => (part === 'Mod' ? 'Ctrl' : part)), key].join(
    '+'
  );
}

const separator: OfficeMenuEntry = { kind: 'separator' };

function item(
  id: string,
  label: string,
  extra: {
    checked?: boolean;
    disabled?: boolean;
    edits: boolean;
    icon?: IconName;
    shortcut?: string;
  }
): OfficeMenuEntry {
  return { id, kind: 'item', label, ...extra };
}

/** An editor command, editing as xlsx-react declares it. */
function command(
  id: XlsxCommand,
  label: string,
  extra: Omit<Parameters<typeof item>[2], 'edits'> = {}
): OfficeMenuEntry {
  return item(id, label, { edits: xlsxCommandEdits(id), ...extra });
}

function submenu(
  id: string,
  label: string,
  items: OfficeMenuEntry[],
  icon?: IconName
): OfficeMenuEntry {
  return icon
    ? { icon, id, items, kind: 'submenu', label }
    : { id, items, kind: 'submenu', label };
}

/** File › Download ▸ .xlsx and PNG, and Print: Capy performs all three. */
function fileItems(t: ReturnType<typeof xlsxT>): OfficeMenuEntry[] {
  return [
    submenu(
      'download',
      t('hostMenus.download'),
      [
        item(OFFICE_HOST_COMMANDS.download, t('hostMenus.excelWorkbook'), {
          edits: false,
        }),
        item(OFFICE_HOST_COMMANDS.png, t('hostMenus.pngImage'), {
          edits: false,
        }),
      ],
      'download'
    ),
    separator,
    item(OFFICE_HOST_COMMANDS.print, t('toolbar.print'), {
      edits: false,
      icon: 'print',
    }),
  ];
}

/** "B" for column 1 (zero-based), as the column header shows it. */
function columnLetter(column: number) {
  let letters = '';
  for (let n = column + 1; n > 0; n = Math.floor((n - 1) / 26))
    letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  return letters;
}

/**
 * The edit-mode menus, after Google Sheets (the 2026-10-03 header mock):
 * editor commands by `XLSX_COMMANDS` id, Save posting the checkpoint, and
 * Capy's download, PNG and print.
 */
export function xlsxEditMenus(
  state: XlsxCommandState,
  locale: OfficeLocale
): OfficeMenu[] {
  const t = xlsxT(locale);
  const { formatting, selection } = state;
  const rows = selection?.rows ?? 1;
  const columns = selection?.columns ?? 1;
  const noSelection = selection === null;
  const run = (
    id: XlsxCommand,
    label: string,
    extra: Parameters<typeof command>[2] = {}
  ) => command(id, label, { disabled: noSelection, ...extra });
  const choice = (id: XlsxCommand, label: string, checked: boolean) =>
    run(id, label, { checked });
  const freeze = (
    axis: 'freezeRows' | 'freezeColumns',
    frozen: number,
    labels: [string, string, string, string]
  ) =>
    ([0, 1, 2, 'current'] as const).map((amount, index) =>
      choice(
        `${axis}:${amount}`,
        labels[index],
        amount !== 'current' && frozen === amount
      )
    );

  return [
    {
      id: 'file',
      items: [
        // Capy takes the checkpoint, as Ctrl/Cmd+S in the frame does.
        item(OFFICE_HOST_COMMANDS.save, t('toolbar.save'), {
          edits: true,
          icon: 'cloudSync',
          shortcut: shortcut('Mod+S'),
        }),
        separator,
        ...fileItems(t),
      ],
      label: t('hostMenus.file'),
    },
    {
      id: 'edit',
      items: [
        command('undo', t('toolbar.undo'), {
          disabled: !state.canUndo,
          icon: 'undo',
          shortcut: shortcut('Mod+Z'),
        }),
        command('redo', t('toolbar.redo'), {
          disabled: !state.canRedo,
          icon: 'redo',
          shortcut: shortcut('Shift+Mod+Z'),
        }),
        separator,
        run('selectAll', t('hostMenus.selectAll'), {
          shortcut: shortcut('Mod+A'),
        }),
        submenu(
          'delete',
          t('hostMenus.delete'),
          [
            run('deleteValues', t('hostMenus.deleteValues')),
            run(
              'deleteRows',
              rows > 1
                ? t('hostMenus.deleteRows', { count: rows })
                : t('hostMenus.deleteRow')
            ),
            run(
              'deleteColumns',
              columns > 1
                ? t('hostMenus.deleteColumns', { count: columns })
                : t('hostMenus.deleteColumn')
            ),
          ],
          'trash'
        ),
      ],
      label: t('hostMenus.edit'),
    },
    {
      id: 'view',
      items: [
        submenu('freeze', t('hostMenus.freeze'), [
          ...freeze('freezeRows', state.frozenRows, [
            t('hostMenus.noRows'),
            t('hostMenus.oneRow'),
            t('hostMenus.twoRows'),
            t('hostMenus.upToRow', { row: (selection?.focusRow ?? 0) + 1 }),
          ]),
          separator,
          ...freeze('freezeColumns', state.frozenColumns, [
            t('hostMenus.noColumns'),
            t('hostMenus.oneColumn'),
            t('hostMenus.twoColumns'),
            t('hostMenus.upToColumn', {
              column: columnLetter(selection?.focusColumn ?? 0),
            }),
          ]),
        ]),
        submenu(
          'zoom',
          t('hostMenus.zoom'),
          ZOOM_PERCENTS.map((percent) =>
            command(`zoom:${percent}`, `${percent}%`, {
              checked: Math.round(state.zoom * 100) === percent,
            })
          ),
          'zoomIn'
        ),
      ],
      label: t('hostMenus.view'),
    },
    {
      id: 'insert',
      items: [
        run(
          'insertRowAbove',
          rows > 1
            ? t('hostMenus.rowsAbove', { count: rows })
            : t('hostMenus.rowAbove')
        ),
        run(
          'insertRowBelow',
          rows > 1
            ? t('hostMenus.rowsBelow', { count: rows })
            : t('hostMenus.rowBelow')
        ),
        separator,
        run(
          'insertColumnLeft',
          columns > 1
            ? t('hostMenus.columnsLeft', { count: columns })
            : t('hostMenus.columnLeft')
        ),
        run(
          'insertColumnRight',
          columns > 1
            ? t('hostMenus.columnsRight', { count: columns })
            : t('hostMenus.columnRight')
        ),
        separator,
        command('insertSheet', t('hostMenus.sheet'), { icon: 'table' }),
      ],
      label: t('hostMenus.insert'),
    },
    {
      id: 'format',
      items: [
        submenu('number', t('hostMenus.number'), [
          ...(['automatic', 'plainText'] as const).map((format) =>
            choice(
              `numberFormat:${format}`,
              t(`toolbar.numberFormats.${format}`),
              formatting.numberFormat === format
            )
          ),
          separator,
          ...(['number', 'percent', 'scientific'] as const).map((format) =>
            choice(
              `numberFormat:${format}`,
              t(`toolbar.numberFormats.${format}`),
              formatting.numberFormat === format
            )
          ),
          separator,
          ...(['currency', 'date', 'time'] as const).map((format) =>
            choice(
              `numberFormat:${format}`,
              t(`toolbar.numberFormats.${format}`),
              formatting.numberFormat === format
            )
          ),
        ]),
        submenu(
          'text',
          t('hostMenus.text'),
          (['bold', 'italic', 'strikethrough'] as const).map((style) =>
            choice(style, t(`toolbar.${style}`), Boolean(formatting[style]))
          ),
          'bold'
        ),
        submenu(
          'alignment',
          t('hostMenus.alignment'),
          [
            ...(['left', 'center', 'right'] as const).map((value) =>
              choice(
                `align:${value}`,
                t(`toolbar.horizontalAlign.${value}`),
                formatting.horizontalAlignment === value
              )
            ),
            separator,
            ...(['top', 'middle', 'bottom'] as const).map((value) =>
              choice(
                `valign:${value}`,
                t(`toolbar.verticalAlign.${value}`),
                formatting.verticalAlignment === value
              )
            ),
          ],
          'alignLeft'
        ),
        submenu(
          'wrapping',
          t('hostMenus.wrapping'),
          (['overflow', 'wrap', 'clip'] as const).map((value) =>
            choice(
              `wrap:${value}`,
              t(`toolbar.wrapping.${value}`),
              formatting.textWrapping === value
            )
          )
        ),
        separator,
        submenu(
          'merge',
          t('hostMenus.mergeCells'),
          [
            run('merge:all', t('toolbar.merge.all'), {
              disabled: !state.canMerge,
            }),
            run('merge:horizontal', t('toolbar.merge.horizontal'), {
              disabled: columns < 2,
            }),
            run('merge:vertical', t('toolbar.merge.vertical'), {
              disabled: rows < 2,
            }),
            separator,
            run('merge:unmerge', t('toolbar.merge.unmerge'), {
              disabled: !state.canUnmerge,
            }),
          ],
          'combine'
        ),
        separator,
        run('clearFormatting', t('hostMenus.clearFormatting'), {
          icon: 'eraser',
        }),
      ],
      label: t('hostMenus.format'),
    },
  ];
}

/**
 * View mode runs Capy's viewer: Download, PNG and Print work there, nothing
 * that edits or zooms does.
 */
export function xlsxViewMenus(locale: OfficeLocale): OfficeMenu[] {
  const t = xlsxT(locale);
  return [{ id: 'file', items: fileItems(t), label: t('hostMenus.file') }];
}

/** Runs an edit-mode menu item: every runtime item's id is an editor command. */
export function runXlsxMenuItem(
  id: string,
  api: Pick<XlsxEditorApi, 'run'> | null
) {
  if (isXlsxCommand(id)) api?.run(id);
}
