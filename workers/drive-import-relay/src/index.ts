interface Env {
  API_BASE_URL: string;
  IMPORT_DLQ_NAME: string;
  IMPORT_QUEUE: Queue<ImportQueueMessage>;
  IMPORT_RELAY_SECRET: string;
}

interface ImportQueueMessage {
  jobId: string;
}

type DownloadGrant =
  | { kind: 'bearer'; token: string; url: string }
  | { kind: 'url'; url: string };

type AcquireResponse =
  | { jobId: string; status: 'succeeded' }
  | {
      attemptToken: string;
      download?: DownloadGrant;
      jobId: string;
      maxBytes: number;
      resumeComplete: boolean;
      status: 'acquired';
    };

interface UploadGrant {
  expiresAt: string;
  headers: Record<string, string>;
  url: string;
}

class RelayFailure extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(
    code: string,
    retryable: boolean,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.code = code;
    this.name = 'RelayFailure';
    this.retryable = retryable;
  }
}

const encoder = new TextEncoder();
const HEX_SHA256 = /^[0-9a-f]{64}$/i;
const MAX_CONTROL_BODY = 64 * 1024;
const MAX_PROVIDER_REDIRECTS = 5;
const MAX_TRANSFER_BYTES = 30 * 1024 * 1024;
const RETRY_DELAY_SECONDS = 300;
const RUNNING_LEASE_RETRY_SECONDS = 300;
const TRAILING_SLASHES = /\/+$/;
const TRANSFER_BUDGET_MILLISECONDS = 10 * 60 * 1000;

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
    ''
  );
}

function hexToBytes(value: string): Uint8Array | null {
  if (!HEX_SHA256.test(value)) return null;
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function ownedBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  return owned;
}

async function sha256Hex(body: Uint8Array): Promise<string> {
  return bytesToHex(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', ownedBytes(body).buffer)
    )
  );
}

async function signature(
  secret: string,
  timestamp: string,
  method: string,
  requestPath: string,
  body: Uint8Array
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { hash: 'SHA-256', name: 'HMAC' },
    false,
    ['sign']
  );
  const canonical = [
    timestamp,
    method.toUpperCase(),
    requestPath,
    await sha256Hex(body),
  ].join('\n');
  return bytesToHex(
    new Uint8Array(
      await crypto.subtle.sign('HMAC', key, encoder.encode(canonical))
    )
  );
}

async function validSignature(
  request: Request,
  body: Uint8Array,
  secret: string
): Promise<boolean> {
  const timestamp = request.headers.get('X-Import-Relay-Timestamp') ?? '';
  const supplied = hexToBytes(
    request.headers.get('X-Import-Relay-Signature') ?? ''
  );
  const seconds = Number(timestamp);
  if (
    !supplied ||
    !Number.isSafeInteger(seconds) ||
    Math.abs(Date.now() / 1000 - seconds) > 300
  ) {
    return false;
  }
  const url = new URL(request.url);
  const expected = hexToBytes(
    await signature(
      secret,
      timestamp,
      request.method,
      `${url.pathname}${url.search}`,
      body
    )
  );
  if (!expected) return false;
  let different = 0;
  for (let index = 0; index < expected.length; index += 1) {
    different |= expected[index] ^ supplied[index];
  }
  return different === 0;
}

function isImportQueueMessage(value: unknown): value is ImportQueueMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'jobId' in value &&
    typeof value.jobId === 'string' &&
    value.jobId.length > 0
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseHTTPSURL(value: unknown, code: string): string {
  if (typeof value !== 'string') {
    throw new RelayFailure(code, true, 'relay URL missing');
  }
  if (!URL.canParse(value)) {
    throw new RelayFailure(code, true, 'relay URL invalid');
  }
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    throw new RelayFailure(code, false, 'relay URL must use HTTPS');
  }
  return value;
}

function relayAPIURL(base: string, path: string): URL {
  if (!URL.canParse(base)) {
    throw new RelayFailure('invalid_api_origin', true, 'API origin invalid');
  }
  const origin = new URL(base);
  if (
    origin.protocol !== 'https:' ||
    origin.username.length > 0 ||
    origin.password.length > 0
  ) {
    throw new RelayFailure(
      'invalid_api_origin',
      true,
      'API origin must use HTTPS'
    );
  }
  return new URL(path, `${base.replace(TRAILING_SLASHES, '')}/`);
}

