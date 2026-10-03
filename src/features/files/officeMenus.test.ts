import { describe, expect, it } from 'vitest';
import {
  ariaKeyShortcut,
  fitOfficeMenus,
  isOfficeMenus,
  OFFICE_HOST_COMMANDS,
  type OfficeMenu,
  officeItemAction,
} from './officeMenus';

describe('Office menu items on the host', () => {
  it("runs Capy's own ids itself, opens Capy's picker for a pick item and sends the rest", () => {
    expect(officeItemAction({ id: OFFICE_HOST_COMMANDS.save })).toEqual({
      command: 'save',
      kind: 'host',
    });
    expect(officeItemAction({ id: OFFICE_HOST_COMMANDS.print })).toEqual({
      command: 'print',
      kind: 'host',
    });
    expect(officeItemAction({ id: 'insert-image', pick: 'image' })).toEqual({
      accept: 'image/*',
      kind: 'pick',
    });
    expect(officeItemAction({ id: 'insert-page-break' })).toEqual({
      kind: 'runtime',
    });
    // Only the exact ids are Capy's.
    expect(officeItemAction({ id: 'capy.saveAs' })).toEqual({
      kind: 'runtime',
    });
  });

  it('drops an oversized submenu, not the menu bar', () => {
    const item = (id: string) => ({ id, kind: 'item' as const, label: id });
    const menus: OfficeMenu[] = [
      {
        id: 'format',
        items: [
          item('bold'),
          {
            id: 'styles',
            items: Array.from({ length: 81 }, (_, index) => item(`s${index}`)),
            kind: 'submenu',
            label: 'Styles',
          },
        ],
        label: 'Format',
      },
    ];
    expect(isOfficeMenus(menus)).toBe(true);
    expect(fitOfficeMenus(menus)[0].items).toEqual([item('bold')]);
  });

  it('names shortcuts for aria-keyshortcuts on Mac and elsewhere', () => {
    expect(ariaKeyShortcut('⌘⇧V')).toBe('Meta+Shift+V');
    expect(ariaKeyShortcut('Ctrl+Shift+V')).toBe('Control+Shift+V');
    expect(ariaKeyShortcut('Del')).toBe('Delete');
  });
});
