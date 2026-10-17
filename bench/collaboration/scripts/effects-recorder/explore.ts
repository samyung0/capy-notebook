// Opens one fixture in the runtime frame and writes what the driver needs to
// know about the editor's DOM: test ids, mirror structure, menus, a screenshot.
//   tsx explore.ts <fixture key> [out dir]
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { FIXTURES, openSession, startBrowser, startServer, TRACK } from './session';

const key = process.argv[2] ?? 'book-30p';
const out = process.argv[3] ?? path.join(TRACK, 'logs', `explore-${key}`);
mkdirSync(out, { recursive: true });
const lines: string[] = [];
const log = (line: string) => lines.push(line);

const server = await startServer();
const browser = await startBrowser();
try {
  const started = Date.now();
  const { session } = await openSession(browser, FIXTURES[key]!, ['A'], log);
  log(`loaded in ${Date.now() - started} ms`);
  await session.page.waitForTimeout(3000);
  const frame = session.frame('A');
  const summary = await frame.evaluate(() => {
    const ids = [...document.querySelectorAll('[data-testid]')].map((e) => e.getAttribute('data-testid'));
    const classes: Record<string, number> = {};
    for (const e of document.querySelectorAll('[class]'))
      for (const c of (e.getAttribute('class') ?? '').split(/\s+/)) if (c) classes[c] = (classes[c] ?? 0) + 1;
    const top = Object.entries(classes).sort((a, b) => b[1] - a[1]).slice(0, 80);
    const paragraphs = [...document.querySelectorAll('[role=paragraph]')].slice(0, 8).map((p) => ({
      text: (p.textContent ?? '').slice(0, 80),
      html: p.outerHTML.slice(0, 600),
      rect: p.getBoundingClientRect().toJSON(),
    }));
    const active = document.activeElement;
    return {
      activeElement: active ? `${active.tagName}#${active.id}.${active.className}` : null,
      ids: [...new Set(ids)],
      paragraphs,
      roles: [...new Set([...document.querySelectorAll('[role]')].map((e) => e.getAttribute('role')))],
      title: document.title,
      top,
    };
  });
  writeFileSync(path.join(out, 'dom.json'), JSON.stringify(summary, null, 2));
  writeFileSync(
    path.join(out, 'menus.json'),
    JSON.stringify(await session.page.evaluate(() => window.recorder.menus('A')), null, 2)
  );
  writeFileSync(path.join(out, 'dump.json'), JSON.stringify(await session.page.evaluate(() => window.recorder.dump()), null, 2));
  await session.page.screenshot({ path: path.join(out, 'page.png') });
  await session.close();
} catch (error) {
  log(`error: ${(error as Error).stack}`);
} finally {
  writeFileSync(path.join(out, 'log.txt'), lines.join('\n'));
  await browser.close();
  await server.close();
}
