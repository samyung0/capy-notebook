import {
  PPTX_COMMAND_IDS,
  type PptxCommandState,
} from '@betteroffice/pptx-react';
import type { XlsxCommandState } from '@betteroffice/xlsx-react';
import { expect, it } from 'vitest';
import type { OfficeMenu, OfficeMenuEntry } from '@/features/files/officeMenus';
import { DOCX_RIBBON } from './docxRibbon';
import { editorMenus as pptxMenus } from './pptxEditorMenus';
import { PPTX_RIBBON } from './pptxRibbon';
import type { RibbonLayout } from './ribbonLayout';
import { xlsxEditMenus } from './xlsxMenus';
import { XLSX_RIBBON } from './xlsxRibbon';

/** Every id a ribbon's tabs name. */
function named(layout: RibbonLayout) {
  const ids = new Set<string>();
  for (const groups of Object.values(layout.tabs))
    for (const group of groups)
      for (const cell of [...(group.big ?? []), ...(group.lines ?? []).flat()])
        if (typeof cell === 'string') ids.add(cell);
        else {
          ids.add(cell.id);
          if (cell.split) ids.add(cell.split);
        }
  return ids;
}

/** Items no cell names or lists: an item's submenu or its control covers it. */
function missing(
  menus: readonly OfficeMenu[],
  layout: RibbonLayout,
  controls: Record<string, string>
) {
  const ids = named(layout);
  const covered = (id: string) => ids.has(id) || ids.has(controls[id]);
  const walk = (entries: readonly OfficeMenuEntry[]): string[] =>
    entries.flatMap((entry) => {
      if (entry.kind === 'separator') return [];
      if (covered(entry.id)) return [];
      return entry.kind === 'submenu' ? walk(entry.items) : [entry.id];
    });
  return menus
    .filter((menu) => menu.id !== 'file')
    .flatMap((menu) => walk(menu.items));
}

it('DOCX: every menu command is in a tab', () => {
  const item = (id: string): OfficeMenuEntry => ({
    edits: true,
    id,
    kind: 'item',
    label: id,
  });
  const list = (id: string, items: string[]): OfficeMenuEntry => ({
    id,
    items: items.map(item),
    kind: 'submenu',
    label: id,
  });
  // HostMenus' tree (fork, DocxEditor/hostMenus.tsx), Capy's cuts made.
  const tree: OfficeMenu[] = [
    {
      id: 'edit',
      items: ['undo', 'redo', 'select-all', 'delete', 'find-replace'].map(item),
      label: 'Edit',
    },
    {
      id: 'view',
      items: [
        item('show-ruler'),
        item('show-outline'),
        item('show-comments'),
        list('zoom', ['zoom:100']),
      ],
      label: 'View',
    },
    {
      id: 'insert',
      items: [
        item('insert-image'),
        list('insert-table', []),
        item('insert-link'),
        item('insert-comment'),
        list('insert-break', [
          'insert-page-break',
          'insert-section-next',
          'insert-section-continuous',
        ]),
        item('insert-toc'),
        item('update-toc'),
      ],
      label: 'Insert',
    },
    {
      id: 'format',
      items: [
        list('format-text', [
          'bold',
          'italic',
          'underline',
          'strikethrough',
          'superscript',
          'subscript',
        ]),
        list('format-styles', ['style:Normal']),
        list('format-align', [
          'align:left',
          'align:center',
          'align:right',
          'align:both',
          'indent',
          'outdent',
        ]),
        list('format-spacing', ['spacing:240']),
        list('format-lists', ['bulletList', 'numberedList']),
        list('format-direction', ['ltr', 'rtl']),
        list('format-table', [
          'table-vertical-align',
          'table-alignment',
          'table-header-row',
          'table-wrap-text',
          'table-distribute',
          'table-autofit',
          'table-properties',
        ]),
        item('image-options'),
        item('clearFormatting'),
      ],
      label: 'Format',
    },
  ];
  expect(
    missing(tree, DOCX_RIBBON, {
      'align:both': 'alignJustify',
      'align:center': 'alignCenter',
      'align:left': 'alignLeft',
      'align:right': 'alignRight',
      bulletList: 'lists',
      'image-options': 'imageProperties',
      indent: 'lists',
      numberedList: 'lists',
      outdent: 'lists',
      'spacing:240': 'lineSpacing',
      strikethrough: 'strike',
      'style:Normal': 'styleGallery',
    })
    // The tab line draws these.
  ).toEqual(['undo', 'redo']);
});

it('XLSX: every menu command is in a tab', () => {
  const state: XlsxCommandState = {
    canMerge: true,
    canRedo: true,
    canUndo: true,
    canUnmerge: true,
    formatting: {},
    frozenColumns: 0,
    frozenRows: 0,
    selection: { columns: 1, focusColumn: 0, focusRow: 0, rows: 1 },
    zoom: 1,
  };
  expect(missing(xlsxEditMenus(state, 'en'), XLSX_RIBBON, {})).toEqual([
    'undo',
    'redo',
  ]);
});

it('PPTX: every menu command is in a tab', () => {
  const state: PptxCommandState = {
    borderWeight: null,
    checked: [],
    enabled: Object.fromEntries(
      PPTX_COMMAND_IDS.map((id) => [id, true])
    ) as PptxCommandState['enabled'],
    lineSpacing: null,
    listStyle: null,
    slideIndex: 0,
    slideLayouts: [{ label: 'Title', value: '/layout1.xml' }],
    zoom: 'fit',
  };
  const lists = (name: string, styles: string[]) =>
    Object.fromEntries(
      styles.map((style) => [`format.${name}:${style}`, name])
    );
  expect(
    missing(pptxMenus(state, 'en'), PPTX_RIBBON, {
      'format.bold': 'bold',
      'format.clearFormatting': 'clearFormatting',
      'format.italic': 'italic',
      'format.underline': 'underline',
      ...lists('bulletedList', ['arrow', 'bullet', 'dash', 'disc', 'square']),
      ...lists('numberedList', [
        'decimal',
        'paren',
        'upperAlpha',
        'upperRoman',
      ]),
    })
  ).toEqual(['edit.undo', 'edit.redo']);
});
