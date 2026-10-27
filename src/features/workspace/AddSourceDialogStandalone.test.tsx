import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { qk } from '@/api/client';
import type { Workspace } from '@/api/types';
import { m } from '@/i18n';
import { sourceUploadPolicy } from '@/mocks/sourceUploadPolicy';
import { AddSourceDialog, type PendingSource } from './AddSourceDialog';

vi.mock('@/components/ui/Dialog', async (original) => ({
  ...(await original<typeof import('@/components/ui/Dialog')>()),
  DialogFooter: ({ children }: { children: ReactNode }) => children,
  DialogPrimary: ({ children }: { children: ReactNode }) => children,
  SimpleDialog: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/components/ui/Tabs', () => ({
  Tabs: ({ tabs }: { tabs: { value: string }[] }) =>
    tabs.map((tab) => <span data-tab={tab.value} key={tab.value} />),
}));
vi.mock('@/lib/useProviderConnect', () => ({
  useMicrosoftLoginHint: () => null,
  useProviderConnect: () => vi.fn(),
}));
vi.mock('./ChapterSelect', async (original) => ({
  ...(await original<typeof import('./ChapterSelect')>()),
  ChapterSelect: () => <span data-chapter-select="" />,
}));

const row: PendingSource = {
  analysisStatus: 'idle',
  chapterId: null,
  chapterName: null,
  contentType: 'application/pdf',
  file: new File(['x'], 'notes.pdf'),
  key: 'local-notes',
  kind: 'pdf',
  name: 'notes.pdf',
  origin: 'local',
  parseMode: 'none',
  sizeBytes: 2048,
  sizeEstimate: false,
};

function render(workspaceId: string | null) {
  const client = new QueryClient();
  client.setQueryData(
    qk.sourceUploadPolicy(workspaceId ?? undefined),
    sourceUploadPolicy
  );
  client.setQueryData(qk.workspace('ws_1'), {
    fileCount: 3,
    filesLimit: 50,
    id: 'ws_1',
  } as Workspace);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <AddSourceDialog
        initialSources={[row]}
        onClose={() => undefined}
        open
        workspaceId={workspaceId}
      />
    </QueryClientProvider>
  );
}

// No workspace (P2, 2026-10-27): Upload and Import only, rows without a
// chapter, and no workspace file room.
it('leaves chapters, the file room and Create out for No workspace', () => {
  const room = m.source_workspace_file_capacity({ limit: 50, used: 3 });
  const workspace = render('ws_1');
  expect(workspace).toContain('data-tab="create"');
  expect(workspace).toContain('data-chapter-select');
  expect(workspace).toContain(room);

  const standalone = render(null);
  expect(standalone).toContain('data-tab="upload"');
  expect(standalone).toContain('data-tab="import"');
  expect(standalone).not.toContain('data-tab="create"');
  expect(standalone).not.toContain('data-chapter-select');
  expect(standalone).not.toContain(room);
  expect(standalone).toContain('notes.pdf');
});
