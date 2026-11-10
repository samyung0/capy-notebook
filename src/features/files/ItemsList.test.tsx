import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { parseHTML } from 'linkedom';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import type { Item, MaterialListItem } from '@/api/types';
import { getLocale, m } from '@/i18n';

// The locale resolves before a window exists, which would make paraglide keep
// it in localStorage; then linkedom's document goes in before
// react-dom/client loads, which reads it once.
getLocale();
const { document, window } = parseHTML(
  '<!doctype html><html><body><div id="root"></div></body></html>'
);
Object.assign(globalThis, { document, IS_REACT_ACT_ENVIRONMENT: true, window });

const list = vi.hoisted(() => ({ items: [] as Item[] }));
vi.mock('@/api/hooks', () => {
  const mutation = () => ({ mutate: vi.fn(), mutateAsync: vi.fn() });
  return {
    useCreateFlashcardSet: mutation,
    useCreateQuiz: mutation,
    useCreateStandaloneNote: mutation,
    useDeleteEditorAsset: mutation,
    useDeleteMaterial: mutation,
    useDeleteOwnedFile: mutation,
    useDeleteOwnedMaterial: mutation,
    useDeletePaper: mutation,
    useItems: () => ({
      data: { pages: [{ items: list.items }] },
      fetchStatus: 'idle',
      hasNextPage: false,
      isLoading: false,
    }),
    useRetryFileProcessing: mutation,
    useRetryingFileIds: () => [],
    useUpdateMaterial: mutation,
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
  useSearch: () => ({}),
}));
vi.mock('usehooks-ts', () => ({ useMediaQuery: () => true }));
vi.mock('@/components/app/layout', () => ({
  PageBody: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/components/app/ListEnd', () => ({ ListEnd: () => null }));
vi.mock('@/components/app/ListToolbar', async (original) => ({
  ...(await original<typeof import('@/components/app/ListToolbar')>()),
  ListToolbar: () => null,
}));
vi.mock('@/components/ui/Menu', () => ({
  Menu: ({ items }: { items: { label: string }[] }) =>
    items.map((item) => (
      <button data-menu={item.label} key={item.label} type="button">
        {item.label}
      </button>
    )),
}));
// Dialogs stay closed in these renders.
vi.mock('@/components/ui/Dialog', () => ({
  ConfirmDialog: () => null,
  SimpleDialog: () => null,
}));
vi.mock('@/features/workspace/ContentActions', () => ({
  ContentActions: () => null,
  ContentPropertiesDialog: () => null,
  downloadMenuItems: () => [],
}));
vi.mock('@/features/workspace/WorkspaceHealth', () => ({
  useAccountFrozen: () => false,
}));
vi.mock('@/features/workspace/LazyAddSourceDialog', () => ({
  AddSourceDialog: () => null,
  addSourceIntent: {},
}));

const { deleteCopy, ItemsList } = await import('./ItemsList');

const at = new Date().toISOString();
const block = (fields: Partial<MaterialListItem>): Item => ({
  material: {
    createdAt: at,
    id: 'm_1',
    isOwner: true,
    kind: 'note',
    preview: undefined,
    privacy: 'private',
    sizeBytes: 1024,
    title: 'Cell notes',
    topicName: '',
    updatedAt: at,
    workspaceId: '',
    workspaceName: '',
    ...fields,
  } as MaterialListItem,
  type: 'material',
});
const ITEMS: Item[] = [
  {
    file: {
      addedAt: at,
      id: 'f_1',
      kind: 'pdf',
      name: 'Lecture 1.pdf',
      sizeBytes: 2048,
      status: 'ready',
    } as Extract<Item, { type: 'file' }>['file'],
    type: 'file',
  },
  {
    submission: {
      assignmentId: 'as_1',
      attemptId: 'at_1',
      bytes: 4096,
      createdAt: at,
      id: 'f_2',
      kind: 'pdf',
      name: 'My answers.pdf',
      quizName: 'Past paper',
      workspaceName: 'Biology',
    },
    type: 'submission',
  },
  block({}),
  {
    embed: {
      assetId: 'ea_1',
      createdAt: at,
      lostAccess: false,
      materialId: 'm_1',
      materialTitle: 'Cell notes',
      materialType: 'note',
      name: 'mitosis.png',
      purpose: 'image',
      sizeBytes: 2048,
      workspaceName: '',
    },
    type: 'embed',
  },
];

const render = () =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <ItemsList
        headerSlot={null}
        onBusyChange={() => undefined}
        onViewChange={() => undefined}
        view="list"
      />
    </QueryClientProvider>
  );

// Epo 2026-11-09: to the user each of them is a file, so they list together,
// each with its own details.
it('lists files, submissions, blocks and embeds as one list', () => {
  list.items = ITEMS;
  const html = render();
  for (const name of ['Lecture 1.pdf', 'My answers.pdf', 'Cell notes'])
    expect(html).toContain(`aria-label="Select ${name}"`);
  // An image is named by the note it sits in, and drawn as what it is.
  expect(html.match(/aria-label="Select Cell notes"/g)).toHaveLength(2);
  expect(html).toContain(`${m.file_kind_image()} · 2 KB`);
  expect(html).toContain('#image"');
  // A submission names its assignment.
  expect(html).toContain('Past paper · 4 KB');
});

// All files lists other members' blocks: they open, study and clone there,
// and only their owner renames or deletes them.
it("offers another member's block only what the caller may do", () => {
  list.items = [block({})];
  const own = render();
  expect(own).toContain(`data-menu="${m.action_rename()}"`);
  expect(own).toContain(`data-menu="${m.action_delete()}"`);
  list.items = [block({ isOwner: false })];
  const theirs = render();
  expect(theirs).toContain(`data-menu="${m.action_clone_to()}"`);
  expect(theirs).not.toContain(`data-menu="${m.action_rename()}"`);
  expect(theirs).not.toContain(`data-menu="${m.action_delete()}"`);
});

// A hidden quiz assigned to the viewer lists in All files as in Recent, and
// only opens its assignment: the quiz itself is refused to them.
it("offers an assignee's quiz only its assignment", () => {
  list.items = [
    block({
      assigned: true,
      assignmentId: 'as_1',
      isOwner: false,
      kind: 'quiz',
      workspaceId: 'ws_1',
    }),
  ];
  const html = render();
  expect(html).toContain(`data-menu="${m.assignment_open()}"`);
  expect(html).not.toContain(`data-menu="${m.action_study()}"`);
  expect(html).not.toContain(`data-menu="${m.action_clone_to()}"`);
});

it('confirms what a deletion does: trash, for good, or both', () => {
  const [file, submission, material, embed] = ITEMS;
  expect(deleteCopy([file, material]).title).toBe(
    m.files_delete_selected_title()
  );
  expect(deleteCopy([embed]).body).toBe(
    m.files_lost_media_delete_body({ name: 'mitosis.png' })
  );
  expect(deleteCopy([submission]).title).toBe(m.submissions_delete_title());
  expect(deleteCopy([file, embed])).toEqual({
    body: m.files_delete_mixed_body({ count: 2 }),
    title: m.files_delete_mixed_title(),
  });
});
