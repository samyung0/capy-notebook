import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { m } from '../../i18n';
import {
  api,
  fixture,
  invite,
  noProviderCalls,
  object,
  string,
  upload,
} from './files';
import {
  apiNote,
  contentText,
  lineAfter,
  notesWorkspace,
  openNote,
} from './note';
import { editOffice, openEditor, saved, savedFacts } from './office';
import { type Actor, expect, test, type UatRun } from './runtime';

// A member's role over time (openwiki/authorization-permissions-lifecycles.md):
// an editor saves a note line and a store-only DOCX edit from the browser, then
// the owner demotes them to viewer and removes them in the members UI. Both
// changes discard-evict the workspace's rooms, and the open editors reconnect
// with a fresh token (plate-editor.md, connection lifetime and refusals).
// Store-only upload and Auto process edits off: no provider call.

/** editOffice's DOCX sentence for a collaborator. */
const SENTENCE = 'Collaborator confirmed the survey starts in July.';

const membership = (run: UatRun, workspaceId: string, userId: string) =>
  run.query(
    'SELECT role FROM workspace_members WHERE workspace_id=%s AND user_id=%s',
    [workspaceId, userId]
  );

/** Whether the workspace is in the actor's workspace list. */
async function listed(actor: Actor, workspaceId: string) {
  const rows = (await api(actor, '/api/workspaces')) as unknown[];
  return rows.some((row) => object(row).id === workspaceId);
}

/**
 * The next collaboration token the page's own client gets at `path`: `read`
 * is a 201 read token, `refused` a 404. `asked` tells an editor's request (its
 * own access) from a View's read channel (`{access: 'read'}`).
 */
function browserToken(
  page: Page,
  path: string,
  asked: 'own' | 'read',
  outcome: 'read' | 'refused'
) {
  return page.waitForResponse(
    async (response) => {
      const request = response.request();
      if (
        request.method() !== 'POST' ||
        new URL(response.url()).pathname !== path ||
        (request.postData() ?? '').includes('"read"') !== (asked === 'read')
      )
        return false;
      if (outcome === 'refused') return response.status() === 404;
      return (
        response.status() === 201 &&
        object(await response.json()).access === 'read'
      );
    },
    { timeout: 120_000 }
  );
}

/**
 * The owner's members UI: Workspace settings → Sharing → the member's menu →
 * Manage member → Role → View, or Remove. Returns the API's status.
 */
async function changeMember(
  run: UatRun,
  workspaceId: string,
  member: Actor,
  change: 'viewer' | 'remove'
) {
  const roster = (await api(
    run.owner,
    `/api/workspaces/${workspaceId}/members`
  )) as unknown[];
  const name = string(
    roster.map(object).find((row) => row.userId === member.id)?.name
  );
  const page = run.owner.page;
  await page.goto(`${run.env.appUrl}/workspaces/${workspaceId}`);
  await page
    .getByRole('button', { exact: true, name: m.workspace_settings() })
    .first()
    .click();
  const settings = page.getByRole('dialog', { name: m.workspace_settings() });
  await settings
    .getByRole('tab', { exact: true, name: m.workspace_sharing() })
    .click();
  const people = settings.getByRole('region', { name: m.members_people() });
  await people.getByText(name, { exact: true }).waitFor();
  const path = `/api/workspaces/${workspaceId}/members/${member.id}`;
  const method = change === 'remove' ? 'DELETE' : 'PATCH';
  const response = page.waitForResponse(
    (r) => new URL(r.url()).pathname === path && r.request().method() === method
  );
  // The member is the only row with a menu (the owner's has none).
  await people.getByRole('button', { name: m.a11y_open_menu() }).click();
  if (change === 'remove')
    await page
      .getByRole('menuitem', { exact: true, name: m.members_remove() })
      .click();
  else {
    await page
      .getByRole('menuitem', { exact: true, name: m.members_manage() })
      .click();
    await page
      .getByRole('combobox', { exact: true, name: m.common_role() })
      .click();
    await page
      .getByRole('option', { exact: true, name: m.members_role_view() })
      .click();
  }
  return (await response).status();
}