function parseDownloadGrant(value: unknown): DownloadGrant {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    throw new RelayFailure(
      'invalid_acquire_grant',
      true,
      'download grant invalid'
    );
  }
  const url = parseHTTPSURL(value.url, 'invalid_acquire_grant');
  if (value.kind === 'url') return { kind: 'url', url };
  if (
    value.kind === 'bearer' &&
    typeof value.token === 'string' &&
    value.token.length > 0 &&
    new URL(url).hostname === 'www.googleapis.com'
  ) {
    return { kind: 'bearer', token: value.token, url };
  }
  throw new RelayFailure(
    'invalid_acquire_grant',
    true,
    'download grant invalid'
  );
}

function parseAcquireResponse(value: unknown): AcquireResponse {
  if (
    !isRecord(value) ||
    typeof value.jobId !== 'string' ||
    typeof value.status !== 'string'
  ) {
    throw new RelayFailure(
      'invalid_acquire_grant',
      true,
      'acquire response invalid'
    );
  }
  if (value.status === 'succeeded') {
    return { jobId: value.jobId, status: 'succeeded' };
  }
  if (
    value.status !== 'acquired' ||
    typeof value.attemptToken !== 'string' ||
    value.attemptToken.length === 0 ||
    typeof value.maxBytes !== 'number' ||
    !Number.isSafeInteger(value.maxBytes) ||
    value.maxBytes <= 0 ||
    value.maxBytes > MAX_TRANSFER_BYTES ||
    typeof value.resumeComplete !== 'boolean'
  ) {
    throw new RelayFailure(
      'invalid_acquire_grant',
      true,
      'acquire response invalid'
    );
  }
  return {
    attemptToken: value.attemptToken,
    download:
      value.download === undefined
        ? undefined
        : parseDownloadGrant(value.download),
    jobId: value.jobId,
    maxBytes: value.maxBytes,
    resumeComplete: value.resumeComplete,
    status: 'acquired',
  };
}

function parseAcquireResponseForJob(
  value: unknown,
  expectedJobId: string
): AcquireResponse {
  const acquired = parseAcquireResponse(value);
  if (acquired.jobId !== expectedJobId) {
    throw new RelayFailure(
      'invalid_acquire_grant',
      true,
      'acquire response job id mismatch'
    );
  }
  return acquired;
}

function parseUploadGrant(value: unknown): UploadGrant {
  if (
    !isRecord(value) ||
    typeof value.expiresAt !== 'string' ||
    !isRecord(value.headers)
  ) {
    throw new RelayFailure(
      'invalid_upload_grant',
      true,
      'upload grant invalid'
    );
  }
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(value.headers)) {
    if (typeof headerValue !== 'string') {
      throw new RelayFailure(
        'invalid_upload_grant',
        true,
        'upload headers invalid'
      );
    }
    headers[name] = headerValue;
  }
  return {
    expiresAt: value.expiresAt,
    headers,
    url: parseHTTPSURL(value.url, 'invalid_upload_grant'),
  };
}

async function enqueue(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response('method not allowed', { status: 405 });
  }
  const declared = Number(request.headers.get('Content-Length') ?? '0');
  if (declared > MAX_CONTROL_BODY || !request.body) {
    return new Response('request too large', { status: 413 });
  }
  let body: Uint8Array<ArrayBuffer>;
  try {
    body = await readStreamBounded(request.body, MAX_CONTROL_BODY);
  } catch {
    return new Response('request too large', { status: 413 });
  }
  if (!(await validSignature(request, body, env.IMPORT_RELAY_SECRET))) {
    return new Response('unauthorized', { status: 401 });
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return new Response('invalid JSON', { status: 400 });
  }
  if (!isImportQueueMessage(value)) {
    return new Response('jobId is required', { status: 400 });
  }
  await env.IMPORT_QUEUE.send({ jobId: value.jobId });
  return new Response(null, { status: 202 });
}

