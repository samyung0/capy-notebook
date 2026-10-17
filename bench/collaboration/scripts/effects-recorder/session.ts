// Shared plumbing for the recorder: the Vite server over Capy's config, the
// headless browser, fixtures and seeds, and one host page session.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { type Browser, type BrowserContext, chromium, type Frame, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { RECORDER_PORT } from './vite.recorder.config';

export const HERE = import.meta.dirname;
export const ROOT = path.resolve(HERE, '../../../..');
export const TRACK = process.env.EFFECTS_TRACK ?? 'C:/WEB/capy-harness/2026-10-17-effects-misses';
export const RECORDINGS = path.join(TRACK, 'recordings');
export const ORIGIN = `http://127.0.0.1:${RECORDER_PORT}`;
const CHECK = path.join(HERE, 'check/target/release/effects-recorder-check.exe');

export type Format = 'docx' | 'pptx' | 'xlsx';
export interface Fixture {
  key: string;
  path: string; // relative to ROOT
  format: Format;
}

export const FIXTURES: Record<string, Fixture> = Object.fromEntries(
  (
    [
      ['book-30p', 'vendor/betteroffice/poc/fixtures/book-30p.docx'],
      ['exchange-plan', 'vendor/betteroffice/poc/fixtures/exchange-plan.docx'],
      ['comprehensive', 'vendor/betteroffice/poc/fixtures/wordprocessingml-comprehensive.docx'],
      ['feature-rich-docx', 'vendor/betteroffice/poc/fixtures/feature-rich.docx'],
      ['opaque-objects', 'vendor/betteroffice/poc/fixtures/opaque-objects.docx'],
      ['exchange-plan-comments', 'e2e/fixtures/files/rich-content/exchange-plan-comments.docx'],
      ['long-handbook', 'bench/editor/fixtures/office/long-handbook.docx'],
      ['lecture', 'vendor/betteroffice/poc/fixtures/lecture.pptx'],
      ['feature-rich-pptx', 'vendor/betteroffice/poc/fixtures/feature-rich.pptx'],
      ['deck-50', 'vendor/betteroffice/poc/fixtures/deck-50.pptx'],
      ['course-guide', 'e2e/fixtures/files/rich-content/course-guide.xlsx'],
      ['feature-rich-xlsx', 'vendor/betteroffice/poc/fixtures/feature-rich.xlsx'],
      ['grades', 'e2e/fixtures/files/basic/grades.xlsx'],
      ['rows-50k', 'bench/editor/fixtures/office/rows-50k.xlsx'],
    ] as const
  ).map(([key, file]) => [key, { key, path: file, format: path.extname(file).slice(1) as Format }])
);

export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export function runCheck(args: string[]): unknown {
  const result = spawnSync(CHECK, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`check ${args[0]} failed: ${result.stderr || result.error}`);
  return JSON.parse(result.stdout);
}

/** The server seed of a fixture, made once by the native check binary. */
export function seedOf(fixture: Fixture) {
  const bytes = readFileSync(path.join(ROOT, fixture.path));
  const fixtureSha = sha256(bytes);
  const dir = path.join(RECORDINGS, '_seeds');
  mkdirSync(dir, { recursive: true });
  const name = `${path.basename(fixture.path)}.${fixtureSha.slice(0, 12)}.seed.bin`;
  const file = path.join(dir, name);
  const indexFile = path.join(dir, 'index.json');
  const index: Record<string, unknown> = existsSync(indexFile) ? JSON.parse(readFileSync(indexFile, 'utf8')) : {};
  if (!existsSync(file)) {
    const made = runCheck(['seed', fixture.format, path.join(ROOT, fixture.path), file]) as { bytes: number };
    index[fixtureSha] = {
      file: name,
      fixture: fixture.path,
      format: fixture.format,
      bytes: made.bytes,
      seedSha256: sha256(readFileSync(file)),
    };
    writeFileSync(indexFile, `${JSON.stringify(index, null, 2)}\n`);
  }
  const seed = readFileSync(file);
  return { bytes, fixtureSha, seed, seedFile: name, seedSha: sha256(seed) };
}

export async function startServer(): Promise<ViteDevServer> {
  const server = await createServer({
    configFile: path.join(HERE, 'vite.recorder.config.ts'),
    logLevel: 'warn',
    mode: 'development',
  });
  await server.listen();
  return server;
}

export async function startBrowser(): Promise<Browser> {
  return chromium.launch({ headless: true });
}

export interface Session {
  context: BrowserContext;
  page: Page;
  frame(peer: string): Frame;
  close(): Promise<void>;
}

/** A host page with `peers` runtime frames loaded on the fixture in edit mode. */
export async function openSession(
  browser: Browser,
  fixture: Fixture,
  peers: string[],
  log: (line: string) => void
): Promise<{ session: Session; seed: ReturnType<typeof seedOf> }> {
  const seed = seedOf(fixture);
  // Tall enough for every frame (900 px each): the host page never scrolls, so
  // a scrollIntoView inside a frame cannot move the frames under the mouse.
  const context = await browser.newContext({
    deviceScaleFactor: 1,
    viewport: { height: 920 * peers.length + 40, width: 1300 },
  });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ORIGIN });
  const page = await context.newPage();
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') log(`[console.${message.type()}] ${message.text()}`);
  });
  page.on('pageerror', (error) => log(`[pageerror] ${error.message}`));
  await page.goto(`${ORIGIN}/bench/collaboration/scripts/effects-recorder/host.html`);
  await page.waitForFunction(() => 'recorder' in window, null, { timeout: 120_000 });
  await page.evaluate(
    (options) => window.recorder.start(options),
    {
      file: Buffer.from(seed.bytes).toString('base64'),
      fileName: path.basename(fixture.path),
      format: fixture.format,
      peers,
      seed: Buffer.from(seed.seed).toString('base64'),
    }
  );
  const session: Session = {
    close: () => context.close(),
    context,
    frame(peer) {
      const frame = page.frame({ name: `peer-${peer}` });
      if (!frame) throw new Error(`no frame for ${peer}`);
      return frame;
    },
    page,
  };
  return { seed, session };
}
