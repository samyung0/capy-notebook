import { describe, expect, it } from 'vitest';

import {
  plateAiCommandUrl,
  plateAiCopilotUrl,
  sanitizePlateAiBody,
} from './plateAiTransport';

describe('Plate AI transport', () => {
  it('scopes command and copilot routes to the encoded workspace', () => {
    expect(plateAiCommandUrl('workspace/one')).toContain(
      '/workspaces/workspace%2Fone/ai/command'
    );
    expect(plateAiCopilotUrl('workspace/one')).toContain(
      '/workspaces/workspace%2Fone/ai/copilot'
    );
  });

  it('recursively removes browser-controlled provider credentials', () => {
    const sanitized = sanitizePlateAiBody(
      JSON.stringify({
        apiKey: 'secret',
        prompt: 'Improve this',
        providerOptions: {
          model: 'unsafe-model',
          nested: [{ keep: true, key: 'secret' }],
          provider: 'demo',
        },
      })
    );

    expect(JSON.parse(String(sanitized))).toEqual({
      prompt: 'Improve this',
      providerOptions: { nested: [{ keep: true }] },
    });
  });

  it('leaves non-JSON streaming bodies unchanged', () => {
    expect(sanitizePlateAiBody('raw body')).toBe('raw body');
  });
});
