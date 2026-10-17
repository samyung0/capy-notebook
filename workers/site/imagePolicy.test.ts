import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build, type ResolvedConfig } from 'vite';
import { describe, expect, it } from 'vitest';
import {
  appPolicy,
  imagePolicy,
  pagePolicy,
  policyHeaders,
} from '../../vite-image-policy';

const DEPLOYED = {
  B2_BUCKET: 'capy-notebook-uat',
  B2_ENDPOINT: 'https://s3.us-west-004.backblazeb2.com',
  VITE_APP_ENV: 'uat',
  VITE_BANK_ASSETS_URL: 'https://bank-assets.capynotebook.com',
  VITE_SENTRY_DSN: 'https://pubkey@o123.ingest.de.sentry.io/456',
};

const SPACES = /\s+/;
const SCRIPT_SRC = /script-src [^;]*/;
const INLINE_SCRIPT = /<script\b(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g;
const directives = (policy: string) =>
  Object.fromEntries(
    policy.split(';').map((directive) => {
      const [name = '', ...sources] = directive.trim().split(SPACES);
      return [name, sources];
    })
  );

// Security regression (human deployment-runbook 2026-10-14 image sources): the
// app's pages name every host they draw images from and no other, report-only.
describe('image-source policy', () => {
  it('names the environment bucket, bank assets, Clerk and YouTube and nothing wider', () => {
    const policy = directives(imagePolicy(DEPLOYED));
    expect(policy).toEqual({
      'img-src': [
        "'self'",
        'data:',
        'blob:',
        'https://capy-notebook-uat.s3.us-west-004.backblazeb2.com',
        'https://bank-assets.capynotebook.com',
        'https://img.clerk.com',
        'https://i.ytimg.com',
      ],
      'report-uri': [
        'https://o123.ingest.de.sentry.io/api/456/security/?sentry_key=pubkey&sentry_environment=uat',
      ],
    });
    expect(policy['img-src'].join(' ')).not.toContain('*');
  });

  it('names the bucket path when the bucket is addressed by path', () => {
    const policy = directives(
      imagePolicy({ ...DEPLOYED, B2_FORCE_PATH_STYLE: 'true' })
    );
    expect(policy['img-src']).toContain(
      'https://s3.us-west-004.backblazeb2.com/capy-notebook-uat/'
    );
    expect(policy['img-src']).not.toContain(
      'https://s3.us-west-004.backblazeb2.com'
    );
  });

  it('names the bank base path when the base is under a path', () => {
    const policy = directives(
      imagePolicy({
        ...DEPLOYED,
        VITE_BANK_ASSETS_URL: 'https://f003.backblazeb2.com/file/bank-public/',
      })
    );
    expect(policy['img-src']).toContain(
      'https://f003.backblazeb2.com/file/bank-public/'
    );
    expect(policy['img-src']).not.toContain('https://f003.backblazeb2.com');
  });

  it('fails a deployed build that misses its bucket or report endpoint', () => {
    for (const environment of ['uat', 'production'])
      for (const key of ['B2_BUCKET', 'B2_ENDPOINT', 'VITE_SENTRY_DSN'])
        expect(() =>
          imagePolicy({ ...DEPLOYED, [key]: '', VITE_APP_ENV: environment })
        ).toThrow(key);
    // A local or e2e build has neither and still builds.
    expect(imagePolicy({ VITE_APP_ENV: 'e2e' })).toBe(
      "img-src 'self' data: blob: https://img.clerk.com https://i.ytimg.com"
    );
  });

  it('adds the policies to the built _headers and to the share renderer', () => {
    const outDir = mkdtempSync(path.join(tmpdir(), 'image-policy-'));
    writeFileSync(path.join(outDir, '_headers'), '/icons/*\n  X-Kept: yes\n');
    // A build keeps index.html's classic inline scripts; Vite bundles its
    // module scripts.
    const boot = 'addEventListener("error", () => {}, true);';
    writeFileSync(
      path.join(outDir, 'index.html'),
      `<head><script>${boot}</script><script type="module" crossorigin src="/assets/main.js"></script></head>`
    );
    const plugin = policyHeaders(DEPLOYED);
    const config = plugin.config as () => { define: Record<string, string> };
    expect(config().define).toEqual({
      __CAPY_IMAGE_POLICY__: JSON.stringify(imagePolicy(DEPLOYED)),
      __CAPY_PAGE_POLICY__: JSON.stringify(pagePolicy(DEPLOYED)),
    });
    const resolved = plugin.configResolved as (config: ResolvedConfig) => void;
    resolved({
      build: { outDir, ssr: false },
      command: 'build',
      root: '/',
    } as unknown as ResolvedConfig);
    (plugin.writeBundle as () => void)();
    const headers = readFileSync(path.join(outDir, '_headers'), 'utf8');
    expect(headers).toContain('/icons/*\n  X-Kept: yes\n');
    const hash = createHash('sha256').update(boot).digest('base64');
    const policy = appPolicy(DEPLOYED);
    const scripts = SCRIPT_SRC.exec(policy)?.[0];
    expect(headers).toContain(
      `/*\n  Content-Security-Policy-Report-Only: ${policy.replace(
        `${scripts};`,
        `${scripts} 'sha256-${hash}';`
      )}\n`
    );
  });

  it("keeps index.html's inline scripts in the built page, each allowed by hash", async () => {
    // The theme and boot-failure scripts run before the entry, so the boot
    // loader and its reload message use the chosen theme (Epo 2026-10-17); a
    // module script would be bundled into the entry.
    const root = mkdtempSync(path.join(tmpdir(), 'inline-scripts-'));
    const source = readFileSync(
      path.resolve(import.meta.dirname, '../../index.html'),
      'utf8'
    );
    writeFileSync(
      path.join(root, 'index.html'),
      source.replace('/src/main.tsx', '/main.js')
    );
    writeFileSync(path.join(root, 'main.js'), 'document.title = "";\n');
    await build({
      cacheDir: path.join(root, '.vite'),
      configFile: false,
      logLevel: 'silent',
      plugins: [policyHeaders(DEPLOYED)],
      root,
    });
    const built = readFileSync(path.join(root, 'dist', 'index.html'), 'utf8');
    const headers = readFileSync(path.join(root, 'dist', '_headers'), 'utf8');
    const scripts = [...source.matchAll(INLINE_SCRIPT)].map(([, code]) => code);
    expect(scripts).toHaveLength(2);
    expect(scripts.some((code) => code.includes("'capy.theme'"))).toBe(true);
    for (const code of scripts) {
      expect(built).toContain(`>${code}</script>`);
      expect(headers).toContain(
        `'sha256-${createHash('sha256').update(code).digest('base64')}'`
      );
    }
  }, 30_000);
});
