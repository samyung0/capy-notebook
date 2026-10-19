import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { STASHED, stashUrlTokens } from '@/lib/urlTokenStash';

const memory = () => {
  const items = new Map<string, string>();
  return {
    items,
    setItem: (key: string, value: string) => {
      items.set(key, value);
    },
  };
};

// Sam 2026-10-19 (review C1): the token leaves the address bar before
// anything records the page.
describe('stashUrlTokens', () => {
  it('moves each address-bar token into storage, leaving a placeholder', () => {
    const share = 'ws_0123456789.AbCdEfGhIjKlMnOp';
    const invite = 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFi';
    for (const [place, clean, kind, token] of [
      [
        { hash: '', pathname: `/open/${share}`, search: '' },
        `/open/${STASHED}`,
        'open',
        share,
      ],
      [
        { hash: '#x', pathname: `/workspace-invites/${invite}`, search: '' },
        `/workspace-invites/${STASHED}#x`,
        'invite',
        invite,
      ],
      [
        {
          hash: '',
          pathname: '/',
          search: `?tab=a&clone=quiz%3A${encodeURIComponent(share)}`,
        },
        `/?tab=a&clone=${STASHED}`,
        'clone',
        `quiz:${share}`,
      ],
    ] as const) {
      const storage = memory();
      const out = stashUrlTokens(place, storage);
      expect(out).toBe(clean);
      expect(out).not.toContain(token.split('.').at(-1));
      expect(storage.items.get(`capy:url-token:${kind}`)).toBe(token);
    }
  });

  it('leaves token-free and already stashed addresses alone', () => {
    const storage = memory();
    for (const pathname of [
      '/workspaces',
      `/open/${STASHED}`,
      `/workspace-invites/${STASHED}`,
    ])
      expect(
        stashUrlTokens(
          { hash: '', pathname, search: `?clone=${STASHED}` },
          storage
        )
      ).toBeNull();
    expect(storage.items.size).toBe(0);
  });

  it('runs before Sentry starts: right after Zod jitless in main.tsx', () => {
    const main = readFileSync(new URL('../main.tsx', import.meta.url), 'utf8');
    const imports = [...main.matchAll(/^import .*$/gm)].map(
      (match) => match[0]
    );
    expect(imports[1]).toBe("import './lib/bootUrlTokens';");
    expect(main.indexOf("import './lib/bootUrlTokens';")).toBeLessThan(
      main.indexOf('initErrorReporting();')
    );
  });
});
