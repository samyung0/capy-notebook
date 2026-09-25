// Size and CPU of storing a value compressed in the service: gzip-6, brotli-5,
// zstd-3, and for Yjs states the update-v2 encoding (with and without gzip).
// Usage: node encodings.mjs <dumpsDir>
import { readdir, readFile, stat } from 'node:fs/promises';
import * as zlib from 'node:zlib';
import { Y } from '../storage/lib.mjs';

const dir = process.argv[2];
const time = (fn) => {
  const t = performance.now();
  const out = fn();
  return [out, +(performance.now() - t).toFixed(1)];
};
const gz = (b) => zlib.gzipSync(b, { level: 6 });
const br = (b) => zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } });
const zs = zlib.zstdCompressSync ? (b) => zlib.zstdCompressSync(b, { params: { [zlib.constants.ZSTD_c_compressionLevel]: 3 } }) : null;

const targets = [];
for (const name of await readdir(dir)) {
  const sub = `${dir}/${name}`;
  if (!(await stat(sub)).isDirectory()) continue;
  for (const kind of await readdir(sub)) targets.push([name, kind, `${sub}/${kind}`]);
}
for (const [name, kind, path] of targets.sort()) {
  if (kind.startsWith('effects-')) continue;
  const bytes = await readFile(path);
  const row = { name, kind, logical: bytes.length };
  const [g, tg] = time(() => gz(bytes));
  const [, tgu] = time(() => zlib.gunzipSync(g));
  Object.assign(row, { gzip: g.length, gzipMs: tg, gunzipMs: tgu, brotli5: br(bytes).length });
  if (zs) {
    const [z, tz] = time(() => zs(bytes));
    const [, tzu] = time(() => zlib.zstdDecompressSync(z));
    Object.assign(row, { zstd3: z.length, zstdMs: tz, unzstdMs: tzu });
  }
  if (kind.endsWith('.bin')) {
    const [v2, tv2] = time(() => Y.convertUpdateFormatV1ToV2(bytes));
    const [, tv1] = time(() => Y.convertUpdateFormatV2ToV1(v2));
    Object.assign(row, { v2: v2.length, v2Gzip: gz(v2).length, toV2Ms: tv2, toV1Ms: tv1 });
  }
  console.log(JSON.stringify(row));
}
