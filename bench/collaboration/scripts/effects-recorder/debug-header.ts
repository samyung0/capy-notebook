// Driver tuning: where a header needle is located and what a double click
// there opens (screenshots before and after).
//   tsx debug-header.ts <fixture key> <needle>
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { driverFor } from './drivers';
import { FIXTURES, openSession, startBrowser, startServer, TRACK } from './session';

const [key, needle] = process.argv.slice(2) as [string, string];
const fixture = FIXTURES[key]!;
const out: string[] = [];
const server = await startServer();
const browser = await startBrowser();
try {
  const { session } = await openSession(browser, fixture, ['A'], (l) => out.push(l));
  const driver = driverFor(fixture, session, ['A'], []);
  const a = driver.peer() as unknown as { point(n: string, w: object): Promise<{ x: number; y: number }> };
  await driver.wait(Number(process.env.WAIT_MS ?? 0));
  const point = await a.point(needle, { at: 3, scope: 'header' });
  out.push(`point ${JSON.stringify(point)}`);
  const regions = await session.frame('A').evaluate(() =>
    [...document.querySelectorAll('.layout-page-mirror:not(.layout-page-mirror-text) .layout-page-header')].map((h) => {
      const r = h.getBoundingClientRect();
      return `${h.closest('.layout-page-mirror')?.getAttribute('data-page-index')} ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)} "${(h.textContent ?? '').slice(0, 30)}"`;
    })
  );
  out.push(...regions);
  await session.page.screenshot({ path: path.join(TRACK, 'logs', 'debug-header-before.png') });
  // Focus the body first (the first focus may jump to a review item), then the header.
  await session.page.mouse.click(point.x, point.y + 120);
  await driver.wait(800);
  if (process.env.PRIOR_EDIT) {
    await session.page.keyboard.type('x');
    await driver.wait(500);
    await session.page.keyboard.press('Backspace');
  }
  await driver.wait(1500);
  await session.page.screenshot({ path: path.join(TRACK, 'logs', 'debug-header-mid.png') });
  const again = await a.point(needle, { at: 3, scope: 'header' });
  out.push(`again ${JSON.stringify(again)}`);
  await session.page.mouse.click(again.x, again.y, { clickCount: 2 });
  await driver.wait(800);
  await session.page.screenshot({ path: path.join(TRACK, 'logs', 'debug-header-after.png') });
  out.push(`story ${await session.frame('A').locator('[data-testid=yrs-input]').getAttribute('data-yrs-story')}`);
  await session.close();
} catch (error) {
  out.push(`error ${(error as Error).stack}`);
} finally {
  writeFileSync(path.join(TRACK, 'logs', 'debug-header.txt'), out.join('\n'));
  await browser.close();
  await server.close();
}
