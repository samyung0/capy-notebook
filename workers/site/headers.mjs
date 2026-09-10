import { access, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const [directory, appOrigin] = process.argv.slice(2);
if (!directory || !appOrigin) {
  throw new Error(
    'Usage: node workers/site/headers.mjs <built dist> <HTTPS app origin>'
  );
}
const app = new URL(appOrigin);
if (
  app.protocol !== 'https:' ||
  app.origin !== appOrigin ||
  app.hostname.includes('*')
) {
  throw new Error('App origin must be an exact HTTPS origin');
}
await access(resolve(directory, 'llm-runtime.html'));
const headers = await readFile(
  new URL('../../public/_headers', import.meta.url),
  'utf8'
);
await writeFile(
  resolve(directory, '_headers'),
  headers.replace(
    /Content-Security-Policy: frame-ancestors[^\r\n]*/,
    () => `Content-Security-Policy: frame-ancestors 'self' ${appOrigin}`
  )
);
