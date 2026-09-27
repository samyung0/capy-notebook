import { build, preview } from "vite";
import path from "node:path";
const client = process.env.EXPORT_CLIENT === "1";
const outDir = client ? "bench/editor/.results/export-client-bundle" : "bench/editor/.results/export-bundle";
await build({
  configFile: false,
  root: process.cwd(),
  resolve: {
    alias: { "@": path.resolve("src"), "@paraglide": path.resolve("src/i18n/paraglide") },
    ...(process.env.EXPORT_WORKER_CONDITION === "1"
      ? { conditions: ["worker", "module", "browser", "production"] }
      : {}),
  },
  worker: { format: "es" },
  build: {
    outDir,
    emptyOutDir: true,
    rollupOptions: {
      input: path.resolve(`bench/editor/scripts/export-${client ? 'client' : 'probe'}.html`),
    },
  },
});
await preview({
  configFile: false,
  build: { outDir },
  preview: { host: "127.0.0.1", port: 5200, strictPort: true },
});
console.log("Export probe at http://127.0.0.1:5200");
