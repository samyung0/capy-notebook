import { describe, expect, it } from 'vitest';
import type { OfficeMenu } from '@/features/files/officeMenus';
import { pausedMenus, runsWhilePaused } from './runtimeMenus';

const item = (id: string) => ({ id, kind: 'item' as const, label: id });
const MENUS: OfficeMenu[] = [
  {
    id: 'file',
    items: [
      item('capy.save'),
      {
        id: 'download',
        items: [item('capy.download')],
        kind: 'submenu',
        label: 'Download',
      },
      item('capy.print'),
    ],
    label: 'File',
  },
  {
    id: 'insert',
    items: [
      {
        id: 'insert-break',
        items: [item('insert-page-break')],
        kind: 'submenu',
        label: 'Break',
      },
      {
        id: 'insert-table',
        items: [{ id: 'table', kind: 'grid' }],
        kind: 'submenu',
        label: 'Table',
      },
    ],
    label: 'Insert',
  },
  {
    id: 'view',
    items: [
      item('zoom:100'),
      {
        id: 'freeze',
        items: [item('freezeRows:1')],
        kind: 'submenu',
        label: 'Freeze',
      },
    ],
    label: 'View',
  },
];

describe('menus while editing is paused', () => {
  it('disables editing items and File › Save, keeping Download, Print and View', () => {
    const [file, insert, view] = pausedMenus(MENUS);
    expect(file.items).toMatchObject([
      { disabled: true, id: 'capy.save' },
      { disabled: false, id: 'download', items: [{ id: 'capy.download' }] },
      { id: 'capy.print' },
    ]);
    expect(file.items[2]).not.toHaveProperty('disabled');
    // A submenu with nothing left to run (the table grid included) is disabled.
    expect(insert.items).toMatchObject([
      { disabled: true, id: 'insert-break' },
      { disabled: true, id: 'insert-table' },
    ]);
    // XLSX freezes panes in the workbook: an edit, even under View.
    expect(view.items).toMatchObject([
      { id: 'zoom:100' },
      { disabled: true, id: 'freeze' },
    ]);
  });

  it('lets only View, header actions and the outputs through', () => {
    const source = {
      actions: [
        { icon: 'presentation' as const, id: 'view.present', label: 'Present' },
      ],
      menus: MENUS,
      run: () => {},
    };
    expect(runsWhilePaused(source, 'zoom:100')).toBe(true);
    expect(runsWhilePaused(source, 'view.present')).toBe(true);
    expect(runsWhilePaused(source, 'capy.print')).toBe(true);
    expect(runsWhilePaused(source, 'insert-page-break')).toBe(false);
    expect(runsWhilePaused(source, 'freezeRows:1')).toBe(false);
    expect(runsWhilePaused(null, 'zoom:100')).toBe(false);
  });
});
