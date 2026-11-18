import { parseHTML } from 'linkedom';
import { expect, it, vi } from 'vitest';

// linkedom's document goes in before react-dom/client and Radix load.
const { document, window } = parseHTML(
  '<!doctype html><html><body><div id="root"></div></body></html>'
);
class NoResize {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.assign(globalThis, {
  DocumentFragment: window.DocumentFragment,
  document,
  Element: window.Element,
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  HTMLElement: window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
  // The messages' runtime keeps the locale there.
  localStorage: { getItem: () => null, setItem: () => undefined },
  MutationObserver: window.MutationObserver,
  Node: window.Node,
  ResizeObserver: NoResize,
  window,
});

// linkedom cannot send Node's own Event through its tree (it sets fields
// Node's keeps read-only), and has no KeyboardEvent: an event as linkedom's
// dispatch reads one, for the keys sent here and for the events Radix sends
// itself.
class PlainEvent {
  readonly AT_TARGET = 2;
  readonly BUBBLING_PHASE = 3;
  readonly CAPTURING_PHASE = 1;
  readonly NONE = 0;
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  readonly detail: unknown;
  readonly key?: string;
  readonly type: string;
  cancelBubble = false;
  defaultPrevented = false;
  eventPhase = 0;
  target: unknown = null;
  timeStamp = Date.now();
  _path: { currentTarget: unknown }[] = [];
  _stopImmediatePropagationFlag = false;
  constructor(
    type: string,
    init: {
      bubbles?: boolean;
      cancelable?: boolean;
      detail?: unknown;
      key?: string;
    } = {}
  ) {
    this.type = type;
    this.bubbles = !!init.bubbles;
    this.cancelable = !!init.cancelable;
    this.detail = init.detail;
    this.key = init.key;
  }
  composedPath() {
    return this._path.map(({ currentTarget }) => currentTarget);
  }
  preventDefault() {
    this.defaultPrevented = true;
  }
  stopPropagation() {
    this.cancelBubble = true;
  }
}
Object.assign(globalThis, { CustomEvent: PlainEvent, Event: PlainEvent });
const key = (name: string) =>
  new PlainEvent('keydown', {
    bubbles: true,
    cancelable: true,
    key: name,
  }) as unknown as Event;

// A setting's row in a menu (Epo 2026-11-18, the file menu's "Shared with
// members"): the row is the one control, a checkbox item that says its state,
// turned by Enter and by Space, and the menu stays open on it.
it('turns a switch row by Enter and by Space, as one checkbox item that keeps the menu open', async () => {
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { Menu } = await import('./Menu');
  const onClick = vi.fn();
  const tree = (checked: boolean) => (
    <Menu
      items={[
        { label: 'Rename' },
        {
          checked,
          closeOnSelect: false,
          label: 'Shared with members',
          onClick,
          switch: true,
        },
      ]}
    />
  );
  const root = createRoot(document.getElementById('root') as never);
  await act(async () => root.render(tree(false)));
  const trigger = document.querySelector('button') as HTMLButtonElement;
  await act(async () => {
    trigger.dispatchEvent(key('Enter'));
  });

  const row = () =>
    document.querySelector('[role="menuitemcheckbox"]') as HTMLElement;
  expect(row().textContent).toBe('Shared with members');
  expect(row().getAttribute('aria-checked')).toBe('false');
  // One stop: the switch drawn in the row is no control of its own.
  const inner = row().querySelector('[role="switch"]') as HTMLElement;
  expect(inner.getAttribute('aria-hidden')).toBe('true');
  expect(inner.getAttribute('tabindex')).toBe('-1');
  expect(
    [...row().querySelectorAll('button, input, [tabindex]')].filter(
      (node) => node.getAttribute('tabindex') !== '-1'
    )
  ).toEqual([]);

  await act(async () => {
    row().dispatchEvent(key('Enter'));
  });
  expect(onClick).toHaveBeenCalledTimes(1);
  await act(async () => root.render(tree(true)));
  // Still open, on the same row, now on.
  expect(row().getAttribute('aria-checked')).toBe('true');
  await act(async () => {
    row().dispatchEvent(key(' '));
  });
  expect(onClick).toHaveBeenCalledTimes(2);
  expect(row()).not.toBeNull();
  // Any other row closes the menu as it is picked.
  const rename = document.querySelector('[role="menuitem"]') as HTMLElement;
  await act(async () => {
    rename.dispatchEvent(key('Enter'));
  });
  expect(document.querySelector('[role="menuitemcheckbox"]')).toBeNull();
  await act(async () => root.unmount());
});
