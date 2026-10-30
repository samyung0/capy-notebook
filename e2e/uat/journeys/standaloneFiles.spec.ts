// Standalone files (todo-standalone-files.md,
// openwiki/authorization-permissions-lifecycles.md): an upload with no
// workspace is its uploader's alone, listed under Files (My files, left
// out by Workspaces only) and opened at /files/{id}. Move puts it into a workspace, never
// out; a workspace file moves on to another workspace, and the open one
// follows itself there. A store-only `.bin` and no parsing anywhere: no
// provider session or model usage.
import { randomUUID } from 'node:crypto';
import { m } from '../../i18n';
import { api, fileRow, noProviderCalls, object, workspace } from './files';
import { expect, test } from './runtime';
import {
  fileCard,
  filterWorkspaceOnly,
  moveTo,
  noActorProviderCalls,
  openWorkspaceFiles,
  treeRow,
  uploadStandalone,
} from './standaloneFiles';

test('standalone files: an owner uploads a file to No workspace, finds it under Standalone, opens it at /files, moves it into a workspace and on to another, where it opens', async ({
  run,
}) => {
  test.setTimeout(600_000);
  const page = run.owner.page;
  const marker = `UAT${randomUUID().replaceAll('-', '')}`;
  const name = `standalone-${marker}.bin`;
  const fileId = await uploadStandalone(
    run,
    name,
    Buffer.from(`Standalone ${marker}`)
  );
  expect(object(await api(run.owner, `/api/files/${fileId}`))).toMatchObject({
    isPayer: true,
    workspaceId: '',
  });

  // 1. Files lists it with no workspace (My files), and Workspaces only
  // leaves it out; it opens at /files/{id}.
  await page.goto(`${run.env.appUrl}/files`);
  const card = fileCard(page, name);
  await expect(card).toHaveCount(1);
  await expect(card).not.toHaveAttribute('data-item-workspace');
  await filterWorkspaceOnly(page);
  await expect(card).toHaveCount(0);
  await page.goto(`${run.env.appUrl}/files`);
  await expect(card).toHaveCount(1);
  await card
    .getByRole('button', { exact: true, name: m.files_select_item({ name }) })
    .dblclick();
  await expect(page).toHaveURL((url) => url.pathname === `/files/${fileId}`);
  await expect(page.getByRole('heading', { name })).toBeVisible();

  // 2. Move to… from its Files card into the first workspace: its tree lists it.
  const first = await workspace(run, 'standalone-a');
  const second = await workspace(run, 'standalone-b');
  const names = Object.fromEntries(
    await Promise.all(
      [first, second].map(
        async (id) =>
          [
            id,
            String(object(await api(run.owner, `/api/workspaces/${id}`)).name),
          ] as const
      )
    )
  );
  await page.goto(`${run.env.appUrl}/files`);
  expect(await moveTo(page, fileCard(page, name), names[first])).toEqual([
    expect.objectContaining({ id: fileId, workspaceId: first }),
  ]);
  expect((await fileRow(run, fileId)).workspace_id).toBe(first);
  await openWorkspaceFiles(run, page, first);
  await expect(treeRow(page, fileId)).toBeVisible();

  // 3. Open there, then Move to… from its tree row into the second
  // workspace: the open file follows itself, listed there and no longer in
  // the first.
  await openWorkspaceFiles(run, page, first, fileId);
  expect(await moveTo(page, treeRow(page, fileId), names[second])).toEqual([
    expect.objectContaining({ id: fileId, workspaceId: second }),
  ]);
  await expect(page).toHaveURL(
    (url) =>
      url.pathname === `/workspaces/${second}` &&
      url.searchParams.get('file') === fileId
  );
  await expect(treeRow(page, fileId)).toBeVisible();
  expect(await fileRow(run, fileId)).toMatchObject({
    status: 'ready',
    user_id: run.owner.id,
    workspace_id: second,
  });
  await openWorkspaceFiles(run, page, first);
  await expect(page.locator('[data-workspace-file-tree]')).toBeVisible();
  await expect(treeRow(page, fileId)).toHaveCount(0);

  for (const id of [first, second]) await noProviderCalls(run, id);
  await noActorProviderCalls(run, run.owner);
});
