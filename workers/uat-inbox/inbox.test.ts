import { describe, expect, it, vi } from 'vitest';
import worker, { type InboxMessage } from './index';

const token = 'inbox-read-token';
const to = 'journeys+run-owner+clerk_test@inbox.uat.capynotebook.com';

function env() {
  const objects = new Map<string, string>();
  return {
    INBOX: {
      get: async (key: string) => objects.get(key) ?? null,
      list: async ({ prefix }: { prefix: string }) => ({
        keys: [...objects.keys()]
          .filter((key) => key.startsWith(prefix))
          .map((name) => ({ name })),
      }),
      put: async (key: string, value: string) => objects.set(key, value),
    },
    objects,
    READ_TOKEN: token,
    SENDER_DOMAIN: 'uat.capynotebook.com',
  };
}

function incoming(from: string) {
  const raw = [
    'From: Capy Notebook <notifications@uat.capynotebook.com>',
    `To: ${to}`,
    'Subject: Your Capy Notebook account deletion is scheduled',
    'List-Unsubscribe: <https://uat-api.capynotebook.com/api/email/unsubscribe?token=t>',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Open https://uat.capynotebook.com',
  ].join('\r\n');
  return {
    from,
    raw: new Response(raw).body as ReadableStream<Uint8Array>,
    setReject: vi.fn(),
    to: to.toUpperCase(),
  };
}

function read(bindings: ReturnType<typeof env>, authorization?: string) {
  return worker.fetch(
    new Request(
      `https://uat-inbox.capynotebook.com/messages?to=${encodeURIComponent(to)}`,
      { headers: authorization ? { Authorization: authorization } : {} }
    ),
    bindings
  );
}

describe('UAT journey inbox', () => {
  it('stores UAT mail and returns it to a token holder', async () => {
    const bindings = env();
    await worker.email(
      incoming('bounce-123@cf-bounce.uat.capynotebook.com'),
      bindings
    );
    const response = await read(bindings, `Bearer ${token}`);
    expect(response.status).toBe(200);
    const [message] = (await response.json()) as InboxMessage[];
    expect(message).toMatchObject({
      from: 'notifications@uat.capynotebook.com',
      subject: 'Your Capy Notebook account deletion is scheduled',
      to,
    });
    expect(message.text.trim()).toBe('Open https://uat.capynotebook.com');
    expect(message.headers['list-unsubscribe']).toContain(
      '/api/email/unsubscribe'
    );
  });

  it('rejects mail from any other sender domain', async () => {
    const bindings = env();
    const message = incoming('someone@notuat.capynotebook.com');
    await worker.email(message, bindings);
    expect(message.setReject).toHaveBeenCalled();
    expect(bindings.objects.size).toBe(0);
  });

  it('refuses reads without the token', async () => {
    const bindings = env();
    expect((await read(bindings)).status).toBe(401);
    expect((await read(bindings, 'Bearer wrong')).status).toBe(401);
  });
});
