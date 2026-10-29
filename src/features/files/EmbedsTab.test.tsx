import { parseHTML } from 'linkedom';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import type { EditorAssetItem } from '@/api/types';
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

const embeds = vi.hoisted(() => ({
  access: [] as (string | undefined)[],
  items: [] as EditorAssetItem[],
  remove: vi.fn<(assetId: string) => Promise<void>>(),
}));
vi.mock('@/api/hooks', async () => {
  const { useState } = await vi.importActual<typeof import('react')>('react');
  return {
    // The real hook's surface, so the dialog sees the pending and failed
    // states a deletion goes through.
    useDeleteEditorAsset: () => {
      const [error, setError] = useState<Error | null>(null);
      const [isPending, setPending] = useState(false);
      return {
        error,
        isPending,
        mutateAsync: async (assetId: string) => {
          setPending(true);
          try {
            await embeds.remove(assetId);
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
    useEditorAssets: (access?: string) => {
      embeds.access.push(access);
      return { data: { pages: [{ items: embeds.items }] }, isLoading: false };
    },
    // Only the workspace icons read it.
    useWorkspaces: () => ({ data: [] }),
  };
});
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    params,
    to,
  }: {
    children: ReactNode;
    params?: Record<string, string>;
    to: string;
  }) => (
    <a href={to.replace(/\$(\w+)/g, (_, key) => params?.[key] ?? '')}>
      {children}
    </a>
  ),
  linkOptions: <T,>(options: T) => options,
  useNavigate: () => vi.fn(),
}));
vi.mock('@/components/app/layout', () => ({
  PageBody: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/components/app/ListEnd', () => ({ ListEnd: () => null }));
vi.mock('@/components/app/ListToolbar', () => ({
  ListToolbar: ({
    filters,
  }: {
    filters: {
      options: { label: string; value: string }[];
      onToggle: (value: string) => void;
    }[];
  }) =>
    filters.flatMap((filter) =>
      filter.options.map((option) => (
        <button
          data-filter={option.value}
          key={option.value}
          onClick={() => filter.onToggle(option.value)}
          type="button"
        >
          {option.label}
        </button>
      ))
    ),
}));
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
const { EmbedsTab } = await import('./EmbedsTab');

const item = (
  assetId: string,
  name: string,
  materialTitle: string,
  lostAccess: boolean
): EditorAssetItem => ({
  assetId,
  createdAt: new Date().toISOString(),
  lostAccess,
  materialId: lostAccess ? undefined : 'mat_note',
  materialTitle,
  materialType: 'note',
  name,
  purpose: name.endsWith('.mp3') ? 'audio' : 'image',
  sizeBytes: 2048,
  workspaceName: 'Biology',
});

const tab = (
  props: { access?: 'open' | 'lost'; view?: 'grid' | 'list' } = {}
) => (
  <EmbedsTab
    onAccessChange={(access) => embeds.access.push(`set:${access}`)}
    onViewChange={() => undefined}
    view="list"
    {...props}
  />
);

// Every image and audio clip the viewer pays for is listed under its note's
// title with its kind and size (Epo 2026-10-24): one in a note it can open
// opens that note, and every one can be deleted (Q273); an owner no longer
// live leaves the note unnamed.
it('lists media under their note, opening or deleting by access', () => {
  embeds.items = [
    item('asset_a', 'mitosis.png', 'Cell division', false),
    item('asset_b', 'lecture.mp3', '', true),
  ];
  const html = renderToStaticMarkup(tab());
  expect(html).toContain('Cell division');
  expect(html).toContain('href="/materials/mat_note"');
  expect(html).toContain(m.files_note_unavailable());
  expect(html).toContain(`${m.file_kind_image()} · 2 KB`);
  expect(html).toContain(`${m.file_kind_audio()} · 2 KB`);
  // Drawn as what it is, not as its note.
  expect(html).toContain('#image"');
  expect(html).toContain('#audio"');
  expect(html).not.toContain('#java-enum"');
  // A grid card shows an image's thumbnail in place of its icon.
  embeds.items = [
    {
      ...item('asset_c', 'cell.png', 'Cell division', false),
      thumbnailUrl: '/t/cell.jpg',
    },
  ];
  expect(renderToStaticMarkup(tab({ view: 'grid' }))).toContain(
    'src="/t/cell.jpg"'
  );
  // Delete on both, the open image's too.
  expect(html.match(/data-menu/g)).toHaveLength(2);
  expect(html.match(/href="\/materials\//g)).toHaveLength(1);
  expect(html).not.toContain(m.files_lost_media_notice());

  embeds.items = [];
  expect(renderToStaticMarkup(tab())).toContain(m.files_embeds_none());
  expect(renderToStaticMarkup(tab({ access: 'lost' }))).toContain(
    m.files_embeds_empty()
  );
});

// The access filter asks the listing for one kind and switches between them;
// picking the chosen one again clears it.
it('filters by whether the note can be opened', async () => {
  embeds.items = [item('asset_b', 'lecture.mp3', 'Lecture', true)];
  embeds.access = [];
  const html = renderToStaticMarkup(tab({ access: 'lost' }));
  expect(embeds.access).toContain('lost');
  expect(html).toContain(m.files_lost_media_notice());

  const root = createRoot(document.getElementById('root') as never);
  await act(async () => root.render(tab({ access: 'lost' })));
  for (const value of ['open', 'lost']) {
    await act(async () => {
      document
        .querySelector(`[data-filter=${value}]`)
        ?.dispatchEvent(new window.Event('click', { bubbles: true }));
    });
  }
  expect(embeds.access).toContain('set:open');
  expect(embeds.access).toContain('set:undefined');
  await act(async () => root.unmount());
});

// Deleting asks first. A refused deletion keeps the confirmation open with the
// server's error in it; a second try that succeeds closes it.
it('confirms a deletion and keeps a failed one open with its error', async () => {
  embeds.items = [item('asset_a', 'mitosis.png', 'Cell division', true)];
  const root = createRoot(document.getElementById('root') as never);
  const click = (selector: string) =>
    act(async () => {
      document
        .querySelector(selector)
        ?.dispatchEvent(new window.Event('click', { bubbles: true }));
    });
  await act(async () => root.render(tab()));

  await click('[data-menu]');
  expect(document.querySelector('[role=dialog]')?.textContent).toContain(
    'mitosis.png'
  );
  expect(embeds.remove).not.toHaveBeenCalled();

  const refused = new Error('refused');
  embeds.remove.mockRejectedValueOnce(refused);
  await click('[data-confirm]');
  expect(embeds.remove).toHaveBeenCalledWith('asset_a');
  expect(document.querySelector('[role=dialog]')).not.toBeNull();
  expect(document.querySelector('[role=alert]')?.textContent).toBe(
    describeError(refused).title
  );

  embeds.remove.mockResolvedValueOnce();
  await click('[data-confirm]');
  expect(embeds.remove).toHaveBeenCalledTimes(2);
  expect(document.querySelector('[role=dialog]')).toBeNull();
  await act(async () => root.unmount());
});
