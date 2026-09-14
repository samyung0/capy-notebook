/** Real Capy iframe viewers: citation messages change overlays, never saved bytes.
 * Run: pnpm exec tsx bench/parsers/scripts/verify_native_viewers.ts */
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

const root = path.resolve(import.meta.dirname, '../../..');
const output = path.join(root, 'bench/parsers/reports/local/2026-09-14-native-citations/viewers');
await mkdir(output, { recursive: true });
const server = await createServer({ root, logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false }, plugins: [{ name: 'citation-verification-parent', configureServer(instance) {
  instance.middlewares.use((req, res, next) => {
    if (req.url !== '/citation-verification') return next();
    res.setHeader('Content-Type', 'text/html');
    res.end('<html><body style="margin:0"><iframe style="width:100vw;height:100vh;border:0"></iframe></body></html>');
  });
} }] });
await server.listen();
const address = server.httpServer?.address();
assert(address && typeof address === 'object');
const origin = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ headless: true });
const results = [];
const cases: Array<{format:string; quote:string; source:string; label:string}> = process.argv[2]
  ? JSON.parse(await readFile(process.argv[2], 'utf8'))
  : [['docx', 'CAPY_EDIT_MARKER_DOCX'], ['xlsx', 'BetterOffice browser round-trip fixture'], ['pptx', 'CAPY_EDIT_MARKER_PPTX']].map(([format,quote]) => ({ format, quote, source:`/vendor/betteroffice/poc/fixtures/feature-rich.${format}`, label:format }));
try {
  for (const { format, quote, source, label } of cases) {
    const page = await browser.newPage({ viewport: { width: 1300, height: 1000 }, deviceScaleFactor: 1 });
    const errors: string[] = [];
    page.on('pageerror', error => { errors.push(error.message); console.error(format, error.message); });
    page.on('console', message => { if (message.type() === 'error') console.error(format, message.text()); });
    await page.goto(`${origin}/citation-verification`);
    const analysis = await page.evaluate(async ({ format, origin, source }) => {
      const iframe = document.querySelector('iframe')!;
      const bytes = await (await fetch(source)).arrayBuffer();
      return await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('runtime readiness timeout')), 60_000);
        window.addEventListener('message', event => {
          if (event.source !== iframe.contentWindow || event.origin !== origin) return;
          if (event.data.type === 'initialized') iframe.contentWindow!.postMessage({ version:4, type:'load', format, fileName:`feature-rich.${format}`, bytes: bytes.slice(0), mode:'view', canEdit:true, revision:1 }, origin);
          if (event.data.type === 'ready') { clearTimeout(timeout); resolve(event.data.analysis); }
          if (event.data.type === 'error') { clearTimeout(timeout); reject(new Error(event.data.message)); }
        });
        iframe.src = `/office-runtime.html?parentOrigin=${encodeURIComponent(origin)}`;
      });
    }, { format, origin, source });
    console.log(`${format} ready`);
    const frame = page.frames().find(frame => frame.url().includes('office-runtime.html'))!;
    await frame.locator('canvas').first().waitFor();
    const send = (citation: { quote:string } | null) => page.evaluate(({ citation, origin }) => document.querySelector('iframe')!.contentWindow!.postMessage({version:4,type:'set-citation',citation},origin), { citation, origin });
    const pixels = () => frame.locator('canvas').first().evaluate(async node => {
      const canvas = node as HTMLCanvasElement;
      const data = canvas.getContext('2d')!.getImageData(0,0,canvas.width,canvas.height).data;
      const hash = await crypto.subtle.digest('SHA-256', data);
      return Array.from(new Uint8Array(hash)).map(value => value.toString(16).padStart(2,'0')).join('');
    });
    // Wait for asynchronous canvas/image painting, then compare stable states.
    await page.waitForTimeout(1200);
    const before = await pixels();
    await send({ quote });
    await page.waitForTimeout(800);
    const after = await pixels();
    const changed = Number(after !== before);
    const overlays = await frame.locator('[data-citation-highlight]').count();
    assert(format === 'docx' ? overlays > 0 : changed > 0, `${format} highlight missing`);
    await page.screenshot({ path: path.join(output, `${label}-highlight.png`) });
    await send(null);
    await page.waitForTimeout(300);
    if (format === 'docx') assert.equal(await frame.locator('[data-citation-highlight]').count(), 0);
    else assert.deepEqual(await pixels(), before, `${format} did not clear highlight`);
    assert.deepEqual(errors, []);
    results.push({ label, format, quote, analysis, changed, overlays, cleared:true });
    await page.close();
  }
  await writeFile(path.join(output, process.argv[2] ? 'google-verification.json' : 'verification.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results));
} finally { await browser.close(); await server.close(); }
