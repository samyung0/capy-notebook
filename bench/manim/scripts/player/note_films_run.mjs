// Memory of a note holding several films, in Chrome (WebGPU on). Against the app's dev server
// with mocks (VITE_USE_MSW=true), it adds the films in bench/manim/.results/notefilms to
// Biology 101, puts each in a note through the slash menu's Manim film, then walks the note:
// each film scrolled to and played for a while, then back to the top for longer than a film
// block lingers once off screen (30 s). Chrome's processes are sampled every second (memory
// footprint by process type) with the page's JS heap; one JSON line per sample, then a summary.
// usage: node note_films_run.mjs <playwright module path> <base url> <seconds per film> <film>…
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [pw, base, dwellArg, ...films] = process.argv.slice(2);
const dwell = Number(dwellArg) * 1000;
const here = path.dirname(fileURLToPath(import.meta.url));
const filmDir = path.resolve(here, "../../.results/notefilms");
const { chromium } = await import(pw);
const browser = await chromium.launch({
  args: ["--enable-unsafe-webgpu", "--autoplay-policy=no-user-gesture-required"],
  channel: "chrome",
});
const cdp = await browser.newBrowserCDPSession();
const page = await browser.newPage({ viewport: { height: 900, width: 1400 } });
page.on("pageerror", (e) => console.error("page error:", e.message));
const pageCdp = await page.context().newCDPSession(page);

