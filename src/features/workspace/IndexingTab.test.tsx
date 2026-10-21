import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '@/api/client';
import type { NoteChange, Workspace, WorkspaceStats } from '@/api/types';
import { m } from '@/i18n';
import { IndexingTab } from './IndexingTab';

const userToast = vi.hoisted(() => vi.fn());
vi.mock('@/components/ui/userToast', () => ({ userToast }));
vi.mock('@/features/workspace/AddSourceDialog', () => ({
  AddSourceDialog: () => null,
}));

// No DOM: each render records the Button props, and the test calls onClick.
const buttons = vi.hoisted(
  () => [] as { children?: unknown; onClick?: () => void }[]
);
vi.mock('@/components/ui/Button', async (original) => ({
  ...(await original<typeof import('@/components/ui/Button')>()),
  Button: (props: (typeof buttons)[number]) => {
    buttons.push(props);
    return null;
  },
}));

afterEach(() => {
  buttons.length = 0;
  userToast.mockReset();
  vi.restoreAllMocks();
});

const note = (materialId: string, state: NoteChange['state']): NoteChange => ({
  lastEditedAt: '2026-10-21T09:00:00Z',
  materialId,
  state,
  title: `Note ${materialId}`,
});

const stats = {
  fileChanges: [
    {
      fileId: 'f_1',
      kind: 'md',
      lastEditedAt: '2026-10-21T08:00:00Z',
      name: 'edited.md',
      state: 'waiting',
    },
  ],
  indexed: 1,
  moreNoteChanges: 3,
  noteChanges: [
    note('n_wait', 'waiting'),
    note('n_fail', 'failed'),
    note('n_queue', 'queued'),
    note('n_proc', 'processing'),
  ],
  notIndexable: 0,
  notIndexed: 0,
} as WorkspaceStats;

function render(workspace: Partial<Workspace>) {
  buttons.length = 0;
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <IndexingTab
        error={null}
        stats={stats}
        workspace={{ autoProcess: true, id: 'ws_1', ...workspace } as Workspace}
      />
    </QueryClientProvider>
  );
}

describe('IndexingTab note changes', () => {
  it('lists notes like files, with the automatic hint on a waiting note only while auto process is on, and counts the notes past the cap', () => {
    const html = render({ isOwner: true });
    const row = (name: string) =>
      html.split('<li').find((item) => item.includes(name));
    for (const { materialId, state } of stats.noteChanges) {
      expect(row(`Note ${materialId}`)).toContain(`data-state="${state}"`);
    }
    expect(html.split(m.workspace_note_change_auto()).length - 1).toBe(1);
    expect(row('Note n_wait')).toContain(m.workspace_note_change_auto());
    expect(html).toContain(m.workspace_note_changes_more({ count: '3' }));
    expect(render({ autoProcess: false, isOwner: true })).not.toContain(
      m.workspace_note_change_auto()
    );
  });

  it('gives the owner Process on waiting and failed notes, none on queued or processing ones, and no Cancel', async () => {
    const posted = vi.spyOn(api, 'post').mockResolvedValue(undefined);
    render({ isOwner: true });
    expect(buttons.map((button) => button.children)).toEqual([
      m.workspace_change_process_all(),
      m.workspace_change_process(),
      m.workspace_change_process(),
      m.error_action_retry(),
    ]);
    buttons.at(-1)?.onClick?.();
    await vi.waitFor(() =>
      expect(posted).toHaveBeenCalledWith(
        '/materials/n_fail/process-changes',
        {}
      )
    );
    posted.mockClear();
    render({ isOwner: true });
    buttons[0]?.onClick?.();
    await vi.waitFor(() => expect(posted).toHaveBeenCalledTimes(3));
    expect(posted.mock.calls.map(([path]) => path).sort()).toEqual([
      '/files/f_1/process-changes',
      '/materials/n_fail/process-changes',
      '/materials/n_wait/process-changes',
    ]);
  });

  it('takes a note queued meanwhile as started, and says when there is nothing to process', async () => {
    const refusal = (code: string) =>
      new ApiError(409, 'Conflict', undefined, { code });
    vi.spyOn(api, 'post').mockRejectedValue(refusal('processing_started'));
    render({ isOwner: true });
    buttons.at(-1)?.onClick?.();
    await vi.waitFor(() =>
      expect(userToast).toHaveBeenCalledWith(
        expect.objectContaining({ variant: 'success' })
      )
    );
    userToast.mockReset();
    vi.spyOn(api, 'post').mockRejectedValue(refusal('nothing_to_process'));
    render({ isOwner: true });
    buttons.at(-1)?.onClick?.();
    await vi.waitFor(() =>
      expect(userToast).toHaveBeenCalledWith(
        expect.objectContaining({
          description: m.error_nothing_to_process_body(),
          variant: 'error',
        })
      )
    );
  });

  it('shows editors the list without actions', () => {
    const html = render({ isOwner: false });
    expect(html).toContain('Note n_wait');
    expect(buttons).toEqual([]);
  });
});
