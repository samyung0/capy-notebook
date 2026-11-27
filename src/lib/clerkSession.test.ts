import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { isPublicPath, likelySignedOut } from './clerkSession';

afterEach(() => {
  vi.unstubAllGlobals();
});

// Q905: the boot move to sign-in must leave exactly the router's public pages.
it("names the router's public pages and no signed-in page as public", () => {
  const source = readFileSync(new URL('../router.ts', import.meta.url), 'utf8');
  const start = source.indexOf('const publicRoutes = [');
  const end = source.indexOf('\n];', start);
  const paths = (text: string) =>
    [...text.matchAll(/path: '(\/[^']*)'/g)].map(([, path]) =>
      path.replace(/\{-\$\w+\}|\$\w+/g, 'x')
    );
  const publicPaths = paths(source.slice(start, end));
  const signedInPaths = paths(source.slice(0, start) + source.slice(end));
  expect(publicPaths.length).toBeGreaterThan(0);
  for (const path of publicPaths) expect(isPublicPath(path), path).toBe(true);
  for (const path of signedInPaths)
    expect(isPublicPath(path), path).toBe(false);
});

it("reads Clerk's session cookie", () => {
  const cookie = (value: string) =>
    vi.stubGlobal('document', { cookie: value });
  cookie('');
  expect(likelySignedOut()).toBe(true);
  cookie('__client_uat_EelQ9s3T=0; __client_uat=0');
  expect(likelySignedOut()).toBe(true);
  // Signed in on one instance, out of another sharing the root domain.
  cookie('__client_uat_EelQ9s3T=1795740952; __client_uat=0');
  expect(likelySignedOut()).toBe(false);
  cookie('theme=dark; __client_uat=1795740952');
  expect(likelySignedOut()).toBe(false);
});
