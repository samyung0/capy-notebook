// Profile DOCX edit mode: CPU per keystroke, heap and process memory growth while typing.
const { chromium } = require('@playwright/test');
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const OUT = process.env.OUT ?? process.cwd();
const BASE = process.env.BASE ?? 'http://localhost:5173';
const URL = `${BASE}/workspaces/ws_bio?file=bio-office-docx&mode=edit`;
const CHARS = Number(process.env.CHARS ?? 40);

function processMB() {
  // Private memory of every Playwright Chromium process.
  const cmd =
    process.platform === 'win32'
      ? `powershell -NoProfile -Command "Get-Process | Where-Object { $_.Path -like '*ms-playwright*' } | Measure-Object -Property PrivateMemorySize64 -Sum | ForEach-Object { [math]::Round($_.Sum / 1MB) }"`
      : `ps -axo rss=,command= | awk '/ms-playwright/ { s += $1 } END { print int(s / 1024) }'`;
  return Number(execSync(cmd).toString().trim());
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  const snap = async (label) => {
    await cdp.send('HeapProfiler.collectGarbage');
    const { metrics } = await cdp.send('Performance.getMetrics');
    const get = (n) => metrics.find((m) => m.name === n)?.value ?? 0;
    console.log(label, JSON.stringify({ jsHeapMB: Math.round(get('JSHeapUsedSize') / 1e6), nodes: get('Nodes'), processesMB: processMB() }));
  };
  await snap('blank');
  await page.goto(URL);
  let ef;
  for (const start = Date.now(); !ef; ) {
    const f = page.frames().find((x) => x.url().includes('office-runtime.html'));
    if (f && (await f.locator('[data-testid="formatting-bar"]').count().catch(() => 0))) ef = f;
    else await page.waitForTimeout(250);
    if (Date.now() - start > 180_000) throw new Error('no editor');
  }
  await page.waitForTimeout(4000);
  await snap('editor open');

  const pageBox = await ef.locator('canvas').first().boundingBox();
  const box = await page.locator('iframe').boundingBox();
  await page.mouse.click(box.x + pageBox.x + pageBox.width / 2, box.y + pageBox.y + 200);
  await page.waitForTimeout(1000);

  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
  await cdp.send('Profiler.start');
  const lat = [];
  for (let i = 0; i < CHARS; i++) {
    const s = Date.now();
    await page.keyboard.press(i % 6 === 5 ? 'Space' : 'a');
    await ef.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    lat.push(Date.now() - s);
  }
  const { profile } = await cdp.send('Profiler.stop');
  fs.writeFileSync(path.join(OUT, 'typing.cpuprofile'), JSON.stringify(profile));
  lat.sort((a, b) => a - b);
  console.log(`keystroke->frame ms: p50 ${lat[Math.floor(lat.length / 2)]} p90 ${lat[Math.floor(lat.length * 0.9)]} max ${lat.at(-1)}`);
  await page.waitForTimeout(2000);
  await snap(`after ${CHARS} chars`);

  // Self time by function and by script.
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map();
  const dt = profile.timeDeltas;
  profile.samples.forEach((id, i) => self.set(id, (self.get(id) ?? 0) + (dt[i] ?? 0)));
  const fn = new Map(), file = new Map();
  for (const [id, us] of self) {
    const { callFrame: c } = byId.get(id);
    const short = c.url.replace(/^.*\/(node_modules|vendor|src)\//, '$1/').replace(/\?.*$/, '');
    const k = `${c.functionName || '(anon)'} ${short}:${c.lineNumber + 1}`;
    fn.set(k, (fn.get(k) ?? 0) + us);
    const f = short || `(${c.functionName})`;
    file.set(f, (file.get(f) ?? 0) + us);
  }
  const total = [...self.values()].reduce((a, b) => a + b, 0);
  const top = (m, n) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${(v / 1000).toFixed(0).padStart(6)} ms ${((v / total) * 100).toFixed(1).padStart(5)}%  ${k}`).join('\n');
  console.log(`\ntotal sampled ${(total / 1000).toFixed(0)} ms\n-- by script --\n${top(file, 15)}\n-- by function (self) --\n${top(fn, 30)}`);
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
