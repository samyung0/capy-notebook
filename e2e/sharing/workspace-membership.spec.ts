import { expect, test } from '../fixtures/actors';
import { apiEndsWith, waitForApi } from '../helpers/api';

test.describe('workspace invitations', () => {
  test('private exact-identifier invite is visible only to its recipient', async ({
    ownerPage,
    commenterPage,
    ownerApi,
    commenterApi,
    otherApi,
    viewerApi,
    workspaceFactory,
  }) => {
    const workspace = await workspaceFactory.create({
      name: 'E2E Invite Only Workspace',
    });
    await ownerPage.goto(`/workspaces/${workspace.id}`);
    await ownerPage.getByRole('button', { name: 'Share' }).click();
    await expect(ownerPage.getByRole('combobox').first()).toContainText(
      'Invite only'
    );

    await ownerPage
      .getByPlaceholder('Email or user ID')
      .fill('commenter@evonotes.test');
    await ownerPage.getByRole('combobox').nth(1).click();
    await ownerPage.getByRole('option', { name: 'Comment' }).click();

    const createResponse = waitForApi(
      ownerPage,
      apiEndsWith(`/api/workspaces/${workspace.id}/invites`, 'POST')
    );
    await ownerPage
      .getByRole('button', { exact: true, name: 'Invite' })
      .click();
    const created = await createResponse;
    expect(created.status()).toBe(202);
    expect(await created.text()).toBe('');
    await expect(ownerPage.getByText('Invitation submitted')).toBeVisible();
    await expect(
      ownerPage.getByText('commenter@evonotes.test')
    ).not.toBeVisible();

    const unknown = await ownerApi.post(
      `/api/workspaces/${workspace.id}/invites`,
      {
        data: { identifier: 'missing@evonotes.test', role: 'viewer' },
      }
    );
    expect(unknown.status()).toBe(202);
    expect(await unknown.text()).toBe('');

    const notificationResponse = await commenterApi.get('/api/notifications');
    expect(notificationResponse.status()).toBe(200);
    const notifications = (await notificationResponse.json()) as Array<{
      kind: string;
      href?: string;
    }>;
    const notification = notifications.find(
      (item) => item.kind === 'workspace_invite'
    );
    expect(notification?.href).toMatch(/^\/workspace-invites\//);
    const token = notification!.href!.split('/').at(-1)!;

    const wrongAccount = await otherApi.post(
      `/api/workspace-invites/${token}/accept`
    );
    expect(wrongAccount.status()).toBe(403);

    await commenterPage.goto('/workspaces');
    await commenterPage.getByRole('button', { name: 'Notifications' }).click();
    await commenterPage
      .getByRole('button', { name: /Workspace invitation/ })
      .click();
    await expect(commenterPage).toHaveURL(notification!.href!);

    const acceptResponse = waitForApi(
      commenterPage,
      apiEndsWith(`/api/workspace-invites/${token}/accept`, 'POST')
    );
    await commenterPage
      .getByRole('button', { name: 'Accept invitation' })
      .click();
    expect((await acceptResponse).status()).toBe(200);
    await commenterPage.getByRole('button', { name: 'Open workspace' }).click();
    await expect(
      commenterPage.getByRole('heading', { name: workspace.name })
    ).toBeVisible();

    const acceptedWorkspace = await commenterApi.get(
      `/api/workspaces/${workspace.id}`
    );
    expect(acceptedWorkspace.status()).toBe(200);
    const acceptedBody = await acceptedWorkspace.json();
    expect(acceptedBody.role).toBe('commenter');
    expect(acceptedBody.capabilities).toMatchObject({
      canComment: true,
      canEdit: false,
      canManageMembers: false,
      canView: true,
    });
    const acceptedMembers = await commenterApi.get(
      `/api/workspaces/${workspace.id}/members`
    );
    expect(acceptedMembers.status()).toBe(200);
    expect(await acceptedMembers.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'commenter', userId: 'u_commenter' }),
      ])
    );

    await ownerPage.reload();
    await ownerPage.getByRole('button', { name: 'Share' }).click();
    await expect(ownerPage.getByText('commenter@evonotes.test')).toBeVisible();

    const candidates = await ownerApi.get(
      `/api/workspaces/${workspace.id}/invite-candidates?q=commenter`
    );
    expect(candidates.status()).toBe(404);
    const revoke = await viewerApi.delete(
      `/api/workspaces/${workspace.id}/invites/unknown`
    );
    expect(revoke.status()).toBe(404);
  });
});
