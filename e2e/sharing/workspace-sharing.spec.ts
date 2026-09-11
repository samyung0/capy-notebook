import { expect, test } from '../fixtures/actors';
import { apiEndsWith, waitForApi } from '../helpers/api';
import { openWorkspaceSharing } from '../helpers/workspace';

test.describe('workspace sharing', () => {
  test('owner can open and edit a private workspace', async ({
    ownerPage,
    seed,
  }) => {
    const resPromise = waitForApi(
      ownerPage,
      apiEndsWith(`/api/workspaces/${seed.privateWorkspace.id}`)
    );
    await ownerPage.goto(`/workspaces/${seed.privateWorkspace.id}`);
    const res = await resPromise;
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.capabilities.canEdit).toBe(true);
    expect(body.capabilities.canManageMembers).toBe(true);

    await expect(
      ownerPage.getByRole('heading', { name: seed.privateWorkspace.name })
    ).toBeVisible();
    await expect(
      ownerPage.getByRole('button', { name: 'Workspace settings' })
    ).toBeVisible();
    await expect(
      ownerPage.getByRole('button', { name: /Add file/i })
    ).toBeVisible();
    await expect(
      ownerPage.getByRole('button', { name: 'Clone workspace' })
    ).toHaveCount(0);
  });

  test('editor member can edit and open workspace settings', async ({
    editorPage,
    seed,
  }) => {
    const resPromise = waitForApi(
      editorPage,
      apiEndsWith(`/api/workspaces/${seed.privateWorkspace.id}`)
    );
    await editorPage.goto(`/workspaces/${seed.privateWorkspace.id}`);
    const res = await resPromise;
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.capabilities.canEdit).toBe(true);
    expect(body.capabilities.canManageMembers).toBe(false);

    await expect(
      editorPage.getByRole('button', { name: /Add file/i })
    ).toBeVisible();
    await openWorkspaceSharing(editorPage);
    await expect(
      editorPage.getByRole('combobox', { name: 'Visibility' })
    ).toBeVisible();
    // Membership management stays with the owner.
    await expect(
      editorPage.getByRole('button', { exact: true, name: 'Invite' })
    ).toHaveCount(0);
    await editorPage.keyboard.press('Escape');
    await expect(
      editorPage.getByRole('button', { name: 'Clone workspace' })
    ).toHaveCount(0);
  });

  test('private summary reveals no metadata, even to signed-in visitors', async ({
    otherPage,
    anonymousPage,
    seed,
  }) => {
    for (const page of [otherPage, anonymousPage]) {
      const response = await page.goto(`/w/${seed.privateWorkspace.id}`);
      expect(response?.status()).toBe(404);
      await expect(
        page.getByRole('heading', { name: 'Workspace unavailable' })
      ).toBeVisible();
      await expect(page.getByText(seed.privateWorkspace.name)).toHaveCount(0);
      await expect(
        page.getByText(seed.privateWorkspace.secretTitle)
      ).toHaveCount(0);
    }
  });

  test('owner can switch private workspace to shared link for viewers', async ({
    ownerPage,
    anonymousPage,
    otherPage,
    ownerApi,
    seed,
  }) => {
    try {
      await ownerPage.goto(`/workspaces/${seed.mutateWorkspace.id}`);
      await expect(
        ownerPage.getByRole('heading', { name: seed.mutateWorkspace.name })
      ).toBeVisible();
      await openWorkspaceSharing(ownerPage);

      const patchPromise = waitForApi(
        ownerPage,
        apiEndsWith(
          `/api/workspaces/${seed.mutateWorkspace.id}/sharing`,
          'PATCH'
        )
      );
      await ownerPage.getByRole('combobox', { name: 'Visibility' }).click();
      await ownerPage.getByRole('option', { name: /Shared link/i }).click();
      expect((await patchPromise).status()).toBe(200);
      await expect(
        ownerPage.getByRole('combobox', { name: 'Anyone with access' })
      ).toContainText('Can view');

      for (const page of [anonymousPage, otherPage]) {
        const response = await page.goto(`/w/${seed.mutateWorkspace.id}`);
        expect(response?.status()).toBe(200);
        await expect(
          page.getByRole('heading', { name: seed.mutateWorkspace.name })
        ).toBeVisible();
        await expect(
          page.getByRole('link', { name: 'Open workspace' })
        ).toBeVisible();
        await expect(
          page.getByRole('button', { name: 'Clone workspace' })
        ).toHaveCount(0);
        await expect(
          page.getByRole('button', { name: /Add file/i })
        ).toHaveCount(0);
        expect(
          await page.locator('meta[name="robots"]').getAttribute('content')
        ).toBe('noindex, nofollow');
      }
      const open = waitForApi(
        otherPage,
        apiEndsWith(`/api/workspaces/${seed.mutateWorkspace.id}`)
      );
      await otherPage.getByRole('link', { name: 'Open workspace' }).click();
      expect((await open).status()).toBe(200);
    } finally {
      // Always restore private so other workers/tests stay isolated.
      const restore = await ownerApi.patch(
        `/api/workspaces/${seed.mutateWorkspace.id}/sharing`,
        {
          data: { privacy: 'private' },
        }
      );
      expect(restore.status()).toBe(200);
    }
  });

  test('public workspace is readable and listed on Explore; link/private are not', async ({
    anonymousPage,
    otherPage,
    seed,
  }) => {
    const publicRes = await anonymousPage.goto(
      `/share/workspaces/${seed.publicWorkspace.id}`
    );
    expect(publicRes?.status()).toBe(200);
    await expect(anonymousPage).toHaveURL(
      new RegExp(`/w/${seed.publicWorkspace.id}$`)
    );
    await expect(
      anonymousPage.getByRole('heading', { name: seed.publicWorkspace.name })
    ).toBeVisible();
    const linkRes = await anonymousPage.goto(`/w/${seed.linkWorkspace.id}`);
    expect(linkRes?.status()).toBe(200);
    const exploreRes = waitForApi(
      otherPage,
      apiEndsWith('/api/explore/workspaces')
    );
    await otherPage.goto('/explore');
    expect((await exploreRes).status()).toBe(200);
    await expect(otherPage.getByText(seed.publicWorkspace.name)).toBeVisible();
    await expect(otherPage.getByText(seed.linkWorkspace.name)).toHaveCount(0);
    await expect(otherPage.getByText(seed.privateWorkspace.name)).toHaveCount(
      0
    );
  });

  test('viewer members clone a workspace; link viewers and anonymous cannot', async ({
    anonymousApi,
    otherApi,
    otherPage,
    viewerApi,
    viewerPage,
    seed,
  }) => {
    await otherPage.goto(`/workspaces/${seed.linkWorkspace.id}`);
    await expect(
      otherPage.getByRole('heading', { name: seed.linkWorkspace.name })
    ).toBeVisible();
    await expect(
      otherPage.getByRole('button', { name: 'Clone workspace' })
    ).toHaveCount(0);
    const linkClone = await otherApi.post(
      `/api/workspaces/${seed.linkWorkspace.id}/clone`
    );
    expect(linkClone.status()).toBe(404);

    const clonePromise = waitForApi(
      viewerPage,
      apiEndsWith(`/api/workspaces/${seed.privateWorkspace.id}/clone`, 'POST')
    );
    await viewerPage.goto(`/workspaces/${seed.privateWorkspace.id}`);
    await viewerPage.getByRole('button', { name: 'Clone workspace' }).click();
    const cloneRes = await clonePromise;
    expect(cloneRes.status()).toBe(201);
    const cloned = await cloneRes.json();
    try {
      expect(cloned.workspace.privacy).toBe('private');
      expect(cloned.workspace.isOwner).toBe(true);

      const anonClone = await anonymousApi.post(
        `/api/workspaces/${seed.linkWorkspace.id}/clone`
      );
      expect(anonClone.status()).toBe(401);
    } finally {
      const removedClone = await viewerApi.delete(
        `/api/workspaces/${cloned.workspace.id}`
      );
      expect(removedClone.status()).toBe(204);
    }
  });

  test('non-member cannot mutate a shared workspace', async ({
    otherApi,
    seed,
  }) => {
    const patch = await otherApi.patch(
      `/api/workspaces/${seed.linkWorkspace.id}`,
      {
        data: { name: 'Hacked' },
      }
    );
    expect(patch.status()).toBe(404);

    const chapter = await otherApi.post(
      `/api/workspaces/${seed.linkWorkspace.id}/chapters`,
      {
        data: { name: 'Injected' },
      }
    );
    expect(chapter.status()).toBe(404);
  });

  test('share roles grant content authority but never workspace settings', async ({
    materialFactory,
    otherApi,
    seed,
  }) => {
    const viewerFixture = await materialFactory.createNote({
      blockId: 'shared-role-viewer-body',
      body: 'Shared viewer base text',
      title: 'E2E Shared Viewer Material',
      workspaceId: seed.publicWorkspace.id,
    });
    const viewerMaterial = await otherApi.get(
      `/api/materials/${viewerFixture.id}`
    );
    expect(viewerMaterial.status()).toBe(200);
    const viewerBody = await viewerMaterial.json();
    expect(viewerBody.content, JSON.stringify(viewerBody)).toBeDefined();
    expect(viewerBody.capabilities).toMatchObject({
      canEdit: false,
      canView: true,
    });
    const viewerToken = await otherApi.post(
      `/api/materials/${viewerFixture.id}/collaboration-token`
    );
    expect(viewerToken.status()).toBe(403);
    const viewerEdit = await otherApi.patch(
      `/api/materials/${viewerFixture.id}/metadata`,
      {
        data: { title: 'Viewers cannot rename' },
      }
    );
    expect(viewerEdit.status()).toBe(403);

    const editorFixture = await materialFactory.createNote({
      blockId: 'shared-role-editor-body',
      body: 'Shared editor base text',
      title: 'E2E Shared Editor Material',
      workspaceId: seed.editableWorkspace.id,
    });
    const editorMaterial = await otherApi.get(
      `/api/materials/${editorFixture.id}`
    );
    expect(editorMaterial.status()).toBe(200);
    const editorBody = await editorMaterial.json();
    expect(editorBody.capabilities).toMatchObject({
      canEdit: true,
      canView: true,
    });

    const collaborationToken = await otherApi.post(
      `/api/materials/${editorFixture.id}/collaboration-token`
    );
    expect(collaborationToken.status()).toBe(201);
    expect(await collaborationToken.json()).toMatchObject({ access: 'write' });

    // A share editor holds the same content authority as an editor member.
    const metadataEdit = await otherApi.patch(
      `/api/materials/${editorFixture.id}/metadata`,
      {
        data: { title: 'Shared editor renamed' },
      }
    );
    expect(metadataEdit.status()).toBe(200);
    const chapter = await otherApi.post(
      `/api/workspaces/${seed.editableWorkspace.id}/chapters`,
      { data: { name: 'Shared editor chapter' } }
    );
    expect(chapter.status()).toBe(201);
    const removedChapter = await otherApi.delete(
      `/api/chapters/${(await chapter.json()).id}`
    );
    expect(removedChapter.status()).toBe(204);
    const remove = await otherApi.delete(`/api/materials/${editorFixture.id}`);
    expect(remove.status()).toBe(204);

    // Workspace settings still answer to persisted membership and refuse
    // non-disclosingly like every other workspace mutation.
    const rename = await otherApi.patch(
      `/api/workspaces/${seed.editableWorkspace.id}`,
      { data: { name: 'Shared editors cannot rename the workspace' } }
    );
    expect(rename.status()).toBe(404);
    const reshare = await otherApi.patch(
      `/api/workspaces/${seed.editableWorkspace.id}/sharing`,
      { data: { privacy: 'private' } }
    );
    expect(reshare.status()).toBe(404);
    const stats = await otherApi.get(
      `/api/workspaces/${seed.editableWorkspace.id}/stats`
    );
    expect(stats.status()).toBe(404);
  });

  test('a viewer member is raised by a more permissive share role', async ({
    materialFactory,
    seed,
    viewerApi,
  }) => {
    const fixture = await materialFactory.createNote({
      blockId: 'union-viewer-member-body',
      body: 'Invited as a viewer where the link grants editing',
      title: 'E2E Union Viewer Member Material',
      workspaceId: seed.editableWorkspace.id,
    });

    const material = await viewerApi.get(`/api/materials/${fixture.id}`);
    expect(material.status()).toBe(200);
    const body = await material.json();
    expect(body.capabilities).toMatchObject({
      canEdit: true,
      canView: true,
    });

    const collaborationToken = await viewerApi.post(
      `/api/materials/${fixture.id}/collaboration-token`
    );
    expect(collaborationToken.status()).toBe(201);
    expect(await collaborationToken.json()).toMatchObject({ access: 'write' });

    // The raise covers content. Workspace settings still answer to the
    // persisted viewer membership.
    const metadataEdit = await viewerApi.patch(
      `/api/materials/${fixture.id}/metadata`,
      {
        data: { title: 'A raised viewer renamed' },
      }
    );
    expect(metadataEdit.status()).toBe(200);

    const rename = await viewerApi.patch(
      `/api/workspaces/${seed.editableWorkspace.id}`,
      { data: { name: 'A raised viewer cannot rename the workspace' } }
    );
    expect(rename.status()).toBe(404);
  });

  test('the mention directory is redacted and gated on editing', async ({
    anonymousApi,
    otherApi,
    ownerApi,
    seed,
  }) => {
    // A public viewer cannot comment, so it gets no directory.
    const viewer = await otherApi.get(
      `/api/workspaces/${seed.publicWorkspace.id}/collaborators`
    );
    expect(viewer.status()).toBe(403);

    const shared = await otherApi.get(
      `/api/workspaces/${seed.editableWorkspace.id}/collaborators`
    );
    expect(shared.status()).toBe(200);
    const directory = await shared.json();
    expect(directory.length).toBeGreaterThan(0);
    for (const entry of directory) {
      expect(entry).toHaveProperty('name');
      expect(entry).not.toHaveProperty('email');
      expect(entry).not.toHaveProperty('role');
    }

    // The full roster stays membership-gated, so the same caller cannot reach
    // the roles through the members endpoint.
    const roster = await otherApi.get(
      `/api/workspaces/${seed.editableWorkspace.id}/members`
    );
    expect(roster.status()).toBe(403);

    // Anonymous visitors can read only the summary, not the mention directory.
    const anonymous = await anonymousApi.get(
      `/api/workspaces/${seed.publicWorkspace.id}/collaborators`
    );
    expect(anonymous.status()).toBe(401);

    const ownerRoster = await ownerApi.get(
      `/api/workspaces/${seed.editableWorkspace.id}/members`
    );
    expect(ownerRoster.status()).toBe(200);
    for (const member of await ownerRoster.json()) {
      expect(member).toHaveProperty('role');
      expect(member).not.toHaveProperty('email');
    }
  });
});
