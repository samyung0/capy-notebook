// A ledger of what ManimGX's player asks WebGPU for while a film plays: every buffer and texture
// its engine frame makes (by label, with its size), when the page lets go of them (the engine
// never calls destroy(): a resource goes only when the garbage collector takes its wrapper), the
// bytes it writes, the take it is fed (by array kind) and its WebAssembly memory. Opens one film
// in the app's file viewer (dev server with mocks) as film_memory_dump.mjs does, plays it, prints
// a line a second and a summary, then runs the collector and prints what is left. DUMP=1 adds
// Chrome's memory-infra dump before and after the collection.
// usage: node film_gpu_ledger.mjs <playwright module path> <base url> <seconds> <film path>
// (SCALE=2 for a 2x screen; WIDTH=n for the window's width in CSS pixels)
import { statSync } from "node:fs";
import path from "node:path";

const [pw, base, secondsArg, filmArg] = process.argv.slice(2);
const filmPath = path.resolve(filmArg);
const MB = (b) => (b / 2 ** 20).toFixed(1);
const filmUrl = `/${path.relative(process.cwd(), filmPath)}`;
const { chromium } = await import(pw);
const browser = await chromium.launch({
  args: ["--enable-unsafe-webgpu", "--js-flags=--expose-gc"],
  channel: "chrome",
});
const context = await browser.newContext({
  deviceScaleFactor: Number(process.env.SCALE ?? 1),
  viewport: { height: 900, width: Number(process.env.WIDTH ?? 1400) },
});

