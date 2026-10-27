import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { qk } from './client';
import { useUploadSource } from './hooks';
import type { SourceFile } from './types';

vi.mock('./auth', async (original) => ({
  ...(await original<typeof import('./auth')>()),
  USE_MSW: false,
}));
const sent = vi.hoisted(() => ({
  metadata: undefined as object | undefined,
  path: '',
}));
vi.mock('./uploadTurn', () => ({
  uploadWithTicket: async (path: string, metadata: object) => {
    sent.path = path;
    sent.metadata = metadata;
    return {
      id: 'f_alone',
      name: 'notes.pdf',
      status: 'pending',
      workspaceId: '',
    } as SourceFile;
  },
}));

// No workspace: the upload goes to the unscoped route with no chapter, and
// the new file's own query holds the status its ingest events patch.
it('uploads a standalone file to the unscoped route', async () => {
  const qc = new QueryClient();
  let upload: ReturnType<typeof useUploadSource>['mutateAsync'] | undefined;
  function Probe() {
    upload = useUploadSource(null).mutateAsync;
    return null;
  }
  renderToStaticMarkup(
    createElement(QueryClientProvider, { client: qc }, createElement(Probe))
  );
  await upload?.({
    batchId: 'batch_1',
    batchTotal: 1,
    chapterId: null,
    file: new File(['x'], 'notes.pdf'),
    kind: 'pdf',
    parseMode: 'fast',
  });
  expect(sent.path).toBe('/sources/uploads');
  expect(sent.metadata).not.toHaveProperty('chapterId');
  expect(sent.metadata).not.toHaveProperty('chapterName');
  expect(qc.getQueryData(qk.file('f_alone'))).toMatchObject({
    ingestPct: 0,
    status: 'pending',
  });
});
