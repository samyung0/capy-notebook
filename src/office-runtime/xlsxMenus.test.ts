import { XLSX_COMMANDS, type XlsxCommandState } from '@betteroffice/xlsx-react';
import { expect, it, vi } from 'vitest';
import {
  OFFICE_HOST_COMMANDS,
  type OfficeMenu,
  type OfficeMenuEntry,
} from '@/features/files/officeMenus';
import { runXlsxMenuItem, xlsxEditMenus, xlsxViewMenus } from './xlsxMenus';

type Item = Extract<OfficeMenuEntry, { kind: 'item' }>;

function items(entries: OfficeMenuEntry[]): Item[] {
  return entries.flatMap((entry) =>
    entry.kind === 'item'
      ? [entry]
      : entry.kind === 'submenu'
        ? items(entry.items)
        : []
  );
}

const all = (menus: OfficeMenu[]) => menus.flatMap((menu) => items(menu.items));
const byId = (menus: OfficeMenu[], id: string) =>
  all(menus).find((entry) => entry.id === id);

const state: XlsxCommandState = {
  canMerge: true,
  canRedo: false,
  canUndo: true,
  canUnmerge: false,
  formatting: { bold: true, numberFormat: 'percent', textWrapping: 'wrap' },
  frozenColumns: 0,
  frozenRows: 1,
  selection: { columns: 1, focusColumn: 2, focusRow: 4, rows: 3 },
  zoom: 1.25,
};

it("offers every editor command once, and Capy's save, download, PNG and print", () => {
  const menus = xlsxEditMenus(state, 'en');
  expect(menus.map((menu) => menu.label)).toEqual([
    'File',
    'Edit',
    'View',
    'Insert',
    'Format',
  ]);
  const ids = all(menus).map((entry) => entry.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids.filter((id) => !id.startsWith('capy.')).sort()).toEqual(
    [...XLSX_COMMANDS].sort()
  );
  for (const id of Object.values(OFFICE_HOST_COMMANDS))
    expect(ids).toContain(id);
});

it('labels counts and checks and enables items from the editor state', () => {
  const menus = xlsxEditMenus(state, 'en');
  expect(byId(menus, 'insertRowAbove')?.label).toBe('3 rows above');
  expect(byId(menus, 'insertColumnLeft')?.label).toBe('Column left');
  expect(byId(menus, 'freezeRows:current')?.label).toBe('Up to row 5');
  expect(byId(menus, 'freezeColumns:current')?.label).toBe('Up to column C');
  expect(byId(menus, 'undo')?.disabled).toBe(false);
  expect(byId(menus, 'redo')?.disabled).toBe(true);
  expect(byId(menus, 'bold')?.checked).toBe(true);
  expect(byId(menus, 'numberFormat:percent')?.checked).toBe(true);
  expect(byId(menus, 'wrap:clip')?.checked).toBe(false);
  expect(byId(menus, 'zoom:125')?.checked).toBe(true);
  expect(byId(menus, 'freezeRows:1')?.checked).toBe(true);
  expect(byId(menus, 'merge:horizontal')?.disabled).toBe(true);
  expect(byId(menus, 'merge:unmerge')?.disabled).toBe(true);
  expect(byId(menus, OFFICE_HOST_COMMANDS.save)?.checked).toBeUndefined();
  const none = xlsxEditMenus({ ...state, selection: null }, 'en');
  expect(byId(none, 'deleteRows')?.disabled).toBe(true);
  expect(byId(none, 'insertSheet')?.disabled).toBeUndefined();
});

it('speaks Chinese for zh', () => {
  const menus = xlsxEditMenus(state, 'zh');
  expect(menus.map((menu) => menu.label)).toEqual([
    '文件',
    '编辑',
    '查看',
    '插入',
    '格式',
  ]);
  expect(byId(menus, 'insertRowAbove')?.label).toBe('在上方插入 3 行');
  expect(byId(menus, 'bold')?.label).toBe('粗体');
});

it('offers view mode only what works there, nothing disabled', () => {
  const menus = xlsxViewMenus('en');
  expect(all(menus).map((entry) => entry.id)).toEqual([
    OFFICE_HOST_COMMANDS.download,
    OFFICE_HOST_COMMANDS.png,
    OFFICE_HOST_COMMANDS.print,
  ]);
  expect(all(menus).some((entry) => entry.disabled)).toBe(false);
});

it('runs editor commands and leaves Capy its own items', () => {
  const run = vi.fn();
  runXlsxMenuItem('freezeRows:2', { run });
  runXlsxMenuItem(OFFICE_HOST_COMMANDS.save, { run });
  runXlsxMenuItem(OFFICE_HOST_COMMANDS.print, { run });
  expect(run.mock.calls).toEqual([['freezeRows:2']]);
});
