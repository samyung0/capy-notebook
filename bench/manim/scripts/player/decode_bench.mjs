// Decode CMV films in JavaScript (Node's V8, as Chrome runs it) and time it: per second of film,
// the worst second, and memory. Video segments are only sliced here (film.html decodes them with
// WebCodecs). zstd by fzstd (pure JS, what a page without a zstd
// wasm would use) and by Node's built-in zstd (native, the floor a wasm zstd approaches).
// usage: node decode_bench.mjs <fzstd esm path> <file.cmv>… [--dump-grid out.bin]
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { Reader } from "./cmv.mjs";

const args = process.argv.slice(2);
const fzstd = await import(args.shift());
const dumpAt = args.indexOf("--dump-grid");
const dump = dumpAt >= 0 ? args.splice(dumpAt, 2)[1] : null;

function run(bytes, decompress, keepGrid) {
  const reader = new Reader(bytes, decompress);
  const seconds = reader.meta.frames / reader.meta.fps;
  let frames = 0, uploads = 0, worst = 0, bases = 0, firstMesh = null;
  const sink = {
    frame: () => frames++,
    path: () => uploads++, points: () => uploads++, rows: () => uploads++, texture: () => uploads++, grow: () => uploads++,
    mesh: (kid, p) => { uploads++; if (keepGrid && !firstMesh) firstMesh = p; },
  };
  const t0 = performance.now();
  for (let c = 0; c < reader.chunks.length; c++) {
    const t = performance.now();
    reader.chunk(c, sink);
    worst = Math.max(worst, performance.now() - t);
    let held = 0;
    for (const q of reader.arrays.values()) held += q.a.byteLength;
    bases = Math.max(bases, held);
  }
  const total = performance.now() - t0;
  return { form: reader.meta.form, seconds, total, worst, frames, uploads, bases, resident: reader.resident, firstMesh };
}

for (const file of args) {
  const bytes = new Uint8Array(readFileSync(file));
  const js = run(bytes, (b) => fzstd.decompress(b.slice()), !!dump); // fzstd misreads a subarray: hand it a copy
  if (dump && js.firstMesh) writeFileSync(dump, Buffer.from(js.firstMesh.buffer));
  const heap = process.memoryUsage();
  const native = run(bytes, (b) => new Uint8Array(zstdDecompressSync(b)), false);
  console.log(JSON.stringify({
    cmv: basename(file), form: js.form, MB: +(bytes.length / 1e6).toFixed(3), seconds: +js.seconds.toFixed(1), frames: js.frames, uploads: js.uploads,
    fzstd_ms_per_video_s: +(js.total / js.seconds).toFixed(1), fzstd_worst_chunk_ms: +js.worst.toFixed(1),
    native_zstd_ms_per_video_s: +(native.total / native.seconds).toFixed(1), native_worst_chunk_ms: +native.worst.toFixed(1),
    decoded_uploads_MB: +(js.resident / 1e6).toFixed(1), peak_bases_MB: +(js.bases / 1e6).toFixed(1), heap_used_MB: +(heap.heapUsed / 1e6).toFixed(0), rss_MB: +(heap.rss / 1e6).toFixed(0),
  }));
}
