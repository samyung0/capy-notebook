import { expect, test } from '@playwright/test';
import { EDITOR_NOTE, EDITOR_WORKSPACE_ID } from '../../src/mocks/editorSeed';
import { clickTextEnd, openEditorNote } from './helpers';

// Switching a note from Edit to View in the same tab renders that tab's live
// document at once, and the projected copy replaces it when the material
// refetch lands, with no loader in between (human/frontend/plate-editor.md).
test('Edit to View shows the live note at once, then the projected copy', async ({
  page,
}) => {
  const editor = await openEditorNote(
    page,
    EDITOR_NOTE.id,
    EDITOR_NOTE.firstParagraph
  );
  const status = page.getByTestId('editor-save-state');
  await clickTextEnd(
    editor.getByText(EDITOR_NOTE.firstParagraph, { exact: true })
  );
  await page.keyboard.type(' saved');
  // A save the room projects, so leaving the editor refetches the material.
  await expect(status).toHaveText('Saved', { timeout: 15_000 });
  await page.keyboard.type(' live');

  // Hold that refetch until released; it then answers with a projected copy
  // whose first block (the heading) is told apart from the live document.
  await page.evaluate(async (id) => {
    const browserPath = '/src/mocks/browser.ts';
    const mswPath = '/node_modules/msw/lib/core/index.mjs';
    const dbPath = '/src/mocks/db.ts';
    const { worker } = await import(browserPath);
    const { http, HttpResponse } = await import(mswPath);
    const db = await import(dbPath);
    const released = new Promise((resolve) =>
      window.addEventListener('projection-release', resolve, { once: true })
    );
    worker.use(
      http.get(`/api/materials/${id}`, async () => {
        await released;
        const material = structuredClone(
          db.learnerMaterial(db.materials.find((row) => row.id === id))
        );
        material.content.value[0].children = [{ text: 'Projected copy' }];
        return HttpResponse.json(material);
      })
    );
    // From the switch on, a frame with the preview loader (FileLoading) or
    // without the preview once it showed is a flash.
    const flashes: string[] = [];
    (window as unknown as { __flashes: string[] }).__flashes = flashes;
    let seen = false;
    const check = () => {
      const preview = document.querySelector(
        '[data-testid="material-preview"]'
      );
      if (preview) seen = true;
      else if (seen) flashes.push('preview gone');
      if (document.body.innerText.includes('Loading preview'))
        flashes.push('loader');
      requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  }, EDITOR_NOTE.id);

  await page
    .getByRole('button', { exact: true, name: 'Material mode' })
    .click();
  const preview = page.getByTestId('material-preview');
  // While the refetch is held, only the live document has the last word.
  await expect(preview).toContainText(
    `${EDITOR_NOTE.firstParagraph} saved live`
  );
  await page.evaluate(() =>
    window.dispatchEvent(new Event('projection-release'))
  );
  await expect(preview).toContainText('Projected copy');
  await expect(preview).not.toContainText(EDITOR_NOTE.headingText);
  await expect(preview).toContainText(EDITOR_NOTE.secondParagraph);
  expect(
    await page.evaluate(
      () => (window as unknown as { __flashes: string[] }).__flashes
    )
  ).toEqual([]);
});

// A note opened straight in View renders through the lazily loaded renderer.
// Once it has loaded, a re-render of the pane (here a title-only update of the
// material, as a rename or refetch makes) must keep the same document: the
// interactive frame does not reload and the embedded quiz keeps its answer.
test('a note opened in View keeps its document through a re-render', async ({
  page,
}) => {
  await page.goto(
    `/workspaces/${EDITOR_WORKSPACE_ID}?material=mat_note_bio_feature_matrix&mode=view`
  );
  const preview = page.getByTestId('material-preview');
  const frame = preview.locator('iframe').first();
  await expect(frame).toBeVisible({ timeout: 30_000 });
  const answer = preview.getByRole('button', { name: /Mitochondria/ }).first();
  await answer.click();
  await expect(answer).toHaveAttribute('aria-pressed', 'true');
  await frame.evaluate((element) => {
    const marked = element as HTMLIFrameElement & { __loads?: number };
    marked.__loads = 0;
    marked.addEventListener('load', () => {
      marked.__loads = (marked.__loads ?? 0) + 1;
    });
  });

  const retitled = await page.evaluate(async (id) => {
    const root = document.querySelector('[data-testid="material-preview"]')!;
    const fiberKey = Object.keys(root).find((key) =>
      key.startsWith('__reactFiber$')
    )!;
    type Fiber = { memoizedProps?: Record<string, unknown>; return?: Fiber };
    let fiber = (root as unknown as Record<string, Fiber>)[fiberKey];
    while (fiber && !fiber.memoizedProps?.client) fiber = fiber.return!;
    const client = fiber.memoizedProps!.client as {
      getQueryCache: () => {
        findAll: () => {
          queryKey: unknown[];
          state: { data?: { id?: string; content?: unknown } };
        }[];
      };
      setQueryData: (key: unknown[], update: (data: object) => object) => void;
    };
    const query = client
      .getQueryCache()
      .findAll()
      .find(({ state }) => state.data?.id === id && state.data?.content);
    if (!query) return false;
    for (const round of [1, 2])
      client.setQueryData(query.queryKey, (data) => ({
        ...data,
        title: `Renamed ${round}`,
      }));
    return true;
  }, 'mat_note_bio_feature_matrix');
  expect(retitled).toBe(true);
  await page.waitForTimeout(1500);

  expect(
    await frame.evaluate(
      (element) => (element as HTMLIFrameElement & { __loads?: number }).__loads
    )
  ).toBe(0);
  await expect(answer).toHaveAttribute('aria-pressed', 'true');
});

// Edits the room discarded (it turned read-only) never reach the cached
// material: the pane falls back to View with the copy it had, not the editor's.
test('a room turned read-only leaves the cached material alone', async ({
  page,
}) => {
  const editor = await openEditorNote(
    page,
    EDITOR_NOTE.id,
    EDITOR_NOTE.firstParagraph
  );
  await clickTextEnd(
    editor.getByText(EDITOR_NOTE.firstParagraph, { exact: true })
  );
  await page.keyboard.type(' discarded');
  await expect(
    editor.getByText(`${EDITOR_NOTE.firstParagraph} discarded`)
  ).toBeVisible();
  // Hold any refetch of the material, so View can only show the cache.
  await page.evaluate(async (id) => {
    const browserPath = '/src/mocks/browser.ts';
    const mswPath = '/node_modules/msw/lib/core/index.mjs';
    const collaborationPath = '/src/mocks/collaboration.ts';
    const { worker } = await import(browserPath);
    const { http } = await import(mswPath);
    worker.use(
      http.get(`/api/materials/${id}`, () => new Promise<never>(() => {}))
    );
    const { announceReadOnly } = await import(collaborationPath);
    announceReadOnly();
  }, EDITOR_NOTE.id);
  const preview = page.getByTestId('material-preview');
  await expect(preview).toContainText(EDITOR_NOTE.firstParagraph);
  await expect(preview).not.toContainText('discarded');
});
