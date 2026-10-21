import type { Page, Route } from '@playwright/test';
import { expect, test } from '../fixtures/actors';
import { showPanelView } from '../helpers/panelView';
import { m } from '../i18n';

// Upload/worker responses are mocked; workspace access and cleanup use the
// disposable local API. These cases do not claim to exercise a real worker.
async function sourceResponses(
  page: Page,
  workspaceId: string,
  failure?: 'upload' | 'ingest'
) {
  const endpoint = '/api/workspaces/' + workspaceId + '/sources/uploads';
  const uploads: Record<string, unknown>[] = [];
  const bodies: Buffer[] = [];
  const files: Record<string, unknown>[] = [];
  await page.route('**/api/me/ingest-slots', (route) =>
    route.fulfill({ json: { slotsFree: 1, slotsLimit: 1, slotsUsed: 0 } })
  );
  await page.route('**/api/workspaces/' + workspaceId + '/files', (route) =>
    route.fulfill({ json: files })
  );
  // Every ticket's turn comes at once; the gateway's line is not under test.
  await page.route('**' + endpoint + '/tickets', (route) =>
    route.fulfill({
      json: { position: 0, ticketId: 'utk_e2e' },
      status: 201,
    })
  );
  // One streamed request per source (with its ticket): its metadata part,
  // then its file part.
  await page.route(
    (url) => url.pathname === endpoint,
    async (route) => {
      const request = route.request();
      const raw = new Uint8Array(request.postDataBuffer() ?? []);
      const form = await new Response(raw, {
        headers: { 'content-type': request.headers()['content-type'] },
      }).formData();
      const metadata = JSON.parse(String(form.get('metadata'))) as Record<
        string,
        unknown
      >;
      uploads.push(metadata);
      bodies.push(Buffer.from(await (form.get('file') as Blob).arrayBuffer()));
      if (failure === 'upload' && uploads.length === 1) {
        await route.fulfill({
          json: { detail: 'Injected upload failure', status: 503 },
          status: 503,
        });
        return;
      }
      const failed = failure === 'ingest' && files.length === 0;
      const file = {
        addedAt: new Date().toISOString(),
        chapterId: null,
        hasBytes: true,
        id: 'f_upload_' + uploads.length,
        indexed: !failed,
        kind: 'txt',
        name: String(metadata.name),
        position: files.length + 1,
        revision: 1,
        sizeBytes: Number(metadata.sizeBytes),
        status: failed ? 'processing' : 'ready',
        workspaceId,
      };
      files.push(file);
      await route.fulfill({ json: file, status: 201 });
    }
  );
  return { bodies, files, uploads };
}

async function chooseSources(page: Page, workspaceId: string, names: string[]) {
  await page.goto('/workspaces/' + workspaceId);
  await showPanelView(page, m.workspace_tab_files());
  await page
    .locator('[data-workspace-add-menu]')
    .getByRole('button', { exact: true, name: m.action_add_file() })
    .click();
  await page
    .getByRole('menuitem', { name: m.action_upload_or_import() })
    .click();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: m.source_upload_computer() }).click(),
  ]);
  await chooser.setFiles(
    names.map((name) => ({
      buffer: Buffer.from('Study facts for ' + name + '.\n'),
      mimeType: 'text/plain',
      name,
    }))
  );
}

test('a failed upload is reported in the panel and toast, and adding it again succeeds', async ({
  ownerApi,
  ownerPage,
  workspaceFactory,
}) => {
  const workspace = await workspaceFactory.create({ name: 'Failed upload' });
  const requests = await sourceResponses(ownerPage, workspace.id, 'upload');
  const name = 'upload-recovery.txt';
  const bytes = Buffer.from('Study facts for ' + name + '.\n');
  await chooseSources(ownerPage, workspace.id, [name]);
  const submit = ownerPage.getByRole('button', {
    exact: true,
    name: m.action_upload(),
  });
  const rejected = ownerPage.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
        '/api/workspaces/' + workspace.id + '/sources/uploads' &&
      response.status() === 503
  );
  await submit.click();
  expect((await rejected).status()).toBe(503);
  // The dialog hands the source to the transfer panel and closes.
  await expect(ownerPage.getByRole('dialog')).toHaveCount(0);
  const panel = ownerPage.getByTestId('source-transfer-panel');
  await expect(
    panel.locator('[data-transfer-status="error"]', { hasText: name })
  ).toBeVisible();
  await expect(ownerPage.locator('[data-sonner-toast]')).toContainText(name);
  expect(requests.uploads).toHaveLength(1);
  expect(requests.files).toEqual([]);

  await chooseSources(ownerPage, workspace.id, [name]);
  await submit.click();
  await expect.poll(() => requests.files.length).toBe(1);
  // Adding it again is a new submission, so a new batch of one.
  expect(requests.uploads).toEqual([
    expect.objectContaining({
      batchTotal: 1,
      name,
      parseMode: 'none',
      sizeBytes: bytes.length,
    }),
    { ...requests.uploads[0], batchId: expect.any(String) },
  ]);
  expect(requests.uploads[1].batchId).not.toBe(requests.uploads[0].batchId);
  expect(requests.bodies).toEqual([bytes, bytes]);
  expect(requests.files[0].status).toBe('ready');
  const persisted = await ownerApi.get(
    '/api/workspaces/' + workspace.id + '/files'
  );
  expect(persisted.status()).toBe(200);
  expect(await persisted.json()).toEqual([]);
});

test('a terminal ingest failure releases the next queued source', async ({
  ownerPage,
  workspaceFactory,
}) => {
  const workspace = await workspaceFactory.create({
    name: 'Failed ingest queue',
  });
  const requests = await sourceResponses(ownerPage, workspace.id, 'ingest');
  const streams: Route[] = [];
  await ownerPage.route(
    (url) =>
      url.pathname === '/api/stream' &&
      url.searchParams.get('workspace') === workspace.id,
    (route) => {
      streams.push(route);
    }
  );
  const readAfterReconnect = async () => {
    await expect.poll(() => streams.length).toBe(1);
    const read = ownerPage.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
        '/api/workspaces/' + workspace.id + '/files'
    );
    await streams
      .shift()!
      .fulfill({ body: ': connected\n\n', contentType: 'text/event-stream' });
    return (await read).json() as Promise<Record<string, unknown>[]>;
  };
  await chooseSources(ownerPage, workspace.id, [
    'failed-ingest.txt',
    'next-source.txt',
  ]);
  await ownerPage
    .getByRole('button', { exact: true, name: m.action_upload() })
    .click();
  await expect.poll(() => requests.files.length).toBe(1);
  const processing = await readAfterReconnect();
  expect(processing[0].status).toBe('processing');
  expect(requests.uploads).toHaveLength(1);
  requests.files[0].status = 'failed';
  const failed = await readAfterReconnect();
  expect(failed[0]).toMatchObject({ indexed: false, status: 'failed' });
  await expect.poll(() => requests.files.length).toBe(2);
  expect(requests.uploads.map((request) => request.name)).toEqual([
    'failed-ingest.txt',
    'next-source.txt',
  ]);
  expect(requests.bodies).toEqual([
    Buffer.from('Study facts for failed-ingest.txt.\n'),
    Buffer.from('Study facts for next-source.txt.\n'),
  ]);
});
