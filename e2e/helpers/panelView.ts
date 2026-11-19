import { expect, type Page } from '@playwright/test';
import { m } from '../i18n';

const railSection = (page: Page, name: string) =>
  page
    .getByRole('navigation', { name: m.workspace_rail_label() })
    .getByRole('button', { exact: true, name });

/** An open item is the Files page, whose chat button may still be on its way:
 * the URL decides, not the button. */
const fileOpen = (page: Page) => /[?&](file|material)=/.test(page.url());

/** Shows Files or the chat in an lg viewport. Files is the tree beside the
 * rail (the Files page's side panel, already shown while a file is open).
 * The chat opens as a window over an open file from its chat button, else on
 * the Chat page; on the chat it shows, else a new one. Pressing the page that
 * already shows would fold its side panel. */
export async function showPanelView(page: Page, name: string) {
  if (name === m.workspace_tab_files()) {
    const files = railSection(page, name);
    await files.waitFor();
    const tree = page.locator('[data-workspace-file-tree]');
    if (!(await tree.first().isVisible())) await files.click();
    await tree.first().waitFor();
    return;
  }
  const chat = page.locator('[data-workspace-chat-page]');
  if (!(await chat.isVisible())) {
    if (fileOpen(page)) await openChatWindow(page);
    else await railSection(page, m.workspace_section_agent()).click();
  }
  const field = chat.getByRole('textbox', { name: m.chat_placeholder() });
  await field.waitFor();
}

/** Opens the chat's window from the Files page's chat button. The mock
 * scenario panel floats over the button's corner, so it leaves the page. The
 * window opens in a view transition, during which the page takes no pointer
 * input (Chrome hit-tests its document element). */
async function openChatWindow(page: Page) {
  await page.addStyleTag({
    content: '[data-testid="mock-scenario-panel"] { display: none; }',
  });
  await page.locator('[data-workspace-chat-button]').click();
  await page.evaluate(
    () =>
      (
        document as Document & {
          activeViewTransition?: { finished: Promise<void> } | null;
        }
      ).activeViewTransition?.finished
  );
}

/** Shows past chats in an lg viewport, for a row to be opened: over an open
 * file the chat window's history dialog (the file stays), else the Chat
 * page's list. */
export async function showChatHistory(page: Page) {
  if (fileOpen(page)) {
    await openChatWindow(page);
    await page
      .locator('[data-workspace-chat-page]')
      .getByRole('button', { name: m.chat_history() })
      .click();
    await page.getByRole('dialog', { name: m.chat_history() }).waitFor();
    return;
  }
  const agent = railSection(page, m.workspace_section_agent());
  await agent.waitFor();
  if ((await agent.getAttribute('aria-current')) !== 'page')
    await agent.click();
  await expect(agent).toHaveAttribute('aria-current', 'page');
  // Agent pressed on its own page folds the list away or back. The panel is
  // empty while folded; while it opens it is there but still 0px wide.
  const list = page.locator('[data-workspace-left-panel]');
  if (await list.evaluate((panel) => !panel.childElementCount))
    await agent.click();
  await list.getByText(m.chat_group_pinned()).waitFor();
}
