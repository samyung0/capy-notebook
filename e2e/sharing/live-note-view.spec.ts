import { randomUUID } from 'node:crypto';
import type { Locator, Page } from '@playwright/test';
import { expect, pageAs, test } from '../fixtures/actors';
import { users } from '../fixtures/seed';
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

/** A paste through the events a real clipboard fires (e2e/editor/paste.spec.ts). */
async function paste(editor: Locator, data: Record<string, string>) {
  await editor.evaluate((element, entries) => {
    const transfer = new DataTransfer();
    for (const [type, value] of Object.entries(entries))
      transfer.setData(type, value);
    const event = new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: transfer,
    });
    element.dispatchEvent(event);
    if (!event.defaultPrevented)
      element.dispatchEvent(
        new InputEvent('beforeinput', {
          bubbles: true,
          cancelable: true,
          dataTransfer: transfer,
          inputType: 'insertFromPaste',
        })
      );
  }, data);
}

const line = (index: number) => ({
  children: [{ text: `Line ${index}` }],
  id: `line-${index}`,
  type: 'p',
});

// REVIEW5 M1 and S5. A note's View keys its blocks by id: while the owner
// adds 20 blocks above a reader, an embedded quiz below keeps its answer and
// its room (no remount, no rejoin) and the reader's place holds (the
// browser's scroll anchoring finds the same block). The embed joins its room
// only once it comes near the screen. The reader runs in Chromium and in
// WebKit.
for (const engine of ['chromium', 'webkit'] as const)
  test(`a reader's embed and place hold while blocks go in above (${engine})`, async ({
    browser,
    ownerApi,
    ownerPage,
    playwright,
    seed,
  }) => {
    test.setTimeout(180_000);
    const workspaceId = seed.privateWorkspace.id;
    const created = await ownerApi.post(
      `/api/workspaces/${workspaceId}/materials`,
      {
        data: {
          content: {
            schemaVersion: 1,
            value: Array.from({ length: 140 }, (_, index) => line(index)),
          },
          kind: 'note',
          title: `E2E Live View Anchor ${randomUUID()}`,
        },
      }
    );
    expect(created.status()).toBe(201);
    const note = (await created.json()) as { id: string };
    const embedded = await ownerApi.post(`/api/materials/${note.id}/embedded`, {
      data: {
        kind: 'quiz',
        questions: [
          {
            id: 'anchor-q',
            labels: 'letters',
            layout: 'paper',
            parts: [
              {
                answer: {
                  correct: [1],
                  options: ['Nucleus', 'Mitochondria'],
                  type: 'mcq',
                },
                blocks: [{ text: 'Which organelle makes ATP?', type: 'text' }],
                id: 'anchor-q-part',
                marks: 1,
                solution: [],
              },
            ],
            stem: [],
          },
        ],
      },
    });
    expect(embedded.status()).toBe(201);
    const quiz = (await embedded.json()) as { id: string };
    const readerBrowser =
      engine === 'webkit' ? await playwright.webkit.launch() : browser;
    const { context, page: reader } = await pageAs(readerBrowser, users.viewer);
    try {
      // The owner puts the quiz after line 100.
      await openWorkspaceMaterial(ownerPage, workspaceId, note.id);
      await expectEditorLive(ownerPage);
      const editor = ownerPage.locator('[contenteditable="true"]').first();
      const hundred = editor.getByText('Line 100', { exact: true });
      const box = (await hundred.boundingBox())!;
      await hundred.click({
        force: true,
        position: { x: Math.max(box.width - 1, 0), y: box.height / 2 },
      });
      await ownerPage.keyboard.press('Enter');
      const fragment = await ownerPage.evaluate(
        (json) => btoa(encodeURIComponent(json)),
        JSON.stringify([
          {
            children: [{ text: '' }],
            id: 'anchor-quiz',
            materialId: quiz.id,
            refKind: 'quiz',
            type: 'material_ref',
          },
        ])
      );
      await paste(editor, {
        'application/x-slate-fragment': fragment,
        'text/html': `<div data-slate-fragment="${fragment}">Quiz</div>`,
        'text/plain': 'Quiz',
      });
      await expect(
        editor.locator('.slate-material_ref').getByText('Mitochondria')
      ).toBeVisible({ timeout: 20_000 });

      let quizJoins = 0;
      reader.on('request', (request) => {
        if (request.url().includes(`/materials/${quiz.id}/collaboration-token`))
          quizJoins += 1;
      });
      await reader.goto(
        `/workspaces/${workspaceId}?material=${encodeURIComponent(note.id)}`
      );
      const preview = reader.getByTestId('material-preview');
      await expect(preview.getByText('Line 0', { exact: true })).toBeVisible();
      const embed = preview.locator('.slate-material_ref');
      await expect(embed.getByText('Mitochondria')).toBeAttached({
        timeout: 20_000,
      });
      // Far below the screen, the embed has not joined its room (S5).
      await reader.waitForTimeout(2000);
      expect(quizJoins).toBe(0);

      await embed.scrollIntoViewIfNeeded();
      await expect.poll(() => quizJoins).toBe(1);
      const answer = embed.getByRole('button', { name: /Mitochondria/ });
      await answer.click();
      await expect(answer).toHaveAttribute('aria-pressed', 'true');
      await embed.evaluate((element) => {
        (element as HTMLElement).dataset.kept = 'yes';
      });
      // The reader reads from line 98 down, the quiz in view.
      const anchor = preview.getByText('Line 98', { exact: true });
      await anchor.evaluate((element) =>
        element.scrollIntoView({ block: 'start' })
      );
      await reader.waitForTimeout(500);
      const before = (await anchor.boundingBox())!.y;

      // The owner adds 20 blocks at the top of the note.
      const zero = editor.getByText('Line 0', { exact: true });
      await zero.click({ force: true, position: { x: 1, y: 5 } });
      await ownerPage.keyboard.press('Home');
      for (let index = 0; index < 20; index += 1) {
        await ownerPage.keyboard.type(`Added ${index}`);
        await ownerPage.keyboard.press('Enter');
      }
      await expect(preview.getByText('Added 19', { exact: true })).toBeAttached(
        { timeout: 20_000 }
      );
      await expect(preview.getByText('Line 0', { exact: true })).toBeAttached();
      await reader.waitForTimeout(500);

      expect(Math.abs((await anchor.boundingBox())!.y - before)).toBeLessThan(
        4
      );
      expect(await embed.getAttribute('data-kept')).toBe('yes');
      await expect(answer).toHaveAttribute('aria-pressed', 'true');
      expect(quizJoins).toBe(1);
    } finally {
      await context.close();
      if (engine === 'webkit') await readerBrowser.close();
      await ownerApi.delete(`/api/materials/${note.id}`);
    }
  });

