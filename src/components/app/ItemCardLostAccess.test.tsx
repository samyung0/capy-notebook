import { parseHTML } from 'linkedom';
import type { ReactNode } from 'react';
import { expect, it, vi } from 'vitest';
import { getLocale } from '@/i18n';

// The locale resolves before a window exists, then linkedom's document goes
// in before react-dom/client loads (as in FilesAddFile.test.tsx).
getLocale();
const { document, window } = parseHTML(
  '<!doctype html><html><body><div id="root"></div></body></html>'
);
Object.assign(globalThis, { document, IS_REACT_ACT_ENVIRONMENT: true, window });

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => children,
  useNavigate: () => vi.fn(),
}));

// A lost-access card has no link: opening it runs onOpen (the Files page's
// toast) instead of doing nothing.
it('opens a linkless pickable item through onOpen', async () => {
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { ItemCard, ItemPick } = await import('./ItemCard');
  const onOpen = vi.fn();
  const root = createRoot(document.getElementById('root') as never);
  await act(async () =>
    root.render(
      <ItemPick.Provider
        value={{ active: false, busy: false, pick: vi.fn() } as never}
      >
        <ItemCard
          icon="pdf"
          meta="yesterday"
          onOpen={onOpen}
          pickKey="f_lost"
          title="Group project brief.pdf"
          view="list"
          workspace="Study group"
          workspaceLost
        />
      </ItemPick.Provider>
    )
  );
  const overlay = document.querySelector('button[aria-pressed]');
  await act(async () => {
    overlay?.dispatchEvent(new window.Event('dblclick', { bubbles: true }));
  });
  expect(onOpen).toHaveBeenCalledOnce();
  await act(async () => root.unmount());
});
