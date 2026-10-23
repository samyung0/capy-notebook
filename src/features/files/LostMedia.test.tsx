import { parseHTML } from 'linkedom';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import type { LostEditorAsset } from '@/api/types';
import { getLocale, m } from '@/i18n';
import { describeError } from '@/lib/errors';

// The locale resolves before a window exists, which would make paraglide keep
// it in localStorage; then linkedom's document goes in before
// react-dom/client loads, which reads it once.
getLocale();
const { document, window } = parseHTML(
  '<!doctype html><html><body><div id="root"></div></body></html>'
);
Object.assign(globalThis, { document, IS_REACT_ACT_ENVIRONMENT: true, window });

const lost = vi.hoisted(() => ({
  items: [] as LostEditorAsset[],
  remove: vi.fn<(assetId: string) => Promise<void>>(),
}));
vi.mock('@/api/hooks', async () => {
  const { useState } = await vi.importActual<typeof import('react')>('react');
  return {
    // The real hook's surface, so the dialog sees the pending and failed
    // states a deletion goes through.
    useDeleteLostMedia: () => {
      const [error, setError] = useState<Error | null>(null);
      const [isPending, setPending] = useState(false);
      return {
        error,
        isPending,
        mutateAsync: async (assetId: string) => {
          setPending(true);
          try {
            await lost.remove(assetId);
          } catch (err) {
            setError(err as Error);
            throw err;
          } finally {
            setPending(false);
          }
        },
        reset: () => setError(null),
      };
    },
    useLostMedia: () => ({ data: { pages: [{ items: lost.items }] } }),
  };
});
vi.mock('@/components/app/ListEnd', () => ({ ListEnd: () => null }));
vi.mock('@/components/ui/Menu', () => ({
  Menu: ({ items }: { items: { label: string; onClick: () => void }[] }) =>
    items.map((item) => (
      <button
        data-menu=""
        key={item.label}
        onClick={item.onClick}
        type="button"
      >
        {item.label}
      </button>
    )),
}));
vi.mock('@/components/ui/Dialog', () => ({
  ConfirmDialog: ({
    body,
    children,
    onConfirm,
    open,
  }: {
    body: ReactNode;
    children: ReactNode;
    onConfirm: () => void;
    open: boolean;
  }) =>
    open ? (
      <div role="dialog">
        <p>{body}</p>
        {children}
        <button data-confirm="" onClick={onConfirm} type="button">
          confirm
        </button>
      </div>
    ) : null,
}));
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { LostMedia } = await import('./LostMedia');

const item = (
  assetId: string,
  name: string,
  materialTitle: string
): LostEditorAsset => ({
  assetId,
  createdAt: new Date().toISOString(),
  materialTitle,
  name,
  purpose: name.endsWith('.mp3') ? 'audio' : 'image',
  sizeBytes: 2048,
});

// The images and audio the viewer still pays for in notes it can no longer
// open (M16) are listed under their note, marked lost; a note whose workspace
// closed has no name to show. Nothing shows while there are none.
it('lists lost media under their note', () => {
  lost.items = [];
  expect(renderToStaticMarkup(<LostMedia view="list" />)).toBe('');
  lost.items = [
    item('asset_a', 'mitosis.png', 'Cell division'),
    item('asset_b', 'lecture.mp3', ''),
  ];
  const html = renderToStaticMarkup(<LostMedia view="list" />);
  expect(html).toContain(m.files_lost_media_title());
  expect(html).toContain('mitosis.png');
  expect(html).toContain('Cell division');
  expect(html).toContain('lecture.mp3');
  expect(html).toContain(m.files_note_unavailable());
});

// Deleting asks first. A refused deletion keeps the confirmation open with the
// server's error in it; a second try that succeeds closes it.
it('confirms a deletion and keeps a failed one open with its error', async () => {
  lost.items = [item('asset_a', 'mitosis.png', 'Cell division')];
  const root = createRoot(document.getElementById('root') as never);
  const click = (selector: string) =>
    act(async () => {
      document
        .querySelector(selector)
        ?.dispatchEvent(new window.Event('click', { bubbles: true }));
    });
  await act(async () => root.render(<LostMedia view="list" />));

  await click('[data-menu]');
  expect(document.querySelector('[role=dialog]')?.textContent).toContain(
    'mitosis.png'
  );
  expect(lost.remove).not.toHaveBeenCalled();

  const refused = new Error('refused');
  lost.remove.mockRejectedValueOnce(refused);
  await click('[data-confirm]');
  expect(lost.remove).toHaveBeenCalledWith('asset_a');
  expect(document.querySelector('[role=dialog]')).not.toBeNull();
  expect(document.querySelector('[role=alert]')?.textContent).toBe(
    describeError(refused).title
  );

  lost.remove.mockResolvedValueOnce();
  await click('[data-confirm]');
  expect(lost.remove).toHaveBeenCalledTimes(2);
  expect(document.querySelector('[role=dialog]')).toBeNull();
  await act(async () => root.unmount());
});
