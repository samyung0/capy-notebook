// How compressible are the charged values? (gzip -6 and brotli q5 as proxies)
import { readFile } from 'node:fs/promises';
import { gzipSync, brotliCompressSync, constants } from 'node:zlib';
import { office, formatOf } from './lib.mjs';
for (const path of process.argv.slice(2)) {
  const format = formatOf(path);
  const bytes = new Uint8Array(await readFile(path));
  const seed = await office.seedOffice(format, bytes);
  const baseline = Buffer.from(JSON.stringify({ entries: await office.officeBaseline(bytes, seed), format, version: 1 }));
  const state = Buffer.from(seed.state);
  const gz = (b) => gzipSync(b, { level: 6 }).length;
  const br = (b) => brotliCompressSync(b, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } }).length;
  console.log(JSON.stringify({ file: path.split('/').pop(), source: bytes.length, state: state.length, stateGzip: gz(state), stateBrotli5: br(state), baseline: baseline.length, baselineGzip: gz(baseline), baselineBrotli5: br(baseline), chargedNow: bytes.length + state.length + baseline.length, chargedIfGzip: bytes.length + gz(state) + gz(baseline) }));
}
