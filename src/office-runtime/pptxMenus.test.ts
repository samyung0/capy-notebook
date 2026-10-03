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
      expect(isOfficeMenus(viewerMenus(locale, true, false))).toBe(true);
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

  it('offers only working items in view mode', () => {
    const entries = items(
      viewerMenus('en', true, false).flatMap((menu) => menu.items)
    );
    expect(entries.some((entry) => entry.disabled)).toBe(false);
    expect(entries.map((entry) => entry.id)).toEqual([
      'capy.download',
      'capy.png',
      'capy.print',
      'view.present',
      'view.speakerNotes',
    ]);
    // Ticked from the viewer's notes state, as in edit mode.
    const notes = (shown: boolean) =>
      items(viewerMenus('en', true, shown).flatMap((menu) => menu.items)).find(
        (entry) => entry.id === 'view.speakerNotes'
      );
    expect(notes(false)).toMatchObject({
      checked: false,
      label: 'Show speaker notes',
    });
    expect(notes(true)?.checked).toBe(true);
    expect(viewerMenus('en', false, false).map((menu) => menu.id)).toEqual([
      'file',
    ]);
  });

  it('carries a command value after the first colon', () => {
    expect(splitCommand('slide.newWithLayout:/ppt/slideLayouts/a.xml')).toEqual(
      ['slide.newWithLayout', '/ppt/slideLayouts/a.xml']
    );
    expect(splitCommand('slide.delete')).toEqual(['slide.delete', undefined]);
  });
});
