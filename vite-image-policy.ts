import { appendFileSync } from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

type Env = Record<string, string | undefined>;

/**
 * The hosts the app's pages draw images from, as a report-only `img-src`
 * policy: the app itself, `data:` and `blob:` URLs, the environment's bucket
 * (addressed as Go's presigner addresses it, `B2_FORCE_PATH_STYLE`), the
 * bank's asset base, Clerk avatars and YouTube posters. Any other image or CSS
 * `url()` a page loads is reported to the browser Sentry project's security
 * endpoint when `VITE_SENTRY_DSN` is set. Enforcing it means sending the same
 * value as `Content-Security-Policy` once UAT reports stay empty.
 */
export function imagePolicy(env: Env): string {
  const sources = ["'self'", 'data:', 'blob:'];
  if (env.B2_BUCKET && env.B2_ENDPOINT) {
    const endpoint = new URL(env.B2_ENDPOINT);
    // Path style shares its host with every bucket in the region, so the
    // source names this bucket's path.
    sources.push(
      env.B2_FORCE_PATH_STYLE === 'true'
        ? `${endpoint.origin}/${env.B2_BUCKET}/`
        : `${endpoint.protocol}//${env.B2_BUCKET}.${endpoint.host}`
    );
  }
  if (env.VITE_BANK_ASSETS_URL)
    sources.push(new URL(env.VITE_BANK_ASSETS_URL).origin);
  sources.push('https://img.clerk.com', 'https://i.ytimg.com');
  const policy = `img-src ${sources.join(' ')}`;
  const report = sentrySecurityUrl(env.VITE_SENTRY_DSN, env.VITE_APP_ENV);
  return report ? `${policy}; report-uri ${report}` : policy;
}

/** Sentry's CSP report endpoint for a DSN `https://{key}@{host}/{project}`. */
function sentrySecurityUrl(dsn?: string, environment?: string) {
  if (!dsn) return;
  const url = new URL(dsn);
  const slash = url.pathname.lastIndexOf('/');
  const report = new URL(
    `${url.pathname.slice(0, slash)}/api/${url.pathname.slice(slash + 1)}/security/`,
    url.origin
  );
  report.searchParams.set('sentry_key', url.username);
  if (environment) report.searchParams.set('sentry_environment', environment);
  return report.href;
}

/**
 * Sends `policy` report-only with every HTML page: the app's own (Workers
 * Assets serves them with `dist/_headers`, which the client build extends) and
 * the pages the site Worker renders, which read it from the share renderer
 * bundle as `IMAGE_POLICY` (src/share/server.tsx).
 */
export function imagePolicyHeaders(policy: string): Plugin {
  let headersFile: string | undefined;
  return {
    config: () => ({
      define: { __CAPY_IMAGE_POLICY__: JSON.stringify(policy) },
    }),
    configResolved(config) {
      if (config.command === 'build' && !config.build.ssr)
        headersFile = path.resolve(
          config.root,
          config.build.outDir,
          '_headers'
        );
    },
    name: 'image-policy',
    // After Vite copied public/_headers into the output.
    writeBundle() {
      if (headersFile)
        appendFileSync(
          headersFile,
          `\n# Image sources, report-only (vite-image-policy.ts).\n/*\n  Content-Security-Policy-Report-Only: ${policy}\n`
        );
    },
  };
}
