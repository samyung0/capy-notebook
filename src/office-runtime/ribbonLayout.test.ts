import {
  PPTX_COMMAND_IDS,
  RIBBON_CONTROL_NAMES as PPTX_RIBBON_CONTROLS,
  type PptxCommandState,
} from '@betteroffice/pptx-react';
import {
  RIBBON_CONTROL_NAMES as XLSX_RIBBON_CONTROLS,
  type XlsxCommandState,
} from '@betteroffice/xlsx-react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import type { OfficeMenu, OfficeMenuEntry } from '@/features/files/officeMenus';
import {
  type DocxMenuModel,
  HostMenus,
} from '../../vendor/betteroffice/packages/docx-react/src/components/DocxEditor/hostMenus';
import { EditorToolbarContext } from '../../vendor/betteroffice/packages/docx-react/src/components/EditorToolbarContext';
import {
  RIBBON_CONTROL_NAMES as DOCX_RIBBON_CONTROLS,
  type ToolbarProps,
} from '../../vendor/betteroffice/packages/docx-react/src/components/Toolbar';
import { editorMenus as docxEditorMenus } from './docxMenus';
import { DOCX_RIBBON } from './docxRibbon';
import { editorMenus as pptxMenus } from './pptxEditorMenus';
import { PPTX_RIBBON } from './pptxRibbon';
import type { RibbonLayout } from './ribbonLayout';
import { findRibbonCell } from './ribbonStore';
import { xlsxEditMenus } from './xlsxMenus';
import { XLSX_RIBBON } from './xlsxRibbon';

// HostMenus reports from an effect; the server renderer runs it at once here.
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useEffect: (run: () => void) => run(),
}));

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

/** HostMenus' real model, with every table, image and insert command on. */
function docxModel(ctx: Partial<ToolbarProps> = {}) {
  let model: DocxMenuModel | null = null;
  const noop = () => {};
  renderToStaticMarkup(
    createElement(
      EditorToolbarContext.Provider,
      {
        value: {
          currentFormatting: {},
          documentStyles: [
            { name: 'Normal', styleId: 'Normal', type: 'paragraph' },
          ],
          imageContext: {
            cssFloat: null,
            displayMode: 'inline',
            wrapType: 'inline',
          },
          onFormat: noop,
          onInsertImage: noop,
          onInsertPageBreak: noop,
          onInsertSectionBreakContinuous: noop,
          onInsertSectionBreakNextPage: noop,
          onInsertTable: noop,
          onInsertTOC: noop,
          onOpenImageProperties: noop,
          onSave: noop,
          onTableAction: noop,
          onToggleOutline: noop,
          onUpdateTOC: noop,
          onZoomChange: noop,
          tableContext: { isInTable: true },
          zoom: 1,
          ...ctx,
        } as ToolbarProps,
      },
      createElement(HostMenus, {
        actions: {
          onAddComment: noop,
          onEditAction: noop,
          onFindReplace: noop,
          onInsertImageFile: noop,
          onToggleComments: noop,
          onToggleRuler: noop,
          showComments: false,
          showRuler: false,
          zoomFit: false,
        },
        onMenus: (next: DocxMenuModel | null) => {
          model ??= next;
        },
      })
    )
  );
  const reported = model as DocxMenuModel | null;
  if (!reported) throw new Error('HostMenus reported nothing');
  return docxEditorMenus(reported.menus, 'en');
}

/** Every cell of a layout, Home's phone row included, that draws nothing. */
function unresolved(
  layout: RibbonLayout,
  controls: readonly string[],
  menus: readonly OfficeMenu[]
) {
  const groups = [...layout.phoneHome, ...Object.values(layout.tabs).flat()];
  return groups
    .flatMap((group) => [...(group.big ?? []), ...(group.lines ?? []).flat()])
    .map((cell) => (typeof cell === 'string' ? { id: cell } : cell))
    .filter(
      (cell) => !(controls.includes(cell.id) || findRibbonCell(menus, cell))
    )
    .map((cell) => cell.id);
}

/** Named controls no tab draws: a typed name that nothing lays out. */
function unused(layout: RibbonLayout, controls: readonly string[]) {
  const ids = named({
    ...layout,
    tabs: { ...layout.tabs, phone: layout.phoneHome },
  });
  return controls.filter((name) => !ids.has(name));
}

it('DOCX: every menu command is in a tab, from the real HostMenus', () => {
  const tree = docxModel();
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
      'spacing:276': 'lineSpacing',
      'spacing:360': 'lineSpacing',
      'spacing:480': 'lineSpacing',
      strikethrough: 'strike',
      'style:Normal': 'styleGallery',
    })
    // The tab line draws these.
  ).toEqual(['undo', 'redo']);
  expect(unresolved(DOCX_RIBBON, DOCX_RIBBON_CONTROLS, tree)).toEqual([]);
  expect(unused(DOCX_RIBBON, DOCX_RIBBON_CONTROLS)).toEqual([]);
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
  const tree = xlsxEditMenus(state, 'en');
  expect(missing(tree, XLSX_RIBBON, {})).toEqual(['undo', 'redo']);
  expect(unresolved(XLSX_RIBBON, XLSX_RIBBON_CONTROLS, tree)).toEqual([]);
  expect(unused(XLSX_RIBBON, XLSX_RIBBON_CONTROLS)).toEqual([]);
});

it('PPTX: every menu command is in a tab', () => {
  const state: PptxCommandState = {
    activeShape: null,
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
  const tree = pptxMenus(state, 'en');
  expect(unresolved(PPTX_RIBBON, PPTX_RIBBON_CONTROLS, tree)).toEqual([]);
  expect(unused(PPTX_RIBBON, PPTX_RIBBON_CONTROLS)).toEqual([]);
  // A deck with no slides has no layouts to list: New slide stays, whole.
  expect(
    unresolved(
      PPTX_RIBBON,
      PPTX_RIBBON_CONTROLS,
      pptxMenus({ ...state, slideLayouts: [] }, 'en')
    )
    // The Slide tab's gallery is those layouts, so it goes with them.
  ).toEqual(['new-slide-layout']);
  expect(
    missing(tree, PPTX_RIBBON, {
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
