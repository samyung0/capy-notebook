// a hand written scalar server to avoid calling any remote servers/registry
// completely offline based solely on the openapi.yaml

import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const openApiPath = path.join(projectRoot, 'openapi.yaml');
const scalarPackageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.resolve('@scalar/api-reference'))),
  '..'
);
const [scalarScript, scalarStyles] = await Promise.all([
  readFile(path.join(scalarPackageRoot, 'dist/browser/standalone.js')),
  readFile(path.join(scalarPackageRoot, 'dist/style.css')),
]);

const configuredPort = Number.parseInt(
  process.env.OPENAPI_DOCS_PORT ?? '3000',
  10
);
const port =
  Number.isInteger(configuredPort) && configuredPort > 0
    ? configuredPort
    : 3000;
const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Capy Notebook API Reference</title>
    <link rel="stylesheet" href="/scalar.css" />
  </head>
  <body>
    <div id="app"></div>
    <script src="/scalar.js"></script>
    <script>
      window.Scalar.createApiReference('#app', { url: '/openapi.yaml' });
    </script>
  </body>
</html>`;

function send(response, statusCode, contentType, body) {
  response.writeHead(statusCode, { 'Content-Type': contentType });
  response.end(body);
}

const server = createServer(async (request, response) => {
  if (request.method !== 'GET') {
    send(response, 405, 'text/plain; charset=utf-8', 'Method Not Allowed');
    return;
  }

  const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
  if (pathname === '/') {
    send(response, 200, 'text/html; charset=utf-8', html);
    return;
  }
  if (pathname === '/scalar.js') {
    send(response, 200, 'application/javascript; charset=utf-8', scalarScript);
    return;
  }
  if (pathname === '/scalar.css') {
    send(response, 200, 'text/css; charset=utf-8', scalarStyles);
    return;
  }
  if (pathname === '/openapi.yaml') {
    try {
      const openApi = await readFile(openApiPath);
      send(response, 200, 'text/yaml; charset=utf-8', openApi);
    } catch (error) {
      console.error(error);
      send(
        response,
        500,
        'text/plain; charset=utf-8',
        'Could not read openapi.yaml'
      );
    }
    return;
  }

  send(response, 404, 'text/plain; charset=utf-8', 'Not Found');
});

server.listen(port, '127.0.0.1', () => {
  // biome-ignore lint: no-console
  console.log(`Scalar API Reference: http://localhost:${port}`);
});
