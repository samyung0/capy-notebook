import { expect, test } from '@playwright/test';
import { m } from '../i18n';

const LAST_PUBLISHED = new RegExp(
  m.assignment_last_published({ date: '' }).trim()
);

// Epo 2026-11-05: an assignment's actions sit on its Settings tab, with no ⋮.
test('Settings holds the actions: Republish moves the last published time, Edit quiz opens it', async ({
  page,
}) => {
  await page.goto(
    '/workspaces/ws_bio?study=assignments&assignment=as_genetics'
  );
  await page
    .getByRole('tab', { name: m.assignment_tab_settings() })
    .click({ timeout: 60_000 });
  await expect(page).toHaveURL(/tab=settings/);
  await expect(
    page.getByRole('button', { name: m.a11y_open_menu() })
  ).toHaveCount(0);

  const hint = page.getByText(LAST_PUBLISHED);
  const before = await hint.innerText();
  await page
    .getByRole('button', { exact: true, name: m.assignment_republish() })
    .click();
  await page
    .getByRole('dialog', { name: m.assignment_republish_title() })
    .getByRole('button', { exact: true, name: m.assignment_republish() })
    .click();
  await expect(hint).not.toHaveText(before);

  await page.getByRole('link', { name: m.assignment_edit_quiz() }).click();
  await expect(page).toHaveURL(/material=/);
  await expect(
    page.getByTestId('content-header').getByText('Genetics check-in')
  ).toBeVisible({ timeout: 30_000 });
});

test('a draft has its Publish row first, and publishing brings the tabs', async ({
  page,
}) => {
  await page.goto('/workspaces/ws_bio?study=assignments&assignment=as_draft');
  await page
    .getByRole('button', { exact: true, name: m.assignment_publish() })
    .click({ timeout: 60_000 });
  await expect(
    page.getByRole('tab', { name: m.assignment_tab_settings() })
  ).toBeVisible();
});

test('a closed assignment keeps Edit quiz and has no Republish', async ({
  page,
}) => {
  await page.goto(
    '/workspaces/ws_bio?study=assignments&assignment=as_cells&tab=settings'
  );
  await expect(
    page.getByRole('link', { name: m.assignment_edit_quiz() })
  ).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(LAST_PUBLISHED)).toHaveCount(0);
});

test.describe('as a member', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() =>
      sessionStorage.setItem('capy.scenario.last', 'workspace-member')
    );
  });

  test('a page open through a republish reads the new questions', async ({
    page,
  }) => {
    await page.goto('/workspaces/ws_bio?study=assignments&assignment=as_paper');
    await page
      .getByRole('button', { exact: true, name: m.assignment_start() })
      .click({ timeout: 30_000 });
    await page.getByRole('button', { name: m.sharing_notice_ok() }).click();
    const take = page.locator('[data-assignment-take]');
    const first = take.getByText('Which organelle makes most');
    await expect(first).toBeVisible({ timeout: 30_000 });
    await page.evaluate(() =>
      fetch('/api/assignments/as_paper/republish', { method: 'POST' })
    );
    await expect(page.getByText(m.assignment_questions_updated())).toBeVisible({
      timeout: 30_000,
    });
    await expect(first).toHaveCount(0);
    await expect(take).toBeVisible();
  });

  test('a quiz open when it gets assigned stays, and a fresh open goes to the assignment', async ({
    page,
  }) => {
    const quiz = '/workspaces/ws_bio?material=qz_bio_near';
    await page.goto(quiz);
    await expect(page.getByTestId('content-header')).toBeVisible({
      timeout: 60_000,
    });
    const assigned = await page.evaluate(async () => {
      await fetch('/api/workspaces/ws_bio/assignments', {
        body: JSON.stringify({
          approveAiMarks: true,
          assignAll: true,
          assignees: [],
          attempts: 1,
          draft: false,
          dueAt: new Date(Date.now() + 86_400_000).toISOString(),
          files: [],
          kind: 'marked',
          latePenaltyPct: 0,
          noLate: false,
          quizId: 'qz_bio_near',
          showAnswers: true,
          shuffle: false,
          title: 'Assigned while open',
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      });
      const paths = ['/src/api/queryClient.ts', '/src/api/client.ts'];
      const [{ queryClient }, { qk }] = await Promise.all(
        paths.map((path) => import(path))
      );
      await queryClient.invalidateQueries();
      const list: { assignmentId?: string; id: string }[] =
        queryClient.getQueryData(qk.materials('ws_bio'));
      return list.find((row) => row.id === 'qz_bio_near')?.assignmentId;
    });
    // The list says it is assigned now, and the page stays.
    expect(assigned).toBeTruthy();
    await page.waitForTimeout(500);
    await expect(page).toHaveURL(/material=qz_bio_near/);
    await expect(page).not.toHaveURL(/assignment=/);
    await expect(page.getByTestId('content-header')).toBeVisible();

    // A quiz assigned already, opened afresh (a reload resets the mock's data).
    await page.goto('/workspaces/ws_bio?material=qz_1');
    await expect(page).toHaveURL(/assignment=/, { timeout: 60_000 });
  });
});

test.describe('at phone width', () => {
  test.use({ viewport: { height: 740, width: 360 } });

  test('a link to Settings shows its tab, past the row’s edge', async ({
    page,
  }) => {
    await page.goto(
      '/workspaces/ws_bio?study=assignments&assignment=as_genetics&tab=settings'
    );
    await expect(
      page.getByRole('tab', { name: m.assignment_tab_settings() })
    ).toBeInViewport({ ratio: 1, timeout: 60_000 });
  });
});
