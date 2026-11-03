import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { qk } from '@/api/client';
import type { BillingInfo, Workspace } from '@/api/types';
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
vi.mock('./TopicSelect', async (original) => ({
  ...(await original<typeof import('./TopicSelect')>()),
  TopicSelect: () => <span data-topic-select="" />,
}));

const row: PendingSource = {
  analysisStatus: 'idle',
  contentType: 'application/pdf',
  file: new File(['x'], 'notes.pdf'),
  key: 'local-notes',
  kind: 'pdf',
  name: 'notes.pdf',
  origin: 'local',
  parseMode: 'none',
  sizeBytes: 2048,
  sizeEstimate: false,
  topicId: null,
  topicName: null,
};

function render(
  workspaceId: string | null,
  {
    billing,
    rows = [row],
  }: { billing?: BillingInfo; rows?: PendingSource[] } = {}
) {
  const client = new QueryClient();
  if (billing) client.setQueryData(qk.billing, billing);
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
        initialSources={rows}
        onClose={() => undefined}
        open
        workspaceId={workspaceId}
      />
    </QueryClientProvider>
  );
}

// No workspace (P2, 2026-10-27): Upload and Import only, rows without a
// topic, and no workspace file room.
it('leaves topics, the file room and Create out for No workspace', () => {
  const room = m.source_workspace_file_capacity({ limit: 50, used: 3 });
  const workspace = render('ws_1');
  expect(workspace).toContain('data-tab="create"');
  expect(workspace).toContain('data-topic-select');
  expect(workspace).toContain(room);

  const standalone = render(null);
  expect(standalone).toContain('data-tab="upload"');
  expect(standalone).toContain('data-tab="import"');
  expect(standalone).not.toContain('data-tab="create"');
  expect(standalone).not.toContain('data-topic-select');
  expect(standalone).not.toContain(room);
  expect(standalone).toContain('notes.pdf');
});

// Board T4 (Epo 2026-11-03): one Topic for the whole upload, and one line
// when the uploader is out of AI credits.
it('asks one topic for the whole upload and says when credits ran out', () => {
  const spent = {
    creditSettings: { autoReload: false },
    creditsLimitMicros: 300_000_000,
    creditsPurchasedMicros: 0,
    creditsReservedMicros: 0,
    creditsUsedMicros: 300_000_000,
  } as BillingInfo;
  const html = render('ws_1', {
    billing: spent,
    rows: [row, { ...row, key: 'local-more', name: 'more.pdf' }],
  });
  expect(html.match(/data-topic-select/g)).toHaveLength(1);
  expect(html).toContain(m.source_upload_topic());
  // Static markup escapes the apostrophes.
  expect(html).toContain(
    m.source_upload_no_credits().replaceAll("'", '&#x27;')
  );
});
