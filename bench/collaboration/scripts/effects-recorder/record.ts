// Records real BetterOffice update streams through Capy's Office runtime.
//   tsx record.ts [case-id regex] [--fixture <key>] [--keep-failed]
// Writes recordings/<case>@<fixture>/ (FORMAT.md) and recordings/index.json,
// then checks each one natively against the server seed.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CASES, type Case } from './cases';
import { driverFor, type Recording } from './drivers';
import {
  FIXTURES,
  type Fixture,
  HERE,
  openSession,
  RECORDINGS,
  ROOT,
  runCheck,
  sha256,
  startBrowser,
  startServer,
  TRACK,
} from './session';

const args = process.argv.slice(2);
const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const onlyFixture = flag('--fixture');
const pattern = new RegExp(args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--fixture')[0] ?? '.');
const PINS = { betteroffice: '8b50ac30', capy: 'fd0b3eb28' };
const DEBOUNCE_MS = 5000;
const MAX_DEBOUNCE_MS = 30000;
const OOTEXT = path.join(HERE, 'ootext.py');

const logFile = path.join(TRACK, 'logs', `b-record-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
mkdirSync(path.dirname(logFile), { recursive: true });
const logLines: string[] = [];
const log = (line: string) => {
  logLines.push(`${new Date().toISOString()} ${line}`);
  writeFileSync(logFile, `${logLines.join('\n')}\n`);
};

function ootext(...argv: string[]): unknown {
  const result = spawnSync('python', ['-I', '-X', 'utf8', OOTEXT, ...argv], { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (result.status !== 0) throw new Error(`ootext ${argv[0]}: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

/** Where the server's debounced saves fall over the recorded arrivals. */
function savePoints(updates: { order: number; t: number }[], scripted: number[]) {
  const points: { afterOrder: number; rule: string }[] = [];
  let first: number | null = null;
  updates.forEach((update, index) => {
    first ??= update.t;
    const next = updates[index + 1];
    if (!next) return;
    if (next.t - update.t >= DEBOUNCE_MS) {
      points.push({ afterOrder: update.order, rule: 'debounce' });
      first = null;
    } else if (next.t - first >= MAX_DEBOUNCE_MS) {
      points.push({ afterOrder: update.order, rule: 'max' });
      first = null;
    }
  });
  for (const t of scripted) {
    const last = [...updates].reverse().find((u) => u.t <= t);
    if (last) points.push({ afterOrder: last.order, rule: 'scripted' });
  }
  const last = updates.at(-1);
  if (last) points.push({ afterOrder: last.order, rule: 'final' });
  return points.sort((a, b) => a.afterOrder - b.afterOrder);
}

function updateIndex(entry: Record<string, unknown>) {
  const file = path.join(RECORDINGS, 'index.json');
  const index: Record<string, unknown>[] = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
  const at = index.findIndex((e) => e.caseId === entry.caseId);
  if (at >= 0) index[at] = entry;
  else index.push(entry);
  index.sort((a, b) => String(a.caseId).localeCompare(String(b.caseId)));
  writeFileSync(file, `${JSON.stringify(index, null, 2)}\n`);
}

/** The editor's export of the untouched file, once per fixture, from its own session. */
async function baselineExport(browser: Awaited<ReturnType<typeof startBrowser>>, fixture: Fixture) {
  const sha = sha256(readFileSync(path.join(ROOT, fixture.path)));
  const file = path.join(RECORDINGS, '_seeds', `${path.basename(fixture.path)}.${sha.slice(0, 12)}.client-export.${fixture.format}`);
  if (existsSync(file)) return file;
  const { session } = await openSession(browser, fixture, ['A'], (line) => log(`baseline ${fixture.key} ${line}`));
  try {
    const bytes = await session.page.evaluate(() => window.recorder.exportFile('A'));
    writeFileSync(file, Buffer.from(bytes, 'base64'));
    const written = (await session.page.evaluate(() => window.recorder.dump())) as Recording;
    if (written.updates.length) log(`baseline ${fixture.key}: opening and exporting wrote ${written.updates.length} updates`);
  } finally {
    await session.close();
  }
  return file;
}

async function record(browser: Awaited<ReturnType<typeof startBrowser>>, kase: Case, fixture: Fixture) {
  const caseId = `${kase.id}@${fixture.key}`;
  const dir = path.join(RECORDINGS, caseId);
  rmSync(dir, { force: true, recursive: true });
  mkdirSync(path.join(dir, 'updates'), { recursive: true });
  mkdirSync(path.join(dir, 'raw'), { recursive: true });
  mkdirSync(path.join(dir, 'client'), { recursive: true });
  const peers = kase.peers ?? ['A'];
  const started = Date.now();
  const beforeFile = await baselineExport(browser, fixture);
  const { session, seed } = await openSession(browser, fixture, peers, (line) => log(`${caseId} ${line}`));
  const recordedAt = new Date().toISOString();
  try {
    const page = session.page;
    const scripted: number[] = [];
    const driver = driverFor(fixture, session, peers, scripted);
    await kase.run(driver, fixture);
    await driver.settle();
    const states: Record<string, string> = {};
    const exports: Record<string, string> = {};
    await driver.step('*', 'flush+export', 'end of case: replica states and exports');
    // Pending input lands everywhere first, then every peer has seen everything.
    for (const peer of peers) await page.evaluate((p) => window.recorder.flush(p), peer);
    await driver.settle();
    for (const peer of peers) {
      const state = Buffer.from(await page.evaluate((p) => window.recorder.flush(p), peer), 'base64');
      states[peer] = path.join(dir, 'client', `${peer}-state.bin`);
      writeFileSync(states[peer]!, state);
    }
    for (const peer of peers) {
      const exported = Buffer.from(await page.evaluate((p) => window.recorder.exportFile(p), peer), 'base64');
      exports[peer] = `client/${peer}-export.${fixture.format}`;
      writeFileSync(path.join(dir, exports[peer]!), exported);
    }
    await driver.settle();
    const captured = await driver.capture(kase.capture?.(fixture) ?? []);
    const dump = (await page.evaluate(() => window.recorder.dump())) as Recording;
    const updates = dump.updates.map((u) => {
      const name = `${u.peer}-${String(u.seq).padStart(4, '0')}.bin`;
      const bytes = Buffer.from(u.bytes, 'base64');
      writeFileSync(path.join(dir, 'updates', name), bytes);
      if (u.raw) writeFileSync(path.join(dir, 'raw', name), Buffer.from(u.raw, 'base64'));
      return {
        order: u.order,
        peer: u.peer,
        seq: u.seq,
        file: `updates/${name}`,
        raw: u.raw ? `raw/${name}` : null,
        t: u.t,
        bytes: bytes.length,
        sha256: sha256(bytes),
        source: u.source,
        step: u.step,
      };
    });
    const textDiff = ootext('diff', beforeFile, path.join(dir, exports[peers[0]!]!)) as unknown[];
    const manifest: Record<string, unknown> = {
      formatVersion: 1,
      caseId,
      parityRows: kase.rows,
      format: fixture.format,
      fixture: {
        name: path.basename(fixture.path),
        path: fixture.path,
        sha256: seed.fixtureSha,
        bytes: seed.bytes.length,
      },
      seed: {
        file: `../_seeds/${seed.seedFile}`,
        sha256: seed.seedSha,
        bytes: seed.seed.length,
        engine: 'office_service::seed (collaboration-rs sources, betteroffice 8b50ac30)',
      },
      pins: PINS,
      recordedAt,
      peers: peers.map((peer) => ({ peer, clientId: dump.clientIds[peer] ?? null })),
      updates,
      steps: dump.steps,
      // Every message the runtime posted (size, and the wire update it produced, null when none).
      runtimePosts: dump.raws,
      savePoints: savePoints(updates, scripted),
      expected: {
        summary: kase.summary,
        effects: textDiff,
        note: 'effects = text diff (ootext.py) of the editor\'s export of the untouched file vs the engine\'s export of the recorded room (equal to the editors\' own exports when check.exportsClean); formatting-only changes show none',
      },
      client: {
        finalText: captured,
        exports,
        baselineExport: `../_seeds/${path.basename(beforeFile)}`,
      },
      messages: dump.messages.filter((m) => m.type === 'error' || m.type === 'notice'),
    };
    writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    const check = runCheck([
      'check',
      dir,
      ROOT,
      ...peers.map((peer) => `${peer}=${states[peer]}`),
    ]) as Record<string, unknown> & { clients: Record<string, { sameStateVectorAndDeleteSet: boolean; rootsDiffering: string[] }> };
    const textSame: Record<string, unknown> = {};
    for (const peer of peers)
      textSame[peer] =
        typeof check.serverExport === 'string'
          ? ootext('same', path.join(dir, exports[peer]!), path.join(dir, check.serverExport))
          : { same: false, error: check.serverExport };
    // The stream is right when the room it builds equals every replica; a peer's
    // own export can still miss a co-editor's change (an editor gap, kept apart).
    const streamClean =
      check.unheld === 0 &&
      (check.refused as unknown[]).length === 0 &&
      check.pendingStructs === 0 &&
      check.pendingDeletes === 0 &&
      peers.every((p) => check.clients[p]?.sameStateVectorAndDeleteSet && check.clients[p]?.rootsDiffering.length === 0);
    const exportsClean = peers.every((p) => (textSame[p] as { same?: boolean }).same);
    const clean = streamClean && exportsClean;
    // Expected effects follow the room (the engine's export, equal to the editors' own when clean).
    if (typeof check.serverExport === 'string') {
      const serverEffects = ootext('diff', beforeFile, path.join(dir, check.serverExport)) as unknown[];
      (manifest.expected as Record<string, unknown>).effects = serverEffects;
      textDiff.splice(0, textDiff.length, ...serverEffects);
    }
    manifest.check = { ...check, textMatchesClient: textSame, streamClean, exportsClean, clean };
    writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    if (streamClean) for (const peer of peers) rmSync(states[peer]!, { force: true });
    const status =
      updates.length === 0 && !kase.expectNoUpdates
        ? 'no-updates'
        : clean
          ? 'ok'
          : streamClean
            ? 'ok-export-gap'
            : 'check-failed';
    updateIndex({
      caseId,
      case: kase.id,
      format: fixture.format,
      fixture: fixture.key,
      parityRows: kase.rows,
      peers: peers.length,
      updates: updates.length,
      status,
      seconds: Math.round((Date.now() - started) / 100) / 10,
      engineEffects: Array.isArray(check.engineEffects) ? check.engineEffects.length : 'error',
      textEffects: textDiff.length,
    });
    log(`${caseId} ${status} updates=${updates.length} textEffects=${textDiff.length}`);
    return status;
  } finally {
    await session.close();
  }
}

const cases = CASES.filter((c) => pattern.test(c.id));
const server = await startServer();
const browser = await startBrowser();
const results: Record<string, string> = {};
try {
  for (const kase of cases) {
    for (const key of kase.fixtures) {
      if (onlyFixture && key !== onlyFixture) continue;
      const caseId = `${kase.id}@${key}`;
      if (kase.blocked) {
        rmSync(path.join(RECORDINGS, caseId), { force: true, recursive: true });
        updateIndex({ caseId, case: kase.id, format: FIXTURES[key]!.format, fixture: key, parityRows: kase.rows, status: 'blocked', reason: kase.blocked });
        results[caseId] = 'blocked';
        continue;
      }
      try {
        results[caseId] = await record(browser, kase, FIXTURES[key]!);
      } catch (error) {
        results[caseId] = 'error';
        log(`${caseId} error ${(error as Error).stack}`);
        updateIndex({ caseId, case: kase.id, fixture: key, format: FIXTURES[key]!.format, parityRows: kase.rows, status: 'error', error: String((error as Error).message).slice(0, 300) });
      }
    }
  }
} finally {
  await browser.close();
  await server.close();
  writeFileSync(path.join(TRACK, 'logs', 'b-record-last.json'), JSON.stringify(results, null, 2));
}
