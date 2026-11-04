import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { createPresenceStore } from '@/features/collaboration/presence';
import { m } from '@/i18n';
import { createEditorStatusStore, Header } from './CenterContentHeader';

const HIDDEN = /\bhidden\b/;
// The hidden chip as a button the keyboard reaches.
const CHIP_BUTTON = /<button[^>]*data-testid="hidden-chip"[^>]*type="button"/;

// The ⋮'s props, and where the header sends the reader.
const header = vi.hoisted(() => ({
  actions: [] as Record<string, unknown>[],
  hidden: false,
  isPayer: false,
  navigate: vi.fn(),
  setHidden: vi.fn(),
}));
// The hidden chip's props, from the real chip.
const chips = vi.hoisted(() => [] as { onShow?: () => void }[]);
vi.mock('@/features/workspace/HiddenChip', async (original) => {
  const real =
    await original<typeof import('@/features/workspace/HiddenChip')>();
  return {
    HiddenChip: (props: { onShow?: () => void }) => {
      chips.push(props);
      return real.HiddenChip(props);
    },
  };
});
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => header.navigate,
}));

vi.mock('@/api/hooks', () => ({
  materialQuery: (id: string | null) => ({
    queryFn: () => null,
    queryKey: ['material', id],
  }),
  useFile: () => ({
    data: {
      hidden: header.hidden,
      id: 'f1',
      isPayer: header.isPayer,
      kind: 'office',
      name: 'Deck.pptx',
    },
  }),
  useMaterials: () => ({ data: [], isPending: false }),
  useSetHidden: () => ({ mutate: header.setHidden }),
  useWorkspace: () => ({ data: undefined }),
}));
vi.mock('@/features/workspace/ContentActions', () => ({
  ContentActions: (props: Record<string, unknown>) => {
    header.actions.push(props);
    return null;
  },
}));
vi.mock('@/features/workspace/WorkspaceHealth', () => ({
  OfflineStatus: () => null,
  WorkspaceStatusButton: () => null,
}));

function render(menuShown: boolean, standalone = false) {
  const editorStatus = createEditorStatusStore();
  editorStatus.getState().report({ saveState: 'saved' });
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <Header
        editorStatus={editorStatus}
        imageZoom={1}
        isFullscreen={false}
        item={{ id: 'f1', kind: 'file' }}
        menuBar={<span data-testid="menu-slot" />}
        menuShown={menuShown}
        onDeleted={() => undefined}
        oneColumn={{
          addItems: [],
          filesOpen: false,
          onOpenFiles: () => undefined,
          settingsItems: [],
          workspaceIconId: 'flask',
          workspaceName: 'Biology',
        }}
        onImageZoomChange={() => undefined}
        onToggleFullscreen={() => undefined}
        presence={createPresenceStore()}
        readOnly={false}
        standalone={standalone}
        topics={[]}
        workspaceId="ws_1"
      />
    </QueryClientProvider>
  );
}

/** An Office file's header is one row until its menus arrive, then two
 * (Epo 2026-10-20); its save status sits on the top row beside the name at
 * every width, a phone's one-column header included. */
it('keeps one row until the file loads and the status beside the name', () => {
  for (const loaded of [false, true]) {
    const html = render(loaded);
    expect(html).toContain(`data-rows="${loaded ? 2 : 1}"`);
    const top = html.slice(0, html.indexOf('data-testid="menu-slot"'));
    expect(top).toContain('data-testid="editor-save-state"');
    expect(top.indexOf('Deck.pptx')).toBeLessThan(
      top.indexOf('data-testid="editor-save-state"')
    );
    // The menu bar's slot stays mounted (the runtime portals into it), hidden
    // until the file loads.
    const at = html.indexOf('data-testid="menu-slot"');
    const container = html.slice(html.lastIndexOf('<div', at), at);
    expect(HIDDEN.test(container)).toBe(!loaded);
  }
});

/** A workspace file is moved by its workspace's owner or its payer (Epo
 * 2026-10-27), and the open one follows itself into its new workspace. */
it('offers the payer Move to… and opens the moved file in its new workspace', () => {
  header.isPayer = true;
  header.actions.length = 0;
  render(true);
  const { canMoveTo, onMoved } = header.actions[0] as {
    canMoveTo: boolean;
    onMoved: (file: { id: string; workspaceId: string }) => void;
  };
  expect(canMoveTo).toBe(true);
  onMoved({ id: 'f1', workspaceId: 'ws_2' });
  expect(header.navigate).toHaveBeenCalledWith({
    params: { workspaceId: 'ws_2' },
    replace: true,
    search: { file: 'f1' },
    to: '/workspaces/$workspaceId',
  });
  // Another editor keeps the topic-only Move.
  header.isPayer = false;
  header.actions.length = 0;
  render(true);
  expect(header.actions[0]?.canMoveTo).toBe(false);
  // The file's own page offers it to its payer too.
  header.isPayer = true;
  header.actions.length = 0;
  render(true, true);
  expect(header.actions[0]?.canMoveTo).toBe(true);
});

/** An item hidden from members says so after its name (X2, Epo 2026-11-03). */
it('marks an item hidden from members beside its name', () => {
  const label = m.content_hidden_from_members();
  header.hidden = true;
  const html = render(true);
  header.hidden = false;
  expect(html).toContain(label);
  expect(html.indexOf('Deck.pptx')).toBeLessThan(html.indexOf(label));
});

/** Its owners and editors show it to members from the chip, as from the ⋮
 * menu's Show to members (Epo 2026-11-03): a button, so the keyboard reaches
 * it, that says what it does. */
it('shows a hidden item to members from its chip', () => {
  header.hidden = true;
  chips.length = 0;
  const html = render(true);
  header.hidden = false;
  expect(html).toMatch(CHIP_BUTTON);
  expect(html).toContain(m.content_show_to_members());
  chips[0]?.onShow?.();
  expect(header.setHidden).toHaveBeenCalledWith(
    { hidden: false, id: 'f1', type: 'file' },
    { onError: expect.any(Function) }
  );
});
