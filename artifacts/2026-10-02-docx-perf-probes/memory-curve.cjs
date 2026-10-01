// Memory growth curve while typing in DOCX edit mode, split into JS heap, WASM memories and canvases.
const { chromium } = require('@playwright/test');
const { execSync } = require('node:child_process');

const BASE = process.env.BASE ?? 'http://localhost:5173';
const URL = `${BASE}/workspaces/ws_bio?file=bio-office-docx&mode=edit`;

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
  // Record every WASM instance's exported memory in every frame and worker-less realm.
  await context.addInitScript(() => {
    const mems = (window.__wasmMemories = []);
    const keep = (r) => {
      const inst = r.instance ?? r;
      for (const [name, v] of Object.entries(inst.exports ?? {}))
        if (v instanceof WebAssembly.Memory) mems.push({ name, mem: v, at: new Error().stack.split('\n')[3]?.trim() });
      return r;
    };
    for (const k of ['instantiate', 'instantiateStreaming']) {
      const orig = WebAssembly[k];
      WebAssembly[k] = function (...a) { return orig.apply(this, a).then(keep); };
    }
    const OrigInstance = WebAssembly.Instance;
    WebAssembly.Instance = function (m, i) { const inst = new OrigInstance(m, i); keep(inst); return inst; };
    WebAssembly.Instance.prototype = OrigInstance.prototype;
  });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  let ef;
  await page.goto(URL);
  for (const start = Date.now(); !ef; ) {
    const f = page.frames().find((x) => x.url().includes('office-runtime.html'));
    if (f && (await f.locator('[data-testid="formatting-bar"]').count().catch(() => 0))) ef = f;
    else await page.waitForTimeout(250);
    if (Date.now() - start > 180_000) throw new Error('no editor');
  }
  await page.waitForTimeout(4000);
  const snap = async (label) => {
    await cdp.send('HeapProfiler.collectGarbage');
    const { metrics } = await cdp.send('Performance.getMetrics');
    const heap = Math.round(metrics.find((m) => m.name === 'JSHeapUsedSize').value / 1e6);
    const frame = await ef.evaluate(() => ({
      wasm: window.__wasmMemories.map((m) => Math.round(m.mem.buffer.byteLength / 1e6)),
      canvases: document.querySelectorAll('canvas').length,
      canvasMB: Math.round([...document.querySelectorAll('canvas')].reduce((a, c) => a + c.width * c.height * 4, 0) / 1e6),
      fontFaces: document.fonts.size,
    }));
    console.log(label.padEnd(14), JSON.stringify({ processesMB: processMB(), jsHeapMB: heap, ...frame }));
  };
  await snap('editor open');
  const pageBox = await ef.locator('canvas').first().boundingBox();
  const box = await page.locator('iframe').boundingBox();
  await page.mouse.click(box.x + pageBox.x + pageBox.width / 2, box.y + pageBox.y + 200);
  await page.waitForTimeout(500);
  for (let round = 1; round <= 5; round++) {
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press(i % 6 === 5 ? 'Space' : 'a');
      await ef.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    }
    await page.waitForTimeout(1500);
    await snap(`${round * 40} chars`);
  }
  console.log(await ef.evaluate(() => window.__wasmMemories.map((m) => m.at).join('\n')));
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
