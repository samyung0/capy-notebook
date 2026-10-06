import {
  PPTX_COMMAND_IDS,
  type PptxCommandState,
} from '@betteroffice/pptx-react';
import { describe, expect, it } from 'vitest';
import {
  isOfficeHeaderActions,
  isOfficeMenus,
  type OfficeMenuEntry,
} from '@/features/files/officeMenus';
import { editorMenus, splitCommand } from './pptxEditorMenus';
import { presentAction, viewerMenus } from './pptxMenus';

const state = (
  enabled: boolean,
  extra: Partial<PptxCommandState> = {}
): PptxCommandState => ({
  borderWeight: null,
  checked: [],
  enabled: Object.fromEntries(
    PPTX_COMMAND_IDS.map((id) => [id, enabled])
  ) as PptxCommandState['enabled'],
  lineSpacing: null,
  listStyle: null,
  slideIndex: 0,
  slideLayouts: [
    { label: 'Layout 1', value: '/ppt/slideLayouts/slideLayout1.xml' },
  ],
  zoom: 'fit',
  ...extra,
});

function items(
  entries: OfficeMenuEntry[]
): Extract<OfficeMenuEntry, { kind: 'item' }>[] {
  return entries.flatMap((entry) =>
    entry.kind === 'item'
      ? [entry]
      : entry.kind === 'submenu'
        ? items(entry.items)
        : []
  );
}

