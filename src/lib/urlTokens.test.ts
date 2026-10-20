import { describe, expect, it } from 'vitest';
import { scrubRecordingEvent, stripUrlTokensDeep } from '@/lib/urlTokens';

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
