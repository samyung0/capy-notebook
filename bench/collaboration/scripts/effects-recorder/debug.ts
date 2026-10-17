// Runs one case body against a fixture with the frame's events logged, for
// tuning a driver step (not a recording).
//   tsx debug.ts <fixture key> <case id>
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { CASES } from './cases';
import { driverFor, type Recording } from './drivers';
import { FIXTURES, openSession, startBrowser, startServer, TRACK } from './session';

const [key, id] = process.argv.slice(2);
const kase = CASES.find((c) => c.id === id)!;
const fixture = FIXTURES[key!]!;
const lines: string[] = [];
const log = (line: string) => lines.push(line);
const server = await startServer();
const browser = await startBrowser();
try {
  const { session } = await openSession(browser, fixture, kase.peers ?? ['A'], log);
  for (const peer of kase.peers ?? ['A'])
    await session.frame(peer).evaluate(() => {
      for (const type of ['beforecut', 'cut', 'beforecopy', 'copy', 'paste', 'keydown', 'beforeinput', 'compositionend'])
        document.addEventListener(type, (event) => console.warn(`[frame] ${type} ${(event as KeyboardEvent).key ?? ''} prevented=${event.defaultPrevented}`), true);
    });
  const driver = driverFor(fixture, session, kase.peers ?? ['A'], []);
  await kase.run(driver, fixture);
  await driver.settle();
  const dump = (await session.page.evaluate(() => window.recorder.dump())) as Recording;
  log(`updates ${dump.updates.length}: ${dump.updates.map((u) => `${u.peer}${u.seq}:${u.source}`).join(' ')}`);
  log(`messages ${JSON.stringify(dump.messages)}`);
  await session.page.screenshot({ path: path.join(TRACK, 'logs', `debug-${id}-${key}.png`) });
  await session.close();
} catch (error) {
  log(`error ${(error as Error).stack}`);
} finally {
  writeFileSync(path.join(TRACK, 'logs', `debug-${id}-${key}.txt`), lines.join('\n'));
  await browser.close();
  await server.close();
}
