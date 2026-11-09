import { parseHTML } from 'linkedom';
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { getLocale } from '@/i18n';

// As EmbedsTab.test: the locale first, then the document react-dom/client reads.
getLocale();
const { document, window } = parseHTML(
  '<!doctype html><html><body><div id="root"></div></body></html>'
);
Object.assign(globalThis, { document, IS_REACT_ACT_ENVIRONMENT: true, window });
const { createRoot } = await import('react-dom/client');
const { BannerStack, FileBanner, useBannerOutlet } = await import(
  './FileBanner'
);

type Outlet = Parameters<typeof useBannerOutlet>[0];

function Header({ outlet }: { outlet: Outlet }) {
  useBannerOutlet(outlet);
  return null;
}

function page(outlet: Outlet) {
  return (
    <BannerStack>
      <Header outlet={outlet} />
      <FileBanner message="Could not save" testId="strip" />
    </BannerStack>
  );
}

const drawn = () => document.querySelector('[data-testid="strip"]');

async function mounted(outlet: Outlet) {
  const root = createRoot(document.getElementById('root') as never);
  await act(async () => root.render(page(outlet)));
  return root;
}

it('sends the strip to the outlet instead of drawing it', async () => {
  const outlet = vi.fn();
  const root = await mounted(outlet);
  expect(drawn()).toBeNull();
  expect(outlet.mock.lastCall?.[0]).toMatchObject({
    message: 'Could not save',
  });
  await act(async () => root.unmount());
});

it('draws the strip itself with no ribbon to send it to, and when the ribbon goes', async () => {
  const root = await mounted(null);
  expect(drawn()).not.toBeNull();
  const outlet = vi.fn();
  await act(async () => root.render(page(outlet)));
  expect(drawn()).toBeNull();
  await act(async () => root.render(page(null)));
  expect(outlet.mock.lastCall?.[0]).toBeNull();
  expect(drawn()).not.toBeNull();
  await act(async () => root.unmount());
});

it('moves to the next view across a swap: the old outlet is told, the new one has it', async () => {
  const before = vi.fn();
  const root = await mounted(before);
  const after = vi.fn();
  await act(async () => root.render(page(after)));
  expect(before.mock.lastCall?.[0]).toBeNull();
  expect(after.mock.lastCall?.[0]).toMatchObject({ message: 'Could not save' });
  expect(drawn()).toBeNull();
  await act(async () => root.unmount());
});
