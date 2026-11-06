import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";
import "../../../e2e/i18n/compile";

/**
 * The drawing board's harness. Run with: pnpm bench:canvas
 *
 * Like the Office harness this measures a production build (minified, React
 * production mode), here without MSW: the board calls no API. The board's route
 * (/dev/drawing) is in that build only because the bench sets VITE_BENCH_ROUTES
 * (src/router.ts, vite.config.ts); a deploy pins it off (scripts/env/config.py).
 * `vite preview` serves the build. The build takes a few minutes.
 *
 * Environment knobs:
 * - PERF_CANVAS_PORT  preview port (default 4520).
 */

const perfDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(perfDir, "..", "..", "..");
const port = Number(process.env.PERF_CANVAS_PORT ?? 4520);
// board.canvas.ts reads the chunks' bytes from here.
const outDir = path.join(perfDir, "..", ".results", "canvas-dist");

export default defineConfig({
  fullyParallel: false,
  projects: [
    { name: "chromium-canvas", use: { ...devices["Desktop Chrome"] } },
  ],
  reporter: [["list"]],
  retries: 0,
  testDir: perfDir,
  testMatch: "**/*.canvas.ts",
  timeout: 1_200_000,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    screenshot: "off",
    trace: "off",
    video: "off",
  },
  webServer: {
    // The heap flag is the one `pnpm build` uses. One build, then its preview,
    // which stops with the command.
    command: `node --max-old-space-size=8192 node_modules/vite/bin/vite.js build --outDir ${outDir} --emptyOutDir && node node_modules/vite/bin/vite.js preview --outDir ${outDir} --host 127.0.0.1 --port ${port} --strictPort`,
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: "production",
      VITE_BENCH_ROUTES: "true",
      VITE_CLERK_PUBLISHABLE_KEY: "",
      VITE_USE_MSW: "false",
    },
    reuseExistingServer: false,
    timeout: 1_200_000,
    url: `http://127.0.0.1:${port}`,
  },
  workers: 1,
});
