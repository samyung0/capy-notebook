import { createHash } from 'node:crypto';
import { PAGE_POLICY } from 'capy-share-render';
import { describe, expect, it, vi } from 'vitest';
import {
  DEV_SHARE_LINK_SECRET,
  sharePath,
  shareToken,
} from '../../src/lib/shareLink';
import { appPolicy, pagePolicy } from '../../vite-image-policy';
import { allowTurnstile, handleSiteRequest } from './handler';

const DEPLOYED = {
  B2_BUCKET: 'capy-notebook-uat',
  B2_ENDPOINT: 'https://s3.us-west-004.backblazeb2.com',
  VITE_APP_ENV: 'uat',
  VITE_CLERK_PUBLISHABLE_KEY: `pk_live_${btoa('clerk.uat.capynotebook.com$')}`,
  VITE_EMBED_ORIGIN: 'https://uat.capy-embed.pages.dev',
  VITE_POSTHOG_HOST: 'https://eu.i.posthog.com',
  VITE_POSTHOG_KEY: 'phc_project',
  VITE_SENTRY_DSN: 'https://pubkey@o123.ingest.de.sentry.io/456',
};
const REPORT =
  'https://o123.ingest.de.sentry.io/api/456/security/?sentry_key=pubkey&sentry_environment=uat';

const SPACES = /\s+/;
const directives = (policy: string | null) =>
  Object.fromEntries(
    (policy ?? '').split(';').map((directive) => {
      const [name = '', ...sources] = directive.trim().split(SPACES);
      return [name, sources];
    })
  );

/** A script source an enforced policy may name: the app, a hash or one host;
 * never `'unsafe-inline'`, `'unsafe-eval'`, a scheme or a wildcard. */
const NAMED_SCRIPT_SOURCE =
  /^('self'|'sha256-[A-Za-z0-9+/]+=*'|https:\/\/[^*]+)$/;

/** What every enforced page policy holds, whatever the environment. */
const locked = (policy: string | null) => {
  const found = directives(policy);
  return {
    'base-uri': found['base-uri'],
    'frame-ancestors': found['frame-ancestors'],
    'object-src': found['object-src'],
    'script-src-attr': found['script-src-attr'],
    scriptsNamed:
      found['script-src']?.includes("'self'") &&
      found['script-src'].every((source: string) =>
        NAMED_SCRIPT_SOURCE.test(source)
      ),
  };
};
const LOCKED = {
  'base-uri': ["'none'"],
  'frame-ancestors': ["'self'"],
  'object-src': ["'none'"],
  'script-src-attr': ["'none'"],
  scriptsNamed: true,
};

const SHARE_TEMPLATE =
  '<html lang="en"><head><!--capy-share-head--></head><body><!--capy-share-body--></body></html>';
const SUMMARY_TEMPLATE =
  '<html lang="en"><head><!--capy-summary-head--></head><body><!--capy-summary-body--></body></html>';
const env = (share = SHARE_TEMPLATE) => ({
  API_ORIGIN: 'https://api.example.test',
  APP_ORIGIN: 'https://app.example.test',
  ASSETS: {
    fetch: vi.fn(async (asset: Request) =>
      new URL(asset.url).pathname === '/share.html'
        ? new Response(share)
        : new Response(SUMMARY_TEMPLATE)
    ),
  },
  SHARE_LINK_SECRET: DEV_SHARE_LINK_SECRET,
});
const quiz = {
  author: { name: 'Mia' },
  id: 'mat_0123456789',
  name: '<script>alert(1)</script>',
  privacy: 'link',
  questions: [],
  updatedAt: '2026-10-04T10:00:00Z',
};
const workspace = {
  author: 'Mia',
  chapters: [],
  description: '',
  files: [],
  iconId: 'waves-03',
  name: 'Biology',
  privacy: 'public',
  tags: [],
};
const QUIZ_PAGE = `/share/quizzes/${await shareToken(DEV_SHARE_LINK_SECRET, 'mat_0123456789')}`;
const SUMMARY_PAGE = await sharePath(DEV_SHARE_LINK_SECRET, 'ws_0123456789');
const request = (path: string, method = 'GET') =>
  new Request(`https://app.example.test${path}`, { method });
const answer = (data: unknown) =>
  vi.fn<typeof fetch>(async () => Response.json(data));