async function relayPost(
  env: Pick<Env, 'API_BASE_URL' | 'IMPORT_RELAY_SECRET'>,
  path: string,
  value: unknown,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch
): Promise<unknown> {
  const raw = encoder.encode(JSON.stringify(value));
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const url = relayAPIURL(env.API_BASE_URL, path);
  const response = await fetcher(url, {
    body: raw,
    headers: {
      'Content-Type': 'application/json',
      'X-Import-Relay-Signature': await signature(
        env.IMPORT_RELAY_SECRET,
        timestamp,
        'POST',
        `${url.pathname}${url.search}`,
        raw
      ),
      'X-Import-Relay-Timestamp': timestamp,
    },
    method: 'POST',
    redirect: 'manual',
    signal,
  });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => undefined);
    throw new RelayFailure(
      'relay_redirect_refused',
      true,
      `relay request returned redirect ${response.status}`
    );
  }
  if (response.status === 204) return;
  const responseBody = await relayResponseJSON(response);
  if (!response.ok) {
    let code = 'relay_request_failed';
    if (isRecord(responseBody) && typeof responseBody.code === 'string') {
      code = responseBody.code;
    }
    throw new RelayFailure(
      code,
      response.status === 408 ||
        response.status === 409 ||
        response.status === 429 ||
        response.status >= 500,
      `relay request returned ${response.status}`
    );
  }
  return responseBody;
}

async function relayResponseJSON(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get('Content-Length') ?? '0');
  if (declared > MAX_CONTROL_BODY || !response.body) {
    throw new RelayFailure(
      'invalid_relay_response',
      true,
      'relay response body invalid'
    );
  }
  let body: Uint8Array<ArrayBuffer>;
  try {
    body = await readStreamBounded(response.body, MAX_CONTROL_BODY);
  } catch (cause) {
    throw invalidRelayResponse('relay response body exceeds limit', cause);
  }
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch (cause) {
    throw invalidRelayResponse('relay response JSON invalid', cause);
  }
}

function invalidRelayResponse(message: string, cause?: unknown): RelayFailure {
  return new RelayFailure('invalid_relay_response', true, message, { cause });
}

async function readStreamBounded(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number
): Promise<Uint8Array<ArrayBuffer>> {
  const output = new Uint8Array(maxBytes);
  const reader = stream.getReader();
  let offset = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > maxBytes - offset) {
        throw new RelayFailure(
          'file_too_large',
          false,
          'file exceeds byte limit'
        );
      }
      output.set(value, offset);
      offset += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return output.subarray(0, offset);
}

async function readBounded(
  response: Response,
  maxBytes: number
): Promise<Uint8Array<ArrayBuffer>> {
  const declared = response.headers.get('Content-Length');
  if (declared && Number(declared) > maxBytes) {
    throw new RelayFailure('file_too_large', false, 'file exceeds byte limit');
  }
  if (!response.body) {
    throw new RelayFailure(
      'provider_empty_body',
      true,
      'provider body missing'
    );
  }
  return readStreamBounded(response.body, maxBytes);
}

function providerStatusFailure(status: number): RelayFailure {
  if (status === 429 || status >= 500 || status === 408 || status === 401) {
    return new RelayFailure(
      'provider_temporarily_unavailable',
      true,
      `provider returned ${status}`
    );
  }
  return new RelayFailure(
    'provider_download_refused',
    false,
    `provider returned ${status}`
  );
}

function providerRedirectTarget(location: string, currentURL: URL): URL {
  if (!URL.canParse(location, currentURL.href)) {
    throw new RelayFailure(
      'provider_download_refused',
      false,
      'provider redirect URL invalid'
    );
  }
  const target = new URL(location, currentURL);
  if (
    target.protocol !== 'https:' ||
    target.username.length > 0 ||
    target.password.length > 0
  ) {
    throw new RelayFailure(
      'provider_download_refused',
      false,
      'provider redirect URL must use HTTPS without credentials'
    );
  }
  return target;
}

async function downloadFile(
  grant: DownloadGrant,
  maxBytes: number,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch
): Promise<Uint8Array<ArrayBuffer>> {
  const headers = new Headers();
  if (grant.kind === 'bearer') {
    headers.set('Authorization', `Bearer ${grant.token}`);
  }
  let currentURL = new URL(grant.url);
  for (let redirects = 0; ; redirects += 1) {
    const response = await fetcher(currentURL, {
      headers,
      redirect: 'manual',
      signal,
    });
    if (response.status < 300 || response.status >= 400) {
      if (!response.ok) throw providerStatusFailure(response.status);
      return readBounded(response, maxBytes);
    }
    if (redirects >= MAX_PROVIDER_REDIRECTS) {
      throw new RelayFailure(
        'provider_download_refused',
        false,
        'provider redirect limit exceeded'
      );
    }
    await response.body?.cancel().catch(() => undefined);
    const location = response.headers.get('Location');
    if (!location) throw providerStatusFailure(response.status);
    const target = providerRedirectTarget(location, currentURL);
    if (target.origin !== currentURL.origin) {
      headers.delete('Authorization');
    }
    await response.body?.cancel().catch(() => undefined);
    currentURL = target;
  }
}

