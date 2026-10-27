import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { createPresenceStore } from '@/features/collaboration/presence';
import { createEditorStatusStore, Header } from './CenterContentHeader';

const HIDDEN = /\bhidden\b/;

// The ⋮'s props, and where the header sends the reader.
const header = vi.hoisted(() => ({
  actions: [] as Record<string, unknown>[],
  isPayer: false,
  navigate: vi.fn(),
}));
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
      id: 'f1',
      isPayer: header.isPayer,
      kind: 'office',
      name: 'Deck.pptx',
    },
  }),
  useMaterials: () => ({ data: [], isPending: false }),
  useWorkspace: () => ({ data: undefined }),
}));
vi.mock('@/features/study/studyItems', () => ({
  useStudyActions: () => ({ menuItems: () => [], set: () => undefined }),
  useStudyStates: () => ({ enabled: false, states: new Map() }),
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

function render(menuShown: boolean) {
  const editorStatus = createEditorStatusStore();
  editorStatus.getState().report({ saveState: 'saved' });
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <Header
        chapters={[]}
        editorStatus={editorStatus}
        imageZoom={1}
        isFullscreen={false}
        item={{ id: 'f1', kind: 'file' }}
        materialMode={null}
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
        onMaterialModeChange={() => undefined}
        onToggleFullscreen={() => undefined}
        presence={createPresenceStore()}
        readOnly={false}
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
    search: { file: 'f1' },
    to: '/workspaces/$workspaceId',
  });
  // Another editor keeps the chapter-only Move.
  header.isPayer = false;
  header.actions.length = 0;
  render(true);
  expect(header.actions[0]?.canMoveTo).toBe(false);
});
