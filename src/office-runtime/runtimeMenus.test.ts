import {
  PPTX_COMMAND_IDS,
  type PptxCommandState,
} from '@betteroffice/pptx-react';
import { describe, expect, it } from 'vitest';
import type { OfficeMenu } from '@/features/files/officeMenus';
import { editorMenus } from './pptxEditorMenus';
import { presentAction } from './pptxMenus';
import { pausedMenus, runsWhilePaused } from './runtimeMenus';

const edit = (id: string) => ({
  edits: true,
  id,
  kind: 'item' as const,
  label: id,
});
const read = (id: string) => ({ ...edit(id), edits: false });
const MENUS: OfficeMenu[] = [
  {
    id: 'file',
    items: [
      edit('capy.save'),
      {
        id: 'download',
        items: [read('capy.download')],
        kind: 'submenu',
        label: 'Download',
      },
      read('capy.print'),
    ],
    label: 'File',
  },
  {
    id: 'edit',
    items: [
      edit('undo'),
      read('select-all'),
      { ...read('find-replace'), disabled: true },
    ],
    label: 'Edit',
  },
  {
    id: 'insert',
    items: [
      {
        id: 'insert-break',
        items: [edit('insert-page-break')],
        kind: 'submenu',
        label: 'Break',
      },
      {
        id: 'insert-table',
        items: [{ id: 'insert-table', kind: 'grid' }],
        kind: 'submenu',
        label: 'Table',
      },
    ],
    label: 'Insert',
  },
  {
    id: 'view',
    items: [
      read('zoom:100'),
      {
        id: 'freeze',
        items: [edit('freezeRows:1')],
        kind: 'submenu',
        label: 'Freeze',
      },
    ],
    label: 'View',
  },
];

describe('menus while editing is paused', () => {
  it('disables the items that edit and keeps the read-only ones as they are', () => {
    const [file, editMenu, insert, view] = pausedMenus(MENUS);
    expect(file.items).toMatchObject([
      { disabled: true, id: 'capy.save' },
      { disabled: false, id: 'download', items: [{ id: 'capy.download' }] },
      { id: 'capy.print' },
    ]);
    expect(file.items[2]).not.toHaveProperty('disabled');
    expect(editMenu.items).toMatchObject([
      { disabled: true, id: 'undo' },
      { id: 'select-all' },
      // The editor's own state still holds.
      { disabled: true, id: 'find-replace' },
    ]);
    expect(editMenu.items[1]).not.toHaveProperty('disabled');
    // A submenu with nothing left to run (the table grid included) is disabled.
    expect(insert.items).toMatchObject([
      { disabled: true, id: 'insert-break' },
      { disabled: true, id: 'insert-table' },
    ]);
    // XLSX declares freezing panes an edit, even under View.
    expect(view.items).toMatchObject([
      { id: 'zoom:100' },
      { disabled: true, id: 'freeze' },
    ]);
  });

  it('runs header actions and items that do not edit, nothing else', () => {
    const source = {
      actions: [
        { icon: 'presentation' as const, id: 'view.present', label: 'Present' },
      ],
      menus: MENUS,
      run: () => {},
    };
    expect(runsWhilePaused(source, 'zoom:100')).toBe(true);
    expect(runsWhilePaused(source, 'select-all')).toBe(true);
    expect(runsWhilePaused(source, 'view.present')).toBe(true);
    expect(runsWhilePaused(source, 'undo')).toBe(false);
    expect(runsWhilePaused(source, 'insert-page-break')).toBe(false);
    expect(runsWhilePaused(source, 'insert-table')).toBe(false);
    expect(runsWhilePaused(source, 'freezeRows:1')).toBe(false);
    expect(runsWhilePaused(source, 'unknown')).toBe(false);
    expect(runsWhilePaused(null, 'zoom:100')).toBe(false);
  });

  it('keeps every way to present running while a PPTX editor is paused', () => {
    const enabled = Object.fromEntries(
      PPTX_COMMAND_IDS.map((id) => [id, true])
    ) as PptxCommandState['enabled'];
    const menus = pausedMenus(
      editorMenus(
        {
          borderWeight: null,
          checked: [],
          enabled,
          lineSpacing: null,
          listStyle: null,
          slideIndex: 0,
          slideLayouts: [],
          zoom: 'fit',
        },
        'en'
      )
    );
    const view = menus.find((menu) => menu.id === 'view')!;
    expect(view.items[0]).toMatchObject({
      disabled: false,
      id: 'present',
      items: [
        { id: 'view.present' },
        { id: 'view.present:start' },
        { kind: 'separator' },
        { id: 'view.presenterView' },
      ],
    });
    for (const entry of (view.items[0] as { items: { disabled?: boolean }[] })
      .items)
      expect(entry.disabled).toBeFalsy();
    const source = { actions: [presentAction('en')], menus, run: () => {} };
    for (const id of [
      'view.present',
      'view.present:start',
      'view.presenterView',
    ])
      expect(runsWhilePaused(source, id)).toBe(true);
    // An action's items run too when no menu lists them.
    expect(
      runsWhilePaused(
        { actions: [presentAction('en')], menus: [], run: () => {} },
        'view.presenterView'
      )
    ).toBe(true);
  });
});
