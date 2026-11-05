import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { parseHTML } from 'linkedom';
import { expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import type { RoomSeed } from '@/features/collaboration/deviceCopy';
import { getLocale } from '@/i18n';

// The locale resolves before a window exists, then linkedom's document goes in
// before react-dom/client loads (see ChatPanel.test.tsx).
getLocale();
const { document, window } = parseHTML(
  '<!doctype html><html><body><div id="root"></div></body></html>'
);
Object.assign(globalThis, { document, IS_REACT_ACT_ENVIRONMENT: true, window });

// The factory runs when the editor's chunk is first asked for.
const editor = vi.hoisted(() => ({ loaded: false }));
vi.mock('@/features/notes/NoteEditor', () => {
  editor.loaded = true;
  return { NoteEditor: () => null };
});
vi.mock('./MaterialPreview', () => ({ MaterialPreview: () => null }));
vi.mock('@/features/notes/NoteDisplayToggles', () => ({
  NoteDisplayToggles: () => null,
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { NoteBody } = await import('./NoteBody');

const seed = (canEditContent: boolean): RoomSeed => ({
  doc: new Y.Doc(),
  room: 'material:n_1:schema:1',
  row: {
    canEditContent,
    document: 'content',
    format: 2,
    kind: 'note',
    materialId: 'n_1',
    owner: 'u_1',
    room: 'material:n_1:schema:1',
    size: 0,
    standalone: false,
    title: 'A note',
    version: 3,
  },
  version: 3,
});

/** A reopen: the copy paints before its material read answers. */
async function reopen(canEditContent: boolean) {
  const root = createRoot(document.getElementById('root') as never);
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <NoteBody
          allowExternalAssets={false}
          editing={false}
          material={undefined}
          materialId="n_1"
          onEditorStatusChange={() => {}}
          onReadOnly={() => {}}
          owner="u_1"
          seed={seed(canEditContent)}
          staticNote={false}
        />
      </QueryClientProvider>
    );
    await new Promise((settled) => setTimeout(settled));
  });
  act(() => root.unmount());
}

it('loads the editor on a reopen only for who could edit when the copy was kept', async () => {
  await reopen(false);
  expect(editor.loaded).toBe(false);
  await reopen(true);
  await vi.waitFor(() => expect(editor.loaded).toBe(true));
});
