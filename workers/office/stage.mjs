import {
  access,
  cp,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { brotliCompress, constants } from 'node:zlib';

const [source, target] = process.argv.slice(2);
if (!source || !target || resolve(source) === resolve(target)) {
  throw new Error(
    'Usage: node workers/office/stage.mjs <built dist> <new output directory>'
  );
}
await access(resolve(source, 'office-runtime.html'));
await access(resolve(source, 'assets'));
// A new destination cannot inherit SPA HTML, _headers or _redirects.
await mkdir(target);
await cp(
  resolve(source, 'office-runtime.html'),
  resolve(target, 'office-runtime.html')
);
await cp(resolve(source, 'assets'), resolve(target, 'assets'), {
  recursive: true,
});
await cp(new URL('./_headers', import.meta.url), resolve(target, '_headers'));

// WASM and uncompressed fonts become `<name>.br` at brotli's maximum quality,
// which the Worker sends as `Content-Encoding: br` (the static layer would
// compress them on the fly at a low quality). The original is removed, so
// only the Worker answers for it. Keep the list in step with PRECOMPRESSED in
// index.ts and run_worker_first. Each file is logged with its sizes.
const PRECOMPRESSED = /\.(wasm|ttf|otf)$/;
const compress = promisify(brotliCompress);
const assets = resolve(target, 'assets');
await Promise.all(
  (await readdir(assets, { recursive: true }))
    .filter((name) => PRECOMPRESSED.test(name))
    .map(async (name) => {
      const file = resolve(assets, name);
      const bytes = await readFile(file);
      const packed = await compress(bytes, {
        params: {
          [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
          [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
        },
      });
      await writeFile(`${file}.br`, packed);
      await rm(file);
      process.stdout.write(
        `${name}: ${bytes.length} -> ${packed.length} bytes (br)\n`
      );
    })
);
