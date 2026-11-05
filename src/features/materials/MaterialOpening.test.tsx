import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query';
import { parseHTML } from 'linkedom';
import { expect, it, vi } from 'vitest';
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
vi.mock('@/api/hooks', () => ({
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

async function open(kind: Material['kind'] | undefined) {
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
