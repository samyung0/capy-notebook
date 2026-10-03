// The smallest S3 the Go server and the collaboration service need for an
// Office room in the collaboration stress test: path-style objects in memory,
// no signature checks. The e2e stack's memory blob store hands out memory://
// URLs the collaboration service cannot fetch, so the stress overlay
// (docker-compose.stress.yml) points the server's B2 client here instead.
// HTTPS on 9443 with the certificate stress.ts makes (the server only takes
// https://*.backblazeb2.com endpoints), plain HTTP on 9000 for the health
// check. Runs in the collaboration image (plain Node, no dependencies).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createTlsServer } from 'node:https';

const objects = new Map(); // "bucket/key" -> { data, type, etag, modified }

function xml(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/xml' });
  res.end(`<?xml version="1.0" encoding="UTF-8"?>${body}`);
}

function escape(value) {
  return value.replace(/[<>&'"]/g, (c) => `&#${c.charCodeAt(0)};`);
}

// aws-chunked bodies: "<hex>[;ext]\r\n<data>\r\n" ... "0[;ext]\r\n[trailers]\r\n"
function decodeChunked(buffer) {
  const parts = [];
  let at = 0;
  for (;;) {
    const lineEnd = buffer.indexOf('\r\n', at);
    if (lineEnd < 0) break;
    const size = Number.parseInt(
      buffer.subarray(at, lineEnd).toString().split(';')[0],
      16
    );
    if (!size) break;
    parts.push(buffer.subarray(lineEnd + 2, lineEnd + 2 + size));
    at = lineEnd + 2 + size + 2;
  }
  return Buffer.concat(parts);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function put(id, data, type) {
  const etag = `"${createHash('md5').update(data).digest('hex')}"`;
  objects.set(id, { data, etag, modified: new Date(), type });
  return etag;
}

async function handle(req, res) {
  try {
    const url = new URL(req.url, 'http://s3');
    const [bucket, ...rest] = url.pathname.slice(1).split('/');
    const key = decodeURIComponent(rest.join('/'));
    const id = `${bucket}/${key}`;
    if (!key) {
      if (req.method === 'HEAD') return res.writeHead(200).end();
      if (req.method === 'POST' && url.searchParams.has('delete')) {
        const body = (await readBody(req)).toString();
        for (const [, name] of body.matchAll(/<Key>([^<]*)<\/Key>/g))
          objects.delete(`${bucket}/${name}`);
        return xml(res, 200, '<DeleteResult/>');
      }
      if (req.method === 'GET') {
        const prefix = url.searchParams.get('prefix') ?? '';
        const keys = [...objects.keys()]
          .filter((name) => name.startsWith(`${bucket}/${prefix}`))
          .map((name) => name.slice(bucket.length + 1))
          .sort();
        const contents = keys
          .map((name) => {
            const object = objects.get(`${bucket}/${name}`);
            return `<Contents><Key>${escape(name)}</Key><Size>${object.data.length}</Size><ETag>${escape(object.etag)}</ETag><LastModified>${object.modified.toISOString()}</LastModified></Contents>`;
          })
          .join('');
        return xml(
          res,
          200,
          `<ListBucketResult><Name>${bucket}</Name><Prefix>${escape(prefix)}</Prefix><KeyCount>${keys.length}</KeyCount><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`
        );
      }
    }
    if (req.method === 'PUT') {
      const source = req.headers['x-amz-copy-source'];
      if (source) {
        const from = objects.get(decodeURIComponent(String(source)).replace(/^\//, ''));
        if (!from) return xml(res, 404, '<Error><Code>NoSuchKey</Code></Error>');
        const etag = put(id, from.data, from.type);
        return xml(
          res,
          200,
          `<CopyObjectResult><ETag>${escape(etag)}</ETag><LastModified>${new Date().toISOString()}</LastModified></CopyObjectResult>`
        );
      }
      const raw = await readBody(req);
      const chunked =
        String(req.headers['content-encoding'] ?? '').includes('aws-chunked') ||
        String(req.headers['x-amz-content-sha256'] ?? '').startsWith('STREAMING-');
      const etag = put(
        id,
        chunked ? decodeChunked(raw) : raw,
        String(req.headers['content-type'] ?? 'application/octet-stream')
      );
      res.writeHead(200, { ETag: etag });
      return res.end();
    }
    if (req.method === 'DELETE') {
      objects.delete(id);
      return res.writeHead(204).end();
    }
    const object = objects.get(id);
    if (!object) {
      if (req.method === 'HEAD') return res.writeHead(404).end();
      return xml(res, 404, '<Error><Code>NoSuchKey</Code></Error>');
    }
    const headers = {
      'Content-Type': object.type,
      ETag: object.etag,
      'Last-Modified': object.modified.toUTCString(),
    };
    const range = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range ?? ''));
    let data = object.data;
    let status = 200;
    if (range) {
      const start = Number(range[1]);
      const end = range[2] ? Math.min(Number(range[2]), data.length - 1) : data.length - 1;
      headers['Content-Range'] = `bytes ${start}-${end}/${data.length}`;
      data = data.subarray(start, end + 1);
      status = 206;
    }
    headers['Content-Length'] = String(data.length);
    res.writeHead(status, headers);
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch (error) {
    console.error('fake-s3', error);
    xml(res, 500, '<Error><Code>InternalError</Code></Error>');
  }
}

createServer(handle).listen(9000);
createTlsServer(
  {
    cert: readFileSync('/stress/tls/cert.pem'),
    key: readFileSync('/stress/tls/key.pem'),
  },
  handle
).listen(9443, () => console.log('fake-s3 listening on 9000 and 9443'));