// Runs in every frame; keeps the ledger only in the engine's.
await context.addInitScript(() => {
  if (!location.pathname.endsWith("/films/engine-frame.html")) return;
  const BPP = {
    "bgra8unorm": 4, "depth24plus": 4, "depth24plus-stencil8": 4, "depth32float": 4,
    "depth32float-stencil8": 8, "r16float": 2, "r32float": 4, "r8unorm": 1, "rg16float": 4,
    "rg32float": 8, "rgba16float": 8, "rgba32float": 16, "rgba8uint": 4, "rgba8unorm": 4,
    "rgba8unorm-srgb": 4,
  };
  const L = {
    collected: { buffer: 0, texture: 0 }, collectedBytes: { buffer: 0, texture: 0 },
    configure: [], fed: { arrays: {}, messages: {} }, draws: 0, live: new Map(), log: [], made: {}, nextId: 1,
    memory: null, writeBuffer: { bytes: 0, calls: 0 }, writeTexture: { bytes: 0, calls: 0 },
  };
  window.__ledger = L;
  const gone = new FinalizationRegistry((id) => {
    const r = L.live.get(id);
    if (!r) return;
    L.live.delete(id);
    L.collected[r.kind]++;
    L.collectedBytes[r.kind] += r.bytes;
  });
  const keep = (object, kind, label, bytes, extra) => {
    const id = L.nextId++;
    L.live.set(id, { bytes, kind, label, t: performance.now(), ...extra });
    const m = (L.made[`${kind}:${label}`] ??= { bytes: 0, count: 0 });
    m.count++;
    m.bytes += bytes;
    gone.register(object, id);
    if (label !== "image" && bytes >= 1 << 20) L.log.push({ bytes, id, label, t: Math.round(performance.now()) });
    return object;
  };
  const dims = (size) =>
    Array.isArray(size) || size[Symbol.iterator]
      ? [...size].concat([1, 1, 1]).slice(0, 3)
      : [size.width, size.height ?? 1, size.depthOrArrayLayers ?? 1];
  const D = GPUDevice.prototype;
  const createBuffer = D.createBuffer;
  D.createBuffer = function (desc) {
    return keep(createBuffer.call(this, desc), "buffer", desc.label || "(none)", Number(desc.size), { usage: desc.usage });
  };
  const createTexture = D.createTexture;
  D.createTexture = function (desc) {
    const [w, h, d] = dims(desc.size);
    const samples = desc.sampleCount ?? 1;
    let bytes = 0;
    for (let l = 0; l < (desc.mipLevelCount ?? 1); l++)
      bytes += Math.max(1, w >> l) * Math.max(1, h >> l) * d;
    bytes *= (BPP[desc.format] ?? 4) * samples;
    return keep(createTexture.call(this, desc), "texture", desc.label || `(none) ${desc.format}${samples > 1 ? ` x${samples}` : ""}`, bytes, { d, format: desc.format, h, samples, w });
  };
  const Q = GPUQueue.prototype;
  const writeBuffer = Q.writeBuffer;
  Q.writeBuffer = function (buffer, offset, data, dataOffset, size) {
    L.writeBuffer.calls++;
    L.writeBuffer.bytes += size ?? (data.byteLength - (dataOffset ?? 0) * (data.BYTES_PER_ELEMENT ?? 1));
    return writeBuffer.apply(this, arguments);
  };
  const writeTexture = Q.writeTexture;
  Q.writeTexture = function (dest, data) {
    L.writeTexture.calls++;
    L.writeTexture.bytes += data.byteLength;
    return writeTexture.apply(this, arguments);
  };
  const configure = GPUCanvasContext.prototype.configure;
  GPUCanvasContext.prototype.configure = function (config) {
    L.configure.push({ alphaMode: config.alphaMode, format: config.format, height: this.canvas.height, usage: config.usage, width: this.canvas.width });
    return configure.call(this, config);
  };
  // the engine's WebAssembly memory
  for (const name of ["instantiate", "instantiateStreaming"]) {
    const f = WebAssembly[name];
    WebAssembly[name] = async function () {
      const result = await f.apply(this, arguments);
      const exports = (result.instance ?? result).exports;
      if (exports?.memory) L.memory = exports.memory;
      return result;
    };
  }
  // the take it is fed: messages by op, ARRAY blobs by kind (take.ts's numbers)
  const KINDS = ["MeshPoints", "MeshUvs", "MeshNormals", "MeshTriangles", "PathPoints", "PathSubpaths", "Points", "Rows", "Texture", "Records"];
  const OPS = { 1: "PATH", 2: "POINTS", 3: "MESH", 4: "ROWS", 5: "TEXTURE", 6: "GROW", 8: "FRAME", 9: "NOTE", 10: "SOUND", 11: "ARRAY", 12: "END", 13: "ENVIRONMENT", 14: "START" };
  let pending = new Uint8Array(0);
  const tally = (bytes) => {
    const all = new Uint8Array(pending.length + bytes.length);
    all.set(pending);
    all.set(bytes, pending.length);
    const v = new DataView(all.buffer);
    let at = 0;
    while (at + 4 <= all.length) {
      const n = v.getUint32(at, true);
      if (at + 4 + n > all.length) break;
      const op = OPS[all[at + 4]] ?? all[at + 4];
      const m = (L.fed.messages[op] ??= { bytes: 0, count: 0 });
      m.count++;
      m.bytes += n + 4;
      if (op === "ARRAY") {
        const kind = KINDS[all[at + 4 + 1 + 16]];
        const blob = v.getUint32(at + 4 + 1 + 18, true);
        const a = (L.fed.arrays[kind] ??= { bytes: 0, count: 0 });
        a.count++;
        a.bytes += blob;
      }
      at += 4 + n;
    }
    pending = all.slice(at);
  };
  let engine;
  Object.defineProperty(window, "engine", {
    configurable: true,
    get: () => engine,
    set: (promise) => {
      engine = promise.then((e) => {
        const feed = e.Player.prototype.feed;
        e.Player.prototype.feed = function (bytes) {
          tally(bytes);
          return feed.call(this, bytes);
        };
        const draw = e.Player.prototype.draw;
        e.Player.prototype.draw = function () {
          L.draws++;
          return draw.call(this);
        };
        return e;
      });
    },
  });
  window.__ledgerNow = () => {
    const byLabel = {};
    let buffers = 0;
    let textures = 0;
    for (const r of L.live.values()) {
      const k = `${r.kind}:${r.label}`;
      const b = (byLabel[k] ??= { bytes: 0, count: 0 });
      b.count++;
      b.bytes += r.bytes;
      if (r.kind === "buffer") buffers += r.bytes;
      else textures += r.bytes;
    }
    return {
      buffers, byLabel, collected: L.collected, log: L.log.map((r) => ({ ...r, live: L.live.has(r.id) })), collectedBytes: L.collectedBytes,
      configure: L.configure, fed: L.fed, made: L.made, textures,
      wasm: L.memory ? L.memory.buffer.byteLength : 0,
      draws: L.draws, writeBuffer: L.writeBuffer, writeTexture: L.writeTexture,
    };
  };
});

