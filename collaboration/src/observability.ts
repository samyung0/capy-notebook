/**
 * Error reporting and structured logging for the collaboration server.
 *
 * This process is the one place where a silent failure is invisible to the
 * user until their work is gone: a document store that fails writes a warning
 * to stdout and keeps accepting edits. Everything in here exists so that
 * failure surfaces somewhere a human looks.
 */

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
): void {
  log('error', 'captured error', {
    ...tags,
    error: error instanceof Error ? error.message : String(error),
  });
  if (!DSN) return;
  Sentry.withScope((scope) => {
    for (const [key, value] of Object.entries(tags)) scope.setTag(key, value);
    Sentry.captureException(error);
  });
}
