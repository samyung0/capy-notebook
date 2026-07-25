import { expect, type Locator, type Page } from '@playwright/test';
import { EDITOR_WORKSPACE_ID } from '../../src/mocks/editorSeed';

export async function openEditorNote(
  page: Page,
  materialId: string,
  readyText: string
): Promise<Locator> {
  await page.goto(
    `/workspaces/${EDITOR_WORKSPACE_ID}?material=${encodeURIComponent(materialId)}`
  );
  const editor = page.locator('[contenteditable="true"]').first();
  await expect(editor).toBeVisible({ timeout: 30_000 });
  await expect(editor.getByText(readyText).first()).toBeVisible({
    timeout: 30_000,
  });
  return editor;
}

/** The block-selection overlay divs rendered inside selected blocks. */
export function blockSelectionOverlays(page: Page): Locator {
  return page.locator('[data-slot="block-selection"]');
}

/** Hover a block and return its (gutter) drag handle button. */
export async function hoverBlockHandle(
  page: Page,
  blockText: string
): Promise<Locator> {
  const editor = page.locator('[contenteditable="true"]').first();
  await editor.getByText(blockText, { exact: true }).hover();
  const handle = page
    .locator('div.group, div.group\\/container')
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
