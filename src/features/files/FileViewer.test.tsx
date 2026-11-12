import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { parseHTML } from 'linkedom';
import { afterEach, expect, it, vi } from 'vitest';
import type { SourceFile } from '@/api/types';
import { getLocale, m } from '@/i18n';

// The locale resolves before a window exists (see ItemsList.test.tsx), then
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
  mePending: false,
  // The workspace's owner, and the Retry processing calls and pending ids.
  owner: true,
  retried: [] as unknown[],
  retrying: [] as string[],
  toasts: [] as string[],
}));
vi.mock('@/api/hooks', () => ({
  fileLinksQuery: () => ({ queryKey: ['file-links'] }),
  useFileLinks: () => ({
    data: { url: 'https://bytes.test/f' },
    isError: false,
    isPending: false,
  }),
  useMe: () => ({ isPending: views.mePending }),
  useRetryFileProcessing: () => ({
    mutateAsync: async (request: unknown) => {
      views.retried.push(request);
    },
  }),
  useRetryingFileIds: () => views.retrying,
  useWorkspace: (id: string) => ({
    data: id
      ? {
          capabilities: { canEdit: true, canEditContent: true },
          isOwner: views.owner,
        }
      : undefined,
    isPending: false,
  }),
}));
vi.mock('@/features/workspace/retryProcessing', () => ({
  retryStartedToast: () => views.toasts.push('retry started'),
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
  views.mePending = false;
  views.owner = true;
  views.retried.length = 0;
  views.retrying.length = 0;
  views.toasts.length = 0;
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

it("opens no standalone editor before the owner's account loads (E1)", async () => {
  // A frozen account reads as not frozen until it loads, and an Office view
  // picks its mode once: it waits, and text stays read-only meanwhile.
  views.mePending = true;
  expect(await open('notes.docx', '')).toBeUndefined();
  expect(await open('notes.md', '')).toEqual(['text', false]);
});

it("opens a workspace file's editor for a content editor", async () => {
  expect(await open('notes.docx', 'ws_1')).toEqual(['docx', true]);
  expect(await open('notes.md', 'ws_1')).toEqual(['text', true]);
});

/** What the viewer shows for a file, with its buttons; `press` clicks one. */
async function screen(fields: Partial<SourceFile>, press?: string) {
  document.body.innerHTML = '<div id="root"></div>';
  const root = createRoot(document.getElementById('root') as never);
  const file = {
    hasBytes: true,
    id: 'f_old',
    isPayer: true,
    kind: 'doc',
    name: 'Essay draft.doc',
    revision: 1,
    status: 'ready',
    workspaceId: 'ws_1',
    ...fields,
  } as SourceFile;
  await act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <FileViewer file={file} />
      </QueryClientProvider>
    )
  );
  const buttons = [...document.querySelectorAll('button')];
  const pressed = buttons.find((button) => button.textContent === press);
  await act(async () => {
    pressed?.dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  const shown = {
    buttons: buttons.map((button) => button.textContent),
    disabled: buttons
      .filter((button) => button.hasAttribute('disabled'))
      .map((button) => button.textContent),
    text: document.body.textContent ?? '',
  };
  root.unmount();
  return shown;
}

// An old Office file that is not converted (mock A, Epo 2026-11-11).
const convertScreen = {
  buttons: [
    m.files_legacy_convert(),
    m.files_download_original({ name: 'Essay draft.doc' }),
  ],
  title: m.files_legacy_title(),
};
const todayScreen = {
  buttons: [m.files_download_original({ name: 'Essay draft.doc' })],
  title: m.files_preview_unavailable(),
};

it('offers the conversion on an old Office file that is ready or failed, to who may reprocess it', async () => {
  for (const fields of [
    { status: 'ready' },
    { status: 'failed' },
    // A file with no workspace, to its payer.
    { workspaceId: '' },
  ] as const) {
    const shown = await screen(fields);
    expect(shown.buttons).toEqual(convertScreen.buttons);
    expect(shown.text).toContain(convertScreen.title);
    expect(shown.text).toContain(
      m.files_legacy_body({ ext: '.doc', target: '.docx' })
    );
  }
});

it("keeps today's screen for a member, a frozen payer and a file that is no old Office file", async () => {
  views.owner = false;
  const member = await screen({});
  expect(member.buttons).toEqual(todayScreen.buttons);
  expect(member.text).toContain(todayScreen.title);
  expect(member.text).toContain(
    m.files_preview_unsupported_body({ ext: '.doc' })
  );
  views.owner = true;

  views.frozen = true;
  expect((await screen({ workspaceId: '' })).buttons).toEqual(
    todayScreen.buttons
  );
  views.frozen = false;

  const zip = await screen({ kind: 'unknown', name: 'archive.zip' });
  expect(zip.buttons).toEqual([
    m.files_download_original({ name: 'archive.zip' }),
  ]);
  expect(zip.text).toContain(todayScreen.title);
});

it('shows the loader with the converting label while an old Office file converts', async () => {
  for (const status of ['pending', 'processing'] as const) {
    const shown = await screen({ status });
    expect(shown.buttons).toEqual([]);
    expect(shown.text).toBe(m.files_converting());
  }
});

it("Convert sends the file's Retry processing, and stays off while one runs", async () => {
  await screen({}, m.files_legacy_convert());
  // The server uses the file's own parse mode; 'fast' names the route.
  expect(views.retried).toEqual([{ id: 'f_old', parseMode: 'fast' }]);
  expect(views.toasts).toEqual(['retry started']);

  views.retrying.push('f_old');
  const running = await screen({}, m.files_legacy_convert());
  expect(running.disabled).toEqual([m.files_legacy_convert()]);
});