// macOS's memory footprint per process (what Activity Monitor and Chrome's task manager show;
// resident memory swings with compression): now and its peak so far.
const UNIT = { B: 2 ** -20, KB: 2 ** -10, MB: 1, GB: 1024 };
const footprintMB = (pids) => {
  let out;
  try {
    out = execFileSync("footprint", pids.flatMap((p) => ["-p", String(p)]), { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch (e) {
    out = e.stdout ?? ""; // a process that exited since the list: the rest still print
  }
  const now = {};
  const peak = {};
  let pid = null;
  for (const line of out.split("\n")) {
    const head = line.match(/\[(\d+)\]:.*Footprint: ([\d.]+) (\w+)/);
    if (head) {
      pid = Number(head[1]);
      now[pid] = Number(head[2]) * UNIT[head[3]];
    }
    const top = line.match(/phys_footprint_peak: ([\d.]+) (\w+)/);
    if (top && pid !== null) peak[pid] = Number(top[1]) * UNIT[top[2]];
  }
  return { now, peak };
};
const t0 = Date.now();
const samples = [];
async function sample(phase) {
  const procs = (await cdp.send("SystemInfo.getProcessInfo")).processInfo;
  const { now, peak } = footprintMB(procs.map((p) => p.id));
  const byType = {};
  let peakSum = 0;
  for (const p of procs) {
    byType[p.type] = (byType[p.type] ?? 0) + (now[p.id] ?? 0);
    peakSum += peak[p.id] ?? 0;
  }
  const { usedSize } = await pageCdp.send("Runtime.getHeapUsage");
  const mounted = await page.locator(".slate-film canvas, .slate-film video").count();
  // The engine's WebAssembly heap (one per page, shared by every film; it only grows).
  const wasm = await page.evaluate(async () => {
    const engine = await import("/vendor/manimgx/0.1.1/engine.js");
    return window.__mgxLoaded ? (await engine.default()).memory.buffer.byteLength / 2 ** 20 : 0;
  });
  const s = {
    t: +((Date.now() - t0) / 1000).toFixed(1),
    phase,
    mounted,
    total_MB: Math.round(Object.values(byType).reduce((a, b) => a + b, 0)),
    peaks_MB: Math.round(peakSum),
    ...Object.fromEntries(Object.entries(byType).map(([k, v]) => [`${k}_MB`, Math.round(v)])),
    js_heap_MB: Math.round(usedSize / 2 ** 20),
    wasm_MB: Math.round(wasm),
  };
  samples.push(s);
  console.log(JSON.stringify(s));
}
async function hold(phase, ms) {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    await sample(phase);
    await page.waitForTimeout(1000);
  }
}

await page.goto(`${base}/workspaces/ws_bio?material=mat_note_1`);
const editor = page.locator("[data-slate-editor]").first();
await editor.waitFor({ timeout: 60_000 });
await page.waitForTimeout(3000);

// The films, as Biology 101's files, each served by the dev server from .results.
const rows = films.map((name, i) => ({
  id: `f_bench_film_${i}`,
  name: `${name}.cmv`,
  sizeBytes: statSync(path.join(filmDir, `${name}.cmv`)).size,
  url: `/bench/manim/.results/notefilms/${name}.cmv`,
}));
await page.evaluate(async (rows) => {
  // The module the app loaded (the dev server adds ?t= after a hot update).
  const handlers = await (await fetch("/src/mocks/handlers.ts")).text();
  const url = handlers.match(/["'](\/src\/mocks\/db\.ts[^"']*)["']/)[1];
  const db = await import(url);
  for (const r of rows) {
    db.fileLinks[r.id] = { url: r.url };
    db.files.push({
      addedAt: new Date().toISOString(), hasBytes: true, id: r.id, indexed: false, isPayer: true,
      kind: "film", name: r.name, position: 90, revision: 1, sizeBytes: r.sizeBytes,
      status: "ready", topicId: null, workspaceId: "ws_bio",
    });
  }
}, rows);

await hold("note, no films", 10_000);

// Empty lines at the note's end, then each film in the first of them (a film takes its line).
const empties = editor.locator(".slate-p").filter({ hasText: /^\s*$/ });
await editor.locator(".slate-p").last().click();
for (const _ of rows) await page.keyboard.press("Enter");
const slot = (await empties.count()) - rows.length - 1;
for (const r of rows) {
  await empties.nth(slot).click();
  await page.keyboard.type("/manim");
  await page.getByRole("option", { exact: true, name: "Manim film" }).click({ timeout: 10_000 }).catch(async (e) => {
    await page.screenshot({ path: path.join(filmDir, "failed.png") });
    throw e;
  });
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("radio", { name: new RegExp(r.name.replace(".", "\\.")) }).click({ timeout: 15_000 }).catch(async (e) => {
    await page.screenshot({ path: path.join(filmDir, "failed.png") });
    throw e;
  });
  await dialog.getByRole("button", { exact: true, name: "Insert" }).click();
  await dialog.waitFor({ state: "detached" });
}
const blocks = page.locator(".slate-film");
console.error(`films in the note: ${await blocks.count()}`);
await page.keyboard.press("Escape");

// Walk the note: each film in view, played.
for (let i = 0; i < rows.length; i++) {
  const block = blocks.nth(i);
  await block.scrollIntoViewIfNeeded();
  const player = block.locator("canvas, video").first();
  await player.waitFor({ timeout: 60_000 });
  if (await block.locator("video").count()) await block.locator("video").evaluate((v) => { v.muted = true; return v.play(); });
  else {
    await block.locator("[role=application]").focus();
    await page.evaluate(() => { window.__mgxLoaded = true; });
    await page.keyboard.press("k");
  }
  await hold(`playing ${rows[i].name}`, dwell);
}

// Back to the top, past the linger, so the films off screen let go.
await editor.locator(".slate-p").first().scrollIntoViewIfNeeded();
await hold("back at the top", 45_000);
// What is garbage not yet collected, and what is held: the page's collector, run by hand.
await pageCdp.send("HeapProfiler.collectGarbage");
await hold("after a forced collection", 15_000);

const peak = (pred) => Math.max(...samples.filter(pred).map((s) => s.total_MB));
const last = (phase) => samples.filter((s) => s.phase === phase).at(-1);
console.log(JSON.stringify({
  summary: true,
  films: rows.map((r) => ({ name: r.name, MB: +(r.sizeBytes / 2 ** 20).toFixed(2) })),
  baseline_MB: last("note, no films").total_MB,
  peak_MB: peak(() => true),
  peak_mounted: Math.max(...samples.map((s) => s.mounted)),
  end_MB: last("back at the top").total_MB,
  after_gc_MB: last("after a forced collection").total_MB,
  end_mounted: last("back at the top").mounted,
}));
await browser.close();
