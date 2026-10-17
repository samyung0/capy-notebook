// Dumps the mirror DOM of the paragraph holding a needle, before and after a
// menu command on a selection (driver tuning, not a recording).
//   tsx debug-dom.ts <fixture key> <needle> <menu id>
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { driverFor } from './drivers';
import { FIXTURES, openSession, startBrowser, startServer, TRACK } from './session';

const [key, needle, menu] = process.argv.slice(2) as [string, string, string];
const fixture = FIXTURES[key]!;
const out: string[] = [];
const server = await startServer();
const browser = await startBrowser();
try {
  const { session } = await openSession(browser, fixture, ['A'], (l) => out.push(l));
  const driver = driverFor(fixture, session, ['A'], []);
  const a = driver.peer();
  const dump = () =>
    session.frame('A').evaluate((n) => {
      const blocks = [...document.querySelectorAll('[role=paragraph]')].filter((b) => (b.textContent ?? '').includes(n));
      return blocks.map((b) => {
        const runs = [...b.querySelectorAll('*')].slice(0, 30).map((e) => {
          const r = e.getBoundingClientRect();
          return `${e.tagName}.${e.className} "${(e.textContent ?? '').slice(0, 12)}" ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`;
        });
        return `${b.closest('.layout-page-mirror')?.className}\n  ${runs.join('\n  ')}`;
      });
    }, needle);
  await a.click(needle, { at: 'start' });
  await a.click(needle, { at: 5, shift: true });
  out.push('BEFORE', ...(await dump()));
  await a.menu(menu);
  await driver.wait(800);
  out.push('AFTER', ...(await dump()));
  await session.close();
} catch (error) {
  out.push(`error ${(error as Error).stack}`);
} finally {
  writeFileSync(path.join(TRACK, 'logs', 'debug-dom.txt'), out.join('\n'));
  await browser.close();
  await server.close();
}
