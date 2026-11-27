// Run playback.html in Playwright's Chromium (WebGPU on) for each take and print its result,
// with Chromium's own processes measured over the page's run: CPU seconds per second of film
// (GPU process, renderer, browser) and their peak resident memory.
// The page is served from bench/manim on port 8765 (python3 -m http.server).
// usage: node playback_run.mjs <playwright module path> <chromium|chrome> <playback|video> <take name>…
import { execFileSync } from "node:child_process";

const [pw, channel, kind, ...takes] = process.argv.slice(2);
const { chromium } = await import(pw);
const browser = await chromium.launch({ channel, args: ["--enable-unsafe-webgpu"] });
const cdp = await browser.newBrowserCDPSession();

const processes = async () => (await cdp.send("SystemInfo.getProcessInfo")).processInfo;
const rssMB = (pids) => {
  const out = execFileSync("ps", ["-o", "pid=,rss=", "-p", pids.join(",")], { encoding: "utf8" });
  return Object.fromEntries(out.trim().split("\n").map((l) => l.trim().split(/\s+/).map(Number)).map(([p, kb]) => [p, kb / 1024]));
};

for (const take of takes) {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.error(take, "page error:", e.message));
  const before = await processes();
  await page.goto(`http://localhost:8765/scripts/player/${kind}.html?take=${take}`);
  const peak = {};
  let result = null;
  while (!(result = await page.evaluate(() => window.result ?? null))) {
    const procs = await processes();
    const rss = rssMB(procs.map((p) => p.id));
    for (const p of procs) peak[p.type] = Math.max(peak[p.type] ?? 0, rss[p.id] ?? 0);
    await new Promise((r) => setTimeout(r, 500));
  }
  const after = await processes();
  const cpu = {};
  for (const p of after) {
    const was = before.find((b) => b.id === p.id)?.cpuTime ?? 0;
    cpu[p.type] = (cpu[p.type] ?? 0) + p.cpuTime - was;
  }
  const per = (x) => +(x / result.seconds).toFixed(3);
  console.log(JSON.stringify({
    ...result,
    cpu_s_per_film_s: Object.fromEntries(Object.entries(cpu).filter(([, v]) => v > 0.01).map(([k, v]) => [k, per(v)])),
    peak_rss_MB: Object.fromEntries(Object.entries(peak).map(([k, v]) => [k, Math.round(v)])),
  }));
  await page.close();
}
await browser.close();