// Security regression (human deployment-runbook 2026-10-15 page scripts):
// pages the site Worker renders run scripts only from the app and named
// hosts, never inline or from an attribute, and only the app frames them.
describe('enforced script policy', () => {
  it('names the app, Clerk and this PostHog project for scripts, and only embed and YouTube frames', () => {
    expect(directives(pagePolicy(DEPLOYED))).toEqual({
      'base-uri': ["'none'"],
      'form-action': ["'self'"],
      'frame-ancestors': ["'self'"],
      'frame-src': [
        'https://uat.capy-embed.pages.dev',
        'https://www.youtube-nocookie.com',
      ],
      'object-src': ["'none'"],
      'report-uri': [REPORT],
      'script-src': [
        "'self'",
        'https://clerk.uat.capynotebook.com/npm/@clerk/',
        'https://eu-assets.i.posthog.com/static/',
        'https://eu-assets.i.posthog.com/array/phc_project/config.js',
      ],
      'script-src-attr': ["'none'"],
      'style-src': ["'self'", "'unsafe-inline'"],
      'worker-src': ["'self'", 'blob:'],
    });
    // A local build without Clerk or PostHog runs scripts from the app only.
    expect(directives(pagePolicy({}))['script-src']).toEqual(["'self'"]);
    expect(locked(PAGE_POLICY)).toEqual(LOCKED);
  });

  it('fails the build when the Clerk key names no plain host', () => {
    for (const host of ['clerk.example.com/x', 'clerk example', 'a;b'])
      expect(() =>
        pagePolicy({
          VITE_CLERK_PUBLISHABLE_KEY: `pk_test_${btoa(`${host}$`)}`,
        })
      ).toThrow('VITE_CLERK_PUBLISHABLE_KEY');
  });

  it('allows PostHog scripts from where posthog-js loads them', () => {
    const posthog = (host?: string) =>
      directives(
        pagePolicy({ VITE_POSTHOG_HOST: host, VITE_POSTHOG_KEY: 'phc_project' })
      )['script-src'].slice(1);
    // Unset means EU Cloud, as in src/lib/analytics.ts.
    for (const host of [
      undefined,
      'https://eu.posthog.com',
      'https://eu.i.posthog.com/',
    ])
      expect(posthog(host)).toEqual([
        'https://eu-assets.i.posthog.com/static/',
        'https://eu-assets.i.posthog.com/array/phc_project/config.js',
      ]);
    expect(posthog('https://app.posthog.com')[0]).toBe(
      'https://us-assets.i.posthog.com/static/'
    );
    // A proxy serves them itself; an empty host means the page's origin.
    expect(posthog('https://ph.example.com/ingest/')).toEqual([
      'https://ph.example.com/ingest/static/',
      'https://ph.example.com/ingest/array/phc_project/config.js',
    ]);
    expect(posthog('')).toEqual([]);
  });

  it('is sent with every page the Worker renders, error pages and HEAD included', async () => {
    const pages = [
      await handleSiteRequest(request(QUIZ_PAGE), env(), answer(quiz)),
      await handleSiteRequest(request(SUMMARY_PAGE), env(), answer(workspace)),
      await handleSiteRequest(request('/w/forged'), env(), answer(workspace)),
      await handleSiteRequest(
        request('/w/forged', 'HEAD'),
        env(),
        answer(workspace)
      ),
    ];
    expect(pages.map((page) => page.status)).toEqual([200, 200, 404, 404]);
    // The quiz page grades signed-out answers, so it also allows Turnstile.
    expect(pages[0].headers.get('Content-Security-Policy')).toBe(
      allowTurnstile(PAGE_POLICY)
    );
    for (const page of pages.slice(1))
      expect(page.headers.get('Content-Security-Policy')).toBe(PAGE_POLICY);
    for (const page of pages) {
      expect(locked(page.headers.get('Content-Security-Policy'))).toEqual(
        LOCKED
      );
    }
  }, 20_000);

  it("lets only the template's own inline scripts run, by hash", async () => {
    const boot = 'window.booted = true;';
    const page = await handleSiteRequest(
      request(QUIZ_PAGE),
      env(
        SHARE_TEMPLATE.replace(
          '</head>',
          `<script type="module">${boot}</script><script type="module" src="/assets/share.js"></script></head>`
        )
      ),
      answer(quiz)
    );
    const policy = page.headers.get('Content-Security-Policy');
    const hash = createHash('sha256').update(boot).digest('base64');
    const [self, ...hosts] = directives(allowTurnstile(PAGE_POLICY))[
      'script-src'
    ];
    expect(directives(policy)['script-src']).toEqual([
      self,
      `'sha256-${hash}'`,
      ...hosts,
    ]);
    expect(locked(policy)).toEqual(LOCKED);
    // What the render wrote is text, and no hash covers it.
    expect(await page.text()).not.toContain('<script>alert(1)');
  });
});

describe('the SPA script report', () => {
  it('reports scripts beyond the share pages’ sources and the app’s own two hosts', () => {
    const found = directives(appPolicy(DEPLOYED));
    expect(found['img-src']).toContain("'self'");
    expect(found['script-src']).toEqual([
      ...directives(pagePolicy(DEPLOYED))['script-src'],
      'https://challenges.cloudflare.com',
      'https://apis.google.com',
    ]);
    expect(found['script-src-attr']).toEqual(["'none'"]);
    expect(found['report-uri']).toEqual([REPORT]);
  });
});
