import { expect, type Page, test } from '@playwright/test';
import { m } from '../i18n';

// Below lg the workspace has no panels: Files drops from the title, ⋮ holds
// the workspace actions, and chat docks on the file until a send grows it
// into its own page.
test.use({
  hasTouch: true,
  isMobile: true,
  viewport: { height: 740, width: 360 },
});

const NOTE = '/workspaces/ws_bio?material=mat_note_1';
const TITLE = 'Lecture notes — the cell';

// The MSW User scenarios panel floats over the dock at phone width.
async function open(page: Page) {
  await page.goto(NOTE);
  await page.addStyleTag({
    content: '[data-testid=mock-scenario-panel] { display: none }',
  });
}

test('the title opens Files from the top and ⋮ carries the workspace actions', async ({
  page,
}) => {
  await open(page);
  const header = page.getByTestId('content-header');
  const title = header.getByRole('button', { name: TITLE });
  await expect(title).toBeVisible({ timeout: 60_000 });
  // Phones keep the header to the title, view/edit and ⋮.
  await expect(
    header.getByRole('button', { name: m.study_mark_read() })
  ).toHaveCount(0);

  await header.getByRole('button', { name: m.a11y_open_menu() }).click();
  for (const item of [
    m.action_add_file(),
    m.action_add_chapter(),
    m.study_mark_read(),
    m.workspace_settings(),
  ])
    await expect(page.getByRole('menuitem', { name: item })).toBeVisible();
  await page.keyboard.press('Escape');

  await title.click();
  // The open dropdown is modal: the page behind it leaves the accessibility tree.
  await expect(header.locator('h2 button')).toHaveAttribute(
    'aria-expanded',
    'true'
  );
  const files = page.getByRole('dialog');
  // The workspace is a plain row: no switcher, settings pinned under the tree.
  await expect(files.getByText('Biology 101')).toBeVisible();
  await expect(files.getByRole('button', { name: 'Biology 101' })).toHaveCount(
    0
  );
  await expect(
    files.getByRole('button', { name: m.workspace_settings() })
  ).toBeVisible();
  await files.getByText('Osmosis notes.txt').click();
  await expect(files).toBeHidden();
  await expect(header.getByRole('button', { name: /Osmosis/ })).toBeVisible();
});

test('chat docks as a button, keeps a draft, and grows into its page on send', async ({
  page,
}) => {
  await open(page);
  const dock = page.locator('[data-workspace-chat-dock]');
  const button = dock.getByRole('button', {
    exact: true,
    name: m.workspace_tab_chat(),
  });
  const field = dock.getByRole('textbox', { name: m.chat_placeholder() });
  // Folded, the field is only transparent: the surface says which it is.
  const surface = dock.locator('.motion-chat-dock');
  // The note first, so the page has something to scroll.
  await expect(
    page.getByRole('heading', { name: 'Prokaryotes vs eukaryotes' })
  ).toBeVisible({ timeout: 60_000 });
  await button.click();
  await expect(field).toBeFocused();

  // Empty, a blur folds it back; with text it stays until the page scrolls.
  await field.blur();
  await expect(button).toBeVisible();
  await button.click();
  await field.fill('What do mitochondria do?');
  await field.blur();
  await expect(field).toBeVisible();
  // Scrolling either way folds it into the button; the draft waits there.
  // Scrolls right after a focus are the browser making room, not the reader.
  // The first scroll only records where the page starts.
  await page.mouse.move(180, 300);
  await page.waitForTimeout(700);
  await page.mouse.wheel(0, 200);
  await page.mouse.wheel(0, 300);
  await expect(surface).toHaveAttribute('data-open', 'false');
  await button.click();
  await page.waitForTimeout(700);
  // Off the dock again: the click left the mouse over it.
  await page.mouse.move(180, 300);
  await page.mouse.wheel(0, -150);
  await expect(surface).toHaveAttribute('data-open', 'false');
  await button.click();
  await expect(field).toHaveValue('What do mitochondria do?');

  await dock.getByRole('button', { name: m.chat_send() }).click();
  const chat = page.locator('[data-workspace-chat-page]');
  await expect(chat).toBeVisible();
  await expect(chat.getByText('What do mitochondria do?')).toBeVisible();
  await expect(
    chat.getByRole('button', { name: m.chat_history() })
  ).toBeVisible();

  // Back leaves a chip that reopens the conversation, or closes.
  await chat.getByRole('button', { name: m.action_back() }).click();
  await expect(chat).toBeHidden();
  const close = dock.getByRole('button', { name: m.action_close() });
  await expect(close).toBeVisible();
  await dock.getByRole('button').first().click();
  await expect(chat).toBeVisible();
  await chat.getByRole('button', { name: m.action_back() }).click();
  await close.click();
  await expect(close).toHaveCount(0);
  await expect(button).toBeVisible();
});
