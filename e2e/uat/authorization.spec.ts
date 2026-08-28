import { expect, test } from '@playwright/test';
import { api, signIn, signOut } from './support';

const workspaceId = process.env.UAT_FIXTURE_WORKSPACE_ID!;
const materialId = process.env.UAT_FIXTURE_MATERIAL_ID!;
test.describe.configure({ mode: 'serial' });

for (const actor of ['owner', 'editor', 'commenter', 'viewer'] as const) {
  test(`${actor} can read the private fixture workspace and member list`, async ({
    page,
  }) => {
    await signIn(page, actor);
    expect((await api(page, `/api/workspaces/${workspaceId}`)).status).toBe(
      200
    );
    expect(
      (await api(page, `/api/workspaces/${workspaceId}/members`)).status
    ).toBe(200);
  });
}

test('an unrelated account cannot distinguish the private fixture from a missing workspace', async ({
  page,
}) => {
  await signIn(page, 'other');
  expect((await api(page, `/api/workspaces/${workspaceId}`)).status).toBe(404);
  expect(
    (await api(page, `/api/workspaces/${workspaceId}/members`)).status
  ).toBe(404);
});

test('workspace statistics remain owner-only', async ({ page }) => {
  await signIn(page, 'owner');
  expect((await api(page, `/api/workspaces/${workspaceId}/stats`)).status).toBe(
    200
  );

  for (const actor of ['editor', 'commenter', 'viewer', 'other'] as const) {
    await signOut(page);
    await signIn(page, actor);
    const response = await api(page, `/api/workspaces/${workspaceId}/stats`);
    expect([403, 404]).toContain(response.status);
  }
});

for (const [actor, access] of [
  ['owner', 'write'],
  ['editor', 'write'],
  ['commenter', 'comment'],
] as const) {
  test(`${actor} receives only ${access} collaboration access`, async ({
    page,
  }) => {
    await signIn(page, actor);
    const response = await api(
      page,
      `/api/materials/${materialId}/collaboration-token`,
      'POST'
    );
    expect(response.status).toBe(201);
    expect(JSON.parse(response.body).access).toBe(access);
  });
}

for (const actor of ['viewer', 'other'] as const) {
  test(`${actor} cannot mint a collaboration token`, async ({ page }) => {
    await signIn(page, actor);
    const response = await api(
      page,
      `/api/materials/${materialId}/collaboration-token`,
      'POST'
    );
    expect([403, 404]).toContain(response.status);
  });
}
