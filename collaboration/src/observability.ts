import { AsyncLocalStorage } from 'node:async_hooks';
/**
 * Error reporting and structured logging for the collaboration server.
 *
 * This process is the one place where a silent failure is invisible to the
 * user until their work is gone: a document store that fails writes a warning
 * to stdout and keeps accepting edits. Everything in here exists so that
 * failure surfaces somewhere a human looks.
 */

import type { ServerResponse } from 'node:http';
import * as Sentry from '@sentry/node';

const DSN = process.env.SENTRY_DSN ?? '';
const APP_ENV = process.env.APP_ENV ?? 'development';
// Not APP_ENV: UAT runs with APP_ENV=production to exercise production
// checks, and still has to report as its own Sentry environment.
const SENTRY_ENVIRONMENT = process.env.SENTRY_ENVIRONMENT || APP_ENV;

export function initErrorReporting(): void {
  if (!DSN) {
    log('info', 'sentry disabled (no SENTRY_DSN)');
    return;
  }
  Sentry.init({
    beforeSend: (event, hint) => {
      if (event.request) {
        delete event.request.data;
        delete event.request.cookies;
        for (const name of Object.keys(event.request.headers ?? {})) {
          if (
            [
              'authorization',
              'cookie',
              'x-pipeline-secret',
              'x-collaboration-secret',
            ].includes(name.toLowerCase())
          ) {
            delete event.request.headers?.[name];
          }
        }
      }
      const existing = errorEventId(hint.originalException);
      return existing && existing !== event.event_id ? null : event;
    },
    dsn: DSN,
    environment: SENTRY_ENVIRONMENT,
    release: process.env.RELEASE_SHA || undefined,
    sendDefaultPii: false,
    // Tracing is off here rather than sampled: every connection is a
    // long-lived WebSocket, so transactions would measure session length
    // rather than anything actionable.
    tracesSampleRate: 0,
  });
  log('info', 'sentry enabled', { environment: SENTRY_ENVIRONMENT });
}

type Level = 'debug' | 'info' | 'warn' | 'error';

const LOG_FORMAT =
  process.env.LOG_FORMAT ?? (APP_ENV === 'development' ? 'text' : 'json');

/**
 * One structured line per event, matching the gateway's field names so a
 * `trace_id` or `user_id` grep spans both services.
 */
export function log(
  level: Level,
  msg: string,
  fields: Record<string, unknown> = {}
): void {
  if (LOG_FORMAT === 'text') {
    const suffix = Object.keys(fields).length
      ? ` ${JSON.stringify(fields)}`
      : '';
    const line = `${level} ${msg}${suffix}`;
    if (level === 'error') {
      console.error(line);
    } else if (level === 'warn') {
      console.warn(line);
    } else {
      console.info(line);
    }
    return;
  }
  console.info(
    JSON.stringify({
      env: APP_ENV,
      level,
      msg,
      service: 'collaboration',
      time: new Date().toISOString(),
      ...fields,
    })
  );
}

/**
 * Report a failure that the connected client will not see. Persistence errors
 * are the important case: the editor stays live and the user keeps typing into
 * a document that is no longer being saved.
 */
export function captureError(
  error: unknown,
  tags: Record<string, string> = {}
): string | undefined {
  const existing = errorEventId(error);
  if (existing) return existing;
  log('error', 'captured error', {
    ...tags,
    error: error instanceof Error ? error.message : String(error),
  });
  if (!Sentry.getClient()?.getDsn()) return;
  let eventId: string | undefined;
  Sentry.withScope((scope) => {
    for (const [key, value] of Object.entries(tags)) scope.setTag(key, value);
    eventId = Sentry.captureException(error);
    withEventId(error, eventId);
  });
  return eventId;
}

export const ERROR_EVENT_HEADER = 'X-Sentry-Event-Id';
const EVENT_ID = /^[a-f0-9]{32}$/;
const reportedErrors = new WeakMap<object, string>();

export function errorEventId(error: unknown): string | undefined {
  const seen = new Set<object>();
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    const eventId = reportedErrors.get(current);
    if (eventId) return eventId;
    current = current.cause;
  }
}

/** Accept identities only from trusted internal responses. */
export function withEventId<T>(
  error: T,
  eventId: string | null | undefined
): T {
  if (error instanceof Error && eventId && EVENT_ID.test(eventId)) {
    reportedErrors.set(error, eventId);
  }
  return error;
}

export function reportHttpError(
  response: ServerResponse,
  error: unknown
): void {
  const eventId = captureError(error, { stage: 'http_request' });
  if (eventId && !response.headersSent)
    response.setHeader(ERROR_EVENT_HEADER, eventId);
}

export const RETRY_EVENT_HEADER = 'X-Sentry-Retry-Event-Id';
const retryEvent = new AsyncLocalStorage<string | undefined>();

export function withRetryEvent<T>(
  eventId: string | undefined,
  work: () => T
): T {
  return retryEvent.run(eventId, work);
}

export function retryEventHeaders(): Record<string, string> {
  const eventId = retryEvent.getStore();
  return eventId ? { [RETRY_EVENT_HEADER]: eventId } : {};
}