// REVIEW5 S3. "Open read-only" on a heavy note keeps the static View the gate
// promises: the projection paints and no room is joined.
test('a heavy note opened read-only joins no room', async ({
  ownerApi,
  seed,
  viewerPage,
}) => {
  test.setTimeout(120_000);
  const workspaceId = seed.privateWorkspace.id;
  const created = await ownerApi.post(
    `/api/workspaces/${workspaceId}/materials`,
    {
      data: {
        content: {
          schemaVersion: 1,
          // About 7,000 nodes, past the warning's 6,000.
          value: Array.from({ length: 3500 }, (_, index) => line(index)),
        },
        kind: 'note',
        title: `E2E Heavy Read-only ${randomUUID()}`,
      },
    }
  );
  expect(created.status()).toBe(201);
  const note = (await created.json()) as { id: string };
  try {
    const joins: string[] = [];
    viewerPage.on('request', (request) => {
      if (request.url().includes(`/materials/${note.id}/collaboration-token`))
        joins.push(request.url());
    });
    await viewerPage.goto(
      `/workspaces/${workspaceId}?material=${encodeURIComponent(note.id)}`
    );
    await viewerPage.getByTestId('heavy-material-read-only').click();
    await expect(
      viewerPage
        .getByTestId('material-preview')
        .getByText('Line 0', { exact: true })
    ).toBeVisible();
    // Long enough for a live View to have asked for a token.
    await viewerPage.waitForTimeout(3000);
    expect(joins).toEqual([]);
  } finally {
    await ownerApi.delete(`/api/materials/${note.id}`);
  }
});
