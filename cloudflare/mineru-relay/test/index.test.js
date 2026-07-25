import assert from 'node:assert/strict';
import test from 'node:test';

import worker from '../src/index.js';

const env = {
  B2_HOST: 's3.us-west-004.backblazeb2.com',
  MAX_BYTES: '10485760',
  MINERU_UPLOAD_HOSTS: '.aliyuncs.com',
  RELAY_TIMEOUT_MS: '5000',
  RELAY_TOKEN: 'secret',
};

const request = (body, token = 'secret') =>
  new Request('https://relay.example/upload', {
    body: JSON.stringify(body),
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    method: 'POST',
  });

const validBody = {
  destinationUrl:
    'https://mineru-upload.oss-cn.example.aliyuncs.com/task?signature=y',
  maxBytes: 10 * 1024 * 1024,
  sourceUrl: 'https://s3.us-west-004.backblazeb2.com/bucket/source?signature=x',
};

test('rejects invalid credentials', async () => {
  const response = await worker.fetch(request(validBody, 'wrong'), env);
  assert.equal(response.status, 401);
});

test('rejects hosts outside both allowlists', async () => {
  const response = await worker.fetch(
    request({
      ...validBody,
      destinationUrl: 'https://attacker.example/upload',
    }),
    env
  );
  assert.equal(response.status, 403);
});

test('rejects an oversized B2 response before uploading', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(new Uint8Array(0), {
      headers: { 'content-length': String(11 * 1024 * 1024) },
      status: 200,
    });
  try {
    const response = await worker.fetch(request(validBody), env);
    assert.equal(response.status, 413);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('streams the B2 response into the signed destination', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ init, url: String(url) });
    if (calls.length === 1) {
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'content-length': '3' },
        status: 200,
      });
    }
    assert.equal(init.method, 'PUT');
    assert.ok(init.body instanceof ReadableStream);
    return new Response(null, { status: 200 });
  };
  try {
    const response = await worker.fetch(request(validBody), env);
    assert.equal(response.status, 200);
    assert.equal(calls.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('aborts a stalled source transfer at the configured timeout', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init = {}) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener(
        'abort',
        () => reject(new Error('aborted')),
        {
          once: true,
        }
      );
    });
  try {
    const response = await worker.fetch(request(validBody), {
      ...env,
      RELAY_TIMEOUT_MS: '1',
    });
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { message: 'relay timed out' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
