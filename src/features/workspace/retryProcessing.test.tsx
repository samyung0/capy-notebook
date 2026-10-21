import {
  QueryClient,
  QueryClientProvider,
  QueryObserver,
} from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, qk } from '@/api/client';
import {
  useFiles,
  useRetryFileProcessing,
  useRetryingFileIds,
} from '@/api/hooks';
import type { SourceFile, Workspace, WorkspaceStats } from '@/api/types';
import type { MenuItem } from '@/components/ui/Menu';
import { FileListItem } from '@/features/files/FileListItem';
import { m } from '@/i18n';
import { IndexingTab } from './IndexingTab';
import { retryFailedFile } from './retryProcessing';

const userToast = vi.hoisted(() => vi.fn());
vi.mock('@/components/ui/userToast', () => ({ userToast }));

// No DOM here: each render records the Retry control's props, and the test
// calls its onClick. State lives in the query client between renders.
const controls = vi.hoisted(() => ({
  buttons: [] as {
    children?: unknown;
    disabled?: boolean;
    onClick?: () => void;
  }[],
  menus: [] as MenuItem[][],
}));
vi.mock('@/components/ui/Button', async (original) => ({
  ...(await original<typeof import('@/components/ui/Button')>()),
  Button: (props: (typeof controls.buttons)[number]) => {
    controls.buttons.push(props);
    return null;
  },
}));
vi.mock('@/features/workspace/ContentActions', () => ({
  ContentActions: ({ leadingItems }: { leadingItems: MenuItem[] }) => {
    controls.menus.push(leadingItems);
    return null;
  },
}));
vi.mock('@/features/workspace/AddSourceDialog', () => ({
  AddSourceDialog: () => null,
}));
vi.mock('@tanstack/react-router', async (original) => ({
  ...(await original<typeof import('@tanstack/react-router')>()),
  Link: ({ children }: { children: ReactNode }) => children,
}));

afterEach(() => {
  userToast.mockReset();
  vi.restoreAllMocks();
});

describe('retryFailedFile', () => {
  it('retries a still-indexed file in one click, without the dialog', async () => {
    const retry = vi.fn(() => Promise.resolve());
    const openDialog = vi.fn();
    retryFailedFile({ id: 'f_1', indexed: true }, retry, openDialog);
    await vi.waitFor(() => expect(userToast).toHaveBeenCalledOnce());
    expect(retry).toHaveBeenCalledWith({ id: 'f_1', parseMode: 'fast' });
    expect(openDialog).not.toHaveBeenCalled();
  });

  it('opens the dialog for a file that is not indexed', () => {
    const retry = vi.fn(() => Promise.resolve());
    const openDialog = vi.fn();
    retryFailedFile({ id: 'f_1', indexed: false }, retry, openDialog);
    expect(openDialog).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
  });
});

const WS = 'ws_1';
const partial = {
  hasBytes: true,
  id: 'f_1',
  indexed: true,
  kind: 'pdf',
  name: 'scan.pdf',
  status: 'failed',
  workspaceId: WS,
} as SourceFile;

/** FilesPanel's wiring: one mutation for the list, pending ids per row. */
function Rows() {
  const { data: files } = useFiles(WS);
  const { mutateAsync } = useRetryFileProcessing(WS);
  const retrying = useRetryingFileIds(WS);
  return files?.map((file) => (
    <FileListItem
      active={false}
      file={file}
      key={file.id}
      onOpen={() => {}}
      retry={mutateAsync}
      retryPending={retrying.includes(file.id)}
      workspaceId={WS}
    />
  ));
}

const surfaces = {
  'the Indexing tab': {
    element: (
      <IndexingTab
        error={null}
        stats={
          {
            fileChanges: [],
            indexed: 1,
            moreNoteChanges: 0,
            noteChanges: [],
            notIndexable: 0,
            notIndexed: 0,
          } as unknown as WorkspaceStats
        }
        workspace={{ autoProcess: true, id: WS, isOwner: true } as Workspace}
      />
    ),
    retry: () =>
      controls.buttons.find(
        (button) => button.children === m.error_action_retry()
      ),
  },
  'the row menu': {
    element: <Rows />,
    retry: () =>
      controls.menus
        .at(-1)
        ?.find((item) => item.label === m.files_retry_processing()),
  },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe.each(Object.entries(surfaces))(
  'Retry on a partial file in %s',
  (_name, surface) => {
    it('POSTs in one click and stays off until the file leaves failed', async () => {
      const qc = new QueryClient();
      qc.setQueryData(qk.files(WS), [partial]);
      // The panel's live list: the retry's settle refetches it.
      const files = new QueryObserver(qc, {
        queryFn: () => api.get<SourceFile[]>(`/workspaces/${WS}/files`),
        queryKey: qk.files(WS),
        staleTime: Number.POSITIVE_INFINITY,
      });
      const unsubscribe = files.subscribe(() => {});
      const post = deferred<undefined>();
      const list = deferred<SourceFile[]>();
      const posted = vi.spyOn(api, 'post').mockReturnValue(post.promise);
      vi.spyOn(api, 'get').mockReturnValue(list.promise);
      const retry = () => {
        controls.buttons = [];
        controls.menus = [];
        renderToStaticMarkup(
          <QueryClientProvider client={qc}>
            {surface.element}
          </QueryClientProvider>
        );
        return surface.retry();
      };

      const first = retry();
      expect(first?.disabled).toBeFalsy();
      first?.onClick?.();
      await vi.waitFor(() =>
        expect(posted).toHaveBeenCalledWith('/files/f_1/retry-processing', {
          parseMode: 'fast',
        })
      );
      expect(retry()?.disabled).toBe(true);

      // The POST landed; the list still shows the file failed until it refetches.
      post.resolve(undefined);
      await vi.waitFor(() => expect(api.get).toHaveBeenCalled());
      expect(retry()?.disabled).toBe(true);

      list.resolve([{ ...partial, status: 'pending' }]);
      await vi.waitFor(() => expect(qc.isMutating()).toBe(0));
      expect(retry()).toBeUndefined();
      expect(posted).toHaveBeenCalledOnce();
      unsubscribe();
    });
  }
);
