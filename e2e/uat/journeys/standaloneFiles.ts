/* biome-ignore-all lint/suspicious/noMisplacedAssertion: Shared assertion helpers execute inside the UAT tests. */
import assert from 'node:assert/strict';
import type { Locator, Page } from '@playwright/test';
import { showPanelView } from '../../helpers/panelView';
import { m } from '../../i18n';
import { fileRow, sha256, string } from './files';
import { type Actor, expect, type UatRun } from './runtime';

/**
 * Files › Add file › No workspace › Upload from your computer, as `actor`
 * (the run's owner unless given): a small `.bin` the server only stores (no
 * parser, so no credits or provider call). Returns the file's id once its
 * row, upload session and exact bytes check out.
 */
export async function uploadStandalone(
  run: UatRun,
  name: string,
  bytes: Buffer,
  actor: Actor = run.owner
) {
  const page = actor.page;
  await page.goto(`${run.env.appUrl}/files`);
  await page
    .getByRole('button', { exact: true, name: m.action_add_file() })
    .click();
  await page
    .getByRole('dialog', { name: m.files_add_destination_title() })
    .getByRole('button', { exact: true, name: m.clone_no_workspace() })
    .click();
  // The picker stays disabled until the upload policy is ready.
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: m.source_upload_computer() }).click(),
  ]);
  await chooser.setFiles({
    buffer: bytes,
    mimeType: 'application/octet-stream',
    name,
  });
  const uploaded = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/sources/uploads' &&
      response.request().method() === 'POST'
  );
  // Consume the response promise even when submission fails.
  const clicked = page
    .getByRole('button', { exact: true, name: m.action_upload() })
    .click();
  const [response] = await Promise.all([uploaded, clicked]);
  if (response.status() !== 201)
    assert.fail(
      `upload answered ${response.status()}: ${await response.text()}`
    );
  const sessions = await run.query(
    'SELECT id,file_id,status FROM upload_sessions WHERE workspace_id IS NULL AND user_id=%s AND name=%s AND file_id IS NOT NULL ORDER BY created_at DESC LIMIT 1',
    [actor.id, name]
  );
  const id = string(sessions[0]?.file_id);
  await run.record('file', id, { standalone: true });
  await run.record('upload', string(sessions[0]?.id), { standalone: true });
  assert.equal(sessions[0]?.status, 'completed');
  const row = await fileRow(run, id);
  const key = string(row.blob_path);
  // In the manifest before it is read, so a failed read cannot leave it out.
  await run.record('blob', key, { fileId: id, sourceSha256: sha256(bytes) });
  const stored = await run.blob(key);
  assert.equal(stored.sha256, sha256(bytes));
  assert.equal(stored.size, bytes.length);
  expect(row).toMatchObject({
    parse_mode: 'none',
    status: 'ready',
    user_id: actor.id,
    workspace_id: null,
  });
  return id;
}

/** The file's card on the Files page, found by its (run-unique) name. */
export const fileCard = (page: Page, name: string) =>
  page.locator('[data-item]').filter({ hasText: name });

/** Files page filter › Location › Workspace only. */
export async function filterWorkspaceOnly(page: Page) {
  await page
    .getByRole('button', { exact: true, name: m.workspaces_filter() })
    .click();
  await page
    .getByRole('button', {
      exact: true,
      name: m.files_location_workspace(),
    })
    .click();
  await expect(page).toHaveURL(
    (url) => url.searchParams.get('location') === 'workspace'
  );
  await page.keyboard.press('Escape');
}

/** The file's row in the workspace's Files panel tree. */
export function treeRow(page: Page, fileId: string) {
  return page
    .locator('[data-workspace-file-tree]')
    .locator(`[data-workspace-content-row="file:${fileId}"]`);
}

/** The workspace page with its Files panel showing (`?file=` opens one). */
export async function openWorkspaceFiles(
  run: UatRun,
  page: Page,
  workspaceId: string,
  fileId?: string
) {
  await page.goto(
    `${run.env.appUrl}/workspaces/${workspaceId}${fileId ? `?file=${encodeURIComponent(fileId)}` : ''}`
  );
  await showPanelView(page, m.workspace_tab_files());
}

/**
 * Picks Move to… in an open ⋮ (`menu` holds the trigger), then the target
 * workspace in the Move dialog, and moves. Returns the files the server
 * moved (POST /api/files/move).
 */
export async function moveTo(page: Page, menu: Locator, target: string) {
  // Row and card menus show on hover.
  await menu.hover();
  await menu.getByRole('button', { name: m.a11y_open_menu() }).click();
  await page
    .getByRole('menuitem', { exact: true, name: m.action_move_to() })
    .click();
  const dialog = page.getByRole('dialog', { name: m.content_move_file() });
  await dialog
    .getByRole('combobox', { name: m.question_ui_workspace() })
    .click();
  await page.getByRole('option', { name: target }).click();
  const moved = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/files/move' &&
      response.request().method() === 'POST'
  );
  const [response] = await Promise.all([
    moved,
    dialog.getByRole('button', { exact: true, name: m.action_move() }).click(),
  ]);
  if (response.status() !== 200)
    assert.fail(`move answered ${response.status()}: ${await response.text()}`);
  await expect(dialog).toBeHidden();
  return (await response.json()) as { id: string; workspaceId: string }[];
}

/** No provider session or model, caption or parse usage belongs to the
 * actor, a fresh account of this run (a standalone file has no workspace to
 * scope it by). */
export async function noActorProviderCalls(run: UatRun, actor: Actor) {
  const rows = await run.query(
    `SELECT (SELECT count(*)::int FROM provider_sessions WHERE actor_user_id=%s) AS sessions,
    (SELECT count(*)::int FROM usage_events WHERE actor_user_id=%s
      AND kind IN ('llm','embedding','caption','parse')) AS usage`,
    [actor.id, actor.id]
  );
  assert.deepEqual(rows[0], { sessions: 0, usage: 0 });
}
