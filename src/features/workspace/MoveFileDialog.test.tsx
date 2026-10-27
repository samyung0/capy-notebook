import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { parseHTML } from 'linkedom';
import type { FormEventHandler, ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import type { Workspace } from '@/api/types';
import { getLocale, m } from '@/i18n';

// The locale resolves before a window exists (see EmbedsTab.test.tsx), then
// linkedom's document goes in before react-dom/client loads.
getLocale();
const { document, window } = parseHTML(
  '<!doctype html><html><body><div id="root"></div></body></html>'
);
Object.assign(globalThis, { document, IS_REACT_ACT_ENVIRONMENT: true, window });

const ui = vi.hoisted(() => ({
  pickChapter: (_id: string | null) => undefined as void,
  pickWorkspace: (_id: string) => undefined as void,
}));
const workspace = (id: string, name: string, canEdit: boolean) =>
  ({ capabilities: { canEdit }, iconId: 'books', id, name }) as Workspace;
vi.mock('@/api/hooks', async (original) => ({
  ...(await original<typeof import('@/api/hooks')>()),
  useChapters: () => ({ data: [] }),
  useWorkspaces: () => ({
    data: [
      workspace('ws_a', 'Biology', true),
      workspace('ws_b', 'Physics', true),
      workspace('ws_c', 'Shared with me', false),
    ],
    isPending: false,
  }),
}));
// Dropdowns as plain lists; the tests pick through the captured callbacks.
vi.mock('@/components/ui/Select', () => ({
  Select: ({
    children,
    onValueChange,
  }: {
    children: ReactNode;
    onValueChange: (id: string) => void;
  }) => {
    ui.pickWorkspace = onValueChange;
    return <div>{children}</div>;
  },
  SelectContent: ({ children }: { children: ReactNode }) => children,
  SelectItem: ({
    children,
    hint,
    value,
  }: {
    children: ReactNode;
    hint?: ReactNode;
    value: string;
  }) => (
    <i data-hint={hint ?? ''} data-item={value}>
      {children}
    </i>
  ),
  SelectTrigger: ({ children }: { children: ReactNode }) => children,
  SelectValue: () => null,
}));
vi.mock('./ChapterSelect', async (original) => ({
  ...(await original<typeof import('./ChapterSelect')>()),
  ChapterSelect: ({
    current,
    onChange,
  }: {
    current?: string | null;
    onChange: (id: string | null) => void;
  }) => {
    ui.pickChapter = onChange;
    return <span data-current={String(current)} />;
  },
}));
vi.mock('@/components/ui/Dialog', () => ({
  ConfirmDialog: ({
    children,
    onConfirm,
    title,
  }: {
    children: ReactNode;
    onConfirm: () => void;
    title: string;
  }) => (
    <div data-confirm="">
      {title}
      {children}
      <button data-confirm-move="" onClick={onConfirm} type="button" />
    </div>
  ),
  SimpleDialog: ({
    action,
    children,
    onSubmit,
  }: {
    action: ReactNode;
    children: ReactNode;
    onSubmit: FormEventHandler;
  }) => (
    <form onSubmit={onSubmit}>
      {children}
      {action}
    </form>
  ),
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { MoveFileDialog } = await import('./MoveFileDialog');

const calls: { body: unknown; method: string; url: string }[] = [];
afterEach(() => {
  calls.length = 0;
  vi.unstubAllGlobals();
});

function stubApi(respond: (url: string, body: unknown) => Response) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ body, method: init?.method ?? 'GET', url });
      return respond(url, body);
    })
  );
}

async function render() {
  document.body.innerHTML = '<div id="root"></div>';
  const root = createRoot(document.getElementById('root') as never);
  const onClose = vi.fn();
  await act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <MoveFileDialog
          file={{
            chapterId: 'ch_1',
            id: 'f_1',
            name: 'Cells.pdf',
            workspaceId: 'ws_a',
          }}
          onClose={onClose}
        />
      </QueryClientProvider>
    )
  );
  return { onClose, root };
}

const submit = () =>
  act(async () => {
    document
      .querySelector('form')
      ?.dispatchEvent(
        new window.Event('submit', { bubbles: true, cancelable: true })
      );
  });

it('offers the workspaces the user edits, the current one marked, never No workspace', async () => {
  const { root } = await render();
  const items = [...document.querySelectorAll('[data-item]')];
  expect(items.map((item) => item.getAttribute('data-item'))).toEqual([
    'ws_a',
    'ws_b',
  ]);
  expect(items.map((item) => item.getAttribute('data-hint'))).toEqual([
    m.destination_current(),
    '',
  ]);
  // The file's chapter is preselected and marked too.
  expect(
    document.querySelector('[data-current]')?.getAttribute('data-current')
  ).toBe('ch_1');
  act(() => root.unmount());
});

it('asks before dropping study progress, then moves with the confirmation', async () => {
  stubApi((_url, body) =>
    (body as { confirmProgressLoss?: boolean }).confirmProgressLoss
      ? Response.json([{ id: 'f_1', workspaceId: 'ws_b' }])
      : Response.json(
          {
            errors: [
              { message: 'progress_loss', value: { people: 3, planSteps: 2 } },
            ],
          },
          { status: 409 }
        )
  );
  const { onClose, root } = await render();
  await act(async () => ui.pickWorkspace('ws_b'));
  await submit();
  const confirm = document.querySelector('[data-confirm]');
  expect(confirm?.textContent).toContain(
    m.move_progress_title({ workspace: 'Physics' })
  );
  expect(confirm?.textContent).toContain(m.move_progress_people({ count: 3 }));
  expect(confirm?.textContent).toContain(m.move_progress_steps({ count: 2 }));
  await act(async () => {
    document
      .querySelector('[data-confirm-move]')
      ?.dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  expect(calls.map((call) => [call.method, call.url, call.body])).toEqual([
    ['POST', '/api/files/move', { fileIds: ['f_1'], workspaceId: 'ws_b' }],
    [
      'POST',
      '/api/files/move',
      { confirmProgressLoss: true, fileIds: ['f_1'], workspaceId: 'ws_b' },
    ],
  ]);
  expect(onClose).toHaveBeenCalled();
  act(() => root.unmount());
});

it('moves to another chapter of the same workspace as a chapter move', async () => {
  stubApi(() => Response.json({ chapterId: 'ch_2', id: 'f_1' }));
  const { onClose, root } = await render();
  await act(async () => ui.pickChapter('ch_2'));
  await submit();
  expect(calls.map((call) => [call.method, call.url, call.body])).toEqual([
    ['PATCH', '/api/files/f_1', { chapterId: 'ch_2' }],
  ]);
  expect(onClose).toHaveBeenCalled();
  act(() => root.unmount());
});
