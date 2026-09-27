import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';

const base = process.env.EXPORT_PROBE_URL || 'http://127.0.0.1:5200';
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
await context.route('https://i.ytimg.com/**', route => route.fulfill({ contentType: 'image/png', headers: { 'access-control-allow-origin': '*' }, body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAJCAIAAAC0SDtlAAAAGklEQVR4nGO8e/cuAymAiSTVDKMaiAMkBysAgmcCqYF2f+QAAAAASUVORK5CYII=', 'base64') }));
const page = await context.newPage();
const results = [];
try {
  await page.goto(`${base}/bench/editor/scripts/export-client.html`);
  await page.waitForFunction(() => typeof window.exportClientProbe === 'function');
  const cdp = await context.newCDPSession(page);
  for (const rate of [1, 4]) {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate });
    for (const format of ['markdown', 'docx']) {
      for (const [name, input] of [
        ['warmup', { count: 20 }],
        ['medium', { count: 500, textLength: 180 }],
        ['near-node-limit', { count: 4900, textLength: 120 }],
        ['near-byte-limit', { count: 2000, textLength: 930 }],
        ['mixed-1300-blocks', { count: 25, fixture: true, mounted: 5000 }],
        ['unique-100-formulas', { count: 100, math: true, mounted: 5000 }],
      ]) {
        for (let repeat = 0; repeat < (name === 'warmup' || name === 'unique-100-formulas' ? 1 : 3); repeat++) {
          const result = await page.evaluate(input => window.exportClientProbe(input), { ...input, format });
          results.push({ name, rate, format, repeat, ...result });
          console.log(JSON.stringify(results.at(-1)));
        }
      }
    }
  }
} finally {
  await mkdir('bench/editor/.results/export-2026-09-27', { recursive: true });
  await writeFile('bench/editor/.results/export-2026-09-27/implemented.json', JSON.stringify({ date: new Date().toISOString(), cpu: os.cpus()[0].model, browser: browser.version(), results }, null, 2));
  await browser.close();
}