describe('PPTX header menus', () => {
  it('are a valid menu bar in both locales, the Present action included', () => {
    for (const locale of ['en', 'zh'] as const) {
      expect(isOfficeMenus(editorMenus(state(true), locale))).toBe(true);
      expect(isOfficeMenus(viewerMenus(locale, true, false, 'fit'))).toBe(true);
      expect(isOfficeHeaderActions([presentAction(locale)])).toBe(true);
    }
  });

  it('disables and ticks edit items from the command state', () => {
    const menus = editorMenus(
      state(false, {
        checked: ['format.bold', 'view.speakerNotes'],
        zoom: '1.5',
      }),
      'en'
    );
    const all = items(menus.flatMap((menu) => menu.items));
    const byId = (id: string) => all.find((entry) => entry.id === id);
    expect(byId('slide.delete')?.disabled).toBe(true);
    expect(byId('format.bold')?.checked).toBe(true);
    expect(byId('format.italic')?.checked).toBe(false);
    expect(byId('view.zoom:1.5')?.checked).toBe(true);
    expect(byId('view.speakerNotes')).toMatchObject({
      checked: true,
      label: 'Show speaker notes',
    });
    expect(byId('insert.image')?.pick).toBe('image');
    // Capy saves, so Save stays available whatever the editor reports.
    expect(menus[0].items[0]).toMatchObject({ id: 'capy.save', label: 'Save' });
    expect(byId('capy.save')?.disabled).toBeUndefined();
    expect(menus.map((menu) => menu.label)).toEqual([
      'File',
      'Edit',
      'View',
      'Insert',
      'Format',
      'Slide',
      'Arrange',
    ]);
  });

  it('takes whether each item edits from pptx-react', () => {
    const all = items(
      editorMenus(state(true), 'en').flatMap((menu) => menu.items)
    );
    const reads = all.filter((entry) => !entry.edits).map((entry) => entry.id);
    expect(reads).toEqual([
      'capy.download',
      'capy.png',
      'capy.print',
      'edit.selectAll',
      'view.present',
      'view.present:start',
      'view.presenterView',
      'view.zoom:fit',
      'view.zoom:0.5',
      'view.zoom:0.75',
      'view.zoom:1',
      'view.zoom:1.25',
      'view.zoom:1.5',
      'view.zoom:2',
      'view.speakerNotes',
    ]);
  });

  it('offers the text and object operations Google Slides has', () => {
    const menus = editorMenus(
      state(true, {
        checked: [
          'format.bulletedList',
          'format.spaceBefore',
          'format.alignMiddle',
        ],
        lineSpacing: '1.5',
        listStyle: 'disc',
      }),
      'en'
    );
    const all = items(menus.flatMap((menu) => menu.items));
    const byId = (id: string) => all.find((entry) => entry.id === id);
    expect(
      menus[1].items.flatMap((entry) =>
        entry.kind === 'item' ? [entry.id] : []
      )
    ).toEqual(['edit.undo', 'edit.redo', 'edit.selectAll', 'edit.delete']);
    expect(byId('edit.selectAll')?.label).toBe('Select all');
    for (const id of [
      'format.strikethrough',
      'format.superscript',
      'format.subscript',
      'format.increaseFontSize',
      'format.decreaseFontSize',
      'format.increaseIndent',
      'format.decreaseIndent',
      'format.clearFormatting',
    ])
      expect(byId(id)).toBeDefined();
    expect(byId('format.alignMiddle')?.checked).toBe(true);
    expect(byId('format.alignTop')?.checked).toBe(false);
    // The styles tick only in the list kind the selection is in.
    expect(byId('format.bulletedList:disc')).toMatchObject({
      checked: true,
      label: '● ○ ■',
    });
    expect(byId('format.bulletedList:bullet')?.checked).toBe(false);
    expect(byId('format.numberedList:decimal')).toMatchObject({
      checked: false,
      label: '1. a. i.',
    });
    expect(byId('format.lineSpacing:1.5')?.checked).toBe(true);
    expect(byId('format.lineSpacing:1')).toMatchObject({
      checked: false,
      label: 'Single',
    });
    expect(byId('format.spaceBefore')?.label).toBe(
      'Remove space before paragraph'
    );
    expect(byId('format.spaceAfter')?.label).toBe('Add space after paragraph');
    expect(
      all
        .filter((entry) => entry.id.startsWith('arrange.'))
        .map((entry) => entry.id)
    ).toEqual([
      'arrange.bringToFront',
      'arrange.bringForward',
      'arrange.sendBackward',
      'arrange.sendToBack',
      'arrange.align:left',
      'arrange.align:center',
      'arrange.align:right',
      'arrange.align:top',
      'arrange.align:middle',
      'arrange.align:bottom',
      'arrange.distribute:horizontal',
      'arrange.distribute:vertical',
      'arrange.centerOnPage:horizontal',
      'arrange.centerOnPage:vertical',
    ]);
  });

  it('offers only working items in view mode', () => {
    const entries = items(
      viewerMenus('en', true, false, 'fit').flatMap((menu) => menu.items)
    );
    expect(entries.some((entry) => entry.disabled)).toBe(false);
    expect(entries.map((entry) => entry.id)).toEqual([
      'capy.download',
      'capy.png',
      'capy.print',
      'view.present',
      'view.present:start',
      'view.presenterView',
      'view.zoom:fit',
      'view.zoom:0.5',
      'view.zoom:0.75',
      'view.zoom:1',
      'view.zoom:1.25',
      'view.zoom:1.5',
      'view.zoom:2',
      'view.speakerNotes',
    ]);
    // Ticked from the viewer's notes state, as in edit mode.
    const notes = (shown: boolean) =>
      items(
        viewerMenus('en', true, shown, 'fit').flatMap((menu) => menu.items)
      ).find((entry) => entry.id === 'view.speakerNotes');
    expect(notes(false)).toMatchObject({
      checked: false,
      label: 'Show speaker notes',
    });
    expect(notes(true)?.checked).toBe(true);
    expect(
      viewerMenus('en', false, false, 'fit').map((menu) => menu.id)
    ).toEqual(['file']);
  });

  it('ticks the zoom in both modes, the same levels, none of them editing', () => {
    const zooms = (menus: ReturnType<typeof viewerMenus>) =>
      items(menus.flatMap((menu) => menu.items)).filter((entry) =>
        entry.id.startsWith('view.zoom:')
      );
    const view = zooms(viewerMenus('en', true, false, '1.5'));
    const edit = zooms(editorMenus(state(true, { zoom: '1.5' }), 'en'));
    expect(view).toEqual(edit);
    expect(
      view.filter((entry) => entry.checked).map((entry) => entry.id)
    ).toEqual(['view.zoom:1.5']);
    expect(view.every((entry) => !entry.edits)).toBe(true);
  });

  it("makes Present a split button with Google Slides' three ways to present, also under View", () => {
    const expected = [
      {
        fullscreen: true,
        icon: 'presentation',
        id: 'view.present',
        label: 'From this slide',
      },
      { fullscreen: true, id: 'view.present:start', label: 'From the start' },
      { kind: 'separator' },
      {
        icon: 'speakerNotes',
        id: 'view.presenterView',
        label: 'Presenter view',
        popup: 'presenter',
      },
    ];
    const action = presentAction('en');
    expect(action).toMatchObject({
      fullscreen: true,
      icon: 'presentation',
      id: 'view.present',
      label: 'Present',
    });
    expect(action.items).toMatchObject(expected);
    expect(items(action.items ?? []).every((entry) => !entry.edits)).toBe(true);
    const present = (menus: ReturnType<typeof viewerMenus>) =>
      menus
        .find((menu) => menu.id === 'view')
        ?.items.find((entry) => entry.kind === 'submenu');
    expect(present(viewerMenus('en', true, false, 'fit'))).toMatchObject({
      icon: 'presentation',
      items: expected,
      label: 'Present',
    });
    expect(present(editorMenus(state(true), 'en'))?.items).toMatchObject(
      expected
    );
    // A deck without slides has nothing to present.
    expect(
      items(present(editorMenus(state(false), 'en'))?.items ?? []).every(
        (entry) => entry.disabled
      )
    ).toBe(true);
    // The editor's action in a deck without slides.
    expect(
      items(presentAction('en', true).items ?? []).every(
        (entry) => entry.disabled
      )
    ).toBe(true);
    expect(presentAction('zh').items).toMatchObject([
      { label: '从当前幻灯片开始' },
      { label: '从头开始' },
      { kind: 'separator' },
      { label: '演示者视图' },
    ]);
  });

  it('carries a command value after the first colon', () => {
    expect(splitCommand('slide.newWithLayout:/ppt/slideLayouts/a.xml')).toEqual(
      ['slide.newWithLayout', '/ppt/slideLayouts/a.xml']
    );
    expect(splitCommand('slide.delete')).toEqual(['slide.delete', undefined]);
  });
});
