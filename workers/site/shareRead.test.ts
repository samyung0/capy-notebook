import { beforeAll, describe, expect, it, vi } from 'vitest';
import { DEV_SHARE_LINK_SECRET, shareToken } from '../../src/lib/shareLink';
import { handleSiteRequest } from './handler';
import { SHARE_READ_HEADER, shareReadHeader } from './shareRead';

const env = {
  API_ORIGIN: 'https://api.example.test',
  APP_ORIGIN: 'https://app.example.test',
  ASSETS: { fetch: vi.fn(async () => new Response('<html></html>')) },
  SHARE_LINK_SECRET: DEV_SHARE_LINK_SECRET,
};
const VISITOR = '2001:db8::1';
const request = (path: string) =>
  new Request(`https://app.example.test${path}`, {
    headers: { 'CF-Connecting-IP': VISITOR },
  });

// security regression: rate-limit audit H7
describe('share-read header', () => {
  // The not-found page's renderer loads on first use; load it up front.
  beforeAll(() => import('capy-share-render'), 60_000);

  it('signs the vector the gateway verifies (ratelimit audit_test.go)', async () => {
    expect(
      await shareReadHeader(
        DEV_SHARE_LINK_SECRET,
        VISITOR,
        '/api/public/quizzes/mat_0123456789.abc',
        1_700_000_000_000
      )
    ).toBe(
      '1700000000.2001:db8::1.6KvJLOKm7yRWTgnp0XDZW69jC4M7VfcFAO5DCi8NrNg'
    );
  });

  it('rides on every Worker read of /api/public/ with the visitor address', async () => {
    const material = await shareToken(DEV_SHARE_LINK_SECRET, 'mat_0123456789');
    const workspace = await shareToken(DEV_SHARE_LINK_SECRET, 'ws_0123456789');
    const reads: Request[] = [];
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      reads.push(input as Request);
      return new Response(null, { status: 404 });
    });
    for (const path of [
      `/share/quizzes/${material}`,
      `/w/${workspace}`,
      `/p/notes/${material}/assets/asset_1`,
    ])
      await handleSiteRequest(request(path), env, fetcher);
    expect(reads).toHaveLength(3);
    for (const read of reads) {
      const { pathname } = new URL(read.url);
      const header = read.headers.get(SHARE_READ_HEADER) ?? '';
      const stamp = Number(header.split('.')[0]);
      expect(pathname.startsWith('/api/public/')).toBe(true);
      expect(Math.abs(Date.now() / 1000 - stamp)).toBeLessThan(60);
      expect(header).toBe(
        await shareReadHeader(
          DEV_SHARE_LINK_SECRET,
          VISITOR,
          pathname,
          stamp * 1000
        )
      );
    }
  });
});
