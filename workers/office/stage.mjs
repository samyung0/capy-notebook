import { access, cp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

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
