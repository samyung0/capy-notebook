import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query';
import { parseHTML } from 'linkedom';
import { expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import type { Material } from '@/api/types';
import { getLocale, m } from '@/i18n';

// The locale resolves before a window exists, then linkedom's document goes in
// before react-dom/client loads (see ChatPanel.test.tsx).
getLocale();
const { document, window } = parseHTML(
  '<!doctype html><html><body><div id="root"></div></body></html>'
);
Object.assign(globalThis, { document, IS_REACT_ACT_ENVIRONMENT: true, window });

// A read with nothing yet, as one paused offline is.
const token = vi.hoisted(() => ({
  fetch: vi.fn(async () => ({ access: 'write' })),
}));
vi.mock('@/api/hooks', () => ({
  materialTokenQuery: (id: string) => ({
    queryFn: token.fetch,
    queryKey: ['material', id, 'collaboration-token'],
  }),
  useMaterial: () => ({ data: undefined, error: null, isPending: true }),
  useMe: () => ({ data: { id: 'u_1' } }),
}));
const preview = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('./NoteBody', async (original) => ({
  ...(await original<typeof import('./NoteBody')>()),
  loadPreview: preview.load,
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { MaterialContent } = await import('./CenterContent');

async function open(kind: Material['kind'] | undefined, staticNote = false) {
  const root = createRoot(document.getElementById('root') as never);
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <MaterialContent
          allowExternalAssets={false}
          centerQuiz={false}
          forceReadOnly={false}
          kind={kind}
          materialId="m_1"
          onEditorStatusChange={() => {}}
          staticNote={staticNote}
        />
      </QueryClientProvider>
    );
    // The device copy's store answers.
    await new Promise((settled) => setTimeout(settled));
  });
  return root;
}

it('waits for the connection while a read with nothing to paint is paused', async () => {
  onlineManager.setOnline(false);
  const root = await open('quiz');
  expect(document.body.textContent).toContain(m.connection_waiting());
  act(() => root.unmount());
  onlineManager.setOnline(true);
});

// The static renderer is about 1.2 MB minified the other kinds never draw.
it.each([
  ['note', 1],
  [undefined, 1],
  ['quiz', 0],
  ['flashcards', 0],
  ['diagram', 0],
  ['mindmap', 0],
] as const)(
  'a %s open loads the static renderer %i times',
  async (kind, times) => {
    preview.load.mockClear();
    const root = await open(kind);
    expect(preview.load).toHaveBeenCalledTimes(times);
    act(() => root.unmount());
  }
);

// Beside its read, not a round trip behind it. A heavy note opened read-only
// joins no room, and another kind's room asks for its own.
it.each([
  ['note', false, 1],
  ['note', true, 0],
  ['quiz', false, 0],
  [undefined, false, 0],
] as const)(
  'a %s open (static: %s) asks for the note token %i times',
  async (kind, staticNote, times) => {
    token.fetch.mockClear();
    const root = await open(kind, staticNote);
    expect(token.fetch).toHaveBeenCalledTimes(times);
    act(() => root.unmount());
  }
);

it('a refused token at open stays quiet: nothing shows and nothing retries', async () => {
  token.fetch.mockClear();
  token.fetch.mockRejectedValueOnce(new ApiError(403, 'forbidden'));
  const before = await open('quiz');
  const shown = document.body.textContent;
  act(() => before.unmount());
  const root = await open('note');
  await act(async () => {
    await new Promise((settled) => setTimeout(settled, 20));
  });
  expect(token.fetch).toHaveBeenCalledTimes(1);
  expect(document.body.textContent).toBe(shown);
  act(() => root.unmount());
});
