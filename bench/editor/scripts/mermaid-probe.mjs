// Main-thread blocking while a near-limit Mermaid diagram draws, on the page
// (as before the worker) and in the worker, at 1x and 4x CPU throttle.
// Start the app's dev server first (MERMAID_PROBE_URL, default port 5173).
// CDP throttles the page's main thread only, not the worker.
import { chromium } from "@playwright/test";

const base = process.env.MERMAID_PROBE_URL || "http://127.0.0.1:5173";
const browser = await chromium.launch({ channel: "chromium", headless: true });
try {
  for (const rate of [1, 4]) {
    for (const where of ["page", "worker"]) {
      for (const name of ["near-flowchart", "near-mindmap"]) {
        for (let repeat = 0; repeat < 2; repeat++) {
          // A fresh page per run: a page draw leaves mermaid's state behind.
          const page = await browser.newPage();
          page.on("pageerror", (error) => console.error("Browser:", error.message));
          await page.goto(`${base}/bench/editor/scripts/mermaid-probe.html`);
          await page.waitForFunction(() => document.body.dataset.ready === "true", null, {
            timeout: 120_000,
          });
          // Warm up: mermaid and the worker load before the clock starts.
          await page.evaluate(
            ([where, code]) => window.mermaidProbe(where, code),
            [where, name === "near-mindmap" ? "mindmap\n  root\n    a" : "flowchart TD\n  A --> B"],
          );
          const cdp = await page.context().newCDPSession(page);
          await cdp.send("Emulation.setCPUThrottlingRate", { rate });
          let result;
          try {
            result = await page.evaluate(
              ([where, name]) => window.mermaidProbe(where, name),
              [where, name],
            );
          } catch (error) {
            result = { error: String(error).slice(0, 200) };
          }
          const rounded = Object.fromEntries(
            Object.entries(result).map(([key, value]) => [
              key,
              typeof value === "number" ? Math.round(value) : value,
            ]),
          );
          console.log(JSON.stringify({ rate, where, name, repeat, ...rounded }));
          await page.close();
        }
      }
    }
  }
} finally {
  await browser.close();
}
