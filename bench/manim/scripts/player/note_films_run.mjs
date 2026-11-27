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
  // The engines' WebAssembly heaps: one per drawn film loaded, in its own frame (engine.ts).
  const wasm = await page.evaluate(async () => {
    let bytes = 0;
    for (const frame of document.querySelectorAll('iframe[src*="engine-frame"]')) {
      const engine = await frame.contentWindow?.engine?.catch(() => null);
      if (engine) bytes += (await engine.default()).memory.buffer.byteLength;
    }
    // Before films had frames of their own: the page's one engine, once a drawn film loaded it.
    if (window.__benchPageEngine) {
      const engine = await import("/vendor/manimgx/0.1.1/engine.js");
      bytes += (await engine.default()).memory.buffer.byteLength;
    }
    return bytes / 2 ** 20;
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

// Empty lines right after the note's own "Organelle overview" heading (not inside one of its
// embeds' editors), then each film in the first of them still empty: they stand in order.
const heading = editor.getByRole("heading", { name: "Organelle overview" });
const text = heading.locator("[data-slate-string]").last();
const end = await text.boundingBox();
await text.click({ position: { x: end.width - 1, y: end.height / 2 } });
for (const _ of rows) await page.keyboard.press("Enter");
const markSlot = () =>
  page.evaluate(() => {
    for (const old of document.querySelectorAll("[data-bench-slot]")) old.removeAttribute("data-bench-slot");
    const h2 = [...document.querySelectorAll("[data-slate-editor] h2")].find((e) => e.textContent.trim() === "Organelle overview");
    let block = h2.closest("[data-slot=block-wrapper]") ?? h2;
    while ((block = block.nextElementSibling)) {
      if (block.querySelector(".slate-film")) continue;
      const line = block.matches(".slate-p") ? block : block.querySelector(".slate-p");
      if (!line || line.textContent.trim() !== "") return false;
      line.setAttribute("data-bench-slot", "");
      return true;
    }
    return false;
  });
for (const r of rows) {
  if (!(await markSlot())) throw new Error("no empty line after the heading");
  await page.locator("[data-bench-slot]").click();
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
  // The closed picker hands focus back to the note; a click before that is undone.
  await page.waitForFunction(() => !!document.activeElement?.closest("[data-slate-editor]"));
}
const blocks = page.locator(".slate-film");
console.error(`films in the note: ${await blocks.count()}`);
await page.keyboard.press("Escape");
// Out of the editor, so it doesn't scroll back to its caret while the walk scrolls.
await page.evaluate(() => {
  window.getSelection()?.removeAllRanges();
  document.activeElement?.blur();
});

// Walk the note: each film in view, played.
for (let i = 0; i < rows.length; i++) {
  const block = blocks.nth(i);
  await block.evaluate((el) => el.scrollIntoView({ block: "center" }));
  const player = block.locator("canvas, video").first();
  await player.waitFor({ timeout: 60_000 });
  if (await block.locator("video").count()) await block.locator("video").evaluate((v) => { v.muted = true; return v.play(); });
  else {
    // The player comes up once its engine has (its frame); then k plays.
    await page.waitForTimeout(3000);
    // k plays (ManimGX's keys); the press scrolls the player into view and focuses it.
    await block.locator("[role=application]").press("k");
    await page.evaluate(() => {
      window.__benchPageEngine ||= !document.querySelector('iframe[src*="engine-frame"]');
    });
  }
  await hold(`playing ${rows[i].name}`, dwell);
  await block.screenshot({ path: path.join(filmDir, `${rows[i].name}.png`) });
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
