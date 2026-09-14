import type { Page, Route } from '@playwright/test';
import { expect, test } from '../fixtures/actors';

// Upload/worker responses are mocked; workspace access and cleanup use the
// disposable local API. These cases do not claim to exercise a real worker.
async function sourceResponses(
  page: Page,
  workspaceId: string,
  failure?: 'reservation' | 'put' | 'ingest'
) {
  const endpoint = '/api/workspaces/' + workspaceId + '/sources/uploads';
  const reservations: Record<string, unknown>[] = [];
  const puts: Buffer[] = [];
  const completed: string[] = [];
  const files: Record<string, unknown>[] = [];
  const order: string[] = [];
  await page.route('**/api/me/ingest-slots', (route) =>
    route.fulfill({ json: { slotsFree: 1, slotsLimit: 1, slotsUsed: 0 } })
  );
  await page.route('**/api/workspaces/' + workspaceId + '/files', (route) =>
    route.fulfill({ json: files })
  );
  await page.route('**' + endpoint, async (route) => {
    reservations.push(
      route.request().postDataJSON() as Record<string, unknown>
    );
    order.push('reserve');
    if (failure === 'reservation' && reservations.length === 1) {
      await route.fulfill({
        json: { detail: 'Injected reservation failure', status: 503 },
        status: 503,
      });
      return;
    }
    const uploadId = 'up_failure_' + reservations.length;
    await route.fulfill({
      json: {
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        headers: { 'Content-Type': 'text/plain' },
        method: 'PUT',
        uploadId,
        url: process.env.E2E_BASE_URL + '/__source-test-put/' + uploadId,
      },
      status: 201,
    });
  });
  await page.route('**/__source-test-put/*', async (route) => {
    puts.push(route.request().postDataBuffer() ?? Buffer.alloc(0));
    order.push('put');
    await route.fulfill({
      body: '',
      status: failure === 'put' && puts.length === 1 ? 503 : 200,
    });
  });
  await page.route('**' + endpoint + '/*/complete', async (route) => {
    const uploadId = new URL(route.request().url()).pathname.split('/').at(-2)!;
    completed.push(uploadId);
    order.push('complete');
    const reservation = reservations[Number(uploadId.split('_').at(-1)) - 1];
    const failed = failure === 'ingest' && completed.length === 1;
    const file = {
      addedAt: new Date().toISOString(),
      chapterId: null,
      hasBytes: true,
      id: 'f_' + uploadId,
      indexed: !failed,
      kind: 'txt',
      name: String(reservation.name),
      position: completed.length,
      revision: 1,
      sizeBytes: Number(reservation.sizeBytes),
      status: failed ? 'processing' : 'ready',
      workspaceId,
    };
    files.push(file);
    await route.fulfill({ json: file, status: 201 });
  });
  return { completed, files, order, puts, reservations };
}

async function chooseSources(page: Page, workspaceId: string, names: string[]) {
  await page.goto('/workspaces/' + workspaceId);
  await page.getByRole('button', { exact: true, name: 'Add file' }).click();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: /^Upload from your computer/ }).click(),
  ]);
  await chooser.setFiles(
    names.map((name) => ({
      buffer: Buffer.from('Study facts for ' + name + '.\n'),
      mimeType: 'text/plain',
      name,
    }))
  );
}

for (const failure of ['reservation', 'put'] as const) {
  test(
    'a failed ' +
      failure +
      ' keeps the source for an explicit successful resubmit',
    async ({ ownerApi, ownerPage, workspaceFactory }) => {
      const workspace = await workspaceFactory.create({
        name: 'Failed ' + failure,
      });
      const requests = await sourceResponses(ownerPage, workspace.id, failure);
      const name = failure + '-recovery.txt';
      const bytes = Buffer.from('Study facts for ' + name + '.\n');
      await chooseSources(ownerPage, workspace.id, [name]);
      const submit = ownerPage.getByRole('button', {
        exact: true,
        name: 'Upload',
      });
      const failedPath =
        failure === 'reservation'
          ? '/api/workspaces/' + workspace.id + '/sources/uploads'
          : '/__source-test-put/up_failure_1';
      const rejected = ownerPage.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === failedPath &&
          response.status() === 503
      );
      await submit.click();
      expect((await rejected).status()).toBe(503);
      await expect(submit).toBeEnabled();
      expect(requests.reservations).toHaveLength(1);
      expect(requests.completed).toEqual([]);
      expect(requests.puts).toHaveLength(failure === 'put' ? 1 : 0);

      await submit.click();
      await expect.poll(() => requests.completed).toEqual(['up_failure_2']);
      expect(requests.reservations).toEqual([
        expect.objectContaining({
          name,
          parseMode: 'none',
          sizeBytes: bytes.length,
        }),
        requests.reservations[0],
      ]);
      expect(requests.puts.at(-1)).toEqual(bytes);
      expect(requests.files[0].status).toBe('ready');
      const persisted = await ownerApi.get(
        '/api/workspaces/' + workspace.id + '/files'
      );
      expect(persisted.status()).toBe(200);
      expect(await persisted.json()).toEqual([]);
    }
  );
}

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
  await ownerPage.getByRole('button', { exact: true, name: 'Upload' }).click();
  await expect.poll(() => requests.completed).toEqual(['up_failure_1']);
  const processing = await readAfterReconnect();
  expect(processing[0].status).toBe('processing');
  expect(requests.reservations).toHaveLength(1);
  requests.files[0].status = 'failed';
  const failed = await readAfterReconnect();
  expect(failed[0]).toMatchObject({ indexed: false, status: 'failed' });
  await expect
    .poll(() => requests.completed)
    .toEqual(['up_failure_1', 'up_failure_2']);
  expect(requests.order).toEqual([
    'reserve',
    'put',
    'complete',
    'reserve',
    'put',
    'complete',
  ]);
  expect(requests.reservations.map((request) => request.name)).toEqual([
    'failed-ingest.txt',
    'next-source.txt',
  ]);
  expect(requests.puts).toEqual([
    Buffer.from('Study facts for failed-ingest.txt.\n'),
    Buffer.from('Study facts for next-source.txt.\n'),
  ]);
});
