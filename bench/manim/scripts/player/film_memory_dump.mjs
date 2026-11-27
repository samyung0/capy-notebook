// Where a playing film's memory goes, by Chrome's own accounting: opens one film in the app's
// file viewer (dev server with mocks), plays it for a while, then takes a memory-infra dump and
// prints each process's largest allocators (Dawn's GPU buffers and textures, V8, PartitionAlloc,
// shared memory…). The film comes from bench/manim/.results/notefilms/<film>.cmv.
// usage: node film_memory_dump.mjs <playwright module path> <base url> <seconds> <film>
// (DEPTH=n shows allocators n levels deep, MATCH=regex only those matching)
import { statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [pw, base, secondsArg, name] = process.argv.slice(2);
const here = path.dirname(fileURLToPath(import.meta.url));
const filmPath = path.resolve(here, "../../.results/notefilms", `${name}.cmv`);
const { chromium } = await import(pw);
const browser = await chromium.launch({ args: ["--enable-unsafe-webgpu"], channel: "chrome" });
const page = await browser.newPage({ viewport: { height: 900, width: 1400 } });

await page.goto(`${base}/workspaces/ws_bio`);
await page.waitForTimeout(3000);
await page.evaluate(
  async ({ size, url }) => {
    const handlers = await (await fetch("/src/mocks/handlers.ts")).text();
    const db = await import(handlers.match(/["'](\/src\/mocks\/db\.ts[^"']*)["']/)[1]);
    db.fileLinks.f_bench_dump = { url };
    db.files.push({
      addedAt: new Date().toISOString(), hasBytes: true, id: "f_bench_dump", indexed: false,
      isPayer: true, kind: "film", name: "dump.cmv", position: 90, revision: 1, sizeBytes: size,
      status: "ready", topicId: null, workspaceId: "ws_bio",
    });
  },
  { size: statSync(filmPath).size, url: `/bench/manim/.results/notefilms/${name}.cmv` }
);
await page.evaluate(() => {
  history.pushState({}, "", "/workspaces/ws_bio?file=f_bench_dump");
  dispatchEvent(new PopStateEvent("popstate"));
});
const player = page.locator("[role=application], video").first();
await player.waitFor({ timeout: 60_000 });
await page.waitForTimeout(3000);
if (await page.locator("video").count()) await page.locator("video").evaluate((v) => { v.muted = true; return v.play(); });
else await page.locator("[role=application]").press("k");
await page.waitForTimeout(Number(secondsArg) * 1000);

// A detailed memory-infra dump of every process.
const cdp = await browser.newBrowserCDPSession();
const events = [];
cdp.on("Tracing.dataCollected", ({ value }) => events.push(...value));
const done = new Promise((resolve) => cdp.once("Tracing.tracingComplete", resolve));
await cdp.send("Tracing.start", {
  traceConfig: {
    includedCategories: ["disabled-by-default-memory-infra"],
    memoryDumpConfig: { triggers: [] },
    recordMode: "recordAsMuchAsPossible",
  },
  transferMode: "ReportEvents",
});
await cdp.send("Tracing.requestMemoryDump", { levelOfDetail: "detailed" });
await cdp.send("Tracing.end");
await done;
await browser.close();

const names = {};
for (const e of events) if (e.ph === "M" && e.name === "process_name") names[e.pid] = e.args.name;
const MB = (hex) => Number.parseInt(hex, 16) / 2 ** 20;
for (const e of events.filter((x) => x.ph === "v" && x.args?.dumps)) {
  const { allocators = {}, process_totals: totals = {} } = e.args.dumps;
  const rows = Object.entries(allocators)
    .filter(([key]) => key.split("/").length <= Number(process.env.DEPTH ?? 3))
    .filter(([key]) => !process.env.MATCH || new RegExp(process.env.MATCH).test(key))
    .map(([key, a]) => [key, a.attrs?.size ? MB(a.attrs.size.value) : 0])
    .filter(([, mb]) => mb >= 8)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 14);
  if (!rows.length) continue;
  const resident = totals.resident_set_bytes ? MB(totals.resident_set_bytes) : 0;
  console.log(`\n${names[e.pid] ?? e.pid} (resident ${resident.toFixed(0)} MB)`);
  for (const [key, mb] of rows) console.log(`  ${mb.toFixed(1).padStart(8)} MB  ${key}`);
}
