import { appendFileSync } from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

type Env = Record<string, string | undefined>;

const TRAILING_SLASH = /\/+$/;
const POSTHOG_CLOUD = /^(eu|us)\.i\.posthog\.com$/;
const KEY_END = /\$$/;

/** What a deployed build's policy cannot leave out: its bucket and where it
 * reports. */
const DEPLOYED_NEEDS = ['B2_BUCKET', 'B2_ENDPOINT', 'VITE_SENTRY_DSN'];

/**
 * The hosts the app's pages draw images from, as a report-only `img-src`
 * policy: the app itself, `data:` and `blob:` URLs, the environment's bucket
 * (addressed as Go's presigner addresses it, `B2_FORCE_PATH_STYLE`), the
 * bank's asset base, Clerk avatars and YouTube posters. Any other image or CSS
 * `url()` a page loads is reported to the browser Sentry project's security
 * endpoint when `VITE_SENTRY_DSN` is set; a `uat` or `production` build
 * without it or its bucket fails. Enforcing it means sending the same value
 * as `Content-Security-Policy` once UAT reports stay empty.
 */
export function imagePolicy(env: Env): string {
  if (env.VITE_APP_ENV === 'uat' || env.VITE_APP_ENV === 'production') {
    const missing = DEPLOYED_NEEDS.filter((key) => !env[key]);
    if (missing.length)
      throw new Error(
        `The ${env.VITE_APP_ENV} image policy needs ${missing.join(', ')}.`
      );
  }
  return withReport(env, [imageSources(env)]);
}

function imageSources(env: Env): string {
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
  if (env.VITE_BANK_ASSETS_URL) {
    // A base under a path (a shared host) allows only that path.
    const bank = new URL(env.VITE_BANK_ASSETS_URL);
    const base = bank.pathname.replace(TRAILING_SLASH, '');
    sources.push(base ? `${bank.origin}${base}/` : bank.origin);
  }
  sources.push('https://img.clerk.com', 'https://i.ytimg.com');
  return `img-src ${sources.join(' ')}`;
}

/**
 * Where the pages the site Worker renders run scripts from: the app itself,
 * Clerk's frontend API (named by the publishable key; shared quizzes and
 * flashcard sets load clerk-js from it to learn who is signed in) and this
 * PostHog project's script assets (its remote config and lazy extensions).
 * The paths keep any other PostHog project's config out.
 */
function scriptSources(env: Env): string[] {
  const sources = ["'self'"];
  const clerkKey = env.VITE_CLERK_PUBLISHABLE_KEY;
  if (clerkKey) {
    // `pk_{test|live}_` and the base64 of `{frontend API host}$`.
    const host = Buffer.from(clerkKey.split('_')[2] ?? '', 'base64')
      .toString()
      .replace(KEY_END, '');
    sources.push(`https://${host}`);
  }
  if (env.VITE_POSTHOG_KEY) {
    // src/lib/analytics.ts falls back to the same host. PostHog Cloud serves
    // scripts from the region's assets host, a proxy from itself.
    const host = (env.VITE_POSTHOG_HOST || 'https://eu.i.posthog.com').replace(
      TRAILING_SLASH,
      ''
    );
    const region = new URL(host).hostname.match(POSTHOG_CLOUD)?.[1];
    const assets = region ? `https://${region}-assets.i.posthog.com` : host;
    sources.push(
      `${assets}/static/`,
      `${assets}/array/${env.VITE_POSTHOG_KEY}/config.js`
    );
  }
  return sources;
}

/**
 * The policy the site Worker enforces on the share, summary and error pages
 * it renders, next to the report-only image policy: scripts only from
 * `scriptSources` and never inline or from an event-handler attribute (the
 * Worker adds the hash of each inline script its own template carries,
 * workers/site/handler.ts), workers also from `blob:` (clerk-js's timers),
 * frames only for interactive blocks and YouTube, no plugins and no `<base>`.
 * Styles stay open to inline: the Worker inlines the page's CSS, and MathLive
 * and Mermaid write style attributes. Framing is unchanged (no
 * `frame-ancestors`).
 */
export function pagePolicy(env: Env): string {
  const frames = [
    env.VITE_EMBED_ORIGIN,
    'https://www.youtube-nocookie.com',
  ].filter(Boolean);
  return withReport(env, [
    `script-src ${scriptSources(env).join(' ')}`,
    "script-src-attr 'none'",
    "worker-src 'self' blob:",
    "style-src 'self' 'unsafe-inline'",
    `frame-src ${frames.join(' ')}`,
    "object-src 'none'",
    "base-uri 'none'",
  ]);
}

/**
 * The SPA's report-only policy: the image sources, and the share pages'
 * script sources plus what only the app loads (Clerk's Turnstile on sign-up,
 * Google's file picker), so reports show what else the app would need before
 * its scripts are enforced.
 */
export function appPolicy(env: Env): string {
  return withReport(env, [
    imageSources(env),
    `script-src ${[
      ...scriptSources(env),
      'https://challenges.cloudflare.com',
      'https://apis.google.com',
    ].join(' ')}`,
    "script-src-attr 'none'",
    "worker-src 'self' blob:",
  ]);
}

/** `directives` reporting to the Sentry security endpoint, when there is one. */
function withReport(env: Env, directives: string[]): string {
  const report = sentrySecurityUrl(env.VITE_SENTRY_DSN, env.VITE_APP_ENV);
  return [...directives, ...(report ? [`report-uri ${report}`] : [])].join(
    '; '
  );
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
 * Sends the policies with the app's pages. Workers Assets serves the SPA's
 * HTML with `dist/_headers`, which the client build extends with `appPolicy`,
 * report-only. The site Worker's pages read `imagePolicy` (report-only) and
 * `pagePolicy` (enforced) from the share renderer bundle as `IMAGE_POLICY`
 * and `PAGE_POLICY` (src/share/server.tsx). A `uat` or `production` build
 * without its bucket or report endpoint fails here.
 */
export function policyHeaders(env: Env): Plugin {
  const image = imagePolicy(env);
  const page = pagePolicy(env);
  const app = appPolicy(env);
  let headersFile: string | undefined;
  return {
    config: () => ({
      define: {
        __CAPY_IMAGE_POLICY__: JSON.stringify(image),
        __CAPY_PAGE_POLICY__: JSON.stringify(page),
      },
    }),
    configResolved(config) {
      if (config.command === 'build' && !config.build.ssr)
        headersFile = path.resolve(
          config.root,
          config.build.outDir,
          '_headers'
        );
    },
    name: 'page-policies',
    // After Vite copied public/_headers into the output.
    writeBundle() {
      if (headersFile)
        appendFileSync(
          headersFile,
          `\n# Image and script sources, report-only (vite-image-policy.ts).\n/*\n  Content-Security-Policy-Report-Only: ${app}\n`
        );
    },
  };
}
