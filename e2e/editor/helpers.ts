import { expect, type Locator, type Page } from '@playwright/test';
import { EDITOR_WORKSPACE_ID } from '../../src/mocks/editorSeed';

export async function openEditorNote(
  page: Page,
  materialId: string,
  readyText: string
): Promise<Locator> {
  await page.goto(
    `/workspaces/${EDITOR_WORKSPACE_ID}?material=${encodeURIComponent(materialId)}&mode=edit`
  );
  const editor = page.locator('[contenteditable="true"]').first();
  await expect(editor).toBeVisible({ timeout: 30_000 });
  await expect(editor.getByText(readyText).first()).toBeVisible({
    timeout: 30_000,
  });
  return editor;
}

/**
 * Put the caret after the last character of a text element. Clicking the text
 * often lands mid-word, and End only moves the native caret, which Slate reads
 * through a throttled selectionchange listener: a re-render in between (TOC,
 * mention menu) restores the click's caret and typing lands mid-word.
 */
export async function clickTextEnd(text: Locator) {
  const box = (await text.boundingBox())!;
  await text.click({ position: { x: box.width - 1, y: box.height / 2 } });
}

/** Select one rendered text line and wait for Slate's range to update. */
export async function selectEditorLine(page: Page, line: Locator) {
  const text = await line.innerText();
  await line.scrollIntoViewIfNeeded();
  const bounds = (await line.boundingBox())!;
  const centerY = bounds.y + bounds.height / 2;
  await page.mouse.move(bounds.x + bounds.width - 1, centerY);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 1, centerY, { steps: 8 });
  await page.mouse.up();
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString()))
    .toBe(text);
  await expect(
    page.getByRole('toolbar', { name: 'Selection actions' })
  ).toBeVisible();
}

/** Hover a block and return its (gutter) drag handle button. */
export async function hoverBlockHandle(
  page: Page,
  blockText: string
): Promise<Locator> {
  const editor = page.locator('[contenteditable="true"]').first();
  await editor.getByText(blockText, { exact: true }).hover();
  // Nested blocks all match, so the innermost wrapper is the one that owns the
  // hovered text.
  const handle = page
    .locator('[data-slot="block-wrapper"]')
    .filter({ hasText: blockText })
    .last()
    .getByRole('button', { exact: true, name: 'Drag block' });
  await expect(handle).toBeVisible();
  return handle;
}

/** Right-click a block and wait for the block context menu. */
export async function openBlockContextMenu(
  page: Page,
  blockText: string
): Promise<Locator> {
  const editor = page.locator('[contenteditable="true"]').first();
  await editor.getByText(blockText, { exact: true }).click({ button: 'right' });
  const menu = page.locator('[data-slot="context-menu-content"]');
  await expect(menu).toBeVisible();
  return menu;
}

/**
 * Call the same MSW-backed API used by the editor from inside the browser.
 * Node's Playwright request context bypasses the service worker, so journey
 * setup must stay in-page to mutate the deterministic editor fixture state.
 */
export async function editorApi<T>(
  page: Page,
  path: string,
  options: { method?: string; body?: unknown } = {}
): Promise<{ status: number; body: T }> {
  return page.evaluate(
    async ({ requestPath, method, body }) => {
      const response = await fetch(requestPath, {
        body: body === undefined ? undefined : JSON.stringify(body),
        headers:
          body === undefined
            ? undefined
            : { 'Content-Type': 'application/json' },
        method,
      });
      const text = await response.text();
      return {
        body: (text ? JSON.parse(text) : null) as T,
        status: response.status,
      };
    },
    { body: options.body, method: options.method ?? 'GET', requestPath: path }
  );
}