test('membership: an editor demoted to viewer has open note and Office editors turn read-only and keeps reading; removed, loses the workspace, its tokens and its open room', async ({
  run,
}) => {
  test.setTimeout(900_000);
  const workspaceId = await notesWorkspace(run, 'membership');
  const marker = `UAT${randomUUID().replaceAll('-', '')}`;
  const body = `Membership ${marker}`;
  const memberLine = `Member ${marker}`;
  const noteId = await apiNote(run, workspaceId, body);
  const fileId = await upload(
    run,
    workspaceId,
    'lesson.docx',
    await fixture('lesson.docx', marker),
    true
  );
  const member = await run.createActor('member');
  await invite(run, workspaceId, member, 'editor');
  const noteToken = `/api/materials/${noteId}/collaboration-token`;
  const fileToken = `/api/files/${fileId}/collaboration-token`;

  // 1. Editor: write tokens; a DOCX sentence and a note line saved from the
  // browser, both editors left open (the DOCX in a second tab).
  expect(
    object(await api(member, `/api/workspaces/${workspaceId}`))
  ).toMatchObject({ capabilities: { canEdit: true }, role: 'editor' });
  assert(await listed(member, workspaceId));
  for (const path of [noteToken, fileToken])
    expect(object(await api(member, path, 'POST', undefined, 201)).access).toBe(
      'write'
    );
  const office: Actor = { ...member, page: await member.context.newPage() };
  const frame = await openEditor(run, office, workspaceId, fileId, 'docx');
  await editOffice(office, frame, 'docx', true);
  await savedFacts(run, fileId, [SENTENCE]);
  // A clean room: the discard below throws nothing away and keeps its epoch.
  await saved(office.page);
  const editor = await openNote(run, member, workspaceId, noteId);
  await lineAfter(member.page, editor, body);
  await member.page.keyboard.type(memberLine);
  await run.poll(
    'the saved note holds the member line',
    () => contentText(run, noteId),
    (text) => text.includes(memberLine)
  );

  // 2. Demoted to viewer: each open editor reconnects on a read token and
  // drops to View under the read-only strip; the note's View joins its room
  // on a read channel. The member still reads but cannot write.
  const noteReadOnly = browserToken(member.page, noteToken, 'own', 'read');
  const officeReadOnly = browserToken(office.page, fileToken, 'own', 'read');
  const viewJoined = browserToken(member.page, noteToken, 'read', 'read');
  expect(await changeMember(run, workspaceId, member, 'viewer')).toBe(204);
  await Promise.all([noteReadOnly, officeReadOnly, viewJoined]);
  for (const page of [member.page, office.page])
    await expect(page.getByText(m.editor_read_only_strip())).toBeVisible();
  await expect(member.page.locator('[contenteditable="true"]')).toHaveCount(0);
  await expect(
    member.page.getByText(memberLine, { exact: true })
  ).toBeVisible();
  expect(await membership(run, workspaceId, member.id)).toEqual([
    { role: 'viewer' },
  ]);
  expect(
    object(await api(member, `/api/workspaces/${workspaceId}`))
  ).toMatchObject({
    capabilities: { canEdit: false, canManageMembers: false, canView: true },
    role: 'viewer',
  });
  const read = object(await api(member, `/api/materials/${noteId}`));
  expect(read.capabilities).toMatchObject({ canEdit: false, canView: true });
  assert(JSON.stringify(read.content).includes(memberLine));
  await api(member, `/api/files/${fileId}`);
  for (const path of [noteToken, fileToken])
    expect(object(await api(member, path, 'POST', undefined, 201)).access).toBe(
      'read'
    );
  // A viewer's content write: the material's 403 (sharing e2e).
  await api(
    member,
    `/api/materials/${noteId}/metadata`,
    'PATCH',
    { title: `Viewer ${marker}` },
    403
  );
  await office.page.close();

  // 3. Removed: the open View's room closes and its rejoin is refused; every
  // read, token and write answers the non-disclosing 404.
  const viewRefused = browserToken(member.page, noteToken, 'read', 'refused');
  expect(await changeMember(run, workspaceId, member, 'remove')).toBe(204);
  await viewRefused;
  expect(await membership(run, workspaceId, member.id)).toEqual([]);
  const refused: Array<[string, string, unknown?]> = [
    ['GET', `/api/workspaces/${workspaceId}`],
    ['GET', `/api/workspaces/${workspaceId}/members`],
    ['GET', `/api/materials/${noteId}`],
    ['GET', `/api/files/${fileId}`],
    ['POST', noteToken],
    ['POST', fileToken],
    ['PATCH', `/api/materials/${noteId}/metadata`, { title: `Gone ${marker}` }],
  ];
  for (const [method, path, payload] of refused)
    await api(member, path, method, payload, 404);
  assert(!(await listed(member, workspaceId)));
  // Both changes reach the member in the app only: the invite is its one email.
  const mail = await run.query(
    'SELECT template FROM email_outbox WHERE user_id=%s OR to_email=%s',
    [member.id, member.email]
  );
  assert(mail.every((row) => row.template === 'workspace-invite'));
  const notifications = object(await api(member, '/api/notifications'))
    .items as unknown[];
  expect(
    notifications
      .map(object)
      .filter(
        (item) =>
          (item.data as { workspaceId?: unknown } | null)?.workspaceId ===
          workspaceId
      )
      .map((item) => item.kind)
  ).toEqual(
    expect.arrayContaining([
      'workspace_role_changed',
      'workspace_member_removed',
    ])
  );

  // What the member saved while an editor stays.
  assert((await contentText(run, noteId)).includes(memberLine));
  await savedFacts(run, fileId, [SENTENCE]);
  await run.attach(`${workspaceId}-membership`, {
    fileId,
    memberId: member.id,
    noteId,
  });
  await noProviderCalls(run, workspaceId);
});
