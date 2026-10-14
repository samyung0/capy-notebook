import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ResolvedConfig } from 'vite';
import { describe, expect, it } from 'vitest';
import { imagePolicy, imagePolicyHeaders } from '../../vite-image-policy';

const DEPLOYED = {
  B2_BUCKET: 'capy-notebook-uat',
  B2_ENDPOINT: 'https://s3.us-west-004.backblazeb2.com',
  VITE_APP_ENV: 'uat',
  VITE_BANK_ASSETS_URL: 'https://bank-assets.capynotebook.com',
  VITE_SENTRY_DSN: 'https://pubkey@o123.ingest.de.sentry.io/456',
};

const SPACES = /\s+/;
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

  it('adds the policy to the built _headers and to the share renderer', () => {
    const outDir = mkdtempSync(path.join(tmpdir(), 'image-policy-'));
    writeFileSync(path.join(outDir, '_headers'), '/icons/*\n  X-Kept: yes\n');
    const policy = imagePolicy(DEPLOYED);
    const plugin = imagePolicyHeaders(policy);
    const config = plugin.config as () => { define: Record<string, string> };
    expect(config().define.__CAPY_IMAGE_POLICY__).toBe(JSON.stringify(policy));
    const resolved = plugin.configResolved as (config: ResolvedConfig) => void;
    resolved({
      build: { outDir, ssr: false },
      command: 'build',
      root: '/',
    } as unknown as ResolvedConfig);
    (plugin.writeBundle as () => void)();
    const headers = readFileSync(path.join(outDir, '_headers'), 'utf8');
    expect(headers).toContain('/icons/*\n  X-Kept: yes\n');
    expect(headers).toContain(
      `/*\n  Content-Security-Policy-Report-Only: ${policy}\n`
    );
  });
});
