import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";

const base = process.env.EXPORT_PROBE_URL || "http://127.0.0.1:5200";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.on("pageerror", (error) => console.error("Browser:", error.message));
const results = [];
try {
  await page.goto(`${base}/bench/editor/scripts/export-probe.html`);
  await page.waitForFunction(
    () => typeof window.exportProbe === "function",
    {},
    { timeout: 120000 },
  );
  const cdp = await page.context().newCDPSession(page);
  for (const rate of [1, 4]) {
    await cdp.send("Emulation.setCPUThrottlingRate", { rate });
    for (const format of ["markdown", "docx"]) {
      for (const offload of process.env.EXPORT_WORKER_CONDITION === "1"
        ? [true]
        : [false, true]) {
        for (const [name, count, textLength] of [
          ["warmup", 20, 80],
          ["medium", 500, 180],
          ["near-node-limit", 4900, 120],
          ["near-byte-limit", 2000, 930],
        ]) {
          for (let repeat = 0; repeat < (name === "warmup" ? 1 : 3); repeat++) {
            const input = { count, textLength, format };
            try {
              const result = await page.evaluate(
                async ({ input, offload }) =>
                  window.exportProbe(input, offload),
                { input, offload },
              );
              results.push({ rate, format, offload, name, repeat, ...result });
              console.log(JSON.stringify(results.at(-1)));
            } catch (error) {
              results.push({
                rate,
                format,
                offload,
                name,
                error: error.message,
              });
              console.log(JSON.stringify(results.at(-1)));
              break;
            }
          }
        }
      }
    }
  }
  for (const offload of [false, true]) {
    try {
      results.push({
        name: "embedded-png",
        offload,
        ...(await page.evaluate(
          async (offload) =>
            window.exportProbe(
              { count: 2, textLength: 80, format: "docx", image: true },
              offload,
            ),
          offload,
        )),
      });
    } catch (error) {
      results.push({ name: "embedded-png", offload, error: error.message });
    }
  }
} finally {
  await mkdir("bench/editor/.results/export-2026-09-27", { recursive: true });
  const name =
    process.env.EXPORT_WORKER_CONDITION === "1"
      ? "worker-condition"
      : "results";
  await writeFile(
    `bench/editor/.results/export-2026-09-27/${name}.json`,
    JSON.stringify(
      {
        date: new Date().toISOString(),
        cpu: os.cpus()[0].model,
        browser: browser.version(),
        results,
      },
      null,
      2,
    ),
  );
  await browser.close();
}
