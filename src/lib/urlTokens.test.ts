import { describe, expect, it } from 'vitest';
import {
  scrubRecordingEvent,
  stripUrlTokens,
  stripUrlTokensDeep,
} from '@/lib/urlTokens';

describe('stripUrlTokensDeep', () => {
  it('scrubs a Sentry event and breadcrumb wherever a token rides', () => {
    const invite = 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFi';
    const share = 'qz_0123456789.AbCdEfGhIjKlMnOp';
    const event = stripUrlTokensDeep({
      breadcrumbs: [
        {
          category: 'navigation',
          data: {
            from: `/share/quizzes/${share}`,
            to: `/workspace-invites/${invite}`,
          },
        },
        {
          category: 'fetch',
          data: {
            url: `https://api.test/api/workspace-invites/${invite}/accept`,
          },
        },
      ],
      exception: {
        values: [{ value: `GET /api/public/quizzes/${share}: 500` }],
      },
      request: { url: `https://app.test/open/${share}` },
      transaction: `/workspace-invites/${invite}`,
    });
    const text = JSON.stringify(event);
    expect(text).not.toContain(invite);
    expect(text).not.toContain('AbCdEfGhIjKlMnOp');
    expect(text).toContain('qz_0123456789');
  });
});

describe('KLIPY searches', () => {
  it('keep the endpoint and drop the typed words and customer id', () => {
    const url =
      'https://api.klipy.com/api/v1/key/gifs/search?q=my+teacher&customer_id=abc-123';
    expect(stripUrlTokens(url)).toBe(
      'https://api.klipy.com/api/v1/key/gifs/search'
    );
  });
});

describe('scrubRecordingEvent', () => {
  it("strips a replay span's fetch URL", () => {
    const invite = 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFi';
    const span = scrubRecordingEvent({
      data: {
        payload: {
          description: `https://app.test/api/workspace-invites/${invite}/accept`,
          op: 'resource.fetch',
        },
        tag: 'performanceSpan',
      },
      type: 5,
    });
    expect(JSON.stringify(span)).not.toContain(invite);
  });
});