const page = await context.newPage();
await page.goto(`${base}/workspaces/ws_bio`);
await page.waitForTimeout(3000);
await page.evaluate(
  async ({ size, url }) => {
    const handlers = await (await fetch("/src/mocks/handlers.ts")).text();
    const db = await import(handlers.match(/["'](\/src\/mocks\/db\.ts[^"']*)["']/)[1]);
    db.fileLinks.f_bench_ledger = { url };
    db.files.push({
      addedAt: new Date().toISOString(), hasBytes: true, id: "f_bench_ledger", indexed: false,
      isPayer: true, kind: "film", name: "ledger.cmv", position: 90, revision: 1, sizeBytes: size,
      status: "ready", topicId: null, workspaceId: "ws_bio",
    });
  },
  { size: statSync(filmPath).size, url: filmUrl }
);
if (process.env.BASELINE) {
  console.log("before the film");
  await dumpNow();
}
await page.evaluate(() => {
  history.pushState({}, "", "/workspaces/ws_bio?file=f_bench_ledger");
  dispatchEvent(new PopStateEvent("popstate"));
});
await page.locator("[role=application]").waitFor({ timeout: 60_000 });
const engineFrame = () => page.frames().find((f) => f.url().includes("/films/engine-frame.html"));
const now = () => engineFrame().evaluate(() => window.__ledgerNow());
const time = () => page.locator("[role=application]").evaluate(() => 0);
await page.waitForTimeout(3000);
const canvas = await page.locator("[role=application] canvas").first().evaluate((c) => [c.width, c.height, c.clientWidth, c.clientHeight]).catch(() => null);
console.log(`canvas ${JSON.stringify(canvas)}`);
let s = await now();
console.log(`loaded: buffers ${MB(s.buffers)} MB, textures ${MB(s.textures)} MB, wasm ${MB(s.wasm)} MB, fed ${JSON.stringify(s.fed.messages)}`);
await page.locator("[role=application]").press("k");
const t0 = Date.now();
let peak = { buffers: 0, textures: 0, wasm: 0 };
for (let i = 1; i <= Number(secondsArg); i++) {
  await page.waitForTimeout(t0 + i * 1000 - Date.now());
  s = await now();
  peak = { buffers: Math.max(peak.buffers, s.buffers), textures: Math.max(peak.textures, s.textures), wasm: Math.max(peak.wasm, s.wasm) };
  const image = s.byLabel["texture:image"] ?? { bytes: 0, count: 0 };
  console.log(
    `${String(i).padStart(3)} s  live buffers ${MB(s.buffers).padStart(7)} MB  textures ${MB(s.textures).padStart(7)} MB (image ${image.count} = ${MB(image.bytes)} MB)  collected b/t ${s.collected.buffer}/${s.collected.texture}  wasm ${MB(s.wasm)} MB  draws ${s.draws}  writeBuffer ${MB(s.writeBuffer.bytes)} MB  writeTexture ${MB(s.writeTexture.bytes)} MB`
  );
}

const show = (title, s) => {
  console.log(`\n${title}: live buffers ${MB(s.buffers)} MB, textures ${MB(s.textures)} MB, wasm ${MB(s.wasm)} MB`);
  for (const [k, v] of Object.entries(s.byLabel).sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 25))
    console.log(`  ${MB(v.bytes).padStart(8)} MB  ${String(v.count).padStart(5)}  ${k}`);
};
const dump = async () => {
  if (process.env.DUMP) await dumpNow();
};
async function dumpNow() {
  const cdp = await browser.newBrowserCDPSession();
  const events = [];
  cdp.on("Tracing.dataCollected", ({ value }) => events.push(...value));
  const done = new Promise((resolve) => cdp.once("Tracing.tracingComplete", resolve));
  await cdp.send("Tracing.start", {
    traceConfig: { includedCategories: ["disabled-by-default-memory-infra"], memoryDumpConfig: { triggers: [] }, recordMode: "recordAsMuchAsPossible" },
    transferMode: "ReportEvents",
  });
  await cdp.send("Tracing.requestMemoryDump", { levelOfDetail: "detailed" });
  await cdp.send("Tracing.end");
  await done;
  await cdp.detach();
  const names = {};
  for (const e of events) if (e.ph === "M" && e.name === "process_name") names[e.pid] = e.args.name;
  const hex = (h) => Number.parseInt(h, 16);
  for (const e of events.filter((x) => x.ph === "v" && x.args?.dumps)) {
    const { allocators = {} } = e.args.dumps;
    const rows = Object.entries(allocators)
      .filter(([key]) => key.split("/").length <= Number(process.env.DEPTH ?? 3))
      .filter(([key]) => !process.env.MATCH || new RegExp(process.env.MATCH).test(key))
      .map(([key, a]) => [key, a.attrs?.size ? hex(a.attrs.size.value) : 0])
      .filter(([, b]) => b >= 8 * 2 ** 20)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12);
    if (!rows.length) continue;
    console.log(`  ${names[e.pid] ?? e.pid}`);
    for (const [key, b] of rows) console.log(`    ${MB(b).padStart(8)} MB  ${key}`);
  }
}
show("after playing", s);
console.log(`  peak live: buffers ${MB(peak.buffers)} MB, textures ${MB(peak.textures)} MB, wasm ${MB(peak.wasm)} MB`);
console.log("  made in all:");
for (const [k, v] of Object.entries(s.made).sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 15))
  console.log(`  ${MB(v.bytes).padStart(8)} MB  ${String(v.count).padStart(5)}  ${k}`);
console.log(`  fed messages: ${JSON.stringify(s.fed.messages)}`);
console.log(`  fed arrays: ${JSON.stringify(s.fed.arrays)}`);
console.log(`  canvas configure: ${JSON.stringify(s.configure)}`);
console.log("  resources of 1 MB or more but images, as made (ms, MB, live now):");
for (const r of s.log) console.log(`    ${String(r.t).padStart(7)}  ${MB(r.bytes).padStart(7)}  ${r.live ? "live" : "    "}  ${r.label}`);
await dump();
// collect in every frame, twice, and let the finalizers run
for (let i = 0; i < 2; i++) {
  for (const f of page.frames()) await f.evaluate(() => globalThis.gc?.()).catch(() => undefined);
  await page.waitForTimeout(1500);
}
show("after the collector", await now());
await dump();
await browser.close();
