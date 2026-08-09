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

  test('non-member and anonymous cannot open a private workspace', async ({
    otherPage,
    anonymousPage,
    seed,
  }) => {
    for (const page of [otherPage, anonymousPage]) {
      const resPromise = waitForApi(
        page,
        apiEndsWith(`/api/workspaces/${seed.privateWorkspace.id}`)
      );
      await page.goto(`/share/workspaces/${seed.privateWorkspace.id}`);
      expect((await resPromise).status()).toBe(404);
      await expect(page.getByTestId('private-or-unavailable')).toBeVisible();
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
        const resPromise = waitForApi(
          page,
          apiEndsWith(`/api/workspaces/${seed.mutateWorkspace.id}`)
        );
        await page.goto(`/share/workspaces/${seed.mutateWorkspace.id}`);
        const res = await resPromise;
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body.capabilities.canEdit).toBe(false);
        await expect(
          page.getByRole('heading', { name: seed.mutateWorkspace.name })
        ).toBeVisible();
        await expect(
          page.getByRole('button', { name: 'Clone workspace' })
        ).toBeVisible();
        await expect(page.getByRole('button', { name: 'Share' })).toHaveCount(
          0
        );
        await expect(
          page.getByRole('button', { name: /Add file/i })
        ).toHaveCount(0);
        await expect(
          page.getByRole('button', { name: /Add chapter/i })
        ).toHaveCount(0);
        await expect(page.getByText('Chat')).toHaveCount(0);
        await expect(page.getByText('Generate')).toHaveCount(0);
      }
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
    const publicRes = waitForApi(
      anonymousPage,
      apiEndsWith(`/api/workspaces/${seed.publicWorkspace.id}`)
    );
    await anonymousPage.goto(`/share/workspaces/${seed.publicWorkspace.id}`);
    expect((await publicRes).status()).toBe(200);
    await expect(
      anonymousPage.getByRole('heading', { name: seed.publicWorkspace.name })
    ).toBeVisible();

    const linkRes = waitForApi(
      anonymousPage,
      apiEndsWith(`/api/workspaces/${seed.linkWorkspace.id}`)
    );
    await anonymousPage.goto(`/share/workspaces/${seed.linkWorkspace.id}`);
    expect((await linkRes).status()).toBe(200);

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
    anonymousPage,
    otherApi,
    otherPage,
    seed,
  }) => {
    const clonePromise = waitForApi(
      otherPage,
      apiEndsWith(`/api/workspaces/${seed.linkWorkspace.id}/clone`, 'POST')
    );
    await otherPage.goto(`/share/workspaces/${seed.linkWorkspace.id}`);
    await otherPage.getByRole('button', { name: 'Clone workspace' }).click();
    const cloneRes = await clonePromise;
    expect(cloneRes.status()).toBe(201);
    const cloned = await cloneRes.json();
    try {
      expect(cloned.workspace.privacy).toBe('private');
      expect(cloned.workspace.isOwner).toBe(true);

      const anonClone = waitForApi(
        anonymousPage,
        apiEndsWith(`/api/workspaces/${seed.linkWorkspace.id}/clone`, 'POST')
      );
      await anonymousPage.goto(`/share/workspaces/${seed.linkWorkspace.id}`);
      await anonymousPage
        .getByRole('button', { name: 'Clone workspace' })
        .click();
      expect((await anonClone).status()).toBe(401);
      await expect(anonymousPage.getByText('Sign in to clone')).toBeVisible();
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
      `/api/materials/${commenterFixture.id}`,
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
      `/api/materials/${editorFixture.id}`,
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
    const metadataEdit = await viewerApi.patch(`/api/materials/${fixture.id}`, {
      data: {
        expectedRevision: body.revision,
        title: 'A raised viewer must not rename',
      },
    });
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

    // Anonymous visitors read the workspace but never comment, so the
    // directory is not theirs to enumerate.
    const anonymous = await anonymousApi.get(
      `/api/workspaces/${seed.publicWorkspace.id}/collaborators`
    );
    expect(anonymous.status()).toBe(403);

    const ownerRoster = await ownerApi.get(
      `/api/workspaces/${seed.publicWorkspace.id}/members`
    );
    expect(ownerRoster.status()).toBe(200);
    expect((await ownerRoster.json())[0]).toHaveProperty('email');
  });
});
