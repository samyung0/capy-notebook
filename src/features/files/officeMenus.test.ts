import { describe, expect, it } from 'vitest';
import {
  ariaKeyShortcut,
  fitOfficeMenus,
  isOfficeMenus,
  OFFICE_HOST_COMMANDS,
  type OfficeMenu,
  officeCommandNeeds,
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
    const item = (id: string) => ({
      edits: false,
      id,
      kind: 'item' as const,
      label: id,
    });
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

  it('takes radio items and refuses a radio flag that is not a boolean', () => {
    const menu = (radio: unknown) => [
      {
        id: 'format',
        items: [
          {
            checked: true,
            edits: true,
            id: 'table-align:left',
            kind: 'item',
            label: 'Left',
            radio,
          },
        ],
        label: 'Format',
      },
    ];
    expect(isOfficeMenus(menu(true))).toBe(true);
    expect(isOfficeMenus(menu('yes'))).toBe(false);
  });

  it('hands over full screen or opens the presenter window first for the items that ask', () => {
    const present = (id: string, extra: object) => ({
      edits: false,
      id,
      kind: 'item' as const,
      label: id,
      ...extra,
    });
    const menus = {
      actions: [
        {
          fullscreen: true,
          icon: 'presentation' as const,
          id: 'view.present',
          items: [present('view.present:start', { fullscreen: true })],
          label: 'Present',
        },
      ],
      menus: [
        {
          id: 'view',
          items: [
            {
              id: 'present',
              items: [present('view.presenterView', { popup: 'presenter' })],
              kind: 'submenu' as const,
              label: 'Present',
            },
            present('view.speakerNotes', {}),
          ],
          label: 'View',
        },
      ],
    };
    expect(officeCommandNeeds(menus, 'view.present')).toEqual({
      fullscreen: true,
    });
    expect(officeCommandNeeds(menus, 'view.present:start')).toEqual({
      fullscreen: true,
      popup: undefined,
    });
    expect(officeCommandNeeds(menus, 'view.presenterView')).toEqual({
      fullscreen: false,
      popup: 'presenter',
    });
    expect(officeCommandNeeds(menus, 'view.speakerNotes')).toEqual({
      fullscreen: false,
      popup: undefined,
    });
    expect(officeCommandNeeds(null, 'view.present')).toEqual({
      fullscreen: false,
      popup: undefined,
    });
  });

  it('names shortcuts for aria-keyshortcuts on Mac and elsewhere', () => {
    expect(ariaKeyShortcut('⌘⇧V')).toBe('Meta+Shift+V');
    expect(ariaKeyShortcut('Ctrl+Shift+V')).toBe('Control+Shift+V');
    expect(ariaKeyShortcut('Del')).toBe('Delete');
  });
});
