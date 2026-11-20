import { parseHTML } from 'linkedom';
import { expect, it, vi } from 'vitest';

// linkedom's document goes in before react-dom/client loads.
const { document, window } = parseHTML(
  '<!doctype html><html><body><div id="root"></div></body></html>'
);
// Where each part of the pill lies, by its class: the copy one 40px row, and
// a button at 44px has wrapped below it.
const tops = new Map<string, number>();
Object.defineProperties(window.HTMLElement.prototype, {
  offsetHeight: {
    get(this: HTMLElement) {
      return this.className === 'tst-copy' ? 40 : 30;
    },
  },
  offsetTop: {
    get(this: HTMLElement) {
      return tops.get(this.getAttribute('data-kind') ?? this.className) ?? 0;
    },
  },
});
class NoResize {
  observe() {}
  disconnect() {}
}
Object.assign(globalThis, {
  document,
  HTMLElement: window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
  // The messages' runtime keeps the locale there.
  localStorage: { getItem: () => null, setItem: () => undefined },
  Node: window.Node,
  ResizeObserver: NoResize,
  window,
});

async function render(close: () => void) {
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { Toast } = await import('./Toast');
  const root = createRoot(document.getElementById('root') as never);
  const discard = vi.fn();
  await act(async () =>
    root.render(
      <Toast
        onClose={close}
        toast={{
          button: { label: 'Download', onClick: vi.fn() },
          description: 'It was deleted.',
          secondary: { label: 'Discard', onClick: discard },
          title: 'Edits to “Cell notes” can’t sync',
          variant: 'error',
        }}
      />
    )
  );
  return { discard, root };
}

// A deleted item's toast (Epo 2026-11-20, Q44): Discard plain and ringed,
// then Download filled, then ×; a pill too narrow for all of them puts every
// button on a row of its own, even when only the × would not fit.
it('shows the plain action before the filled one, and wraps all buttons together', async () => {
  tops.set('tst-close', 44);
  const close = vi.fn();
  const { discard, root } = await render(close);
  const actions = [...document.querySelectorAll('.tst-action')];
  expect(actions.map((node) => node.textContent)).toEqual([
    'Discard',
    'Download',
  ]);
  expect(actions[0].getAttribute('data-kind')).toBe('plain');
  expect(actions[1].getAttribute('data-kind')).toBeNull();
  expect(
    document.querySelector('.tst-body')?.hasAttribute('data-wrapped')
  ).toBe(true);
  (actions[0] as HTMLButtonElement).click();
  expect(discard).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
  root.unmount();
});
