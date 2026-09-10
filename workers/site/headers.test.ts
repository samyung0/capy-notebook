import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it('stages static runtime isolation for exactly the deployment app origin and rejects invalid origins', () => {
  const directory = mkdtempSync(join(tmpdir(), 'capy-site-headers-'));
  const stage = (origin: string) =>
    execFileSync(
      process.execPath,
      ['workers/site/headers.mjs', directory, origin],
      { stdio: 'pipe' }
    );
  try {
    writeFileSync(join(directory, 'llm-runtime.html'), 'runtime');
    stage('https://app.example.test');
    const headers = readFileSync(join(directory, '_headers'), 'utf8');
    expect(headers).toContain('/llm-runtime.html');
    expect(headers).toContain('Cross-Origin-Opener-Policy: same-origin');
    expect(headers).toContain('Cross-Origin-Embedder-Policy: credentialless');
    expect(headers).toContain(
      'Document-Isolation-Policy: isolate-and-credentialless'
    );
    expect(headers).toContain(
      "Content-Security-Policy: frame-ancestors 'self' https://app.example.test\n"
    );
    expect(headers).not.toContain('localhost');
    expect(headers).toContain('public, max-age=31536000, immutable');
    for (const origin of [
      '',
      'http://app.example.test',
      'https://app.example.test/',
      'https://app.example.test/path',
      'https://user:pass@app.example.test',
      'https://*.example.test',
      'https://app.example.test\n  Set-Cookie: secret',
    ]) {
      expect(() => stage(origin)).toThrow();
      expect(readFileSync(join(directory, '_headers'), 'utf8')).toBe(headers);
    }
  } finally {
    rmSync(directory, { recursive: true });
  }
});
