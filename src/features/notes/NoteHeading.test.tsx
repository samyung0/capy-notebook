import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { parseHTML } from 'linkedom';
import { afterEach, expect, it, vi } from 'vitest';
import type { Material } from '@/api/types';

const reported: unknown[] = [];
// linkedom's document before react-dom/client loads, which reads it once.
const { document, window } = parseHTML(
  '<!doctype html><html><body><div id="root"></div></body></html>'
);
Object.assign(globalThis, {
  document,
  IS_REACT_ACT_ENVIRONMENT: true,
  // The app keeps small preferences there; Node has none.
  localStorage: {
    getItem: () => null,
    removeItem: () => undefined,
    setItem: () => undefined,
  },
  // The title follows its column's width; linkedom lays nothing out.
  ResizeObserver: class {
    disconnect() {
      // Nothing is observed.
    }
    observe() {
      // Nothing is observed.
    }
  },
  // React reports a render error here; linkedom's own event dispatch cannot.
  reportError: (error: unknown) => reported.push(error),
  window,
});
vi.mock('@/api/auth', () => ({
  authHeaders: async () => ({}),
  USE_MSW: false,
}));
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { api } = await import('@/api/client');
const { countWords, NoteHeading, noteText } = await import('./NoteHeading');
afterEach(() => vi.restoreAllMocks());

const material = {
  capabilities: { canEdit: true },
  createdAt: '2026-11-02T08:00:00Z',
  id: 'mat_1',
  title: 'Cellular respiration',
  topicId: null,
  updatedAt: '2026-11-10T06:02:00Z',
  workspaceId: 'ws_1',
} as Material;

async function show(file: Material | null = material) {
  const root = createRoot(document.getElementById('root') as never);
  await act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <NoteHeading
          fullWidth={false}
          material={file ?? undefined}
          onEnter={() => undefined}
          readonly={false}
          title={material.title}
          words={() => 412}
        />
      </QueryClientProvider>
    )
  );
  return root;
}

// The title at the top of a note is the file's name (Epo 2026-11-10, mock P1).
it('renames the file when the title is changed and left', async () => {
  const patch = vi.spyOn(api, 'patch').mockResolvedValue({});
  const root = await show();
  const field = document.querySelector('textarea') as HTMLTextAreaElement;
  expect(field.value).toBe('Cellular respiration');
  await act(async () => {
    field.value = 'Respiration notes';
    field.dispatchEvent(new window.Event('input', { bubbles: true }));
    field.dispatchEvent(new window.Event('focusout', { bubbles: true }));
  });
  await vi.waitFor(() =>
    expect(patch).toHaveBeenCalledWith('/materials/mat_1/metadata', {
      title: 'Respiration notes',
    })
  );
  expect(reported).toEqual([]);
  await act(async () => root.unmount());
});

// Info opens what the file carries (mock I1): no topic reads as Other files.
it("opens the Info row with the file's own details", async () => {
  vi.spyOn(api, 'get').mockResolvedValue([]);
  const root = await show();
  const info = document.querySelector('button') as HTMLButtonElement;
  await act(async () => info.click());
  const text = document.querySelector('dl')?.textContent ?? '';
  expect(text).toContain('Other files');
  expect(text).toContain('412');
  expect(reported).toEqual([]);
  await act(async () => root.unmount());
});

// A note paints before its read answers (NoteBody): the name alone, read-only,
// in the same box the editor's title takes.
it('shows the name read-only until the file is known', async () => {
  const root = await show(null);
  const field = document.querySelector('textarea') as HTMLTextAreaElement;
  expect(field.value).toBe('Cellular respiration');
  // linkedom keeps React's attribute name as written.
  expect(field.hasAttribute('readOnly')).toBe(true);
  expect(reported).toEqual([]);
  await act(async () => root.unmount());
});

// Info's Words, from a Plate note's blocks.
it("counts a note's words block by block", () => {
  const value = [
    {
      children: [{ text: 'Cells make ' }, { bold: true, text: 'ATP' }],
      type: 'p',
    },
    {
      children: [{ children: [{ text: 'in mitochondria' }], type: 'p' }],
      type: 'callout',
    },
  ];
  expect(countWords(noteText(value))).toBe(5);
});
