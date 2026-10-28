import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { parseHTML } from 'linkedom';
import { afterEach, expect, it, vi } from 'vitest';
import type { SourceFile } from '@/api/types';
import { getLocale } from '@/i18n';

// The locale resolves before a window exists (see EmbedsTab.test.tsx), then
// linkedom's document goes in before react-dom/client loads.
getLocale();
const { document, window } = parseHTML(
  '<!doctype html><html><body><div id="root"></div></body></html>'
);
Object.assign(globalThis, { document, IS_REACT_ACT_ENVIRONMENT: true, window });

// What each editor view was told about editing.
const views = vi.hoisted(() => ({
  edits: [] as [string, boolean][],
  frozen: false,
}));
vi.mock('@/api/hooks', () => ({
  fileLinksQuery: () => ({ queryKey: ['file-links'] }),
  useFileLinks: () => ({
    data: { url: 'https://bytes.test/f' },
    isError: false,
    isPending: false,
  }),
  useWorkspace: (id: string) => ({
    data: id ? { capabilities: { canEditContent: true } } : undefined,
    isPending: false,
  }),
}));
vi.mock('@/features/workspace/WorkspaceHealth', () => ({
  useAccountFrozen: () => views.frozen,
}));
vi.mock('./DocxView', () => ({
  default: ({ canEdit }: { canEdit: boolean }) => {
    views.edits.push(['docx', canEdit]);
    return null;
  },
}));
vi.mock('./SourceTextView', () => ({
  SourceTextView: ({ canEdit }: { canEdit: boolean }) => {
    views.edits.push(['text', canEdit]);
    return null;
  },
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { FileViewer } = await import('./FileViewer');

afterEach(() => {
  views.edits.length = 0;
  views.frozen = false;
});

async function open(name: string, workspaceId: string) {
  document.body.innerHTML = '<div id="root"></div>';
  const root = createRoot(document.getElementById('root') as never);
  const file = {
    hasBytes: true,
    id: 'f_1',
    kind: name.endsWith('.md') ? 'md' : 'docx',
    name,
    revision: 1,
    workspaceId,
  } as SourceFile;
  await act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <FileViewer file={file} />
      </QueryClientProvider>
    )
  );
  // The lazy views resolve on later turns.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  root.unmount();
  return views.edits.at(-1);
}

it("opens a standalone Office or text file's editor for its owner, read-only while frozen", async () => {
  expect(await open('notes.docx', '')).toEqual(['docx', true]);
  expect(await open('notes.md', '')).toEqual(['text', true]);
  views.frozen = true;
  expect(await open('notes.docx', '')).toEqual(['docx', false]);
  expect(await open('notes.md', '')).toEqual(['text', false]);
});

it("opens a workspace file's editor for a content editor", async () => {
  expect(await open('notes.docx', 'ws_1')).toEqual(['docx', true]);
  expect(await open('notes.md', 'ws_1')).toEqual(['text', true]);
});
