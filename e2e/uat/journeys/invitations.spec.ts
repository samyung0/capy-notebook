import { randomBytes } from 'node:crypto';
import { signOut } from '../support';
import { api, object, string, workspace } from './files';
import { expect, test } from './runtime';

test('signed-out invitation returns after sign-in and persists accepted membership', async ({
  run,
}) => {
  const password = `Uat!${randomBytes(24).toString('base64url')}7`;
  const recipient = await run.createActor('invitee', password);
  const workspaceId = await workspace(run, 'invitation');
  await api(
    run.owner,
    `/api/workspaces/${workspaceId}/invites`,
    'POST',
    { identifier: recipient.id, role: 'viewer' },
    202
  );
  const invitations = await run.poll(
    'workspace invitation',
    () =>
      run.query(
        'SELECT id FROM workspace_invites WHERE workspace_id=%s AND invited_user_id=%s',
        [workspaceId, recipient.id]
      ),
    (rows) => rows.length === 1
  );
  const invitationId = string(invitations[0].id);
  await run.record('invitation', invitationId, {
    actorId: recipient.id,
    workspaceId,
  });
  const invitationPath = `/workspace-invites/${invitationId}`;
  const page = recipient.page;
  await signOut(page);
  await expect(page).toHaveURL((url) => url.pathname === '/sign-in');
  await page.goto(invitationPath);
  await expect(page).toHaveURL((url) => url.pathname === '/sign-in');
  try {
    await page.locator('input[autocomplete="email"]').fill(recipient.email);
    await page.locator('input[autocomplete="current-password"]').fill(password);
    await page.getByRole('button', { exact: true, name: 'Sign in' }).click();
  } catch {
    // biome-ignore lint/style/useErrorCause: Playwright input errors can include the password.
    throw new Error(
      'Invitation password sign-in failed; credential-bearing browser details are omitted'
    );
  }
  await expect(page).toHaveURL((url) => url.pathname === invitationPath);
  expect(
    await run.query(
      'SELECT role FROM workspace_members WHERE workspace_id=%s AND user_id=%s',
      [workspaceId, recipient.id]
    )
  ).toEqual([]);

  const accepted = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
        `/api/workspace-invites/${invitationId}/accept` &&
      response.request().method() === 'POST'
  );
  const [response] = await Promise.all([
    accepted,
    page
      .getByRole('button', { exact: true, name: 'Accept invitation' })
      .click(),
  ]);
  expect(response.status()).toBe(200);
  expect(object(await response.json()).workspaceId).toBe(workspaceId);
  expect(
    await run.query(
      'SELECT role FROM workspace_members WHERE workspace_id=%s AND user_id=%s',
      [workspaceId, recipient.id]
    )
  ).toEqual([{ role: 'viewer' }]);
  const [invitation] = await run.query(
    'SELECT accepted_by,accepted_at FROM workspace_invites WHERE id=%s',
    [invitationId]
  );
  expect(invitation.accepted_by).toBe(recipient.id);
  expect(invitation.accepted_at).not.toBeNull();
  await page
    .getByRole('button', { exact: true, name: 'Open workspace' })
    .click();
  await expect(page).toHaveURL(
    (url) => url.pathname === `/workspaces/${workspaceId}`
  );
  const visible = object(
    await api(recipient, `/api/workspaces/${workspaceId}`)
  );
  expect(visible.role).toBe('viewer');
  expect(visible.capabilities).toMatchObject({
    canEdit: false,
    canManageMembers: false,
    canView: true,
  });
  await run.attach('invitation-acceptance', {
    acceptedBy: recipient.id,
    invitationId,
    role: 'viewer',
    signedOutReturn: true,
    workspaceId,
  });
});
