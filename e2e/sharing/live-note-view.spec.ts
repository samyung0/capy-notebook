import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures/actors';
import { expectEditorLive } from '../helpers/editor';
import { openWorkspaceMaterial } from '../helpers/workspace';
import { m } from '../i18n';

// Signed-in note View follows the room (Epo 2026-10-10): the projection
// paints first, then a viewer's read channel brings each edit as it is typed,
// a Mermaid source included. Public share pages stay fresh-on-open.

const diagram = (source: string) => ({
  children: [{ children: [{ text: '' }], type: 'mermaid_caption' }],
  id: 'watched-diagram',
  source,
  type: 'mermaid',
});

/** Clicks the end of a paragraph, as live-collaboration.spec.ts explains. */
async function typeAtEnd(page: Page, text: string, typed: string) {
  const target = page
    .locator('[contenteditable="true"]')
    .first()
    .getByText(text, { exact: true });
  const box = await target.boundingBox();
  if (!box) throw new Error('paragraph has no layout box');
  await target.click({
    force: true,
    position: { x: Math.max(box.width - 1, 0), y: box.height / 2 },
  });
  await page.keyboard.type(typed);
}

test('a viewer watches the owner type and change a diagram, live', async ({
  ownerApi,
  ownerPage,
  seed,
  viewerPage,
}) => {
  const workspaceId = seed.privateWorkspace.id;
  const body = 'Viewers watch this';
  const created = await ownerApi.post(
    `/api/workspaces/${workspaceId}/materials`,
    {
      data: {
        content: {
          schemaVersion: 1,
          value: [
            { children: [{ text: body }], id: 'watched-body', type: 'p' },
            diagram('flowchart LR\n  Alpha --> Beta'),
          ],
        },
        kind: 'note',
        title: `E2E Live View ${randomUUID()}`,
      },
    }
  );
  expect(created.status()).toBe(201);
  const note = (await created.json()) as { id: string };
  try {
    await openWorkspaceMaterial(ownerPage, workspaceId, note.id);
    await viewerPage.goto(
      `/workspaces/${workspaceId}?material=${encodeURIComponent(note.id)}`
    );
    await expectEditorLive(ownerPage);
    const preview = viewerPage.getByTestId('material-preview');
    await expect(preview.getByText(body, { exact: true })).toBeVisible();
    await expect(preview.locator('.mermaid-render')).toContainText('Beta', {
      timeout: 30_000,
    });
    // The viewer reads only: nothing on its page edits.
    await expect(viewerPage.locator('[contenteditable="true"]')).toHaveCount(0);

    await typeAtEnd(ownerPage, body, ' as it is typed');
    await expect(
      preview.getByText(`${body} as it is typed`, { exact: true })
    ).toBeVisible();

    const block = ownerPage.locator('.slate-mermaid').first();
    await block.hover();
    await block
      .getByRole('button', { exact: true, name: m.action_edit() })
      .click();
    const source = ownerPage
      .getByRole('dialog')
      .getByRole('textbox', { name: m.editor_mermaid_source() });
    await source.click();
    await ownerPage.keyboard.press('ControlOrMeta+End');
    await ownerPage.keyboard.type('\n  Beta --> Gamma');
    await expect(preview.locator('.mermaid-render')).toContainText('Gamma', {
      timeout: 30_000,
    });
  } finally {
    await ownerApi.delete(`/api/materials/${note.id}`);
  }
});

test('a shared note page joins no room, signed in or out', async ({
  anonymousPage,
  otherPage,
  ownerApi,
}) => {
  const body = `E2E fresh-on-open note ${randomUUID()}`;
  const created = await ownerApi.post('/api/materials', {
    data: {
      content: {
        schemaVersion: 1,
        value: [{ children: [{ text: body }], id: 'body', type: 'p' }],
      },
      kind: 'note',
      title: body,
    },
  });
  expect(created.status()).toBe(201);
  const note = (await created.json()) as { id: string };
  try {
    const shared = await ownerApi.patch(`/api/materials/${note.id}/sharing`, {
      data: { privacy: 'link' },
    });
    expect(shared.status()).toBe(200);
    const list = (await (await ownerApi.get('/api/materials')).json()) as {
      items: { id: string; sharePath?: string }[];
    };
    const path = list.items.find((item) => item.id === note.id)?.sharePath;
    expect(path).toMatch(/^\/share\/notes\//);
    for (const [page, url] of [
      [anonymousPage, `${path}?anonymous`],
      [otherPage, path as string],
    ] as const) {
      const joins: string[] = [];
      page.on('request', (request) => {
        if (request.url().includes('collaboration-token'))
          joins.push(request.url());
      });
      // Vite's own socket in development shares the page's host.
      page.on('websocket', (socket) => {
        if (new URL(socket.url()).host !== new URL(page.url()).host)
          joins.push(socket.url());
      });
      await page.goto(url);
      await expect(page.getByText(body).first()).toBeVisible();
      // Long enough for a live View to have asked for a token and joined.
      await page.waitForTimeout(3000);
      expect(joins).toEqual([]);
    }
  } finally {
    await ownerApi.delete(`/api/materials/${note.id}`);
  }
});