async function reportFailure(
  env: Env,
  jobId: string,
  attemptToken: string,
  failure: RelayFailure
) {
  await relayPost(env, '/api/internal/import-relay/fail', {
    attemptToken,
    code: failure.code,
    jobId,
    message: failure.message,
    retryable: failure.retryable,
    retryDelaySeconds: RETRY_DELAY_SECONDS,
  });
}

async function runImport(message: Message<ImportQueueMessage>, env: Env) {
  let attemptToken = '';
  const transfer = new AbortController();
  const timeout = setTimeout(
    () => transfer.abort(),
    TRANSFER_BUDGET_MILLISECONDS
  );
  try {
    const acquired = parseAcquireResponseForJob(
      await relayPost(
        env,
        '/api/internal/import-relay/acquire',
        { jobId: message.body.jobId },
        transfer.signal
      ),
      message.body.jobId
    );
    if (acquired.status === 'succeeded') return;
    attemptToken = acquired.attemptToken;
    if (!acquired.resumeComplete) {
      if (!acquired.download) {
        throw new RelayFailure(
          'invalid_acquire_grant',
          true,
          'download grant missing'
        );
      }
      const bytes = await downloadFile(
        acquired.download,
        acquired.maxBytes,
        transfer.signal
      );
      const upload = parseUploadGrant(
        await relayPost(
          env,
          '/api/internal/import-relay/upload-grant',
          {
            actualSize: bytes.byteLength,
            attemptToken,
            jobId: message.body.jobId,
          },
          transfer.signal
        )
      );
      const uploadResponse = await fetch(upload.url, {
        body: bytes,
        headers: upload.headers,
        method: 'PUT',
        signal: transfer.signal,
      });
      if (!uploadResponse.ok) {
        throw new RelayFailure(
          'blob_upload_failed',
          uploadResponse.status === 408 ||
            uploadResponse.status === 429 ||
            uploadResponse.status >= 500,
          `blob upload returned ${uploadResponse.status}`
        );
      }
    }
    await relayPost(
      env,
      '/api/internal/import-relay/complete',
      {
        attemptToken,
        jobId: message.body.jobId,
      },
      transfer.signal
    );
  } catch (error) {
    const failure =
      error instanceof RelayFailure
        ? error
        : new RelayFailure(
            'relay_unexpected_failure',
            true,
            error instanceof Error ? error.message : 'unexpected relay failure'
          );
    if (attemptToken) {
      try {
        await reportFailure(env, message.body.jobId, attemptToken, failure);
      } catch {
        message.retry({ delaySeconds: RETRY_DELAY_SECONDS });
        return;
      }
    }
    if (failure.retryable) {
      message.retry({
        delaySeconds:
          failure.code === 'import_not_ready'
            ? RUNNING_LEASE_RETRY_SECONDS
            : RETRY_DELAY_SECONDS,
      });
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function deadLetter(message: Message<ImportQueueMessage>, env: Env) {
  try {
    await relayPost(env, '/api/internal/import-relay/dead-letter', {
      jobId: message.body.jobId,
    });
  } catch {
    message.retry({ delaySeconds: RUNNING_LEASE_RETRY_SECONDS });
  }
}

export const internals = {
  downloadFile,
  isImportQueueMessage,
  parseAcquireResponse,
  parseAcquireResponseForJob,
  parseUploadGrant,
  providerRedirectTarget,
  readBounded,
  relayAPIURL,
  relayPost,
  signature,
  validSignature,
};

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== '/enqueue') {
      return new Response('not found', { status: 404 });
    }
    return enqueue(request, env);
  },
  async queue(batch, env): Promise<void> {
    for (const message of batch.messages) {
      if (!isImportQueueMessage(message.body)) {
        message.ack();
        continue;
      }
      if (batch.queue === env.IMPORT_DLQ_NAME) {
        await deadLetter(message, env);
      } else {
        await runImport(message, env);
      }
    }
  },
} satisfies ExportedHandler<Env, ImportQueueMessage>;
