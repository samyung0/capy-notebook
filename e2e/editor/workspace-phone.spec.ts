import { expect, type Page, test } from '@playwright/test';
import { m } from '../i18n';

// On phones Files and Chat are list pages: a file leads back with "← Files",
// a conversation with "← Chats"; ⋮ holds the workspace actions, and chat docks
// on the Files page until a send grows it into its own page.
test.use({
  hasTouch: true,
  isMobile: true,
  viewport: { height: 740, width: 360 },
});

const NOTE = '/workspaces/ws_bio?material=mat_note_1';

// The MSW User scenarios panel floats over the dock at phone width.
async function open(page: Page) {
  await page.goto(NOTE);
  await page.addStyleTag({
    content: '[data-testid=mock-scenario-panel] { display: none }',
  });
}

test('Files is a page: a file leads back to it, and ⋮ carries the workspace actions', async ({
  page,
}) => {
  await page.goto('/workspaces/ws_bio?view=files');
  const tree = page.locator('[data-workspace-file-tree]');
  await tree.getByText('Osmosis notes.txt').click({ timeout: 60_000 });
  const header = page.getByTestId('content-header');
  await expect(header.getByRole('heading', { name: /Osmosis/ })).toBeVisible();
  await header.getByRole('button', { name: m.a11y_open_menu() }).click();
  for (const item of [
    m.action_add_file(),
    m.action_add_topic(),
    m.workspace_settings(),
  ])
    await expect(page.getByRole('menuitem', { name: item })).toBeVisible();
  await page.keyboard.press('Escape');

  await header
    .getByRole('button', { exact: true, name: m.workspace_tab_files() })
    .click();
  await expect(page).toHaveURL(/view=files/);
  await expect(tree.getByText('Osmosis notes.txt')).toBeVisible();
});

test('Chats is a page with no chat button, and a conversation leads back to it', async ({
  page,
}) => {
  await page.goto('/workspaces/ws_bio?view=chats');
  await page
    .getByRole('button', { name: 'What is a cell?' })
    .click({ timeout: 60_000 });
  const chat = page.locator('[data-workspace-chat-page]');
  await expect(chat.getByText('A cell is the basic')).toBeVisible();
  await expect(page).toHaveURL(/view=chat\b/);
  await expect(page.locator('[data-workspace-chat-button]')).toHaveCount(0);
  await chat.getByRole('button', { exact: true, name: m.chat_chats() }).click();
  await expect(chat).toBeHidden();
  await expect(page).toHaveURL(/view=chats/);
  await expect(
    page.getByRole('button', { name: 'Exam plan for the cell unit' })
  ).toBeVisible();
});

test('Workspace settings shows the tabs first, reached by the URL with its search', async ({
  page,
}) => {
  await page.goto('/workspaces/ws_bio?settings=menu&settingsQuery=transfer');
  const list = page.getByRole('dialog', { name: m.workspace_settings() });
  await expect(
    list.getByRole('textbox', { name: m.workspace_settings_search() })
  ).toHaveValue('transfer', { timeout: 60_000 });
  await expect(list.getByRole('tab')).toHaveCount(1);

  await list.getByRole('tab', { name: m.workspace_tab_danger() }).click();
  const danger = page.getByRole('dialog', { name: m.workspace_tab_danger() });
  await expect(
    danger.getByRole('button', { name: m.workspace_transfer_confirm() })
  ).toBeVisible();
  await expect(page).toHaveURL(/settings=danger&settingsQuery=transfer/);

  await danger.getByRole('button', { name: m.action_back() }).click();
  await expect(list.getByRole('tab')).toHaveCount(1);
  await expect(page).toHaveURL(/settings=menu&settingsQuery=transfer/);
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
  // Its ⋮ is about the chat: back leads to the rest of the workspace.
  await chat.getByRole('button', { name: m.a11y_open_menu() }).click();
  await expect(page.getByRole('menuitem')).toHaveText([
    m.chat_new(),
    m.workspace_settings(),
  ]);
  await page.keyboard.press('Escape');

  // The URL holds it open: the back gesture closes it and keeps the file.
  await expect(page).toHaveURL(/view=chat/);
  await page.goBack();
  await expect(chat).toBeHidden();
  await expect(page).toHaveURL(/material=mat_note_1/);
  await expect(page).not.toHaveURL(/view=/);
  await dock.getByRole('button').first().click();
  await expect(chat).toBeVisible();

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

// A personal workspace: a class's owner and editors have no Study.
test('⋮ reaches Study, as phones have no rail', async ({ page }) => {
  await page.goto('/workspaces/ws_calc?material=f_7');
  await page.addStyleTag({
    content: '[data-testid=mock-scenario-panel] { display: none }',
  });
  await page
    .getByTestId('content-header')
    .getByRole('button', { name: m.a11y_open_menu() })
    .click({ timeout: 60_000 });
  await page.getByRole('menuitem', { name: m.workspace_tab_study() }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: m.workspace_tab_study() })
  ).toBeVisible();
});

test('the chat page lists past chats in its history dialog, with See archived', async ({
  page,
}) => {
  await open(page);
  const dock = page.locator('[data-workspace-chat-dock]');
  await dock
    .getByRole('button', { exact: true, name: m.workspace_tab_chat() })
    .click({ timeout: 60_000 });
  await dock.getByRole('button', { name: m.chat_history() }).click();
  const history = page.getByRole('dialog', { name: m.chat_history() });
  await expect(
    history.getByRole('button', { name: 'Exam plan for the cell unit' })
  ).toBeVisible();
  await history.getByRole('button', { name: m.chat_see_archived() }).click();
  await expect(
    page
      .getByRole('dialog', { name: m.chat_archived_title() })
      .getByText('Lab report draft questions')
  ).toBeVisible();
});
