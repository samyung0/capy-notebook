/**
 * W3C trace context for browser-originated requests.
 *
 * The browser mints the id so a trace covers the whole interaction, including
 * the part that happens before the gateway sees it. The same id then flows
 * gateway → retrieval service → provider call, and is what joins a Sentry
 * event, a log line, and a `usage_events` row for one user action.
 */

const HEX = '0123456789abcdef';

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let out = '';
  for (const byte of buf) {
    out += HEX[byte >> 4] + HEX[byte & 15];
  }
  return out;
}

export function newTraceId(): string {
  return randomHex(16);
}

export function newSpanId(): string {
  return randomHex(8);
}

/**
 * A fresh traceparent per request. Requests are not grouped into a single
 * browser-session trace on purpose: one id per user action is what makes
 * "what did this question cost" answerable, and a session-long trace would
 * merge every action into one unqueryable blob.
 */
export function traceparent(): string {
  return `00-${newTraceId()}-${newSpanId()}-01`;
}

export function traceHeaders(): Record<string, string> {
  return { traceparent: traceparent() };
}
