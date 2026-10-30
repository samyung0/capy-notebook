import { parseHTML } from 'linkedom';
import { expect, it } from 'vitest';

// linkedom's document goes in before react-dom/client loads.
const { document, window } = parseHTML(
  '<!doctype html><html><body><div id="root"></div></body></html>'
);
Object.assign(globalThis, { document, IS_REACT_ACT_ENVIRONMENT: true, window });

// Navigating back to a page remounts its avatars: one already shown appears
// at once instead of pulsing and fading in as if it were fetched again.
it('shows an avatar it has loaded before without the loading pulse', async () => {
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { Avatar } = await import('./Avatar');
  const src = '/icons/avataaars-01.svg';
  const root = createRoot(document.getElementById('root') as never);
  const img = () => document.querySelector('img') as HTMLImageElement;

  await act(async () => root.render(<Avatar name="Kate" src={src} />));
  expect(img().className).toContain('opacity-0');
  await act(async () => {
    img().dispatchEvent(new window.Event('load'));
  });
  expect(img().className).not.toContain('opacity-0');

  await act(async () => root.render(null));
  await act(async () => root.render(<Avatar name="Kate" src={src} />));
  expect(img().className).not.toContain('opacity-0');
  await act(async () => root.unmount());
});
