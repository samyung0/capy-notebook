import { expect, test } from '../fixtures/actors';
import { apiEndsWith, waitForApi } from '../helpers/api';

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
      ownerPage.getByRole('button', { name: 'Share' })
    ).toBeVisible();
    await expect(
      ownerPage.getByRole('button', { name: /Add file/i })
    ).toBeVisible();
    await expect(
      ownerPage.getByRole('button', { name: 'Clone workspace' })
    ).toHaveCount(0);
  });

  test('editor can edit but cannot share workspace privacy', async ({
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
    await expect(editorPage.getByRole('button', { name: 'Share' })).toHaveCount(
      0
    );
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
      await ownerPage.getByRole('button', { name: 'Share' }).click();

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

  test('signed-in viewer can clone a shared workspace; anonymous gets 401', async ({
    anonymousApi,
    otherApi,
    otherPage,
    seed,
  }) => {
    const clonePromise = waitForApi(
      otherPage,
      apiEndsWith(`/api/workspaces/${seed.linkWorkspace.id}/clone`, 'POST')
    );
    await otherPage.goto(`/workspaces/${seed.linkWorkspace.id}`);
    await otherPage.getByRole('button', { name: 'Clone workspace' }).click();
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
      const removedClone = await otherApi.delete(
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

  test('shared roles grant material-only writes to signed-in users', async ({
    materialFactory,
    otherApi,
    seed,
  }) => {
    const commenterFixture = await materialFactory.createNote({
      blockId: 'shared-role-commenter-body',
      body: 'Shared commenter base text',
      title: 'E2E Shared Commenter Material',
      workspaceId: seed.publicWorkspace.id,
    });
    const commenterMaterial = await otherApi.get(
      `/api/materials/${commenterFixture.id}`
    );
    expect(commenterMaterial.status()).toBe(200);
    const commenterBody = await commenterMaterial.json();
    expect(commenterBody.content, JSON.stringify(commenterBody)).toBeDefined();
    expect(commenterBody.capabilities).toMatchObject({
      canComment: true,
      canEdit: false,
      canView: true,
    });

    const commenterEdit = await otherApi.patch(
      `/api/materials/${commenterFixture.id}/metadata`,
      {
        data: {
          expectedRevision: commenterBody.revision,
          title: 'Commenters cannot rename',
        },
      }
    );
    expect(commenterEdit.status()).toBe(403);

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
      canComment: true,
      canEdit: true,
      canView: true,
    });

    const collaborationToken = await otherApi.post(
      `/api/materials/${editorFixture.id}/collaboration-token`
    );
    expect(collaborationToken.status()).toBe(201);
    expect(await collaborationToken.json()).toMatchObject({ access: 'write' });

    const metadataEdit = await otherApi.patch(
      `/api/materials/${editorFixture.id}/metadata`,
      {
        data: {
          expectedRevision: editorBody.revision,
          title: 'Shared editor must not rename',
        },
      }
    );
    expect(metadataEdit.status()).toBe(403);

    const remove = await otherApi.delete(`/api/materials/${editorFixture.id}`);
    expect(remove.status()).toBe(404);
    const chapter = await otherApi.post(
      `/api/workspaces/${seed.editableWorkspace.id}/chapters`,
      {
        data: { name: 'Shared editors cannot add chapters' },
      }
    );
    expect(chapter.status()).toBe(404);
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
      canComment: true,
      canEdit: true,
      canView: true,
    });

    const collaborationToken = await viewerApi.post(
      `/api/materials/${fixture.id}/collaboration-token`
    );
    expect(collaborationToken.status()).toBe(201);
    expect(await collaborationToken.json()).toMatchObject({ access: 'write' });

    // The raise covers document collaboration only. Metadata and workspace
    // structure still answer to the persisted viewer membership.
    const metadataEdit = await viewerApi.patch(
      `/api/materials/${fixture.id}/metadata`,
      {
        data: {
          expectedRevision: body.revision,
          title: 'A raised viewer must not rename',
        },
      }
    );
    expect(metadataEdit.status()).toBe(403);

    const chapter = await viewerApi.post(
      `/api/workspaces/${seed.editableWorkspace.id}/chapters`,
      { data: { name: 'A raised viewer cannot add chapters' } }
    );
    expect(chapter.status()).toBe(404);
  });

  test('the mention directory is redacted and gated on commenting', async ({
    anonymousApi,
    otherApi,
    ownerApi,
    seed,
  }) => {
    const shared = await otherApi.get(
      `/api/workspaces/${seed.publicWorkspace.id}/collaborators`
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
    // the emails and roles through the members endpoint.
    const roster = await otherApi.get(
      `/api/workspaces/${seed.publicWorkspace.id}/members`
    );
    expect(roster.status()).toBe(403);

    // Anonymous visitors can read only the summary, not the mention directory.
    const anonymous = await anonymousApi.get(
      `/api/workspaces/${seed.publicWorkspace.id}/collaborators`
    );
    expect(anonymous.status()).toBe(401);

    const ownerRoster = await ownerApi.get(
      `/api/workspaces/${seed.publicWorkspace.id}/members`
    );
    expect(ownerRoster.status()).toBe(200);
    expect((await ownerRoster.json())[0]).toHaveProperty('email');
  });
});
