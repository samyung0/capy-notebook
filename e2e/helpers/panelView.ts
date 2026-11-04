import type { Page } from '@playwright/test';
import { m } from '../i18n';

const railSection = (page: Page, name: string) =>
  page
    .getByRole('navigation', { name: m.workspace_rail_label() })
    .getByRole('button', { exact: true, name });

/** Agent's panel, on whichever it shows: a chat or the history. Pressing the
 * section that already shows would close its panel. */
async function showAgent(page: Page) {
  const agent = railSection(page, m.workspace_section_agent());
  await agent.waitFor();
  const shown = page.locator('[data-workspace-left-panel]');
  if (
    (await agent.getAttribute('aria-current')) !== 'page' ||
    !(await shown.isVisible())
  )
    await agent.click();
}

/** Shows Files or Chat in an lg viewport, both in the panel beside the rail.
 * Files is the rail's Files section (already shown while a file is open). Chat
 * is the rail's Agent section on a chat: the one it shows, else a new one. The
 * centre keeps what it showed. */
export async function showPanelView(page: Page, name: string) {
  if (name === m.workspace_tab_files()) {
    const files = railSection(page, name);
    await files.waitFor();
    const tree = page.locator('[data-workspace-file-tree]');
    if (!(await tree.first().isVisible())) await files.click();
    await tree.first().waitFor();
    return;
  }
  await showAgent(page);
  const field = page.getByRole('textbox', { name: m.chat_placeholder() });
  const newChat = page.getByRole('button', {
    exact: true,
    name: m.chat_new(),
  });
  await field.or(newChat).first().waitFor();
  if (!(await field.isVisible())) await newChat.click();
  await field.waitFor();
}

/** Shows Agent's chat history in an lg viewport, for a row to be opened. */
export async function showChatHistory(page: Page) {
  await showAgent(page);
  const back = page.getByRole('button', { name: m.chat_history() });
  const newChat = page.getByRole('button', {
    exact: true,
    name: m.chat_new(),
  });
  await back.or(newChat).first().waitFor();
  if (await back.isVisible()) await back.click();
  await newChat.waitFor();
}
