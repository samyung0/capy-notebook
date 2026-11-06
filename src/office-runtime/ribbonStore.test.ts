import { expect, it, vi } from 'vitest';
import {
  OFFICE_RIBBON_COMMANDS,
  type OfficeBanner,
  type OfficeMenu,
} from '@/features/files/officeMenus';
import { createRibbonStore, ribbonChrome } from './ribbonStore';

const item = (id: string) => ({
  edits: true,
  id,
  kind: 'item' as const,
  label: id,
});
const menus: OfficeMenu[] = [
  { id: 'file', items: [item('capy.save')], label: 'File' },
  { id: 'edit', items: [item('undo'), item('redo')], label: 'Edit' },
  { id: 'insert', items: [item('insert-image')], label: 'Insert' },
];
const tabCommand = (tab: string) => `${OFFICE_RIBBON_COMMANDS.tab}${tab}`;

function open() {
  const onChange = vi.fn();
  const store = createRibbonStore(onChange);
  store.setMenus(menus, null);
  store.setMounted(true);
  onChange.mockClear();
  return { onChange, store };
}

it('opens on Home, with Undo and Redo and every tab but File', () => {
  const { store } = open();
  expect(ribbonChrome(store.get())).toMatchObject({
    collapsed: false,
    redo: { id: 'redo' },
    tab: 'home',
    undo: { id: 'undo' },
  });
  expect(ribbonChrome(store.get())?.tabs.map((tab) => tab.id)).toEqual([
    'home',
    'edit',
    'insert',
  ]);
});

it('moves between tabs and tells the host', () => {
  const { onChange, store } = open();
  expect(store.command(tabCommand('insert'))).toBe(true);
  expect(store.get().tab).toBe('insert');
  expect(onChange).toHaveBeenCalledTimes(1);
  // Not the ribbon's: the editor's command runs.
  expect(store.command('insert-image')).toBe(false);
});

it('collapsed, a tab opens over the page and no tab is current until then', () => {
  const { store } = open();
  store.command(OFFICE_RIBBON_COMMANDS.collapse);
  expect(ribbonChrome(store.get())).toMatchObject({
    collapsed: true,
    tab: null,
  });

  store.command(tabCommand('insert'));
  expect(store.get()).toMatchObject({ over: true, tab: 'insert' });
  expect(ribbonChrome(store.get())?.tab).toBe('insert');

  // The open tab again closes it; another moves what's over the page.
  store.command(tabCommand('home'));
  expect(store.get()).toMatchObject({ over: true, tab: 'home' });
  store.command(tabCommand('home'));
  expect(store.get().over).toBe(false);

  store.command(tabCommand('home'));
  store.closeOver();
  expect(store.get().over).toBe(false);

  // Keeping it expands the ribbon again.
  store.command(tabCommand('home'));
  store.command(OFFICE_RIBBON_COMMANDS.collapse);
  expect(store.get()).toMatchObject({ collapsed: false, over: false });
});

it("adds a contextual tab, and leaves it for Home when it's gone", () => {
  const { store } = open();
  store.setContexts(['table']);
  expect(ribbonChrome(store.get())?.tabs.at(-1)?.id).toBe('table');
  store.command(tabCommand('table'));
  expect(store.get().tab).toBe('table');
  store.setContexts([]);
  expect(store.get().tab).toBe('home');
});

it('runs an item with its file, and draws only a changed banner', () => {
  const { store } = open();
  const run = vi.fn();
  store.setMenus(menus, run);
  const file = new File(['x'], 'x.png');
  store.run('insert-image', undefined, file);
  expect(run).toHaveBeenCalledWith('insert-image', undefined, file);

  const banner: OfficeBanner = {
    actions: [],
    closeable: true,
    inline: false,
    message: 'Saved elsewhere',
    tone: 'neutral',
  };
  const listener = vi.fn();
  store.subscribe(listener);
  store.setBanner(banner);
  store.setBanner({ ...banner });
  expect(listener).toHaveBeenCalledTimes(1);
  expect(store.get().banner).toEqual(banner);
});

it('offers no tab line while the ribbon is not on screen', () => {
  const { onChange, store } = open();
  store.setMounted(false);
  expect(ribbonChrome(store.get())).toBeNull();
  expect(onChange).toHaveBeenCalledTimes(1);
});

it('draws nothing for menus reported again unchanged, and keeps the newest runner', () => {
  const { store } = open();
  const drawn = vi.fn();
  store.subscribe(drawn);
  const run = vi.fn();
  store.setMenus(structuredClone(menus), run);
  expect(drawn).not.toHaveBeenCalled();
  store.run('undo');
  expect(run).toHaveBeenCalledWith('undo', undefined, undefined);
});

it('restores a swapped view on its tab and collapse, or Home when the tab is gone', () => {
  const store = createRibbonStore(vi.fn());
  store.setMounted(true);
  store.restore({ collapsed: true, tab: 'insert' });
  store.setMenus(menus, null);
  expect(store.get()).toMatchObject({ collapsed: true, tab: 'insert' });
  const gone = createRibbonStore(vi.fn());
  gone.restore({ collapsed: false, tab: 'table' });
  gone.setMenus(menus, null);
  expect(gone.get().tab).toBe('home');
});

it('counts the tab line sending the keyboard in, and opens over the page when collapsed', () => {
  const { store } = open();
  store.command(OFFICE_RIBBON_COMMANDS.collapse);
  expect(store.command(OFFICE_RIBBON_COMMANDS.enter)).toBe(true);
  expect(store.get()).toMatchObject({ focusRequest: 1, over: true });
});
